import { Injectable } from '@nestjs/common';
import type { InstKpis, InstOverview } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, inArray, sql } from '@exatech/db';
import { addDays, addMonths, formatINRCompact, istDateTime, monthName, monthStart, todayIST } from '@exatech/domain';
import { branchScope } from '../../core/context';
import { Db } from '../../core/db';
import { RedisService } from '../../core/redis';
import { branchStatus, idList, pct } from './institution.shared';

export interface BranchMetric {
  students: number;
  runningBatches: number;
  liveBatches: number;
  admissions: number;
  awaiting: number;
  leads: number;
  revenue: number;
  revenuePrev: number;
  collected: number;
  dues: number;
  duesOver60: number;
}

const EMPTY: BranchMetric = { students: 0, runningBatches: 0, liveBatches: 0, admissions: 0, awaiting: 0, leads: 0, revenue: 0, revenuePrev: 0, collected: 0, dues: 0, duesOver60: 0 };

/**
 * Institution KPIs, computed per branch with one grouped query per measure
 * (read-only over Academics, Sales and Finance tables) and materialised in
 * Redis for 60 s per branch scope (PRD §14: dashboards refresh ≤ 60 s).
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
  ) {}

  /** Calendar boundaries of the current and previous IST month. */
  months(today = todayIST()) {
    const cur = monthStart(today);
    const next = addMonths(cur, 1);
    const prev = addMonths(cur, -1);
    return { today, cur, next, prev, curAt: istDateTime(cur).toISOString(), nextAt: istDateTime(next).toISOString(), label: monthName(cur, true), prevLabel: monthName(prev, true), short: monthName(cur) };
  }

  async perBranch(branchIds: string[] | null): Promise<Map<string, BranchMetric>> {
    const m = this.months();
    const f = (col: string) => (branchIds === null ? sql`true` : sql`${sql.raw(col)} in ${idList(branchIds)}`);
    const over60 = addDays(m.today, -60);
    const [students, batches, admissions, leads, revenue, collected, dues] = await Promise.all([
      this.db.db.execute<{ branch_id: string; n: number }>(sql`
        select branch_id, count(distinct student_id)::int as n from enrollment where status = 'active' and ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; running: number; live: number }>(sql`
        select branch_id, (count(*) filter (where status = 'running'))::int as running,
          (count(*) filter (where status in ('planned', 'open', 'running', 'waitlist')))::int as live
        from batch where ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; approved: number; awaiting: number }>(sql`
        select branch_id, (count(*) filter (where status = 'approved' and approved_at >= ${m.curAt} and approved_at < ${m.nextAt}))::int as approved,
          (count(*) filter (where status in ('submitted', 'fee_verified')))::int as awaiting
        from admission where ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; n: number }>(sql`
        select branch_id, count(*)::int as n from lead where created_at >= ${m.curAt} and created_at < ${m.nextAt} and ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; cur: string; prev: string }>(sql`
        select branch_id, coalesce(sum(total) filter (where issue_date >= ${m.cur}), 0) as cur, coalesce(sum(total) filter (where issue_date < ${m.cur}), 0) as prev
        from invoice where status <> 'cancelled' and issue_date >= ${m.prev} and issue_date < ${m.next} and ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; n: string }>(sql`
        select branch_id, coalesce(sum(total), 0) as n from payment where status = 'cleared' and received_at >= ${m.curAt} and received_at < ${m.nextAt} and ${f('branch_id')} group by branch_id`),
      this.db.db.execute<{ branch_id: string; dues: string; over60: string }>(sql`
        select branch_id, coalesce(sum(greatest(amount - paid - waived, 0)), 0) as dues,
          coalesce(sum(greatest(amount - paid - waived, 0)) filter (where due_date < ${over60}), 0) as over60
        from instalment where due_date <= ${m.today} and status not in ('paid', 'waived', 'cancelled') and ${f('branch_id')} group by branch_id`),
    ]);
    const out = new Map<string, BranchMetric>();
    const get = (id: string) => {
      let x = out.get(id);
      if (!x) out.set(id, (x = { ...EMPTY }));
      return x;
    };
    for (const r of students) get(r.branch_id).students = Number(r.n);
    for (const r of batches) Object.assign(get(r.branch_id), { runningBatches: Number(r.running), liveBatches: Number(r.live) });
    for (const r of admissions) Object.assign(get(r.branch_id), { admissions: Number(r.approved), awaiting: Number(r.awaiting) });
    for (const r of leads) get(r.branch_id).leads = Number(r.n);
    for (const r of revenue) Object.assign(get(r.branch_id), { revenue: Number(r.cur), revenuePrev: Number(r.prev) });
    for (const r of collected) get(r.branch_id).collected = Number(r.n);
    for (const r of dues) Object.assign(get(r.branch_id), { dues: Number(r.dues), duesOver60: Number(r.over60) });
    return out;
  }

  metricFor(map: Map<string, BranchMetric>, id: string): BranchMetric {
    return map.get(id) ?? { ...EMPTY };
  }

  kpis(totals: BranchMetric, target: number): InstKpis {
    const m = this.months();
    const delta = totals.revenuePrev > 0 ? Math.round(((totals.revenue - totals.revenuePrev) / totals.revenuePrev) * 100) : null;
    const conversion = totals.leads > 0 ? Math.round((totals.admissions / totals.leads) * 1000) / 10 : 0;
    return {
      monthLabel: m.label,
      prevMonthLabel: m.prevLabel,
      revenue: totals.revenue,
      revenuePrev: totals.revenuePrev,
      revenueNote: delta === null ? `no invoices in ${m.prevLabel}` : `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}% vs ${m.prevLabel}`,
      collected: totals.collected,
      target,
      collectedPct: pct(totals.collected, target),
      dues: totals.dues,
      duesOver60: totals.duesOver60,
      duesNote: `${formatINRCompact(totals.duesOver60)} over 60 days`,
      admissions: totals.admissions,
      leads: totals.leads,
      admissionsNote: `from ${totals.leads.toLocaleString('en-IN')} lead${totals.leads === 1 ? '' : 's'} · ${conversion}%`,
      awaitingApproval: totals.awaiting,
      activeStudents: totals.students,
      runningBatches: totals.runningBatches,
      studentsNote: `in ${totals.runningBatches} running batch${totals.runningBatches === 1 ? '' : 'es'}`,
    };
  }

  static sum(list: BranchMetric[]): BranchMetric {
    const t = { ...EMPTY };
    for (const x of list) for (const k of Object.keys(t) as (keyof BranchMetric)[]) t[k] += x[k];
    return t;
  }

  /** Overview for the current branch scope, materialised for 60 s. */
  async overview(): Promise<InstOverview> {
    const scope = branchScope();
    const key = `inst:overview:${scope ? [...scope].sort().join(',') : 'all'}:${todayIST()}`;
    const scopeLabel = await this.scopeLabel(scope);
    return this.redis.cached(key, 60, async () => {
      const branches = await this.db.db
        .select({ id: s.branch.id, code: s.branch.code, name: s.branch.name, status: s.branch.status, statusNote: s.branch.statusNote, openedOn: s.branch.openedOn, target: s.branch.monthlyTarget })
        .from(s.branch)
        .where(and(scope ? (scope.length ? inArray(s.branch.id, scope) : sql`false`) : undefined, inArray(s.branch.status, ['active', 'paused'])))
        .orderBy(asc(s.branch.openedOn));
      const map = await this.perBranch(scope);
      const rows = branches.map((b) => {
        const x = this.metricFor(map, b.id);
        const st = branchStatus(b);
        return { id: b.id, code: b.code, name: b.name, students: x.students, admissions: x.admissions, collected: x.collected, dues: x.dues, target: b.target, collectedPct: pct(x.collected, b.target), statusLabel: st.label, statusTag: st.tag };
      });
      const totals = MetricsService.sum(branches.map((b) => this.metricFor(map, b.id)));
      const target = branches.reduce((a, b) => a + b.target, 0);
      return { scopeLabel, kpis: this.kpis(totals, target), branches: rows, computedAt: new Date().toISOString() };
    });
  }

  async scopeLabel(scope: string[] | null): Promise<string> {
    if (scope === null) return 'All branches';
    if (scope.length === 0) return 'No branch';
    const rows = await this.db.db.select({ name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, scope));
    return rows.length === 1 ? rows[0]!.name : rows.map((r) => r.name).join(' · ');
  }
}
