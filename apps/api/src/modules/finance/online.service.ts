import { Injectable, Logger } from '@nestjs/common';
import { paymentsContract, type Order } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, eq, gte, isNull, lt, sql } from '@exatech/db';
import { formatINR, sumPaise } from '@exatech/domain';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { badRequest, conflict, forbidden, invalid, notFound } from '../../core/errors';
import { ScopeService } from '../../core/scope.service';
import { AuditService } from '../../core/audit/audit.service';
import { FinanceShared } from './finance.shared';
import { RazorpayGateway, razorpayConfigured, SANDBOX_EVENT_HEADER, SANDBOX_SIGNATURE_HEADER, SandboxGateway, type PaymentGateway } from './gateway';
import { openBalance, suggestedInstalment } from './ledger';
import { PaymentsService } from './payments.service';

type OrderRow = typeof s.gatewayOrder.$inferSelect;

/**
 * Online payments: server-computed orders (never trust client amounts),
 * signature-verified idempotent webhooks (Razorpay, or the sandbox gateway
 * posting signed webhooks to the same handler), and order status for the
 * portal's success screen.
 */
@Injectable()
export class OnlineService {
  private readonly log = new Logger('Payments');
  private readonly sandbox = new SandboxGateway();
  private razorpay: RazorpayGateway | null = null;

  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly payments: PaymentsService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  gateway(): PaymentGateway {
    if (razorpayConfigured()) return (this.razorpay ??= new RazorpayGateway());
    return this.sandbox;
  }

  private gatewayFor(name: string): PaymentGateway {
    if (name === 'sandbox') return this.sandbox;
    if (!razorpayConfigured()) throw badRequest('Razorpay is not configured');
    return (this.razorpay ??= new RazorpayGateway());
  }

  /** Amount for a purpose, computed on the server from open instalments. */
  async amountFor(enrollmentId: string, purpose: 'next_due' | 'full' | 'custom', custom?: number): Promise<{ amount: number; description: string }> {
    const insts = await this.shared.instalments(this.db.db, enrollmentId);
    const outstanding = sumPaise(insts.map(openBalance));
    if (outstanding <= 0) throw invalid('Nothing is due on this fee account');
    const fin = await this.shared.settings();
    if (purpose === 'full') return { amount: outstanding, description: `Full balance · ${formatINR(outstanding)}` };
    if (purpose === 'next_due') {
      const next = suggestedInstalment(insts)!;
      return { amount: openBalance(next), description: `${/^\d/.test(next.label) ? `Instalment ${next.label.split(' · ')[0]}` : next.label} · ${formatINR(openBalance(next))}` };
    }
    if (!custom || custom <= 0) throw invalid('Enter the amount to pay', { amount: 'Required' });
    if (custom % 100 !== 0) throw invalid('Pay in whole rupees', { amount: 'Whole rupees' });
    if (custom > outstanding) throw invalid(`At most ${formatINR(outstanding)} is outstanding`, { amount: `At most ${formatINR(outstanding)}` });
    if (custom < fin.minPartial && custom < outstanding) throw invalid(`Minimum partial payment is ${formatINR(fin.minPartial)}`, { amount: `At least ${formatINR(fin.minPartial)}` });
    return { amount: custom, description: `Part payment · ${formatINR(custom)}` };
  }

  async create(input: { enrollmentId: string; studentId: string; purpose: 'next_due' | 'full' | 'custom'; amount?: number; createdBy: string; payer: { name: string; email: string | null; contact: string | null } }): Promise<Order> {
    const fin = await this.shared.settings();
    if (!fin.methods.online) throw invalid('Online payments are switched off — pay at the branch counter');
    const { amount, description } = await this.amountFor(input.enrollmentId, input.purpose, input.amount);
    const gw = this.gateway();
    const receipt = `rcpt_${crypto.randomBytes(6).toString('hex')}`;
    const { externalOrderId } = await gw.createOrder({ amount, receipt, notes: { enrollmentId: input.enrollmentId } });
    const [o] = await this.db.db
      .insert(s.gatewayOrder)
      .values({ enrollmentId: input.enrollmentId, studentId: input.studentId, amount, purpose: input.purpose, gateway: gw.name, externalOrderId, createdByUserId: input.createdBy })
      .returning();
    const [st] = await this.db.db.select({ name: s.student.name }).from(s.student).where(eq(s.student.id, input.studentId));
    return {
      orderId: o!.id,
      gateway: gw.name,
      externalOrderId,
      keyId: gw.keyId,
      amount,
      currency: 'INR',
      description: `${description} · ${st?.name ?? ''}`,
      prefill: input.payer,
      sandboxUrl: gw.name === 'sandbox' ? `/pay/sandbox/${o!.id}` : null,
    };
  }

  /** Portal: student (own) or parent (linked child). */
  async createForPortal(body: { studentId?: string; purpose: 'next_due' | 'full' | 'custom'; amount?: number }): Promise<Order> {
    const c = ctx();
    const sc = await this.scope.portalEnrollment(body.studentId ?? null);
    const [u] = await this.db.db.select({ name: s.user.name, email: s.user.email, phone: s.user.phoneNumber }).from(s.user).where(eq(s.user.id, c.userId));
    return this.create({
      enrollmentId: sc.enrollmentId,
      studentId: sc.studentId,
      purpose: body.purpose,
      amount: body.amount,
      createdBy: c.userId,
      payer: { name: u?.name ?? sc.name, email: u?.email && !u.email.endsWith('.invalid') ? u.email : null, contact: u?.phone ?? null },
    });
  }

  /** Orders are visible to the student and linked parents only. */
  async portalOrder(orderId: string): Promise<OrderRow> {
    const [o] = await this.db.db.select().from(s.gatewayOrder).where(eq(s.gatewayOrder.id, orderId));
    if (!o) throw notFound('Order');
    const c = ctx();
    const list = c.roleKey === 'parent' ? await this.scope.parentChildren() : await this.scope.studentEnrollments();
    if (!list.some((x) => x.studentId === o.studentId)) throw forbidden('This payment belongs to another account');
    return o;
  }

  async status(orderId: string) {
    const [o] = await this.db.db.select().from(s.gatewayOrder).where(eq(s.gatewayOrder.id, orderId));
    if (!o) throw notFound('Order');
    const [p] = o.paymentId ? await this.db.db.select({ receivedAt: s.payment.receivedAt }).from(s.payment).where(eq(s.payment.id, o.paymentId)) : [];
    const [r] = o.paymentId ? await this.db.db.select({ id: s.receipt.id, number: s.receipt.number }).from(s.receipt).where(eq(s.receipt.paymentId, o.paymentId)) : [];
    const [e] = await this.db.db.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, o.enrollmentId));
    return { orderId: o.id, status: o.status, amount: o.amount, receiptNumber: r?.number ?? null, receiptId: r?.id ?? null, feeCleared: e?.feeCleared ?? false, paidAt: p?.receivedAt ?? null };
  }

  async checkout(orderId: string) {
    const o = await this.portalOrder(orderId);
    const [st] = await this.db.db.select({ name: s.student.name }).from(s.student).where(eq(s.student.id, o.studentId));
    const [u] = await this.db.db.select({ name: s.user.name, email: s.user.email, phone: s.user.phoneNumber }).from(s.user).where(eq(s.user.id, ctx().userId));
    const gw = this.gatewayFor(o.gateway);
    return {
      orderId: o.id,
      gateway: gw.name,
      externalOrderId: o.externalOrderId,
      keyId: gw.keyId,
      amount: o.amount,
      currency: 'INR' as const,
      description: `${o.purpose === 'full' ? 'Full balance' : o.purpose === 'custom' ? 'Part payment' : 'Next instalment'} · ${st?.name ?? ''}`,
      prefill: { name: u?.name ?? '', email: u?.email && !u.email.endsWith('.invalid') ? u.email : null, contact: u?.phone ?? null },
      sandboxUrl: gw.name === 'sandbox' ? `/pay/sandbox/${o.id}` : null,
      status: o.status,
      studentName: st?.name ?? '',
      payerName: u?.name ?? '',
    };
  }

  /** Sandbox: the simulated gateway posts a signed webhook to our own webhook handler (same path as Razorpay). */
  async sandboxComplete(orderId: string, outcome: 'success' | 'failure', method: string) {
    const o = await this.portalOrder(orderId);
    if (o.gateway !== 'sandbox') throw invalid('This order is not a sandbox order');
    if (o.status === 'paid') return this.status(o.id);
    const hook = SandboxGateway.webhook({ externalOrderId: o.externalOrderId, amount: o.amount, method, outcome });
    const res = await fetch(`http://127.0.0.1:${env().API_PORT}${paymentsContract.sandboxWebhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: hook.signature, [SANDBOX_EVENT_HEADER]: hook.eventId },
      body: hook.body,
    });
    if (!res.ok) throw conflict(`The sandbox gateway could not deliver the payment (${res.status}) — try again`);
    return this.status(o.id);
  }

  /** Razorpay Checkout handler: verify the signature, then record through the same idempotent path. */
  async razorpayVerify(orderId: string, body: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
    const o = await this.portalOrder(orderId);
    if (o.externalOrderId !== body.razorpay_order_id) throw invalid('Order mismatch');
    const gw = this.gatewayFor(o.gateway);
    if (!gw.verifyPayment({ orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature })) throw forbidden('Payment signature could not be verified');
    await this.capture(o.externalOrderId, { id: body.razorpay_payment_id, amount: o.amount, method: null });
    return this.status(o.id);
  }

  /** Record a captured payment for an order (idempotent on the gateway payment id). */
  private async capture(externalOrderId: string, pay: { id: string; amount: number; method: string | null }): Promise<'recorded' | 'duplicate' | 'unknown_order'> {
    return this.db.tx(async (tx) => {
      const [o] = await tx.select().from(s.gatewayOrder).where(eq(s.gatewayOrder.externalOrderId, externalOrderId)).for('update');
      if (!o) return 'unknown_order';
      if (o.status === 'paid' && o.paymentId) return 'duplicate';
      const result = await this.payments.record(tx, {
        enrollmentId: o.enrollmentId,
        tenders: [{ method: 'online', amount: pay.amount, reference: pay.id }],
        channel: 'online',
        receivedBy: null,
        gatewayOrderId: o.externalOrderId,
        gatewayPaymentId: pay.id,
        idempotencyKey: `gw:${pay.id}`,
        notes: `gateway:${o.gateway}${pay.method ? `:${pay.method}` : ''}`,
      });
      await tx.update(s.gatewayOrder).set({ status: 'paid', paymentId: result.paymentId }).where(eq(s.gatewayOrder.id, o.id));
      return result.replay ? 'duplicate' : 'recorded';
    });
  }

  /**
   * Webhook: verify signature → store the event (unique external id makes
   * replays no-ops) → record via PaymentsService → mark processed. Failures
   * are stored with the attempt count and the handler answers 5xx so the
   * gateway retries (Razorpay retries for up to 72 h); a maintenance job also
   * re-processes stored failures.
   */
  async webhook(provider: 'razorpay' | 'sandbox', rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{ ok: true; duplicate: boolean; status: string }> {
    const gw = this.gatewayFor(provider);
    const parsed = gw.parseWebhook(rawBody, headers);
    if (!parsed.valid) {
      this.log.warn(`${provider} webhook rejected: bad signature`);
      throw forbidden('Invalid webhook signature');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw badRequest('Webhook body is not JSON');
    }
    const [inserted] = await this.db.db
      .insert(s.webhookEvent)
      .values({ provider, externalId: parsed.eventId, type: parsed.type, payload, signatureValid: true })
      .onConflictDoNothing({ target: s.webhookEvent.externalId })
      .returning();
    const [ev] = inserted ? [inserted] : await this.db.db.select().from(s.webhookEvent).where(eq(s.webhookEvent.externalId, parsed.eventId));
    if (!ev) throw conflict('Webhook could not be stored');
    if (ev.processedAt) return { ok: true, duplicate: true, status: 'already processed' };
    return this.process(ev.id, parsed.type, parsed.payment);
  }

  private async process(eventId: string, type: string, pay: { id: string; orderId: string; amount: number; method: string | null; status: string; error: string | null } | null) {
    await this.db.db.update(s.webhookEvent).set({ attempts: sql`${s.webhookEvent.attempts} + 1` }).where(eq(s.webhookEvent.id, eventId));
    try {
      let status = 'ignored';
      if (pay && (type === 'payment.captured' || type === 'order.paid' || pay.status === 'captured')) {
        status = await this.capture(pay.orderId, pay);
      } else if (pay && (type === 'payment.failed' || pay.status === 'failed')) {
        await this.db.db
          .update(s.gatewayOrder)
          .set({ status: 'failed' })
          .where(and(eq(s.gatewayOrder.externalOrderId, pay.orderId), eq(s.gatewayOrder.status, 'created')));
        status = 'failed';
      }
      await this.db.db.update(s.webhookEvent).set({ processedAt: new Date(), lastError: status === 'unknown_order' ? 'No matching order — left for reconciliation' : null }).where(eq(s.webhookEvent.id, eventId));
      if (status === 'recorded') {
        await this.audit.log(this.db.db, { action: 'Webhook processed', kind: 'payment', entityType: 'payment', entityLabel: pay?.id ?? '', summary: `${type} · ${pay ? formatINR(pay.amount) : ''} · order ${pay?.orderId ?? ''}` });
      }
      return { ok: true as const, duplicate: status === 'duplicate', status };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await this.db.db.update(s.webhookEvent).set({ lastError: msg.slice(0, 500) }).where(eq(s.webhookEvent.id, eventId));
      this.log.warn(`webhook ${eventId} failed: ${msg}`);
      throw err;
    }
  }

  /** Maintenance: re-process stored, signature-valid events that failed in the last 72 h. */
  async retryFailed(): Promise<number> {
    const rows = await this.db.db
      .select()
      .from(s.webhookEvent)
      .where(and(isNull(s.webhookEvent.processedAt), eq(s.webhookEvent.signatureValid, true), lt(s.webhookEvent.attempts, 20), gte(s.webhookEvent.createdAt, new Date(Date.now() - 72 * 3600_000))))
      .limit(50);
    let ok = 0;
    for (const ev of rows) {
      try {
        const b = ev.payload as { event?: string; payload?: { payment?: { entity?: { id: string; order_id: string; amount: number; method?: string; status?: string; error_description?: string } } } };
        const e = b.payload?.payment?.entity;
        await this.process(ev.id, b.event ?? ev.type, e ? { id: e.id, orderId: e.order_id, amount: Number(e.amount), method: e.method ?? null, status: e.status ?? '', error: e.error_description ?? null } : null);
        ok++;
      } catch {
        /* recorded on the event; retried next run */
      }
    }
    return ok;
  }
}
