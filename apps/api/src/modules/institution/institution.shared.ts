import { ROLE_META, type InstTag, type SystemRoleKey } from '@exatech/contracts';
import { sql, type SQL } from '@exatech/db';
import { addDays, formatDate, monthName, todayIST } from '@exatech/domain';
import { branchScope } from '../../core/context';

/** Branch-scope condition for raw SQL over a column expression (honours the header switcher). */
export function scopeSql(column: SQL, scope: string[] | null = branchScope()): SQL {
  if (scope === null) return sql`true`;
  if (scope.length === 0) return sql`false`;
  return sql`${column} in ${idList(scope)}`;
}

export function idList(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`(null::uuid)`;
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export function roleShort(key: string, name: string): string {
  return ROLE_META[key as SystemRoleKey]?.short ?? name;
}

/** "Oct 20" (holiday tags). */
export function monthDay(date: string): string {
  return `${monthName(date)} ${Number(date.slice(8, 10))}`;
}

/** "2019", or "Aug 2026" for a branch opened within the last year. */
export function openedLabel(openedOn: string | null): string {
  if (!openedOn) return '—';
  return openedOn >= addDays(todayIST(), -365) ? `${monthName(openedOn)} ${openedOn.slice(0, 4)}` : openedOn.slice(0, 4);
}

export function openedLong(openedOn: string | null): string {
  return openedOn ? formatDate(openedOn) : '—';
}

export function branchStatus(b: { status: 'active' | 'paused' | 'archived'; statusNote: string | null; openedOn: string | null }): { label: string; tag: InstTag } {
  const note = b.statusNote?.trim();
  if (b.status === 'paused') return { label: note || 'Paused', tag: 'outline' };
  if (b.status === 'archived') return { label: note || 'Archived', tag: 'plain' };
  if (note && note !== 'Active') return { label: note, tag: 'neutral' };
  if (!note && b.openedOn && b.openedOn >= addDays(todayIST(), -180)) return { label: `Opened ${monthName(b.openedOn)} ${b.openedOn.slice(0, 4)}`, tag: 'neutral' };
  return { label: 'Active', tag: 'accent' };
}

export function gstinLine(gstin: string | null, note: string | null): string {
  if (gstin) return note ? `${gstin} · ${note}` : gstin;
  return note || 'shared with institution';
}

export const BATCH_STATUS_META: Record<string, { label: string; tag: InstTag }> = {
  running: { label: 'Running', tag: 'accent' },
  open: { label: 'Open', tag: 'outline' },
  planned: { label: 'Planned', tag: 'neutral' },
  waitlist: { label: 'Waitlist', tag: 'ink' },
  completed: { label: 'Completed', tag: 'plain' },
  cancelled: { label: 'Cancelled', tag: 'plain' },
};

export const LIVE_BATCH_STATUSES = ['planned', 'open', 'running', 'waitlist'] as const;

export const LEAVE_TYPE_LABEL: Record<string, string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', on_duty: 'On duty' };

export const LEAVE_STATUS_META: Record<string, { label: string; tag: InstTag }> = {
  pending: { label: 'Pending approval', tag: 'outline' },
  approved: { label: 'Approved', tag: 'accent' },
  rejected: { label: 'Rejected', tag: 'plain' },
  cancelled: { label: 'Cancelled', tag: 'plain' },
};

/** Membership scope text stored on the row, e.g. "Trivandrum", "TVM · EKM", "TVM · own leads", "DM-A · DM-B". */
export function scopeLabelFor(
  role: { key: string; scopeKind: string },
  branches: { id: string; code: string; name: string }[],
  batchCodes: string[] = [],
): string {
  if (role.scopeKind === 'institution') return 'Institution';
  const codes = branches.map((b) => b.code).join(' · ');
  if (role.scopeKind === 'batch') return batchCodes.length ? batchCodes.join(' · ') : `${codes} · no batches yet`;
  if (role.scopeKind === 'own') return `${codes} · ${role.key === 'sales' ? 'own leads' : 'own records'}`;
  return branches.length === 1 ? branches[0]!.name : codes;
}

/** Compact label for tables: "Super Admin", "Sales Manager TVM", "Teacher FS-B · FS-C". */
export function membershipLabel(m: { roleKey: string; roleName: string; scopeKind: string; branchIds: string[]; scopeLabel: string | null }, codeOf: (id: string) => string): string {
  const short = roleShort(m.roleKey, m.roleName);
  if (m.scopeKind === 'institution' || m.branchIds.length === 0) return short;
  if (m.scopeKind === 'batch') {
    const label = m.scopeLabel ?? '';
    return label && !label.includes('no batches') ? `${short} ${label}` : `${short} ${m.branchIds.map(codeOf).join(' · ')}`;
  }
  return `${short} ${m.branchIds.map(codeOf).join(' · ')}`;
}

/** "Chrome on macOS" from a user agent (device list). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici|playwright/i.test(ua) ? 'API client' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

export const AUTH_METHOD_LABEL: Record<string, string> = {
  magic_link: 'Email link',
  email_otp: 'Email code',
  phone_otp: 'Phone code',
  google: 'Google',
  demo: 'Demo sign-in',
  impersonation: 'View-as',
};

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

