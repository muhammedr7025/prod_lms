import { Injectable } from '@nestjs/common';
import { TEACH_ADHOC_LABEL, TEACH_ADHOC_TYPES, TEACH_LEAVE_LABEL, TEACH_LEAVE_TYPES, type TeachLeaveRow, type TeachTag, type TeachToday, type TeachTodaySession } from '@exatech/contracts';
import * as s from '@exatech/db';
import { alias, and, asc, eq, gt, gte, inArray, isNull, or, sql } from '@exatech/db';
import { addDays, evaluateMarkRow, formatLongWeekdayDate, formatWeekdayDate, minutesOf, todayIST, toISTTime } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, invalid } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { plural, TeachingShared } from './teaching.shared';

type LeaveType = (typeof TEACH_LEAVE_TYPES)[number];

function greeting(name: string, now = new Date()): string {
  const h = Math.floor(minutesOf(toISTTime(now)) / 60);
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return `Good ${part}, ${name.split(' ')[0]}`;
}

/** "DM-A 09:00" / "DM-A 09:00 and DM-B 16:30" */
function joinSessions(list: { code: string; start: string }[]): string {
  const parts = list.map((x) => `${x.code} ${x.start}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Teacher · Today: sessions with live marked counts, ad-hoc cards, to-grade / missing-marks tiles, leave. */
@Injectable()
export class TodayService {
  constructor(
    private readonly db: Db,
    private readonly shared: TeachingShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
  ) {}

  async today(): Promise<TeachToday> {
    const c = ctx();
    const today = todayIST();
    const nowMin = minutesOf(toISTTime(new Date()));
    const rows = await this.db.db
      .select({ cs: s.classSession, batchCode: s.batch.code, batchMode: s.batch.mode, meetLink: s.batch.meetLink, roomName: s.room.name })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(and(eq(s.classSession.teacherUserId, c.userId), eq(s.classSession.date, today), inArray(s.classSession.kind, ['timetabled', 'adhoc']), inArray(s.classSession.status, ['scheduled', 'held'])))
      .orderBy(asc(s.classSession.startTime));
    const ids = rows.map((r) => r.cs.id);
    const marked = ids.length
      ? await this.db.db
          .select({ sessionId: s.attendance.sessionId, n: sql<number>`count(*)::int` })
          .from(s.attendance)
          .where(inArray(s.attendance.sessionId, ids))
          .groupBy(s.attendance.sessionId)
      : [];
    const batchIds = [...new Set(rows.map((r) => r.cs.batchId))];
    const rosters = batchIds.length
      ? await this.db.db
          .select({ batchId: s.enrollment.batchId, n: sql<number>`count(*)::int` })
          .from(s.enrollment)
          .where(and(inArray(s.enrollment.batchId, batchIds), eq(s.enrollment.status, 'active')))
          .groupBy(s.enrollment.batchId)
      : [];

    const timetabled = rows.filter((r) => r.cs.kind === 'timetabled');
    const primaryId = timetabled.find((r) => !r.cs.attendanceSubmittedAt)?.cs.id ?? null;
    const card = (r: (typeof rows)[number]): TeachTodaySession => {
      const cs = r.cs;
      const n = Number(marked.find((m) => m.sessionId === cs.id)?.n ?? 0);
      const roster = Number(rosters.find((x) => x.batchId === cs.batchId)?.n ?? 0);
      const submitted = !!cs.attendanceSubmittedAt;
      const primary = cs.id === primaryId;
      const ended = nowMin >= minutesOf(cs.endTime);
      let tag: string;
      let tagVariant: TeachTag;
      if (cs.kind === 'adhoc') {
        tag = `Marked ${n}`;
        tagVariant = 'outline';
      } else if (submitted) {
        tag = `${n} / ${roster} marked`;
        tagVariant = 'accent';
      } else if (primary) {
        tag = ended ? 'Not marked' : nowMin >= minutesOf(cs.startTime) ? 'In progress' : 'Next';
        tagVariant = ended ? 'ink' : 'outline';
      } else if (ended) {
        tag = 'Not marked';
        tagVariant = 'ink';
      } else {
        tag = n > 0 ? `${n} / ${roster} marked` : 'Upcoming';
        tagVariant = 'neutral';
      }
      const subject = cs.subjectTaught ?? cs.subjectName;
      const typeLabel = TEACH_ADHOC_LABEL[(cs.adhocType ?? 'extra') as (typeof TEACH_ADHOC_TYPES)[number]] ?? 'Ad-hoc';
      const room = r.roomName ?? (cs.mode === 'online' ? 'Online' : null);
      const meet = r.meetLink && cs.mode === 'hybrid' ? ' · Meet link attached for hybrid learners' : r.meetLink && cs.mode === 'online' ? ' · online · Meet link attached' : '';
      return {
        id: cs.id,
        batchId: cs.batchId,
        batchCode: r.batchCode,
        kind: cs.kind === 'adhoc' ? 'adhoc' : 'timetabled',
        kicker: cs.kind === 'adhoc' ? `${cs.startTime} · ad-hoc · ${typeLabel.toLowerCase()}` : [`${cs.startTime}–${cs.endTime}`, room, subject].filter(Boolean).join(' · '),
        title: cs.kind === 'adhoc' ? `${r.batchCode} · ${cs.adhocReason ?? subject}` : `${r.batchCode} · ${cs.topic ?? subject}`,
        tag,
        tagVariant,
        marked: n,
        roster,
        submitted,
        primary,
        rosterLine: `${plural(roster, 'student')}${meet}`,
        adhocPending: cs.kind === 'adhoc' && !cs.acknowledgedAt,
      };
    };

    let emptyNote: string | null = null;
    if (timetabled.length === 0) {
      const [next] = await this.db.db
        .select({ date: s.classSession.date, start: s.classSession.startTime, code: s.batch.code })
        .from(s.classSession)
        .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
        .where(and(eq(s.classSession.teacherUserId, c.userId), gt(s.classSession.date, today), eq(s.classSession.kind, 'timetabled'), eq(s.classSession.status, 'scheduled')))
        .orderBy(asc(s.classSession.date), asc(s.classSession.startTime))
        .limit(1);
      emptyNote = next ? `No sessions today · next: ${formatWeekdayDate(next.date)} ${next.start} ${next.code}` : 'No sessions today · nothing scheduled yet';
    }

    const { toGrade, marksMissing, marksMissingNote } = await this.tiles();
    return {
      dateLabel: formatLongWeekdayDate(today),
      greeting: greeting(c.userName),
      sessions: timetabled.map(card),
      adhoc: rows.filter((r) => r.cs.kind === 'adhoc').map(card),
      emptyNote,
      toGrade,
      marksMissing,
      marksMissingNote,
      leaves: await this.leaves(),
      canRequestLeave: can('teaching:leave.request'),
    };
  }

  /** To-grade submissions across my batches; missing marks across my started (or due) draft exams. */
  private async tiles() {
    const batchIds = await this.shared.myBatchIds();
    if (!batchIds.length) return { toGrade: 0, marksMissing: 0, marksMissingNote: 'no draft exams' };
    const [g] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.submission)
      .innerJoin(s.assignment, eq(s.assignment.id, s.submission.assignmentId))
      .where(and(inArray(s.assignment.batchId, batchIds), isNull(s.submission.gradedAt)));
    const exams = await this.db.db
      .select()
      .from(s.exam)
      .where(and(inArray(s.exam.batchId, batchIds), inArray(s.exam.status, ['draft', 'returned'])))
      .orderBy(asc(s.exam.date));
    const today = todayIST();
    const perExam: { name: string; missing: number }[] = [];
    for (const e of exams) {
      const comps = await this.db.db.select().from(s.examComponent).where(eq(s.examComponent.examId, e.id)).orderBy(asc(s.examComponent.position));
      const marks = await this.db.db.select({ enrollmentId: s.mark.enrollmentId, componentId: s.mark.examComponentId, value: s.mark.value }).from(s.mark).where(eq(s.mark.examId, e.id));
      const started = marks.some((m) => m.value != null);
      if (!started && e.date > today) continue;
      const active = await this.db.db.select({ id: s.enrollment.id }).from(s.enrollment).where(and(eq(s.enrollment.batchId, e.batchId), eq(s.enrollment.status, 'active')));
      const roster = [...new Set([...active.map((a) => a.id), ...marks.map((m) => m.enrollmentId)])];
      const defs = comps.map((x) => ({ name: x.name, max: x.maxMarks }));
      const missing = roster.filter((enr) => !evaluateMarkRow(comps.map((cp) => marks.find((m) => m.enrollmentId === enr && m.componentId === cp.id)?.value ?? null), defs).complete).length;
      if (missing) perExam.push({ name: e.name, missing });
    }
    const marksMissing = perExam.reduce((a, x) => a + x.missing, 0);
    const marksMissingNote = perExam.length === 0 ? 'all entered marks complete' : perExam.length === 1 ? `in ${perExam[0]!.name}` : `across ${perExam.length} draft exams`;
    return { toGrade: Number(g?.n ?? 0), marksMissing, marksMissingNote };
  }

  /** My sessions on a date (that would need a substitute). */
  private async sessionsOn(date: string) {
    return this.db.db
      .select({ code: s.batch.code, start: s.classSession.startTime, branchId: s.classSession.branchId, substitute: s.classSession.substituteForUserId })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .where(and(eq(s.classSession.teacherUserId, ctx().userId), eq(s.classSession.date, date), inArray(s.classSession.kind, ['timetabled', 'exam']), eq(s.classSession.status, 'scheduled')))
      .orderBy(asc(s.classSession.startTime));
  }

  private async leaves(): Promise<TeachLeaveRow[]> {
    const c = ctx();
    const today = todayIST();
    const decider = alias(s.user, 'decider');
    const rows = await this.db.db
      .select({ l: s.leave, decidedBy: decider.name })
      .from(s.leave)
      .leftJoin(decider, eq(decider.id, s.leave.decidedBy))
      .where(and(eq(s.leave.userId, c.userId), or(gte(s.leave.date, addDays(today, -7)), eq(s.leave.status, 'pending'))))
      .orderBy(asc(s.leave.date))
      .limit(8);
    const out: TeachLeaveRow[] = [];
    for (const r of rows) {
      const l = r.l;
      // Sessions that day: mine (still to be covered) or handed to a substitute.
      const own = await this.sessionsOn(l.date);
      const subbed = await this.db.db
        .select({ code: s.batch.code, start: s.classSession.startTime, sub: s.user.name })
        .from(s.classSession)
        .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
        .innerJoin(s.user, eq(s.user.id, s.classSession.teacherUserId))
        .where(and(eq(s.classSession.substituteForUserId, c.userId), eq(s.classSession.date, l.date), eq(s.classSession.status, 'scheduled')));
      let sub: string;
      if (l.status === 'rejected' || l.status === 'cancelled') sub = own.length ? `${joinSessions(own)} stays on your timetable` : 'no sessions that day';
      else if (own.length) sub = `${joinSessions(own)} ${l.status === 'pending' ? 'will need' : 'needs'} a substitute`;
      else if (subbed.length) sub = subbed.map((x) => `${x.code} ${x.start} → ${x.sub}`).join(', ');
      else sub = 'no sessions that day';
      const meta: Record<string, { label: string; tag: TeachTag }> = {
        pending: { label: 'Pending', tag: 'outline' },
        approved: { label: r.decidedBy ? `Approved · ${r.decidedBy.split(' ')[0]}` : 'Approved', tag: 'accent' },
        rejected: { label: 'Rejected', tag: 'ink' },
        cancelled: { label: 'Cancelled', tag: 'plain' },
      };
      out.push({
        id: l.id,
        date: l.date,
        title: `${formatWeekdayDate(l.date)} · ${TEACH_LEAVE_LABEL[l.type as LeaveType]}`,
        sub: [l.reason, sub].filter(Boolean).join(' · '),
        statusLabel: meta[l.status]!.label,
        tag: meta[l.status]!.tag,
      });
    }
    return out;
  }

  async leaveImpact(date: string) {
    const own = await this.sessionsOn(date);
    const [existing] = await this.db.db
      .select({ status: s.leave.status })
      .from(s.leave)
      .where(and(eq(s.leave.userId, ctx().userId), eq(s.leave.date, date), inArray(s.leave.status, ['pending', 'approved'])));
    return {
      label: own.length ? `${formatWeekdayDate(date)} · ${joinSessions(own)} will need a substitute` : `${formatWeekdayDate(date)} · no sessions that day`,
      sessions: own.length,
      existing: existing ? `You already have ${existing.status === 'approved' ? 'approved leave' : 'a pending leave request'} for ${formatWeekdayDate(date)}` : null,
    };
  }

  async requestLeave(body: { date: string; type: LeaveType; reason: string }): Promise<{ id: string }> {
    const c = ctx();
    if (body.date < todayIST()) throw invalid('Pick today or a later date', { date: 'Past date' });
    const impact = await this.leaveImpact(body.date);
    if (impact.existing) throw conflict(impact.existing);
    const own = await this.sessionsOn(body.date);
    const branchId = own[0]?.branchId ?? c.selectedBranchId ?? c.membershipBranchIds?.[0] ?? (await this.shared.assignments())[0]?.branchId;
    if (!branchId) throw invalid('Your account is not linked to a branch — ask your administrator');
    return this.db.tx(async (tx) => {
      const [row] = await tx.insert(s.leave).values({ userId: c.userId, branchId, date: body.date, type: body.type, reason: body.reason, status: 'pending' }).returning({ id: s.leave.id });
      const id = row!.id;
      const typeLabel = TEACH_LEAVE_LABEL[body.type];
      await this.events.emit(tx, 'LeaveRequested', { leaveId: id, userId: c.userId, branchId, date: body.date });
      await this.audit.log(tx, {
        action: 'Leave requested',
        kind: 'create',
        entityType: 'leave',
        entityId: id,
        entityLabel: `${c.userName} · ${body.date}`,
        after: { date: body.date, type: body.type, reason: body.reason, status: 'pending' },
        summary: `${formatWeekdayDate(body.date)} · ${typeLabel} · ${body.reason} · ${impact.sessions ? impact.label.split(' · ').slice(1).join(' · ') : 'no sessions that day'}`,
        branchId,
      });
      const admins = await this.shared.branchAdmins(tx, branchId);
      await this.notify.notify(tx, {
        userIds: admins,
        category: 'leave',
        title: `Leave request · ${c.userName}`,
        body: `${formatWeekdayDate(body.date)} · ${typeLabel} · ${body.reason}${impact.sessions ? ` · ${plural(impact.sessions, 'session')} need${impact.sessions === 1 ? 's' : ''} a substitute` : ''}`,
        link: '/branch',
        entityType: 'leave',
        entityId: id,
      });
      this.notify.invalidate(tx, branchId, [['academics'], ['teaching']]);
      return { id };
    });
  }
}
