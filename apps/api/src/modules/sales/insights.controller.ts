import { Controller } from '@nestjs/common';
import { salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, eq, gte, inArray, lt, sql } from '@exatech/db';
import {
  addDays,
  addMonths,
  conversionPct,
  formatDuration,
  formatDayMonth,
  isoWeekNumber,
  istDateTime,
  LEAD_STAGE_LABEL,
  medianMinutes,
  mondayOf,
  monthName,
  monthStart,
  PIPELINE_COLUMNS,
  todayIST,
} from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, branchScope } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { forbidden, invalid } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { NotifyService } from '../../core/notifications/notify.service';
import { resolveBranchId, STAGE_ORDER, usersWithRoleInBranch } from './sales.shared';

const TWO_HOURS = 2 * 3_600_000;

function period(kind: 'week' | 'month' | 'quarter', today = todayIST()) {
  if (kind === 'week') {
    const start = mondayOf(today);
    const end = addDays(start, 7);
    return { start, end, prevStart: addDays(start, -7), label: `Week ${isoWeekNumber(today)} · ${formatDayMonth(start)} – ${formatDayMonth(addDays(start, 6))}`, prevLabel: 'last week' };
  }
  if (kind === 'month') {
    const start = monthStart(today);
    const prevStart = addMonths(start, -1);
    return { start, end: addMonths(start, 1), prevStart, label: monthName(start, true), prevLabel: monthName(prevStart) };
  }
  const m = Number(today.slice(5, 7)) - 1;
  const start = `${today.slice(0, 4)}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, '0')}-01`;
  const end = addMonths(start, 3);
  return { start, end, prevStart: addMonths(start, -3), label: `${monthName(start)} – ${monthName(addDays(end, -1))}`, prevLabel: 'last quarter' };
}

@Controller()
export class InsightsController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async scopeName(): Promise<string> {
    const scope = branchScope();
    if (!scope) return 'All branches';
    const rows = await this.db.db.select({ name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, scope));
    return rows.map((r) => r.name).join(' · ') || '—';
  }

  @Endpoint(salesContract.funnel)
  @Can('sales:funnel.read')
  async funnel(@Input() { query }: Args<typeof salesContract.funnel>) {
    const db = this.db.db;
    const p = period(query.period);
    const from = istDateTime(p.start);
    const to = istDateTime(p.end);
    const scope = inBranchScope(s.lead.branchId);
    const leads = await db
      .select({ id: s.lead.id, stage: s.lead.stage, source: s.lead.source, lostReason: s.lead.lostReason, responded: s.lead.responded, createdAt: s.lead.createdAt, firstResponseAt: s.lead.firstResponseAt })
      .from(s.lead)
      .where(and(scope, gte(s.lead.createdAt, from), lt(s.lead.createdAt, to)));
    const [prev] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.lead)
      .where(and(scope, gte(s.lead.createdAt, istDateTime(p.prevStart)), lt(s.lead.createdAt, from)));

    // Furthest stage reached: current stage, or the furthest recorded in the stage history (lost leads).
    const ids = leads.map((l) => l.id);
    const history = new Map<string, number>();
    if (ids.length) {
      const arr = sql.raw(`ARRAY[${STAGE_ORDER.map((x) => `'${x}'`).join(',')}]::text[]`);
      const rows = await db
        .select({ id: s.leadActivity.leadId, idx: sql<number>`max(array_position(${arr}, ${s.leadActivity.meta}->>'to'))` })
        .from(s.leadActivity)
        .where(and(inArray(s.leadActivity.leadId, ids), eq(s.leadActivity.kind, 'stage')))
        .groupBy(s.leadActivity.leadId);
      for (const r of rows) if (r.idx != null) history.set(r.id, Number(r.idx) - 1);
    }
    const reached = leads.map((l) => {
      const cur = l.stage === 'lost' ? (l.responded ? 1 : 0) : STAGE_ORDER.indexOf(l.stage);
      return Math.max(cur, history.get(l.id) ?? 0);
    });
    const counts = PIPELINE_COLUMNS.map((_, i) => reached.filter((r) => r >= i).length);
    const top = counts[0] || 0;
    const stages = PIPELINE_COLUMNS.map((stage, i) => ({
      stage,
      label: LEAD_STAGE_LABEL[stage],
      n: counts[i]!,
      pct: top ? Math.round((counts[i]! / top) * 1000) / 10 : 0,
      conv: i === 0 ? '' : `${conversionPct(counts[i - 1]!, counts[i]!)}%`,
    }));

    const won = leads.filter((l) => l.stage === 'won').length;
    const lost = leads.filter((l) => l.stage === 'lost');
    const reasons = new Map<string, number>();
    for (const l of lost) reasons.set(l.lostReason ?? 'Other', (reasons.get(l.lostReason ?? 'Other') ?? 0) + 1);
    const lostTop = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const lostLine = lost.length
      ? `Conversion shown step-to-step · lost reasons: ${lostTop.map(([r, n]) => `${r.toLowerCase()} ${Math.round((n / lost.length) * 100)}%`).join(', ')}`
      : 'Conversion shown step-to-step · no lost leads in this period';

    const median = medianMinutes(leads.filter((l) => l.firstResponseAt).map((l) => Math.max(0, Math.round((l.firstResponseAt!.getTime() - l.createdAt.getTime()) / 60_000))));
    const [rev] = await db
      .select({ total: sql<string>`coalesce(sum((${s.admission.quote}->>'total')::bigint), 0)`, n: sql<number>`count(*)::int` })
      .from(s.admission)
      .where(and(inBranchScope(s.admission.branchId), eq(s.admission.status, 'approved'), gte(s.admission.approvedAt, from), lt(s.admission.approvedAt, to)));

    const bySource = new Map<string, { leads: number; won: number }>();
    for (const l of leads) {
      const e = bySource.get(l.source) ?? { leads: 0, won: 0 };
      e.leads++;
      if (l.stage === 'won') e.won++;
      bySource.set(l.source, e);
    }
    const sources = [...bySource.entries()].map(([source, e]) => ({ source: source === 'Website' ? 'Website form' : source, leads: e.leads, won: e.won, convPct: conversionPct(e.leads, e.won), best: false })).sort((a, b) => b.leads - a.leads);
    const bestPct = Math.max(0, ...sources.map((x) => x.convPct));
    for (const x of sources) x.best = bestPct > 0 && x.convPct === bestPct;

    const prevN = Number(prev?.n ?? 0);
    const delta = prevN ? Math.round(((leads.length - prevN) / prevN) * 100) : null;
    return {
      scopeLabel: await this.scopeName(),
      periodLabel: p.label,
      kpis: {
        leads: leads.length,
        leadsMeta: delta == null ? `${prevN} in ${p.prevLabel}` : `${delta >= 0 ? '+' : ''}${delta}% vs ${p.prevLabel}`,
        conversionPct: conversionPct(leads.length, won),
        conversionMeta: `${won} won · ${lost.length} lost`,
        medianFirstResponse: formatDuration(median),
        revenue: Number(rev?.total ?? 0),
        admissions: Number(rev?.n ?? 0),
      },
      stages,
      lostLine,
      sources,
    };
  }

  /** Salespeople in scope: sales roles in the scoped branches, plus anyone holding a target there. */
  private async team(month: string): Promise<{ id: string; name: string }[]> {
    const scope = branchScope();
    const lists = scope ? await Promise.all(scope.map((b) => usersWithRoleInBranch(this.db.db, ['sales', 'salesmanager'], b))) : [await usersWithRoleInBranch(this.db.db, ['sales', 'salesmanager'], null)];
    const map = new Map<string, string>();
    for (const l of lists) for (const u of l) map.set(u.id, u.name);
    const targets = await this.db.db
      .select({ id: s.user.id, name: s.user.name })
      .from(s.salesTarget)
      .innerJoin(s.user, eq(s.user.id, s.salesTarget.userId))
      .where(and(eq(s.salesTarget.month, month), inBranchScope(s.salesTarget.branchId)));
    for (const t of targets) map.set(t.id, t.name);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }

  @Endpoint(salesContract.leaderboard)
  @Can('sales:targets.manage')
  async leaderboard() {
    const db = this.db.db;
    const today = todayIST();
    const month = monthStart(today);
    const next = addMonths(month, 1);
    const from = istDateTime(month);
    const to = istDateTime(next);
    const team = await this.team(month);
    const ids = team.map((t) => t.id);
    const none = ids.length === 0;
    const [leads, adms, targets, nextTargets] = none
      ? [[], [], [], []]
      : await Promise.all([
          db
            .select({ owner: s.lead.ownerUserId, createdAt: s.lead.createdAt, first: s.lead.firstResponseAt })
            .from(s.lead)
            .where(and(inBranchScope(s.lead.branchId), inArray(s.lead.ownerUserId, ids), gte(s.lead.createdAt, from), lt(s.lead.createdAt, to))),
          db
            .select({ sales: s.admission.salesUserId, total: sql<string>`coalesce((${s.admission.quote}->>'total')::bigint, 0)` })
            .from(s.admission)
            .where(and(inBranchScope(s.admission.branchId), inArray(s.admission.salesUserId, ids), eq(s.admission.status, 'approved'), gte(s.admission.approvedAt, from), lt(s.admission.approvedAt, to))),
          db.select().from(s.salesTarget).where(and(inArray(s.salesTarget.userId, ids), eq(s.salesTarget.month, month))),
          db.select().from(s.salesTarget).where(and(inArray(s.salesTarget.userId, ids), eq(s.salesTarget.month, next))),
        ]);
    const rows = team.map((u) => {
      const mine = leads.filter((l) => l.owner === u.id);
      const fast = mine.filter((l) => l.first && l.first.getTime() - l.createdAt.getTime() < TWO_HOURS).length;
      const a = adms.filter((x) => x.sales === u.id);
      const target = targets.find((t) => t.userId === u.id)?.targetAdmissions ?? null;
      return {
        rank: 0,
        userId: u.id,
        name: u.name,
        leads: mine.length,
        fastLine: mine.length ? `${Math.round((fast / mine.length) * 100)}%` : '—',
        admissions: a.length,
        target,
        targetPct: target ? Math.min(100, Math.round((a.length / target) * 100)) : 0,
        revenue: a.reduce((sum, x) => sum + Number(x.total), 0),
      };
    });
    rows.sort((x, y) => y.admissions - x.admissions || y.revenue - x.revenue || y.leads - x.leads || x.name.localeCompare(y.name));
    rows.forEach((r, i) => (r.rank = i + 1));
    return {
      scopeLabel: await this.scopeName(),
      monthLabel: monthName(month, true),
      nextMonth: next,
      nextMonthLabel: monthName(next, true),
      rows,
      nextTargets: rows.map((r) => {
        const n = nextTargets.find((t) => t.userId === r.userId);
        const cur = targets.find((t) => t.userId === r.userId);
        return { userId: r.userId, name: r.name, admissions: n?.targetAdmissions ?? cur?.targetAdmissions ?? 0, revenue: n?.targetRevenue ?? cur?.targetRevenue ?? 0 };
      }),
    };
  }

  @Endpoint(salesContract.setTargets)
  @Can('sales:targets.manage')
  async setTargets(@Input() { body }: Args<typeof salesContract.setTargets>) {
    const month = monthStart(body.month);
    if (month !== body.month) throw invalid('Targets are set per month (use the 1st)', { month: 'Use the first of the month' });
    if (month < monthStart(todayIST())) throw invalid('Past months are closed — set targets for this month or later');
    const branchId = await resolveBranchId(this.db.db);
    assertBranchAccess(branchId);
    const team = await this.team(monthStart(todayIST()));
    for (const r of body.rows) if (!team.some((t) => t.id === r.userId)) throw forbidden('One of the salespeople is outside your team');
    await this.db.tx(async (tx) => {
      const before = await tx.select().from(s.salesTarget).where(and(eq(s.salesTarget.month, month), inArray(s.salesTarget.userId, body.rows.map((r) => r.userId))));
      for (const r of body.rows) {
        await tx
          .insert(s.salesTarget)
          .values({ userId: r.userId, branchId, month, targetAdmissions: r.admissions, targetRevenue: r.revenue })
          .onConflictDoUpdate({ target: [s.salesTarget.userId, s.salesTarget.month], set: { targetAdmissions: r.admissions, targetRevenue: r.revenue } });
      }
      await this.audit.log(tx, {
        action: 'Sales targets set',
        kind: 'update',
        entityType: 'sales_target',
        entityLabel: monthName(month, true),
        before: before.map((b) => ({ userId: b.userId, admissions: b.targetAdmissions, revenue: b.targetRevenue })),
        after: body.rows,
        summary: `${monthName(month, true)} · ${body.rows.length} salespeople · ${body.rows.reduce((a, r) => a + r.admissions, 0)} admissions`,
        branchId,
      });
      this.notify.invalidate(tx, branchId, [['sales']]);
    });
    return { ok: true as const };
  }
}

