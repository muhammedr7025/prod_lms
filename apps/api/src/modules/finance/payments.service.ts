import { Injectable } from '@nestjs/common';
import type { PaymentResult } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, or, sql, type Tx } from '@exatech/db';
import { formatINR, referenceLabel, sumPaise, todayIST, toISTDate, validateDeskPayment, type ISODate, type TenderLine } from '@exatech/domain';
import crypto from 'node:crypto';
import { AuditService } from '../../core/audit/audit.service';
import { maybeCtx } from '../../core/context';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { instalmentStatus, METHOD_SHORT, openBalance, planAllocation, tenderSummary } from './ledger';

export interface RecordInput {
  enrollmentId: string;
  tenders: TenderLine[];
  channel: 'desk' | 'online' | 'reconciliation';
  receivedBy: string | null;
  cashSessionId?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  idempotencyKey: string;
  notes?: string | null;
  /** Override "today" (tests). */
  today?: ISODate;
}

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Bank transfer', online: 'Razorpay online' };

/**
 * The single source of truth for money movement. Every collection — desk,
 * online webhook or reconciliation — goes through `record()`: idempotent,
 * period-locked, allocated oldest-due-first (or by priority), ledgered,
 * receipted with a gap-free number, and followed by a clearance recompute.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly shared: FinanceShared,
    private readonly invoices: InvoicesService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async record(tx: Tx, input: RecordInput): Promise<PaymentResult> {
    const today = input.today ?? todayIST();
    // Serialise everything that touches this fee account (double-clicks, webhook retries).
    const [enr] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, input.enrollmentId)).for('update');
    if (!enr) throw notFound('Fee account');

    const replay = await this.findExisting(tx, input);
    if (replay) return this.result(tx, replay.id, true);

    const tenders = input.tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference?.trim() || null }));
    const total = sumPaise(tenders.map((t) => t.amount));
    if (total <= 0) throw invalid('Enter an amount to collect');
    const fin = await this.shared.settings(tx);
    const insts = await this.shared.instalments(tx, enr.id, { lock: true });
    const outstanding = sumPaise(insts.map(openBalance));

    if (input.channel === 'desk') {
      for (const t of tenders) {
        if (t.method === 'online') throw invalid('Razorpay online payments are recorded by the gateway webhook, not at the desk');
        if (!fin.methods[t.method]) throw invalid(`${METHOD_LABEL[t.method]} is switched off in Finance settings`);
      }
      const v = validateDeskPayment(tenders, outstanding, fin.minPartial);
      if (!v.ok) throw invalid(v.errors.join(' · '), Object.fromEntries(v.errors.map((e) => [/required for/.test(e) ? 'reference' : 'amount', e])));
    }
    await this.shared.assertOpenPeriod(tx, enr.branchId, today, { dayClose: input.channel !== 'online' });

    const plan = planAllocation(tenders, insts, fin.allocationOrder);
    const pendingTotal = plan.pendingTotal;
    const status = pendingTotal > 0 && fin.chequeUnlocksAfterClearance ? 'pending_clearance' : 'cleared';
    const chequePending = status === 'pending_clearance';
    const c = await this.shared.enrollmentCtx(tx, enr.id);

    // Invoices first so the ledger reads charge → payment.
    const invoiceByInst = new Map<string, { id: string; number: string }>();
    for (const a of plan.allocations) {
      if (invoiceByInst.has(a.instalmentId)) continue;
      const inv = await this.invoices.issueForInstalment(tx, a.instalmentId, { createdBy: input.receivedBy, today });
      invoiceByInst.set(a.instalmentId, { id: inv.id, number: inv.number });
    }

    const [pay] = await tx
      .insert(s.payment)
      .values({
        branchId: enr.branchId,
        enrollmentId: enr.id,
        studentId: enr.studentId,
        total,
        status,
        channel: input.channel,
        gatewayOrderId: input.gatewayOrderId ?? null,
        gatewayPaymentId: input.gatewayPaymentId ?? null,
        cashSessionId: input.cashSessionId ?? null,
        receivedBy: input.receivedBy,
        idempotencyKey: input.idempotencyKey,
        excessCredit: plan.excess,
        notes: input.notes ?? null,
      })
      .returning();
    const paymentId = pay!.id;
    await tx.insert(s.paymentTender).values(tenders.map((t) => ({ paymentId, method: t.method, amount: t.amount, reference: t.reference, chequeStatus: t.method === 'cheque' ? ('pending' as const) : null })));

    // Allocations: cheque money is pending (never unlocks content) unless settings say otherwise.
    const allocs = plan.allocations.map((a) => ({ ...a, pending: a.pending && chequePending }));
    if (allocs.length) {
      await tx.insert(s.paymentAllocation).values(allocs.map((a) => ({ paymentId, instalmentId: a.instalmentId, invoiceId: invoiceByInst.get(a.instalmentId)?.id ?? null, amount: a.amount, pending: a.pending })));
    }
    for (const inst of insts) {
      const mine = allocs.filter((a) => a.instalmentId === inst.id);
      if (mine.length === 0) continue;
      const paid = inst.paid + sumPaise(mine.filter((a) => !a.pending).map((a) => a.amount));
      const pendingPaid = inst.pendingPaid + sumPaise(mine.filter((a) => a.pending).map((a) => a.amount));
      await tx.update(s.instalment).set({ paid, pendingPaid, status: instalmentStatus({ ...inst, paid, pendingPaid }) }).where(eq(s.instalment.id, inst.id));
    }
    for (const inv of invoiceByInst.values()) await this.invoices.recompute(tx, inv.id);

    // Receipt (gap-free per branch per FY) + ledger.
    const r = await this.shared.nextNumber(tx, enr.branchId, 'receipt', today);
    const [rec] = await tx
      .insert(s.receipt)
      .values({ branchId: enr.branchId, paymentId, number: r.number, fy: r.fy, seq: r.seq, verifyToken: crypto.randomBytes(18).toString('base64url') })
      .returning();
    const methodsLabel = [...new Set(tenders.map((t) => (t.method === 'online' ? 'Razorpay' : METHOD_SHORT[t.method] ?? t.method)))].join(' + ');
    const applied = total - plan.excess;
    if (applied > 0) {
      await tx.insert(s.ledgerEntry).values({
        enrollmentId: enr.id,
        branchId: enr.branchId,
        kind: 'payment',
        description: `Payment · ${methodsLabel}${chequePending ? ' · pending clearance' : ''}`,
        reference: r.number,
        credit: applied,
        paymentId,
        createdBy: input.receivedBy,
      });
    }
    if (plan.excess > 0) {
      await tx.update(s.enrollment).set({ creditBalance: sql`${s.enrollment.creditBalance} + ${plan.excess}` }).where(eq(s.enrollment.id, enr.id));
      await tx.insert(s.ledgerEntry).values({
        enrollmentId: enr.id,
        branchId: enr.branchId,
        kind: 'credit',
        description: `Advance held as credit · ${methodsLabel}`,
        reference: r.number,
        credit: plan.excess,
        paymentId,
        createdBy: input.receivedBy,
      });
    }

    const clr = await this.shared.recomputeClearance(tx, enr.id, today);
    await this.events.emit(tx, 'PaymentRecorded', { paymentId, enrollmentId: enr.id, studentId: enr.studentId, branchId: enr.branchId, amount: total, status, channel: input.channel, receiptId: rec!.id });
    await this.events.emit(tx, 'ReceiptIssued', { receiptId: rec!.id, paymentId, enrollmentId: enr.id, number: r.number });
    const allocText = this.allocText(insts, allocs, plan.excess);
    await this.audit.log(tx, {
      action: 'Payment recorded',
      kind: 'payment',
      entityType: 'payment',
      entityId: paymentId,
      entityLabel: `${c.student.name} · ${r.number}`,
      after: { total, status, channel: input.channel, tenders: tenders.map((t) => ({ method: t.method, amount: t.amount })), receipt: r.number },
      summary: `${tenderSummary(tenders)} → ${allocText}${clr.changed ? ` · fee clearance ${clr.cleared ? 'unlocked' : 'locked'}` : ''}`,
      branchId: enr.branchId,
    });
    this.shared.invalidate(tx, enr.branchId, this.shared.portalUserIds(c));
    return this.result(tx, paymentId, false);
  }

  private allocText(insts: { id: string; label: string }[], allocs: { instalmentId: string; amount: number; pending: boolean }[], excess: number): string {
    const parts = allocs.map((a) => `${insts.find((i) => i.id === a.instalmentId)?.label ?? 'Instalment'} ${formatINR(a.amount)}${a.pending ? ' (pending)' : ''}`);
    if (excess > 0) parts.push(`credit ${formatINR(excess)}`);
    return parts.join(', ') || 'credit';
  }

  private async findExisting(tx: Tx, input: Pick<RecordInput, 'idempotencyKey' | 'gatewayPaymentId'>) {
    const conds = [eq(s.payment.idempotencyKey, input.idempotencyKey)];
    if (input.gatewayPaymentId) conds.push(eq(s.payment.gatewayPaymentId, input.gatewayPaymentId));
    const [p] = await tx.select({ id: s.payment.id }).from(s.payment).where(or(...conds)).limit(1);
    return p ?? null;
  }

  /** Display-ready result for a payment (also used for replays). */
  async result(tx: Tx, paymentId: string, replay: boolean): Promise<PaymentResult> {
    const [p] = await tx.select().from(s.payment).where(eq(s.payment.id, paymentId));
    if (!p) throw notFound('Payment');
    const [rec] = await tx.select().from(s.receipt).where(eq(s.receipt.paymentId, paymentId));
    const tenders = await tx.select().from(s.paymentTender).where(eq(s.paymentTender.paymentId, paymentId));
    const allocs = await tx
      .select({ amount: s.paymentAllocation.amount, pending: s.paymentAllocation.pending, label: s.instalment.label })
      .from(s.paymentAllocation)
      .innerJoin(s.instalment, eq(s.instalment.id, s.paymentAllocation.instalmentId))
      .where(eq(s.paymentAllocation.paymentId, paymentId))
      .orderBy(asc(s.instalment.dueDate));
    const insts = await this.shared.instalments(tx, p.enrollmentId);
    const [enr] = await tx.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, p.enrollmentId));
    const parts = allocs.map((a) => `${/^\d/.test(a.label) ? `Instalment ${a.label.split(' · ')[0]}` : a.label} · ${formatINR(a.amount)}${a.pending ? ' (pending clearance)' : ''}`);
    if (p.excessCredit > 0) parts.push(`credit ${formatINR(p.excessCredit)}`);
    return {
      paymentId: p.id,
      receiptId: rec!.id,
      receiptNumber: rec!.number,
      replay,
      total: p.total,
      status: p.status,
      tenders: tenders.map((t) => ({ method: t.method, label: METHOD_LABEL[t.method] ?? t.method, amount: t.amount, reference: t.reference })),
      tenderSummary: tenderSummary(tenders),
      allocatedTo: parts.join(', ') || '—',
      excessCredit: p.excessCredit,
      balanceAfter: sumPaise(insts.map(openBalance)),
      feeCleared: enr?.feeCleared ?? false,
      enrollmentId: p.enrollmentId,
    };
  }

  /** Is the payment dated inside a locked month or a closed day? */
  async voidLockReason(tx: Tx, paymentId: string): Promise<string | null> {
    const [p] = await tx.select({ branchId: s.payment.branchId, receivedAt: s.payment.receivedAt }).from(s.payment).where(eq(s.payment.id, paymentId));
    if (!p) throw notFound('Payment');
    return this.shared.lockReason(tx, p.branchId, toISTDate(p.receivedAt), { dayClose: true });
  }

  /**
   * Void: allocations reversed, ledger reversal, instalments / invoices /
   * clearance recomputed, receipt marked voided. Never deletes.
   */
  async voidPayment(tx: Tx, paymentId: string, reason: string, opts: { bypassLock?: boolean } = {}): Promise<{ receiptNumber: string }> {
    const [p] = await tx.select().from(s.payment).where(eq(s.payment.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    if (p.status === 'voided') throw conflict('This payment is already voided');
    if (!opts.bypassLock) {
      const lock = await this.voidLockReason(tx, paymentId);
      if (lock) throw invalid(lock);
    }
    await tx.select({ id: s.enrollment.id }).from(s.enrollment).where(eq(s.enrollment.id, p.enrollmentId)).for('update');
    const [rec] = await tx.select().from(s.receipt).where(eq(s.receipt.paymentId, p.id));
    const allocs = await tx.select().from(s.paymentAllocation).where(and(eq(s.paymentAllocation.paymentId, p.id), eq(s.paymentAllocation.reversed, false)));
    if (allocs.length) {
      await tx.update(s.paymentAllocation).set({ reversed: true }).where(inArray(s.paymentAllocation.id, allocs.map((a) => a.id)));
      const instIds = [...new Set(allocs.map((a) => a.instalmentId))];
      const insts = await tx.select().from(s.instalment).where(inArray(s.instalment.id, instIds)).for('update');
      for (const inst of insts) {
        const mine = allocs.filter((a) => a.instalmentId === inst.id);
        const paid = Math.max(0, inst.paid - sumPaise(mine.filter((a) => !a.pending).map((a) => a.amount)));
        const pendingPaid = Math.max(0, inst.pendingPaid - sumPaise(mine.filter((a) => a.pending).map((a) => a.amount)));
        await tx.update(s.instalment).set({ paid, pendingPaid, status: instalmentStatus({ ...inst, paid, pendingPaid }) }).where(eq(s.instalment.id, inst.id));
      }
      for (const invId of [...new Set(allocs.map((a) => a.invoiceId).filter((x): x is string => !!x))]) await this.invoices.recompute(tx, invId);
    }
    if (p.excessCredit > 0) await tx.update(s.enrollment).set({ creditBalance: sql`greatest(0, ${s.enrollment.creditBalance} - ${p.excessCredit})` }).where(eq(s.enrollment.id, p.enrollmentId));
    const c = maybeCtx();
    const now = new Date();
    await tx.update(s.payment).set({ status: 'voided', voidReason: reason, voidedBy: c?.userId ?? null, voidedAt: now }).where(eq(s.payment.id, p.id));
    if (rec) await tx.update(s.receipt).set({ voided: true, voidedAt: now }).where(eq(s.receipt.id, rec.id));
    await tx.insert(s.ledgerEntry).values({
      enrollmentId: p.enrollmentId,
      branchId: p.branchId,
      kind: 'reversal',
      description: `Reversal · receipt ${rec?.number ?? ''} voided · ${reason}`,
      reference: rec?.number ?? null,
      debit: p.total,
      paymentId: p.id,
      createdBy: c?.userId ?? null,
    });
    await this.shared.recomputeClearance(tx, p.enrollmentId);
    await this.events.emit(tx, 'PaymentVoided', { paymentId: p.id, enrollmentId: p.enrollmentId, branchId: p.branchId, reason });
    const ec = await this.shared.enrollmentCtx(tx, p.enrollmentId);
    await this.audit.log(tx, {
      action: 'Payment voided',
      kind: 'update',
      entityType: 'payment',
      entityId: p.id,
      entityLabel: `${ec.student.name} · ${rec?.number ?? ''}`,
      before: { status: p.status },
      after: { status: 'voided', reason },
      summary: `${rec?.number ?? 'payment'} ${formatINR(p.total)} → voided · reason: ${reason}`,
      branchId: p.branchId,
    });
    this.shared.invalidate(tx, p.branchId, this.shared.portalUserIds(ec));
    return { receiptNumber: rec?.number ?? '' };
  }

  /** Cheque cleared → pending money becomes paid (may unlock content); bounced → allocations reversed. */
  async chequeOutcome(tx: Tx, paymentId: string, outcome: 'cleared' | 'bounced', note?: string): Promise<void> {
    const [p] = await tx.select().from(s.payment).where(eq(s.payment.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    const cheques = await tx.select().from(s.paymentTender).where(and(eq(s.paymentTender.paymentId, p.id), eq(s.paymentTender.method, 'cheque'), eq(s.paymentTender.chequeStatus, 'pending')));
    if (cheques.length === 0) throw conflict('There is no cheque awaiting clearance on this payment');
    const chequeTotal = sumPaise(cheques.map((t) => t.amount));
    const now = new Date();
    await tx.update(s.paymentTender).set({ chequeStatus: outcome, clearedAt: outcome === 'cleared' ? now : null }).where(inArray(s.paymentTender.id, cheques.map((t) => t.id)));
    const pendingAllocs = await tx.select().from(s.paymentAllocation).where(and(eq(s.paymentAllocation.paymentId, p.id), eq(s.paymentAllocation.pending, true), eq(s.paymentAllocation.reversed, false)));
    const insts = pendingAllocs.length ? await tx.select().from(s.instalment).where(inArray(s.instalment.id, [...new Set(pendingAllocs.map((a) => a.instalmentId))])).for('update') : [];
    for (const inst of insts) {
      const amt = sumPaise(pendingAllocs.filter((a) => a.instalmentId === inst.id).map((a) => a.amount));
      const pendingPaid = Math.max(0, inst.pendingPaid - amt);
      const paid = outcome === 'cleared' ? inst.paid + amt : inst.paid;
      await tx.update(s.instalment).set({ paid, pendingPaid, status: instalmentStatus({ ...inst, paid, pendingPaid }) }).where(eq(s.instalment.id, inst.id));
    }
    if (pendingAllocs.length) {
      await tx
        .update(s.paymentAllocation)
        .set(outcome === 'cleared' ? { pending: false } : { reversed: true })
        .where(inArray(s.paymentAllocation.id, pendingAllocs.map((a) => a.id)));
      for (const invId of [...new Set(pendingAllocs.map((a) => a.invoiceId).filter((x): x is string => !!x))]) await this.invoices.recompute(tx, invId);
    }
    const [rec] = await tx.select().from(s.receipt).where(eq(s.receipt.paymentId, p.id));
    const allCheque = chequeTotal === p.total;
    if (outcome === 'cleared') {
      await tx.update(s.payment).set({ status: 'cleared' }).where(eq(s.payment.id, p.id));
      await this.events.emit(tx, 'PaymentCleared', { paymentId: p.id, enrollmentId: p.enrollmentId, branchId: p.branchId });
    } else {
      await tx.update(s.payment).set({ status: allCheque ? 'bounced' : 'cleared', voidReason: note ?? 'Cheque bounced' }).where(eq(s.payment.id, p.id));
      await tx.insert(s.ledgerEntry).values({
        enrollmentId: p.enrollmentId,
        branchId: p.branchId,
        kind: 'reversal',
        description: `Reversal · cheque bounced${note ? ` · ${note}` : ''}`,
        reference: rec?.number ?? null,
        debit: chequeTotal,
        paymentId: p.id,
        createdBy: maybeCtx()?.userId ?? null,
      });
    }
    await this.shared.recomputeClearance(tx, p.enrollmentId);
    const ec = await this.shared.enrollmentCtx(tx, p.enrollmentId);
    await this.audit.log(tx, {
      action: outcome === 'cleared' ? 'Cheque cleared' : 'Cheque bounced',
      kind: 'payment',
      entityType: 'payment',
      entityId: p.id,
      entityLabel: `${ec.student.name} · ${rec?.number ?? ''}`,
      before: { chequeStatus: 'pending' },
      after: { chequeStatus: outcome },
      summary: `${rec?.number ?? ''} · cheque ${formatINR(chequeTotal)} → ${outcome}${note ? ` · ${note}` : ''}`,
      branchId: p.branchId,
    });
    this.shared.invalidate(tx, p.branchId, this.shared.portalUserIds(ec));
  }

  /** Reference hint per method (desk placeholder). */
  static referenceHint(method: TenderLine['method']): string | null {
    return method === 'cash' || method === 'online' ? null : referenceLabel(method);
  }
}
