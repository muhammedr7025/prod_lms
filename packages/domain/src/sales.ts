/* ───────────────────────── Pipeline ───────────────────────── */

export const LEAD_STAGES = ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation', 'admission_in_progress', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  counselled: 'Counselled',
  demo_scheduled: 'Demo scheduled',
  negotiation: 'Negotiation',
  admission_in_progress: 'Admission in progress',
  won: 'Won',
  lost: 'Lost',
};

/** The seven kanban columns (Lost is a terminal state shown in the table only). */
export const PIPELINE_COLUMNS: readonly LeadStage[] = ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation', 'admission_in_progress', 'won'];

/**
 * One-click advance. "Admission in progress" and "Won" are reached through the
 * admission flow, not by clicking: converting a lead submits an application,
 * and approval marks the lead Won.
 */
export function nextStage(stage: LeadStage): LeadStage | null {
  switch (stage) {
    case 'new':
      return 'contacted';
    case 'contacted':
      return 'counselled';
    case 'counselled':
      return 'demo_scheduled';
    case 'demo_scheduled':
      return 'negotiation';
    default:
      return null;
  }
}

export const LEAD_SOURCES = ['Walk-in', 'Instagram', 'Website', 'Google Ads', 'Referral', 'Import'] as const;

/* ───────────────────────── Scoring ───────────────────────── */

export interface ScoreInput {
  source: string;
  stage: LeadStage;
  responded: boolean;
  visited: boolean;
  demoAttended: boolean;
  courseHasOpenBatch: boolean;
  hasEmail: boolean;
}

const SOURCE_WEIGHT: Record<string, number> = { Referral: 20, 'Walk-in': 18, Website: 12, 'Google Ads': 10, Instagram: 8, Import: 5 };
const STAGE_WEIGHT: Record<LeadStage, number> = {
  new: 0,
  contacted: 8,
  counselled: 16,
  demo_scheduled: 24,
  negotiation: 32,
  admission_in_progress: 40,
  won: 45,
  lost: 0,
};

/** Engagement + fit score, 0–100. */
export function leadScore(i: ScoreInput): number {
  let s = 10;
  s += SOURCE_WEIGHT[i.source] ?? 5;
  s += STAGE_WEIGHT[i.stage];
  if (i.responded) s += 8;
  if (i.visited) s += 8;
  if (i.demoAttended) s += 10;
  if (i.courseHasOpenBatch) s += 6;
  if (i.hasEmail) s += 3;
  return Math.max(0, Math.min(100, s));
}

/* ───────────────────────── Assignment rules ───────────────────────── */

export interface RuleCondition {
  sources?: string[];
  courseIds?: string[];
  preferredBranchIds?: string[];
}

export interface AssignmentRuleDef {
  id: string;
  position: number;
  enabled: boolean;
  condition: RuleCondition; // empty = matches everything
  assigneeIds: string[];
  cursor: number; // round-robin position
}

export interface LeadFacts {
  source: string;
  courseId: string | null;
  preferredBranchId: string | null;
}

export function ruleMatches(c: RuleCondition, l: LeadFacts): boolean {
  if (c.sources?.length && !c.sources.includes(l.source)) return false;
  if (c.courseIds?.length && (!l.courseId || !c.courseIds.includes(l.courseId))) return false;
  if (c.preferredBranchIds?.length && (!l.preferredBranchId || !c.preferredBranchIds.includes(l.preferredBranchId))) return false;
  return true;
}

/**
 * Rules evaluated top-down; first enabled rule that matches and has assignees wins.
 * Round robin advances the rule's cursor. Returns null when nothing matches.
 */
export function assignLead(
  lead: LeadFacts,
  rules: readonly AssignmentRuleDef[],
  isAvailable: (userId: string) => boolean = () => true,
): { ruleId: string; assigneeId: string; nextCursor: number } | null {
  const ordered = [...rules].filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const r of ordered) {
    if (!ruleMatches(r.condition, lead) || r.assigneeIds.length === 0) continue;
    const n = r.assigneeIds.length;
    for (let k = 0; k < n; k++) {
      const idx = (r.cursor + k) % n;
      const candidate = r.assigneeIds[idx]!;
      if (isAvailable(candidate)) return { ruleId: r.id, assigneeId: candidate, nextCursor: (idx + 1) % n };
    }
  }
  return null;
}

/* ───────────────────────── Dedupe ───────────────────────── */

export function dedupeKeys(phone: string | null, email: string | null): string[] {
  const keys: string[] = [];
  if (phone) keys.push(`p:${phone}`);
  if (email) keys.push(`e:${email.toLowerCase()}`);
  return keys;
}

/* ───────────────────────── Funnel ───────────────────────── */

export function conversionPct(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.round((to / from) * 1000) / 10;
}

export function medianMinutes(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** 100 → "1 h 40 m" */
export function formatDuration(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${min} m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}
