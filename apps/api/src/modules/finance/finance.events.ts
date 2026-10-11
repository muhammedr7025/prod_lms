import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { DomainEvents } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, sql, type Tx } from '@exatech/db';
import { buildSchedule, formatINR, todayIST } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { EventBus } from '../../core/events/event-bus';
import { QueueService } from '../../core/queue.service';
import { AccountsService, type RestructureRow } from './accounts.service';
import { DuesService } from './dues.service';
import { FinanceMessages } from './finance-messages.service';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { OnlineService } from './online.service';
import { PaymentsService } from './payments.service';

/**
 * Finance's event handlers and jobs:
 *  - AdmissionApproved → instalment schedule, invoice 1, clearance (in-tx);
 *    first invoice PDF by WhatsApp + email (worker)
 *  - BatchTransferred → fee account follows the student, pro-rated adjustment
 *  - ApprovalDecided → locked-period voids, refunds, restructures, exemptions, voids, waivers
 *  - PaymentRecorded → receipt PDF to student + guardians (worker)
 *  - reminders queue: daily 09:00 IST run + per-instalment sends; maintenance: webhook retries
 */
@Injectable()
export class FinanceEvents implements OnModuleInit {
  private readonly log = new Logger('FinanceEvents');

  constructor(
    private readonly events: EventBus,
    private readonly queue: QueueService,
    private readonly shared: FinanceShared,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly accounts: AccountsService,
    private readonly dues: DuesService,
    private readonly messages: FinanceMessages,
    private readonly online: OnlineService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.events.onTx('AdmissionApproved', (tx, p) => this.onAdmissionApproved(tx, p), 'finance-schedule');
    this.events.onAsync('AdmissionApproved', 'send-first-invoice', (p) => this.sendFirstInvoice(p));
    this.events.onTx('BatchTransferred', (tx, p) => this.onBatchTransferred(tx, p), 'finance-transfer');
    this.events.onTx('ApprovalDecided', (tx, p) => this.onApprovalDecided(tx, p), 'finance-approvals');
    this.events.onAsync('PaymentRecorded', 'send-receipt', async (p) => {
      if (p.receiptId) await this.messages.sendReceipt(p.receiptId);
    });

    this.queue.process(
      'reminders',
      async (job) => {
        if (job.name === 'fee-reminders-daily') return this.dues.runDaily();
        if (job.name === 'fee-reminder-send') return this.dues.sendOne((job.data as { instalmentId: string }).instalmentId);
        return undefined;
      },
      2,
      ['fee-reminders-daily', 'fee-reminder-send'],
    );
    this.queue.process('maintenance', async () => this.online.retryFailed(), 1, ['finance-retry-webhooks']);
    // Repeatable jobs (idempotent upserts keyed by the repeat pattern).
    void this.queue
      .add('reminders', 'fee-reminders-daily', {}, { repeat: { pattern: '0 9 * * *', tz: 'Asia/Kolkata' }, jobId: 'fee-reminders-daily', attempts: 2 })
      .catch((err: Error) => this.log.warn(`could not schedule daily reminders: ${err.message}`));
    void this.queue
      .add('maintenance', 'finance-retry-webhooks', {}, { repeat: { every: 15 * 60_000 }, jobId: 'finance-retry-webhooks', attempts: 1 })
      .catch((err: Error) => this.log.warn(`could not schedule webhook retries: ${err.message}`));
  }

  /* ───────────────────────── Admission approved ───────────────────────── */

  private async onAdmissionApproved(tx: Tx, p: DomainEvents['AdmissionApproved']): Promise<void> {
    const existing = await tx.select({ id: s.instalment.id }).from(s.instalment).where(eq(s.instalment.enrollmentId, p.enrollmentId)).limit(1);
    if (existing.length) return;
    const [enr] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, p.enrollmentId));
    const [plan] = await tx.select().from(s.feePlan).where(eq(s.feePlan.id, p.feePlanId));
    const [batch] = await tx.select({ startDate: s.batch.startDate }).from(s.batch).where(eq(s.batch.id, p.batchId));
    if (!enr || !plan || !batch || enr.feeTotal <= 0) return;
    const start = enr.joinedOn > batch.startDate ? enr.joinedOn : batch.startDate;
    const drafts = buildSchedule(enr.feeTotal, plan.schedule, start);
    const rows = await tx
      .insert(s.instalment)
      .values(drafts.map((d) => ({ enrollmentId: enr.id, branchId: p.branchId, seq: d.seq, label: d.label, dueDate: d.dueDate, amount: d.amount, revision: 1 })))
      .returning();
    const first = rows.sort((a, b) => a.seq - b.seq)[0]!;
    const inv = await this.invoices.issueForInstalment(tx, first.id, { createdBy: p.actorUserId, today: todayIST() });
    await this.audit.log(tx, {
      action: 'Fee schedule created',
      kind: 'create',
      entityType: 'instalment',
      entityId: enr.id,
      entityLabel: p.admissionNo,
      after: { instalments: drafts.map((d) => ({ due: d.dueDate, amount: d.amount })) },
      summary: `${plan.name} · ${drafts.length} instalment${drafts.length === 1 ? '' : 's'} · ${formatINR(enr.feeTotal)} · invoice ${inv.number}`,
      branchId: p.branchId,
    });
    await this.shared.recomputeClearance(tx, enr.id);
    this.shared.invalidate(tx, p.branchId, [p.studentUserId, ...p.guardianUserIds].filter((x): x is string => !!x));
  }

  private async sendFirstInvoice(p: DomainEvents['AdmissionApproved']): Promise<void> {
    const db = this.shared.db.db;
    const [inv] = await db
      .select({ id: s.invoice.id })
      .from(s.invoice)
      .innerJoin(s.instalment, eq(s.instalment.id, s.invoice.instalmentId))
      .where(and(eq(s.invoice.enrollmentId, p.enrollmentId), sql`${s.invoice.status} <> 'cancelled'`))
      .orderBy(asc(s.instalment.seq))
      .limit(1);
    if (inv) await this.messages.sendInvoice(inv.id, 'first');
  }

  /* ───────────────────────── Batch transfer ───────────────────────── */

  /**
   * The fee account follows the student: instalments, invoices, payments and
   * follow-ups move to the new enrollment (the append-only ledger is read
   * across the transfer chain). The pro-rated adjustment becomes a new
   * invoiced instalment (owes more) or a credit (owes less).
   */
  private async onBatchTransferred(tx: Tx, p: DomainEvents['BatchTransferred']): Promise<void> {
    const [from] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, p.fromEnrollmentId));
    const [to] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, p.toEnrollmentId));
    if (!from || !to) return;
    const today = todayIST();
    const moved = await tx.select().from(s.instalment).where(eq(s.instalment.enrollmentId, from.id));
    if (moved.length) {
      await tx.insert(s.scheduleRevision).values({
        enrollmentId: to.id,
        revision: moved.reduce((m, i) => Math.max(m, i.revision), 1),
        rows: moved.map((i) => ({ seq: i.seq, label: i.label, dueDate: i.dueDate, amount: i.amount, paid: i.paid })),
        reason: `Batch transfer${p.adjustment ? ` · adjustment ${formatINR(p.adjustment)}` : ''}`,
      });
    }
    await tx.update(s.instalment).set({ enrollmentId: to.id, branchId: to.branchId }).where(eq(s.instalment.enrollmentId, from.id));
    await tx.update(s.invoice).set({ enrollmentId: to.id }).where(eq(s.invoice.enrollmentId, from.id));
    await tx.update(s.payment).set({ enrollmentId: to.id }).where(eq(s.payment.enrollmentId, from.id));
    await tx.update(s.creditNote).set({ enrollmentId: to.id }).where(eq(s.creditNote.enrollmentId, from.id));
    await tx.update(s.duesActivity).set({ enrollmentId: to.id }).where(eq(s.duesActivity.enrollmentId, from.id));
    await tx.update(s.gatewayOrder).set({ enrollmentId: to.id }).where(eq(s.gatewayOrder.enrollmentId, from.id));
    await tx.update(s.enrollment).set({ creditBalance: from.creditBalance }).where(eq(s.enrollment.id, to.id));
    await tx.update(s.enrollment).set({ creditBalance: 0 }).where(eq(s.enrollment.id, from.id));

    if (p.adjustment > 0) {
      const maxSeq = moved.reduce((m, i) => Math.max(m, i.seq), 0);
      const [inst] = await tx
        .insert(s.instalment)
        .values({ enrollmentId: to.id, branchId: to.branchId, seq: maxSeq + 1, label: 'Transfer adjustment', dueDate: to.joinedOn > today ? to.joinedOn : today, amount: p.adjustment, revision: moved.reduce((m, i) => Math.max(m, i.revision), 1) })
        .returning();
      await this.invoices.issueForInstalment(tx, inst!.id, { ledgerKind: 'adjustment' });
      await tx.update(s.enrollment).set({ feeTotal: to.feeTotal + p.adjustment }).where(eq(s.enrollment.id, to.id));
    } else if (p.adjustment < 0) {
      const credit = -p.adjustment;
      await tx.update(s.enrollment).set({ creditBalance: sql`${s.enrollment.creditBalance} + ${credit}`, feeTotal: Math.max(0, to.feeTotal - credit) }).where(eq(s.enrollment.id, to.id));
      await tx.insert(s.ledgerEntry).values({ enrollmentId: to.id, branchId: to.branchId, kind: 'adjustment', description: 'Transfer adjustment · pro-rated credit', credit });
    }
    await this.shared.recomputeClearance(tx, to.id);
    await this.audit.log(tx, {
      action: 'Fee account transferred',
      kind: 'update',
      entityType: 'enrollment_fee',
      entityId: to.id,
      summary: `${moved.length} instalments moved${p.adjustment ? ` · adjustment ${formatINR(p.adjustment)}` : ''}`,
      branchId: to.branchId,
    });
    this.shared.invalidate(tx, to.branchId);
    if (from.branchId !== to.branchId) this.shared.invalidate(tx, from.branchId);
  }

  /* ───────────────────────── Approvals ───────────────────────── */

  private async onApprovalDecided(tx: Tx, p: DomainEvents['ApprovalDecided']): Promise<void> {
    if (!['locked_period', 'refund', 'restructure', 'exemption', 'void', 'waiver'].includes(p.kind)) return;
    if (p.status !== 'approved') return; // denied / returned: nothing to apply (the decision is logged by the queue)
    const [a] = await tx.select().from(s.approvalRequest).where(eq(s.approvalRequest.id, p.approvalId));
    if (!a) return;
    const payload = a.payload as Record<string, unknown>;
    switch (a.kind) {
      case 'locked_period':
      case 'void': {
        if (a.entityType !== 'payment') return;
        const [pay] = await tx.select({ status: s.payment.status }).from(s.payment).where(eq(s.payment.id, a.entityId));
        if (!pay || pay.status === 'voided') return;
        // Period reopened for this one entry: the requested void is performed under the approval.
        await this.payments.voidPayment(tx, a.entityId, String(payload.reason ?? 'Approved void'), { bypassLock: true });
        if (a.kind === 'locked_period' && a.branchId) {
          await this.audit.log(tx, { action: 'Locked period entry', kind: 'approve', entityType: 'payment', entityId: a.entityId, entityLabel: a.title, summary: `Period reopened for one entry · ${String(payload.reason ?? '')}`, branchId: a.branchId });
        }
        return;
      }
      case 'refund':
        await this.accounts.applyRefund(tx, a.entityId, a.amount ?? 0, String(payload.reason ?? 'Refund'));
        return;
      case 'restructure':
        await this.accounts.applyRestructure(tx, a.entityId, (payload.rows as RestructureRow[]) ?? [], String(payload.reason ?? 'Restructure'), { requestedBy: a.requestedBy, approvedBy: a.decidedBy });
        return;
      case 'exemption':
        await this.accounts.applyExemption(tx, a.entityId, String(payload.until), String(payload.reason ?? 'Exemption'));
        return;
      case 'waiver':
        await this.accounts.applyWaiver(tx, String(payload.instalmentId ?? a.entityId), Number(payload.amount ?? a.amount ?? 0), String(payload.reason ?? 'Waiver'));
        return;
    }
  }
}
