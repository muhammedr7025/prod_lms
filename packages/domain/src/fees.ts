import { addDays, daysBetween, type ISODate } from './dates';
import { percentOf, roundRupee, splitByPercent, sumPaise, type Paise } from './money';

/* ───────────────────────── Fee plans & quotes ───────────────────────── */

export interface FeeComponent {
  name: string;
  amount: Paise; // before tax and discount
}

export interface ScheduleStep {
  label: string;
  pct: number; // share of the total, all steps sum to 100
  dueOffsetDays: number; // from admission / batch start
}

export type FeePlanKind = 'one_time' | 'split' | 'instalments' | 'custom';

export interface FeeQuote {
  subtotal: Paise;
  discountPct: number;
  discount: Paise;
  earlyPayDiscount: Paise;
  taxable: Paise;
  gstRate: number;
  gst: Paise;
  total: Paise;
}

/**
 * subtotal − discount (− early-pay discount) = taxable; GST on taxable; total.
 * Matches the admission wizard preview: 48,000 − 12% (5,760) = 42,240 + 18% GST (7,603) = 49,843.
 */
export function quoteFee(
  components: readonly FeeComponent[],
  discountPct: number,
  gstRate: number,
  earlyPayDiscountPct = 0,
): FeeQuote {
  const subtotal = sumPaise(components.map((c) => c.amount));
  const discount = percentOf(subtotal, discountPct);
  const afterDiscount = subtotal - discount;
  const earlyPayDiscount = percentOf(afterDiscount, earlyPayDiscountPct);
  const taxable = afterDiscount - earlyPayDiscount;
  const gst = percentOf(taxable, gstRate);
  return { subtotal, discountPct, discount, earlyPayDiscount, taxable, gstRate, gst, total: taxable + gst };
}

export interface InstalmentDraft {
  seq: number;
  label: string;
  dueDate: ISODate;
  amount: Paise;
}

/** Build the instalment schedule. Amounts always sum exactly to `total`. */
export function buildSchedule(total: Paise, steps: readonly ScheduleStep[], startDate: ISODate): InstalmentDraft[] {
  const pctSum = steps.reduce((a, s) => a + s.pct, 0);
  if (steps.length === 0 || Math.abs(pctSum - 100) > 0.001) {
    throw new Error(`Schedule percentages must sum to 100 (got ${pctSum})`);
  }
  const amounts = splitByPercent(total, steps.map((s) => s.pct));
  return steps.map((s, i) => ({
    seq: i + 1,
    label: s.label,
    dueDate: addDays(startDate, s.dueOffsetDays),
    amount: amounts[i]!,
  }));
}

/* ───────────────────────── Discounts ───────────────────────── */

export interface DiscountThresholds {
  financePct: number; // above this Finance Manager approves (default 10)
  superAdminPct: number; // above this Super Admin approves (default 20)
}

export const DEFAULT_DISCOUNT_THRESHOLDS: DiscountThresholds = { financePct: 10, superAdminPct: 20 };

export type DiscountApproval = 'none' | 'finance' | 'super_admin';

export function discountApprovalLevel(pct: number, t: DiscountThresholds = DEFAULT_DISCOUNT_THRESHOLDS): DiscountApproval {
  if (pct > t.superAdminPct) return 'super_admin';
  if (pct > t.financePct) return 'finance';
  return 'none';
}

/* ───────────────────────── Fee clearance ───────────────────────── */

export type ClearancePolicy =
  | { kind: 'current_instalment' }
  | { kind: 'fully_paid' }
  | { kind: 'percentage'; percentage: number };

export interface InstalmentState {
  dueDate: ISODate;
  amount: Paise;
  /** Only money that counts: cleared payments (pending cheques excluded). */
  paid: Paise;
}

export interface ClearanceInput {
  instalments: readonly InstalmentState[];
  policy: ClearancePolicy;
  today: ISODate;
  /** Temporary exemption granted by an admin (inclusive). */
  exemptUntil?: ISODate | null;
}

export interface ClearanceResult {
  cleared: boolean;
  /** Last date the student stays cleared without another payment (next due − 1). null = indefinitely. */
  clearedUntil: ISODate | null;
  exempt: boolean;
  reason: string;
}

/**
 * Fee clearance (PRD §12 rule 3). Pure: computed server-side, cached on the
 * enrollment and recomputed on every payment, void, waiver or exemption.
 */
export function computeClearance(input: ClearanceInput): ClearanceResult {
  const { instalments, policy, today, exemptUntil } = input;
  const sorted = [...instalments].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const total = sumPaise(sorted.map((i) => i.amount));
  const paid = sumPaise(sorted.map((i) => Math.min(i.paid, i.amount)));
  const exempt = !!exemptUntil && exemptUntil >= today;

  let cleared: boolean;
  let reason: string;
  let clearedUntil: ISODate | null = null;

  switch (policy.kind) {
    case 'fully_paid':
      cleared = paid >= total;
      reason = cleared ? 'Fully paid' : 'Policy requires the full fee to be paid';
      break;
    case 'percentage': {
      const pct = total === 0 ? 100 : (paid / total) * 100;
      cleared = pct + 1e-9 >= policy.percentage;
      reason = cleared ? `${Math.floor(pct)}% paid` : `Policy requires ${policy.percentage}% paid (${Math.floor(pct)}% so far)`;
      break;
    }
    case 'current_instalment':
    default: {
      const due = sorted.filter((i) => i.dueDate <= today);
      const unpaid = due.find((i) => i.paid < i.amount);
      cleared = !unpaid;
      const next = sorted.find((i) => i.dueDate > today && i.paid < i.amount);
      clearedUntil = cleared && next ? addDays(next.dueDate, -1) : null;
      reason = cleared ? 'All instalments due so far are paid' : `Instalment due ${unpaid!.dueDate} is not fully paid`;
      break;
    }
  }

  if (!cleared && exempt) {
    return { cleared: true, clearedUntil: exemptUntil!, exempt: true, reason: `Temporary exemption until ${exemptUntil}` };
  }
  return { cleared, clearedUntil, exempt, reason };
}

/* ───────────────────────── Content access ───────────────────────── */

export type Visibility = 'always' | 'fee_gated' | 'scheduled';

/**
 * canAccess(enrollment, item) = visibility == ALWAYS or (releasedAt <= now and clearance(enrollment)).
 */
export function canAccessMaterial(
  item: { visibility: Visibility; releaseAt: Date | null },
  enrollment: { feeCleared: boolean },
  now: Date = new Date(),
): boolean {
  if (item.visibility === 'always') return true;
  const released = !item.releaseAt || item.releaseAt.getTime() <= now.getTime();
  return released && enrollment.feeCleared;
}

/* ───────────────────────── Payment allocation ───────────────────────── */

export interface OpenItem {
  id: string;
  dueDate: ISODate;
  balance: Paise;
  /** Lower = earlier when allocating by component priority. */
  priority?: number;
}

export type AllocationOrder = 'oldest_first' | 'component_priority';

export interface AllocationResult {
  allocations: { id: string; amount: Paise }[];
  excess: Paise; // held as credit
}

export function allocatePayment(amount: Paise, items: readonly OpenItem[], order: AllocationOrder = 'oldest_first'): AllocationResult {
  if (amount < 0) throw new Error('Payment amount must be positive');
  const sorted = [...items]
    .filter((i) => i.balance > 0)
    .sort((a, b) =>
      order === 'component_priority'
        ? (a.priority ?? 99) - (b.priority ?? 99) || a.dueDate.localeCompare(b.dueDate)
        : a.dueDate.localeCompare(b.dueDate) || (a.priority ?? 99) - (b.priority ?? 99),
    );
  let remaining = amount;
  const allocations: { id: string; amount: Paise }[] = [];
  for (const item of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(item.balance, remaining);
    allocations.push({ id: item.id, amount: take });
    remaining -= take;
  }
  return { allocations, excess: remaining };
}

/* ───────────────────────── Late fee ───────────────────────── */

export interface LateFeeRule {
  graceDays: number; // default 3
  perDay: Paise; // default ₹100
  capPct: number; // of the instalment amount, default 5
}

export const DEFAULT_LATE_FEE: LateFeeRule = { graceDays: 3, perDay: 10_000, capPct: 5 };

/** Late fee accrues per day on the unpaid balance after grace, capped. Zero when balance is zero. */
export function computeLateFee(
  inst: { dueDate: ISODate; amount: Paise; balance: Paise },
  today: ISODate,
  rule: LateFeeRule = DEFAULT_LATE_FEE,
): Paise {
  if (inst.balance <= 0) return 0;
  const lateDays = daysBetween(inst.dueDate, today) - rule.graceDays;
  if (lateDays <= 0) return 0;
  const cap = percentOf(inst.amount, rule.capPct);
  return Math.min(lateDays * rule.perDay, cap);
}

/* ───────────────────────── Dues ageing ───────────────────────── */

export type AgeingBucket = '0-30' | '31-60' | '61-90' | '90+';

export function ageingBucket(dueDate: ISODate, today: ISODate): AgeingBucket {
  const d = daysBetween(dueDate, today);
  if (d <= 30) return '0-30';
  if (d <= 60) return '31-60';
  if (d <= 90) return '61-90';
  return '90+';
}

/* ───────────────────────── Collection desk ───────────────────────── */

export const DEFAULT_MIN_PARTIAL: Paise = 1_000_00;

export interface TenderLine {
  method: 'upi' | 'cash' | 'card' | 'cheque' | 'transfer' | 'online';
  amount: Paise;
  reference?: string | null;
}

export interface DeskValidation {
  ok: boolean;
  errors: string[];
}

export function validateDeskPayment(
  tenders: readonly TenderLine[],
  outstanding: Paise,
  minPartial: Paise = DEFAULT_MIN_PARTIAL,
): DeskValidation {
  const errors: string[] = [];
  const total = sumPaise(tenders.map((t) => t.amount));
  if (tenders.length === 0) errors.push('Add at least one tender');
  if (tenders.some((t) => !Number.isInteger(t.amount) || t.amount <= 0)) errors.push('Each tender needs a positive amount');
  if (total > 0 && total < minPartial && total < outstanding) {
    errors.push(`Minimum partial payment is ₹${(minPartial / 100).toLocaleString('en-IN')}`);
  }
  for (const t of tenders) {
    if (['upi', 'card', 'cheque', 'transfer'].includes(t.method) && !t.reference?.trim()) {
      errors.push(`${referenceLabel(t.method)} is required for ${t.method.toUpperCase()}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function referenceLabel(method: TenderLine['method']): string {
  switch (method) {
    case 'upi':
      return 'UPI transaction ID';
    case 'card':
      return 'Card approval code';
    case 'cheque':
      return 'Cheque number';
    case 'transfer':
      return 'Bank reference';
    default:
      return 'Reference';
  }
}

/** Round amounts to rupees for display/inputs that accept rupees. */
export function rupeeInputToPaise(value: string | number): Paise | null {
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return roundRupee(Math.round(n * 100));
}

/* ───────────────────────── Batch transfer ───────────────────────── */

/**
 * Pro-rated adjustment when moving between batches with different fees.
 * Positive = student owes more, negative = credit.
 */
export function transferAdjustment(fromTotal: Paise, toTotal: Paise, progressPct: number): Paise {
  const remainingShare = Math.max(0, Math.min(100, 100 - progressPct));
  return roundRupee(((toTotal - fromTotal) * remainingShare) / 100);
}
