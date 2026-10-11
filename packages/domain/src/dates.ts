/**
 * Calendar dates are ISO strings `YYYY-MM-DD` (Postgres `date`), interpreted in IST.
 * Instants are JS `Date` (stored UTC). Everything user-facing is displayed in IST.
 */
export type ISODate = string;

export const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Shift an instant into "IST wall clock" so UTC getters read IST fields. */
function istWall(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
}

export function toISTDate(d: Date): ISODate {
  return istWall(d).toISOString().slice(0, 10);
}

export function todayIST(now: Date = new Date()): ISODate {
  return toISTDate(now);
}

/** "HH:MM" in IST for an instant. */
export function toISTTime(d: Date): string {
  return istWall(d).toISOString().slice(11, 16);
}

/** Build an instant from an IST calendar date and "HH:MM". */
export function istDateTime(date: ISODate, time = '00:00'): Date {
  const [y, m, dd] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, dd, hh, mm) - IST_OFFSET_MIN * 60_000);
}

function parse(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fmt(new Date(parse(date).getTime() + days * DAY_MS));
}

export function addMonths(date: ISODate, months: number): ISODate {
  const d = parse(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return fmt(target);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: ISODate): number {
  return parse(date).getUTCDay();
}

/** Monday of the week containing `date`. */
export function mondayOf(date: ISODate): ISODate {
  const wd = weekday(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function isoWeekNumber(date: ISODate): number {
  const d = parse(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

/** Indian financial year label, April–March: 2026-10-11 → "2026-27". */
export function financialYear(date: ISODate): string {
  const d = parse(date);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function monthStart(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`;
}

/** "11 Oct" */
export function formatDayMonth(date: ISODate): string {
  const d = parse(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "11 Oct 2026" */
export function formatDate(date: ISODate): string {
  const d = parse(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Sat 11 Oct" */
export function formatWeekdayDate(date: ISODate): string {
  return `${WEEKDAYS[weekday(date)]} ${formatDayMonth(date)}`;
}

/** "Saturday 11 Oct" */
export function formatLongWeekdayDate(date: ISODate): string {
  return `${WEEKDAYS_LONG[weekday(date)]} ${formatDayMonth(date)}`;
}

/** "Mon 13" — timetable column header. */
export function formatWeekdayShort(date: ISODate): string {
  return `${WEEKDAYS[weekday(date)]} ${parse(date).getUTCDate()}`;
}

export function monthName(date: ISODate, long = false): string {
  const m = parse(date).getUTCMonth();
  return long
    ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m]!
    : MONTHS[m]!;
}

/** Relative "2 min", "1 h", "Yesterday", "3 Oct" for feeds. */
export function formatRelative(at: Date, now: Date = new Date()): string {
  const diff = now.getTime() - at.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24 && toISTDate(at) === toISTDate(now)) return `${h} h`;
  const days = daysBetween(toISTDate(at), toISTDate(now));
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[weekday(toISTDate(at))]!;
  return formatDayMonth(toISTDate(at));
}

/** Minutes since midnight for "HH:MM". */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function timeFromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmt(parse(s)) === s;
}
