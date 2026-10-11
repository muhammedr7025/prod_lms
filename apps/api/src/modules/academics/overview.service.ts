import { Injectable } from '@nestjs/common';
import type { AcadAtRiskRow, AcadLeaveRow, AcadOverview, AcadTodaySession } from '@exatech/contracts';
import * as s from '@exatech/db';
import { alias, and, asc, desc, eq, gte, inArray, isNull, lte, sql } from '@exatech/db';
import { addDays, formatLongWeekdayDate, formatWeekdayDate, formatWeekdayShort, isAtRisk, minutesOf, riskReasons, todayIST, toISTTime } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { AcademicsShared, idList, scopeSql } from './academics.shared';

const ADHOC_LABEL: Record<string, string> = { substitute: 'Substitute', extra: 'Extra class', doubt_clearing: 'Doubt clearing', guest: 'Guest session' };

export interface RiskRow {
  enrollmentId: string;
  studentId: string;
  name: string;
  batchCode: string;
  attendancePct: number;
  overdue: number;
  missed: number;
  streak: number;
}

/** Branch operations: today's sessions, KPIs, at-risk students, leave and ad-hoc acknowledgement. */
@Injectable()
export class OverviewService {
  constructor(
    private readonly db: Db,
    private readonly shared: AcademicsShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
  ) {}

  /** Risk inputs for every active enrollment in scope (attendance, overdue, missed work, absence streak). */
  async riskRows(): Promise<RiskRow[]> {
    const today = todayIST();
    const rows = await this.db.db.execute<{ enrollment_id: string; student_id: string; name: string; batch_code: string; attendance_pct: number; overdue: string | null; missed: string | null }>(sql`
      select e.id as enrollment_id, st.id as student_id, st.name, b.code as batch_code, e.attendance_pct,
        (select sum(greatest(i.amount - i.paid - i.waived, 0)) from instalment i
          where i.enrollment_id = e.id and i.due_date < ${today} and i.status not in ('paid', 'waived', 'cancelled')) as overdue,
        (select count(*) from assignment a
          where a.batch_id = e.batch_id and a.due_at < now() and a.due_at >= e.joined_on::timestamp
            and not exists (select 1 from submission sb where sb.assignment_id = a.id and sb.enrollment_id = e.id)) as missed
      from enrollment e
      join student st on st.id = e.student_id
      join batch b on b.id = e.batch_id
      where e.status = 'active' and b.status in ('running', 'open', 'waitlist') and ${scopeSql(sql`e.branch_id`)}`);
    const ids = rows.map((r) => r.enrollment_id);
    const streaks = new Map<string, number>();
    if (ids.length) {
      const st = await this.db.db.execute<{ enrollment_id: string; streak: number }>(sql`
        with ranked as (
          select a.enrollment_id, a.status,
            row_number() over (partition by a.enrollment_id order by cs.date desc, cs.start_time desc) as rn
          from attendance a join class_session cs on cs.id = a.session_id
          where a.enrollment_id in ${idList(ids)} and cs.status <> 'cancelled'
            and (cs.kind <> 'adhoc' or cs.acknowledged_at is not null)
        )
        select enrollment_id, (coalesce(min(rn) filter (where status <> 'A'), max(rn) + 1) - 1)::int as streak
        from ranked group by enrollment_id`);
      for (const r of st) streaks.set(r.enrollment_id, Number(r.streak));
    }
    return rows.map((r) => ({
      enrollmentId: r.enrollment_id,
      studentId: r.student_id,
      name: r.name,
      batchCode: r.batch_code,
      attendancePct: Number(r.attendance_pct),
      overdue: Number(r.overdue ?? 0),
      missed: Number(r.missed ?? 0),
      streak: streaks.get(r.enrollment_id) ?? 0,
    }));
  }

  atRisk(rows: RiskRow[]): AcadAtRiskRow[] {
    return rows
      .map((r) => ({ r, input: { attendancePct: r.attendancePct, overdue: r.overdue, missedAssignments: r.missed, consecutiveAbsences: r.streak } }))
      .filter((x) => isAtRisk(x.input))
      .sort((a, b) => a.r.attendancePct - b.r.attendancePct || b.r.streak - a.r.streak || b.r.overdue - a.r.overdue)
      .map(({ r, input }) => ({ studentId: r.studentId, name: r.name, batchCode: r.batchCode, reasons: riskReasons(input), attendancePct: r.attendancePct, overdue: r.overdue }));
  }

  async overview(): Promise<AcadOverview> {
    const today = todayIST();
    const now = toISTTime(new Date());
    const teacher = alias(s.user, 'teacher');
    const sessionRows = await this.db.db
      .select({ cs: s.classSession, batchCode: s.batch.code, teacherName: teacher.name, roomName: s.room.name })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .innerJoin(teacher, eq(teacher.id, s.classSession.teacherUserId))
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(
        and(
          inBranchScope(s.classSession.branchId),
          inArray(s.classSession.status, ['scheduled', 'held']),
          sql`(${s.classSession.date} = ${today} or (${s.classSession.kind} = 'adhoc' and ${s.classSession.acknowledgedAt} is null and ${s.classSession.date} >= ${addDays(today, -14)} and ${s.classSession.date} < ${today}))`,
        ),
      )
      .orderBy(asc(s.classSession.date), asc(s.classSession.startTime));
    const canAck = can('academics:adhoc.acknowledge');
    let nextAssigned = false;
    const sessions: AcadTodaySession[] = sessionRows.map((r) => {
      const cs = r.cs;
      const isToday = cs.date === today;
      const base = {
        id: cs.id,
        date: cs.date,
        time: isToday ? cs.startTime : `${formatWeekdayShort(cs.date).split(' ')[0]} ${cs.startTime}`,
        batchId: cs.batchId,
        batchCode: r.batchCode,
        topic: cs.topic ?? cs.subjectName,
        teacherName: r.teacherName,
        roomName: r.roomName ?? (cs.mode === 'online' ? 'Online' : 'No room'),
        kind: cs.kind,
        adhocNote: cs.kind === 'adhoc' ? [ADHOC_LABEL[cs.adhocType ?? ''] ?? 'Ad-hoc', cs.adhocReason].filter(Boolean).join(' · ') : null,
      };
      if (cs.kind === 'adhoc' && !cs.acknowledgedAt) return { ...base, status: 'adhoc_pending' as const, statusLabel: 'Ad-hoc · acknowledge', tag: 'ink' as const, canAcknowledge: canAck };
      if (cs.attendanceSubmittedAt) return { ...base, status: 'marked' as const, statusLabel: 'Marked', tag: 'accent' as const, canAcknowledge: false };
      if (minutesOf(now) >= minutesOf(cs.endTime)) return { ...base, status: 'not_marked' as const, statusLabel: 'Not marked', tag: 'ink' as const, canAcknowledge: false };
      if (minutesOf(now) >= minutesOf(cs.startTime)) return { ...base, status: 'in_progress' as const, statusLabel: 'In progress', tag: 'outline' as const, canAcknowledge: false };
      if (!nextAssigned) {
        nextAssigned = true;
        return { ...base, status: 'next' as const, statusLabel: 'Next', tag: 'outline' as const, canAcknowledge: false };
      }
      return { ...base, status: 'upcoming' as const, statusLabel: 'Upcoming', tag: 'neutral' as const, canAcknowledge: false };
    });
    const todays = sessionRows.filter((r) => r.cs.date === today);

    const [running] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.batch)
      .where(and(inBranchScope(s.batch.branchId), eq(s.batch.status, 'running')));
    const [students] = await this.db.db
      .select({ n: sql<number>`count(distinct ${s.enrollment.studentId})::int` })
      .from(s.enrollment)
      .where(and(inBranchScope(s.enrollment.branchId), eq(s.enrollment.status, 'active')));
    const [admissions] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.admission)
      .where(and(inBranchScope(s.admission.branchId), eq(s.admission.status, 'fee_verified'), sql`(not ${s.admission.needsSuperAdmin} or ${s.admission.superAdminApprovedBy} is not null)`));
    const [marks] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.exam)
      .where(and(inBranchScope(s.exam.branchId), eq(s.exam.status, 'submitted')));
    const atRisk = this.atRisk(await this.riskRows());

    return {
      branchLabel: await this.shared.branchLabel(),
      dateLabel: formatLongWeekdayDate(today),
      kpis: {
        sessionsToday: todays.length,
        sessionsMarked: todays.filter((r) => r.cs.attendanceSubmittedAt).length,
        runningBatches: Number(running?.n ?? 0),
        activeStudents: Number(students?.n ?? 0),
        admissionsPending: Number(admissions?.n ?? 0),
        marksToPublish: Number(marks?.n ?? 0),
        atRisk: atRisk.length,
      },
      sessions,
      atRisk: atRisk.slice(0, 8),
      leave: can('academics:leave.approve') ? await this.pendingLeave() : [],
    };
  }

  private async pendingLeave(): Promise<AcadLeaveRow[]> {
    const rows = await this.db.db
      .select({ l: s.leave, name: s.user.name })
      .from(s.leave)
      .innerJoin(s.user, eq(s.user.id, s.leave.userId))
      .where(and(inBranchScope(s.leave.branchId), eq(s.leave.status, 'pending'), gte(s.leave.date, todayIST())))
      .orderBy(asc(s.leave.date))
      .limit(20);
    const out: AcadLeaveRow[] = [];
    for (const r of rows) {
      const affected = await this.db.db
        .select({ code: s.batch.code, start: s.classSession.startTime })
        .from(s.classSession)
        .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
        .where(and(eq(s.classSession.teacherUserId, r.l.userId), eq(s.classSession.date, r.l.date), eq(s.classSession.status, 'scheduled')))
        .orderBy(asc(s.classSession.startTime));
      out.push({
        id: r.l.id,
        userId: r.l.userId,
        userName: r.name,
        date: r.l.date,
        dateLabel: formatWeekdayDate(r.l.date),
        type: r.l.type[0]!.toUpperCase() + r.l.type.slice(1).replace('_', ' '),
        reason: r.l.reason,
        impact: affected.length ? `${affected.length} session${affected.length > 1 ? 's' : ''} affected · ${affected.map((a) => `${a.code} ${a.start}`).join(', ')}` : 'No sessions that day',
        requestedAt: r.l.createdAt.toISOString(),
      });
    }
    return out;
  }

  /** Ad-hoc sessions count towards attendance only after this. */
  async acknowledge(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [row] = await tx.select().from(s.classSession).where(eq(s.classSession.id, id)).for('update');
      if (!row) throw notFound('Session');
      assertInScope(row.branchId);
      if (row.kind !== 'adhoc') throw conflict('Only ad-hoc sessions need acknowledgement');
      if (row.acknowledgedAt) return;
      const c = ctx();
      await tx.update(s.classSession).set({ acknowledgedAt: new Date(), acknowledgedBy: c.userId }).where(eq(s.classSession.id, id));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, row.batchId));
      const [t] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, row.teacherUserId));
      await this.shared.recomputeBatchAttendance(tx, row.batchId);
      const label = `${b?.code ?? 'Batch'} · ${formatWeekdayDate(row.date)} ${row.startTime}`;
      await this.audit.log(tx, {
        action: 'Ad-hoc session acknowledged',
        kind: 'approve',
        entityType: 'class_session',
        entityId: id,
        entityLabel: label,
        before: { acknowledgedAt: null },
        after: { acknowledgedAt: new Date().toISOString() },
        summary: `${label} · ${t?.name ?? ''} · ${ADHOC_LABEL[row.adhocType ?? ''] ?? 'ad-hoc'}${row.adhocReason ? ` (${row.adhocReason})` : ''} · attendance now counts`,
        branchId: row.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [row.teacherUserId],
        category: 'adhoc_session',
        title: `Ad-hoc session acknowledged · ${b?.code ?? ''}`,
        body: `${formatWeekdayDate(row.date)} ${row.startTime} — attendance now counts`,
        link: '/teacher',
        entityType: 'class_session',
        entityId: id,
      });
      this.notify.invalidate(tx, row.branchId, [['academics'], ['students'], ['teaching']]);
    });
  }

  async decideLeave(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [l] = await tx.select().from(s.leave).where(eq(s.leave.id, id)).for('update');
      if (!l) throw notFound('Leave request');
      assertInScope(l.branchId);
      if (l.status !== 'pending') throw conflict(`This leave request is already ${l.status}`);
      const c = ctx();
      if (l.userId === c.userId) throw invalid('You cannot decide your own leave request');
      await tx.update(s.leave).set({ status: decision, decidedBy: c.userId, decidedAt: new Date(), decisionNote: note ?? null }).where(eq(s.leave.id, id));
      const [u] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, l.userId));
      let flagged = 0;
      if (decision === 'approved') {
        const res = await tx
          .update(s.classSession)
          .set({ flag: 'leave · substitute?' })
          .where(and(eq(s.classSession.teacherUserId, l.userId), eq(s.classSession.date, l.date), eq(s.classSession.status, 'scheduled'), isNull(s.classSession.substituteForUserId)))
          .returning({ id: s.classSession.id });
        flagged = res.length;
      }
      await this.events.emit(tx, 'LeaveDecided', { leaveId: id, userId: l.userId, branchId: l.branchId, date: l.date, status: decision });
      await this.audit.log(tx, {
        action: decision === 'approved' ? 'Leave approved' : 'Leave rejected',
        kind: 'approve',
        entityType: 'leave',
        entityId: id,
        entityLabel: `${u?.name ?? ''} · ${l.date}`,
        before: { status: 'pending' },
        after: { status: decision, note: note ?? null },
        summary: `${u?.name ?? ''} · ${formatWeekdayDate(l.date)} · pending → ${decision}${flagged ? ` · ${flagged} session${flagged > 1 ? 's' : ''} flagged for a substitute` : ''}${note ? ` · ${note}` : ''}`,
        branchId: l.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [l.userId],
        category: 'leave',
        title: `Leave ${decision} · ${formatWeekdayDate(l.date)}`,
        body: note ?? (decision === 'approved' ? (flagged ? 'A substitute will be assigned for your sessions' : 'Enjoy your day off') : 'Talk to your branch administrator'),
        link: '/teacher',
        entityType: 'leave',
        entityId: id,
      });
      this.notify.invalidate(tx, l.branchId, [['academics'], ['teaching']]);
    });
  }

  /** Not used by the overview but kept for the student drawer's KPI (missed + pending work). */
  async latestAttendance(enrollmentIds: string[], limit = 8) {
    if (!enrollmentIds.length) return [];
    return this.db.db
      .select({ date: s.classSession.date, topic: s.classSession.topic, subject: s.classSession.subjectName, status: s.attendance.status, kind: s.classSession.kind, ack: s.classSession.acknowledgedAt })
      .from(s.attendance)
      .innerJoin(s.classSession, eq(s.classSession.id, s.attendance.sessionId))
      .where(and(inArray(s.attendance.enrollmentId, enrollmentIds), lte(s.classSession.date, todayIST())))
      .orderBy(desc(s.classSession.date), desc(s.classSession.startTime))
      .limit(limit);
  }
}
