import { z } from 'zod';
import { route, zId, zInstant, zPaise } from '../route';

/**
 * Online payments (Razorpay, or the built-in sandbox gateway when Razorpay is
 * not configured). Implemented by the Finance module; called by the student
 * and parent portals' "Pay now" sheet.
 *
 * Flow: createOrder → (Razorpay Checkout | sandbox page) → gateway webhook →
 * Finance records the payment, issues the receipt, recomputes fee clearance
 * (fee-gated notes unlock) → client polls orderStatus until paid.
 */
export const zPayPurpose = z.enum(['next_due', 'full', 'custom']);

export const zOrder = z.object({
  orderId: zId,
  gateway: z.enum(['razorpay', 'sandbox']),
  /** Razorpay order id (order_…) or sandbox id. */
  externalOrderId: z.string(),
  /** Razorpay public key id for Checkout (razorpay only). */
  keyId: z.string().nullable(),
  amount: zPaise,
  currency: z.literal('INR'),
  description: z.string(),
  prefill: z.object({ name: z.string(), email: z.string().nullable(), contact: z.string().nullable() }),
  /** Sandbox only: in-app URL of the simulated checkout page. */
  sandboxUrl: z.string().nullable(),
});
export type Order = z.output<typeof zOrder>;

export const zOrderStatus = z.object({
  orderId: zId,
  status: z.enum(['created', 'paid', 'failed', 'expired']),
  amount: zPaise,
  receiptNumber: z.string().nullable(),
  receiptId: zId.nullable(),
  feeCleared: z.boolean(),
  paidAt: zInstant.nullable(),
});

export const paymentsContract = {
  /** Student pays own fees; parent passes studentId for a linked child. */
  createOrder: route({
    method: 'POST',
    path: '/api/portal/payments/orders',
    body: z.object({
      studentId: zId.optional(),
      purpose: zPayPurpose,
      /** Required for "custom" (paise, ≥ minimum partial unless it clears the balance). */
      amount: zPaise.positive().optional(),
    }),
    response: zOrder,
  }),
  orderStatus: route({ method: 'GET', path: '/api/portal/payments/orders/:orderId', response: zOrderStatus }),
  /** Sandbox gateway only: simulate the payer completing or failing checkout. */
  sandboxComplete: route({
    method: 'POST',
    path: '/api/portal/payments/orders/:orderId/sandbox',
    body: z.object({ outcome: z.enum(['success', 'failure']), method: z.enum(['upi', 'card', 'netbanking', 'wallet']).default('upi') }),
    response: zOrderStatus,
  }),
  /** Razorpay Checkout success handler posts the signed result here (verified server-side). */
  razorpayVerify: route({
    method: 'POST',
    path: '/api/portal/payments/orders/:orderId/razorpay',
    body: z.object({ razorpay_payment_id: z.string(), razorpay_order_id: z.string(), razorpay_signature: z.string() }),
    response: zOrderStatus,
  }),
  /** Gateway webhooks (public, signature-verified, idempotent). */
  razorpayWebhookPath: '/api/payments/webhooks/razorpay',
  sandboxWebhookPath: '/api/payments/webhooks/sandbox',
};

/** Document downloads (PDF). Finance implements; portals and staff link to them. */
export const DOCUMENT_PATHS = {
  invoice: (id: string) => `/api/documents/invoices/${id}.pdf`,
  receipt: (id: string) => `/api/documents/receipts/${id}.pdf`,
  statement: (enrollmentId: string) => `/api/documents/statements/${enrollmentId}.pdf`,
  idCard: (studentId: string) => `/api/documents/id-cards/${studentId}.pdf`,
  reportCard: (enrollmentId: string) => `/api/documents/report-cards/${enrollmentId}.pdf`,
} as const;
