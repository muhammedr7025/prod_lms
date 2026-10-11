import * as s from '@exatech/db';
import { and, eq, inArray, sql, type DbOrTx, type SQL } from '@exatech/db';
import { addDays, formatWeekdayDate, istDateTime, LEAD_STAGE_LABEL, toISTDate, toISTTime, todayIST, type LeadStage } from '@exatech/domain';
import { assertBranchAccess, branchScope, can, ctx } from '../../core/context';
import { inBranchScope } from '../../core/db';
import { forbidden, invalid } from '../../core/errors';

export type LeadRow = typeof s.lead.$inferSelect;

export const OPEN_STAGES: LeadStage[] = ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation', 'admission_in_progress'];
export const MANUAL_STAGES: LeadStage[] = ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation'];
export const STAGE_ORDER: LeadStage[] = ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation', 'admission_in_progress', 'won'];

export const stageLabel = (st: string) => LEAD_STAGE_LABEL[st as LeadStage] ?? st;
export const firstName = (name: string | null | undefined) => (name ? name.split(' ')[0]! : '—');

/** Read scope for leads: branch scope, plus own-only unless `sales:leads.all`. */
export function leadScope(): SQL | undefined {
  const c = ctx();
  const parts = [inBranchScope(s.lead.branchId), can('sales:leads.all') ? undefined : eq(s.lead.ownerUserId, c.userId)].filter(Boolean) as SQL[];
  return parts.length ? and(...parts) : undefined;
}

/** Write access to one lead (membership branch + ownership for own-scope roles). */
export function assertLeadAccess(lead: Pick<LeadRow, 'branchId' | 'ownerUserId'>): void {
  assertBranchAccess(lead.branchId);
  const c = ctx();
  if (!can('sales:leads.all') && lead.ownerUserId !== c.userId) throw forbidden('This lead belongs to another salesperson');
}

/**
 * The branch new records belong to: the header selection, else the only
 * membership branch, else the user's home branch (institution-wide roles).
 */
export async function resolveBranchId(db: DbOrTx, preferred?: string | null): Promise<string> {
  const c = ctx();
  if (c.selectedBranchId) return c.selectedBranchId;
  if (preferred && (!c.membershipBranchIds || c.membershipBranchIds.includes(preferred))) return preferred;
  if (c.membershipBranchIds?.length) return c.membershipBranchIds[0]!;
  const [p] = await db.select({ b: s.staffProfile.homeBranchId }).from(s.staffProfile).where(eq(s.staffProfile.userId, c.userId));
  if (p?.b) return p.b;
  const [b] = await db.select({ id: s.branch.id }).from(s.branch).where(eq(s.branch.status, 'active')).limit(1);
  if (!b) throw invalid('Pick a branch first');
  return b.id;
}

/** "Trivandrum · own leads" / "Trivandrum · branch team" / "All branches · team". */
export async function scopeLabel(db: DbOrTx): Promise<string> {
  const scope = branchScope();
  let where = 'All branches';
  if (scope && scope.length) {
    const rows = await db.select({ name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, scope));
    where = rows.map((r) => r.name).join(' · ') || 'No branch';
  }
  return `${where} · ${can('sales:leads.all') ? (scope ? 'branch team' : 'team') : 'own leads'}`;
}

export async function branchName(db: DbOrTx, branchId: string): Promise<string> {
  const [b] = await db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, branchId));
  return b?.name ?? '—';
}

/** Start of today (IST) as an instant, plus helpers for day windows. */
export function dayWindow(date = todayIST()) {
  return { start: istDateTime(date), end: istDateTime(addDays(date, 1)), date };
}

/** "Today 15:00", "Tomorrow 10:30", "Overdue · Fri 10 Oct", "Mon 13 Oct 10:00". */
export function whenLabel(at: Date, now = new Date()): { label: string; overdue: boolean } {
  const today = todayIST(now);
  const d = toISTDate(at);
  const t = toISTTime(at);
  if (at.getTime() < now.getTime() && d !== today) return { label: `Overdue · ${formatWeekdayDate(d)}`, overdue: true };
  if (d === today) return { label: `Today ${t}`, overdue: at.getTime() < now.getTime() };
  if (d === addDays(today, 1)) return { label: `Tomorrow ${t}`, overdue: false };
  return { label: `${formatWeekdayDate(d)} ${t}`, overdue: false };
}

export function nextLine(l: Pick<LeadRow, 'stage' | 'nextFollowUpAt' | 'nextFollowUpNote' | 'lostReason'>, now = new Date()): { line: string; overdue: boolean } {
  if (l.stage === 'won') return { line: 'Won · enrolled', overdue: false };
  if (l.stage === 'lost') return { line: `Lost${l.lostReason ? ` · ${l.lostReason}` : ''}`, overdue: false };
  if (!l.nextFollowUpAt) return { line: l.stage === 'admission_in_progress' ? 'Application in progress' : 'No follow-up', overdue: false };
  const w = whenLabel(l.nextFollowUpAt, now);
  return { line: l.nextFollowUpNote ? `${w.label} · ${l.nextFollowUpNote}` : w.label, overdue: w.overdue };
}

/** Users who cannot take new leads today: on leave in their staff profile or with an approved leave today. */
export async function unavailableUsers(db: DbOrTx, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const today = todayIST();
  const [profiles, leaves] = await Promise.all([
    db.select({ id: s.staffProfile.userId }).from(s.staffProfile).where(and(inArray(s.staffProfile.userId, userIds), eq(s.staffProfile.status, 'leave'))),
    db.select({ id: s.leave.userId }).from(s.leave).where(and(inArray(s.leave.userId, userIds), eq(s.leave.date, today), eq(s.leave.status, 'approved'))),
  ]);
  return new Set([...profiles.map((p) => p.id), ...leaves.map((l) => l.id)]);
}

export async function userNames(db: DbOrTx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Staff holding a role (by key) whose membership covers the branch. */
export async function usersWithRoleInBranch(db: DbOrTx, roleKeys: string[], branchId: string | null): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .selectDistinct({ id: s.user.id, name: s.user.name })
    .from(s.membership)
    .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
    .innerJoin(s.user, eq(s.user.id, s.membership.userId))
    .where(
      and(
        inArray(s.role.key, roleKeys),
        eq(s.membership.status, 'active'),
        eq(s.user.status, 'active'),
        branchId ? sql`(cardinality(${s.membership.branchIds}) = 0 or ${branchId} = any(${s.membership.branchIds}))` : undefined,
      ),
    );
  return rows;
}

/** Super Admins (institution-wide approvals). */
export async function superAdminIds(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: s.membership.userId })
    .from(s.membership)
    .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
    .where(and(eq(s.role.key, 'superadmin'), eq(s.membership.status, 'active')));
  return rows.map((r) => r.id);
}

export function csvEscape(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}
