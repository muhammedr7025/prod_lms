import type { TagVariant } from '@exatech/contracts';
import { allocatePayment, addDays, computeLateFee, daysBetween, formatDayMonth, formatINR, sumPaise, type AllocationOrder, type ISODate, type LateFeeRule, type Paise, type TenderLine } from '@exatech/domain';

/**
 * Pure finance arithmetic shared by the services and their unit tests.
 * An instalment's open balance includes its accrued late fee; clearance only
 * ever looks at principal paid with cleared money (pending cheques excluded).
 */
export interface InstalmentLike {
  id: string;
  seq: number;
  label: string;
  dueDate: ISODate;
  amount: Paise;
  paid: Paise;
  pendingPaid: Paise;
  waived: Paise;
  lateFee: Paise;
  status: 'due' | 'partially_paid' | 'paid' | 'waived' | 'cancelled';
}

export const isActive = (i: Pick<InstalmentLike, 'status'>) => i.status !== 'cancelled';

/** Principal still unpaid (pending cheques count as paid for this purpose: no double collection). */
export function principalOpen(i: InstalmentLike): Paise {
  if (!isActive(i)) return 0;
  return Math.max(0, i.amount - i.waived - i.paid - i.pendingPaid);
}

/** Principal + accrued late fee still open. */
export function openBalance(i: InstalmentLike): Paise {
  if (!isActive(i)) return 0;
  return Math.max(0, i.amount + i.lateFee - i.waived - i.paid - i.pendingPaid);
}

export function lateFeeOpen(i: InstalmentLike): Paise {
  return Math.max(0, openBalance(i) - principalOpen(i));
}

/**
 * Late fee owed on an instalment today: accrued per `computeLateFee` (per day
 * on the unpaid balance after grace, capped) — whether or not the daily run
 * has posted it yet — less what has already been paid against late fees.
 */
export function lateFeeDue(i: InstalmentLike, today: ISODate, rule: LateFeeRule): Paise {
  if (!isActive(i)) return 0;
  const accrued = computeLateFee({ dueDate: i.dueDate, amount: i.amount - i.waived, balance: principalOpen(i) }, today, rule);
  const paidLate = i.lateFee - lateFeeOpen(i);
  return Math.max(lateFeeOpen(i), accrued - paidLate);
}

/** Stored status after money moves. */
export function instalmentStatus(i: Omit<InstalmentLike, 'status'> & { status?: InstalmentLike['status'] }): InstalmentLike['status'] {
  if (i.status === 'cancelled') return 'cancelled';
  if (i.amount > 0 && i.waived >= i.amount + i.lateFee) return 'waived';
  if (i.paid + i.waived >= i.amount + i.lateFee) return 'paid';
  if (i.paid + i.pendingPaid > 0) return 'partially_paid';
  return 'due';
}

export type InstalmentState = 'paid' | 'partially_paid' | 'overdue' | 'due_today' | 'not_due' | 'pending_clearance' | 'waived' | 'cancelled';

/** Display state for desk / account / schedule rows. */
export function instalmentState(i: InstalmentLike, today: ISODate): { state: InstalmentState; label: string; tag: TagVariant } {
  if (i.status === 'cancelled') return { state: 'cancelled', label: 'Restructured', tag: 'plain' };
  if (i.status === 'waived') return { state: 'waived', label: 'Waived', tag: 'neutral' };
  const open = openBalance(i);
  if (open === 0 && i.pendingPaid > 0) return { state: 'pending_clearance', label: 'Pending clearance', tag: 'outline' };
  if (open === 0) return { state: 'paid', label: 'Paid', tag: 'accent' };
  if (i.dueDate < today) {
    const d = daysBetween(i.dueDate, today);
    return { state: 'overdue', label: `Overdue ${d} day${d === 1 ? '' : 's'}`, tag: 'ink' };
  }
  if (i.dueDate === today) return { state: 'due_today', label: 'Due today', tag: 'ink' };
  if (i.pendingPaid > 0) return { state: 'pending_clearance', label: 'Pending clearance', tag: 'outline' };
  if (i.paid > 0) return { state: 'partially_paid', label: 'Partially paid', tag: 'outline' };
  return { state: 'not_due', label: 'Not due', tag: 'neutral' };
}

/** Oldest open instalment: the desk's "suggested" row and the portal's next due. */
export function suggestedInstalment<T extends InstalmentLike>(insts: readonly T[]): T | null {
  return [...insts].filter((i) => openBalance(i) > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.seq - b.seq)[0] ?? null;
}

export interface PlannedAllocation {
  instalmentId: string;
  amount: Paise;
  /** From a cheque awaiting clearance. */
  pending: boolean;
}

/**
 * Split a payment across open instalments: cleared money first (it is what
 * unlocks content), then cheque money as pending. Anything left is excess,
 * held as credit on the fee account.
 */
export function planAllocation(tenders: readonly TenderLine[], insts: readonly InstalmentLike[], order: AllocationOrder): { allocations: PlannedAllocation[]; excess: Paise; outstanding: Paise; total: Paise; pendingTotal: Paise } {
  const total = sumPaise(tenders.map((t) => t.amount));
  const pendingTotal = sumPaise(tenders.filter((t) => t.method === 'cheque').map((t) => t.amount));
  const items = insts.filter(isActive).map((i) => ({ id: i.id, dueDate: i.dueDate, balance: openBalance(i), priority: i.seq }));
  const outstanding = sumPaise(items.map((i) => i.balance));
  const first = allocatePayment(total - pendingTotal, items, order);
  const left = items.map((it) => ({ ...it, balance: it.balance - (first.allocations.find((a) => a.id === it.id)?.amount ?? 0) }));
  const second = allocatePayment(pendingTotal, left, order);
  const allocations: PlannedAllocation[] = [
    ...first.allocations.map((a) => ({ instalmentId: a.id, amount: a.amount, pending: false })),
    ...second.allocations.map((a) => ({ instalmentId: a.id, amount: a.amount, pending: true })),
  ];
  return { allocations, excess: first.excess + second.excess, outstanding, total, pendingTotal };
}

/** Apply planned allocations to instalment rows (pure; returns the updated copies). */
export function applyAllocations<T extends InstalmentLike>(insts: readonly T[], allocations: readonly PlannedAllocation[]): T[] {
  return insts.map((i) => {
    const mine = allocations.filter((a) => a.instalmentId === i.id);
    if (mine.length === 0) return i;
    const paid = i.paid + sumPaise(mine.filter((a) => !a.pending).map((a) => a.amount));
    const pendingPaid = i.pendingPaid + sumPaise(mine.filter((a) => a.pending).map((a) => a.amount));
    const next = { ...i, paid, pendingPaid };
    return { ...next, status: instalmentStatus(next) };
  });
}

/** Invoice status from what has been paid (cleared money) against it. */
export function invoiceStatus(total: Paise, paid: Paise, current: 'issued' | 'partially_paid' | 'paid' | 'cancelled'): 'issued' | 'partially_paid' | 'paid' | 'cancelled' {
  if (current === 'cancelled') return 'cancelled';
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partially_paid';
  return 'issued';
}

/** Taxable value and GST inside a GST-inclusive amount, rounded to whole rupees. */
export function splitGst(inclusive: Paise, rate: number): { taxable: Paise; tax: Paise; cgst: Paise; sgst: Paise } {
  const taxable = Math.round(inclusive / (1 + rate / 100) / 100) * 100;
  const tax = inclusive - taxable;
  const cgst = cgstOf(tax);
  return { taxable, tax, cgst, sgst: tax - cgst };
}

/** CGST half of a GST amount in whole rupees (SGST is the remainder). */
export const cgstOf = (tax: Paise): Paise => Math.round(tax / 2 / 100) * 100;

export const METHOD_SHORT: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Transfer', online: 'Razorpay' };

export function tenderSummary(tenders: readonly { method: string; amount: Paise }[]): string {
  if (tenders.length === 1) return `${METHOD_SHORT[tenders[0]!.method] ?? tenders[0]!.method} ${formatINR(tenders[0]!.amount)}`;
  return tenders.map((t) => `${METHOD_SHORT[t.method] ?? t.method} ${formatINR(t.amount)}`).join(' + ');
}

/** "Late fee applies after 18 Oct" boundary for an instalment. */
export function lateFeeStarts(dueDate: ISODate, graceDays: number): string {
  return formatDayMonth(addDays(dueDate, graceDays));
}

/** Short tail of an id for tables: "…9f21". */
export const tail = (id: string, n = 4) => `…${id.replace(/-/g, '').slice(-n)}`;

/** Collapse long gateway ids: "pay_Nq7K…31". */
export function shortGatewayId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-2)}`;
}

/** Last numeric run of a document number: "TVM/RCPT/2026-27/000184" → "000184". */
export function shortNumber(n: string): string {
  const m = /(\d+)$/.exec(n);
  return m ? m[1]! : n;
}
