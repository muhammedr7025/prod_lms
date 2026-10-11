import crypto from 'node:crypto';
import { env } from '../../config/env';

export interface GatewayPayment {
  id: string;
  orderId: string;
  amount: number;
  method: string | null;
  status: 'captured' | 'failed' | 'authorized' | 'other';
  error: string | null;
}

export interface ParsedWebhook {
  valid: boolean;
  eventId: string;
  type: string;
  payment: GatewayPayment | null;
}

/**
 * Payment gateway port. Razorpay in production; the sandbox gateway (default)
 * simulates checkout and posts signed webhooks to the same handler.
 */
export interface PaymentGateway {
  readonly name: 'razorpay' | 'sandbox';
  readonly keyId: string | null;
  createOrder(input: { amount: number; receipt: string; notes: Record<string, string> }): Promise<{ externalOrderId: string }>;
  /** Checkout success signature: HMAC_SHA256(order_id|payment_id, secret). */
  verifyPayment(input: { orderId: string; paymentId: string; signature: string }): boolean;
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook;
}

function hmac(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Razorpay / sandbox webhook body → payment. */
function parseBody(rawBody: string): { type: string; payment: GatewayPayment | null; createdAt: number | null } {
  const body = JSON.parse(rawBody) as {
    event?: string;
    created_at?: number;
    payload?: { payment?: { entity?: { id: string; order_id: string; amount: number; method?: string; status?: string; error_description?: string | null } } };
  };
  const e = body.payload?.payment?.entity;
  const st = e?.status === 'captured' ? 'captured' : e?.status === 'failed' ? 'failed' : e?.status === 'authorized' ? 'authorized' : 'other';
  return {
    type: body.event ?? 'unknown',
    createdAt: body.created_at ?? null,
    payment: e ? { id: e.id, orderId: e.order_id, amount: Number(e.amount), method: e.method ?? null, status: st, error: e.error_description ?? null } : null,
  };
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;
  readonly keyId: string;
  private readonly secret: string;
  private readonly webhookSecret: string;

  constructor() {
    const e = env();
    this.keyId = e.RAZORPAY_KEY_ID!;
    this.secret = e.RAZORPAY_KEY_SECRET!;
    this.webhookSecret = e.RAZORPAY_WEBHOOK_SECRET ?? e.RAZORPAY_KEY_SECRET!;
  }

  async createOrder(input: { amount: number; receipt: string; notes: Record<string, string> }) {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.secret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: input.amount, currency: 'INR', receipt: input.receipt, notes: input.notes, payment_capture: 1 }),
    });
    if (!res.ok) throw new Error(`Razorpay order failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id: string };
    return { externalOrderId: json.id };
  }

  verifyPayment(input: { orderId: string; paymentId: string; signature: string }) {
    return safeEqual(hmac(this.secret, `${input.orderId}|${input.paymentId}`), input.signature);
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const sig = header(headers, 'x-razorpay-signature') ?? '';
    const valid = !!sig && safeEqual(hmac(this.webhookSecret, rawBody), sig);
    if (!valid) return { valid: false, eventId: '', type: 'invalid', payment: null };
    const b = parseBody(rawBody);
    const eventId = header(headers, 'x-razorpay-event-id') ?? `${b.type}:${b.payment?.id ?? crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 24)}`;
    return { valid, eventId, type: b.type, payment: b.payment };
  }
}

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';
export const SANDBOX_EVENT_HEADER = 'x-sandbox-event-id';

export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox' as const;
  readonly keyId = null;

  async createOrder() {
    return { externalOrderId: `sbx_order_${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}` };
  }

  verifyPayment(input: { orderId: string; paymentId: string; signature: string }) {
    return safeEqual(hmac(env().SANDBOX_WEBHOOK_SECRET, `${input.orderId}|${input.paymentId}`), input.signature);
  }

  /** Deterministic ids per order + outcome so a replayed webhook is the same event. */
  static ids(externalOrderId: string, outcome: 'success' | 'failure') {
    const suffix = externalOrderId.replace(/^sbx_order_/, '');
    return { paymentId: `sbx_pay_${suffix}${outcome === 'failure' ? '_f' : ''}`, eventId: `sbx_evt_${suffix}_${outcome}` };
  }

  /** The signed webhook body the simulated gateway posts (same shape as Razorpay's). */
  static webhook(input: { externalOrderId: string; amount: number; method: string; outcome: 'success' | 'failure' }) {
    const { paymentId, eventId } = SandboxGateway.ids(input.externalOrderId, input.outcome);
    const body = JSON.stringify({
      entity: 'event',
      event: input.outcome === 'success' ? 'payment.captured' : 'payment.failed',
      contains: ['payment'],
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: input.externalOrderId,
            amount: input.amount,
            currency: 'INR',
            method: input.method,
            status: input.outcome === 'success' ? 'captured' : 'failed',
            error_description: input.outcome === 'failure' ? 'Payment declined by the payer (sandbox)' : null,
          },
        },
      },
    });
    return { body, eventId, paymentId, signature: hmac(env().SANDBOX_WEBHOOK_SECRET, body) };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const sig = header(headers, SANDBOX_SIGNATURE_HEADER) ?? '';
    const valid = !!sig && safeEqual(hmac(env().SANDBOX_WEBHOOK_SECRET, rawBody), sig);
    if (!valid) return { valid: false, eventId: '', type: 'invalid', payment: null };
    const b = parseBody(rawBody);
    const eventId = header(headers, SANDBOX_EVENT_HEADER) ?? `${b.type}:${b.payment?.id ?? ''}`;
    return { valid, eventId, type: b.type, payment: b.payment };
  }
}

export function razorpayConfigured(): boolean {
  const e = env();
  return !!(e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET);
}
