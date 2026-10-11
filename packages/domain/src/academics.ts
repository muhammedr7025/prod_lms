import { addDays, daysBetween, toISTDate } from './dates';

/* ───────────────────────── Attendance ───────────────────────── */

export type AttendanceStatus = 'P' | 'A' | 'L' | 'E';

export const ATTENDANCE_CYCLE: readonly AttendanceStatus[] = ['P', 'A', 'L', 'E'];

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };

export function nextAttendanceStatus(s: AttendanceStatus | null | undefined): AttendanceStatus {
  if (!s) return 'P';
  const i = ATTENDANCE_CYCLE.indexOf(s);
  return ATTENDANCE_CYCLE[(i + 1) % ATTENDANCE_CYCLE.length]!;
}

/** Present + Late count as attended; Excused is removed from the denominator. */
export function attendancePercent(statuses: readonly AttendanceStatus[]): number {
  const counted = statuses.filter((s) => s !== 'E');
  if (counted.length === 0) return 100;
  const attended = counted.filter((s) => s === 'P' || s === 'L').length;
  return Math.round((attended / counted.length) * 100);
}

export function attendanceCounts(statuses: readonly (AttendanceStatus | null)[]): Record<AttendanceStatus, number> {
  const c: Record<AttendanceStatus, number> = { P: 0, A: 0, L: 0, E: 0 };
  for (const s of statuses) if (s) c[s]++;
  return c;
}

export const ATTENDANCE_EDIT_WINDOW_HOURS = 48;
export const LOW_ATTENDANCE_THRESHOLD = 75;

export function teacherCanEditAttendance(submittedAt: Date | null, now: Date = new Date(), windowHours = ATTENDANCE_EDIT_WINDOW_HOURS): boolean {
  if (!submittedAt) return true;
  return now.getTime() - submittedAt.getTime() <= windowHours * 3_600_000;
}

/* ───────────────────────── Marks ───────────────────────── */

export interface ExamComponentDef {
  name: string;
  max: number;
}

export interface MarkRowState {
  total: number;
  complete: boolean;
  overMax: boolean[];
  invalid: boolean;
}

/** Validate one student's marks across components. Values: number or null (empty). */
export function evaluateMarkRow(values: readonly (number | null)[], comps: readonly ExamComponentDef[]): MarkRowState {
  const overMax = comps.map((c, i) => {
    const v = values[i];
    return v != null && (v > c.max || v < 0 || !Number.isFinite(v));
  });
  const complete = comps.every((_, i) => values[i] != null);
  const total = comps.reduce((a, _, i) => a + (values[i] ?? 0), 0);
  return { total, complete, overMax, invalid: overMax.some(Boolean) };
}

export function examMaxTotal(comps: readonly ExamComponentDef[]): number {
  return comps.reduce((a, c) => a + c.max, 0);
}

export interface ExamStats {
  average: number | null;
  highest: number | null;
  lowest: number | null;
  missing: number;
  count: number;
}

export function examStats(rows: readonly (readonly (number | null)[])[], comps: readonly ExamComponentDef[]): ExamStats {
  const totals: number[] = [];
  let missing = 0;
  for (const r of rows) {
    const s = evaluateMarkRow(r, comps);
    if (!s.complete) missing++;
    else totals.push(s.total);
  }
  if (totals.length === 0) return { average: null, highest: null, lowest: null, missing, count: rows.length };
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  return { average: Math.round(avg * 10) / 10, highest: Math.max(...totals), lowest: Math.min(...totals), missing, count: rows.length };
}

/** A submission is allowed only when every row is complete and valid. */
export function canSubmitMarks(rows: readonly (readonly (number | null)[])[], comps: readonly ExamComponentDef[]): { ok: boolean; reason?: string } {
  if (comps.length === 0) return { ok: false, reason: 'Exam has no components' };
  if (rows.length === 0) return { ok: false, reason: 'No students on the roster' };
  let incomplete = 0;
  let invalid = 0;
  for (const r of rows) {
    const s = evaluateMarkRow(r, comps);
    if (!s.complete) incomplete++;
    if (s.invalid) invalid++;
  }
  if (invalid) return { ok: false, reason: `${invalid} row${invalid > 1 ? 's have' : ' has'} marks over the maximum` };
  if (incomplete) return { ok: false, reason: `${incomplete} row${incomplete > 1 ? 's are' : ' is'} incomplete` };
  return { ok: true };
}

export interface GradeBand {
  min: number; // percentage, inclusive
  grade: string;
}

export const DEFAULT_GRADE_SCHEME: readonly GradeBand[] = [
  { min: 90, grade: 'A+' },
  { min: 80, grade: 'A' },
  { min: 70, grade: 'B+' },
  { min: 60, grade: 'B' },
  { min: 50, grade: 'C' },
  { min: 40, grade: 'D' },
  { min: 0, grade: 'F' },
];

export function gradeFor(pct: number, scheme: readonly GradeBand[] = DEFAULT_GRADE_SCHEME): string {
  const band = [...scheme].sort((a, b) => b.min - a.min).find((b) => pct >= b.min);
  return band?.grade ?? 'F';
}

/* ───────────────────────── Assignments ───────────────────────── */

export type LatePolicy = 'minus_10_per_day' | 'minus_5_per_day' | 'not_accepted' | 'no_penalty';

export const LATE_POLICY_LABEL: Record<LatePolicy, string> = {
  minus_10_per_day: '−10% per day',
  minus_5_per_day: '−5% per day',
  not_accepted: 'Not accepted after due',
  no_penalty: 'No penalty',
};

export function lateDays(dueAt: Date, submittedAt: Date): number {
  if (submittedAt.getTime() <= dueAt.getTime()) return 0;
  return Math.max(1, daysBetween(toISTDate(dueAt), toISTDate(submittedAt)));
}

export function canSubmitAfterDue(policy: LatePolicy): boolean {
  return policy !== 'not_accepted';
}

/** Apply the late policy to awarded marks (never below zero). */
export function applyLatePenalty(marks: number, max: number, policy: LatePolicy, days: number): number {
  if (days <= 0) return marks;
  const perDay = policy === 'minus_10_per_day' ? 10 : policy === 'minus_5_per_day' ? 5 : 0;
  const penalty = (max * perDay * days) / 100;
  return Math.max(0, Math.round((marks - penalty) * 10) / 10);
}

/* ───────────────────────── At-risk signal ───────────────────────── */

export interface RiskInput {
  attendancePct: number;
  overdue: number; // paise
  missedAssignments: number;
  consecutiveAbsences: number;
}

export function riskReasons(r: RiskInput): string[] {
  const out: string[] = [];
  if (r.attendancePct < LOW_ATTENDANCE_THRESHOLD) out.push(`Attendance ${r.attendancePct}%`);
  if (r.overdue > 0) out.push(`₹${Math.round(r.overdue / 100).toLocaleString('en-IN')} overdue`);
  if (r.missedAssignments > 0) out.push(`${r.missedAssignments} assignment${r.missedAssignments > 1 ? 's' : ''} missed`);
  if (r.consecutiveAbsences >= 3) out.push(`${r.consecutiveAbsences} absences in a row`);
  return out;
}

export function isAtRisk(r: RiskInput): boolean {
  return r.attendancePct < LOW_ATTENDANCE_THRESHOLD || r.consecutiveAbsences >= 3 || (r.overdue > 0 && r.missedAssignments > 0);
}

/* ───────────────────────── QR self check-in ───────────────────────── */

export const QR_ROTATE_SECONDS = 300;

/** "Wk42" style label helper for timetable headers. */
export function weekRangeLabel(monday: string): string {
  const sat = addDays(monday, 5);
  const [, m1, d1] = monday.split('-');
  const [, m2, d2] = sat.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m1 === m2 ? `${Number(d1)}–${Number(d2)} ${months[Number(m1) - 1]}` : `${Number(d1)} ${months[Number(m1) - 1]} – ${Number(d2)} ${months[Number(m2) - 1]}`;
}
