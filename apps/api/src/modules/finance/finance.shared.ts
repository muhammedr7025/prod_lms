import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, ne, sql, type DbOrTx, type FinanceSettings, type InstitutionSettings, type Tx } from '@exatech/db';
import {
  computeClearance,
  DEFAULT_LATE_FEE,
  DEFAULT_MIN_PARTIAL,
  DEFAULT_PATTERNS,
  financialYear,
  formatDayMonth,
  formatNumber,
  maskPhone,
  monthName,
  monthStart,
  toISTTime,
  todayIST,
  type ClearancePolicy,
  type ISODate,
} from '@exatech/domain';
import { afterCommit, Db } from '../../core/db';
import { invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { NumberingService } from '../../core/numbering.service';
import { RedisService } from '../../core/redis';
import { isActive, type InstalmentLike } from './ledger';

/** InstitutionSettings.finance plus the keys Finance adds to the same jsonb (UPI VPA). */
export type FinSettings = FinanceSettings & { upiVpa: string | null };

export function withDefaults(f: Partial<FinanceSettings> & { upiVpa?: string | null } | undefined): FinSettings {
  return {
    numbering: { invoice: f?.numbering?.invoice || DEFAULT_PATTERNS.invoice, receipt: f?.numbering?.receipt || DEFAULT_PATTERNS.receipt, credit_note: f?.numbering?.credit_note || DEFAULT_PATTERNS.credit_note },
    gstRate: f?.gstRate ?? 18,
    sac: f?.sac ?? '999293',
    lateFee: f?.lateFee ?? DEFAULT_LATE_FEE,
    minPartial: f?.minPartial ?? DEFAULT_MIN_PARTIAL,
    restructureApprovalAbove: f?.restructureApprovalAbove ?? 10_000_00,
    allocationOrder: f?.allocationOrder ?? 'oldest_first',
    methods: f?.methods ?? { upi: true, cash: true, card: true, cheque: true, transfer: true, online: true },
    chequeUnlocksAfterClearance: f?.chequeUnlocksAfterClearance ?? true,
    reminderDaysBefore: f?.reminderDaysBefore ?? [3],
    reminderDaysAfter: f?.reminderDaysAfter ?? [1, 4, 8],
    upiVpa: f?.upiVpa ?? null,
  };
}

export interface EnrollmentCtx {
  enrollment: typeof s.enrollment.$inferSelect;
  student: typeof s.student.$inferSelect;
  batch: { id: string; code: string; startDate: string; courseId: string };
  course: { id: string; code: string; name: string; clearancePolicy: ClearancePolicy | null };
  branch: { id: string; code: string; name: string; address: string | null; city: string | null; phone: string | null; gstin: string | null };
  guardians: { name: string; phone: string | null; email: string | null; userId: string | null; relationship: string }[];
}

export type InstalmentRowDb = typeof s.instalment.$inferSelect;

/**
 * Shared Finance plumbing: settings, enrollment context, clearance recompute,
 * period locks, gap-free document numbers, cache versioning.
 */
@Injectable()
export class FinanceShared {
  constructor(
    readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly redis: RedisService,
  ) {}

  async institution(tx: DbOrTx = this.db.db): Promise<{ id: string; name: string; legalName: string | null; gstin: string | null; settings: InstitutionSettings; fin: FinSettings }> {
    const [inst] = await tx.select().from(s.institution).limit(1);
    if (!inst) throw notFound('Institution');
    return { id: inst.id, name: inst.name, legalName: inst.legalName, gstin: inst.gstin, settings: inst.settings, fin: withDefaults(inst.settings.finance as FinSettings) };
  }

  async settings(tx: DbOrTx = this.db.db): Promise<FinSettings> {
    return (await this.institution(tx)).fin;
  }

  async enrollmentCtx(tx: DbOrTx, enrollmentId: string): Promise<EnrollmentCtx> {
    const [row] = await tx
      .select({ enrollment: s.enrollment, student: s.student, batch: { id: s.batch.id, code: s.batch.code, startDate: s.batch.startDate, courseId: s.batch.courseId }, course: { id: s.course.id, code: s.course.code, name: s.course.name, clearancePolicy: s.course.clearancePolicy }, branch: { id: s.branch.id, code: s.branch.code, name: s.branch.name, address: s.branch.address, city: s.branch.city, phone: s.branch.phone, gstin: s.branch.gstin } })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .innerJoin(s.branch, eq(s.branch.id, s.enrollment.branchId))
      .where(eq(s.enrollment.id, enrollmentId));
    if (!row) throw notFound('Fee account');
    const guardians = await tx
      .select({ name: s.guardian.name, phone: s.guardian.phone, email: s.guardian.email, userId: s.guardian.userId, relationship: s.studentGuardian.relationship })
      .from(s.studentGuardian)
      .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
      .where(eq(s.studentGuardian.studentId, row.student.id))
      .orderBy(sql`${s.studentGuardian.isPrimary} desc`);
    return { ...row, guardians };
  }

  guardianLine(c: Pick<EnrollmentCtx, 'guardians' | 'student'>): string {
    const g = c.guardians[0];
    if (g) return `Guardian ${g.name} · ${maskPhone(g.phone)}`;
    return `Student · ${maskPhone(c.student.phone)}`;
  }

  /** Portal users (student + guardians) for notifications and realtime. */
  portalUserIds(c: Pick<EnrollmentCtx, 'guardians' | 'student'>): string[] {
    return [c.student.userId, ...c.guardians.map((g) => g.userId)].filter((x): x is string => !!x);
  }

  async instalments(tx: DbOrTx, enrollmentId: string, opts: { lock?: boolean; includeCancelled?: boolean } = {}): Promise<InstalmentRowDb[]> {
    const where = opts.includeCancelled ? eq(s.instalment.enrollmentId, enrollmentId) : and(eq(s.instalment.enrollmentId, enrollmentId), ne(s.instalment.status, 'cancelled'));
    const q = tx.select().from(s.instalment).where(where).orderBy(asc(s.instalment.dueDate), asc(s.instalment.seq));
    return opts.lock ? q.for('update') : q;
  }

  /** Enrollment ids whose ledger belongs to this fee account (batch transfers keep one running ledger). */
  async chainIds(tx: DbOrTx, enrollmentId: string): Promise<string[]> {
    const rows = await tx.execute<{ id: string }>(sql`
      with recursive chain(id) as (
        select ${enrollmentId}::uuid
        union
        select t.from_enrollment_id from enrollment_transfer t join chain c on t.to_enrollment_id = c.id
      ) select id from chain`);
    return rows.map((r) => r.id);
  }

  /**
   * Fee clearance (PRD §12 rule 3): course policy (or the institution default),
   * cleared money only, honouring a temporary exemption. Cached on the
   * enrollment; FeeClearanceChanged is emitted when it flips.
   */
  async recomputeClearance(tx: Tx, enrollmentId: string, today: ISODate = todayIST()): Promise<{ cleared: boolean; changed: boolean; reason: string }> {
    const [row] = await tx
      .select({ enr: s.enrollment, policy: s.course.clearancePolicy })
      .from(s.enrollment)
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(eq(s.enrollment.id, enrollmentId));
    if (!row) throw notFound('Enrollment');
    const inst = await this.institution(tx);
    const policy: ClearancePolicy = row.policy ?? inst.settings.clearancePolicy ?? { kind: 'current_instalment' };
    const insts = (await this.instalments(tx, enrollmentId)).filter((i) => i.amount - i.waived > 0);
    const r = computeClearance({
      instalments: insts.map((i) => ({ dueDate: i.dueDate, amount: i.amount - i.waived, paid: i.paid })),
      policy,
      today,
      exemptUntil: row.enr.exemptUntil,
    });
    const changed = r.cleared !== row.enr.feeCleared;
    if (changed || r.clearedUntil !== row.enr.clearedUntil || r.reason !== row.enr.clearanceReason) {
      await tx.update(s.enrollment).set({ feeCleared: r.cleared, clearedUntil: r.clearedUntil, clearanceReason: r.reason }).where(eq(s.enrollment.id, enrollmentId));
    }
    if (changed) await this.events.emit(tx, 'FeeClearanceChanged', { enrollmentId, studentId: row.enr.studentId, cleared: r.cleared });
    return { cleared: r.cleared, changed, reason: r.reason };
  }

  /** Locked month or closed day for a branch (null when open). */
  async lockReason(tx: DbOrTx, branchId: string, date: ISODate, opts: { dayClose: boolean }): Promise<string | null> {
    const month = monthStart(date);
    const [lock] = await tx
      .select({ id: s.periodLock.id, branch: s.branch.name })
      .from(s.periodLock)
      .innerJoin(s.branch, eq(s.branch.id, s.periodLock.branchId))
      .where(and(eq(s.periodLock.branchId, branchId), eq(s.periodLock.month, month), eq(s.periodLock.status, 'locked')));
    if (lock) return `${monthName(month, true)} ${month.slice(0, 4)} is a locked period for ${lock.branch} — entries in it need Super Admin approval`;
    if (opts.dayClose) {
      const [dc] = await tx
        .select({ closedAt: s.dayClose.closedAt, branch: s.branch.name, by: s.user.name })
        .from(s.dayClose)
        .innerJoin(s.branch, eq(s.branch.id, s.dayClose.branchId))
        .leftJoin(s.user, eq(s.user.id, s.dayClose.closedBy))
        .where(and(eq(s.dayClose.branchId, branchId), eq(s.dayClose.date, date)));
      if (dc) return `${dc.branch}'s day book for ${formatDayMonth(date)} was closed at ${toISTTime(dc.closedAt)}${dc.by ? ` by ${dc.by}` : ''} — no more desk entries for that day`;
    }
    return null;
  }

  async assertOpenPeriod(tx: DbOrTx, branchId: string, date: ISODate, opts: { dayClose: boolean }): Promise<void> {
    const reason = await this.lockReason(tx, branchId, date, opts);
    if (reason) throw invalid(reason);
  }

  /** Next gap-free document number for a branch in the current FY. */
  async nextNumber(tx: Tx, branchId: string, docType: 'invoice' | 'receipt' | 'credit_note', today: ISODate = todayIST()): Promise<{ number: string; seq: number; fy: string }> {
    const fy = financialYear(today);
    const [branch] = await tx.select({ code: s.branch.code }).from(s.branch).where(eq(s.branch.id, branchId));
    if (!branch) throw notFound('Branch');
    const fin = await this.settings(tx);
    const seq = await this.numbering.next(tx, branchId, docType, fy);
    return { number: formatNumber(fin.numbering[docType], { BRANCH: branch.code, FY: fy, SEQ: seq }), seq, fy };
  }

  /** Dashboards cache for 60 s; any money movement bumps the version so they refresh at once. */
  bumpDashboard(tx: DbOrTx): void {
    afterCommit(tx, () => this.redis.client.incr(this.redis.key('fin', 'dash', 'ver')));
  }

  async dashboardVersion(): Promise<string> {
    return (await this.redis.client.get(this.redis.key('fin', 'dash', 'ver'))) ?? '0';
  }

  /** Realtime: finance screens in the branch + the student's and guardians' portals. */
  invalidate(tx: DbOrTx, branchId: string, portalUserIds: readonly string[] = []): void {
    const keys = [['finance'], ['students'], ['portal']];
    this.notify.invalidate(tx, branchId, keys);
    if (portalUserIds.length) this.notify.invalidateUsers(tx, portalUserIds, keys);
    this.bumpDashboard(tx);
  }

  activeOnly<T extends InstalmentLike>(insts: readonly T[]): T[] {
    return insts.filter(isActive);
  }

  async branchesByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db.db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, ids));
  }
}
