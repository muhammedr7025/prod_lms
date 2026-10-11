import { Controller, Res } from '@nestjs/common';
import { institutionContract } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { Can, Endpoint } from '../../core/http';
import { MetricsService } from './metrics.service';

/** Super Admin · Overview: KPIs for the selected branch scope + by-branch table (materialised, ≤ 60 s). */
@Controller()
export class InstitutionOverviewController {
  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  @Endpoint(institutionContract.overview)
  @Can('institution:overview.read')
  async overview() {
    return this.metrics.overview();
  }

  /** Watermarked CSV of the KPIs and the by-branch table (logged). */
  @Endpoint({ method: 'GET', path: institutionContract.exportPath, response: z.any() })
  @Can('institution:overview.read')
  async export(@Res() reply: FastifyReply) {
    const o = await this.metrics.overview();
    const c = ctx();
    const k = o.kpis;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rupee = (p: number) => (p / 100).toFixed(2);
    const lines = [
      `# Exported by ${c.userName} (${c.roleLabel}) at ${new Date().toISOString()} — confidential, do not share`,
      `# Scope: ${o.scopeLabel} · aggregates computed ${new Date(o.computedAt).toISOString()}`,
      ['kpi', 'value', 'note'].join(','),
      [`Revenue · ${k.monthLabel} (INR)`, rupee(k.revenue), k.revenueNote].map(esc).join(','),
      ['Collected (INR)', rupee(k.collected), `${k.collectedPct}% of target ${formatINR(k.target)}`].map(esc).join(','),
      ['Dues outstanding (INR)', rupee(k.dues), k.duesNote].map(esc).join(','),
      [`Admissions · ${k.monthLabel}`, k.admissions, `${k.admissionsNote} · ${k.awaitingApproval} awaiting approval`].map(esc).join(','),
      ['Active students', k.activeStudents, k.studentsNote].map(esc).join(','),
      '',
      ['branch', 'code', 'students', 'admissions', 'collected_inr', 'dues_inr', 'target_inr', 'collection_vs_target_pct', 'status'].join(','),
      ...o.branches.map((b) => [b.name, b.code, b.students, b.admissions, rupee(b.collected), rupee(b.dues), rupee(b.target), b.collectedPct, b.statusLabel].map(esc).join(',')),
    ];
    const scope = branchScope();
    await this.audit.log(this.db.db, {
      action: 'Export',
      kind: 'export',
      entityType: 'report',
      entityLabel: 'institution-overview',
      summary: `Overview CSV · ${o.scopeLabel} · ${o.branches.length} branch row${o.branches.length === 1 ? '' : 's'} · watermarked`,
      branchId: scope && scope.length === 1 ? scope[0]! : null,
    });
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="institution-overview-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(lines.join('\n'));
  }
}
