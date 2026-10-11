import { Injectable } from '@nestjs/common';
import type { PortalTimetable, TagVariant } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, ne, sql } from '@exatech/db';
import { addDays, formatWeekdayDate, istDateTime, isoWeekNumber, isValidISODate, mondayOf, monthName, todayIST } from '@exatech/domain';
import type { StudentScope } from '../../core/scope.service';
import { PortalShared } from './portal.shared';

interface SessionRow {
  id: string;
  date: string;
  start: string;
  end: string;
  kind: 'timetabled' | 'adhoc' | 'exam';
  adhocType: string | null;
  status: 'scheduled' | 'cancelled' | 'held' | 'suppressed';
  topic: string | null;
  subject: string;
  mode: 'offline' | 'online' | 'hybrid';
  room: string | null;
  teacher: string;
  substituteFor: string | null;
  submittedAt: Date | null;
}

/** "5–11 Oct" / "28 Sep – 4 Oct" for a Monday-based week. */
export function weekLabel(monday: string): string {
  const sun = addDays(monday, 6);
  const d1 = Number(monday.slice(8));
  const d2 = Number(sun.slice(8));
  return monday.slice(5, 7) === sun.slice(5, 7) ? `${d1}–${d2} ${monthName(monday)}` : `${d1} ${monthName(monday)} – ${d2} ${monthName(sun)}`;
}

/** RFC 5545 text escaping. */
function icsText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold content lines at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Student / Parent · Timetable: week list incl. exams and holidays; ICS export of the next 8 weeks. */
@Injectable()
export class TimetableService {
  constructor(private readonly shared: PortalShared) {}

  private async sessions(sc: StudentScope, from: string, to: string): Promise<SessionRow[]> {
    const db = this.shared.db.db;
    const rows = await db
      .select({
        id: s.classSession.id,
        date: s.classSession.date,
        start: s.classSession.startTime,
        end: s.classSession.endTime,
        kind: s.classSession.kind,
        adhocType: s.classSession.adhocType,
        status: s.classSession.status,
        topic: s.classSession.topic,
        subject: s.classSession.subjectName,
        mode: s.classSession.mode,
        room: s.room.name,
        teacher: s.user.name,
        substituteFor: s.classSession.substituteForUserId,
        submittedAt: s.classSession.attendanceSubmittedAt,
        acknowledgedAt: s.classSession.acknowledgedAt,
      })
      .from(s.classSession)
      .innerJoin(s.user, eq(s.user.id, s.classSession.teacherUserId))
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(and(eq(s.classSession.batchId, sc.batchId), ne(s.classSession.status, 'suppressed'), sql`${s.classSession.date} between ${from}::date and ${to}::date`))
      .orderBy(asc(s.classSession.date), asc(s.classSession.startTime));
    return rows;
  }

  private async holidays(sc: StudentScope, from: string, to: string) {
    return this.shared.db.db
      .select({ id: s.holiday.id, date: s.holiday.date, name: s.holiday.name })
      .from(s.holiday)
      .where(and(sql`${s.holiday.date} between ${from}::date and ${to}::date`, sql`(${s.holiday.branchId} is null or ${s.holiday.branchId} = ${sc.branchId})`));
  }

  private place(x: SessionRow): string {
    return x.mode === 'online' ? 'Online' : (x.room ?? 'Room TBA');
  }

  private examName(x: SessionRow): string {
    return (x.topic ?? x.subject).replace(/^Exam · /, '');
  }

  async week(studentId: string | undefined, week: string | undefined): Promise<PortalTimetable> {
    const sc = await this.shared.resolve(studentId);
    const today = todayIST();
    const monday = mondayOf(week && isValidISODate(week) ? week : today);
    const sunday = addDays(monday, 6);
    const [sessions, hols] = await Promise.all([this.sessions(sc, monday, sunday), this.holidays(sc, monday, sunday)]);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(monday, i);
      const items: PortalTimetable['days'][number]['items'] = [];
      for (const h of hols.filter((x) => x.date === date)) {
        items.push({ id: h.id, kind: 'holiday', title: h.name, sub: 'Holiday · no classes', tag: 'Holiday', tagVariant: 'neutral' });
      }
      for (const x of sessions.filter((r) => r.date === date)) {
        const time = `${x.start}–${x.end}`;
        if (x.kind === 'exam') {
          items.push({ id: x.id, kind: 'exam', title: this.examName(x), sub: `${time} · ${this.place(x)}`, tag: 'Exam', tagVariant: 'ink' });
          continue;
        }
        let tag = 'Class';
        let tagVariant: TagVariant = 'accent';
        const past = date < today || !!x.submittedAt;
        if (x.status === 'cancelled') [tag, tagVariant] = ['Cancelled', 'plain'];
        else if (x.substituteFor || x.adhocType === 'substitute') [tag, tagVariant] = past ? ['Done', 'neutral'] : ['Substitute', 'outline'];
        else if (past || x.status === 'held') [tag, tagVariant] = ['Done', 'neutral'];
        const who = x.substituteFor || x.adhocType === 'substitute' ? `${x.teacher} (substitute)` : x.teacher;
        items.push({
          id: x.id,
          kind: 'class',
          title: x.topic ?? x.subject,
          sub: [time, this.place(x), who].join(' · '),
          tag,
          tagVariant,
        });
      }
      return { date, label: formatWeekdayDate(date), today: date === today, past: date < today, items };
    });
    return {
      kicker: `Week ${isoWeekNumber(monday)} · ${weekLabel(monday)}`,
      monday,
      prev: addDays(monday, -7),
      next: addDays(monday, 7),
      isCurrent: monday === mondayOf(today),
      days,
    };
  }

  /** iCalendar (RFC 5545) for the next 8 weeks: classes, exams and holidays. */
  async ics(studentId: string | undefined): Promise<{ body: string; filename: string }> {
    const sc = await this.shared.resolve(studentId);
    const today = todayIST();
    const to = addDays(today, 8 * 7);
    const [sessions, hols, branch] = await Promise.all([this.sessions(sc, today, to), this.holidays(sc, today, to), this.shared.branch(sc.branchId)]);
    const inst = await this.shared.institution();
    const stamp = utcStamp(new Date());
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Exatech//Student portal//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsText(`${sc.batchCode} · ${inst.name}`)}`,
      'X-WR-TIMEZONE:Asia/Kolkata',
    ];
    for (const h of hols) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:holiday-${h.id}@exatech`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${h.date.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${addDays(h.date, 1).replace(/-/g, '')}`,
        `SUMMARY:${icsText(`Holiday · ${h.name}`)}`,
        `DESCRIPTION:${icsText(`${branch.name} is closed — no classes`)}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
    for (const x of sessions) {
      if (x.status === 'cancelled') continue;
      const isExam = x.kind === 'exam';
      const summary = isExam ? `Exam · ${this.examName(x)}` : `${sc.batchCode} · ${x.topic ?? x.subject}`;
      const location = x.mode === 'online' ? 'Online' : [x.room, `${inst.name} ${branch.name}`].filter(Boolean).join(', ');
      const description = isExam ? `${sc.batchCode} · ${sc.courseName} · ${x.subject}` : `${x.subject} · ${x.teacher}${x.substituteFor ? ' (substitute)' : ''}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${x.id}@exatech`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${utcStamp(istDateTime(x.date, x.start))}`,
        `DTEND:${utcStamp(istDateTime(x.date, x.end))}`,
        `SUMMARY:${icsText(summary)}`,
        `LOCATION:${icsText(location)}`,
        `DESCRIPTION:${icsText(description)}`,
        `CATEGORIES:${isExam ? 'EXAM' : 'CLASS'}`,
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    return { body: lines.map(fold).join('\r\n') + '\r\n', filename: `${sc.batchCode}-timetable.ics` };
  }
}
