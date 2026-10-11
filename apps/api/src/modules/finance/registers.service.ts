import { Injectable } from '@nestjs/common';
import type { CreditNoteRow, InvoiceRow, ReceiptRow } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from '@exatech/db';
import { addDays, formatINR, istDateTime, monthStart, todayIST, toISTDate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FinanceMessages } from './finance-messages.service';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { tenderSummary } from './ledger';
import { PaymentsService } from './payments.service';

type ListQuery = { q?: string; status?: string; month?: string; limit: number };

const like = (q: string) => `%${q.replace(/[%_]/g, '')}%`;

/** Invoices, receipts and credit notes registers and their actions (cancel, reprint, void, bulk generate). */
@Injectable()
export class RegistersService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly messages: FinanceMessages,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  private monthRange(month?: string): [string, string] | null {
    if (!month) return null;
    const start = `${month}-01`;
    return [start, monthStart(addDays(start, 32))];
  }

  async listInvoices(q: ListQuery): Promise<{ items: InvoiceRow[]; total: number }> {
    const today = todayIST();
    const where: (SQL | undefined)[] = [inBranchScope(s.invoice.branchId)];
    if (q.q) where.push(or(ilike(s.invoice.number, like(q.q)), ilike(s.student.name, like(q.q)), ilike(s.student.admissionNo, like(q.q))));
    const r = this.monthRange(q.month);
    if (r) where.push(gte(s.invoice.issueDate, r[0]), lt(s.invoice.issueDate, r[1]));
    if (q.status === 'paid') where.push(eq(s.invoice.status, 'paid'));
    if (q.status === 'partially_paid') where.push(eq(s.invoice.status, 'partially_paid'));
    if (q.status === 'cancelled') where.push(eq(s.invoice.status, 'cancelled'));
    if (q.status === 'issued') where.push(eq(s.invoice.status, 'issued'), gte(s.invoice.dueDate, today));
    if (q.status === 'overdue') where.push(inArray(s.invoice.status, ['issued', 'partially_paid']), lt(s.invoice.dueDate, today));
    const base = this.db.db
      .select({ inv: s.invoice, student: s.student.name, adm: s.student.admissionNo, batch: s.batch.code })
      .from(s.invoice)
      .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.invoice.enrollmentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .where(and(...where));
    const rows = await base.orderBy(desc(s.invoice.issueDate), desc(s.invoice.seq)).limit(q.limit);
    const [{ n } = { n: 0 }] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.invoice)
      .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
      .where(and(...where));
    const ids = rows.map((r) => r.inv.id);
    const allocs = ids.length
      ? await this.db.db
          .select({ invoiceId: s.paymentAllocation.invoiceId, n: sql<number>`count(*)::int` })
          .from(s.paymentAllocation)
          .where(and(inArray(s.paymentAllocation.invoiceId, ids), eq(s.paymentAllocation.reversed, false)))
          .groupBy(s.paymentAllocation.invoiceId)
      : [];
    return {
      total: Number(n),
      items: rows.map(({ inv, student, adm, batch }) => {
        const overdue = (inv.status === 'issued' || inv.status === 'partially_paid') && inv.dueDate < today;
        const st =
          inv.status === 'cancelled'
            ? { label: 'Cancelled', tag: 'plain' as const }
            : inv.status === 'paid'
              ? { label: inv.creditNoteId && inv.paid < inv.total ? 'Closed · credit note' : 'Paid', tag: 'accent' as const }
              : overdue
                ? { label: inv.status === 'partially_paid' ? `Overdue · ${formatINR(inv.total - inv.paid)}` : 'Overdue', tag: 'ink' as const }
                : inv.status === 'partially_paid'
                  ? { label: 'Partially paid', tag: 'outline' as const }
                  : { label: 'Issued', tag: 'neutral' as const };
        const hasAlloc = allocs.some((a) => a.invoiceId === inv.id && Number(a.n) > 0);
        return {
          id: inv.id,
          number: inv.number,
          enrollmentId: inv.enrollmentId,
          studentName: student,
          admissionNo: adm,
          batchCode: batch,
          items: inv.lines.map((l) => `${l.description.split(' · ').slice(1).join(' · ') || l.description} + GST ${l.taxRate}%`).join(', '),
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          amount: inv.total,
          paid: inv.paid,
          status: inv.status,
          statusLabel: st.label,
          tag: st.tag,
          reprintCount: inv.reprintCount,
          cancelBlockedReason: inv.status === 'cancelled' ? 'Already cancelled' : hasAlloc ? 'Payments are allocated to this invoice — void those receipts first' : null,
        };
      }),
    };
  }

  async listReceipts(q: ListQuery): Promise<{ items: ReceiptRow[]; total: number }> {
    const where: (SQL | undefined)[] = [inBranchScope(s.receipt.branchId)];
    if (q.q) where.push(or(ilike(s.receipt.number, like(q.q)), ilike(s.student.name, like(q.q)), ilike(s.student.admissionNo, like(q.q))));
    const r = this.monthRange(q.month);
    if (r) where.push(gte(s.receipt.issuedAt, istDateTime(r[0])), lt(s.receipt.issuedAt, istDateTime(r[1])));
    if (q.status === 'cleared') where.push(eq(s.payment.status, 'cleared'));
    if (q.status === 'pending_clearance') where.push(eq(s.payment.status, 'pending_clearance'));
    if (q.status === 'voided') where.push(eq(s.receipt.voided, true));
    if (q.status === 'bounced') where.push(eq(s.payment.status, 'bounced'));
    const rows = await this.db.db
      .select({ r: s.receipt, p: s.payment, student: s.student.name, adm: s.student.admissionNo, batch: s.batch.code })
      .from(s.receipt)
      .innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId))
      .innerJoin(s.student, eq(s.student.id, s.payment.studentId))
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.payment.enrollmentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .where(and(...where))
      .orderBy(desc(s.receipt.issuedAt), desc(s.receipt.seq))
      .limit(q.limit);
    const [{ n } = { n: 0 }] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.receipt)
      .innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId))
      .innerJoin(s.student, eq(s.student.id, s.payment.studentId))
      .where(and(...where));
    const pids = rows.map((x) => x.p.id);
    const tenders = pids.length ? await this.db.db.select().from(s.paymentTender).where(inArray(s.paymentTender.paymentId, pids)) : [];
    const allocs = pids.length
      ? await this.db.db
          .select({ paymentId: s.paymentAllocation.paymentId, label: s.instalment.label, amount: s.paymentAllocation.amount })
          .from(s.paymentAllocation)
          .innerJoin(s.instalment, eq(s.instalment.id, s.paymentAllocation.instalmentId))
          .where(inArray(s.paymentAllocation.paymentId, pids))
      : [];
    // Lock state per receipt date (month locks + closed days).
    const lockCache = new Map<string, string | null>();
    const items: ReceiptRow[] = [];
    for (const { r: rec, p, student, adm, batch } of rows) {
      const date = toISTDate(p.receivedAt);
      const key = `${p.branchId}:${date}`;
      if (!lockCache.has(key)) lockCache.set(key, await this.shared.lockReason(this.db.db, p.branchId, date, { dayClose: true }));
      const t = tenders.filter((x) => x.paymentId === p.id);
      const st =
        rec.voided
          ? { label: 'Voided', tag: 'plain' as const }
          : p.status === 'pending_clearance'
            ? { label: 'Pending clearance', tag: 'outline' as const }
            : p.status === 'bounced'
              ? { label: 'Cheque bounced', tag: 'ink' as const }
              : { label: p.channel === 'online' ? 'Cleared · online' : 'Cleared', tag: 'accent' as const };
      items.push({
        id: rec.id,
        number: rec.number,
        paymentId: p.id,
        enrollmentId: p.enrollmentId,
        studentName: student,
        admissionNo: adm,
        batchCode: batch,
        tenders: tenderSummary(t),
        allocatedTo:
          allocs
            .filter((a) => a.paymentId === p.id)
            .map((a) => `${a.label} ${formatINR(a.amount)}`)
            .join(', ') || (p.excessCredit > 0 ? 'Credit' : '—'),
        date,
        amount: p.total,
        channel: p.channel,
        paymentStatus: p.status,
        statusLabel: st.label,
        tag: st.tag,
        voided: rec.voided,
        reprintCount: rec.reprintCount,
        hasPendingCheque: t.some((x) => x.method === 'cheque' && x.chequeStatus === 'pending'),
        voidNeedsApproval: !rec.voided && !!lockCache.get(key),
        voidBlockedReason: rec.voided ? 'Already voided' : p.status === 'bounced' ? 'Bounced cheques are already reversed' : null,
        verifyPath: `/verify/receipt/${rec.verifyToken}`,
      });
    }
    return { items, total: Number(n) };
  }

  async listCreditNotes(q: ListQuery): Promise<{ items: CreditNoteRow[]; total: number }> {
    const where: (SQL | undefined)[] = [inBranchScope(s.creditNote.branchId)];
    if (q.q) where.push(or(ilike(s.creditNote.number, like(q.q)), ilike(s.student.name, like(q.q)), ilike(s.student.admissionNo, like(q.q))));
    const r = this.monthRange(q.month);
    if (r) where.push(gte(s.creditNote.createdAt, istDateTime(r[0])), lt(s.creditNote.createdAt, istDateTime(r[1])));
    const rows = await this.db.db
      .select({ cn: s.creditNote, student: s.student.name, batch: s.batch.code, inv: s.invoice.number })
      .from(s.creditNote)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.creditNote.enrollmentId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .leftJoin(s.invoice, eq(s.invoice.id, s.creditNote.invoiceId))
      .where(and(...where))
      .orderBy(desc(s.creditNote.createdAt))
      .limit(q.limit);
    return {
      total: rows.length,
      items: rows.map(({ cn, student, batch, inv }) => ({
        id: cn.id,
        number: cn.number,
        enrollmentId: cn.enrollmentId,
        studentName: student,
        batchCode: batch,
        against: inv ? `Invoice ${inv}` : 'Refund',
        date: toISTDate(cn.createdAt),
        amount: cn.amount,
        reason: cn.reason,
      })),
    };
  }

  async cancelInvoice(id: string, reason: string) {
    const [inv] = await this.db.db.select({ branchId: s.invoice.branchId }).from(s.invoice).where(eq(s.invoice.id, id));
    if (!inv) throw notFound('Invoice');
    assertInScope(inv.branchId);
    return this.db.tx(async (tx) => {
      const cn = await this.invoices.cancel(tx, id, reason);
      return { creditNoteId: cn.id, creditNoteNumber: cn.number };
    });
  }

  async reprintInvoice(id: string) {
    return this.db.tx(async (tx) => {
      const [inv] = await tx.select().from(s.invoice).where(eq(s.invoice.id, id)).for('update');
      if (!inv) throw notFound('Invoice');
      assertInScope(inv.branchId);
      const count = inv.reprintCount + 1;
      await tx.update(s.invoice).set({ reprintCount: count }).where(eq(s.invoice.id, id));
      await this.audit.log(tx, { action: 'Reprint', kind: 'export', entityType: 'invoice', entityId: id, entityLabel: inv.number, summary: `${inv.number} · duplicate copy #${count} · watermarked`, branchId: inv.branchId });
      return { url: `/api/documents/invoices/${id}.pdf?copy=duplicate`, reprintCount: count };
    });
  }

  async reprintReceipt(id: string, format: string) {
    return this.db.tx(async (tx) => {
      const [rec] = await tx.select().from(s.receipt).where(eq(s.receipt.id, id)).for('update');
      if (!rec) throw notFound('Receipt');
      assertInScope(rec.branchId);
      const count = rec.reprintCount + 1;
      await tx.update(s.receipt).set({ reprintCount: count }).where(eq(s.receipt.id, id));
      await this.audit.log(tx, { action: 'Reprint', kind: 'export', entityType: 'receipt', entityId: id, entityLabel: rec.number, summary: `${rec.number} · duplicate copy #${count} · ${format} · watermarked`, branchId: rec.branchId });
      return { url: `/api/documents/receipts/${id}.pdf?format=${format}&copy=duplicate`, reprintCount: count };
    });
  }

  async resendReceipt(id: string) {
    const [rec] = await this.db.db.select({ branchId: s.receipt.branchId, number: s.receipt.number, voided: s.receipt.voided }).from(s.receipt).where(eq(s.receipt.id, id));
    if (!rec) throw notFound('Receipt');
    assertInScope(rec.branchId);
    if (rec.voided) throw invalid('A voided receipt cannot be resent');
    const sent = await this.messages.sendReceipt(id, { force: true });
    if (sent === 0) throw invalid('No student or parent portal account to send this receipt to');
    await this.audit.log(this.db.db, { action: 'Receipt resent', kind: 'other', entityType: 'receipt', entityId: id, entityLabel: rec.number, summary: `${rec.number} · WhatsApp + email · ${sent} recipient${sent === 1 ? '' : 's'}`, branchId: rec.branchId });
    return { sent };
  }

  /** Void a receipt; in a locked period (or a closed day) it raises a Super Admin approval instead. */
  async voidReceipt(id: string, reason: string): Promise<{ status: 'voided' | 'approval_requested'; message: string }> {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const [rec] = await tx.select().from(s.receipt).where(eq(s.receipt.id, id));
      if (!rec) throw notFound('Receipt');
      assertInScope(rec.branchId);
      if (rec.voided) throw conflict(`${rec.number} is already voided`);
      const lock = await this.payments.voidLockReason(tx, rec.paymentId);
      if (lock) {
        const [dup] = await tx
          .select({ id: s.approvalRequest.id })
          .from(s.approvalRequest)
          .where(and(eq(s.approvalRequest.entityId, rec.paymentId), eq(s.approvalRequest.status, 'pending')));
        if (dup) throw conflict(`Voiding ${rec.number} is already waiting for Super Admin approval`);
        const [p] = await tx.select({ total: s.payment.total, studentId: s.payment.studentId }).from(s.payment).where(eq(s.payment.id, rec.paymentId));
        const [st] = await tx.select({ name: s.student.name }).from(s.student).where(eq(s.student.id, p!.studentId));
        const [a] = await tx
          .insert(s.approvalRequest)
          .values({
            institutionId: c.institutionId,
            branchId: rec.branchId,
            kind: 'locked_period',
            level: 'super_admin',
            title: `Locked-period entry · void ${rec.number}`,
            summary: `${reason} · ${st?.name ?? ''} · ${formatINR(p!.total)} · ${lock.split(' — ')[0]}`,
            entityType: 'payment',
            entityId: rec.paymentId,
            amount: p!.total,
            payload: { action: 'void', reason },
            requestedBy: c.userId,
          })
          .returning({ id: s.approvalRequest.id });
        await this.events.emit(tx, 'ApprovalRequested', { approvalId: a!.id, kind: 'locked_period', level: 'super_admin', branchId: rec.branchId });
        await this.audit.log(tx, { action: 'Void requested', kind: 'create', entityType: 'approval', entityId: a!.id, entityLabel: rec.number, summary: `${rec.number} is in a locked period → Super Admin · ${reason}`, branchId: rec.branchId });
        this.shared.invalidate(tx, rec.branchId);
        return { status: 'approval_requested' as const, message: `${rec.number} is in a locked period — sent to Super Admin to approve the void` };
      }
      await this.payments.voidPayment(tx, rec.paymentId, reason);
      return { status: 'voided' as const, message: `${rec.number} voided · allocations reversed` };
    });
  }

  async bulkPreview(batchId: string, withinDays: number) {
    const [b] = await this.db.db.select({ branchId: s.batch.branchId }).from(s.batch).where(eq(s.batch.id, batchId));
    if (!b) throw notFound('Batch');
    assertInScope(b.branchId);
    const rows = await this.invoices.bulkCandidates(this.db.db, batchId, withinDays);
    return { count: rows.length, amount: rows.reduce((a, r) => a + r.inst.amount - r.inst.waived, 0), students: new Set(rows.map((r) => r.studentId)).size };
  }

  async bulkGenerate(batchId: string, withinDays: number) {
    const [b] = await this.db.db.select({ branchId: s.batch.branchId, code: s.batch.code }).from(s.batch).where(eq(s.batch.id, batchId));
    if (!b) throw notFound('Batch');
    assertInScope(b.branchId);
    return this.db.tx(async (tx) => {
      const rows = await this.invoices.bulkCandidates(tx, batchId, withinDays);
      if (rows.length === 0) throw invalid(`Every instalment in ${b.code} due within ${withinDays} days is already invoiced`);
      let amount = 0;
      for (const r of rows) {
        const inv = await this.invoices.issueForInstalment(tx, r.inst.id, { audit: false });
        amount += inv.total;
      }
      await this.audit.log(tx, { action: 'Invoices generated', kind: 'create', entityType: 'invoice', entityLabel: b.code, summary: `${rows.length} invoices · ${formatINR(amount)} · due within ${withinDays} days`, branchId: b.branchId });
      this.shared.invalidate(tx, b.branchId);
      return { issued: rows.length, amount };
    });
  }

  async batches() {
    return this.db.db
      .select({ id: s.batch.id, code: s.batch.code, branchName: s.branch.name })
      .from(s.batch)
      .innerJoin(s.branch, eq(s.branch.id, s.batch.branchId))
      .where(and(inBranchScope(s.batch.branchId), inArray(s.batch.status, ['open', 'running', 'waitlist', 'planned'])))
      .orderBy(s.branch.name, s.batch.code);
  }
}
