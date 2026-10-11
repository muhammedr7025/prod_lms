import { Injectable } from '@nestjs/common';
import { DOCUMENT_PATHS, FINANCE_DOCUMENT_PATHS, type PortalFees, type TagVariant } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, inArray, ne } from '@exatech/db';
import { daysBetween, formatDayMonth, formatINR, todayIST, toISTDate } from '@exatech/domain';
import { FinanceShared } from '../finance/finance.shared';
import { instalmentState, openBalance } from '../finance/ledger';
import { instalmentName, plural, PortalShared } from './portal.shared';

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Bank transfer', online: 'Online' };

/** Student / Parent · Fees: instalments, pay, invoices & receipts (Finance documents). */
@Injectable()
export class FeesService {
  constructor(
    private readonly shared: PortalShared,
    private readonly finance: FinanceShared,
  ) {}

  async fees(studentId?: string): Promise<PortalFees> {
    const sc = await this.shared.resolve(studentId);
    const db = this.shared.db.db;
    const today = todayIST();
    const fee = await this.shared.feeSummary(sc, today);
    const [enr] = await db.select({ planName: s.enrollment.feePlanName, total: s.enrollment.feeTotal }).from(s.enrollment).where(eq(s.enrollment.id, sc.enrollmentId));
    const chain = await this.finance.chainIds(db, sc.enrollmentId);

    // Payments allocated to each instalment (cleared or awaiting clearance), newest first.
    const instIds = fee.instalments.map((i) => i.id);
    const allocs = instIds.length
      ? await db
          .select({ instalmentId: s.paymentAllocation.instalmentId, paymentId: s.payment.id, receivedAt: s.payment.receivedAt, amount: s.paymentAllocation.amount, pending: s.paymentAllocation.pending })
          .from(s.paymentAllocation)
          .innerJoin(s.payment, eq(s.payment.id, s.paymentAllocation.paymentId))
          .where(and(inArray(s.paymentAllocation.instalmentId, instIds), eq(s.paymentAllocation.reversed, false), inArray(s.payment.status, ['cleared', 'pending_clearance'])))
          .orderBy(desc(s.payment.receivedAt))
      : [];
    const payIds = [...new Set(allocs.map((a) => a.paymentId))];
    const tenders = payIds.length ? await db.select({ paymentId: s.paymentTender.paymentId, method: s.paymentTender.method }).from(s.paymentTender).where(inArray(s.paymentTender.paymentId, payIds)) : [];
    const methodsOf = (paymentId: string) => [...new Set(tenders.filter((t) => t.paymentId === paymentId).map((t) => METHOD_LABEL[t.method] ?? t.method))].join(' + ');

    const instalments = fee.instalments.map((i) => {
      const st = instalmentState(i, today);
      const mine = allocs.filter((a) => a.instalmentId === i.id);
      const last = mine[0];
      const paidLine = last ? `paid ${formatDayMonth(toISTDate(last.receivedAt))}${methodsOf(last.paymentId) ? ` · ${methodsOf(last.paymentId)}` : ''}` : null;
      const open = openBalance(i);
      let tag: string;
      let tagVariant: TagVariant;
      let sub: string;
      switch (st.state) {
        case 'paid':
          [tag, tagVariant] = ['Paid', 'accent'];
          sub = [`Due ${formatDayMonth(i.dueDate)}`, paidLine].filter(Boolean).join(' · ');
          break;
        case 'overdue': {
          const d = daysBetween(i.dueDate, today);
          [tag, tagVariant] = ['Overdue', 'ink'];
          sub = [`Due ${formatDayMonth(i.dueDate)} · ${plural(d, 'day')} overdue`, i.paid > 0 ? `${formatINR(i.paid)} ${paidLine ?? 'paid'}` : null, `${formatINR(open)} open`].filter(Boolean).join(' · ');
          break;
        }
        case 'due_today':
          [tag, tagVariant] = ['Due today', 'ink'];
          sub = [`Due today`, i.paid > 0 ? `${formatINR(i.paid)} ${paidLine ?? 'paid'}` : null, `${formatINR(open)} open`].filter(Boolean).join(' · ');
          break;
        case 'partially_paid':
          [tag, tagVariant] = ['Partially paid', 'outline'];
          sub = [`Due ${formatDayMonth(i.dueDate)}`, `${formatINR(i.paid)} ${paidLine ?? 'paid'}`, `${formatINR(open)} open`].join(' · ');
          break;
        case 'pending_clearance':
          [tag, tagVariant] = ['Pending clearance', 'outline'];
          sub = [`Due ${formatDayMonth(i.dueDate)}`, paidLine, 'cheque awaiting clearance'].filter(Boolean).join(' · ');
          break;
        case 'waived':
          [tag, tagVariant] = ['Waived', 'neutral'];
          sub = `Due ${formatDayMonth(i.dueDate)} · waived`;
          break;
        default:
          [tag, tagVariant] = ['Not due', 'neutral'];
          sub = `Due ${formatDayMonth(i.dueDate)}`;
      }
      return { id: i.id, name: instalmentName(i.label), sub, amount: i.amount, tag, tagVariant, highlight: fee.next?.id === i.id && fee.card.state !== 'cleared' };
    });

    const [invoices, receipts, credits] = await Promise.all([
      db
        .select({ id: s.invoice.id, number: s.invoice.number, date: s.invoice.issueDate, total: s.invoice.total, status: s.invoice.status })
        .from(s.invoice)
        .where(inArray(s.invoice.enrollmentId, chain)),
      db
        .select({ id: s.receipt.id, number: s.receipt.number, at: s.receipt.issuedAt, paymentId: s.payment.id, total: s.payment.total })
        .from(s.receipt)
        .innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId))
        .where(and(inArray(s.payment.enrollmentId, chain), eq(s.receipt.voided, false), ne(s.payment.status, 'voided'))),
      db.select({ id: s.creditNote.id, number: s.creditNote.number, at: s.creditNote.createdAt, amount: s.creditNote.amount }).from(s.creditNote).where(inArray(s.creditNote.enrollmentId, chain)),
    ]);
    const recTenders = receipts.length ? await db.select({ paymentId: s.paymentTender.paymentId, method: s.paymentTender.method }).from(s.paymentTender).where(inArray(s.paymentTender.paymentId, receipts.map((r) => r.paymentId))) : [];
    const docs: (PortalFees['documents'][number] & { sort: string })[] = [
      ...invoices.map((x) => ({
        id: x.id,
        kind: 'invoice' as const,
        number: x.number,
        sub: `Invoice · ${formatDayMonth(x.date)} · ${formatINR(x.total)}${x.status === 'cancelled' ? ' · cancelled' : x.status === 'paid' ? ' · paid' : ''}`,
        pdfUrl: DOCUMENT_PATHS.invoice(x.id),
        printUrl: DOCUMENT_PATHS.invoice(x.id),
        sort: `${x.date}T00:00:00`,
      })),
      ...receipts.map((x) => {
        const m = [...new Set(recTenders.filter((t) => t.paymentId === x.paymentId).map((t) => METHOD_LABEL[t.method] ?? t.method))].join(' + ');
        return {
          id: x.id,
          kind: 'receipt' as const,
          number: x.number,
          sub: `Receipt · ${formatDayMonth(toISTDate(x.at))} · ${formatINR(x.total)}${m ? ` · ${m}` : ''}`,
          pdfUrl: DOCUMENT_PATHS.receipt(x.id),
          printUrl: `${DOCUMENT_PATHS.receipt(x.id)}?format=A5`,
          sort: x.at.toISOString(),
        };
      }),
      ...credits.map((x) => ({
        id: x.id,
        kind: 'credit_note' as const,
        number: x.number,
        sub: `Credit note · ${formatDayMonth(toISTDate(x.at))} · ${formatINR(x.amount)}`,
        pdfUrl: FINANCE_DOCUMENT_PATHS.creditNote(x.id),
        printUrl: FINANCE_DOCUMENT_PATHS.creditNote(x.id),
        sort: x.at.toISOString(),
      })),
    ];
    docs.sort((a, b) => b.sort.localeCompare(a.sort) || a.number.localeCompare(b.number));

    return {
      studentId: sc.studentId,
      enrollmentId: sc.enrollmentId,
      studentName: sc.name,
      kicker: `${enr?.planName ?? 'Fee plan'} · ${formatINR(enr?.total ?? fee.total)} incl. GST`,
      fee: fee.card,
      outstanding: fee.outstanding,
      statementUrl: DOCUMENT_PATHS.statement(sc.enrollmentId),
      instalments,
      pay: fee.pay,
      documents: docs.map(({ sort: _sort, ...d }) => d),
    };
  }
}
