import { minutesOf, type ISODate } from './dates';

export interface SlotSession {
  id: string;
  branchId: string;
  batchId: string;
  batchCode: string;
  teacherId: string;
  teacherName: string;
  roomId: string | null;
  roomName: string | null;
  date: ISODate;
  start: string; // HH:MM
  end: string; // HH:MM
  status?: 'scheduled' | 'cancelled' | 'held' | 'suppressed';
}

export type IssueCode = 'ROOM_CLASH' | 'TEACHER_CLASH' | 'TEACHER_TRAVEL' | 'TEACHER_ON_LEAVE' | 'HOLIDAY' | 'ROOM_CAPACITY' | 'OFF_SITE_DAY';

export interface ScheduleIssue {
  code: IssueCode;
  message: string;
  withSessionId?: string;
}

export interface ScheduleContext {
  existing: readonly SlotSession[];
  holidays: readonly { date: ISODate; name: string; branchId: string | null }[];
  approvedLeave: readonly { teacherId: string; date: ISODate }[];
  roomCapacity?: number | null;
  batchSeats?: number | null;
  /** Days (0-6) a cross-branch teacher is on site at this branch; empty = any day. */
  teacherOnSiteDays?: readonly number[];
  travelBufferMin?: number;
}

export const DEFAULT_TRAVEL_BUFFER_MIN = 45;

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string, bufferMin = 0): boolean {
  return minutesOf(aStart) < minutesOf(bEnd) + bufferMin && minutesOf(bStart) < minutesOf(aEnd) + bufferMin;
}

const active = (s: SlotSession) => s.status !== 'cancelled' && s.status !== 'suppressed';

/**
 * Validate a session before save (PRD §6 timetable, §12 rule 7). Every
 * blocking issue states its reason so the dialog can show it inline.
 */
export function validateSession(candidate: SlotSession, ctx: ScheduleContext): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const buffer = ctx.travelBufferMin ?? DEFAULT_TRAVEL_BUFFER_MIN;
  const others = ctx.existing.filter((s) => s.id !== candidate.id && active(s) && s.date === candidate.date);

  for (const s of others) {
    if (candidate.roomId && s.roomId === candidate.roomId && s.branchId === candidate.branchId && overlaps(candidate.start, candidate.end, s.start, s.end)) {
      issues.push({ code: 'ROOM_CLASH', message: `${candidate.roomName ?? 'Room'} is taken by ${s.batchCode} ${s.start}–${s.end}`, withSessionId: s.id });
    }
    if (s.teacherId === candidate.teacherId) {
      if (s.branchId === candidate.branchId) {
        if (overlaps(candidate.start, candidate.end, s.start, s.end)) {
          issues.push({ code: 'TEACHER_CLASH', message: `${candidate.teacherName} already teaches ${s.batchCode} ${s.start}–${s.end}`, withSessionId: s.id });
        }
      } else if (overlaps(candidate.start, candidate.end, s.start, s.end, buffer)) {
        issues.push({
          code: 'TEACHER_TRAVEL',
          message: `${candidate.teacherName} is at another branch (${s.batchCode} ${s.start}–${s.end}) — needs a ${buffer}-min travel buffer`,
          withSessionId: s.id,
        });
      }
    }
  }

  if (ctx.approvedLeave.some((l) => l.teacherId === candidate.teacherId && l.date === candidate.date)) {
    issues.push({ code: 'TEACHER_ON_LEAVE', message: `${candidate.teacherName} has approved leave on this day` });
  }
  const holiday = ctx.holidays.find((h) => h.date === candidate.date && (h.branchId === null || h.branchId === candidate.branchId));
  if (holiday) issues.push({ code: 'HOLIDAY', message: `${holiday.name} is a holiday — sessions are suppressed` });
  if (ctx.roomCapacity != null && ctx.batchSeats != null && ctx.roomCapacity < ctx.batchSeats) {
    issues.push({ code: 'ROOM_CAPACITY', message: `${candidate.roomName ?? 'Room'} seats ${ctx.roomCapacity}, batch has ${ctx.batchSeats} seats` });
  }
  if (ctx.teacherOnSiteDays && ctx.teacherOnSiteDays.length > 0) {
    const [y, m, d] = candidate.date.split('-').map(Number) as [number, number, number];
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!ctx.teacherOnSiteDays.includes(wd)) {
      issues.push({ code: 'OFF_SITE_DAY', message: `${candidate.teacherName} is not on site at this branch on that day` });
    }
  }
  return issues;
}

export interface WeekConflict {
  key: string;
  code: 'ROOM_CLASH' | 'TEACHER_CLASH' | 'TEACHER_TRAVEL' | 'TEACHER_ON_LEAVE';
  message: string;
  sessionIds: string[];
  /** One-click fix, when one exists. */
  fix?: { label: string; sessionId: string; roomId?: string; roomName?: string };
}

/**
 * Live conflicts for a week grid (the "Conflicts · live" panel). For room
 * clashes we suggest the first free room with enough capacity at that time.
 */
export function findWeekConflicts(
  sessions: readonly SlotSession[],
  opts: {
    rooms: readonly { id: string; name: string; capacity: number; branchId: string }[];
    seatsByBatch?: Readonly<Record<string, number>>;
    approvedLeave?: readonly { teacherId: string; date: ISODate }[];
    travelBufferMin?: number;
  },
): WeekConflict[] {
  const out: WeekConflict[] = [];
  const list = sessions.filter(active);
  const buffer = opts.travelBufferMin ?? DEFAULT_TRAVEL_BUFFER_MIN;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.date !== b.date) continue;
      if (a.roomId && a.roomId === b.roomId && a.branchId === b.branchId && overlaps(a.start, a.end, b.start, b.end)) {
        const busy = new Set(list.filter((s) => s.date === b.date && s.branchId === b.branchId && overlaps(s.start, s.end, b.start, b.end)).map((s) => s.roomId));
        const seats = opts.seatsByBatch?.[b.batchId] ?? 0;
        const free = opts.rooms.find((r) => r.branchId === b.branchId && !busy.has(r.id) && r.capacity >= seats);
        out.push({
          key: `room:${a.id}:${b.id}`,
          code: 'ROOM_CLASH',
          message: `${a.roomName} double-booked ${a.start} — ${a.batchCode} and ${b.batchCode}`,
          sessionIds: [a.id, b.id],
          fix: free ? { label: `Move ${b.batchCode} to ${free.name}`, sessionId: b.id, roomId: free.id, roomName: free.name } : undefined,
        });
      }
      if (a.teacherId === b.teacherId) {
        const sameBranch = a.branchId === b.branchId;
        if (overlaps(a.start, a.end, b.start, b.end, sameBranch ? 0 : buffer)) {
          out.push({
            key: `teacher:${a.id}:${b.id}`,
            code: sameBranch ? 'TEACHER_CLASH' : 'TEACHER_TRAVEL',
            message: sameBranch
              ? `${a.teacherName} double-booked ${a.start} — ${a.batchCode} and ${b.batchCode}`
              : `${a.teacherName} cannot reach ${b.batchCode} in time (${buffer}-min buffer)`,
            sessionIds: [a.id, b.id],
          });
        }
      }
    }
  }
  for (const s of list) {
    if (opts.approvedLeave?.some((l) => l.teacherId === s.teacherId && l.date === s.date)) {
      out.push({ key: `leave:${s.id}`, code: 'TEACHER_ON_LEAVE', message: `${s.teacherName} on leave — ${s.batchCode} ${s.start} needs a substitute`, sessionIds: [s.id] });
    }
  }
  return out;
}

/** Hours of teaching for a teacher in a set of sessions. */
export function teachingHours(sessions: readonly SlotSession[], teacherId: string): number {
  return sessions.filter((s) => active(s) && s.teacherId === teacherId).reduce((a, s) => a + (minutesOf(s.end) - minutesOf(s.start)) / 60, 0);
}

export const DEFAULT_SLOTS = ['09:00', '11:30', '14:00', '16:30'] as const;
export const SLOT_LENGTH_MIN = 120;
