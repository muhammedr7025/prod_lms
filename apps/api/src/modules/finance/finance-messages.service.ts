import { Injectable, Logger } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, eq, inArray, sql } from '@exatech/db';
import { formatDate, formatINR, sumPaise } from '@exatech/domain';
import { env } from '../../config/env';
import { Db } from '../../core/db';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { FinanceDocuments } from './documents.service';
import { FinanceShared } from './finance.shared';
import { openBalance } from './ledger';

function fill(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
}

/**
 * Documents travel with their messages: receipts, first invoices and due
 * reminders are generated as PDFs, stored, and attached to WhatsApp (signed
 * link) and email. Every send is idempotent unless explicitly forced.
 */
@Injectable()
export class FinanceMessages {
  private readonly log = new Logger('FinanceMessages');

  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly docs: FinanceDocuments,
    private readonly files: FilesService,
    private readonly notify: NotifyService,
  ) {}

  private async template(key: string, fallback: string): Promise<string> {
    const [t] = await this.db.db.select({ body: s.messageTemplate.body }).from(s.messageTemplate).where(eq(s.messageTemplate.key, key)).limit(1);
    return t?.body ?? fallback;
  }

  private async alreadyNotified(userIds: string[], entityType: string, entityId: string): Promise<boolean> {
    if (userIds.length === 0) return true;
    const [row] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.notification)
      .where(and(inArray(s.notification.userId, userIds), eq(s.notification.entityType, entityType), eq(s.notification.entityId, entityId)));
    return Number(row?.n ?? 0) > 0;
  }

  private portalLink(kind: 'student' | 'parent') {
    return `${env().WEB_ORIGIN}/${kind}/fees`;
  }

  /** Receipt PDF → student + guardians (WhatsApp payment_receipt + email + in-app). Returns recipients count. */
  async sendReceipt(receiptId: string, opts: { force?: boolean } = {}): Promise<number> {
    const [row] = await this.db.db.select({ r: s.receipt, p: s.payment }).from(s.receipt).innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId)).where(eq(s.receipt.id, receiptId));
    if (!row) return 0;
    const c = await this.shared.enrollmentCtx(this.db.db, row.p.enrollmentId);
    const users = this.shared.portalUserIds(c);
    if (users.length === 0) return 0;
    if (!opts.force && (await this.alreadyNotified(users, 'receipt', receiptId))) return 0;
    const pdf = await this.docs.receipt(receiptId, 'A4', false);
    const insts = await this.shared.instalments(this.db.db, row.p.enrollmentId);
    const balance = formatINR(sumPaise(insts.map(openBalance)));
    const tpl = await this.template('payment_receipt', 'Payment received: {amount} for {name}. Receipt {receipt_no}. Balance {balance}. Thank you — Exatech.');
    const wa = fill(tpl, { name: c.student.name, amount: formatINR(row.p.total), receipt_no: row.r.number, balance });
    await this.db.tx(async (tx) => {
      const file = await this.files.storeGenerated(tx, { buffer: pdf.buffer, filename: pdf.filename, mime: 'application/pdf', purpose: 'document' });
      const attach = [{ filename: pdf.filename, fileId: file.id }];
      const pending = row.p.status === 'pending_clearance' ? ' · cheque pending clearance' : '';
      await this.notify.notify(tx, {
        userIds: users,
        category: 'payment',
        title: `Payment received · ${formatINR(row.p.total)}`,
        body: `${c.student.name} · receipt ${row.r.number}${pending} · balance ${balance}`,
        link: null,
        entityType: 'receipt',
        entityId: receiptId,
        whatsapp: { body: wa, template: 'payment_receipt', attachments: attach },
        email: {
          subject: `Receipt ${row.r.number} · ${formatINR(row.p.total)} · ${c.student.name}`,
          body: `${wa}\n\nThe receipt is attached. You can verify it any time by scanning its QR code.\n\n— ${c.branch.name} accounts`,
          attachments: attach,
        },
      });
    });
    return users.length;
  }

  /**
   * Invoice PDF → student + guardians. `reminder` uses the fee_reminder
   * WhatsApp template (fee-due messages cannot be muted).
   */
  async sendInvoice(invoiceId: string, mode: 'first' | 'reminder', opts: { force?: boolean; note?: string } = {}): Promise<number> {
    const [inv] = await this.db.db.select().from(s.invoice).where(eq(s.invoice.id, invoiceId));
    if (!inv || inv.status === 'cancelled') return 0;
    const c = await this.shared.enrollmentCtx(this.db.db, inv.enrollmentId);
    const users = this.shared.portalUserIds(c);
    if (users.length === 0) return 0;
    const entityType = mode === 'first' ? 'invoice' : 'invoice_reminder';
    if (!opts.force && mode === 'first' && (await this.alreadyNotified(users, entityType, invoiceId))) return 0;
    const [inst] = inv.instalmentId ? await this.db.db.select().from(s.instalment).where(eq(s.instalment.id, inv.instalmentId)) : [];
    const due = inst ? openBalance(inst) : Math.max(0, inv.total - inv.paid);
    if (mode === 'reminder' && due <= 0) return 0; // reminders stop the moment a payment posts
    const pdf = await this.docs.invoice(invoiceId, false);
    const tpl = await this.template('fee_reminder', 'Reminder: {amount} for {name} is due {due}. Pay online: {link}');
    await this.db.tx(async (tx) => {
      const file = await this.files.storeGenerated(tx, { buffer: pdf.buffer, filename: pdf.filename, mime: 'application/pdf', purpose: 'document' });
      const attach = [{ filename: pdf.filename, fileId: file.id }];
      const groups: { ids: string[]; kind: 'student' | 'parent' }[] = [
        { ids: c.student.userId ? [c.student.userId] : [], kind: 'student' },
        { ids: c.guardians.map((g) => g.userId).filter((x): x is string => !!x), kind: 'parent' },
      ];
      for (const g of groups) {
        if (g.ids.length === 0) continue;
        const vars = { name: c.student.name, amount: formatINR(due), due: formatDate(inv.dueDate), link: this.portalLink(g.kind) };
        const wa = mode === 'reminder' ? fill(tpl, vars) : `Invoice ${inv.number} for ${c.student.name}: ${formatINR(inv.total)} due ${formatDate(inv.dueDate)}. Pay online: ${vars.link}`;
        await this.notify.notify(tx, {
          userIds: g.ids,
          category: 'fee_due',
          title: mode === 'reminder' ? `Fee reminder · ${formatINR(due)}` : `Invoice ${inv.number} · ${formatINR(inv.total)}`,
          body: `${c.student.name} · due ${formatDate(inv.dueDate)}${opts.note ? ` · ${opts.note}` : ''}`,
          link: `/${g.kind}/fees`,
          entityType,
          entityId: invoiceId,
          whatsapp: { body: wa, template: mode === 'reminder' ? 'fee_reminder' : undefined, attachments: attach },
          email: {
            subject: mode === 'reminder' ? `Fee reminder · ${c.student.name} · ${formatINR(due)} due ${formatDate(inv.dueDate)}` : `Invoice ${inv.number} · ${c.student.name}`,
            body: `${wa}\n\nThe invoice is attached.\n\n— ${c.branch.name} accounts`,
            attachments: attach,
          },
        });
      }
    });
    return users.length;
  }

  logFailure(what: string, err: unknown) {
    this.log.warn(`${what}: ${(err as Error).message}`);
  }
}
