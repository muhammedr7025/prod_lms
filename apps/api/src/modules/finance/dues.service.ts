import { Injectable, Logger } from '@nestjs/common';
import type { DuesRow } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from '@exatech/db';
import { addDays, ageingBucket, computeLateFee, daysBetween, formatDayMonth, formatINR, maskPhone, todayIST, toISTDate, type ISODate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, maybeCtx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { invalid } from '../../core/errors';
import { QueueService } from '../../core/queue.service';
import { FinanceMessages } from './finance-messages.service';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { lateFeeDue, openBalance, principalOpen } from './ledger';

export type DuesQuery = { bucket: 'all' | '0-30' | '31-60' | '61-90' | '90+'; batchId?: string; promise: 'any' | 'promised' | 'none' | 'broken' };

/**
 * Dues & follow-up: overdue lists with ageing, last reminder and promise;
 * one-click and bulk reminders (WhatsApp fee_reminder + email with the
 * invoice PDF); the daily 09:00 IST run (before/after-due reminders, late
 * fees after grace, capped), which skips holidays and paid instalments.
 */
@Injectable()
export class DuesService {
  private readonly log = new Logger('Dues');

  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly invoices: InvoicesService,
    private readonly messages: FinanceMessages,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async list(q: DuesQuery): Promise<{ items: DuesRow[]; shown: number; total: number; totalAmount: number; students: number }> {
    const today = todayIST();
    const where: (SQL | undefined)[] = [
      inBranchScope(s.instalment.branchId),
      inArray(s.enrollment.status, ['active', 'on_hold']),
      inArray(s.instalment.status, ['due', 'partially_paid']),
      sql`${s.instalment.dueDate} < ${today}`,
      sql`(${s.instalment.amount} + ${s.instalment.lateFee} - ${s.instalment.waived} - ${s.instalment.paid} - ${s.instalment.pendingPaid}) > 0`,
    ];
    const rows = await this.db.db
      .select({ inst: s.instalment, studentName: s.student.name, studentId: s.student.id, studentPhone: s.student.phone, batchId: s.batch.id, batchCode: s.batch.code })
      .from(s.instalment)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.instalment.enrollmentId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .where(and(...where))
      .orderBy(asc(s.instalment.dueDate), asc(s.student.name));
    const enrIds = [...new Set(rows.map((r) => r.inst.enrollmentId))];
    const acts = enrIds.length
      ? await this.db.db
          .select()
          .from(s.duesActivity)
          .where(and(inArray(s.duesActivity.enrollmentId, enrIds), inArray(s.duesActivity.kind, ['reminder', 'promise', 'call'])))
          .orderBy(desc(s.duesActivity.createdAt))
      : [];
    const guardians = rows.length
      ? await this.db.db
          .select({ studentId: s.studentGuardian.studentId, name: s.guardian.name, phone: s.guardian.phone })
          .from(s.studentGuardian)
          .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
          .where(inArray(s.studentGuardian.studentId, [...new Set(rows.map((r) => r.studentId))]))
      : [];
    const fin = await this.shared.settings();
    const all = rows.map((r) => {
      const i = r.inst;
      const lastRem = acts.find((a) => a.enrollmentId === i.enrollmentId && a.kind === 'reminder');
      const promises = acts.filter((a) => a.enrollmentId === i.enrollmentId && a.promiseDate);
      const promise = promises[0]?.promiseDate ?? null;
      const bucket = ageingBucket(i.dueDate, today);
      const days = daysBetween(i.dueDate, today);
      const g = guardians.find((x) => x.studentId === r.studentId);
      const overdue = principalOpen(i) + lateFeeDue(i, today, fin.lateFee);
      return {
        instalmentId: i.id,
        enrollmentId: i.enrollmentId,
        studentName: r.studentName,
        guardianLine: g ? `${g.name} · ${maskPhone(g.phone)}` : `Student · ${maskPhone(r.studentPhone)}`,
        batchId: r.batchId,
        batchCode: r.batchCode,
        instalment: `${i.label} · due ${formatDayMonth(i.dueDate)}`,
        overdue,
        bucket,
        ageLabel: `${days} d`,
        ageTag: (bucket === '0-30' ? 'outline' : bucket === '31-60' ? 'neutral' : 'ink') as DuesRow['ageTag'],
        lastReminder: lastRem ? `${lastRem.channel ?? 'WhatsApp + email'} · ${formatDayMonth(toISTDate(lastRem.createdAt))}` : '—',
        promiseDate: promise,
        remindedToday: !!lastRem && toISTDate(lastRem.createdAt) === today,
        _broken: !!promise && promise < today,
      };
    });
    const filtered = all.filter((r) => {
      if (q.bucket !== 'all' && r.bucket !== q.bucket) return false;
      if (q.batchId && r.batchId !== q.batchId) return false;
      if (q.promise === 'promised' && !(r.promiseDate && r.promiseDate >= today)) return false;
      if (q.promise === 'none' && r.promiseDate) return false;
      if (q.promise === 'broken' && !r._broken) return false;
      return true;
    });
    return {
      items: filtered.map(({ _broken, ...r }) => {
        void _broken;
        return r;
      }),
      shown: filtered.length,
      total: all.length,
      totalAmount: all.reduce((a, r) => a + r.overdue, 0),
      students: new Set(all.map((r) => r.enrollmentId)).size,
    };
  }

  /**
   * Manual reminders: log the activity now (the button flips to "Reminded"),
   * then generate the invoice PDF and send in the worker.
   */
  async remind(instalmentIds: string[], channelNote = 'WhatsApp + invoice PDF'): Promise<number> {
    const today = todayIST();
    const insts = await this.db.db.select().from(s.instalment).where(inArray(s.instalment.id, instalmentIds));
    const open = insts.filter((i) => openBalance(i) > 0 && i.status !== 'cancelled');
    if (open.length === 0) throw invalid('Nothing is due on the selected instalments — reminders stop once a payment posts');
    for (const i of open) assertInScope(i.branchId);
    const byEnrollment = new Map<string, typeof open>();
    for (const i of open) byEnrollment.set(i.enrollmentId, [...(byEnrollment.get(i.enrollmentId) ?? []), i]);
    const me = maybeCtx()?.userId ?? null;
    await this.db.tx(async (tx) => {
      for (const [enrollmentId, list] of byEnrollment) {
        for (const i of list) {
          await this.invoices.issueForInstalment(tx, i.id, { today });
        }
        await tx.insert(s.duesActivity).values({ enrollmentId, kind: 'reminder', channel: channelNote, note: list.map((i) => `${i.label} ${formatINR(openBalance(i))}`).join(', '), createdBy: me });
      }
      await this.audit.log(tx, {
        action: byEnrollment.size > 1 ? 'Reminders sent' : 'Reminder sent',
        kind: 'other',
        entityType: 'instalment',
        entityId: open.length === 1 ? open[0]!.id : null,
        entityLabel: `${byEnrollment.size} account${byEnrollment.size === 1 ? '' : 's'}`,
        summary: `${open.length} overdue instalment${open.length === 1 ? '' : 's'} · ${channelNote}`,
        branchId: open[0]!.branchId,
      });
      for (const b of new Set(open.map((i) => i.branchId))) this.shared.invalidate(tx, b);
    });
    for (const i of open) await this.queue.add('reminders', 'fee-reminder-send', { instalmentId: i.id }, { attempts: 4 });
    return byEnrollment.size;
  }

  async remindAccount(enrollmentId: string): Promise<number> {
    const insts = await this.shared.instalments(this.db.db, enrollmentId);
    const open = insts.filter((i) => openBalance(i) > 0);
    const today = todayIST();
    const target = open.filter((i) => i.dueDate <= addDays(today, 7));
    const pick = target.length ? target : open.slice(0, 1);
    if (pick.length === 0) throw invalid('Nothing is due on this account');
    return this.remind(pick.map((i) => i.id));
  }

  async remindAll(q: DuesQuery): Promise<number> {
    const list = await this.list(q);
    const pending = list.items.filter((r) => !r.remindedToday);
    if (pending.length === 0) throw invalid('Everyone in this list has already been reminded today');
    return this.remind(pending.map((r) => r.instalmentId), 'WhatsApp + invoice PDF · bulk');
  }

  /** Worker: generate the invoice PDF and send the reminder (skips if paid meanwhile). */
  async sendOne(instalmentId: string): Promise<void> {
    const [inst] = await this.db.db.select().from(s.instalment).where(eq(s.instalment.id, instalmentId));
    if (!inst || openBalance(inst) <= 0) return;
    const inv = await this.db.tx((tx) => this.invoices.issueForInstalment(tx, inst.id, { audit: false }));
    await this.messages.sendInvoice(inv.id, 'reminder', { force: true });
  }

  /**
   * Daily run (09:00 IST): late fees after grace (capped, posted as deltas so
   * re-runs are safe) and before/after-due reminders. Holidays pause
   * reminders for that branch; paid instalments are never reminded.
   */
  async runDaily(today: ISODate = todayIST()): Promise<{ reminded: number; lateFees: number; skippedHoliday: boolean }> {
    const fin = await this.shared.settings();
    const holidays = await this.db.db.select({ branchId: s.holiday.branchId }).from(s.holiday).where(eq(s.holiday.date, today));
    const allHoliday = holidays.some((h) => h.branchId === null);
    const holidayBranches = new Set(holidays.map((h) => h.branchId).filter((x): x is string => !!x));
    const open = await this.db.db
      .select({ inst: s.instalment })
      .from(s.instalment)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.instalment.enrollmentId))
      .where(and(inArray(s.enrollment.status, ['active', 'on_hold']), inArray(s.instalment.status, ['due', 'partially_paid'])));
    let lateFees = 0;
    await this.db.tx(async (tx) => {
      for (const { inst } of open) {
        if (inst.dueDate >= today || principalOpen(inst) <= 0) continue;
        const accrued = computeLateFee({ dueDate: inst.dueDate, amount: inst.amount - inst.waived, balance: principalOpen(inst) }, today, fin.lateFee);
        const delta = accrued - inst.lateFee;
        if (delta <= 0) continue;
        await tx.update(s.instalment).set({ lateFee: accrued, status: inst.paid + inst.pendingPaid > 0 ? 'partially_paid' : 'due' }).where(eq(s.instalment.id, inst.id));
        await tx.insert(s.ledgerEntry).values({
          enrollmentId: inst.enrollmentId,
          branchId: inst.branchId,
          kind: 'late_fee',
          description: `Late fee · ${inst.label} · ${daysBetween(inst.dueDate, today) - fin.lateFee.graceDays} days after grace`,
          debit: delta,
        });
        lateFees++;
      }
      if (lateFees) await this.audit.log(tx, { action: 'Late fees posted', kind: 'other', entityType: 'instalment', summary: `${lateFees} instalments · daily run ${today}` });
    });
    let reminded = 0;
    if (!allHoliday) {
      const due = new Set([...fin.reminderDaysBefore.map((d) => addDays(today, d)), ...fin.reminderDaysAfter.map((d) => addDays(today, -d))]);
      const targets = open.map((o) => o.inst).filter((i) => due.has(i.dueDate) && openBalance(i) > 0 && !holidayBranches.has(i.branchId));
      // Skip anything already reminded today (manual or a previous run).
      const enrIds = [...new Set(targets.map((t) => t.enrollmentId))];
      const done = enrIds.length
        ? await this.db.db
            .select({ enrollmentId: s.duesActivity.enrollmentId })
            .from(s.duesActivity)
            .where(and(inArray(s.duesActivity.enrollmentId, enrIds), eq(s.duesActivity.kind, 'reminder'), gte(s.duesActivity.createdAt, new Date(Date.now() - 20 * 3600_000))))
        : [];
      const skip = new Set(done.map((d) => d.enrollmentId));
      const go = targets.filter((t) => !skip.has(t.enrollmentId));
      if (go.length) {
        await this.db.tx(async (tx) => {
          for (const i of go) {
            await tx.insert(s.duesActivity).values({ enrollmentId: i.enrollmentId, kind: 'reminder', channel: 'WhatsApp + email · auto', note: `${i.label} ${i.dueDate < today ? 'overdue' : 'due'} ${formatDayMonth(i.dueDate)}` });
          }
        });
        for (const i of go) await this.queue.add('reminders', 'fee-reminder-send', { instalmentId: i.id }, { attempts: 4 });
        reminded = go.length;
      }
    }
    this.log.log(`daily run ${today}: ${lateFees} late fees, ${reminded} reminders${allHoliday ? ' (holiday — reminders paused)' : ''}`);
    return { reminded, lateFees, skippedHoliday: allHoliday };
  }
}

