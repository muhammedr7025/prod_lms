import { Injectable } from '@nestjs/common';
import type { FeeCard, PayInfo, TagVariant } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx } from '@exatech/db';
import {
  addDays,
  attendancePercent,
  daysBetween,
  formatDayMonth,
  formatINR,
  formatWeekdayDate,
  LOW_ATTENDANCE_THRESHOLD,
  minutesOf,
  sumPaise,
  todayIST,
  toISTTime,
  type AttendanceStatus,
  type ISODate,
} from '@exatech/domain';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden } from '../../core/errors';
import { ScopeService, type StudentScope } from '../../core/scope.service';
import { FinanceShared, type FinSettings, type InstalmentRowDb } from '../finance/finance.shared';
import { razorpayConfigured } from '../finance/gateway';
import { isActive, openBalance, suggestedInstalment } from '../finance/ledger';

/** An instalment is "due soon" (fee card shows Pay now) within this many days of its due date. */
export const DUE_SOON_DAYS = 30;
/** When "Message class teacher" messages are delivered (after moderation). */
export const STAFF_HOURS = 'Mon–Sat 09:00–18:00';

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 · 50% mid-course" → "Instalment 2 · 50% mid-course"; other labels unchanged. */
export function instalmentName(label: string): string {
  return /^\d/.test(label) ? `Instalment ${label}` : label;
}

/** "2 · 50% mid-course" → "Instalment 2". */
export function instalmentShort(label: string): string {
  return /^\d/.test(label) ? `Instalment ${label.split(' · ')[0]}` : label;
}

export interface FeeSummary {
  card: FeeCard;
  pay: PayInfo | null;
  outstanding: number;
  total: number;
  next: InstalmentRowDb | null;
  instalments: InstalmentRowDb[];
  fin: FinSettings;
  feeCleared: boolean;
}

export interface AttendanceSummary {
  pct: number;
  attended: number;
  total: number;
  threshold: number;
  low: boolean;
  rows: { sessionId: string; date: string; startTime: string; topic: string | null; subject: string; status: AttendanceStatus }[];
}

/**
 * Shared portal plumbing: scope resolution, fee card + pay-sheet data
 * (computed from Finance's instalments with Finance's own arithmetic),
 * attendance summary and the next session.
 */
@Injectable()
export class PortalShared {
  constructor(
    readonly db: Db,
    private readonly scope: ScopeService,
    private readonly finance: FinanceShared,
  ) {}

  /** Student → own enrollment; parent → the linked child (?studentId=). */
  async resolve(studentId?: string | null): Promise<StudentScope> {
    return this.scope.portalEnrollment(studentId ?? null);
  }

  /** Every enrollment this account may see (student: own; parent: children). */
  async all(): Promise<StudentScope[]> {
    return ctx().roleKey === 'parent' ? this.scope.parentChildren() : this.scope.studentEnrollments();
  }

  /** Student-only actions (open notes, submit work, check in). */
  async ownEnrollment(): Promise<StudentScope> {
    if (ctx().roleKey === 'parent') throw forbidden('Only the student can do this');
    return this.scope.portalEnrollment(null);
  }

  async institution(dbx: DbOrTx = this.db.db) {
    return this.finance.institution(dbx);
  }

  async threshold(): Promise<number> {
    const inst = await this.institution();
    return inst.settings.lowAttendanceThreshold ?? LOW_ATTENDANCE_THRESHOLD;
  }

  async branch(branchId: string) {
    const [b] = await this.db.db.select({ id: s.branch.id, name: s.branch.name, code: s.branch.code, city: s.branch.city }).from(s.branch).where(eq(s.branch.id, branchId));
    return b ?? { id: branchId, name: '', code: '', city: null };
  }

  /** "DM-A · Digital Marketing · Trivandrum" */
  async batchLong(sc: StudentScope): Promise<string> {
    const b = await this.branch(sc.branchId);
    return [sc.batchCode, sc.courseName, b.name].filter(Boolean).join(' · ');
  }

  /** Fee card (Home / Fees), pay-sheet info, and the raw instalments. */
  async feeSummary(sc: StudentScope, today: ISODate = todayIST()): Promise<FeeSummary> {
    const [fin, rows, enr] = await Promise.all([
      this.finance.settings(),
      this.finance.instalments(this.db.db, sc.enrollmentId),
      this.db.db.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, sc.enrollmentId)),
    ]);
    const insts = rows.filter(isActive);
    const outstanding = sumPaise(insts.map(openBalance));
    const total = sumPaise(insts.map((i) => i.amount));
    const next = suggestedInstalment(insts);
    const feeCleared = enr[0]?.feeCleared ?? false;
    const amount = next ? openBalance(next) : 0;

    let card: FeeCard;
    if (!next) {
      const pending = insts.some((i) => i.pendingPaid > 0);
      card = pending
        ? { state: 'cleared', headline: 'Payment awaiting clearance', sub: 'Fee-gated notes unlock as soon as the cheque clears', amount: 0 }
        : { state: 'cleared', headline: 'All fees cleared', sub: `Fully paid · ${formatINR(total)}`, amount: 0 };
    } else if (next.dueDate < today) {
      const overdueDays = daysBetween(next.dueDate, today);
      const lateIn = fin.lateFee.graceDays - overdueDays + 1;
      const label = instalmentShort(next.label);
      card = {
        state: 'overdue',
        headline: `${formatINR(amount)} overdue`,
        sub:
          lateIn > 0
            ? `${label} was due ${formatDayMonth(next.dueDate)} · late fee after ${plural(lateIn, 'day')}`
            : `${label} · ${plural(overdueDays, 'day')} overdue · late fee ${formatINR(fin.lateFee.perDay)}/day`,
        amount,
      };
    } else if (daysBetween(today, next.dueDate) <= DUE_SOON_DAYS) {
      const inDays = daysBetween(today, next.dueDate);
      card = {
        state: 'due',
        headline: `${formatINR(amount)} due ${formatDayMonth(next.dueDate)}`,
        sub: `${instalmentShort(next.label)} · ${inDays === 0 ? 'due today' : `in ${plural(inDays, 'day')}`} · late fee after ${plural(fin.lateFee.graceDays, 'day')}' grace`,
        amount,
      };
    } else {
      card = { state: 'cleared', headline: 'All fees cleared', sub: `Next due ${formatDayMonth(next.dueDate)} · ${formatINR(amount)}`, amount: 0 };
    }

    let pay: PayInfo | null = null;
    if (next && outstanding > 0) {
      const overdue = next.dueDate < today;
      const od = daysBetween(next.dueDate, today);
      const gateway = razorpayConfigured() ? 'razorpay' : 'sandbox';
      pay = {
        studentId: sc.studentId,
        studentName: sc.name,
        firstName: firstName(sc.name),
        instalmentLabel: instalmentShort(next.label),
        title: `${instalmentShort(next.label)} · ${formatINR(amount)}`,
        dueLine: overdue ? `due ${formatDayMonth(next.dueDate)} · ${plural(od, 'day')} overdue` : `due ${formatDayMonth(next.dueDate)}`,
        overdue,
        nextDue: amount,
        full: outstanding,
        minPartial: Math.min(fin.minPartial, outstanding),
        gateway,
        gatewayLabel: gateway === 'razorpay' ? 'Razorpay' : 'Sandbox gateway',
      };
    }
    return { card, pay, outstanding, total, next, instalments: insts, fin, feeCleared };
  }

  /** Attendance % (same rule as the cached enrollment %: ad-hoc counts once acknowledged). */
  async attendance(enrollmentId: string): Promise<AttendanceSummary> {
    const [threshold, rows] = await Promise.all([
      this.threshold(),
      this.db.db
        .select({
          sessionId: s.classSession.id,
          date: s.classSession.date,
          startTime: s.classSession.startTime,
          topic: s.classSession.topic,
          subject: s.classSession.subjectName,
          status: s.attendance.status,
        })
        .from(s.attendance)
        .innerJoin(s.classSession, eq(s.classSession.id, s.attendance.sessionId))
        .where(
          and(
            eq(s.attendance.enrollmentId, enrollmentId),
            sql`${s.classSession.status} <> 'cancelled'`,
            sql`${s.classSession.kind} <> 'exam'`,
            sql`(${s.classSession.kind} <> 'adhoc' or ${s.classSession.acknowledgedAt} is not null)`,
          ),
        )
        .orderBy(sql`${s.classSession.date} desc`, sql`${s.classSession.startTime} desc`),
    ]);
    const statuses = rows.map((r) => r.status);
    const counted = statuses.filter((x) => x !== 'E');
    const attended = counted.filter((x) => x === 'P' || x === 'L').length;
    const pct = attendancePercent(statuses);
    return { pct, attended, total: counted.length, threshold, low: pct < threshold, rows };
  }

  /** "Tue 13 Oct 09:00 · Room 1 · Analytics setup" — next scheduled class for the batch. */
  async nextSession(batchId: string, now: Date = new Date()): Promise<string | null> {
    const today = todayIST(now);
    const nowMin = minutesOf(toISTTime(now));
    const rows = await this.db.db
      .select({ date: s.classSession.date, start: s.classSession.startTime, topic: s.classSession.topic, subject: s.classSession.subjectName, mode: s.classSession.mode, room: s.room.name })
      .from(s.classSession)
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(
        and(
          eq(s.classSession.batchId, batchId),
          eq(s.classSession.status, 'scheduled'),
          inArray(s.classSession.kind, ['timetabled', 'adhoc']),
          sql`${s.classSession.date} >= ${today}::date`,
          sql`${s.classSession.date} <= ${addDays(today, 60)}::date`,
        ),
      )
      .orderBy(asc(s.classSession.date), asc(s.classSession.startTime))
      .limit(5);
    const n = rows.find((r) => r.date > today || minutesOf(r.start) > nowMin);
    if (!n) return null;
    const where = n.mode === 'online' ? 'Online' : (n.room ?? 'Room TBA');
    return [`${formatWeekdayDate(n.date)} ${n.start}`, where, n.topic ?? n.subject].join(' · ');
  }

  /** Active teachers of a batch (class teacher first). */
  async batchTeachers(batchId: string, dbx: DbOrTx = this.db.db) {
    return dbx
      .select({ id: s.user.id, name: s.user.name, subject: s.teacherAssignment.subjectName })
      .from(s.teacherAssignment)
      .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
      .where(and(eq(s.teacherAssignment.batchId, batchId), eq(s.teacherAssignment.active, true)))
      .orderBy(sql`${s.teacherAssignment.isPrimary} desc`, asc(s.user.name));
  }

  /** Branch Administrators of a branch. */
  async branchAdmins(branchId: string, dbx: DbOrTx = this.db.db): Promise<string[]> {
    const rows = await dbx
      .selectDistinct({ id: s.user.id })
      .from(s.membership)
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .innerJoin(s.user, eq(s.user.id, s.membership.userId))
      .where(and(eq(s.role.key, 'branchadmin'), eq(s.membership.status, 'active'), eq(s.user.status, 'active'), sql`${branchId} = any(${s.membership.branchIds})`));
    return rows.map((r) => r.id);
  }
}

export const ATT_TAG: Record<AttendanceStatus, TagVariant> = { P: 'accent', A: 'ink', L: 'outline', E: 'neutral' };
