import { Controller } from '@nestjs/common';
import { salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from '@exatech/db';
import { formatDuration, formatLongWeekdayDate, formatWeekdayDate, istDateTime, medianMinutes, monthStart, nextStage, toISTDate, toISTTime, todayIST, addDays, type LeadStage } from '@exatech/domain';
import { can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { LeadsService } from './leads.service';
import { assertLeadAccess, dayWindow, leadScope } from './sales.shared';

@Controller()
export class FollowUpsController {
  constructor(
    private readonly db: Db,
    private readonly leads: LeadsService,
  ) {}

  private async items(where: SQL) {
    const c = ctx();
    const own = can('sales:leads.all') ? inBranchScope(s.lead.branchId) : eq(s.followUp.ownerUserId, c.userId);
    const rows = await this.db.db
      .select({
        id: s.followUp.id,
        leadId: s.lead.id,
        leadName: s.lead.name,
        phone: s.lead.phone,
        email: s.lead.email,
        stage: s.lead.stage,
        dueAt: s.followUp.dueAt,
        channel: s.followUp.channel,
        note: s.followUp.note,
        ownerName: s.user.name,
      })
      .from(s.followUp)
      .innerJoin(s.lead, eq(s.lead.id, s.followUp.leadId))
      .innerJoin(s.user, eq(s.user.id, s.followUp.ownerUserId))
      .where(and(eq(s.followUp.status, 'open'), own, where))
      .orderBy(asc(s.followUp.dueAt))
      .limit(200);
    const today = todayIST();
    const yesterday = addDays(today, -1);
    return rows.map((r) => {
      const d = toISTDate(r.dueAt);
      const t = toISTTime(r.dueAt);
      const dueLabel = d === today ? t : d === yesterday ? `Yesterday ${t}` : `${formatWeekdayDate(d)} ${t}`;
      return { ...r, dueLabel, nextStage: nextStage(r.stage as LeadStage) };
    });
  }

  @Endpoint(salesContract.followUps)
  @Can('sales:followups.manage')
  async list() {
    const c = ctx();
    const { start, end, date } = dayWindow();
    const [overdue, todayItems] = await Promise.all([this.items(lt(s.followUp.dueAt, start)), this.items(and(gte(s.followUp.dueAt, start), lt(s.followUp.dueAt, end))!)]);
    const ownFU = can('sales:leads.all') ? undefined : eq(s.followUp.ownerUserId, c.userId);
    const [upcoming] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.followUp)
      .innerJoin(s.lead, eq(s.lead.id, s.followUp.leadId))
      .where(and(eq(s.followUp.status, 'open'), gte(s.followUp.dueAt, end), ownFU, inBranchScope(s.lead.branchId)));

    // Median first response over the last 30 days (own leads, or the team for managers).
    const resp = await this.db.db
      .select({ created: s.lead.createdAt, first: s.lead.firstResponseAt })
      .from(s.lead)
      .where(and(leadScope(), isNotNull(s.lead.firstResponseAt), gte(s.lead.createdAt, new Date(Date.now() - 30 * 86_400_000))));
    const median = medianMinutes(resp.map((r) => Math.max(0, Math.round((r.first!.getTime() - r.created.getTime()) / 60_000))));

    const templates = await this.templatesList();

    const mStart = istDateTime(monthStart(date));
    const [[calls], [adm], [target]] = await Promise.all([
      this.db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.leadActivity)
        .where(and(eq(s.leadActivity.actorUserId, c.userId), eq(s.leadActivity.kind, 'call'), gte(s.leadActivity.createdAt, mStart))),
      this.db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.admission)
        .where(and(eq(s.admission.salesUserId, c.userId), eq(s.admission.status, 'approved'), gte(s.admission.approvedAt, mStart))),
      this.db.db
        .select({ t: s.salesTarget.targetAdmissions })
        .from(s.salesTarget)
        .where(and(eq(s.salesTarget.userId, c.userId), eq(s.salesTarget.month, monthStart(date)))),
    ]);
    const admissions = Number(adm?.n ?? 0);
    const t = target?.t ?? null;
    return {
      dateLabel: formatLongWeekdayDate(date),
      medianFirstResponse: formatDuration(median),
      overdue,
      today: todayItems,
      upcoming: Number(upcoming?.n ?? 0),
      templates,
      myMonth: { calls: Number(calls?.n ?? 0), admissions, target: t, pct: t ? Math.round((admissions / t) * 100) : null },
    };
  }

  private async templatesList() {
    return this.db.db
      .select({
        id: s.messageTemplate.id,
        key: s.messageTemplate.key,
        name: s.messageTemplate.name,
        channel: s.messageTemplate.channel,
        category: s.messageTemplate.category,
        body: s.messageTemplate.body,
        variables: s.messageTemplate.variables,
        status: s.messageTemplate.status,
      })
      .from(s.messageTemplate)
      .where(inArray(s.messageTemplate.category, ['sales']))
      .orderBy(asc(s.messageTemplate.status), asc(s.messageTemplate.key));
  }

  @Endpoint(salesContract.templates)
  @Can('sales:leads.read')
  async templates() {
    return this.templatesList();
  }

  @Endpoint(salesContract.scheduleFollowUp)
  @Can('sales:leads.update', 'sales:followups.manage')
  async schedule(@Input() { body }: Args<typeof salesContract.scheduleFollowUp>) {
    const c = ctx();
    const dueAt = new Date(body.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw invalid('Pick a valid date and time', { dueAt: 'Invalid date' });
    await this.db.tx(async (tx) => {
      const lead = await this.leads.lockLead(tx, body.leadId);
      assertLeadAccess(lead);
      await this.leads.scheduleFollowUp(tx, lead, { dueAt, channel: body.channel, note: body.note ?? null }, c.userId);
    });
    return { ok: true as const };
  }

  @Endpoint(salesContract.completeFollowUp)
  @Can('sales:followups.manage')
  async complete(@Input() { params, body }: Args<typeof salesContract.completeFollowUp>) {
    const c = ctx();
    await this.db.tx(async (tx) => {
      const [f] = await tx.select().from(s.followUp).where(eq(s.followUp.id, params.id)).for('update');
      if (!f) throw notFound('Follow-up');
      if (f.status !== 'open') throw conflict('This follow-up is already closed');
      let lead = await this.leads.lockLead(tx, f.leadId);
      assertLeadAccess(lead);
      await tx.update(s.followUp).set({ status: 'done', outcome: body.outcome, doneAt: new Date() }).where(eq(s.followUp.id, f.id));
      const kind = f.channel === 'visit' ? 'visit' : f.channel;
      await this.leads.logActivity(tx, lead, { kind, summary: body.outcome }, c.userId);
      if (body.next) {
        const dueAt = new Date(body.next.dueAt);
        lead = await this.leads.lockLead(tx, f.leadId);
        await this.leads.scheduleFollowUp(tx, lead, { dueAt, channel: body.next.channel, note: body.next.note ?? null }, c.userId);
      }
      await this.leads.syncNextFollowUp(tx, f.leadId);
      if (body.advance) {
        lead = await this.leads.lockLead(tx, f.leadId);
        const to = nextStage(lead.stage as LeadStage);
        if (!to) throw invalid(`${lead.name} cannot be advanced from here — use Convert to admission`);
        await this.leads.moveStage(tx, lead, to, { actorUserId: c.userId });
      }
    });
    return { ok: true as const };
  }
}
