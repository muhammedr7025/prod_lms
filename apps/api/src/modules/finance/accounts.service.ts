import { Injectable } from '@nestjs/common';
import type { FeeAccount } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL, type Tx } from '@exatech/db';
import { addDays, daysBetween, formatDayMonth, formatINR, referenceLabel, sumPaise, todayIST, toISTDate, type ISODate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FinanceShared, type InstalmentRowDb } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { instalmentState, instalmentStatus, isActive, lateFeeDue, openBalance, principalOpen, suggestedInstalment } from './ledger';

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Bank transfer' };

export interface RestructureRow {
  label: string;
  dueDate: ISODate;
  amount: number;
}

/** Fee accounts: the full ledger per enrollment, clearance, schedule, follow-up and the controls on it. */
@Injectable()
export class AccountsService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly invoices: InvoicesService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async account(enrollmentId: string, opts: { scope?: boolean } = {}): Promise<FeeAccount> {
    const db = this.db.db;
    const c = await this.shared.enrollmentCtx(db, enrollmentId);
    if (opts.scope !== false) assertInScope(c.branch.id);
    const fin = await this.shared.settings();
    const today = todayIST();
    const all = await this.shared.instalments(db, enrollmentId, { includeCancelled: true });
    const insts = all.filter(isActive);
    const invs = all.length
      ? await db
          .select({ id: s.invoice.id, number: s.invoice.number, instalmentId: s.invoice.instalmentId })
          .from(s.invoice)
          .where(and(inArray(s.invoice.instalmentId, all.map((i) => i.id)), ne(s.invoice.status, 'cancelled')))
      : [];
    const suggested = suggestedInstalment(insts);
    const instRows = insts.map((i) => {
      const st = instalmentState(i, today);
      const inv = invs.find((v) => v.instalmentId === i.id);
      const isSuggested = suggested?.id === i.id;
      return {
        id: i.id,
        seq: i.seq,
        label: i.label,
        dueDate: i.dueDate,
        amount: i.amount,
        paid: i.paid,
        pendingPaid: i.pendingPaid,
        waived: i.waived,
        lateFee: i.lateFee,
        balance: openBalance(i),
        state: st.state,
        statusLabel: isSuggested ? `${st.label} · suggested` : st.label,
        tag: st.tag,
        suggested: isSuggested,
        revision: i.revision,
        invoiceId: inv?.id ?? null,
        invoiceNumber: inv?.number ?? null,
      };
    });
    const paid = sumPaise(insts.map((i) => i.paid));
    const pending = sumPaise(insts.map((i) => i.pendingPaid));
    const outstanding = sumPaise(insts.map(openBalance));
    const overdueInsts = insts.filter((i) => i.dueDate < today && openBalance(i) > 0);
    const lateFee = sumPaise(insts.map((i) => lateFeeDue(i, today, fin.lateFee)));
    const overdue = sumPaise(overdueInsts.map(principalOpen)) + lateFee;
    const chain = await this.shared.chainIds(db, enrollmentId);

    // Ledger (append-only) with running balance.
    const ledger = await db.select().from(s.ledgerEntry).where(inArray(s.ledgerEntry.enrollmentId, chain)).orderBy(asc(s.ledgerEntry.at), asc(s.ledgerEntry.id));
    let bal = 0;
    const ledgerRows = ledger.map((l) => {
      bal += l.debit - l.credit;
      return { id: l.id, at: l.at.toISOString(), date: toISTDate(l.at), kind: l.kind, entry: l.description, reference: l.reference, debit: l.debit, credit: l.credit, balance: bal, emphasis: ['reversal', 'credit_note', 'refund', 'waiver', 'adjustment', 'late_fee'].includes(l.kind) };
    });

    // Follow-up log.
    const acts = await db
      .select({ a: s.duesActivity, by: s.user.name })
      .from(s.duesActivity)
      .leftJoin(s.user, eq(s.user.id, s.duesActivity.createdBy))
      .where(inArray(s.duesActivity.enrollmentId, chain))
      .orderBy(desc(s.duesActivity.createdAt))
      .limit(30);
    const followUps = acts.slice(0, 8).map(({ a, by }) => ({
      id: a.id,
      kind: a.kind,
      label: activityLabel(a),
      date: toISTDate(a.createdAt),
      promiseDate: a.promiseDate,
      by,
    }));
    const promise = acts.find((x) => x.a.promiseDate && x.a.promiseDate >= today)?.a.promiseDate ?? null;
    const remindedToday = acts.some((x) => x.a.kind === 'reminder' && toISTDate(x.a.createdAt) === today);

    const payments = await db.select({ id: s.payment.id, receivedAt: s.payment.receivedAt, status: s.payment.status }).from(s.payment).where(eq(s.payment.enrollmentId, enrollmentId)).orderBy(desc(s.payment.receivedAt));
    const live = payments.filter((p) => p.status !== 'voided' && p.status !== 'failed');
    const approvals = await db
      .select({ id: s.approvalRequest.id, kind: s.approvalRequest.kind, title: s.approvalRequest.title })
      .from(s.approvalRequest)
      .where(and(eq(s.approvalRequest.status, 'pending'), inArray(s.approvalRequest.entityId, [enrollmentId, ...payments.map((p) => p.id)])));

    const revision = all.reduce((m, i) => Math.max(m, i.revision), all.length ? 1 : 0);
    const e = c.enrollment;
    const pcts = insts.map((i) => (e.feeTotal > 0 ? Math.round((i.amount / e.feeTotal) * 100) : 0));
    const planLabel = insts.length === 0 ? 'No fee schedule yet' : insts.length === 1 ? 'One-time · incl. GST' : `${insts.length} instalments · ${pcts.join('/')} · incl. GST${revision > 1 ? ` · revision ${revision}` : ''}`;

    // Clearance tag.
    const exempt = !!e.exemptUntil && e.exemptUntil >= today;
    const dueSoFar = insts.filter((i) => i.dueDate <= today);
    const firstUnpaidDue = dueSoFar.find((i) => i.paid < i.amount - i.waived);
    let tag: string;
    if (e.feeCleared) {
      if (exempt && firstUnpaidDue) tag = `Fee cleared · exemption until ${formatDayMonth(e.exemptUntil!)}`;
      else if (insts.length && outstanding === 0 && pending === 0) tag = 'Fee cleared · fully paid';
      else if (dueSoFar.length === 0) tag = 'Fee cleared · nothing due yet';
      else tag = `Fee cleared · instalment ${dueSoFar[dueSoFar.length - 1]!.seq}`;
    } else if (firstUnpaidDue) {
      tag = `Locked · instalment ${firstUnpaidDue.seq} ${firstUnpaidDue.dueDate === today ? 'due today' : 'overdue'}`;
    } else tag = `Locked · ${e.clearanceReason ?? 'policy not met'}`;

    // Foot line.
    const foot: string[] = [`Credit balance ${formatINR(e.creditBalance)}`];
    if (lateFee > 0) foot.push(`late fee ${formatINR(lateFee)} on the unpaid balance (${formatINR(fin.lateFee.perDay)}/day, capped at ${fin.lateFee.capPct}%)`);
    else if (suggested) {
      const starts = addDays(suggested.dueDate, fin.lateFee.graceDays);
      foot.push(starts >= today ? `no late fee yet (applies after ${formatDayMonth(starts)} on unpaid balance only)` : 'no late fee');
    }
    if (pending > 0) foot.push(`${formatINR(pending)} cheque pending clearance`);
    if (promise) foot.push(`promise-to-pay ${formatDayMonth(promise)}`);
    if (!e.feeCleared) foot.push('notes locked');
    else if (exempt) foot.push(`exemption until ${formatDayMonth(e.exemptUntil!)}`);

    const last = live[0];
    return {
      enrollmentId: e.id,
      studentId: c.student.id,
      studentName: c.student.name,
      admissionNo: c.student.admissionNo,
      branchId: c.branch.id,
      branchName: c.branch.name,
      batchCode: c.batch.code,
      courseName: c.course.name,
      batchLabel: `${c.batch.code} · ${c.course.name}`,
      guardianLine: this.shared.guardianLine(c),
      enrollmentStatus: e.status,
      planLabel,
      feeTotal: e.feeTotal,
      paid,
      paidNote: live.length ? `${live.length} receipt${live.length === 1 ? '' : 's'} · last ${formatDayMonth(toISTDate(last!.receivedAt))}` : 'No payments yet',
      pendingClearance: pending,
      outstanding,
      overdue,
      overdueNote: overdue > 0 ? `since ${formatDayMonth(overdueInsts[0]?.dueDate ?? today)}${lateFee > 0 ? ` · incl. late fee ${formatINR(lateFee)}` : ' · no late fee yet'}` : 'Nothing overdue',
      lateFeeDue: lateFee,
      creditBalance: e.creditBalance,
      clearance: {
        cleared: e.feeCleared,
        label: e.feeCleared ? 'Unlocked' : 'Locked',
        reason: (e.clearanceReason ?? (e.feeCleared ? 'All instalments due so far are paid' : 'Not cleared')).replace(/\d{4}-\d{2}-\d{2}/g, (d) => formatDayMonth(d)),
        tag,
        tagVariant: e.feeCleared ? 'accent' : 'ink',
        exemptUntil: e.exemptUntil,
        exemptReason: e.exemptReason,
      },
      hasSchedule: insts.length > 0,
      revision: Math.max(revision, 1),
      instalments: instRows,
      suggestedAmount: suggested ? openBalance(suggested) : 0,
      minPartial: outstanding > 0 ? Math.min(fin.minPartial, outstanding) : fin.minPartial,
      foot: foot.join(' · '),
      ledger: ledgerRows,
      followUps,
      promiseDate: promise,
      remindedToday,
      pendingApprovals: approvals,
      restructureApprovalAbove: fin.restructureApprovalAbove,
      methods: (['upi', 'cash', 'card', 'cheque', 'transfer'] as const).filter((m) => fin.methods[m]).map((m) => ({ method: m, label: METHOD_LABEL[m]!, referenceLabel: m === 'cash' ? null : referenceLabel(m) })),
      allocationOrder: fin.allocationOrder,
      upiVpa: fin.upiVpa,
    };
  }

  async list(q: { q?: string; filter: 'all' | 'overdue' | 'locked' | 'no_schedule'; limit: number }) {
    const today = todayIST();
    const agg = this.db.db
      .select({
        enrollmentId: s.instalment.enrollmentId,
        paid: sql<number>`sum(paid)::bigint`.as('agg_paid'),
        open: sql<number>`sum(greatest(0, amount + late_fee - waived - paid - pending_paid))::bigint`.as('agg_open'),
        overdue: sql<number>`sum(case when due_date < ${today} then greatest(0, amount + late_fee - waived - paid - pending_paid) else 0 end)::bigint`.as('agg_overdue'),
        n: sql<number>`count(*)::int`.as('agg_n'),
      })
      .from(s.instalment)
      .where(ne(s.instalment.status, 'cancelled'))
      .groupBy(s.instalment.enrollmentId)
      .as('agg');
    const where: (SQL | undefined)[] = [inArray(s.enrollment.status, ['active', 'on_hold']), inBranchScope(s.enrollment.branchId)];
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, '')}%`;
      const digits = q.q.replace(/\D/g, '');
      where.push(or(ilike(s.student.name, like), ilike(s.student.admissionNo, like), digits.length >= 4 ? ilike(s.student.phone, `%${digits}%`) : undefined));
    }
    if (q.filter === 'overdue') where.push(sql`coalesce(${agg.overdue}, 0) > 0`);
    if (q.filter === 'locked') where.push(eq(s.enrollment.feeCleared, false));
    if (q.filter === 'no_schedule') where.push(isNull(agg.enrollmentId));
    const rows = await this.db.db
      .select({
        enrollmentId: s.enrollment.id,
        studentId: s.student.id,
        studentName: s.student.name,
        admissionNo: s.student.admissionNo,
        batchCode: s.batch.code,
        branchName: s.branch.name,
        feeTotal: s.enrollment.feeTotal,
        feeCleared: s.enrollment.feeCleared,
        paid: agg.paid,
        open: agg.open,
        overdue: agg.overdue,
        n: agg.n,
      })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.branch, eq(s.branch.id, s.enrollment.branchId))
      .leftJoin(agg, eq(agg.enrollmentId, s.enrollment.id))
      .where(and(...where))
      .orderBy(sql`coalesce(${agg.overdue}, 0) desc`, asc(s.student.name))
      .limit(q.limit + 1);
    const [{ total } = { total: 0 }] = await this.db.db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .leftJoin(agg, eq(agg.enrollmentId, s.enrollment.id))
      .where(and(...where));
    return {
      items: rows.slice(0, q.limit).map((r) => ({
        enrollmentId: r.enrollmentId,
        studentId: r.studentId,
        studentName: r.studentName,
        admissionNo: r.admissionNo,
        batchCode: r.batchCode,
        branchName: r.branchName,
        feeTotal: r.feeTotal,
        paid: Number(r.paid ?? 0),
        outstanding: Number(r.open ?? 0),
        overdue: Number(r.overdue ?? 0),
        feeCleared: r.feeCleared,
        hasSchedule: Number(r.n ?? 0) > 0,
      })),
      total: Number(total),
    };
  }

  /* ───────────────────────── Exemption ───────────────────────── */

  async grantExemption(enrollmentId: string, until: ISODate, reason: string): Promise<void> {
    const today = todayIST();
    if (until < today) throw invalid('Pick a date from today onwards', { until: 'From today onwards' });
    if (daysBetween(today, until) > 180) throw invalid('Exemptions are temporary — at most 180 days', { until: 'At most 180 days' });
    await this.db.tx(async (tx) => {
      const c = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(c.branch.id);
      await tx.select({ id: s.enrollment.id }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId)).for('update');
      await this.applyExemption(tx, enrollmentId, until, reason);
    });
  }

  async applyExemption(tx: Tx, enrollmentId: string, until: ISODate, reason: string): Promise<void> {
    const c = await this.shared.enrollmentCtx(tx, enrollmentId);
    const before = { exemptUntil: c.enrollment.exemptUntil, feeCleared: c.enrollment.feeCleared };
    await tx.update(s.enrollment).set({ exemptUntil: until, exemptReason: reason }).where(eq(s.enrollment.id, enrollmentId));
    await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'exemption', note: `Until ${formatDayMonth(until)} · ${reason}`, createdBy: ctx().userId });
    const clr = await this.shared.recomputeClearance(tx, enrollmentId);
    await this.audit.log(tx, {
      action: 'Clearance exemption granted',
      kind: 'update',
      entityType: 'enrollment_fee',
      entityId: enrollmentId,
      entityLabel: `${c.student.name} · ${c.student.admissionNo ?? ''}`,
      before,
      after: { exemptUntil: until, feeCleared: clr.cleared },
      summary: `Exempt until ${until} · ${reason}${clr.changed ? ` · notes ${clr.cleared ? 'unlocked' : 'locked'}` : ''}`,
      branchId: c.branch.id,
    });
    this.shared.invalidate(tx, c.branch.id, this.shared.portalUserIds(c));
  }

  /* ───────────────────────── Restructure ───────────────────────── */

  /** What the new rows must add up to (outstanding principal), or null for a first-time schedule. */
  restructureTarget(insts: InstalmentRowDb[]): number | null {
    const active = insts.filter(isActive);
    if (active.length === 0) return null;
    return sumPaise(active.map(principalOpen));
  }

  async restructure(enrollmentId: string, rows: RestructureRow[], reason: string): Promise<{ status: 'applied' | 'approval_requested'; message: string }> {
    const today = todayIST();
    if (rows.some((r) => r.dueDate < today)) throw invalid('New instalments must be due today or later', { rows: 'Due dates from today' });
    if (rows.some((r) => r.amount % 100 !== 0)) throw invalid('Use whole rupees for instalment amounts');
    const c = ctx();
    return this.db.tx(async (tx) => {
      const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(ec.branch.id);
      await tx.select({ id: s.enrollment.id }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId)).for('update');
      const insts = await this.shared.instalments(tx, enrollmentId, { lock: true });
      const target = this.restructureTarget(insts);
      const sum = sumPaise(rows.map((r) => r.amount));
      if (target !== null && sum !== target) throw invalid(`New rows add up to ${formatINR(sum)} — they must equal the outstanding balance of ${formatINR(target)}`, { rows: 'Must equal the outstanding balance' });
      if (target === 0) throw invalid('Nothing is outstanding — there is no balance to restructure');
      const fin = await this.shared.settings(tx);
      const amount = target ?? sum;
      if (amount > fin.restructureApprovalAbove) {
        const [dup] = await tx
          .select({ id: s.approvalRequest.id })
          .from(s.approvalRequest)
          .where(and(eq(s.approvalRequest.entityId, enrollmentId), eq(s.approvalRequest.kind, 'restructure'), eq(s.approvalRequest.status, 'pending')));
        if (dup) throw conflict('A restructure for this account is already waiting for approval');
        const [a] = await tx
          .insert(s.approvalRequest)
          .values({
            institutionId: c.institutionId,
            branchId: ec.branch.id,
            kind: 'restructure',
            level: 'finance',
            title: `${target === null ? 'Fee schedule' : 'Restructure'} ${formatINR(amount)} · ${ec.student.name}`,
            summary: `${rows.length} instalment${rows.length === 1 ? '' : 's'}: ${rows.map((r) => `${formatINR(r.amount)} on ${formatDayMonth(r.dueDate)}`).join(', ')} · ${reason}`,
            entityType: 'enrollment',
            entityId: enrollmentId,
            amount,
            payload: { rows, reason },
            requestedBy: c.userId,
          })
          .returning({ id: s.approvalRequest.id });
        await this.events.emit(tx, 'ApprovalRequested', { approvalId: a!.id, kind: 'restructure', level: 'finance', branchId: ec.branch.id });
        await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'restructure', note: `Requested · ${formatINR(amount)} into ${rows.length} · awaiting approval`, createdBy: c.userId });
        await this.audit.log(tx, {
          action: 'Restructure requested',
          kind: 'create',
          entityType: 'approval',
          entityId: a!.id,
          entityLabel: ec.student.name,
          summary: `${formatINR(amount)} into ${rows.length} instalments · above ${formatINR(fin.restructureApprovalAbove)} → maker-checker · ${reason}`,
          branchId: ec.branch.id,
        });
        this.shared.invalidate(tx, ec.branch.id);
        return { status: 'approval_requested' as const, message: `Above ${formatINR(fin.restructureApprovalAbove)} — sent to another Finance Manager for approval (maker-checker)` };
      }
      await this.applyRestructure(tx, enrollmentId, rows, reason, { requestedBy: c.userId, approvedBy: null });
      return { status: 'applied' as const, message: target === null ? 'Fee schedule set up' : 'Balance restructured · original schedule kept in history' };
    });
  }

  async applyRestructure(tx: Tx, enrollmentId: string, rows: RestructureRow[], reason: string, by: { requestedBy: string | null; approvedBy: string | null }): Promise<void> {
    const today = todayIST();
    const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
    const all = await this.shared.instalments(tx, enrollmentId, { lock: true, includeCancelled: true });
    const active = all.filter(isActive);
    const target = this.restructureTarget(active);
    const sum = sumPaise(rows.map((r) => r.amount));
    if (target !== null && sum !== target) throw invalid(`The balance changed since this restructure was requested (now ${formatINR(target)}) — raise it again`);
    const current = all.reduce((m, i) => Math.max(m, i.revision), 1);
    const next = active.length ? current + 1 : 1;
    if (active.length) {
      await tx.insert(s.scheduleRevision).values({
        enrollmentId,
        revision: current,
        rows: all.map((i) => ({ seq: i.seq, label: i.label, dueDate: i.dueDate, amount: i.amount, paid: i.paid })),
        reason,
        requestedBy: by.requestedBy,
        approvedBy: by.approvedBy,
      });
    }
    // Shrink each open instalment to what has been paid; credit-note the unpaid part of its invoice.
    for (const inst of active) {
      const moved = principalOpen(inst);
      if (moved <= 0) continue;
      const newAmount = inst.amount - moved;
      const shrunk = { ...inst, amount: newAmount };
      await tx
        .update(s.instalment)
        .set({ amount: newAmount, status: newAmount <= 0 && inst.lateFee <= inst.paid ? 'cancelled' : instalmentStatus(shrunk) })
        .where(eq(s.instalment.id, inst.id));
      const inv = await this.invoices.activeInvoiceFor(tx, inst.id);
      if (inv) {
        const credit = Math.min(moved, inv.total - inv.paid);
        if (credit > 0) {
          const cn = await this.invoices.creditNote(tx, { branchId: inv.branchId, enrollmentId, invoiceId: inv.id, amount: credit, reason: `Restructured · ${reason}` });
          const fullyUnpaid = inv.paid === 0;
          await tx
            .update(s.invoice)
            .set(fullyUnpaid ? { status: 'cancelled', cancelledAt: new Date(), cancelReason: `Restructured · ${reason}`, creditNoteId: cn.id } : { status: 'paid', creditNoteId: cn.id })
            .where(eq(s.invoice.id, inv.id));
          await tx.insert(s.ledgerEntry).values({
            enrollmentId,
            branchId: inv.branchId,
            kind: 'credit_note',
            description: `Credit note · ${inv.number} restructured`,
            reference: cn.number,
            credit,
            invoiceId: inv.id,
            createdBy: by.approvedBy ?? by.requestedBy,
          });
        }
      }
    }
    const maxSeq = all.reduce((m, i) => Math.max(m, i.seq), 0);
    await tx.insert(s.instalment).values(
      rows.map((r, i) => ({
        enrollmentId,
        branchId: ec.enrollment.branchId,
        seq: maxSeq + i + 1,
        label: r.label,
        dueDate: r.dueDate,
        amount: r.amount,
        revision: next,
      })),
    );
    if (target === null) await tx.update(s.enrollment).set({ feeTotal: sum }).where(eq(s.enrollment.id, enrollmentId));
    await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'restructure', note: `${target === null ? 'Schedule set up' : `Revision ${next}`} · ${formatINR(sum)} into ${rows.length} · ${reason}`, createdBy: by.approvedBy ?? by.requestedBy });
    // Rows due today or earlier are invoiced now; the rest at their invoice date (bulk / reminders / desk).
    const fresh = await tx.select().from(s.instalment).where(and(eq(s.instalment.enrollmentId, enrollmentId), eq(s.instalment.revision, next)));
    for (const f of fresh.filter((x) => x.dueDate <= addDays(today, 7))) await this.invoices.issueForInstalment(tx, f.id, { audit: false });
    const clr = await this.shared.recomputeClearance(tx, enrollmentId);
    await this.audit.log(tx, {
      action: target === null ? 'Fee schedule set up' : 'Schedule restructured',
      kind: 'update',
      entityType: 'instalment',
      entityId: enrollmentId,
      entityLabel: `${ec.student.name} · ${ec.student.admissionNo ?? ''}`,
      before: { revision: active.length ? current : 0, outstanding: target },
      after: { revision: next, rows },
      summary: `${target === null ? 'New schedule' : `Revision ${current} → ${next}`} · ${formatINR(sum)} into ${rows.length} · ${reason}${clr.changed ? ` · notes ${clr.cleared ? 'unlocked' : 'locked'}` : ''}`,
      branchId: ec.branch.id,
    });
    this.shared.invalidate(tx, ec.branch.id, this.shared.portalUserIds(ec));
  }

  /* ───────────────────────── Follow-up ───────────────────────── */

  async logCall(enrollmentId: string, outcome: string, promiseDate: ISODate | null): Promise<void> {
    const today = todayIST();
    if (promiseDate && promiseDate < today) throw invalid('A promise-to-pay date cannot be in the past', { promiseDate: 'From today onwards' });
    await this.db.tx(async (tx) => {
      const c = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(c.branch.id);
      const me = ctx().userId;
      await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'call', channel: 'phone', note: outcome, promiseDate: promiseDate ?? null, createdBy: me });
      if (promiseDate) await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'promise', note: `Promised ${formatDayMonth(promiseDate)}`, promiseDate, createdBy: me });
      await this.audit.log(tx, {
        action: 'Call logged',
        kind: 'create',
        entityType: 'enrollment_fee',
        entityId: enrollmentId,
        entityLabel: c.student.name,
        summary: `${outcome}${promiseDate ? ` · promise-to-pay ${promiseDate}` : ''}`,
        branchId: c.branch.id,
      });
      this.shared.invalidate(tx, c.branch.id);
    });
  }

  /* ───────────────────────── Refund (always Super Admin) ───────────────────────── */

  async requestRefund(enrollmentId: string, amount: number, reason: string): Promise<{ approvalId: string; message: string }> {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(ec.branch.id);
      const [paid] = await tx
        .select({ n: sql<number>`coalesce(sum(${s.payment.total}),0)::bigint` })
        .from(s.payment)
        .where(and(eq(s.payment.enrollmentId, enrollmentId), eq(s.payment.status, 'cleared')));
      const [refunded] = await tx
        .select({ n: sql<number>`coalesce(sum(${s.ledgerEntry.debit}),0)::bigint` })
        .from(s.ledgerEntry)
        .where(and(eq(s.ledgerEntry.enrollmentId, enrollmentId), eq(s.ledgerEntry.kind, 'refund')));
      const refundable = Number(paid?.n ?? 0) - Number(refunded?.n ?? 0);
      if (amount > refundable) throw invalid(`At most ${formatINR(refundable)} can be refunded (cleared payments less earlier refunds)`, { amount: `At most ${formatINR(refundable)}` });
      const [a] = await tx
        .insert(s.approvalRequest)
        .values({
          institutionId: c.institutionId,
          branchId: ec.branch.id,
          kind: 'refund',
          level: 'super_admin',
          title: `Refund ${formatINR(amount)} · ${ec.student.name}`,
          summary: `${ec.batch.code} · ${reason} · credit note on approval`,
          entityType: 'enrollment',
          entityId: enrollmentId,
          amount,
          payload: { reason },
          requestedBy: c.userId,
        })
        .returning({ id: s.approvalRequest.id });
      await this.events.emit(tx, 'ApprovalRequested', { approvalId: a!.id, kind: 'refund', level: 'super_admin', branchId: ec.branch.id });
      await this.audit.log(tx, { action: 'Refund requested', kind: 'create', entityType: 'approval', entityId: a!.id, entityLabel: ec.student.name, summary: `${formatINR(amount)} · ${reason} → Super Admin`, branchId: ec.branch.id });
      this.shared.invalidate(tx, ec.branch.id);
      return { approvalId: a!.id, message: 'Refund sent to Super Admin for approval' };
    });
  }

  /** Approved refund: credit note (gap-free), ledger credit-note reversal and the payout entry. */
  async applyRefund(tx: Tx, enrollmentId: string, amount: number, reason: string): Promise<void> {
    const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
    const cn = await this.invoices.creditNote(tx, { branchId: ec.branch.id, enrollmentId, invoiceId: null, amount, reason: `Refund · ${reason}` });
    await tx.insert(s.ledgerEntry).values([
      { enrollmentId, branchId: ec.branch.id, kind: 'credit_note', description: `Credit note · refund approved · ${reason}`, reference: cn.number, credit: amount, createdBy: ctx().userId },
      { enrollmentId, branchId: ec.branch.id, kind: 'refund', description: 'Refund payout', reference: cn.number, debit: amount, createdBy: ctx().userId },
    ]);
    await this.shared.recomputeClearance(tx, enrollmentId);
    await this.audit.log(tx, { action: 'Refund issued', kind: 'payment', entityType: 'credit_note', entityId: cn.id, entityLabel: cn.number, summary: `${ec.student.name} · ${formatINR(amount)} · ${reason}`, branchId: ec.branch.id });
    this.shared.invalidate(tx, ec.branch.id, this.shared.portalUserIds(ec));
  }

  /** Approved waiver: payload { instalmentId, amount, reason }. */
  async applyWaiver(tx: Tx, instalmentId: string, amount: number, reason: string): Promise<void> {
    const [inst] = await tx.select().from(s.instalment).where(eq(s.instalment.id, instalmentId)).for('update');
    if (!inst) throw notFound('Instalment');
    const waive = Math.min(amount, openBalance(inst));
    if (waive <= 0) return;
    const next = { ...inst, waived: inst.waived + waive };
    await tx.update(s.instalment).set({ waived: next.waived, status: instalmentStatus(next) }).where(eq(s.instalment.id, inst.id));
    await tx.insert(s.ledgerEntry).values({ enrollmentId: inst.enrollmentId, branchId: inst.branchId, kind: 'waiver', description: `Waiver · ${inst.label} · ${reason}`, credit: waive, createdBy: ctx().userId });
    await this.shared.recomputeClearance(tx, inst.enrollmentId);
    await this.audit.log(tx, { action: 'Waiver applied', kind: 'update', entityType: 'instalment', entityId: inst.id, entityLabel: inst.label, summary: `${formatINR(waive)} · ${reason}`, branchId: inst.branchId });
    this.shared.invalidate(tx, inst.branchId);
  }
}

function activityLabel(a: typeof s.duesActivity.$inferSelect): string {
  switch (a.kind) {
    case 'reminder':
      return `Reminder · ${a.channel ?? 'WhatsApp + email'}${a.note ? ` · ${a.note}` : ''}`;
    case 'call':
      return `Call · ${a.note ?? ''}${a.promiseDate ? ` · promised ${formatDayMonth(a.promiseDate)}` : ''}`;
    case 'promise':
      return 'Promise-to-pay';
    case 'payment_link':
      return `Payment link sent${a.note ? ` · ${a.note}` : ''}`;
    case 'exemption':
      return `Exemption · ${a.note ?? ''}`;
    case 'restructure':
      return `Restructure · ${a.note ?? ''}`;
    default:
      return a.note ?? a.kind;
  }
}
