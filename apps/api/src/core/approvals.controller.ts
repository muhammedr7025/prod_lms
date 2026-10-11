import { Controller } from '@nestjs/common';
import { approvalsContract, type Approval } from '@exatech/contracts';
import * as s from '@exatech/db';
import { alias, and, desc, eq, inArray, ne, or, isNull, sql, type SQL } from '@exatech/db';
import { AuditService } from './audit/audit.service';
import { can, ctx } from './context';
import { Db, inBranchScope } from './db';
import { conflict, forbidden, invalid, notFound } from './errors';
import { EventBus } from './events/event-bus';
import { Can, Endpoint, Input, type Args } from './http';
import { NotifyService } from './notifications/notify.service';

/**
 * Generic approval queue. Super Admins decide `super_admin` requests; users
 * with `finance:approve` decide `finance`-level ones (maker-checker: never
 * your own request). Effects are applied by the owning module's
 * `ApprovalDecided` in-transaction handler.
 */
@Controller()
export class ApprovalsController {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async rows(where: SQL | undefined): Promise<Approval[]> {
    const requester = alias(s.user, 'requester');
    const decider = alias(s.user, 'decider');
    const rows = await this.db.db
      .select({ a: s.approvalRequest, requester: requester.name, decider: decider.name, branchName: s.branch.name })
      .from(s.approvalRequest)
      .innerJoin(requester, eq(requester.id, s.approvalRequest.requestedBy))
      .leftJoin(decider, eq(decider.id, s.approvalRequest.decidedBy))
      .leftJoin(s.branch, eq(s.branch.id, s.approvalRequest.branchId))
      .where(where)
      .orderBy(desc(s.approvalRequest.requestedAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.a.id,
      kind: r.a.kind,
      level: r.a.level,
      status: r.a.status,
      title: r.a.title,
      summary: r.a.summary,
      entityType: r.a.entityType,
      entityId: r.a.entityId,
      amount: r.a.amount,
      pct: r.a.pct,
      branchId: r.a.branchId,
      branchName: r.branchName,
      requestedByName: r.requester,
      requestedAt: r.a.requestedAt.toISOString(),
      decidedByName: r.decider,
      decidedAt: r.a.decidedAt?.toISOString() ?? null,
      decisionNote: r.a.decisionNote,
    }));
  }

  private levels(): ('finance' | 'super_admin')[] {
    const out: ('finance' | 'super_admin')[] = [];
    if (can('institution:approvals.decide')) out.push('super_admin');
    if (can('finance:approve')) out.push('finance');
    return out;
  }

  @Endpoint(approvalsContract.list)
  @Can('institution:approvals.decide', 'finance:approve')
  async list(@Input() { query }: Args<typeof approvalsContract.list>) {
    const levels = query.level ? this.levels().filter((l) => l === query.level) : this.levels();
    if (levels.length === 0) return [];
    const where: (SQL | undefined)[] = [inArray(s.approvalRequest.level, levels)];
    const scope = inBranchScope(s.approvalRequest.branchId);
    if (scope) where.push(or(scope, isNull(s.approvalRequest.branchId)));
    if (query.status === 'pending') where.push(eq(s.approvalRequest.status, 'pending'));
    if (query.status === 'decided') where.push(ne(s.approvalRequest.status, 'pending'));
    return this.rows(and(...where));
  }

  @Endpoint(approvalsContract.decide)
  @Can('institution:approvals.decide', 'finance:approve')
  async decide(@Input() { params, body }: Args<typeof approvalsContract.decide>) {
    const c = ctx();
    if (body.decision !== 'approved' && !body.note) throw invalid('Add a note so the requester knows what to fix', { note: 'Required' });
    await this.db.tx(async (tx) => {
      const [a] = await tx.select().from(s.approvalRequest).where(eq(s.approvalRequest.id, params.id)).for('update');
      if (!a) throw notFound('Approval request');
      if (a.status !== 'pending') throw conflict('This request has already been decided');
      if (!this.levels().includes(a.level)) throw forbidden(a.level === 'super_admin' ? 'Only a Super Admin can decide this request' : 'You cannot decide finance approvals');
      if (a.requestedBy === c.userId) throw forbidden('Maker-checker: you cannot approve your own request');
      if (a.branchId && c.membershipBranchIds && !c.membershipBranchIds.includes(a.branchId)) throw forbidden('This request belongs to a branch outside your membership');
      await tx
        .update(s.approvalRequest)
        .set({ status: body.decision, decidedBy: c.userId, decidedAt: new Date(), decisionNote: body.note ?? null })
        .where(eq(s.approvalRequest.id, a.id));
      await this.events.emit(tx, 'ApprovalDecided', { approvalId: a.id, kind: a.kind, status: body.decision, entityId: a.entityId });
      await this.audit.log(tx, {
        action: body.decision === 'approved' ? 'Approval granted' : body.decision === 'returned' ? 'Approval returned' : 'Approval denied',
        kind: 'approve',
        entityType: 'approval',
        entityId: a.id,
        entityLabel: a.title,
        before: { status: 'pending' },
        after: { status: body.decision, note: body.note ?? null },
        summary: `${a.title} · ${body.decision}${body.note ? ` · ${body.note}` : ''}`,
        branchId: a.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [a.requestedBy],
        category: 'approval',
        title: `${a.title} · ${body.decision}`,
        body: body.note ?? (body.decision === 'approved' ? 'Approved — you can continue.' : 'See the note and resubmit.'),
        link: null,
        entityType: 'approval',
        entityId: a.id,
      });
      this.notify.invalidate(tx, a.branchId, [['approvals'], ['admissions'], ['finance'], ['institution']]);
    });
    const [row] = await this.rows(eq(s.approvalRequest.id, params.id));
    void sql;
    return row!;
  }
}
