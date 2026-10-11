import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, type DbOrTx } from '@exatech/db';
import { formatDate, formatDayMonth, formatINR, sumPaise, todayIST, toISTDate, toISTTime } from '@exatech/domain';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { DocumentKit, MUTED, type PaperFormat } from '../../core/documents/document-kit';
import { notFound } from '../../core/errors';
import { FinanceShared, type EnrollmentCtx } from './finance.shared';
import { cgstOf, lateFeeOpen, METHOD_SHORT, openBalance, splitGst } from './ledger';

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', cheque: 'Cheque', transfer: 'Bank transfer', online: 'Razorpay online' };

/** Signed public tokens for invoices / credit notes (receipts carry their own random token). */
export function docToken(kind: 'i' | 'c', id: string): string {
  const sig = crypto.createHmac('sha256', env().AUTH_SECRET).update(`${kind}:${id}`).digest('base64url').slice(0, 16);
  return `${kind}.${id}.${sig}`;
}

export function parseDocToken(token: string): { kind: 'i' | 'c'; id: string } | null {
  const m = /^([ic])\.([0-9a-f-]{36})\.([\w-]{16})$/.exec(token);
  if (!m) return null;
  const [, kind, id] = m as unknown as [string, 'i' | 'c', string];
  const expected = docToken(kind, id);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token)) ? { kind, id } : null;
}

export const verifyUrl = (token: string) => `${env().WEB_ORIGIN}/verify/receipt/${token}`;

/**
 * Finance documents (PDF via DocumentKit): GST tax invoice, receipt (A4 / A5 /
 * 80 mm), credit note and statement of account. Institution identity, branch
 * address + GSTIN, admission barcode and a verification QR are injected.
 */
@Injectable()
export class FinanceDocuments {
  constructor(private readonly shared: FinanceShared) {}

  private async kit(c: EnrollmentCtx, format: PaperFormat, title: string, number: string, date: string) {
    const inst = await this.shared.institution();
    const kit = await DocumentKit.create(format, { title: `${title} ${number}`, author: inst.name });
    const addr = [c.branch.address, c.branch.city].filter(Boolean).join(', ');
    kit.header({
      institution: inst.name,
      branch: { name: `${inst.legalName ?? inst.name} · ${c.branch.name}`, lines: [addr, c.branch.phone ? `Phone ${c.branch.phone}` : ''].filter(Boolean) },
      title,
      number,
      date,
      gstin: c.branch.gstin ?? inst.gstin,
    });
    return { kit, inst };
  }

  private async studentBlock(kit: DocumentKit, c: EnrollmentCtx, label = 'Student') {
    const g = c.guardians[0];
    kit.keyValues([
      [label, c.student.name],
      ['Admission no.', c.student.admissionNo ?? '—'],
      ['Course · batch', `${c.course.name} · ${c.batch.code}`],
      ...(g ? ([[`Guardian`, `${g.name} (${g.relationship})`]] as [string, string][]) : []),
    ]);
    if (c.student.admissionNo) await kit.barcode(c.student.admissionNo, { width: kit.small ? kit.contentWidth * 0.8 : 150 });
  }

  private async verification(kit: DocumentKit, url: string, caption: string) {
    const size = kit.small ? 64 : 70;
    kit.ensure(size + 10);
    const top = kit.y;
    await kit.qr(url, { x: kit.margin, y: top - size, size });
    const tx = kit.margin + size + 8;
    const w = kit.contentWidth - size - 8;
    kit.y = top - 2;
    kit.text(caption, { x: tx, size: 8.5, bold: true, width: w });
    kit.text(url, { x: tx, size: 7, color: MUTED, width: w });
    kit.y = Math.min(kit.y, top - size - 6);
  }

  /* ───────────────────────── Receipt ───────────────────────── */

  async receipt(receiptId: string, format: PaperFormat, duplicate: boolean, db: DbOrTx = this.shared.db.db): Promise<{ buffer: Buffer; filename: string; enrollmentId: string; branchId: string; number: string }> {
    const [row] = await db.select({ r: s.receipt, p: s.payment }).from(s.receipt).innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId)).where(eq(s.receipt.id, receiptId));
    if (!row) throw notFound('Receipt');
    const { r, p } = row;
    const c = await this.shared.enrollmentCtx(db, p.enrollmentId);
    const tenders = await db.select().from(s.paymentTender).where(eq(s.paymentTender.paymentId, p.id));
    const allocs = await db
      .select({ amount: s.paymentAllocation.amount, pending: s.paymentAllocation.pending, reversed: s.paymentAllocation.reversed, label: s.instalment.label, invoice: s.invoice.number })
      .from(s.paymentAllocation)
      .innerJoin(s.instalment, eq(s.instalment.id, s.paymentAllocation.instalmentId))
      .leftJoin(s.invoice, eq(s.invoice.id, s.paymentAllocation.invoiceId))
      .where(eq(s.paymentAllocation.paymentId, p.id))
      .orderBy(asc(s.instalment.dueDate));
    const [cashier] = p.receivedBy ? await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, p.receivedBy)) : [];
    const insts = await this.shared.instalments(db, p.enrollmentId);
    const date = `${formatDate(toISTDate(r.issuedAt))} ${toISTTime(r.issuedAt)}`;
    const { kit, inst } = await this.kit(c, format, 'Receipt', r.number, date);
    const mark = [r.voided ? 'VOID' : null, duplicate ? 'DUPLICATE' : null].filter(Boolean).join(' · ');
    if (mark) kit.watermark(mark);
    await this.studentBlock(kit, c, 'Received from');
    const small = kit.small;
    kit.text('Payment', { bold: true, size: 10 });
    kit.table(
      small
        ? [
            { label: 'Method', width: 0.55 },
            { label: 'Amount', width: 0.45, align: 'right' },
          ]
        : [
            { label: 'Method', width: 0.3 },
            { label: 'Reference', width: 0.45 },
            { label: 'Amount', width: 0.25, align: 'right' },
          ],
      [
        ...tenders.map((t) => {
          const m = `${METHOD_LABEL[t.method] ?? t.method}${t.method === 'cheque' ? ` · ${t.chequeStatus === 'pending' ? 'pending clearance' : t.chequeStatus}` : ''}`;
          return small ? [t.reference ? `${m} · ${t.reference}` : m, formatINR(t.amount)] : [m, t.reference ?? '—', formatINR(t.amount)];
        }),
        small ? ['Total received', formatINR(p.total)] : ['Total received', '', formatINR(p.total)],
      ],
      { boldLast: true },
    );
    if (allocs.length || p.excessCredit > 0) {
      kit.text('Allocated to', { bold: true, size: 10 });
      kit.table(
        small
          ? [
              { label: 'Instalment', width: 0.6 },
              { label: 'Amount', width: 0.4, align: 'right' },
            ]
          : [
              { label: 'Instalment', width: 0.45 },
              { label: 'Invoice', width: 0.33 },
              { label: 'Amount', width: 0.22, align: 'right' },
            ],
        [
          ...allocs.map((a) => {
            const label = `${a.label}${a.pending ? ' (pending)' : ''}${a.reversed ? ' (reversed)' : ''}`;
            return small ? [label, formatINR(a.amount)] : [label, a.invoice ?? '—', formatINR(a.amount)];
          }),
          ...(p.excessCredit > 0 ? [small ? ['Held as credit', formatINR(p.excessCredit)] : ['Held as credit on the fee account', '', formatINR(p.excessCredit)]] : []),
        ],
      );
    }
    const balance = sumPaise(insts.map(openBalance));
    kit.keyValues([
      ['Balance remaining', formatINR(balance)],
      ['Received by', p.channel === 'online' ? 'Online · Razorpay' : p.channel === 'reconciliation' ? `Settlement reconciliation${cashier ? ` · ${cashier.name}` : ''}` : (cashier?.name ?? '—')],
      ...(p.status === 'pending_clearance' ? ([['Status', 'Cheque pending clearance — fee-gated content unlocks once it clears']] as [string, string][]) : []),
      ...(r.voided ? ([['Status', `VOIDED${p.voidReason ? ` · ${p.voidReason}` : ''}`]] as [string, string][]) : []),
      ...(p.status === 'bounced' ? ([['Status', 'Cheque bounced — this receipt is not valid']] as [string, string][]) : []),
    ]);
    kit.gap(4);
    await this.verification(kit, verifyUrl(r.verifyToken), 'Scan to verify this receipt');
    kit.footer(`${inst.name} · computer-generated receipt${duplicate ? ` · duplicate copy (reprint ${r.reprintCount})` : ''} · ${r.number}`);
    return { buffer: await kit.save(), filename: `${r.number.replace(/[^\w-]+/g, '_')}${duplicate ? '-duplicate' : ''}.pdf`, enrollmentId: p.enrollmentId, branchId: p.branchId, number: r.number };
  }

  /* ───────────────────────── Invoice ───────────────────────── */

  async invoice(invoiceId: string, duplicate: boolean, db: DbOrTx = this.shared.db.db): Promise<{ buffer: Buffer; filename: string; enrollmentId: string; branchId: string; number: string }> {
    const [inv] = await db.select().from(s.invoice).where(eq(s.invoice.id, invoiceId));
    if (!inv) throw notFound('Invoice');
    const c = await this.shared.enrollmentCtx(db, inv.enrollmentId);
    const [cn] = inv.creditNoteId ? await db.select().from(s.creditNote).where(eq(s.creditNote.id, inv.creditNoteId)) : [];
    const { kit, inst } = await this.kit(c, 'A4', 'Tax invoice', inv.number, formatDate(inv.issueDate));
    const mark = [inv.status === 'cancelled' ? 'CANCELLED' : null, duplicate ? 'DUPLICATE' : null].filter(Boolean).join(' · ');
    if (mark) kit.watermark(mark);
    await this.studentBlock(kit, c, 'Billed to');
    kit.keyValues([
      ['Place of supply', 'Kerala (32)'],
      ['Due date', formatDate(inv.dueDate)],
    ]);
    const rows = inv.lines.map((l) => {
      const half = cgstOf(l.tax);
      return [l.description, l.sac, formatINR(l.amount), `${formatINR(half)}`, `${formatINR(l.tax - half)}`, formatINR(l.amount + l.tax)];
    });
    const rate = inv.lines[0]?.taxRate ?? 18;
    kit.table(
      [
        { label: 'Description', width: 0.36 },
        { label: 'SAC', width: 0.1 },
        { label: 'Taxable', width: 0.14, align: 'right' },
        { label: `CGST ${rate / 2}%`, width: 0.13, align: 'right' },
        { label: `SGST ${rate / 2}%`, width: 0.13, align: 'right' },
        { label: 'Amount', width: 0.14, align: 'right' },
      ],
      [...rows, ['Total', '', formatINR(inv.subtotal), formatINR(cgstOf(inv.tax)), formatINR(inv.tax - cgstOf(inv.tax)), formatINR(inv.total)]],
      { boldLast: true },
    );
    kit.keyValues([
      ['Amount paid', formatINR(inv.paid)],
      ['Balance due', formatINR(Math.max(0, inv.total - inv.paid))],
      ...(inv.status === 'cancelled' ? ([['Status', `Cancelled${cn ? ` · credit note ${cn.number}` : ''}${inv.cancelReason ? ` · ${inv.cancelReason}` : ''}`]] as [string, string][]) : []),
    ]);
    kit.text('Pay online from the student or parent portal, or at the branch counter (UPI, cash, card, cheque, bank transfer).', { size: 8.5, color: MUTED });
    kit.gap(6);
    await this.verification(kit, verifyUrl(docToken('i', inv.id)), 'Scan to verify this invoice');
    kit.footer(`${inst.name} · GST tax invoice · ${inv.number}${duplicate ? ` · duplicate copy (reprint ${inv.reprintCount})` : ''}`);
    return { buffer: await kit.save(), filename: `${inv.number.replace(/[^\w-]+/g, '_')}${duplicate ? '-duplicate' : ''}.pdf`, enrollmentId: inv.enrollmentId, branchId: inv.branchId, number: inv.number };
  }

  /* ───────────────────────── Credit note ───────────────────────── */

  async creditNote(id: string, db: DbOrTx = this.shared.db.db) {
    const [cn] = await db.select().from(s.creditNote).where(eq(s.creditNote.id, id));
    if (!cn) throw notFound('Credit note');
    const c = await this.shared.enrollmentCtx(db, cn.enrollmentId);
    const [inv] = cn.invoiceId ? await db.select().from(s.invoice).where(eq(s.invoice.id, cn.invoiceId)) : [];
    const { kit, inst } = await this.kit(c, 'A4', 'Credit note', cn.number, formatDate(toISTDate(cn.createdAt)));
    await this.studentBlock(kit, c, 'Issued to');
    kit.keyValues([
      ['Against', inv ? `Invoice ${inv.number} dated ${formatDate(inv.issueDate)}` : 'Fee account (refund)'],
      ['Reason', cn.reason],
      ['Credit amount', formatINR(cn.amount)],
    ]);
    if (inv) {
      const rate = inv.lines[0]?.taxRate ?? 18;
      const g = splitGst(cn.amount, rate);
      kit.table(
        [
          { label: 'Taxable', width: 0.25, align: 'right' },
          { label: `CGST ${rate / 2}%`, width: 0.25, align: 'right' },
          { label: `SGST ${rate / 2}%`, width: 0.25, align: 'right' },
          { label: 'Total', width: 0.25, align: 'right' },
        ],
        [[formatINR(g.taxable), formatINR(g.cgst), formatINR(g.sgst), formatINR(cn.amount)]],
      );
    }
    await this.verification(kit, verifyUrl(docToken('c', cn.id)), 'Scan to verify this credit note');
    kit.footer(`${inst.name} · credit note · ${cn.number}`);
    return { buffer: await kit.save(), filename: `${cn.number.replace(/[^\w-]+/g, '_')}.pdf`, enrollmentId: cn.enrollmentId, branchId: cn.branchId, number: cn.number };
  }

  /* ───────────────────────── Statement of account ───────────────────────── */

  async statement(enrollmentId: string, db: DbOrTx = this.shared.db.db) {
    const c = await this.shared.enrollmentCtx(db, enrollmentId);
    const today = todayIST();
    const insts = await this.shared.instalments(db, enrollmentId);
    const chain = await this.shared.chainIds(db, enrollmentId);
    const ledger = await db.select().from(s.ledgerEntry).where(inArray(s.ledgerEntry.enrollmentId, chain)).orderBy(asc(s.ledgerEntry.at), asc(s.ledgerEntry.id));
    const { kit, inst } = await this.kit(c, 'A4', 'Statement of account', c.student.admissionNo ?? c.student.name, formatDate(today));
    await this.studentBlock(kit, c);
    const paid = sumPaise(insts.map((i) => i.paid));
    const pending = sumPaise(insts.map((i) => i.pendingPaid));
    const outstanding = sumPaise(insts.map(openBalance));
    kit.keyValues([
      ['Total fee', `${formatINR(c.enrollment.feeTotal)}${c.enrollment.feePlanName ? ` · ${c.enrollment.feePlanName}` : ''} · incl. GST`],
      ['Paid', formatINR(paid)],
      ...(pending > 0 ? ([['Pending clearance', formatINR(pending)]] as [string, string][]) : []),
      ['Outstanding', `${formatINR(outstanding)}${sumPaise(insts.map(lateFeeOpen)) > 0 ? ` (incl. late fee ${formatINR(sumPaise(insts.map(lateFeeOpen)))})` : ''}`],
      ['Credit balance', formatINR(c.enrollment.creditBalance)],
      ['Fee clearance', c.enrollment.feeCleared ? 'Cleared' : `Locked · ${(c.enrollment.clearanceReason ?? '').replace(/\d{4}-\d{2}-\d{2}/g, (d) => formatDayMonth(d))}`],
    ]);
    if (insts.length) {
      kit.text('Instalment schedule', { bold: true, size: 10 });
      kit.table(
        [
          { label: 'Instalment', width: 0.34 },
          { label: 'Due', width: 0.16 },
          { label: 'Amount', width: 0.17, align: 'right' },
          { label: 'Paid', width: 0.17, align: 'right' },
          { label: 'Balance', width: 0.16, align: 'right' },
        ],
        insts.map((i) => [i.label, formatDayMonth(i.dueDate), formatINR(i.amount), formatINR(i.paid), formatINR(openBalance(i))]),
      );
    }
    kit.text('Ledger', { bold: true, size: 10 });
    let bal = 0;
    kit.table(
      [
        { label: 'Date', width: 0.1 },
        { label: 'Entry', width: 0.31 },
        { label: 'Reference', width: 0.25 },
        { label: 'Debit', width: 0.11, align: 'right' },
        { label: 'Credit', width: 0.11, align: 'right' },
        { label: 'Balance', width: 0.12, align: 'right' },
      ],
      ledger.length
        ? ledger.map((l) => {
            bal += l.debit - l.credit;
            return [formatDayMonth(toISTDate(l.at)), l.description, l.reference ?? '—', l.debit ? formatINR(l.debit) : '', l.credit ? formatINR(l.credit) : '', formatINR(bal)];
          })
        : [['—', 'No entries yet', '', '', '', formatINR(0)]],
    );
    kit.footer(`${inst.name} · statement of account · ${c.student.name} · generated ${formatDate(today)} · nothing is deleted — corrections appear as reversals`);
    return { buffer: await kit.save(), filename: `statement-${(c.student.admissionNo ?? c.student.id).replace(/[^\w-]+/g, '_')}.pdf`, enrollmentId, branchId: c.branch.id };
  }

  /** Latest active invoice for a set of instalments (attachments for reminders). */
  async invoiceIdsFor(db: DbOrTx, instalmentIds: string[]) {
    if (instalmentIds.length === 0) return [];
    return db
      .select({ id: s.invoice.id, instalmentId: s.invoice.instalmentId, number: s.invoice.number })
      .from(s.invoice)
      .where(and(inArray(s.invoice.instalmentId, instalmentIds)));
  }

  static methodShort(m: string) {
    return METHOD_SHORT[m] ?? m;
  }
}
