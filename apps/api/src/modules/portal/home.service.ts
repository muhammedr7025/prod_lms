import { Injectable } from '@nestjs/common';
import type { PortalChild, PortalHome } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from '@exatech/db';
import { daysBetween, formatDayMonth, formatWeekdayDate, gradeFor, minutesOf, todayIST, toISTDate, toISTTime, weekday, type GradeBand } from '@exatech/domain';
import type { StudentScope } from '../../core/scope.service';
import { firstName, initials, plural, PortalShared, STAFF_HOURS } from './portal.shared';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Student · Home and Parent · Home (per child), plus the child switcher. */
@Injectable()
export class HomeService {
  constructor(private readonly shared: PortalShared) {}

  private get db() {
    return this.shared.db.db;
  }

  async children(): Promise<{ items: PortalChild[] }> {
    const list = await this.shared.all();
    const items: PortalChild[] = [];
    for (const sc of list) {
      const fee = await this.shared.feeSummary(sc);
      items.push({
        studentId: sc.studentId,
        enrollmentId: sc.enrollmentId,
        name: sc.name,
        firstName: firstName(sc.name),
        initials: initials(sc.name),
        admissionNo: sc.admissionNo,
        batchCode: sc.batchCode,
        batchLong: await this.shared.batchLong(sc),
        feeState: fee.card.state,
        dueAmount: fee.card.state === 'cleared' ? 0 : fee.card.amount,
        pay: fee.card.state === 'cleared' ? null : fee.pay,
      });
    }
    return { items };
  }

  async home(studentId?: string): Promise<PortalHome> {
    const sc = await this.shared.resolve(studentId);
    const now = new Date();
    const today = todayIST(now);
    const [fee, att, next, pending, exam, latest, todayCard, teachers, batchLong] = await Promise.all([
      this.shared.feeSummary(sc, today),
      this.shared.attendance(sc.enrollmentId),
      this.shared.nextSession(sc.batchId, now),
      this.pendingWork(sc, now),
      this.upcomingExam(sc, today),
      this.latestMarks(sc),
      this.today(sc, now),
      this.shared.batchTeachers(sc.batchId),
      this.shared.batchLong(sc),
    ]);
    return {
      student: {
        studentId: sc.studentId,
        enrollmentId: sc.enrollmentId,
        name: sc.name,
        firstName: firstName(sc.name),
        admissionNo: sc.admissionNo,
        batchCode: sc.batchCode,
        courseName: sc.courseName,
        kicker: [sc.batchCode, sc.courseName, sc.admissionNo].filter(Boolean).join(' · '),
        batchLong,
      },
      fee: fee.card,
      pay: fee.pay,
      attendance: {
        pct: att.pct,
        attended: att.attended,
        total: att.total,
        threshold: att.threshold,
        low: att.low,
        line: att.total ? `${att.attended} of ${plural(att.total, 'session')} · threshold ${att.threshold}%` : `No sessions marked yet · threshold ${att.threshold}%`,
        note: att.low ? `below ${att.threshold}% threshold` : att.total ? `${att.attended} of ${plural(att.total, 'session')}` : 'no sessions yet',
        next: next ? `Next: ${next}` : null,
      },
      pendingWork: pending,
      upcomingExam: exam,
      latestMarks: latest,
      today: todayCard,
      contact: { teacherNames: teachers.map((t) => t.name), staffHours: STAFF_HOURS },
    };
  }

  /** Open assignments not yet submitted (late-but-accepted ones count too). */
  private async pendingWork(sc: StudentScope, now: Date): Promise<{ count: number; note: string }> {
    const rows = await this.db
      .select({ id: s.assignment.id, title: s.assignment.title, dueAt: s.assignment.dueAt, latePolicy: s.assignment.latePolicy })
      .from(s.assignment)
      .leftJoin(s.submission, and(eq(s.submission.assignmentId, s.assignment.id), eq(s.submission.enrollmentId, sc.enrollmentId)))
      .where(and(eq(s.assignment.batchId, sc.batchId), eq(s.assignment.status, 'open'), isNull(s.submission.id)))
      .orderBy(asc(s.assignment.dueAt));
    const open = rows.filter((r) => r.dueAt.getTime() >= now.getTime() || r.latePolicy !== 'not_accepted');
    if (open.length === 0) return { count: 0, note: 'all caught up' };
    const first = open[0]!;
    const due = formatWeekdayDate(toISTDate(first.dueAt));
    const late = first.dueAt.getTime() < now.getTime();
    return { count: open.length, note: open.length === 1 ? `${late ? 'was due' : 'due'} ${due}` : `next ${late ? 'was due' : 'due'} ${due}` };
  }

  private async upcomingExam(sc: StudentScope, today: string) {
    const [e] = await this.db
      .select({ name: s.exam.name, date: s.exam.date, start: s.exam.startTime, room: s.exam.room })
      .from(s.exam)
      .where(and(eq(s.exam.batchId, sc.batchId), sql`${s.exam.date} >= ${today}::date`))
      .orderBy(asc(s.exam.date))
      .limit(1);
    if (!e) return null;
    const soon = daysBetween(today, e.date) <= 6;
    const short = e.name.split(' · ')[0] ?? e.name;
    return {
      date: e.date,
      day: daysBetween(today, e.date) === 0 ? 'Today' : soon ? WEEKDAY[weekday(e.date)]! : formatDayMonth(e.date),
      label: [short, e.room, e.start].filter(Boolean).join(' · '),
    };
  }

  /** Latest published exam for this enrollment ("86%" · "Module 1 · Foundations · A"). */
  private async latestMarks(sc: StudentScope) {
    const [e] = await this.db
      .select({ id: s.exam.id, name: s.exam.name, scheme: s.course.gradeScheme })
      .from(s.exam)
      .innerJoin(s.batch, eq(s.batch.id, s.exam.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(and(eq(s.exam.batchId, sc.batchId), eq(s.exam.status, 'published')))
      .orderBy(desc(s.exam.date))
      .limit(1);
    if (!e) return null;
    const comps = await this.db.select({ id: s.examComponent.id, max: s.examComponent.maxMarks }).from(s.examComponent).where(eq(s.examComponent.examId, e.id));
    if (comps.length === 0) return null;
    const marks = await this.db
      .select({ value: s.mark.value })
      .from(s.mark)
      .where(and(eq(s.mark.examId, e.id), eq(s.mark.enrollmentId, sc.enrollmentId), inArray(s.mark.examComponentId, comps.map((c) => c.id))));
    const max = comps.reduce((a, c) => a + c.max, 0);
    if (!max || marks.length < comps.length || marks.some((m) => m.value == null)) return null;
    const score = marks.reduce((a, m) => a + (m.value ?? 0), 0);
    const pct = Math.round((score / max) * 100);
    return { score: `${pct}%`, label: `${e.name} · ${gradeFor(pct, (e.scheme as GradeBand[] | null) ?? undefined)}` };
  }

  /** Parent "Today" card: today's class and this child's mark. */
  private async today(sc: StudentScope, now: Date): Promise<PortalHome['today']> {
    const today = todayIST(now);
    const [hol] = await this.db
      .select({ name: s.holiday.name })
      .from(s.holiday)
      .where(and(eq(s.holiday.date, today), sql`(${s.holiday.branchId} is null or ${s.holiday.branchId} = ${sc.branchId})`))
      .limit(1);
    const sessions = await this.db
      .select({
        id: s.classSession.id,
        start: s.classSession.startTime,
        topic: s.classSession.topic,
        subject: s.classSession.subjectName,
        submittedAt: s.classSession.attendanceSubmittedAt,
        room: s.room.name,
        mode: s.classSession.mode,
        status: s.attendance.status,
        markedAt: s.attendance.markedAt,
      })
      .from(s.classSession)
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .leftJoin(s.attendance, and(eq(s.attendance.sessionId, s.classSession.id), eq(s.attendance.enrollmentId, sc.enrollmentId)))
      .where(and(eq(s.classSession.batchId, sc.batchId), eq(s.classSession.date, today), ne(s.classSession.kind, 'exam'), inArray(s.classSession.status, ['scheduled', 'held'])))
      .orderBy(asc(s.classSession.startTime));
    if (sessions.length === 0) {
      const next = await this.shared.nextSession(sc.batchId, now);
      return { title: hol ? `Holiday · ${hol.name}` : 'No class today', sub: next ? `Next: ${next}` : 'No upcoming sessions scheduled', tone: 'none' };
    }
    const nowMin = minutesOf(toISTTime(now));
    // The most relevant session: the latest one that has started, else the first.
    const started = sessions.filter((x) => minutesOf(x.start) <= nowMin);
    const x = started[started.length - 1] ?? sessions[0]!;
    const where = x.mode === 'online' ? 'Online' : (x.room ?? 'Room TBA');
    const sub = [x.topic ?? x.subject, where].join(' · ');
    const head = `${sc.batchCode} ${x.start}`;
    if (x.status === 'A') {
      const alertAt = x.submittedAt ?? x.markedAt;
      return { title: `${head} · Absent${alertAt ? ` — alert sent ${toISTTime(alertAt)}` : ''}`, sub, tone: 'absent' };
    }
    if (x.status === 'P') return { title: `${head} · Present`, sub, tone: 'present' };
    if (x.status === 'L') return { title: `${head} · Late`, sub, tone: 'present' };
    if (x.status === 'E') return { title: `${head} · Excused`, sub, tone: 'none' };
    if (minutesOf(x.start) > nowMin) return { title: `${head} · Starts at ${x.start}`, sub, tone: 'pending' };
    return { title: `${head} · Not marked yet`, sub: `${sub} · attendance is marked in class`, tone: 'pending' };
  }
}
