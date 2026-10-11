import { Injectable } from '@nestjs/common';
import type { AcadBatchRow, AcadBatchStatus, AcadTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx, type SQL } from '@exatech/db';
import { attendancePercent, minutesOf, timeFromMinutes, type AttendanceStatus, type ClearancePolicy } from '@exatech/domain';
import { AccessService } from '../../core/auth/access.service';
import { branchScope, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { invalid } from '../../core/errors';
import { NotifyService } from '../../core/notifications/notify.service';

export const SLOT_MINUTES = 120;
export const endOf = (start: string) => timeFromMinutes(minutesOf(start) + SLOT_MINUTES);

export const BATCH_STATUS_META: Record<AcadBatchStatus, { label: string; tag: AcadTag }> = {
  running: { label: 'Running', tag: 'accent' },
  open: { label: 'Open', tag: 'outline' },
  planned: { label: 'Planned', tag: 'neutral' },
  waitlist: { label: 'Waitlist', tag: 'ink' },
  completed: { label: 'Completed', tag: 'plain' },
  cancelled: { label: 'Cancelled', tag: 'plain' },
};

/** Lifecycle: planned → open → running → completed, or cancelled from any live state. */
export const BATCH_TRANSITIONS: Record<AcadBatchStatus, AcadBatchStatus[]> = {
  planned: ['open', 'cancelled'],
  open: ['running', 'waitlist', 'planned', 'cancelled'],
  waitlist: ['open', 'running', 'cancelled'],
  running: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon/Wed/Fri 09:00 · Tue 16:30" from weekly slots. */
export function scheduleLabel(slots: readonly { weekday: number; start: string }[]): string {
  const times = [...new Set(slots.map((x) => x.start))].sort();
  return times
    .map((t) => {
      const days = [...new Set(slots.filter((x) => x.start === t).map((x) => x.weekday))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      return `${days.map((d) => WD[d]).join('/')} ${t}`;
    })
    .join(' · ');
}

export function policyLabel(p: ClearancePolicy | null | undefined): string {
  if (!p) return 'Current instalment paid';
  if (p.kind === 'fully_paid') return 'Fully paid';
  if (p.kind === 'percentage') return `At least ${p.percentage}% of the fee paid`;
  return 'Current instalment paid';
}

/** Branch-scope condition for raw SQL over a column expression. */
export function scopeSql(column: SQL): SQL {
  const sc = branchScope();
  if (sc === null) return sql`true`;
  if (sc.length === 0) return sql`false`;
  return sql`${column} in (${sql.join(
    sc.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export function idList(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`(null::uuid)`;
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/** Shared queries and side effects for the Academics controllers. */
@Injectable()
export class AcademicsShared {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly notify: NotifyService,
  ) {}

  async settings() {
    return (await this.access.institution()).settings;
  }

  async institutionName() {
    return (await this.access.institution()).name;
  }

  /** "Trivandrum" for a single-branch scope, otherwise "All branches". */
  async branchLabel(): Promise<string> {
    const sc = branchScope();
    if (sc && sc.length === 1) {
      const [b] = await this.db.db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, sc[0]!));
      return b?.name ?? 'Branch';
    }
    if (sc && sc.length > 1) {
      const rows = await this.db.db.select({ code: s.branch.code }).from(s.branch).where(inArray(s.branch.id, sc));
      return rows.map((r) => r.code).join(' · ');
    }
    return 'All branches';
  }

  /** The single branch new records go to (explicit, selected, or the only one in the membership). */
  resolveBranch(explicit?: string | null): string {
    const c = ctx();
    const sc = branchScope();
    const id = explicit ?? c.selectedBranchId ?? (sc && sc.length === 1 ? sc[0]! : null);
    if (!id) throw invalid('Choose a branch first (header branch switcher)', { branchId: 'Required' });
    if (sc && !sc.includes(id)) throw invalid('That branch is outside your scope', { branchId: 'Out of scope' });
    return id;
  }

  /** Student portal users (+ teachers) of a batch for timetable / material fan-out. */
  async batchAudience(tx: DbOrTx, batchId: string, opts: { guardians?: boolean } = {}): Promise<{ students: string[]; guardians: string[]; teachers: string[] }> {
    const rows = await tx
      .select({ studentUserId: s.student.userId, studentId: s.student.id })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .where(and(eq(s.enrollment.batchId, batchId), eq(s.enrollment.status, 'active')));
    const teachers = await tx
      .select({ id: s.teacherAssignment.teacherUserId })
      .from(s.teacherAssignment)
      .where(and(eq(s.teacherAssignment.batchId, batchId), eq(s.teacherAssignment.active, true)));
    let guardians: string[] = [];
    if (opts.guardians && rows.length) {
      const g = await tx
        .select({ userId: s.guardian.userId })
        .from(s.studentGuardian)
        .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
        .where(inArray(s.studentGuardian.studentId, rows.map((r) => r.studentId)));
      guardians = g.map((x) => x.userId).filter((x): x is string => !!x);
    }
    return { students: rows.map((r) => r.studentUserId).filter((x): x is string => !!x), guardians, teachers: teachers.map((t) => t.id) };
  }

  /** In-app timetable notice to a batch's students and teachers (plus extra users). */
  async notifyBatch(tx: DbOrTx, batchId: string, input: { title: string; body: string; link?: string | null; extraUserIds?: string[]; category?: s.NotificationCategory; entityType?: string; entityId?: string }) {
    const a = await this.batchAudience(tx, batchId);
    const me = ctx().userId;
    const userIds = [...new Set([...a.students, ...a.teachers, ...(input.extraUserIds ?? [])])].filter((u) => u !== me);
    await this.notify.notify(tx, {
      userIds,
      category: input.category ?? 'timetable',
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      entityType: input.entityType ?? 'class_session',
      entityId: input.entityId,
    });
  }

  /**
   * Recompute the cached attendance % for a batch's active enrollments.
   * Ad-hoc sessions only count once a Branch Admin has acknowledged them.
   */
  async recomputeBatchAttendance(tx: DbOrTx, batchId: string): Promise<void> {
    const enr = await tx.select({ id: s.enrollment.id }).from(s.enrollment).where(and(eq(s.enrollment.batchId, batchId), eq(s.enrollment.status, 'active')));
    if (enr.length === 0) return;
    const rows = await tx
      .select({ enrollmentId: s.attendance.enrollmentId, status: s.attendance.status })
      .from(s.attendance)
      .innerJoin(s.classSession, eq(s.classSession.id, s.attendance.sessionId))
      .where(
        and(
          inArray(
            s.attendance.enrollmentId,
            enr.map((e) => e.id),
          ),
          sql`${s.classSession.status} <> 'cancelled'`,
          sql`(${s.classSession.kind} <> 'adhoc' or ${s.classSession.acknowledgedAt} is not null)`,
        ),
      );
    const by = new Map<string, AttendanceStatus[]>();
    for (const r of rows) {
      const list = by.get(r.enrollmentId) ?? [];
      list.push(r.status);
      by.set(r.enrollmentId, list);
    }
    for (const e of enr) {
      await tx.update(s.enrollment).set({ attendancePct: attendancePercent(by.get(e.id) ?? []) }).where(eq(s.enrollment.id, e.id));
    }
  }

  /** Batch rows (Courses & batches table) for a filter. */
  async batchRows(where: SQL | undefined, dbx: DbOrTx = this.db.db): Promise<AcadBatchRow[]> {
    const rows = await dbx
      .select({
        b: s.batch,
        branchCode: s.branch.code,
        courseCode: s.course.code,
        courseName: s.course.name,
        roomName: s.room.name,
        feePlanName: s.feePlan.name,
        enrolled: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.batch.id} and e.status = 'active')`,
      })
      .from(s.batch)
      .innerJoin(s.branch, eq(s.branch.id, s.batch.branchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .leftJoin(s.room, eq(s.room.id, s.batch.roomId))
      .leftJoin(s.feePlan, eq(s.feePlan.id, s.batch.feePlanId))
      .where(where)
      .orderBy(asc(s.branch.code), asc(s.batch.code));
    const ids = rows.map((r) => r.b.id);
    const assignments = ids.length
      ? await dbx
          .select({ batchId: s.teacherAssignment.batchId, teacherUserId: s.teacherAssignment.teacherUserId, subjectName: s.teacherAssignment.subjectName, isPrimary: s.teacherAssignment.isPrimary, name: s.user.name })
          .from(s.teacherAssignment)
          .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
          .where(and(inArray(s.teacherAssignment.batchId, ids), eq(s.teacherAssignment.active, true)))
          .orderBy(asc(s.teacherAssignment.createdAt))
      : [];
    const canManage = can('academics:courses.manage');
    const canCancel = can('academics:courses.delete');
    const order: AcadBatchStatus[] = ['running', 'open', 'waitlist', 'planned', 'completed', 'cancelled'];
    return rows
      .map((r) => {
        const as = assignments.filter((a) => a.batchId === r.b.id).sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary));
        const primary = as[0];
        const status = r.b.status as AcadBatchStatus;
        const enrolled = Number(r.enrolled);
        return {
          id: r.b.id,
          code: r.b.code,
          name: r.b.name,
          branchId: r.b.branchId,
          branchCode: r.branchCode,
          courseId: r.b.courseId,
          courseCode: r.courseCode,
          courseName: r.courseName,
          schedule: r.b.scheduleLabel ?? '—',
          teacherUserId: primary?.teacherUserId ?? null,
          teacherName: primary?.name ?? null,
          subjectName: primary?.subjectName ?? null,
          assignments: as.map((a) => ({ teacherUserId: a.teacherUserId, teacherName: a.name, subjectName: a.subjectName, isPrimary: a.isPrimary })),
          roomId: r.b.roomId,
          roomName: r.roomName,
          capacity: r.b.capacity,
          enrolled,
          seatsPct: r.b.capacity > 0 ? Math.min(100, Math.round((enrolled / r.b.capacity) * 100)) : 0,
          feePlanId: r.b.feePlanId,
          feePlanName: r.feePlanName,
          status,
          statusLabel: BATCH_STATUS_META[status].label,
          tag: BATCH_STATUS_META[status].tag,
          startDate: r.b.startDate,
          endDate: r.b.endDate,
          mode: r.b.mode,
          meetLink: r.b.meetLink,
          nextStatuses: canManage ? BATCH_TRANSITIONS[status].filter((x) => x !== 'cancelled' || canCancel) : [],
        };
      })
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.code.localeCompare(b.code));
  }
}
