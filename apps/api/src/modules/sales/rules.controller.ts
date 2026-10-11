import { Controller } from '@nestjs/common';
import { salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gt, inArray, lt, ne, sql, type Tx } from '@exatech/db';
import { LEAD_SOURCES } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { NotifyService } from '../../core/notifications/notify.service';
import { branchName, firstName, resolveBranchId, unavailableUsers, userNames, usersWithRoleInBranch } from './sales.shared';

type Rule = typeof s.assignmentRule.$inferSelect;

@Controller()
export class RulesController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async branch(): Promise<string> {
    const id = await resolveBranchId(this.db.db);
    assertBranchAccess(id);
    return id;
  }

  private assignLabel(rule: Pick<Rule, 'strategy' | 'assigneeUserIds'>, names: Map<string, string>): string {
    const list = rule.assigneeUserIds.map((id) => names.get(id) ?? '—');
    if (rule.strategy === 'single' || list.length === 1) return list[0] ?? '—';
    return `Round robin · ${list.map((n) => firstName(n)).join(', ')}`;
  }

  @Endpoint(salesContract.rules)
  @Can('sales:rules.manage')
  async list() {
    const branchId = await this.branch();
    const db = this.db.db;
    const rules = await db.select().from(s.assignmentRule).where(eq(s.assignmentRule.branchId, branchId)).orderBy(asc(s.assignmentRule.position));
    const [courses, branches] = await Promise.all([
      db.select({ id: s.course.id, name: s.course.name }).from(s.course).where(eq(s.course.status, 'active')).orderBy(asc(s.course.name)),
      db.select({ id: s.branch.id, name: s.branch.name }).from(s.branch).where(ne(s.branch.status, 'archived')).orderBy(asc(s.branch.openedOn)),
    ]);
    const cname = new Map(courses.map((c) => [c.id, c.name]));
    const bname = new Map(branches.map((b) => [b.id, b.name]));
    const members = await usersWithRoleInBranch(db, ['sales', 'salesmanager'], branchId);
    const extra = [...new Set(rules.flatMap((r) => r.assigneeUserIds))].filter((id) => !members.some((m) => m.id === id));
    const extraNames = await userNames(db, extra);
    const team = [...members, ...extra.map((id) => ({ id, name: extraNames.get(id) ?? '—' }))].sort((a, b) => a.name.localeCompare(b.name));
    const names = new Map(team.map((t) => [t.id, t.name]));
    const away = await unavailableUsers(db, team.map((t) => t.id));
    const ids = team.map((t) => t.id);
    const now = new Date();
    const [open, overdue] = ids.length
      ? await Promise.all([
          db
            .select({ id: s.lead.ownerUserId, n: sql<number>`count(*)::int` })
            .from(s.lead)
            .where(and(eq(s.lead.branchId, branchId), inArray(s.lead.ownerUserId, ids), ne(s.lead.stage, 'won'), ne(s.lead.stage, 'lost')))
            .groupBy(s.lead.ownerUserId),
          db
            .select({ id: s.lead.ownerUserId, n: sql<number>`count(distinct ${s.lead.id})::int` })
            .from(s.followUp)
            .innerJoin(s.lead, eq(s.lead.id, s.followUp.leadId))
            .where(and(eq(s.lead.branchId, branchId), inArray(s.lead.ownerUserId, ids), eq(s.followUp.status, 'open'), lt(s.followUp.dueAt, now), ne(s.lead.stage, 'won'), ne(s.lead.stage, 'lost')))
            .groupBy(s.lead.ownerUserId),
        ])
      : [[], []];
    const count = (list: { id: string | null; n: number }[], id: string) => Number(list.find((x) => x.id === id)?.n ?? 0);
    return {
      branchId,
      branchName: await branchName(db, branchId),
      rules: rules.map((r) => {
        const c = r.condition ?? {};
        const parts: string[] = [];
        if (c.sources?.length) parts.push(c.sources.length === 1 ? `Source = ${c.sources[0]}` : `Source ∈ ${c.sources.join(', ')}`);
        if (c.courseIds?.length) {
          const n = c.courseIds.map((id) => cname.get(id) ?? '—');
          parts.push(n.length === 1 ? `Course = ${n[0]}` : `Course ∈ ${n.join(', ')}`);
        }
        if (c.preferredBranchIds?.length) {
          const n = c.preferredBranchIds.map((id) => bname.get(id) ?? '—');
          parts.push(n.length === 1 ? `Preferred branch = ${n[0]}` : `Preferred branch ∈ ${n.join(', ')}`);
        }
        return {
          id: r.id,
          position: r.position,
          name: r.name,
          whenLabel: parts.length ? parts.join(' · ') : 'Everything else',
          assignLabel: r.assigneeLabel ?? this.assignLabel(r, names),
          fallback: r.fallback ?? '—',
          matched: r.matchedCount,
          enabled: r.enabled,
          isDefault: r.isDefault,
          strategy: r.strategy,
          condition: { sources: c.sources ?? [], courseIds: c.courseIds ?? [], preferredBranchIds: c.preferredBranchIds ?? [] },
          assigneeUserIds: r.assigneeUserIds,
        };
      }),
      team: team.map((t) => ({ id: t.id, name: t.name, onLeave: away.has(t.id), openLeads: count(open, t.id), overdueLeads: count(overdue, t.id) })),
      courses,
      branches,
      sources: [...LEAD_SOURCES],
    };
  }

  private async lockRule(tx: Tx, id: string): Promise<Rule> {
    const [r] = await tx.select().from(s.assignmentRule).where(eq(s.assignmentRule.id, id)).for('update');
    if (!r) throw notFound('Rule');
    assertBranchAccess(r.branchId);
    return r;
  }

  private async labelFor(tx: Tx, strategy: 'single' | 'round_robin', ids: string[]): Promise<string> {
    const names = await userNames(tx, ids);
    return this.assignLabel({ strategy, assigneeUserIds: ids }, names);
  }

  @Endpoint(salesContract.createRule)
  @Can('sales:rules.manage')
  async create(@Input() { body }: Args<typeof salesContract.createRule>) {
    const branchId = await this.branch();
    const cond = body.condition;
    if (!cond.sources.length && !cond.courseIds.length && !cond.preferredBranchIds.length) throw invalid('Add at least one condition — the default rule already catches everything else', { condition: 'Required' });
    await this.db.tx(async (tx) => {
      const rules = await tx.select().from(s.assignmentRule).where(eq(s.assignmentRule.branchId, branchId)).orderBy(asc(s.assignmentRule.position)).for('update');
      const def = rules.find((r) => r.isDefault);
      // New rules go just above the default (catch-all) rule.
      const position = def ? def.position : (rules.at(-1)?.position ?? 0) + 1;
      if (def) await tx.update(s.assignmentRule).set({ position: def.position + 1 }).where(eq(s.assignmentRule.id, def.id));
      const [row] = await tx
        .insert(s.assignmentRule)
        .values({ branchId, position, name: body.name, condition: cond, assigneeUserIds: body.assigneeUserIds, assigneeLabel: await this.labelFor(tx, body.strategy, body.assigneeUserIds), strategy: body.strategy, fallback: body.fallback })
        .returning();
      await this.audit.log(tx, { action: 'Assignment rule created', kind: 'create', entityType: 'assignment_rule', entityId: row!.id, entityLabel: body.name, after: body, summary: `#${position} ${body.name}`, branchId });
      this.notify.invalidate(tx, branchId, [['sales']]);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.updateRule)
  @Can('sales:rules.manage')
  async update(@Input() { params, body }: Args<typeof salesContract.updateRule>) {
    await this.db.tx(async (tx) => {
      const r = await this.lockRule(tx, params.id);
      const cond = r.isDefault ? { sources: [], courseIds: [], preferredBranchIds: [] } : body.condition;
      if (!r.isDefault && !cond.sources.length && !cond.courseIds.length && !cond.preferredBranchIds.length) throw invalid('Add at least one condition — the default rule already catches everything else', { condition: 'Required' });
      await tx
        .update(s.assignmentRule)
        .set({ name: body.name, condition: cond, assigneeUserIds: body.assigneeUserIds, assigneeLabel: await this.labelFor(tx, body.strategy, body.assigneeUserIds), strategy: body.strategy, fallback: body.fallback, cursor: 0 })
        .where(eq(s.assignmentRule.id, r.id));
      await this.audit.log(tx, { action: 'Assignment rule updated', kind: 'update', entityType: 'assignment_rule', entityId: r.id, entityLabel: body.name, before: { name: r.name, condition: r.condition, assignees: r.assigneeUserIds, strategy: r.strategy }, after: body, summary: `${r.name} → ${body.name}`, branchId: r.branchId });
      this.notify.invalidate(tx, r.branchId, [['sales']]);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.toggleRule)
  @Can('sales:rules.manage')
  async toggle(@Input() { params, body }: Args<typeof salesContract.toggleRule>) {
    await this.db.tx(async (tx) => {
      const r = await this.lockRule(tx, params.id);
      if (r.isDefault && !body.enabled) throw invalid('The default rule catches every lead no other rule matches — it cannot be switched off');
      await tx.update(s.assignmentRule).set({ enabled: body.enabled }).where(eq(s.assignmentRule.id, r.id));
      await this.audit.log(tx, { action: body.enabled ? 'Assignment rule enabled' : 'Assignment rule disabled', kind: 'update', entityType: 'assignment_rule', entityId: r.id, entityLabel: r.name, summary: `${r.enabled ? 'On' : 'Off'} → ${body.enabled ? 'On' : 'Off'}`, branchId: r.branchId });
      this.notify.invalidate(tx, r.branchId, [['sales']]);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.moveRule)
  @Can('sales:rules.manage')
  async move(@Input() { params, body }: Args<typeof salesContract.moveRule>) {
    await this.db.tx(async (tx) => {
      const r = await this.lockRule(tx, params.id);
      if (r.isDefault) throw invalid('The default rule always runs last');
      const [other] = await tx
        .select()
        .from(s.assignmentRule)
        .where(and(eq(s.assignmentRule.branchId, r.branchId), body.direction === 'up' ? lt(s.assignmentRule.position, r.position) : gt(s.assignmentRule.position, r.position)))
        .orderBy(body.direction === 'up' ? desc(s.assignmentRule.position) : asc(s.assignmentRule.position))
        .limit(1)
        .for('update');
      if (!other) throw invalid(body.direction === 'up' ? 'Already the first rule' : 'Already the last rule');
      if (other.isDefault) throw invalid('The default rule always runs last');
      await tx.update(s.assignmentRule).set({ position: other.position }).where(eq(s.assignmentRule.id, r.id));
      await tx.update(s.assignmentRule).set({ position: r.position }).where(eq(s.assignmentRule.id, other.id));
      await this.audit.log(tx, { action: 'Assignment rules reordered', kind: 'update', entityType: 'assignment_rule', entityId: r.id, entityLabel: r.name, summary: `#${r.position} → #${other.position}`, branchId: r.branchId });
      this.notify.invalidate(tx, r.branchId, [['sales']]);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.deleteRule)
  @Can('sales:rules.manage')
  async remove(@Input() { params }: Args<typeof salesContract.deleteRule>) {
    await this.db.tx(async (tx) => {
      const r = await this.lockRule(tx, params.id);
      if (r.isDefault) throw invalid('The default rule cannot be deleted');
      await tx.delete(s.assignmentRule).where(eq(s.assignmentRule.id, r.id));
      // Keep positions contiguous (1…n) so "#" reads naturally.
      const rest = await tx.select({ id: s.assignmentRule.id }).from(s.assignmentRule).where(eq(s.assignmentRule.branchId, r.branchId)).orderBy(asc(s.assignmentRule.position));
      for (const [i, x] of rest.entries()) await tx.update(s.assignmentRule).set({ position: i + 1 }).where(eq(s.assignmentRule.id, x.id));
      await this.audit.log(tx, { action: 'Assignment rule deleted', kind: 'delete', entityType: 'assignment_rule', entityId: r.id, entityLabel: r.name, before: { condition: r.condition, assignees: r.assigneeUserIds }, summary: `#${r.position} ${r.name}`, branchId: r.branchId });
      this.notify.invalidate(tx, r.branchId, [['sales']]);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.reassign)
  @Can('sales:rules.manage')
  async reassign(@Input() { body }: Args<typeof salesContract.reassign>) {
    const c = ctx();
    if (body.fromUserId === body.toUserId) throw invalid('Pick a different salesperson to receive the leads', { toUserId: 'Same person' });
    const branchId = await this.branch();
    const members = await usersWithRoleInBranch(this.db.db, ['sales', 'salesmanager'], branchId);
    if (!members.some((m) => m.id === body.toUserId)) throw forbidden('The receiver is not on this branch’s sales team');
    const count = await this.db.tx(async (tx) => {
      const now = new Date();
      const base = and(eq(s.lead.branchId, branchId), eq(s.lead.ownerUserId, body.fromUserId), ne(s.lead.stage, 'won'), ne(s.lead.stage, 'lost'));
      let ids: string[];
      if (body.which === 'overdue') {
        const rows = await tx
          .selectDistinct({ id: s.lead.id })
          .from(s.followUp)
          .innerJoin(s.lead, eq(s.lead.id, s.followUp.leadId))
          .where(and(base, eq(s.followUp.status, 'open'), lt(s.followUp.dueAt, now)));
        ids = rows.map((r) => r.id);
      } else {
        ids = (await tx.select({ id: s.lead.id }).from(s.lead).where(base)).map((r) => r.id);
      }
      if (ids.length === 0) throw invalid('No leads match — nothing to reassign');
      await tx.select({ id: s.lead.id }).from(s.lead).where(inArray(s.lead.id, ids)).for('update');
      await tx.update(s.lead).set({ ownerUserId: body.toUserId, updatedAt: now }).where(inArray(s.lead.id, ids));
      await tx.update(s.followUp).set({ ownerUserId: body.toUserId }).where(and(inArray(s.followUp.leadId, ids), eq(s.followUp.status, 'open')));
      const names = await userNames(tx, [body.fromUserId, body.toUserId]);
      const from = names.get(body.fromUserId) ?? '—';
      const to = names.get(body.toUserId) ?? '—';
      await tx.insert(s.leadActivity).values(ids.map((leadId) => ({ leadId, actorUserId: c.userId, kind: 'assigned' as const, summary: `Reassigned ${from} → ${to}`, meta: { from: body.fromUserId, to: body.toUserId } })));
      await this.notify.notify(tx, {
        userIds: [body.toUserId],
        category: 'lead',
        title: `${ids.length} lead${ids.length === 1 ? '' : 's'} reassigned to you`,
        body: `From ${from}${body.which === 'overdue' ? ' · overdue follow-ups' : ''} · by ${c.userName}`,
        link: '/sales/pipeline',
      });
      await this.audit.log(tx, {
        action: 'Leads reassigned',
        kind: 'update',
        entityType: 'lead',
        entityLabel: `${ids.length} leads`,
        before: { owner: body.fromUserId },
        after: { owner: body.toUserId, which: body.which, leadIds: ids.slice(0, 200) },
        summary: `${from} → ${to} · ${ids.length} ${body.which === 'overdue' ? 'with overdue follow-ups' : 'open leads'}`,
        branchId,
      });
      this.notify.invalidate(tx, branchId, [['sales']]);
      return ids.length;
    });
    return { count };
  }
}
