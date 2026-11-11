import { Injectable } from '@nestjs/common';
import type { DiscountRow, FeeAccount } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, inArray, sql, type DbOrTx, type Tx } from '@exatech/db';
import {
  cumulativeDiscountPct,
  DEFAULT_DISCOUNT_THRESHOLDS,
  discountApprovalLevel,
  DISCOUNT_KIND_LABEL,
  DISCOUNT_SOURCE_LABEL,
  financialYear,
  formatINR,
  quoteFee,
  splitProportionally,
  sumPaise,
  todayIST,
  type DiscountKind,
  type DiscountThresholds,
  type ISODate,
} from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService } from '../../core/auth/access.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FinanceShared, type EnrollmentCtx } from './finance.shared';
import { instalmentStatus, isActive, principalOpen } from './ledger';

export interface DiscountRequest {
  kind: DiscountKind;
  /** Paise. */
  amount: number;
  reason: string;
  sourceName?: string | null;
}

/**
 * Fee discounts: referral, special discount, scholarship, other.
 *
 * A discount reduces what is still owed — it is applied to the unpaid instalments (through `waived`, which
 * invoices, balances, late fees and fee-gated notes already honour) and recorded in the ledger and in
 * fee_discount with its reason. It can never take the fee below what has been paid (that is a refund).
 *
 * Approval looks at the CUMULATIVE reduction against the course's list price, not at the size of one
 * discount, so a large discount cannot be split into small ones to avoid approval:
 *   up to the Finance threshold ........ Finance or Super Admin applies it
 *   up to the Super Admin threshold ..... Finance or Super Admin applies it (Finance is the authority at this level)
 *   above ............................... only a Super Admin applies it; a Finance request goes to the Super Admin queue
 */
@Injectable()
export class DiscountsService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async thresholds(): Promise<DiscountThresholds> {
    const inst = await this.access.institution();
    return inst.settings.discountThresholds ?? DEFAULT_DISCOUNT_THRESHOLDS;
  }

  /** The course's list price for this student: the fee plan (with GST), never below what is charged. */
  private async listTotal(db: DbOrTx, ec: EnrollmentCtx): Promise<number> {
    const e = ec.enrollment;
    const [applied] = await db.select({ n: sql<number>`coalesce(sum(${s.feeDiscount.amount}), 0)::bigint` }).from(s.feeDiscount).where(eq(s.feeDiscount.enrollmentId, e.id));
    let list = e.feeTotal + Number(applied?.n ?? 0); // what it was before the recorded discounts
    if (e.feePlanId) {
      const [plan] = await db.select({ components: s.feePlan.components, gstRate: s.feePlan.gstRate }).from(s.feePlan).where(eq(s.feePlan.id, e.feePlanId));
      if (plan) list = Math.max(e.feeTotal, quoteFee(plan.components, 0, plan.gstRate).total);
    }
    return list;
  }

  /* ───────────────────────── read model for the fee account ───────────────────────── */

  async accountBlock(db: DbOrTx, ec: EnrollmentCtx, insts: (typeof s.instalment.$inferSelect)[]): Promise<FeeAccount['discounts']> {
    const t = await this.thresholds();
    const list = await this.listTotal(db, ec);
    const open = sumPaise(insts.filter(isActive).map(principalOpen));
    const rows = await db
      .select({ d: s.feeDiscount, by: s.user.name })
      .from(s.feeDiscount)
      .leftJoin(s.user, eq(s.user.id, s.feeDiscount.grantedBy))
      .where(eq(s.feeDiscount.enrollmentId, ec.enrollment.id))
      .orderBy(desc(s.feeDiscount.grantedAt));
    return {
      listTotal: list,
      openPrincipal: open,
      pctBelowList: cumulativeDiscountPct(list, ec.enrollment.feeTotal),
      thresholds: t,
      directUpToPct: can('institution:approvals.decide') ? 100 : t.superAdminPct,
      canGrant: can('finance:discount.approve') && ec.enrollment.status === 'active',
      history: rows.map((r) => this.row(r.d, r.by)),
    };
  }

  private row(d: typeof s.feeDiscount.$inferSelect, by: string | null): DiscountRow {
    return {
      id: d.id,
      kind: d.kind,
      kindLabel: DISCOUNT_KIND_LABEL[d.kind],
      amount: d.amount,
      pctAfter: d.pctAfter,
      reason: d.reason,
      sourceLabel: d.sourceName ? DISCOUNT_SOURCE_LABEL[d.kind] : null,
      sourceName: d.sourceName,
      grantedByName: by,
      grantedAt: d.grantedAt.toISOString(),
      origin: d.origin,
    };
  }

  /* ───────────────────────── grant ───────────────────────── */

  async grant(enrollmentId: string, input: DiscountRequest): Promise<{ status: 'applied' | 'approval_requested'; message: string; approvalId: string | null }> {
    const c = ctx();
    const sourceName = input.sourceName?.trim() || null;
    if (input.kind === 'referral' && !sourceName) throw invalid('Say who referred this student', { sourceName: 'Required for a referral' });
    const t = await this.thresholds();
    return this.db.tx(async (tx) => {
      const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(ec.branch.id);
      if (ec.enrollment.status !== 'active') throw invalid(`Only an active enrollment can be discounted (this one is ${ec.enrollment.status.replace('_', ' ')})`);
      const insts = (await this.shared.instalments(tx, enrollmentId)).filter(isActive);
      const open = sumPaise(insts.map(principalOpen));
      if (open <= 0) throw invalid('Nothing is left to discount — the fee is already fully paid. To return money, use a refund.', { amount: 'Fee fully paid' });
      if (input.amount > open) {
        throw invalid(`At most ${formatINR(open)} can be taken off — the rest is already paid. To return paid money, use a refund.`, { amount: `At most ${formatINR(open)}` });
      }
      // One discount at a time per student: while a request waits for the Super Admin nothing else changes the fee, so it cannot be split up or go stale.
      const [pending] = await tx
        .select({ id: s.approvalRequest.id })
        .from(s.approvalRequest)
        .where(and(eq(s.approvalRequest.entityType, 'enrollment'), eq(s.approvalRequest.entityId, enrollmentId), eq(s.approvalRequest.kind, 'discount'), eq(s.approvalRequest.status, 'pending')));
      if (pending) throw conflict('A discount for this student is already waiting for the Super Admin. Wait for the decision before giving another.');
      const list = await this.listTotal(tx, ec);
      const cum = cumulativeDiscountPct(list, ec.enrollment.feeTotal - input.amount);
      const level = discountApprovalLevel(cum, t);
      const direct = level !== 'super_admin' || can('institution:approvals.decide');
      const label = DISCOUNT_KIND_LABEL[input.kind];
      if (direct) {
        await this.apply(tx, enrollmentId, { ...input, sourceName }, { userId: c.userId, approvalId: null });
        return { status: 'applied' as const, message: `${label} · ${formatINR(input.amount)} taken off ${ec.student.name}’s fee (${cum}% below the list price in total)`, approvalId: null };
      }

      // Above the Finance limit: the Super Admin decides.
      const [a] = await tx
        .insert(s.approvalRequest)
        .values({
          institutionId: c.institutionId,
          branchId: ec.branch.id,
          kind: 'discount',
          level: 'super_admin',
          title: `${label} ${formatINR(input.amount)} · ${ec.student.name}`,
          summary: `${ec.batch.code} · ${cum}% below the list price in total · ${input.reason}${sourceName ? ` · ${DISCOUNT_SOURCE_LABEL[input.kind] ?? 'From'}: ${sourceName}` : ''} · requested by ${c.userName}`,
          entityType: 'enrollment',
          entityId: enrollmentId,
          amount: input.amount,
          pct: cum,
          payload: { kind: input.kind, amount: input.amount, reason: input.reason, sourceName },
          requestedBy: c.userId,
        })
        .returning({ id: s.approvalRequest.id });
      await this.events.emit(tx, 'ApprovalRequested', { approvalId: a!.id, kind: 'discount', level: 'super_admin', branchId: ec.branch.id });
      await this.audit.log(tx, { action: 'Discount requested', kind: 'create', entityType: 'approval', entityId: a!.id, entityLabel: ec.student.name, summary: `${label} ${formatINR(input.amount)} · ${cum}% below list in total · ${input.reason} → Super Admin`, branchId: ec.branch.id });
      this.shared.invalidate(tx, ec.branch.id);
      return { status: 'approval_requested' as const, message: `Sent to the Super Admin: the total reduction would be ${cum}% of the list price, above your ${t.superAdminPct}% limit`, approvalId: a!.id };
    });
  }

  /** The Super Admin approved a request: apply it (clamped if payments made the open amount smaller meanwhile). */
  async applyApproved(tx: Tx, a: typeof s.approvalRequest.$inferSelect): Promise<void> {
    const p = a.payload as { kind?: DiscountKind; amount?: number; reason?: string; sourceName?: string | null };
    if (!p.kind || !p.amount) return;
    const [en] = await tx.select({ status: s.enrollment.status }).from(s.enrollment).where(eq(s.enrollment.id, a.entityId));
    if (!en) throw notFound('Fee account');
    if (en.status !== 'active') return; // the student left meanwhile: nothing to reduce
    await this.apply(tx, a.entityId, { kind: p.kind, amount: p.amount, reason: p.reason ?? 'Approved discount', sourceName: p.sourceName ?? null }, { userId: a.decidedBy ?? a.requestedBy, approvalId: a.id });
  }

  /**
   * Take `amount` off the unpaid instalments, proportionally. Shared by the direct path and the approved
   * request. Returns what was actually applied.
   */
  async apply(
    tx: Tx,
    enrollmentId: string,
    d: DiscountRequest,
    by: { userId: string | null; approvalId: string | null },
    origin: 'adjustment' | 'admission' | 'import' = 'adjustment',
  ): Promise<number> {
    const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
    const all = await this.shared.instalments(tx, enrollmentId, { lock: true });
    const insts = all.filter(isActive);
    const open = insts.map(principalOpen);
    const amount = Math.min(d.amount, sumPaise(open));
    if (amount <= 0) throw invalid('Nothing is left to discount — the fee is already fully paid');
    const list = await this.listTotal(tx, ec);
    const parts = splitProportionally(amount, open);
    for (let i = 0; i < insts.length; i++) {
      const part = parts[i]!;
      if (part <= 0) continue;
      const inst = insts[i]!;
      const waived = inst.waived + part;
      await tx.update(s.instalment).set({ waived, status: instalmentStatus({ ...inst, waived }) }).where(eq(s.instalment.id, inst.id));
    }
    const label = DISCOUNT_KIND_LABEL[d.kind];
    const feeAfter = ec.enrollment.feeTotal - amount;
    const pctAfter = cumulativeDiscountPct(list, feeAfter);
    await tx.insert(s.ledgerEntry).values({ enrollmentId, branchId: ec.branch.id, kind: 'discount', description: `Discount · ${label} · ${d.reason}`, credit: amount, createdBy: by.userId });
    await tx.update(s.enrollment).set({ feeTotal: feeAfter, discountPct: pctAfter }).where(eq(s.enrollment.id, enrollmentId));
    await tx.insert(s.feeDiscount).values({ enrollmentId, branchId: ec.branch.id, kind: d.kind, amount, pctAfter, reason: d.reason, sourceName: d.sourceName ?? null, origin, approvalId: by.approvalId, grantedBy: by.userId });
    await this.shared.recomputeClearance(tx, enrollmentId);
    await this.audit.log(tx, {
      action: 'Fee discount applied',
      kind: 'update',
      entityType: 'enrollment_fee',
      entityId: enrollmentId,
      entityLabel: `${ec.student.name} · ${ec.student.admissionNo ?? ''}`,
      summary: `${label} ${formatINR(amount)}${amount < d.amount ? ` (approved ${formatINR(d.amount)}; ${formatINR(d.amount - amount)} had been paid meanwhile)` : ''} · fee ${formatINR(ec.enrollment.feeTotal)} → ${formatINR(feeAfter)} · ${pctAfter}% below list · ${d.reason}${d.sourceName ? ` · ${DISCOUNT_SOURCE_LABEL[d.kind] ?? 'From'}: ${d.sourceName}` : ''}`,
      branchId: ec.branch.id,
    });
    this.shared.invalidate(tx, ec.branch.id, this.shared.portalUserIds(ec));
    return amount;
  }

  /* ───────────────────────── report ───────────────────────── */

  async report(q: { from?: ISODate; to?: ISODate; kind?: DiscountKind }) {
    const today = todayIST();
    const from = q.from ?? `${financialYear(today).slice(0, 4)}-04-01`;
    const to = q.to ?? today;
    const where = [
      sql`(${s.feeDiscount.grantedAt} at time zone 'Asia/Kolkata')::date between ${from} and ${to}`,
      ...(q.kind ? [eq(s.feeDiscount.kind, q.kind)] : []),
    ];
    const scope = inBranchScope(s.feeDiscount.branchId);
    if (scope) where.push(scope);
    const rows = await this.db.db
      .select({ d: s.feeDiscount, by: s.user.name, student: s.student.name, admissionNo: s.student.admissionNo, branchName: s.branch.name, batchCode: s.batch.code })
      .from(s.feeDiscount)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.feeDiscount.enrollmentId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.branch, eq(s.branch.id, s.feeDiscount.branchId))
      .leftJoin(s.user, eq(s.user.id, s.feeDiscount.grantedBy))
      .where(and(...where))
      .orderBy(desc(s.feeDiscount.grantedAt))
      .limit(300);
    const agg = await this.db.db
      .select({ kind: s.feeDiscount.kind, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${s.feeDiscount.amount}), 0)::bigint` })
      .from(s.feeDiscount)
      .where(and(...where))
      .groupBy(s.feeDiscount.kind);
    const byKind = (['referral', 'special', 'scholarship', 'other'] as const).map((kind) => {
      const a = agg.find((x) => x.kind === kind);
      return { kind, label: DISCOUNT_KIND_LABEL[kind], count: Number(a?.n ?? 0), amount: Number(a?.amount ?? 0) };
    });
    return {
      from,
      to,
      total: byKind.reduce((a, k) => a + k.amount, 0),
      count: byKind.reduce((a, k) => a + k.count, 0),
      byKind,
      rows: rows.map((r) => ({ ...this.row(r.d, r.by), enrollmentId: r.d.enrollmentId, studentName: r.student, admissionNo: r.admissionNo, branchName: r.branchName, batchCode: r.batchCode })),
    };
  }
}

void inArray;
