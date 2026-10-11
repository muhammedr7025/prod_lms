import { Controller } from '@nestjs/common';
import { salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, ilike, ne, or, sql, type SQL } from '@exatech/db';
import { LEAD_STAGE_LABEL, PIPELINE_COLUMNS, isValidEmail, normalizeEmail, normalizePhone } from '@exatech/domain';
import { branchScope, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { notFound } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { LeadsService } from './leads.service';
import { assertLeadAccess, leadScope, resolveBranchId, scopeLabel, userNames } from './sales.shared';

const WON_WINDOW_MS = 30 * 86_400_000;

@Controller()
export class LeadsController {
  constructor(
    private readonly db: Db,
    private readonly leads: LeadsService,
  ) {}

  @Endpoint(salesContract.pipeline)
  @Can('sales:leads.read')
  async pipeline() {
    const rows = await this.db.db
      .select()
      .from(s.lead)
      .where(and(leadScope(), ne(s.lead.stage, 'lost'), or(ne(s.lead.stage, 'won'), gte(s.lead.updatedAt, new Date(Date.now() - WON_WINDOW_MS)))))
      .orderBy(sql`${s.lead.nextFollowUpAt} asc nulls last`, desc(s.lead.score))
      .limit(2000);
    const cards = await this.leads.cards(this.db.db, rows);
    const columns = PIPELINE_COLUMNS.map((stage) => {
      const list = cards.filter((c) => c.stage === stage);
      return { stage, label: LEAD_STAGE_LABEL[stage], count: list.length, leads: list.slice(0, 60) };
    });
    return { scopeLabel: await scopeLabel(this.db.db), openTotal: cards.filter((c) => c.stage !== 'won').length, columns };
  }

  @Endpoint(salesContract.leads)
  @Can('sales:leads.read')
  async list(@Input() { query }: Args<typeof salesContract.leads>) {
    const where: (SQL | undefined)[] = [leadScope()];
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, '')}%`;
      const digits = query.q.replace(/\D/g, '');
      where.push(or(ilike(s.lead.name, like), ilike(s.lead.email, like), digits.length >= 3 ? ilike(s.lead.phone, `%${digits}%`) : undefined));
    }
    if (query.stage) where.push(eq(s.lead.stage, query.stage));
    if (query.status === 'open') where.push(and(ne(s.lead.stage, 'won'), ne(s.lead.stage, 'lost')));
    if (query.courseId) where.push(eq(s.lead.courseId, query.courseId));
    if (query.source) where.push(eq(s.lead.source, query.source));
    if (query.ownerId) where.push(eq(s.lead.ownerUserId, query.ownerId));
    if (query.minScore) where.push(gte(s.lead.score, query.minScore));
    const [rows, [total]] = await Promise.all([
      this.db.db
        .select()
        .from(s.lead)
        .where(and(...where))
        .orderBy(desc(s.lead.lastActivityAt), asc(s.lead.name))
        .limit(query.limit),
      this.db.db.select({ n: sql<number>`count(*)::int` }).from(s.lead).where(and(...where)),
    ]);
    const cards = await this.leads.cards(this.db.db, rows);
    const items = cards.map((c, i) => {
      const r = rows[i]!;
      return { ...c, phone: r.phone, phoneDisplay: r.phone ? formatLocal(r.phone) : '—', email: r.email, campaign: r.campaign, createdAt: r.createdAt };
    });
    return { scopeLabel: await scopeLabel(this.db.db), items, total: Number(total?.n ?? 0) };
  }

  @Endpoint(salesContract.checkLead)
  @Can('sales:leads.create')
  async check(@Input() { query }: Args<typeof salesContract.checkLead>) {
    const c = ctx();
    const phone = normalizePhone(query.phone ?? null);
    const rawEmail = query.email?.trim() || null;
    const email = normalizeEmail(rawEmail);
    const dup = phone || email ? await this.leads.findDuplicate(this.db.db, c.institutionId, phone, email) : null;
    const scope = branchScope();
    const visible = !!dup && dup.kind === 'lead' && (!scope || scope.includes(dup.branchId)) && (can('sales:leads.all') || dup.ownerUserId === c.userId);
    const duplicate = dup ? { kind: dup.kind, id: dup.id, name: dup.name, line: dup.line, canOpen: visible } : null;
    let assignee: { userId: string; name: string; ruleName: string } | null = null;
    if (query.source) {
      const branchId = await resolveBranchId(this.db.db, query.preferredBranchId);
      const hit = await this.leads.pickAssignee(this.db.db, branchId, { source: query.source, courseId: query.courseId ?? null, preferredBranchId: query.preferredBranchId ?? branchId }, false);
      if (hit) {
        const names = await userNames(this.db.db, [hit.userId]);
        assignee = { userId: hit.userId, name: names.get(hit.userId) ?? '—', ruleName: hit.ruleName };
      }
    }
    return { phoneValid: !!phone, phoneE164: phone, emailValid: !rawEmail || isValidEmail(rawEmail), duplicate, assignee };
  }

  @Endpoint(salesContract.getLead)
  @Can('sales:leads.read')
  async get(@Input() { params }: Args<typeof salesContract.getLead>) {
    const [lead] = await this.db.db.select().from(s.lead).where(and(eq(s.lead.id, params.id), leadScope()));
    if (!lead) throw notFound('Lead');
    return this.leads.detail(this.db.db, lead);
  }

  @Endpoint(salesContract.createLead)
  @Can('sales:leads.create')
  async create(@Input() { body }: Args<typeof salesContract.createLead>) {
    const c = ctx();
    const branchId = await resolveBranchId(this.db.db, body.preferredBranchId);
    const { id } = await this.db.tx((tx) =>
      this.leads.create(tx, { ...body, email: body.email ?? null }, { institutionId: c.institutionId, branchId, actorUserId: c.userId, actorIsSales: this.leads.actorIsSales(), via: 'manual' }),
    );
    // The creator may not own the lead (rules route it); read it back unscoped.
    const [lead] = await this.db.db.select().from(s.lead).where(eq(s.lead.id, id));
    return this.leads.detail(this.db.db, lead!);
  }

  @Endpoint(salesContract.setStage)
  @Can('sales:leads.update')
  async setStage(@Input() { params, body }: Args<typeof salesContract.setStage>) {
    const c = ctx();
    const updated = await this.db.tx(async (tx) => {
      const lead = await this.leads.lockLead(tx, params.id);
      assertLeadAccess(lead);
      return this.leads.setStage(tx, lead, body, c.userId);
    });
    const [card] = await this.leads.cards(this.db.db, [updated]);
    return card!;
  }

  @Endpoint(salesContract.logActivity)
  @Can('sales:leads.update')
  async logActivity(@Input() { params, body }: Args<typeof salesContract.logActivity>) {
    const c = ctx();
    await this.db.tx(async (tx) => {
      const lead = await this.leads.lockLead(tx, params.id);
      assertLeadAccess(lead);
      await this.leads.logActivity(tx, lead, body, c.userId);
    });
    const [lead] = await this.db.db.select().from(s.lead).where(eq(s.lead.id, params.id));
    return this.leads.detail(this.db.db, lead!);
  }
}

/** "+919847011223" → "98470 11223" for tables. */
function formatLocal(e164: string): string {
  if (e164.startsWith('+91') && e164.length === 13) return `${e164.slice(3, 8)} ${e164.slice(8)}`;
  return e164;
}
