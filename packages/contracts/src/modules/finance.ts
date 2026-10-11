import { z } from 'zod';
import { route, zDate, zId, zInstant, zInstantNullable, zOk, zPaise } from '../route';
import { zOrder } from './payments';

/**
 * Finance (Finance Manager / cashier). Accounting-grade: every rupee has a
 * ledger entry, every collection a receipt; nothing is deleted — only voided
 * or reversed with a reason. Display-ready labels and tag variants are
 * computed on the server so screens stay thin.
 */

export const zTagVariant = z.enum(['accent', 'neutral', 'outline', 'ink', 'solid', 'plain']);
export type TagVariant = z.output<typeof zTagVariant>;

export const TENDER_METHODS = ['upi', 'cash', 'card', 'cheque', 'transfer', 'online'] as const;
export const zTenderMethod = z.enum(TENDER_METHODS);
export type TenderMethod = (typeof TENDER_METHODS)[number];
export const METHOD_LABEL: Record<TenderMethod, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Bank transfer', online: 'Razorpay online' };

export const zTender = z.object({
  method: zTenderMethod,
  amount: zPaise.positive('Each tender needs a positive amount'),
  reference: z.string().trim().max(80).nullable().optional(),
});

/* ───────────────────────── Dashboard ───────────────────────── */

export const zFinanceDashboard = z.object({
  todayLabel: z.string(), // "Saturday 11 Oct · FY 2026-27"
  collectedToday: z.object({ amount: zPaise, receipts: z.number().int(), counters: z.number().int() }),
  expectedWeek: z.object({ amount: zPaise, instalments: z.number().int(), rangeLabel: z.string() }),
  overdue: z.object({ amount: zPaise, students: z.number().int(), promised: z.number().int() }),
  pendingClearance: z.object({ amount: zPaise, cheques: z.number().int(), online: z.number().int() }),
  approvals: z.object({ discounts: z.number().int(), refunds: z.number().int(), restructures: z.number().int(), other: z.number().int() }),
  byMethod: z.array(z.object({ method: z.string(), label: z.string(), amount: zPaise, pct: z.number() })),
  ageing: z.array(z.object({ bucket: z.enum(['0-30', '31-60', '61-90', '90+']), label: z.string(), amount: zPaise, heightPct: z.number() })),
  targets: z.object({
    monthLabel: z.string(),
    rows: z.array(z.object({ branchId: zId, branchName: z.string(), collected: zPaise, target: zPaise, pct: z.number() })),
    paceNote: z.string(),
  }),
  refreshedAt: zInstant,
});
export type FinanceDashboard = z.output<typeof zFinanceDashboard>;

/* ───────────────────────── Fee account ───────────────────────── */

export const INSTALMENT_STATES = ['paid', 'partially_paid', 'overdue', 'due_today', 'not_due', 'pending_clearance', 'waived', 'cancelled'] as const;

export const zInstalmentRow = z.object({
  id: zId,
  seq: z.number().int(),
  label: z.string(),
  dueDate: zDate,
  amount: zPaise,
  paid: zPaise,
  pendingPaid: zPaise,
  waived: zPaise,
  lateFee: zPaise,
  /** Open balance incl. accrued late fee. */
  balance: zPaise,
  state: z.enum(INSTALMENT_STATES),
  statusLabel: z.string(),
  tag: zTagVariant,
  suggested: z.boolean(),
  revision: z.number().int(),
  invoiceId: zId.nullable(),
  invoiceNumber: z.string().nullable(),
});
export type InstalmentRow = z.output<typeof zInstalmentRow>;

export const zLedgerRow = z.object({
  id: zId,
  at: zInstant,
  date: zDate,
  kind: z.string(),
  entry: z.string(),
  reference: z.string().nullable(),
  debit: zPaise,
  credit: zPaise,
  balance: zPaise,
  emphasis: z.boolean(),
});

export const zFollowUpRow = z.object({
  id: zId,
  kind: z.string(),
  label: z.string(),
  date: zDate,
  promiseDate: zDate.nullable(),
  by: z.string().nullable(),
});

export const zFeeAccount = z.object({
  enrollmentId: zId,
  studentId: zId,
  studentName: z.string(),
  admissionNo: z.string().nullable(),
  branchId: zId,
  branchName: z.string(),
  batchCode: z.string(),
  courseName: z.string(),
  batchLabel: z.string(), // "FS-B · Full Stack Development"
  guardianLine: z.string(), // "Guardian Suresh Menon · 98•••••210"
  enrollmentStatus: z.string(),
  planLabel: z.string(), // "3 instalments · 40/30/30 · incl. GST"
  feeTotal: zPaise,
  paid: zPaise,
  paidNote: z.string(),
  pendingClearance: zPaise,
  outstanding: zPaise,
  overdue: zPaise,
  overdueNote: z.string(),
  lateFeeDue: zPaise,
  creditBalance: zPaise,
  clearance: z.object({
    cleared: z.boolean(),
    label: z.enum(['Unlocked', 'Locked']),
    reason: z.string(),
    tag: z.string(), // "Fee cleared · instalment 1" / "Locked · instalment 2 overdue"
    tagVariant: zTagVariant,
    exemptUntil: zDate.nullable(),
    exemptReason: z.string().nullable(),
  }),
  hasSchedule: z.boolean(),
  revision: z.number().int(),
  instalments: z.array(zInstalmentRow),
  suggestedAmount: zPaise,
  /** Effective minimum for a partial payment (the full balance if smaller). */
  minPartial: zPaise,
  foot: z.string(),
  ledger: z.array(zLedgerRow),
  followUps: z.array(zFollowUpRow),
  promiseDate: zDate.nullable(),
  remindedToday: z.boolean(),
  pendingApprovals: z.array(z.object({ id: zId, kind: z.string(), title: z.string() })),
  restructureApprovalAbove: zPaise,
  methods: z.array(z.object({ method: zTenderMethod, label: z.string(), referenceLabel: z.string().nullable() })),
  allocationOrder: z.enum(['oldest_first', 'component_priority']),
  upiVpa: z.string().nullable(),
});
export type FeeAccount = z.output<typeof zFeeAccount>;

export const zAccountListRow = z.object({
  enrollmentId: zId,
  studentId: zId,
  studentName: z.string(),
  admissionNo: z.string().nullable(),
  batchCode: z.string(),
  branchName: z.string(),
  feeTotal: zPaise,
  paid: zPaise,
  outstanding: zPaise,
  overdue: zPaise,
  feeCleared: z.boolean(),
  hasSchedule: z.boolean(),
});

/* ───────────────────────── Collection desk ───────────────────────── */

export const zDeskMatch = z.object({
  studentId: zId,
  enrollmentId: zId,
  name: z.string(),
  admissionNo: z.string().nullable(),
  batchCode: z.string(),
  branchName: z.string(),
  phoneMasked: z.string(),
  matchedBy: z.enum(['admission_no', 'card', 'phone', 'name', 'student']),
  exact: z.boolean(),
});
export type DeskMatch = z.output<typeof zDeskMatch>;

export const zCashSessionInfo = z.object({
  id: zId,
  branchId: zId,
  branchName: z.string(),
  counterName: z.string(),
  cashierName: z.string(),
  cashierIsMe: z.boolean(),
  openedAt: zInstant,
  status: z.enum(['open', 'closed']),
  closedAt: zInstantNullable,
});

export const zPaymentResult = z.object({
  paymentId: zId,
  receiptId: zId,
  receiptNumber: z.string(),
  replay: z.boolean(),
  total: zPaise,
  status: z.enum(['pending_gateway', 'pending_clearance', 'cleared', 'bounced', 'voided', 'failed']),
  tenders: z.array(z.object({ method: zTenderMethod, label: z.string(), amount: zPaise, reference: z.string().nullable() })),
  tenderSummary: z.string(), // "UPI ₹10,000 + Cash ₹5,000"
  allocatedTo: z.string(), // "Instalment 2 · ₹15,000"
  excessCredit: zPaise,
  balanceAfter: zPaise,
  feeCleared: z.boolean(),
  enrollmentId: zId,
});
export type PaymentResult = z.output<typeof zPaymentResult>;

/* ───────────────────────── Invoices, receipts, credit notes ───────────────────────── */

export const zInvoiceRow = z.object({
  id: zId,
  number: z.string(),
  enrollmentId: zId,
  studentName: z.string(),
  admissionNo: z.string().nullable(),
  batchCode: z.string(),
  items: z.string(),
  issueDate: zDate,
  dueDate: zDate,
  amount: zPaise,
  paid: zPaise,
  status: z.enum(['issued', 'partially_paid', 'paid', 'cancelled']),
  statusLabel: z.string(),
  tag: zTagVariant,
  reprintCount: z.number().int(),
  cancelBlockedReason: z.string().nullable(),
});
export type InvoiceRow = z.output<typeof zInvoiceRow>;

export const zReceiptRow = z.object({
  id: zId,
  number: z.string(),
  paymentId: zId,
  enrollmentId: zId,
  studentName: z.string(),
  admissionNo: z.string().nullable(),
  batchCode: z.string(),
  tenders: z.string(),
  allocatedTo: z.string(),
  date: zDate,
  amount: zPaise,
  channel: z.string(),
  paymentStatus: z.string(),
  statusLabel: z.string(),
  tag: zTagVariant,
  voided: z.boolean(),
  reprintCount: z.number().int(),
  hasPendingCheque: z.boolean(),
  voidNeedsApproval: z.boolean(),
  voidBlockedReason: z.string().nullable(),
  /** Public verification page behind the receipt QR. */
  verifyPath: z.string(),
});
export type ReceiptRow = z.output<typeof zReceiptRow>;

export const zCreditNoteRow = z.object({
  id: zId,
  number: z.string(),
  enrollmentId: zId,
  studentName: z.string(),
  batchCode: z.string(),
  against: z.string(),
  date: zDate,
  amount: zPaise,
  reason: z.string(),
});
export type CreditNoteRow = z.output<typeof zCreditNoteRow>;

const zDocListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/* ───────────────────────── Dues ───────────────────────── */

export const AGEING_FILTERS = ['all', '0-30', '31-60', '61-90', '90+'] as const;

export const zDuesRow = z.object({
  instalmentId: zId,
  enrollmentId: zId,
  studentName: z.string(),
  guardianLine: z.string(),
  batchId: zId,
  batchCode: z.string(),
  instalment: z.string(),
  overdue: zPaise,
  bucket: z.enum(['0-30', '31-60', '61-90', '90+']),
  ageLabel: z.string(),
  ageTag: zTagVariant,
  lastReminder: z.string(),
  promiseDate: zDate.nullable(),
  remindedToday: z.boolean(),
});
export type DuesRow = z.output<typeof zDuesRow>;

const zDuesQuery = z.object({
  bucket: z.enum(AGEING_FILTERS).default('all'),
  batchId: zId.optional(),
  promise: z.enum(['any', 'promised', 'none', 'broken']).default('any'),
});

/* ───────────────────────── Day book ───────────────────────── */

export const zDayBookCounter = z.object({
  sessionId: zId.nullable(),
  label: z.string(), // "Counter 1 · Joseph Mathew" / "Online · Razorpay"
  kind: z.enum(['counter', 'online']),
  opened: z.string(),
  openingCash: zPaise.nullable(),
  upi: zPaise,
  cash: zPaise.nullable(),
  card: zPaise,
  cheque: zPaise.nullable(),
  other: zPaise,
  deposited: zPaise.nullable(),
  depositedLabel: z.string().nullable(),
  closingCash: zPaise.nullable(),
  statusLabel: z.string(),
  tag: zTagVariant,
  open: z.boolean(),
});

export const zDayBook = z.object({
  date: zDate,
  dateLabel: z.string(),
  branchId: zId,
  branchName: z.string(),
  branches: z.array(z.object({ id: zId, name: z.string() })),
  dayClosed: z.boolean(),
  dayClosedLabel: z.string().nullable(),
  statusLabel: z.string(),
  counters: z.array(zDayBookCounter),
  controls: z.object({
    periodLocks: z.array(z.object({ month: zDate, label: z.string(), status: z.enum(['locked', 'reopened']), note: z.string() })),
    lockableMonth: z.object({ month: zDate, label: z.string() }).nullable(),
    voidsToday: z.string(),
    depositDue: z.string(),
  }),
});
export type DayBook = z.output<typeof zDayBook>;

export const DENOMINATIONS = ['500', '200', '100', 'coins'] as const;

/* ───────────────────────── Reconciliation ───────────────────────── */

export const zSettlementItemRow = z.object({
  id: zId,
  gatewayPaymentId: z.string(),
  amount: zPaise,
  notes: z.string().nullable(),
  recorded: z.string().nullable(), // "pmt …9f21 · RCPT 000184"
  recordedAmount: zPaise.nullable(),
  studentName: z.string().nullable(),
  enrollmentId: zId.nullable(),
  status: z.enum(['matched', 'unmatched', 'amount_differs', 'resolved']),
  statusLabel: z.string(),
  tag: zTagVariant,
  resolution: z.string().nullable(),
});

export const zReconciliation = z.object({
  settlements: z.array(z.object({ id: zId, label: z.string() })),
  settlement: z
    .object({
      id: zId,
      externalId: z.string(),
      gateway: z.string(),
      settledOn: zDate,
      label: z.string(),
      amount: zPaise,
      fees: zPaise,
      paymentCount: z.number().int(),
      utr: z.string().nullable(),
    })
    .nullable(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  webhookFailures: z.number().int(),
  items: z.array(zSettlementItemRow),
});
export type Reconciliation = z.output<typeof zReconciliation>;

/* ───────────────────────── Settings ───────────────────────── */

export const zFinanceSettingsBody = z.object({
  numbering: z.object({ invoice: z.string().trim().min(3), receipt: z.string().trim().min(3), credit_note: z.string().trim().min(3) }),
  gstRate: z.number().min(0).max(28),
  sac: z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4–8 digits'),
  lateFee: z.object({ graceDays: z.number().int().min(0).max(60), perDay: zPaise.nonnegative(), capPct: z.number().min(0).max(100) }),
  minPartial: zPaise.nonnegative(),
  allocationOrder: z.enum(['oldest_first', 'component_priority']),
  methods: z.object({ upi: z.boolean(), cash: z.boolean(), card: z.boolean(), cheque: z.boolean(), transfer: z.boolean(), online: z.boolean() }),
  upiVpa: z
    .string()
    .trim()
    .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a UPI ID like exatech@icici')
    .nullable(),
  reminderDaysBefore: z.array(z.number().int().min(0).max(60)).max(5),
  reminderDaysAfter: z.array(z.number().int().min(1).max(120)).max(8),
});
export type FinanceSettingsBody = z.input<typeof zFinanceSettingsBody>;

export const zFinanceSettings = zFinanceSettingsBody.extend({
  restructureApprovalAbove: zPaise,
  chequeUnlocksAfterClearance: z.boolean(),
  discountThresholds: z.object({ financePct: z.number(), superAdminPct: z.number() }),
  preview: z.object({ branchCode: z.string(), fy: z.string(), invoiceSeq: z.number().int(), receiptSeq: z.number().int(), creditNoteSeq: z.number().int() }),
  samples: z.object({ invoiceId: zId.nullable(), receiptId: zId.nullable(), enrollmentId: zId.nullable() }),
});
export type FinanceSettingsView = z.output<typeof zFinanceSettings>;

/* ───────────────────────── Contract ───────────────────────── */

export const financeContract = {
  dashboard: route({ method: 'GET', path: '/api/finance/dashboard', response: zFinanceDashboard }),
  /** GST summary for a month (CSV): taxable, CGST/SGST split, total by SAC. ?month=YYYY-MM */
  gstSummaryPath: '/api/finance/reports/gst-summary.csv',
  /** Tally-importable vouchers (CSV) for a month. ?month=YYYY-MM */
  tallyExportPath: '/api/finance/reports/tally.csv',

  /* desk */
  deskSearch: route({
    method: 'GET',
    path: '/api/finance/desk/search',
    query: z.object({ q: z.string().trim().max(120).optional(), studentId: zId.optional() }),
    response: z.object({ items: z.array(zDeskMatch), cardRejected: z.boolean() }),
  }),
  deskSession: route({
    method: 'GET',
    path: '/api/finance/desk/session',
    query: z.object({ counter: z.string().trim().min(1).max(40).default('Counter 1') }),
    response: z.object({ counters: z.array(z.string()), sessions: z.array(zCashSessionInfo), dayClosedBranches: z.array(z.string()) }),
  }),
  collect: route({
    method: 'POST',
    path: '/api/finance/payments',
    body: z.object({
      enrollmentId: zId,
      tenders: z.array(zTender).min(1, 'Add at least one tender').max(4),
      counterName: z.string().trim().min(1).max(40),
      idempotencyKey: z.string().trim().min(8).max(80),
    }),
    response: zPaymentResult,
  }),
  /** UPI QR (PNG) for the exact amount: upi://pay?pa=<VPA>&am=…&tn=<adm no>. ?enrollmentId=&amount=(paise) */
  upiQrPath: '/api/finance/desk/upi-qr.png',
  /** Code 128 of an admission number (PNG). ?text= */
  barcodePath: '/api/finance/barcode.png',
  chequeOutcome: route({
    method: 'POST',
    path: '/api/finance/payments/:id/cheque',
    body: z.object({ outcome: z.enum(['cleared', 'bounced']), note: z.string().trim().max(200).optional() }),
    response: zOk,
  }),

  /* accounts */
  accounts: route({
    method: 'GET',
    path: '/api/finance/accounts',
    query: z.object({ q: z.string().trim().max(80).optional(), filter: z.enum(['all', 'overdue', 'locked', 'no_schedule']).default('all'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    response: z.object({ items: z.array(zAccountListRow), total: z.number().int() }),
  }),
  account: route({ method: 'GET', path: '/api/finance/accounts/:enrollmentId', response: zFeeAccount }),
  grantExemption: route({
    method: 'POST',
    path: '/api/finance/accounts/:enrollmentId/exemption',
    body: z.object({ until: zDate, reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) }),
    response: zOk,
  }),
  restructure: route({
    method: 'POST',
    path: '/api/finance/accounts/:enrollmentId/restructure',
    body: z.object({
      rows: z.array(z.object({ label: z.string().trim().min(1).max(60), dueDate: zDate, amount: zPaise.positive() })).min(1).max(12),
      reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300),
    }),
    response: z.object({ status: z.enum(['applied', 'approval_requested']), message: z.string() }),
  }),
  remindAccount: route({ method: 'POST', path: '/api/finance/accounts/:enrollmentId/remind', response: z.object({ sent: z.number().int() }) }),
  logCall: route({
    method: 'POST',
    path: '/api/finance/accounts/:enrollmentId/calls',
    body: z.object({ outcome: z.string().trim().min(3, 'Note the outcome of the call').max(300), promiseDate: zDate.nullable().optional() }),
    response: zOk,
  }),
  paymentLink: route({
    method: 'POST',
    path: '/api/finance/accounts/:enrollmentId/payment-link',
    response: z.object({ url: z.string(), amount: zPaise, description: z.string() }),
  }),
  requestRefund: route({
    method: 'POST',
    path: '/api/finance/accounts/:enrollmentId/refund',
    body: z.object({ amount: zPaise.positive(), reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) }),
    response: z.object({ approvalId: zId, message: z.string() }),
  }),

  /* invoices / receipts / credit notes */
  invoices: route({ method: 'GET', path: '/api/finance/invoices', query: zDocListQuery, response: z.object({ items: z.array(zInvoiceRow), total: z.number().int() }) }),
  receipts: route({ method: 'GET', path: '/api/finance/receipts', query: zDocListQuery, response: z.object({ items: z.array(zReceiptRow), total: z.number().int() }) }),
  creditNotes: route({ method: 'GET', path: '/api/finance/credit-notes', query: zDocListQuery, response: z.object({ items: z.array(zCreditNoteRow), total: z.number().int() }) }),
  cancelInvoice: route({
    method: 'POST',
    path: '/api/finance/invoices/:id/cancel',
    body: z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) }),
    response: z.object({ creditNoteId: zId, creditNoteNumber: z.string() }),
  }),
  reprintInvoice: route({ method: 'POST', path: '/api/finance/invoices/:id/reprint', response: z.object({ url: z.string(), reprintCount: z.number().int() }) }),
  reprintReceipt: route({
    method: 'POST',
    path: '/api/finance/receipts/:id/reprint',
    body: z.object({ format: z.enum(['A4', 'A5', '80mm']).default('A4') }),
    response: z.object({ url: z.string(), reprintCount: z.number().int() }),
  }),
  resendReceipt: route({ method: 'POST', path: '/api/finance/receipts/:id/resend', response: z.object({ sent: z.number().int() }) }),
  voidReceipt: route({
    method: 'POST',
    path: '/api/finance/receipts/:id/void',
    body: z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) }),
    response: z.object({ status: z.enum(['voided', 'approval_requested']), message: z.string() }),
  }),
  bulkPreview: route({
    method: 'GET',
    path: '/api/finance/invoices/bulk',
    query: z.object({ batchId: zId, withinDays: z.coerce.number().int().min(0).max(90).default(7) }),
    response: z.object({ count: z.number().int(), amount: zPaise, students: z.number().int() }),
  }),
  bulkGenerate: route({
    method: 'POST',
    path: '/api/finance/invoices/bulk',
    body: z.object({ batchId: zId, withinDays: z.number().int().min(0).max(90) }),
    response: z.object({ issued: z.number().int(), amount: zPaise }),
  }),
  batches: route({
    method: 'GET',
    path: '/api/finance/batches',
    response: z.array(z.object({ id: zId, code: z.string(), branchName: z.string() })),
  }),

  /* dues */
  dues: route({
    method: 'GET',
    path: '/api/finance/dues',
    query: zDuesQuery,
    response: z.object({ items: z.array(zDuesRow), shown: z.number().int(), total: z.number().int(), totalAmount: zPaise, students: z.number().int() }),
  }),
  remind: route({
    method: 'POST',
    path: '/api/finance/dues/remind',
    body: z.object({ instalmentIds: z.array(zId).min(1).max(500) }),
    response: z.object({ sent: z.number().int() }),
  }),
  remindAll: route({ method: 'POST', path: '/api/finance/dues/remind-all', body: zDuesQuery, response: z.object({ sent: z.number().int() }) }),
  runReminders: route({ method: 'POST', path: '/api/finance/dues/run-reminders', response: z.object({ reminded: z.number().int(), lateFees: z.number().int(), skippedHoliday: z.boolean() }) }),

  /* day book */
  dayBook: route({
    method: 'GET',
    path: '/api/finance/day-book',
    query: z.object({ date: zDate.optional(), branchId: zId.optional() }),
    response: zDayBook,
  }),
  closeCounter: route({
    method: 'POST',
    path: '/api/finance/day-book/close',
    body: z.object({
      branchId: zId,
      date: zDate,
      sessionId: zId.nullable(),
      denominations: z.record(z.string(), z.number().int().min(0)).default({}),
      explanation: z.string().trim().max(300).optional(),
    }),
    response: z.object({ dayClosed: z.boolean(), difference: zPaise, message: z.string() }),
  }),
  lockPeriod: route({
    method: 'POST',
    path: '/api/finance/period-locks',
    body: z.object({ branchId: zId, month: zDate }),
    response: zOk,
  }),

  /* reconciliation */
  reconciliation: route({
    method: 'GET',
    path: '/api/finance/reconciliation',
    query: z.object({ settlementId: zId.optional() }),
    response: zReconciliation,
  }),
  uploadSettlement: route({
    method: 'POST',
    path: '/api/finance/reconciliation/settlements',
    body: z.object({ fileId: zId, gateway: z.enum(['razorpay', 'bank']).default('razorpay') }),
    response: z.object({ settlementId: zId, items: z.number().int(), matched: z.number().int() }),
  }),
  autoMatch: route({
    method: 'POST',
    path: '/api/finance/reconciliation/:settlementId/auto-match',
    response: z.object({ matched: z.number().int(), differs: z.number().int(), unmatched: z.number().int() }),
  }),
  recordAdvance: route({
    method: 'POST',
    path: '/api/finance/reconciliation/items/:itemId/advance',
    body: z.object({ enrollmentId: zId }),
    response: z.object({ receiptNumber: z.string(), studentName: z.string() }),
  }),
  resolveItem: route({
    method: 'POST',
    path: '/api/finance/reconciliation/items/:itemId/resolve',
    body: z.object({ note: z.string().trim().min(5, 'Describe what you found (at least 5 characters)').max(300) }),
    response: zOk,
  }),

  /* settings */
  settings: route({ method: 'GET', path: '/api/finance/settings', response: zFinanceSettings }),
  saveSettings: route({ method: 'PUT', path: '/api/finance/settings', body: zFinanceSettingsBody, response: zFinanceSettings }),

  /* portal checkout helpers (sandbox + Razorpay pages) */
  orderCheckout: route({ method: 'GET', path: '/api/portal/payments/orders/:orderId/checkout', response: zOrder.extend({ status: z.enum(['created', 'paid', 'failed', 'expired']), studentName: z.string(), payerName: z.string() }) }),

  /* public verification */
  verify: route({
    method: 'GET',
    path: '/api/public/receipts/:token',
    response: z.object({
      kind: z.enum(['receipt', 'invoice', 'credit_note']),
      title: z.string(),
      number: z.string(),
      amount: zPaise,
      date: zDate,
      branch: z.string(),
      institution: z.string(),
      student: z.string(),
      status: z.enum(['valid', 'voided', 'pending_clearance', 'cancelled', 'bounced']),
      statusLabel: z.string(),
      issuedAt: zInstant,
    }),
  }),
};

/** Extra document path (credit notes are not in DOCUMENT_PATHS). */
export const FINANCE_DOCUMENT_PATHS = {
  creditNote: (id: string) => `/api/documents/credit-notes/${id}.pdf`,
} as const;

