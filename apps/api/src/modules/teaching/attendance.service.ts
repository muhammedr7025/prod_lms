import { Injectable } from '@nestjs/common';
import { TEACH_ADHOC_LABEL, TEACH_ADHOC_TYPES, TEACH_SUBJECT_EXTRAS, type TeachAttCounts, type TeachAttendanceSession } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, inArray, lte, sql, type DbOrTx, type Tx } from '@exatech/db';
import {
  addDays,
  ATTENDANCE_LABEL,
  attendanceCounts,
  DEFAULT_SLOTS,
  formatWeekdayDate,
  istDateTime,
  minutesOf,
  QR_ROTATE_SECONDS,
  teacherCanEditAttendance,
  timeFromMinutes,
  todayIST,
  toISTDate,
  toISTTime,
  type AttendanceStatus,
} from '@exatech/domain';
import bwipjs from 'bwip-js';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, DomainError, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { RedisService } from '../../core/redis';
import { ScopeService } from '../../core/scope.service';
import { AcademicsShared } from '../academics/academics.shared';
import { plural, TeachingShared } from './teaching.shared';

type AdhocType = (typeof TEACH_ADHOC_TYPES)[number];
type Session = typeof s.classSession.$inferSelect;

const SLOT_MIN = 120;
/** QR check-in after this many minutes past the start marks Late. */
const LATE_AFTER_MIN = 15;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const dayLabel = (date: string, today = todayIST()) => (date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : formatWeekdayDate(date));
const firstName = (name: string) => name.split(' ')[0] ?? name;

function emptyCounts(): TeachAttCounts {
  return { P: 0, A: 0, L: 0, E: 0 };
}

/** Rotating check-in code: HMAC(session id + 5-minute window) → "EXA-4F7K-2Q". */
export function checkinCode(sessionId: string, window: number): string {
  const mac = crypto.createHmac('sha256', env().AUTH_SECRET).update(`qr:${sessionId}:${window}`).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[mac[i]! % CODE_ALPHABET.length];
  return `EXA-${out.slice(0, 4)}-${out.slice(4)}`;
}

const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Attendance (teacher): session picker, roster with optimistic taps and
 * idempotent autosave, submit (absence alerts, attendance % recompute),
 * 48 h edit window, QR self check-in and ad-hoc "cover another class".
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: Db,
    private readonly shared: TeachingShared,
    private readonly academics: AcademicsShared,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly redis: RedisService,
  ) {}

  private async editWindowHours(): Promise<number> {
    return (await this.shared.settings()).attendanceEditWindowHours ?? 48;
  }

  /** My sessions today and in the last 48 h, newest day first (time order within a day). */
  private async recentSessions() {
    const today = todayIST();
    const cutoff = Date.now() - 48 * 3_600_000;
    const rows = await this.db.db
      .select({ cs: s.classSession, batchCode: s.batch.code })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .where(
        and(
          eq(s.classSession.teacherUserId, ctx().userId),
          inArray(s.classSession.kind, ['timetabled', 'adhoc']),
          inArray(s.classSession.status, ['scheduled', 'held']),
          gte(s.classSession.date, addDays(today, -2)),
          lte(s.classSession.date, today),
        ),
      )
      .orderBy(desc(s.classSession.date), asc(s.classSession.startTime));
    return rows.filter((r) => r.cs.date === today || istDateTime(r.cs.date, r.cs.endTime).getTime() >= cutoff);
  }

  private optionLabel(cs: Session, batchCode: string): string {
    return `${batchCode} · ${dayLabel(cs.date)} ${cs.startTime}${cs.kind === 'adhoc' ? ' · ad-hoc' : ''}`;
  }

  async get(sessionId?: string): Promise<{ options: { id: string; label: string }[]; session: TeachAttendanceSession | null }> {
    const recent = await this.recentSessions();
    const options = recent.map((r) => ({ id: r.cs.id, label: this.optionLabel(r.cs, r.batchCode) }));
    let id = sessionId;
    if (!id) {
      const today = todayIST();
      const todays = recent.filter((r) => r.cs.date === today && r.cs.kind === 'timetabled');
      id = (todays.find((r) => !r.cs.attendanceSubmittedAt) ?? todays[todays.length - 1] ?? recent[0])?.cs.id;
    }
    if (!id) return { options, session: null };
    const session = await this.session(id);
    if (!options.some((o) => o.id === id)) {
      const [b] = await this.db.db.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, session.batchId));
      const [cs] = await this.db.db.select().from(s.classSession).where(eq(s.classSession.id, id));
      options.push({ id, label: this.optionLabel(cs!, b?.code ?? '') });
    }
    return { options, session };
  }

  /** Enrollment ids that already received a same-day absence alert for this session. */
  private async alertedEnrollments(dbx: DbOrTx, sessionId: string, enrollmentIds: string[]): Promise<Set<string>> {
    if (!enrollmentIds.length) return new Set();
    const sent = await dbx
      .selectDistinct({ userId: s.notification.userId })
      .from(s.notification)
      .where(and(eq(s.notification.entityType, 'class_session'), eq(s.notification.entityId, sessionId), eq(s.notification.category, 'attendance')));
    if (!sent.length) return new Set();
    const users = new Set(sent.map((x) => x.userId));
    const links = await this.shared.guardians(enrollmentIds);
    return new Set(links.filter((l) => l.guardianUserIds.some((g) => users.has(g))).map((l) => l.enrollmentId));
  }

  /** Roster for a session: the batch's active enrollments plus anyone already marked. */
  private async sessionRoster(dbx: DbOrTx, cs: Session) {
    const active = await this.shared.roster(cs.batchId, dbx);
    const rows = await dbx.select().from(s.attendance).where(eq(s.attendance.sessionId, cs.id));
    const extra = rows.filter((r) => !active.some((a) => a.enrollmentId === r.enrollmentId)).map((r) => r.enrollmentId);
    const extraPeople = extra.length
      ? await dbx
          .select({ enrollmentId: s.enrollment.id, studentId: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo, userId: s.student.userId })
          .from(s.enrollment)
          .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
          .where(inArray(s.enrollment.id, extra))
      : [];
    const people = [...active, ...extraPeople].sort((a, b) => a.name.localeCompare(b.name));
    return { people, rows };
  }

  private async session(id: string): Promise<TeachAttendanceSession> {
    const cs = await this.shared.mySession(id);
    if (cs.kind === 'exam') throw invalid('Exam sessions do not take attendance — enter marks instead');
    const [b] = await this.db.db.select({ code: s.batch.code, courseId: s.batch.courseId }).from(s.batch).where(eq(s.batch.id, cs.batchId));
    const { people, rows } = await this.sessionRoster(this.db.db, cs);
    const alerted = await this.alertedEnrollments(
      this.db.db,
      cs.id,
      rows.filter((r) => r.status === 'A').map((r) => r.enrollmentId),
    );
    const roster = people.map((p) => {
      const r = rows.find((x) => x.enrollmentId === p.enrollmentId);
      return { enrollmentId: p.enrollmentId, studentId: p.studentId, name: p.name, admissionNo: p.admissionNo, status: (r?.status ?? null) as AttendanceStatus | null, source: r?.source ?? null, alerted: alerted.has(p.enrollmentId) };
    });
    const window = await this.editWindowHours();
    const today = todayIST();
    const submitted = !!cs.attendanceSubmittedAt;
    const inWindow = teacherCanEditAttendance(cs.attendanceSubmittedAt, new Date(), window);
    let lockedReason: string | null = null;
    if (cs.date > today) lockedReason = `This session is on ${formatWeekdayDate(cs.date)} — mark attendance on the day.`;
    else if (!inWindow) lockedReason = `Submitted ${this.when(cs.attendanceSubmittedAt!)} · the ${window} h edit window has closed. Changes now need a Branch Admin override with a reason.`;
    const lastMarked = rows.reduce<Date | null>((a, r) => (!a || r.markedAt > a ? r.markedAt : a), null);

    const as = await this.shared.assignments();
    const mine = as.find((a) => a.batchId === cs.batchId);
    const assignedSubject = mine?.subjectName ?? cs.subjectName;
    const subjects = await this.db.db.select({ name: s.courseSubject.name }).from(s.courseSubject).where(eq(s.courseSubject.courseId, b!.courseId)).orderBy(asc(s.courseSubject.position));
    const current = cs.subjectTaught ?? cs.subjectName;
    const subjectOptions = [...new Set([assignedSubject, cs.subjectName, ...subjects.map((x) => x.name), current, ...TEACH_SUBJECT_EXTRAS])];

    return {
      sessionId: cs.id,
      batchId: cs.batchId,
      batchCode: b?.code ?? '',
      kicker: `${b?.code ?? ''} · ${formatWeekdayDate(cs.date)} · ${cs.startTime}${cs.kind === 'adhoc' ? ` · ad-hoc ${(TEACH_ADHOC_LABEL[cs.adhocType as AdhocType] ?? '').toLowerCase()}` : ''}`,
      date: cs.date,
      startTime: cs.startTime,
      kind: cs.kind === 'adhoc' ? 'adhoc' : 'timetabled',
      adhocPending: cs.kind === 'adhoc' && !cs.acknowledgedAt,
      submitted,
      submittedLabel: submitted ? `Submitted ${this.when(cs.attendanceSubmittedAt!)}` : null,
      savedLabel: lastMarked ? `Saved ${this.when(lastMarked)}` : 'Not started',
      canEdit: lockedReason === null,
      lockedReason,
      editWindowHours: window,
      assignedSubject,
      subjectTaught: current,
      subjectOptions,
      roster,
      counts: attendanceCounts(roster.map((r) => r.status)),
    };
  }

  /** "16:42" today, "Fri 9 Oct 16:42" otherwise (IST). */
  private when(at: Date): string {
    const d = toISTDate(at);
    return d === todayIST() ? toISTTime(at) : `${formatWeekdayDate(d)} ${toISTTime(at)}`;
  }

  private async assertMarkable(cs: Session) {
    if (cs.kind === 'exam') throw invalid('Exam sessions do not take attendance');
    if (cs.status === 'cancelled' || cs.status === 'suppressed') throw conflict('This session was cancelled — there is nothing to mark');
    if (cs.date > todayIST()) throw invalid(`This session is on ${formatWeekdayDate(cs.date)} — mark attendance on the day`);
    const window = await this.editWindowHours();
    if (!teacherCanEditAttendance(cs.attendanceSubmittedAt, new Date(), window)) {
      throw forbidden(`The ${window} h edit window has closed. Changes now need a Branch Admin override with a reason.`);
    }
  }

  /** Same-day absence alert to the parents of each absentee (in-app + WhatsApp absence_alert). */
  private async sendAbsenceAlerts(tx: Tx, cs: Session, batchCode: string, absentees: { enrollmentId: string; name: string }[]): Promise<number> {
    if (!absentees.length) return 0;
    const links = await this.shared.guardians(absentees.map((a) => a.enrollmentId));
    const subject = cs.subjectTaught ?? cs.subjectName;
    let sent = 0;
    for (const a of absentees) {
      const guardians = links.find((l) => l.enrollmentId === a.enrollmentId)?.guardianUserIds ?? [];
      if (!guardians.length) continue;
      const when = cs.date === todayIST() ? 'today' : `on ${formatWeekdayDate(cs.date)}`;
      await this.notify.notify(tx, {
        userIds: guardians,
        category: 'attendance',
        title: `${firstName(a.name)} absent ${when}`,
        body: `${batchCode} · ${subject} · ${cs.startTime} session · marked absent`,
        link: '/parent/attendance',
        entityType: 'class_session',
        entityId: cs.id,
        whatsapp: {
          template: 'absence_alert',
          body: `Exatech: ${a.name} was marked absent ${when} for ${batchCode} · ${subject} (${cs.startTime}). If this is unexpected, please contact the branch.`,
        },
      });
      sent++;
    }
    return sent;
  }

  async mark(sessionId: string, marks: { enrollmentId: string; status: AttendanceStatus }[]) {
    return this.db.tx(async (tx) => {
      const cs = await this.shared.mySession(sessionId, tx, true);
      await this.assertMarkable(cs);
      const { people, rows } = await this.sessionRoster(tx, cs);
      const byId = new Map(people.map((p) => [p.enrollmentId, p]));
      const latest = new Map<string, AttendanceStatus>();
      for (const m of marks) {
        if (!byId.has(m.enrollmentId)) throw invalid('One of the students is not on this batch roster');
        latest.set(m.enrollmentId, m.status);
      }
      const c = ctx();
      const now = new Date();
      const changes: { enrollmentId: string; name: string; from: AttendanceStatus | null; to: AttendanceStatus }[] = [];
      for (const [enrollmentId, status] of latest) {
        const before = rows.find((r) => r.enrollmentId === enrollmentId);
        if (before?.status === status) continue;
        changes.push({ enrollmentId, name: byId.get(enrollmentId)!.name, from: (before?.status ?? null) as AttendanceStatus | null, to: status });
      }
      if (changes.length) {
        await tx
          .insert(s.attendance)
          .values(changes.map((ch) => ({ sessionId, enrollmentId: ch.enrollmentId, status: ch.to, source: 'teacher' as const, markedBy: c.userId, markedAt: now })))
          .onConflictDoUpdate({
            target: [s.attendance.sessionId, s.attendance.enrollmentId],
            set: { status: sql`excluded.status`, source: sql`excluded.source`, markedBy: sql`excluded.marked_by`, markedAt: sql`excluded.marked_at` },
          });
      }
      if (changes.length && cs.attendanceSubmittedAt) {
        // Post-submit edit (inside the window): audit, keep the cached % right, alert new absentees.
        const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, cs.batchId));
        const window = await this.editWindowHours();
        const label = (x: AttendanceStatus | null) => (x ? ATTENDANCE_LABEL[x].toLowerCase() : 'unmarked');
        await this.audit.log(tx, {
          action: 'Attendance edited',
          kind: 'update',
          entityType: 'class_session',
          entityId: cs.id,
          entityLabel: `${b?.code ?? ''} · ${formatWeekdayDate(cs.date)} ${cs.startTime}`,
          before: Object.fromEntries(changes.map((ch) => [ch.enrollmentId, ch.from])),
          after: Object.fromEntries(changes.map((ch) => [ch.enrollmentId, ch.to])),
          summary: `${changes.map((ch) => `${ch.name}: ${label(ch.from)} → ${label(ch.to)}`).join(' · ')} (within ${window} h)`,
          branchId: cs.branchId,
        });
        await this.academics.recomputeBatchAttendance(tx, cs.batchId);
        const newlyAbsent = changes.filter((ch) => ch.to === 'A');
        if (newlyAbsent.length && cs.date === todayIST()) {
          const already = await this.alertedEnrollments(
            tx,
            cs.id,
            newlyAbsent.map((x) => x.enrollmentId),
          );
          await this.sendAbsenceAlerts(
            tx,
            cs,
            b?.code ?? '',
            newlyAbsent.filter((x) => !already.has(x.enrollmentId)),
          );
        }
        this.notify.invalidate(tx, cs.branchId, [['teaching'], ['academics'], ['students'], ['portal']]);
      }
      const all = await tx.select({ status: s.attendance.status }).from(s.attendance).where(eq(s.attendance.sessionId, sessionId));
      return { savedAt: now, counts: attendanceCounts(all.map((x) => x.status as AttendanceStatus)) };
    });
  }

  async setSubject(sessionId: string, subject: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const cs = await this.shared.mySession(sessionId, tx, true);
      if (cs.kind === 'exam') throw invalid('Exam sessions keep their subject');
      const before = cs.subjectTaught ?? cs.subjectName;
      if (before === subject) return;
      const [b] = await tx.select({ code: s.batch.code, courseId: s.batch.courseId }).from(s.batch).where(eq(s.batch.id, cs.batchId));
      const subjects = await tx.select({ name: s.courseSubject.name }).from(s.courseSubject).where(eq(s.courseSubject.courseId, b!.courseId));
      const mine = (await this.shared.assignments()).find((a) => a.batchId === cs.batchId)?.subjectName;
      const allowed = new Set([cs.subjectName, mine, ...subjects.map((x) => x.name), ...TEACH_SUBJECT_EXTRAS].filter(Boolean));
      if (!allowed.has(subject)) throw invalid('Pick a subject from the syllabus or Doubt-clearing / Revision / Guest lecture', { subject: 'Unknown subject' });
      const subjectTaught = subject === cs.subjectName ? null : subject;
      await tx.update(s.classSession).set({ subjectTaught }).where(eq(s.classSession.id, cs.id));
      const label = `${b?.code ?? ''} · ${formatWeekdayDate(cs.date)} ${cs.startTime}`;
      await this.audit.log(tx, {
        action: 'Subject taught tagged',
        kind: 'update',
        entityType: 'class_session',
        entityId: cs.id,
        entityLabel: label,
        before: { subjectTaught: cs.subjectTaught },
        after: { subjectTaught },
        summary: `${label} · ${before} → ${subject} (syllabus log)`,
        branchId: cs.branchId,
      });
      // Inform the teacher who owns that subject in this batch (when it is someone else).
      const owners = await tx
        .select({ userId: s.teacherAssignment.teacherUserId })
        .from(s.teacherAssignment)
        .where(and(eq(s.teacherAssignment.batchId, cs.batchId), eq(s.teacherAssignment.subjectName, subject), eq(s.teacherAssignment.active, true)));
      const me = ctx();
      const notifyIds = owners.map((o) => o.userId).filter((u) => u !== me.userId);
      if (notifyIds.length) {
        await this.notify.notify(tx, {
          userIds: notifyIds,
          category: 'timetable',
          title: `${b?.code ?? ''} · ${subject} taught by ${me.userName}`,
          body: `${formatWeekdayDate(cs.date)} ${cs.startTime} session was tagged ${subject} — the syllabus log is updated`,
          link: '/teacher',
          entityType: 'class_session',
          entityId: cs.id,
        });
      }
      this.notify.invalidate(tx, cs.branchId, [['teaching'], ['academics']]);
    });
  }

  async submit(sessionId: string) {
    return this.db.tx(async (tx) => {
      const cs = await this.shared.mySession(sessionId, tx, true);
      if (cs.attendanceSubmittedAt) throw conflict(`Attendance was already submitted ${this.when(cs.attendanceSubmittedAt)} — changes save automatically`);
      await this.assertMarkable(cs);
      const { people, rows } = await this.sessionRoster(tx, cs);
      const unmarked = people.filter((p) => !rows.some((r) => r.enrollmentId === p.enrollmentId));
      if (unmarked.length) throw invalid(`${plural(unmarked.length, 'student')} ${unmarked.length === 1 ? 'is' : 'are'} not marked yet — tap Mark all present, then mark the exceptions`);
      if (!people.length) throw invalid('Nobody is on this batch roster');
      const c = ctx();
      const now = new Date();
      await tx.update(s.classSession).set({ attendanceSubmittedAt: now, attendanceSubmittedBy: c.userId, status: 'held' }).where(eq(s.classSession.id, cs.id));
      const counts = attendanceCounts(rows.map((r) => r.status as AttendanceStatus));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, cs.batchId));
      const absentees = rows.filter((r) => r.status === 'A').map((r) => ({ enrollmentId: r.enrollmentId, name: people.find((p) => p.enrollmentId === r.enrollmentId)?.name ?? 'Student' }));
      const alerted = await this.sendAbsenceAlerts(tx, cs, b?.code ?? '', absentees);
      await this.academics.recomputeBatchAttendance(tx, cs.batchId);
      await this.events.emit(tx, 'AttendanceSubmitted', {
        sessionId: cs.id,
        branchId: cs.branchId,
        batchId: cs.batchId,
        absentEnrollmentIds: absentees.map((a) => a.enrollmentId),
        present: counts.P + counts.L,
        absent: counts.A,
      });
      const label = `${b?.code ?? ''} · ${formatWeekdayDate(cs.date)} ${cs.startTime}`;
      await this.audit.log(tx, {
        action: 'Attendance submitted',
        kind: 'create',
        entityType: 'class_session',
        entityId: cs.id,
        entityLabel: label,
        before: { submitted: false },
        after: { ...counts, alerted },
        summary: `${label}${cs.kind === 'adhoc' ? ' (ad-hoc)' : ''} · ${counts.P} present · ${counts.A} absent · ${counts.L} late · ${counts.E} excused · ${plural(alerted, 'parent alert')} sent`,
        branchId: cs.branchId,
      });
      this.notify.invalidate(tx, cs.branchId, [['teaching'], ['academics'], ['students'], ['portal']]);
      return { present: counts.P + counts.L, absent: counts.A, alerted };
    });
  }

  /* ───────────────────────── QR self check-in ───────────────────────── */

  private window(now = Date.now()) {
    return Math.floor(now / 1000 / QR_ROTATE_SECONDS);
  }

  async qr(sessionId: string) {
    const cs = await this.shared.mySession(sessionId);
    if (cs.kind === 'exam') throw invalid('Exam sessions do not take attendance');
    if (cs.date !== todayIST()) throw invalid('QR check-in only works for today’s sessions');
    const w = this.window();
    const code = checkinCode(cs.id, w);
    const [present] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.attendance)
      .where(and(eq(s.attendance.sessionId, cs.id), inArray(s.attendance.status, ['P', 'L'])));
    const [roster] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.enrollment)
      .where(and(eq(s.enrollment.batchId, cs.batchId), eq(s.enrollment.status, 'active')));
    const svg = bwipjs.toSVG({ bcid: 'qrcode', text: code, scale: 4, paddingwidth: 2, paddingheight: 2 });
    return { code, expiresAt: new Date((w + 1) * QR_ROTATE_SECONDS * 1000), rotateSeconds: QR_ROTATE_SECONDS, presentSoFar: Number(present?.n ?? 0), roster: Number(roster?.n ?? 0), svg };
  }

  /** Student side (portal): validate the code for a session of my batch today and mark P / L. */
  async checkIn(rawCode: string): Promise<{ sessionLabel: string; status: 'P' | 'L'; alreadyMarked: boolean }> {
    const c = ctx();
    if (!(await this.redis.rateLimit(`checkin:${c.userId}`, 10, 300))) throw new DomainError('RATE_LIMITED', 'Too many check-in attempts — wait a few minutes and try again', 429);
    const enrollments = await this.scope.studentEnrollments();
    if (!enrollments.length) throw forbidden('No active enrollment linked to this account');
    const today = todayIST();
    const sessions = await this.db.db
      .select({ cs: s.classSession, batchCode: s.batch.code })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .where(
        and(
          inArray(
            s.classSession.batchId,
            enrollments.map((e) => e.batchId),
          ),
          eq(s.classSession.date, today),
          inArray(s.classSession.kind, ['timetabled', 'adhoc']),
          inArray(s.classSession.status, ['scheduled', 'held']),
        ),
      );
    const want = normaliseCode(rawCode);
    const w = this.window();
    const hit = sessions.find((x) => [w, w - 1].some((win) => normaliseCode(checkinCode(x.cs.id, win)) === want));
    if (!hit) throw invalid('This code is not valid for your batch right now — codes rotate every 5 minutes. Ask your teacher for the current code.', { code: 'Invalid or expired' });
    const cs = hit.cs;
    const enr = enrollments.find((e) => e.batchId === cs.batchId)!;
    const sessionLabel = `${hit.batchCode} · ${cs.subjectTaught ?? cs.subjectName} · ${cs.startTime}`;
    const late = minutesOf(toISTTime(new Date())) - minutesOf(cs.startTime) > LATE_AFTER_MIN;
    const status: 'P' | 'L' = late ? 'L' : 'P';
    return this.db.tx(async (tx) => {
      const [existing] = await tx
        .select()
        .from(s.attendance)
        .where(and(eq(s.attendance.sessionId, cs.id), eq(s.attendance.enrollmentId, enr.enrollmentId)));
      if (existing) return { sessionLabel, status: existing.status === 'L' || existing.status === 'P' ? existing.status : status, alreadyMarked: true };
      const inserted = await tx
        .insert(s.attendance)
        .values({ sessionId: cs.id, enrollmentId: enr.enrollmentId, status, source: 'qr', markedBy: c.userId })
        .onConflictDoNothing()
        .returning({ id: s.attendance.id });
      if (!inserted.length) return { sessionLabel, status, alreadyMarked: true };
      if (cs.attendanceSubmittedAt) await this.academics.recomputeBatchAttendance(tx, cs.batchId);
      await this.audit.log(tx, {
        action: 'QR check-in',
        kind: 'create',
        entityType: 'attendance',
        entityId: inserted[0]!.id,
        entityLabel: `${enr.name} · ${sessionLabel}`,
        after: { status, source: 'qr' },
        summary: `${enr.name} · ${hit.batchCode} ${cs.startTime} · self check-in → ${ATTENDANCE_LABEL[status].toLowerCase()}`,
        branchId: cs.branchId,
      });
      this.notify.invalidateUsers(tx, [cs.teacherUserId], [['teaching']]);
      return { sessionLabel, status, alreadyMarked: false };
    });
  }

  /* ───────────────────────── Cover another class (ad-hoc) ───────────────────────── */

  private membershipBranchFilter() {
    const b = ctx().membershipBranchIds;
    return b === null ? undefined : inArray(s.batch.branchId, b.length ? b : ['00000000-0000-0000-0000-000000000000']);
  }

  async coverOptions() {
    const rows = await this.db.db
      .select({ id: s.batch.id, code: s.batch.code, courseName: s.course.name })
      .from(s.batch)
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(and(this.membershipBranchFilter(), inArray(s.batch.status, ['running', 'open', 'waitlist'])))
      .orderBy(asc(s.batch.code));
    const teachers = rows.length
      ? await this.db.db
          .select({ batchId: s.teacherAssignment.batchId, name: s.user.name, isPrimary: s.teacherAssignment.isPrimary })
          .from(s.teacherAssignment)
          .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
          .where(and(inArray(s.teacherAssignment.batchId, rows.map((r) => r.id)), eq(s.teacherAssignment.active, true)))
      : [];
    const now = minutesOf(toISTTime(new Date()));
    const nowSlot = timeFromMinutes(Math.floor(now / 5) * 5);
    return {
      batches: rows.map((r) => {
        const t = teachers.filter((x) => x.batchId === r.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
        return { id: r.id, code: r.code, label: `${r.code} · ${r.courseName}`, regularTeacher: t?.name ?? null };
      }),
      types: TEACH_ADHOC_TYPES.map((t) => ({ value: t, label: TEACH_ADHOC_LABEL[t] })),
      slots: [{ value: nowSlot, label: `Now · ${nowSlot}` }, ...DEFAULT_SLOTS.filter((x) => x !== nowSlot).map((x) => ({ value: x, label: x }))],
    };
  }

  async startCover(body: { batchId: string; type: AdhocType; start: string; reason: string }): Promise<{ sessionId: string }> {
    const [b] = await this.db.db.select().from(s.batch).where(eq(s.batch.id, body.batchId));
    if (!b) throw notFound('Batch');
    assertBranchAccess(b.branchId);
    if (!['running', 'open', 'waitlist'].includes(b.status)) throw invalid(`${b.code} is ${b.status} — pick a live batch`);
    const c = ctx();
    const today = todayIST();
    return this.db.tx(async (tx) => {
      const assignments = await tx
        .select({ userId: s.teacherAssignment.teacherUserId, subjectName: s.teacherAssignment.subjectName, isPrimary: s.teacherAssignment.isPrimary })
        .from(s.teacherAssignment)
        .where(and(eq(s.teacherAssignment.batchId, b.id), eq(s.teacherAssignment.active, true)));
      const mine = assignments.find((a) => a.userId === c.userId);
      const regular = assignments.filter((a) => a.userId !== c.userId).sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary))[0] ?? null;
      const [course] = await tx.select({ name: s.course.name }).from(s.course).where(eq(s.course.id, b.courseId));
      const subjectName = mine?.subjectName ?? regular?.subjectName ?? course?.name ?? b.code;
      const clash = await tx
        .select({ id: s.classSession.id, start: s.classSession.startTime })
        .from(s.classSession)
        .where(and(eq(s.classSession.batchId, b.id), eq(s.classSession.date, today), eq(s.classSession.startTime, body.start), eq(s.classSession.kind, 'adhoc'), inArray(s.classSession.status, ['scheduled', 'held'])));
      if (clash.length) throw conflict(`An ad-hoc session for ${b.code} at ${body.start} already exists today — open it from Attendance`);
      const end = timeFromMinutes(Math.min(minutesOf(body.start) + SLOT_MIN, 23 * 60 + 59));
      const [row] = await tx
        .insert(s.classSession)
        .values({
          branchId: b.branchId,
          batchId: b.id,
          teacherUserId: c.userId,
          subjectName,
          date: today,
          startTime: body.start,
          endTime: end,
          mode: b.mode,
          kind: 'adhoc',
          adhocType: body.type,
          adhocReason: body.reason,
          status: 'scheduled',
          createdBy: c.userId,
        })
        .returning({ id: s.classSession.id });
      const sessionId = row!.id;
      const typeLabel = TEACH_ADHOC_LABEL[body.type];
      await this.events.emit(tx, 'AdhocSessionStarted', { sessionId, branchId: b.branchId, batchId: b.id, teacherUserId: c.userId, regularTeacherUserId: regular?.userId ?? null, reason: body.reason });
      await this.audit.log(tx, {
        action: 'Ad-hoc session started',
        kind: 'create',
        entityType: 'class_session',
        entityId: sessionId,
        entityLabel: `${b.code} · ${formatWeekdayDate(today)} ${body.start}`,
        after: { kind: 'adhoc', adhocType: body.type, reason: body.reason, start: body.start },
        summary: `${b.code} · today ${body.start} · ${typeLabel} by ${c.userName} · reason: ${body.reason} · awaiting Branch Admin acknowledgement`,
        branchId: b.branchId,
      });
      if (regular) {
        await this.notify.notify(tx, {
          userIds: [regular.userId],
          category: 'adhoc_session',
          title: `${c.userName} is taking ${b.code} · ${typeLabel.toLowerCase()}`,
          body: `Today ${body.start} · ${body.reason}`,
          link: '/teacher',
          entityType: 'class_session',
          entityId: sessionId,
        });
      }
      const admins = await this.shared.branchAdmins(tx, b.branchId);
      await this.notify.notify(tx, {
        userIds: admins.filter((u) => u !== regular?.userId),
        category: 'adhoc_session',
        title: `Ad-hoc session · ${b.code} · acknowledge`,
        body: `${c.userName} · ${typeLabel} · today ${body.start} · ${body.reason}`,
        link: '/branch',
        entityType: 'class_session',
        entityId: sessionId,
      });
      this.notify.invalidate(tx, b.branchId, [['academics'], ['teaching']]);
      return { sessionId };
    });
  }
}
