import { boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, tsz, updatedAt } from './_helpers';

/**
 * Finance is accounting-grade: money tables are append-only or status-moved,
 * never deleted. Corrections are reversals with a reason.
 */

export const instalment = pgTable(
  'instalment',
  {
    id: pk(),
    enrollmentId: uuid().notNull(),
    branchId: uuid().notNull(),
    seq: integer().notNull(),
    label: text().notNull(),
    dueDate: date().notNull(),
    amount: money().notNull(),
    /** Allocated from cleared payments. */
    paid: money().default(0).notNull(),
    /** Allocated from payments awaiting clearance (cheques, pending online). */
    pendingPaid: money().default(0).notNull(),
    lateFee: money().default(0).notNull(),
    waived: money().default(0).notNull(),
    status: text({ enum: ['due', 'partially_paid', 'paid', 'waived', 'cancelled'] }).default('due').notNull(),
    revision: integer().default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.enrollmentId), index().on(t.branchId, t.dueDate)],
);

export const scheduleRevision = pgTable('schedule_revision', {
  id: pk(),
  enrollmentId: uuid().notNull(),
  revision: integer().notNull(),
  rows: jsonb().$type<{ seq: number; label: string; dueDate: string; amount: number; paid: number }[]>().notNull(),
  reason: text().notNull(),
  requestedBy: uuid(),
  approvedBy: uuid(),
  createdAt: createdAt(),
});

export interface InvoiceLine {
  description: string;
  sac: string;
  amount: number; // taxable, paise
  taxRate: number;
  tax: number; // paise
}

export const invoice = pgTable(
  'invoice',
  {
    id: pk(),
    branchId: uuid().notNull(),
    enrollmentId: uuid().notNull(),
    studentId: uuid().notNull(),
    instalmentId: uuid(),
    number: text().notNull().unique(),
    fy: text().notNull(),
    seq: integer().notNull(),
    issueDate: date().notNull(),
    dueDate: date().notNull(),
    lines: jsonb().$type<InvoiceLine[]>().notNull(),
    subtotal: money().notNull(),
    tax: money().notNull(),
    total: money().notNull(),
    paid: money().default(0).notNull(),
    status: text({ enum: ['issued', 'partially_paid', 'paid', 'cancelled'] }).default('issued').notNull(),
    cancelledAt: tsz(),
    cancelReason: text(),
    creditNoteId: uuid(),
    reprintCount: integer().default(0).notNull(),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.enrollmentId), index().on(t.branchId, t.issueDate), uniqueIndex().on(t.branchId, t.fy, t.seq)],
);

export const payment = pgTable(
  'payment',
  {
    id: pk(),
    branchId: uuid().notNull(),
    enrollmentId: uuid().notNull(),
    studentId: uuid().notNull(),
    receivedAt: tsz().defaultNow().notNull(),
    total: money().notNull(),
    status: text({ enum: ['pending_gateway', 'pending_clearance', 'cleared', 'bounced', 'voided', 'failed'] }).notNull(),
    channel: text({ enum: ['desk', 'online', 'reconciliation'] }).notNull(),
    gatewayOrderId: text(),
    gatewayPaymentId: text().unique(),
    cashSessionId: uuid(),
    receivedBy: uuid(),
    /** Idempotency for desk double-submits and gateway webhook retries. */
    idempotencyKey: text().unique(),
    excessCredit: money().default(0).notNull(),
    notes: text(),
    voidReason: text(),
    voidedBy: uuid(),
    voidedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.enrollmentId), index().on(t.branchId, t.receivedAt)],
);

export const paymentTender = pgTable(
  'payment_tender',
  {
    id: pk(),
    paymentId: uuid()
      .notNull()
      .references(() => payment.id),
    method: text({ enum: ['upi', 'cash', 'card', 'cheque', 'transfer', 'online'] }).notNull(),
    amount: money().notNull(),
    reference: text(),
    chequeStatus: text({ enum: ['pending', 'cleared', 'bounced'] }),
    clearedAt: tsz(),
  },
  (t) => [index().on(t.paymentId)],
);

export const paymentAllocation = pgTable(
  'payment_allocation',
  {
    id: pk(),
    paymentId: uuid()
      .notNull()
      .references(() => payment.id),
    instalmentId: uuid().notNull(),
    invoiceId: uuid(),
    amount: money().notNull(),
    reversed: boolean().default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.paymentId), index().on(t.instalmentId)],
);

export const receipt = pgTable(
  'receipt',
  {
    id: pk(),
    branchId: uuid().notNull(),
    paymentId: uuid().notNull().unique(),
    number: text().notNull().unique(),
    fy: text().notNull(),
    seq: integer().notNull(),
    issuedAt: tsz().defaultNow().notNull(),
    reprintCount: integer().default(0).notNull(),
    voided: boolean().default(false).notNull(),
    voidedAt: tsz(),
    /** Opaque token behind the public verification QR. */
    verifyToken: text().notNull().unique(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.fy, t.seq)],
);

export const creditNote = pgTable(
  'credit_note',
  {
    id: pk(),
    branchId: uuid().notNull(),
    invoiceId: uuid(),
    enrollmentId: uuid().notNull(),
    number: text().notNull().unique(),
    fy: text().notNull(),
    seq: integer().notNull(),
    amount: money().notNull(),
    reason: text().notNull(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.fy, t.seq)],
);

/** Append-only (enforced by trigger in migrate). Running balance is derived. */
export const ledgerEntry = pgTable(
  'ledger_entry',
  {
    id: pk(),
    enrollmentId: uuid().notNull(),
    branchId: uuid().notNull(),
    at: tsz().defaultNow().notNull(),
    kind: text({ enum: ['charge', 'payment', 'discount', 'late_fee', 'waiver', 'reversal', 'credit_note', 'refund', 'adjustment', 'credit'] }).notNull(),
    description: text().notNull(),
    reference: text(),
    debit: money().default(0).notNull(),
    credit: money().default(0).notNull(),
    paymentId: uuid(),
    invoiceId: uuid(),
    createdBy: uuid(),
  },
  (t) => [index().on(t.enrollmentId, t.at)],
);

/** Gap-free counters per branch per FY per document type (row-locked in txn). */
export const docSequence = pgTable(
  'doc_sequence',
  {
    scopeId: uuid().notNull(),
    docType: text().notNull(),
    period: text().notNull(),
    nextSeq: integer().default(1).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scopeId, t.docType, t.period] })],
);

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    branchId: uuid(),
    kind: text({ enum: ['discount', 'locked_period', 'refund', 'restructure', 'waiver', 'void', 'exemption'] }).notNull(),
    level: text({ enum: ['finance', 'super_admin'] }).notNull(),
    status: text({ enum: ['pending', 'approved', 'returned', 'denied'] }).default('pending').notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    amount: money(),
    pct: numeric({ mode: 'number' }),
    payload: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    requestedBy: uuid().notNull(),
    requestedAt: tsz().defaultNow().notNull(),
    decidedBy: uuid(),
    decidedAt: tsz(),
    decisionNote: text(),
  },
  (t) => [index().on(t.status, t.level)],
);

export const cashSession = pgTable(
  'cash_session',
  {
    id: pk(),
    branchId: uuid().notNull(),
    counterName: text().notNull(),
    cashierUserId: uuid().notNull(),
    date: date().notNull(),
    openedAt: tsz().defaultNow().notNull(),
    openingCash: money().default(0).notNull(),
    deposited: money().default(0).notNull(),
    closedAt: tsz(),
    closedBy: uuid(),
    denominations: jsonb().$type<Record<string, number>>(),
    counted: money(),
    expectedCash: money(),
    difference: money(),
    explanation: text(),
    status: text({ enum: ['open', 'closed'] }).default('open').notNull(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.counterName, t.date)],
);

export const periodLock = pgTable(
  'period_lock',
  {
    id: pk(),
    branchId: uuid().notNull(),
    /** First day of the month */
    month: date().notNull(),
    status: text({ enum: ['locked', 'reopened'] }).default('locked').notNull(),
    lockedAt: tsz().defaultNow().notNull(),
    lockedBy: uuid(),
    reopenedBy: uuid(),
    reopenedAt: tsz(),
    reopenReason: text(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.month)],
);

/** Locks a single day's entries after cash closing. */
export const dayClose = pgTable(
  'day_close',
  {
    id: pk(),
    branchId: uuid().notNull(),
    date: date().notNull(),
    closedAt: tsz().defaultNow().notNull(),
    closedBy: uuid(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.date)],
);

export const duesActivity = pgTable(
  'dues_activity',
  {
    id: pk(),
    enrollmentId: uuid().notNull(),
    kind: text({ enum: ['reminder', 'call', 'promise', 'note', 'payment_link', 'exemption', 'restructure'] }).notNull(),
    channel: text(),
    note: text(),
    promiseDate: date(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.enrollmentId, t.createdAt)],
);

export const settlement = pgTable('settlement', {
  id: pk(),
  gateway: text().notNull(),
  externalId: text().notNull().unique(),
  settledOn: date().notNull(),
  amount: money().notNull(),
  fees: money().default(0).notNull(),
  utr: text(),
  paymentCount: integer().default(0).notNull(),
  status: text({ enum: ['open', 'reconciled'] }).default('open').notNull(),
  createdAt: createdAt(),
});

export const settlementItem = pgTable(
  'settlement_item',
  {
    id: pk(),
    settlementId: uuid()
      .notNull()
      .references(() => settlement.id),
    gatewayPaymentId: text().notNull(),
    amount: money().notNull(),
    notes: text(),
    matchedPaymentId: uuid(),
    status: text({ enum: ['matched', 'unmatched', 'amount_differs', 'resolved'] }).default('unmatched').notNull(),
    resolution: text(),
    resolvedBy: uuid(),
    resolvedAt: tsz(),
  },
  (t) => [index().on(t.settlementId)],
);

export const gatewayOrder = pgTable('gateway_order', {
  id: pk(),
  enrollmentId: uuid().notNull(),
  studentId: uuid().notNull(),
  amount: money().notNull(),
  purpose: text({ enum: ['next_due', 'custom', 'full'] }).notNull(),
  gateway: text().notNull(),
  externalOrderId: text().notNull().unique(),
  status: text({ enum: ['created', 'paid', 'failed', 'expired'] }).default('created').notNull(),
  createdByUserId: uuid().notNull(),
  paymentId: uuid(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookEvent = pgTable('webhook_event', {
  id: pk(),
  provider: text().notNull(),
  externalId: text().notNull().unique(),
  type: text().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  signatureValid: boolean().notNull(),
  processedAt: tsz(),
  attempts: integer().default(0).notNull(),
  lastError: text(),
  createdAt: createdAt(),
});
