import { Controller, Headers, Param, Query, Req, Res } from '@nestjs/common';
import { DOCUMENT_PATHS, FINANCE_DOCUMENT_PATHS, financeContract, paymentsContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { eq } from '@exatech/db';
import { formatDate, toISTDate } from '@exatech/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, can, ctx } from '../../core/context';
import { env } from '../../config/env';
import { Db } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { Can, Endpoint, Input, Public, type Args } from '../../core/http';
import { ScopeService } from '../../core/scope.service';
import { AccountsService } from './accounts.service';
import { DashboardService } from './dashboard.service';
import { DayBookService } from './daybook.service';
import { DeskService } from './desk.service';
import { FinanceDocuments, parseDocToken } from './documents.service';
import { DuesService } from './dues.service';
import { OnlineService } from './online.service';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import { RegistersService } from './registers.service';
import { FinanceSettingsService } from './settings.service';
import { FinanceShared } from './finance.shared';

const sendFile = (reply: FastifyReply, buffer: Buffer, filename: string, type: string) => {
  void reply.header('Content-Type', type).header('Content-Disposition', `${type === 'application/pdf' ? 'inline' : 'attachment'}; filename="${filename}"`).header('Cache-Control', 'no-store').send(buffer);
};

/* ───────────────────────── Dashboard & exports ───────────────────────── */

@Controller()
export class FinanceDashboardController {
  constructor(private readonly dash: DashboardService) {}

  @Endpoint(financeContract.dashboard)
  @Can('finance:dashboard.read')
  async dashboard() {
    return this.dash.dashboard();
  }

  @Endpoint({ method: 'GET', path: financeContract.gstSummaryPath, response: z.any() })
  @Can('finance:dashboard.read')
  async gst(@Query('month') month: string | undefined, @Res() reply: FastifyReply) {
    const r = await this.dash.gstCsv(month);
    sendFile(reply, Buffer.from(r.csv, 'utf8'), r.filename, 'text/csv; charset=utf-8');
  }

  @Endpoint({ method: 'GET', path: financeContract.tallyExportPath, response: z.any() })
  @Can('finance:dashboard.read')
  async tally(@Query('month') month: string | undefined, @Res() reply: FastifyReply) {
    const r = await this.dash.tallyCsv(month);
    sendFile(reply, Buffer.from(r.csv, 'utf8'), r.filename, 'text/csv; charset=utf-8');
  }
}

/* ───────────────────────── Collection desk ───────────────────────── */

@Controller()
export class DeskController {
  constructor(
    private readonly desk: DeskService,
    private readonly payments: PaymentsService,
    private readonly db: Db,
  ) {}

  @Endpoint(financeContract.deskSearch)
  @Can('finance:payment.collect')
  async search(@Input() { query }: Args<typeof financeContract.deskSearch>) {
    return this.desk.search(query);
  }

  @Endpoint(financeContract.deskSession)
  @Can('finance:payment.collect')
  async session(@Input() { query }: Args<typeof financeContract.deskSession>) {
    return this.desk.session(query.counter);
  }

  @Endpoint(financeContract.collect)
  @Can('finance:payment.collect')
  async collect(@Input() { body }: Args<typeof financeContract.collect>) {
    return this.desk.collect({ ...body, tenders: body.tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference ?? null })) });
  }

  @Endpoint({ method: 'GET', path: financeContract.upiQrPath, response: z.any() })
  @Can('finance:payment.collect')
  async upiQr(@Query('enrollmentId') enrollmentId: string, @Query('amount') amount: string, @Res() reply: FastifyReply) {
    if (!z.string().uuid().safeParse(enrollmentId).success) throw notFound('Fee account');
    const png = await this.desk.upiQr(enrollmentId, Number(amount));
    sendFile(reply, png, 'upi.png', 'image/png');
  }

  @Endpoint({ method: 'GET', path: financeContract.barcodePath, response: z.any() })
  @Can('finance:payment.collect', 'finance:account.read')
  async barcode(@Query('text') text: string, @Res() reply: FastifyReply) {
    sendFile(reply, await this.desk.barcode(String(text ?? '')), 'barcode.png', 'image/png');
  }

  @Endpoint(financeContract.chequeOutcome)
  @Can('finance:payment.collect')
  async cheque(@Input() { params, body }: Args<typeof financeContract.chequeOutcome>) {
    const [p] = await this.db.db.select({ branchId: s.payment.branchId }).from(s.payment).where(eq(s.payment.id, params.id));
    if (!p) throw notFound('Payment');
    const sc = branchScope();
    if (sc && !sc.includes(p.branchId)) throw forbidden('This payment is outside the selected branch');
    await this.db.tx((tx) => this.payments.chequeOutcome(tx, params.id, body.outcome, body.note));
    return { ok: true as const };
  }
}

/* ───────────────────────── Fee accounts ───────────────────────── */

@Controller()
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly dues: DuesService,
    private readonly online: OnlineService,
    private readonly shared: FinanceShared,
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Endpoint(financeContract.accounts)
  @Can('finance:account.read')
  async list(@Input() { query }: Args<typeof financeContract.accounts>) {
    return this.accounts.list(query);
  }

  @Endpoint(financeContract.account)
  @Can('finance:account.read', 'finance:payment.collect')
  async account(@Input() { params }: Args<typeof financeContract.account>) {
    if (!z.string().uuid().safeParse(params.enrollmentId).success) throw notFound('Fee account');
    return this.accounts.account(params.enrollmentId);
  }

  @Endpoint(financeContract.grantExemption)
  @Can('finance:exemption.grant')
  async exemption(@Input() { params, body }: Args<typeof financeContract.grantExemption>) {
    await this.accounts.grantExemption(params.enrollmentId, body.until, body.reason);
    return { ok: true as const };
  }

  @Endpoint(financeContract.restructure)
  @Can('finance:restructure')
  async restructure(@Input() { params, body }: Args<typeof financeContract.restructure>) {
    return this.accounts.restructure(params.enrollmentId, body.rows, body.reason);
  }

  @Endpoint(financeContract.remindAccount)
  @Can('finance:dues.manage')
  async remind(@Input() { params }: Args<typeof financeContract.remindAccount>) {
    return { sent: await this.dues.remindAccount(params.enrollmentId) };
  }

  @Endpoint(financeContract.logCall)
  @Can('finance:dues.manage')
  async call(@Input() { params, body }: Args<typeof financeContract.logCall>) {
    await this.accounts.logCall(params.enrollmentId, body.outcome, body.promiseDate ?? null);
    return { ok: true as const };
  }

  @Endpoint(financeContract.paymentLink)
  @Can('finance:dues.manage')
  async paymentLink(@Input() { params }: Args<typeof financeContract.paymentLink>) {
    const c = ctx();
    const ec = await this.shared.enrollmentCtx(this.db.db, params.enrollmentId);
    const sc = branchScope();
    if (sc && !sc.includes(ec.branch.id)) throw forbidden('This account is outside the selected branch');
    const g = ec.guardians.find((x) => x.userId) ?? null;
    const order = await this.online.create({
      enrollmentId: ec.enrollment.id,
      studentId: ec.student.id,
      purpose: 'next_due',
      createdBy: c.userId,
      payer: { name: g?.name ?? ec.student.name, email: g?.email ?? ec.student.email, contact: g?.phone ?? ec.student.phone },
    });
    const url = `${env().WEB_ORIGIN}${order.sandboxUrl ?? `/pay/${order.orderId}`}`;
    await this.db.tx(async (tx) => {
      await tx.insert(s.duesActivity).values({ enrollmentId: ec.enrollment.id, kind: 'payment_link', note: order.description, createdBy: c.userId });
      await this.audit.log(tx, { action: 'Payment link created', kind: 'create', entityType: 'enrollment_fee', entityId: ec.enrollment.id, entityLabel: ec.student.name, summary: `${order.description} · ${order.gateway}`, branchId: ec.branch.id });
      this.shared.invalidate(tx, ec.branch.id);
    });
    return { url, amount: order.amount, description: order.description };
  }

  @Endpoint(financeContract.requestRefund)
  @Can('finance:payment.collect', 'finance:approve')
  async refund(@Input() { params, body }: Args<typeof financeContract.requestRefund>) {
    return this.accounts.requestRefund(params.enrollmentId, body.amount, body.reason);
  }
}

/* ───────────────────────── Invoices, receipts, credit notes ───────────────────────── */

@Controller()
export class RegistersController {
  constructor(private readonly reg: RegistersService) {}

  @Endpoint(financeContract.invoices)
  @Can('finance:invoices.manage')
  async invoices(@Input() { query }: Args<typeof financeContract.invoices>) {
    return this.reg.listInvoices(query);
  }

  @Endpoint(financeContract.receipts)
  @Can('finance:invoices.manage')
  async receipts(@Input() { query }: Args<typeof financeContract.receipts>) {
    return this.reg.listReceipts(query);
  }

  @Endpoint(financeContract.creditNotes)
  @Can('finance:invoices.manage')
  async creditNotes(@Input() { query }: Args<typeof financeContract.creditNotes>) {
    return this.reg.listCreditNotes(query);
  }

  @Endpoint(financeContract.cancelInvoice)
  @Can('finance:invoices.manage')
  async cancel(@Input() { params, body }: Args<typeof financeContract.cancelInvoice>) {
    return this.reg.cancelInvoice(params.id, body.reason);
  }

  @Endpoint(financeContract.reprintInvoice)
  @Can('finance:invoices.manage')
  async reprintInvoice(@Input() { params }: Args<typeof financeContract.reprintInvoice>) {
    return this.reg.reprintInvoice(params.id);
  }

  @Endpoint(financeContract.reprintReceipt)
  @Can('finance:invoices.manage', 'finance:payment.collect')
  async reprintReceipt(@Input() { params, body }: Args<typeof financeContract.reprintReceipt>) {
    return this.reg.reprintReceipt(params.id, body.format);
  }

  @Endpoint(financeContract.resendReceipt)
  @Can('finance:invoices.manage', 'finance:payment.collect')
  async resend(@Input() { params }: Args<typeof financeContract.resendReceipt>) {
    return this.reg.resendReceipt(params.id);
  }

  @Endpoint(financeContract.voidReceipt)
  @Can('finance:void')
  async void(@Input() { params, body }: Args<typeof financeContract.voidReceipt>) {
    return this.reg.voidReceipt(params.id, body.reason);
  }

  @Endpoint(financeContract.bulkPreview)
  @Can('finance:invoices.manage')
  async bulkPreview(@Input() { query }: Args<typeof financeContract.bulkPreview>) {
    return this.reg.bulkPreview(query.batchId, query.withinDays);
  }

  @Endpoint(financeContract.bulkGenerate)
  @Can('finance:invoices.manage')
  async bulk(@Input() { body }: Args<typeof financeContract.bulkGenerate>) {
    return this.reg.bulkGenerate(body.batchId, body.withinDays);
  }

  @Endpoint(financeContract.batches)
  @Can('finance:invoices.manage', 'finance:dues.manage', 'finance:account.read')
  async batches() {
    return this.reg.batches();
  }
}

/* ───────────────────────── Dues ───────────────────────── */

@Controller()
export class DuesController {
  constructor(private readonly dues: DuesService) {}

  @Endpoint(financeContract.dues)
  @Can('finance:dues.manage')
  async list(@Input() { query }: Args<typeof financeContract.dues>) {
    return this.dues.list(query);
  }

  @Endpoint(financeContract.remind)
  @Can('finance:dues.manage')
  async remind(@Input() { body }: Args<typeof financeContract.remind>) {
    return { sent: await this.dues.remind(body.instalmentIds) };
  }

  @Endpoint(financeContract.remindAll)
  @Can('finance:dues.manage')
  async remindAll(@Input() { body }: Args<typeof financeContract.remindAll>) {
    return { sent: await this.dues.remindAll(body) };
  }

  /** Runs the daily reminder / late-fee job now (ops). */
  @Endpoint(financeContract.runReminders)
  @Can('finance:settings.manage')
  async run() {
    return this.dues.runDaily();
  }
}

/* ───────────────────────── Day book ───────────────────────── */

@Controller()
export class DayBookController {
  constructor(private readonly book: DayBookService) {}

  @Endpoint(financeContract.dayBook)
  @Can('finance:daybook.manage')
  async dayBook(@Input() { query }: Args<typeof financeContract.dayBook>) {
    return this.book.dayBook(query);
  }

  @Endpoint(financeContract.closeCounter)
  @Can('finance:daybook.manage')
  async close(@Input() { body }: Args<typeof financeContract.closeCounter>) {
    return this.book.close(body);
  }

  @Endpoint(financeContract.lockPeriod)
  @Can('finance:daybook.manage')
  async lock(@Input() { body }: Args<typeof financeContract.lockPeriod>) {
    await this.book.lockPeriod(body.branchId, body.month);
    return { ok: true as const };
  }
}

/* ───────────────────────── Reconciliation ───────────────────────── */

@Controller()
export class ReconciliationController {
  constructor(private readonly rec: ReconciliationService) {}

  @Endpoint(financeContract.reconciliation)
  @Can('finance:reconcile')
  async view(@Input() { query }: Args<typeof financeContract.reconciliation>) {
    return this.rec.view(query.settlementId);
  }

  @Endpoint(financeContract.uploadSettlement)
  @Can('finance:reconcile')
  async upload(@Input() { body }: Args<typeof financeContract.uploadSettlement>) {
    return this.rec.upload(body.fileId, body.gateway);
  }

  @Endpoint(financeContract.autoMatch)
  @Can('finance:reconcile')
  async autoMatch(@Input() { params }: Args<typeof financeContract.autoMatch>) {
    return this.rec.autoMatch(params.settlementId);
  }

  @Endpoint(financeContract.recordAdvance)
  @Can('finance:reconcile')
  async advance(@Input() { params, body }: Args<typeof financeContract.recordAdvance>) {
    return this.rec.recordAdvance(params.itemId, body.enrollmentId);
  }

  @Endpoint(financeContract.resolveItem)
  @Can('finance:reconcile')
  async resolve(@Input() { params, body }: Args<typeof financeContract.resolveItem>) {
    await this.rec.resolve(params.itemId, body.note);
    return { ok: true as const };
  }
}

/* ───────────────────────── Settings ───────────────────────── */

@Controller()
export class FinanceSettingsController {
  constructor(private readonly settings: FinanceSettingsService) {}

  @Endpoint(financeContract.settings)
  @Can('finance:settings.manage')
  async get() {
    return this.settings.get();
  }

  @Endpoint(financeContract.saveSettings)
  @Can('finance:settings.manage')
  async save(@Input() { body }: Args<typeof financeContract.saveSettings>) {
    return this.settings.save(body);
  }
}

/* ───────────────────────── Online payments (portal) + webhooks ───────────────────────── */

@Controller()
export class PortalPaymentsController {
  constructor(private readonly online: OnlineService) {}

  @Endpoint(paymentsContract.createOrder)
  @Can('portal:student', 'portal:parent')
  async createOrder(@Input() { body }: Args<typeof paymentsContract.createOrder>) {
    return this.online.createForPortal(body);
  }

  @Endpoint(paymentsContract.orderStatus)
  @Can('portal:student', 'portal:parent')
  async status(@Input() { params }: Args<typeof paymentsContract.orderStatus>) {
    await this.online.portalOrder(params.orderId);
    return this.online.status(params.orderId);
  }

  @Endpoint(financeContract.orderCheckout)
  @Can('portal:student', 'portal:parent')
  async checkout(@Input() { params }: Args<typeof financeContract.orderCheckout>) {
    return this.online.checkout(params.orderId);
  }

  @Endpoint(paymentsContract.sandboxComplete)
  @Can('portal:student', 'portal:parent')
  async sandbox(@Input() { params, body }: Args<typeof paymentsContract.sandboxComplete>) {
    return this.online.sandboxComplete(params.orderId, body.outcome, body.method);
  }

  @Endpoint(paymentsContract.razorpayVerify)
  @Can('portal:student', 'portal:parent')
  async razorpay(@Input() { params, body }: Args<typeof paymentsContract.razorpayVerify>) {
    return this.online.razorpayVerify(params.orderId, body);
  }

  @Endpoint({ method: 'POST', path: paymentsContract.razorpayWebhookPath, response: z.any() })
  @Public()
  async razorpayWebhook(@Req() req: FastifyRequest & { rawBody?: string }, @Headers() headers: Record<string, string>) {
    return this.online.webhook('razorpay', req.rawBody ?? JSON.stringify(req.body ?? {}), headers);
  }

  @Endpoint({ method: 'POST', path: paymentsContract.sandboxWebhookPath, response: z.any() })
  @Public()
  async sandboxWebhook(@Req() req: FastifyRequest & { rawBody?: string }, @Headers() headers: Record<string, string>) {
    return this.online.webhook('sandbox', req.rawBody ?? JSON.stringify(req.body ?? {}), headers);
  }
}

/* ───────────────────────── Documents (PDF) + public verification ───────────────────────── */

const FORMATS = ['A4', 'A5', '80mm'] as const;

@Controller()
export class FinanceDocumentsController {
  constructor(
    private readonly docs: FinanceDocuments,
    private readonly scope: ScopeService,
    private readonly db: Db,
    private readonly shared: FinanceShared,
  ) {}

  /** Staff with finance:account.read (branch scope) or the student / parent who owns the enrollment. */
  private async authorize(enrollmentId: string, branchId: string) {
    if (can('finance:account.read') || can('finance:invoices.manage') || can('finance:payment.collect')) {
      const sc = branchScope();
      if (sc && !sc.includes(branchId)) throw forbidden('This document belongs to a branch outside the selected one');
      return;
    }
    const c = ctx();
    const [e] = await this.db.db.select({ studentId: s.enrollment.studentId }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
    const mine = c.roleKey === 'parent' ? await this.scope.parentChildren() : c.roleKey === 'student' ? await this.scope.studentEnrollments() : [];
    if (!e || !mine.some((m) => m.studentId === e.studentId)) throw forbidden('This document belongs to another account');
  }

  private uuid(id: string, what: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound(what);
  }

  @Endpoint({ method: 'GET', path: DOCUMENT_PATHS.invoice(':id'), response: z.any() })
  @Can('finance:account.read', 'finance:invoices.manage', 'finance:payment.collect', 'portal:student', 'portal:parent')
  async invoice(@Param('id') id: string, @Query('copy') copy: string | undefined, @Res() reply: FastifyReply) {
    this.uuid(id, 'Invoice');
    const [inv] = await this.db.db.select({ enrollmentId: s.invoice.enrollmentId, branchId: s.invoice.branchId }).from(s.invoice).where(eq(s.invoice.id, id));
    if (!inv) throw notFound('Invoice');
    await this.authorize(inv.enrollmentId, inv.branchId);
    const pdf = await this.docs.invoice(id, copy === 'duplicate');
    sendFile(reply, pdf.buffer, pdf.filename, 'application/pdf');
  }

  @Endpoint({ method: 'GET', path: DOCUMENT_PATHS.receipt(':id'), response: z.any() })
  @Can('finance:account.read', 'finance:invoices.manage', 'finance:payment.collect', 'portal:student', 'portal:parent')
  async receipt(@Param('id') id: string, @Query('format') format: string | undefined, @Query('copy') copy: string | undefined, @Res() reply: FastifyReply) {
    this.uuid(id, 'Receipt');
    const fmt = (FORMATS as readonly string[]).includes(format ?? 'A4') ? ((format ?? 'A4') as (typeof FORMATS)[number]) : null;
    if (!fmt) throw invalid('Format must be A4, A5 or 80mm');
    const [r] = await this.db.db
      .select({ enrollmentId: s.payment.enrollmentId, branchId: s.receipt.branchId })
      .from(s.receipt)
      .innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId))
      .where(eq(s.receipt.id, id));
    if (!r) throw notFound('Receipt');
    await this.authorize(r.enrollmentId, r.branchId);
    const pdf = await this.docs.receipt(id, fmt, copy === 'duplicate');
    sendFile(reply, pdf.buffer, pdf.filename, 'application/pdf');
  }

  @Endpoint({ method: 'GET', path: FINANCE_DOCUMENT_PATHS.creditNote(':id'), response: z.any() })
  @Can('finance:account.read', 'finance:invoices.manage', 'portal:student', 'portal:parent')
  async creditNote(@Param('id') id: string, @Res() reply: FastifyReply) {
    this.uuid(id, 'Credit note');
    const [cn] = await this.db.db.select({ enrollmentId: s.creditNote.enrollmentId, branchId: s.creditNote.branchId }).from(s.creditNote).where(eq(s.creditNote.id, id));
    if (!cn) throw notFound('Credit note');
    await this.authorize(cn.enrollmentId, cn.branchId);
    const pdf = await this.docs.creditNote(id);
    sendFile(reply, pdf.buffer, pdf.filename, 'application/pdf');
  }

  @Endpoint({ method: 'GET', path: DOCUMENT_PATHS.statement(':enrollmentId'), response: z.any() })
  @Can('finance:account.read', 'finance:payment.collect', 'portal:student', 'portal:parent')
  async statement(@Param('enrollmentId') enrollmentId: string, @Res() reply: FastifyReply) {
    this.uuid(enrollmentId, 'Fee account');
    const [e] = await this.db.db.select({ branchId: s.enrollment.branchId }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
    if (!e) throw notFound('Fee account');
    await this.authorize(enrollmentId, e.branchId);
    const pdf = await this.docs.statement(enrollmentId);
    sendFile(reply, pdf.buffer, pdf.filename, 'application/pdf');
  }

  /** Public receipt / invoice / credit-note verification behind the document QR. */
  @Endpoint(financeContract.verify)
  @Public()
  async verify(@Param('token') token: string) {
    const inst = await this.shared.institution();
    const mask = (name: string) => {
      const [first, ...rest] = name.split(/\s+/);
      return `${first ?? ''}${rest.length ? ` ${rest[rest.length - 1]![0]}.` : ''}`;
    };
    const doc = parseDocToken(token);
    if (doc?.kind === 'i') {
      const [row] = await this.db.db
        .select({ inv: s.invoice, branch: s.branch.name, student: s.student.name })
        .from(s.invoice)
        .innerJoin(s.branch, eq(s.branch.id, s.invoice.branchId))
        .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
        .where(eq(s.invoice.id, doc.id));
      if (!row) throw notFound('Document');
      const cancelled = row.inv.status === 'cancelled';
      return { kind: 'invoice' as const, title: 'Tax invoice', number: row.inv.number, amount: row.inv.total, date: row.inv.issueDate, branch: row.branch, institution: inst.name, student: mask(row.student), status: cancelled ? ('cancelled' as const) : ('valid' as const), statusLabel: cancelled ? 'Cancelled — replaced by a credit note' : `Valid · due ${formatDate(row.inv.dueDate)}`, issuedAt: row.inv.createdAt };
    }
    if (doc?.kind === 'c') {
      const [row] = await this.db.db
        .select({ cn: s.creditNote, branch: s.branch.name, student: s.student.name })
        .from(s.creditNote)
        .innerJoin(s.branch, eq(s.branch.id, s.creditNote.branchId))
        .innerJoin(s.enrollment, eq(s.enrollment.id, s.creditNote.enrollmentId))
        .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
        .where(eq(s.creditNote.id, doc.id));
      if (!row) throw notFound('Document');
      return { kind: 'credit_note' as const, title: 'Credit note', number: row.cn.number, amount: row.cn.amount, date: toISTDate(row.cn.createdAt), branch: row.branch, institution: inst.name, student: mask(row.student), status: 'valid' as const, statusLabel: 'Valid', issuedAt: row.cn.createdAt };
    }
    if (!/^[\w-]{16,64}$/.test(token)) throw notFound('Receipt');
    const [row] = await this.db.db
      .select({ r: s.receipt, p: s.payment, branch: s.branch.name, student: s.student.name })
      .from(s.receipt)
      .innerJoin(s.payment, eq(s.payment.id, s.receipt.paymentId))
      .innerJoin(s.branch, eq(s.branch.id, s.receipt.branchId))
      .innerJoin(s.student, eq(s.student.id, s.payment.studentId))
      .where(eq(s.receipt.verifyToken, token));
    if (!row) throw notFound('Receipt');
    const status = row.r.voided ? ('voided' as const) : row.p.status === 'bounced' ? ('bounced' as const) : row.p.status === 'pending_clearance' ? ('pending_clearance' as const) : ('valid' as const);
    const label = { voided: `Voided${row.r.voidedAt ? ` on ${formatDate(toISTDate(row.r.voidedAt))}` : ''} — this receipt is no longer valid`, bounced: 'Cheque bounced — this receipt is not valid', pending_clearance: 'Valid · cheque pending clearance', valid: 'Valid · payment received' }[status];
    return { kind: 'receipt' as const, title: 'Receipt', number: row.r.number, amount: row.p.total, date: toISTDate(row.r.issuedAt), branch: row.branch, institution: inst.name, student: mask(row.student), status, statusLabel: label, issuedAt: row.r.issuedAt };
  }
}
