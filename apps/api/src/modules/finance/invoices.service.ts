import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, ne, sql, type DbOrTx, type Tx } from '@exatech/db';
import { addDays, formatINR, todayIST, type ISODate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { maybeCtx } from '../../core/context';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FinanceShared } from './finance.shared';
import { invoiceStatus, openBalance, splitGst } from './ledger';

/**
 * GST tax invoices and credit notes. Invoices state what is owed (one per
 * instalment); a charge is posted to the ledger when an invoice is issued.
 * Cancelling never deletes: a credit note reverses the charge and the number
 * stays in the series as cancelled.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly shared: FinanceShared,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async activeInvoiceFor(tx: Tx, instalmentId: string) {
    const [inv] = await tx
      .select()
      .from(s.invoice)
      .where(and(eq(s.invoice.instalmentId, instalmentId), ne(s.invoice.status, 'cancelled')))
      .limit(1);
    return inv ?? null;
  }

  /**
   * Issue the GST invoice for an instalment (idempotent: returns the active
   * one if it exists). Posts the ledger charge (or `ledgerKind`).
   */
  async issueForInstalment(tx: Tx, instalmentId: string, opts: { ledgerKind?: 'charge' | 'adjustment'; createdBy?: string | null; today?: ISODate; audit?: boolean } = {}) {
    const existing = await this.activeInvoiceFor(tx, instalmentId);
    if (existing) return existing;
    const [inst] = await tx.select().from(s.instalment).where(eq(s.instalment.id, instalmentId));
    if (!inst) throw notFound('Instalment');
    if (inst.status === 'cancelled') throw invalid('This instalment was restructured — it cannot be invoiced');
    const c = await this.shared.enrollmentCtx(tx, inst.enrollmentId);
    const fin = await this.shared.settings(tx);
    const [plan] = c.enrollment.feePlanId ? await tx.select({ gstRate: s.feePlan.gstRate }).from(s.feePlan).where(eq(s.feePlan.id, c.enrollment.feePlanId)) : [];
    const rate = plan?.gstRate ?? fin.gstRate;
    const today = opts.today ?? todayIST();
    const amount = inst.amount - inst.waived;
    if (amount <= 0) throw invalid('Nothing to invoice on this instalment');
    const { taxable, tax } = splitGst(amount, rate);
    const { number, seq, fy } = await this.shared.nextNumber(tx, c.branch.id, 'invoice', today);
    const label = /^\d/.test(inst.label) ? `Instalment ${inst.label}` : inst.label;
    const paid = Math.min(amount, inst.paid);
    const [inv] = await tx
      .insert(s.invoice)
      .values({
        branchId: c.branch.id,
        enrollmentId: inst.enrollmentId,
        studentId: c.student.id,
        instalmentId: inst.id,
        number,
        fy,
        seq,
        issueDate: today,
        dueDate: inst.dueDate,
        lines: [{ description: `${c.course.name} · ${label}`, sac: fin.sac, amount: taxable, taxRate: rate, tax }],
        subtotal: taxable,
        tax,
        total: amount,
        paid,
        status: invoiceStatus(amount, paid, 'issued'),
        createdBy: opts.createdBy ?? maybeCtx()?.userId ?? null,
      })
      .returning();
    await tx.insert(s.ledgerEntry).values({
      enrollmentId: inst.enrollmentId,
      branchId: c.branch.id,
      kind: opts.ledgerKind ?? 'charge',
      description: opts.ledgerKind === 'adjustment' ? `Adjustment · ${inst.label}` : `Invoice · ${inst.label}`,
      reference: number,
      debit: amount,
      invoiceId: inv!.id,
      createdBy: opts.createdBy ?? maybeCtx()?.userId ?? null,
    });
    // Allocations made before the invoice existed now point at it.
    await tx.update(s.paymentAllocation).set({ invoiceId: inv!.id }).where(and(eq(s.paymentAllocation.instalmentId, inst.id), sql`${s.paymentAllocation.invoiceId} is null`));
    await this.events.emit(tx, 'InvoiceIssued', { invoiceId: inv!.id, enrollmentId: inst.enrollmentId, number });
    if (opts.audit !== false) {
      await this.audit.log(tx, {
        action: 'Invoice issued',
        kind: 'create',
        entityType: 'invoice',
        entityId: inv!.id,
        entityLabel: number,
        after: { total: amount, dueDate: inst.dueDate },
        summary: `${c.student.name} · ${inst.label} · ${formatINR(amount)} due ${inst.dueDate}`,
        branchId: c.branch.id,
      });
    }
    return inv!;
  }

  /** Recompute paid/status from cleared, non-reversed allocations. */
  async recompute(tx: Tx, invoiceId: string): Promise<void> {
    const [inv] = await tx.select().from(s.invoice).where(eq(s.invoice.id, invoiceId));
    if (!inv) return;
    const [{ paid } = { paid: 0 }] = await tx
      .select({ paid: sql<number>`coalesce(sum(${s.paymentAllocation.amount}), 0)::bigint` })
      .from(s.paymentAllocation)
      .where(and(eq(s.paymentAllocation.invoiceId, invoiceId), eq(s.paymentAllocation.reversed, false), eq(s.paymentAllocation.pending, false)));
    const p = Math.min(inv.total, Number(paid));
    const status = inv.status === 'cancelled' ? 'cancelled' : inv.creditNoteId && p < inv.total ? 'paid' : invoiceStatus(inv.total, p, inv.status);
    if (p !== inv.paid || status !== inv.status) await tx.update(s.invoice).set({ paid: p, status }).where(eq(s.invoice.id, invoiceId));
  }

  async creditNote(tx: Tx, input: { branchId: string; enrollmentId: string; invoiceId: string | null; amount: number; reason: string; today?: ISODate }) {
    const { number, seq, fy } = await this.shared.nextNumber(tx, input.branchId, 'credit_note', input.today);
    const [cn] = await tx
      .insert(s.creditNote)
      .values({ branchId: input.branchId, invoiceId: input.invoiceId, enrollmentId: input.enrollmentId, number, fy, seq, amount: input.amount, reason: input.reason, createdBy: maybeCtx()?.userId ?? null })
      .returning();
    return cn!;
  }

  /** Cancel an invoice: credit note for the full amount, ledger reversal, number kept as cancelled. */
  async cancel(tx: Tx, invoiceId: string, reason: string) {
    const [inv] = await tx.select().from(s.invoice).where(eq(s.invoice.id, invoiceId)).for('update');
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'cancelled') throw conflict(`${inv.number} is already cancelled`);
    const [alloc] = await tx
      .select({ n: sql<number>`count(*)::int`, amt: sql<number>`coalesce(sum(${s.paymentAllocation.amount}),0)::bigint` })
      .from(s.paymentAllocation)
      .where(and(eq(s.paymentAllocation.invoiceId, inv.id), eq(s.paymentAllocation.reversed, false)));
    if (Number(alloc?.n ?? 0) > 0) throw invalid(`${formatINR(Number(alloc!.amt))} has been received against ${inv.number} — void those receipts first`);
    const cn = await this.creditNote(tx, { branchId: inv.branchId, enrollmentId: inv.enrollmentId, invoiceId: inv.id, amount: inv.total, reason });
    await tx.update(s.invoice).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, creditNoteId: cn.id }).where(eq(s.invoice.id, inv.id));
    await tx.insert(s.ledgerEntry).values({
      enrollmentId: inv.enrollmentId,
      branchId: inv.branchId,
      kind: 'credit_note',
      description: `Credit note · ${inv.number} cancelled · ${reason}`,
      reference: cn.number,
      credit: inv.total,
      invoiceId: inv.id,
      createdBy: maybeCtx()?.userId ?? null,
    });
    const c = await this.shared.enrollmentCtx(tx, inv.enrollmentId);
    await this.audit.log(tx, {
      action: 'Invoice cancelled',
      kind: 'update',
      entityType: 'invoice',
      entityId: inv.id,
      entityLabel: inv.number,
      before: { status: inv.status },
      after: { status: 'cancelled', creditNote: cn.number },
      summary: `${inv.number} → cancelled · credit note ${cn.number} · ${formatINR(inv.total)} · ${reason}`,
      branchId: inv.branchId,
    });
    this.shared.invalidate(tx, inv.branchId, this.shared.portalUserIds(c));
    return cn;
  }

  /** Instalments in a batch due within N days that have no active invoice. */
  async bulkCandidates(tx: DbOrTx, batchId: string, withinDays: number, today: ISODate = todayIST()) {
    const horizon = addDays(today, withinDays);
    const rows = await tx
      .select({ inst: s.instalment, studentId: s.enrollment.studentId })
      .from(s.instalment)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.instalment.enrollmentId))
      .where(
        and(
          eq(s.enrollment.batchId, batchId),
          inArray(s.enrollment.status, ['active', 'on_hold']),
          inArray(s.instalment.status, ['due', 'partially_paid']),
          sql`${s.instalment.dueDate} <= ${horizon}`,
          sql`not exists (select 1 from invoice i where i.instalment_id = "instalment"."id" and i.status <> 'cancelled')`,
        ),
      )
      .orderBy(asc(s.instalment.dueDate));
    return rows.filter((r) => openBalance(r.inst) > 0 || r.inst.paid > 0);
  }
}
