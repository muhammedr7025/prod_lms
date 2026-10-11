import { Injectable } from '@nestjs/common';
import type { LeadCard, zLeadDetail } from '@exatech/contracts';
import type { z } from 'zod';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, or, sql, type DbOrTx, type Tx } from '@exatech/db';
import {
  assignLead,
  formatPhone,
  formatWeekdayDate,
  isValidEmail,
  leadScore,
  nextStage,
  normalizeEmail,
  normalizePhone,
  toISTDate,
  toISTTime,
  type AssignmentRuleDef,
  type LeadStage,
} from '@exatech/domain';
import { maybeCtx } from '../../core/context';
import { AuditService } from '../../core/audit/audit.service';
import { DomainError, conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { MANUAL_STAGES, STAGE_ORDER, firstName, nextLine, stageLabel, unavailableUsers, userNames, type LeadRow } from './sales.shared';

export interface NewLead {
  name: string;
  phone: string;
  email?: string | null;
  courseId?: string | null;
  source: string;
  campaign?: string | null;
  preferredBranchId?: string | null;
  note?: string | null;
}

export interface Duplicate {
  kind: 'lead' | 'student';
  id: string;
  name: string;
  line: string;
  ownerUserId: string | null;
  branchId: string;
}

/**
 * Lead lifecycle: create (dedupe → assignment rule → first-response timer),
 * stage changes, activities, follow-ups and score. Used by the staff API,
 * the public enquiry form and the import job.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  /* ───────────── dedupe ───────────── */

  async findDuplicate(db: DbOrTx, institutionId: string, phone: string | null, email: string | null): Promise<Duplicate | null> {
    if (!phone && !email) return null;
    const leadMatch = [phone ? eq(s.lead.phone, phone) : undefined, email ? sql`lower(${s.lead.email}) = ${email}` : undefined].filter(Boolean);
    const studentMatch = [phone ? eq(s.student.phone, phone) : undefined, email ? sql`lower(${s.student.email}) = ${email}` : undefined].filter(Boolean);
    const [stu] = await db
      .select({ id: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo, branchId: s.student.branchId })
      .from(s.student)
      .where(and(eq(s.student.institutionId, institutionId), or(...studentMatch)))
      .limit(1);
    if (stu) return { kind: 'student', id: stu.id, name: stu.name, line: `Already an enrolled student${stu.admissionNo ? ` · ${stu.admissionNo}` : ''}`, ownerUserId: null, branchId: stu.branchId };
    const [ld] = await db
      .select({ id: s.lead.id, name: s.lead.name, stage: s.lead.stage, owner: s.user.name, ownerUserId: s.lead.ownerUserId, branchId: s.lead.branchId })
      .from(s.lead)
      .leftJoin(s.user, eq(s.user.id, s.lead.ownerUserId))
      .where(and(eq(s.lead.institutionId, institutionId), or(...leadMatch)))
      .orderBy(desc(s.lead.createdAt))
      .limit(1);
    if (ld) return { kind: 'lead', id: ld.id, name: ld.name, line: `Already a lead · ${stageLabel(ld.stage)} · ${ld.owner ?? 'unassigned'}`, ownerUserId: ld.ownerUserId, branchId: ld.branchId };
    return null;
  }

  /* ───────────── assignment ───────────── */

  private async rulesFor(db: DbOrTx, branchId: string, lock: boolean) {
    const q = db.select().from(s.assignmentRule).where(eq(s.assignmentRule.branchId, branchId)).orderBy(asc(s.assignmentRule.position));
    return lock ? q.for('update') : q;
  }

  /**
   * Evaluate the branch's rules top-down. `commit` persists the round-robin
   * cursor and match count (inside the create transaction).
   */
  async pickAssignee(
    db: DbOrTx,
    branchId: string,
    facts: { source: string; courseId: string | null; preferredBranchId: string | null },
    commit: boolean,
  ): Promise<{ userId: string; ruleId: string; ruleName: string } | null> {
    const rules = await this.rulesFor(db, branchId, commit);
    if (rules.length === 0) return null;
    const away = await unavailableUsers(db, [...new Set(rules.flatMap((r) => r.assigneeUserIds))]);
    const defs: AssignmentRuleDef[] = rules.map((r) => ({
      id: r.id,
      position: r.position,
      enabled: r.enabled,
      condition: r.condition,
      assigneeIds: r.assigneeUserIds,
      cursor: r.strategy === 'single' ? 0 : r.cursor,
    }));
    const hit = assignLead(facts, defs, (id) => !away.has(id));
    if (!hit) return null;
    const rule = rules.find((r) => r.id === hit.ruleId)!;
    if (commit) {
      await db
        .update(s.assignmentRule)
        .set({ cursor: rule.strategy === 'single' ? rule.cursor : hit.nextCursor, matchedCount: sql`${s.assignmentRule.matchedCount} + 1` })
        .where(eq(s.assignmentRule.id, rule.id));
    }
    return { userId: hit.assigneeId, ruleId: rule.id, ruleName: rule.name };
  }

  /** Branches a salesperson works in (from their sales memberships). */
  private async salesBranches(db: DbOrTx, userId: string): Promise<string[] | null> {
    const rows = await db
      .select({ branchIds: s.membership.branchIds })
      .from(s.membership)
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .where(and(eq(s.membership.userId, userId), eq(s.membership.status, 'active'), inArray(s.role.key, ['sales', 'salesmanager', 'branchadmin', 'superadmin'])));
    if (rows.some((r) => r.branchIds.length === 0)) return null;
    return [...new Set(rows.flatMap((r) => r.branchIds))];
  }

  /* ───────────── score ───────────── */

  async score(db: DbOrTx, l: Pick<LeadRow, 'source' | 'stage' | 'responded' | 'visited' | 'demoAttended' | 'email' | 'courseId' | 'branchId'>): Promise<number> {
    let open = false;
    if (l.courseId) {
      const [b] = await db
        .select({ id: s.batch.id })
        .from(s.batch)
        .where(and(eq(s.batch.courseId, l.courseId), eq(s.batch.branchId, l.branchId), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist'])))
        .limit(1);
      open = !!b;
    }
    return leadScore({ source: l.source, stage: l.stage as LeadStage, responded: l.responded, visited: l.visited, demoAttended: l.demoAttended, courseHasOpenBatch: open, hasEmail: !!l.email });
  }

  /* ───────────── create ───────────── */

  /** Validate + normalise contact details (blocking reasons are field-level). */
  normalize(input: NewLead): { phone: string; email: string | null } {
    const phone = normalizePhone(input.phone);
    if (!phone) throw invalid('Enter a valid 10-digit mobile', { phone: 'Enter a valid 10-digit mobile' });
    const rawEmail = input.email?.trim() || null;
    if (rawEmail && !isValidEmail(rawEmail)) throw invalid('Enter a valid email', { email: 'Enter a valid email' });
    return { phone, email: normalizeEmail(rawEmail) };
  }

  async create(tx: Tx, input: NewLead, opts: { institutionId: string; branchId: string; actorUserId: string | null; actorIsSales: boolean; via: 'manual' | 'website' }): Promise<{ id: string; ownerUserId: string | null; branchId: string }> {
    const { phone, email } = this.normalize(input);
    const dup = await this.findDuplicate(tx, opts.institutionId, phone, email);
    if (dup) {
      const field = dup.kind === 'student' ? 'Already an enrolled student' : 'Already a lead';
      throw new DomainError('DUPLICATE', `${field} — ${dup.name}`, 409, { phone: field }, { kind: dup.kind, id: dup.id, name: dup.name, line: dup.line });
    }
    let courseName: string | null = null;
    if (input.courseId) {
      const [c] = await tx.select({ name: s.course.name }).from(s.course).where(eq(s.course.id, input.courseId));
      if (!c) throw invalid('Pick a course', { courseId: 'Unknown course' });
      courseName = c.name;
    }
    const preferredBranchId = input.preferredBranchId ?? opts.branchId;
    const hit = await this.pickAssignee(tx, opts.branchId, { source: input.source, courseId: input.courseId ?? null, preferredBranchId }, true);
    let ownerUserId = hit?.userId ?? (opts.actorIsSales ? opts.actorUserId : null);
    let branchId = opts.branchId;
    // Cross-branch routing: a rule may hand the lead to another branch's team (e.g. "Preferred branch = Kochi").
    if (ownerUserId && preferredBranchId !== branchId) {
      const ob = await this.salesBranches(tx, ownerUserId);
      if (ob && !ob.includes(branchId) && ob.includes(preferredBranchId)) branchId = preferredBranchId;
    }
    if (!ownerUserId) ownerUserId = null;
    const base = { source: input.source, stage: 'new' as const, responded: false, visited: false, demoAttended: false, email, courseId: input.courseId ?? null, branchId };
    const score = await this.score(tx, base);
    const now = new Date();
    const [row] = await tx
      .insert(s.lead)
      .values({
        institutionId: opts.institutionId,
        branchId,
        name: input.name.trim(),
        phone,
        email,
        source: input.source,
        campaign: input.campaign?.trim() || null,
        courseId: input.courseId ?? null,
        preferredBranchId,
        stage: 'new',
        ownerUserId,
        score,
        assignedByRuleId: hit?.ruleId ?? null,
        createdBy: opts.actorUserId,
        lastActivityAt: now,
      })
      .returning();
    const lead = row!;
    const names = await userNames(tx, [ownerUserId]);
    const ownerName = ownerUserId ? (names.get(ownerUserId) ?? '—') : 'unassigned';
    await tx.insert(s.leadActivity).values({
      leadId: lead.id,
      actorUserId: opts.actorUserId,
      kind: 'created',
      summary: `Created from ${input.source}${hit ? ` · assigned by rule ${hit.ruleName} → ${ownerName}` : ` · ${ownerName}`}`,
      meta: { via: opts.via, ruleId: hit?.ruleId ?? null, note: input.note ?? null },
    });
    if (input.note) await tx.insert(s.leadActivity).values({ leadId: lead.id, actorUserId: null, kind: 'note', summary: `Enquiry · ${input.note.slice(0, 280)}` });
    if (ownerUserId && ownerUserId !== opts.actorUserId) {
      await this.notify.notify(tx, {
        userIds: [ownerUserId],
        category: 'lead',
        title: 'New lead assigned',
        body: `${lead.name} · ${input.source}${courseName ? ` · ${courseName}` : ''} · first response timer started`,
        link: `/sales/leads?lead=${lead.id}`,
        entityType: 'lead',
        entityId: lead.id,
      });
    }
    await this.events.emit(tx, 'LeadCreated', { leadId: lead.id, branchId, ownerUserId, source: input.source });
    await this.audit.log(tx, {
      action: 'Lead created',
      kind: 'create',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: lead.name,
      after: { source: input.source, courseId: lead.courseId, ownerUserId, ruleId: hit?.ruleId ?? null },
      summary: `${input.source}${courseName ? ` · ${courseName}` : ''} → ${ownerName}${hit ? ` (rule: ${hit.ruleName})` : ''}`,
      branchId,
    });
    this.notify.invalidate(tx, branchId, [['sales']]);
    return { id: lead.id, ownerUserId, branchId };
  }

  /* ───────────── stage ───────────── */

  async lockLead(tx: Tx, id: string): Promise<LeadRow> {
    const [l] = await tx.select().from(s.lead).where(eq(s.lead.id, id)).for('update');
    if (!l) throw notFound('Lead');
    return l;
  }

  /** Low-level stage change used by the API, follow-up outcomes and the admission flow. */
  async moveStage(tx: Tx, lead: LeadRow, to: LeadStage, opts: { actorUserId: string | null; lostReason?: string | null; note?: string | null; undo?: boolean; extra?: Partial<typeof s.lead.$inferInsert> }): Promise<LeadRow> {
    const from = lead.stage as LeadStage;
    const demoAttended = lead.demoAttended || (from === 'demo_scheduled' && STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf('demo_scheduled'));
    const next = { ...lead, ...opts.extra, stage: to, demoAttended, lostReason: to === 'lost' ? (opts.lostReason ?? 'Other') : null };
    const score = await this.score(tx, next);
    const patch: Partial<typeof s.lead.$inferInsert> = { ...opts.extra, stage: to, demoAttended, lostReason: next.lostReason, score, lastActivityAt: new Date() };
    if (to === 'lost') {
      patch.nextFollowUpAt = null;
      patch.nextFollowUpNote = null;
      await tx.update(s.followUp).set({ status: 'cancelled' }).where(and(eq(s.followUp.leadId, lead.id), eq(s.followUp.status, 'open')));
    }
    const [updated] = await tx.update(s.lead).set(patch).where(eq(s.lead.id, lead.id)).returning();
    const label = `${stageLabel(from)} → ${stageLabel(to)}`;
    await tx.insert(s.leadActivity).values({
      leadId: lead.id,
      actorUserId: opts.actorUserId,
      kind: 'stage',
      summary: `Stage → ${stageLabel(to)}${to === 'lost' && next.lostReason ? ` · ${next.lostReason}` : ''}${opts.undo ? ' (undo)' : ''}${opts.note ? ` · ${opts.note}` : ''}`,
      meta: { from, to, undo: !!opts.undo },
    });
    await this.events.emit(tx, 'LeadStageChanged', { leadId: lead.id, branchId: lead.branchId, from, to, actorUserId: opts.actorUserId });
    await this.audit.log(tx, {
      action: opts.undo ? 'Lead stage change undone' : 'Lead stage changed',
      kind: 'update',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: lead.name,
      before: { stage: from },
      after: { stage: to, lostReason: next.lostReason },
      summary: `${label}${to === 'lost' && next.lostReason ? ` · ${next.lostReason}` : ''}`,
      branchId: lead.branchId,
    });
    this.notify.invalidate(tx, lead.branchId, [['sales']]);
    return updated!;
  }

  /** User-initiated move: one-click advance, mark lost, or undo. */
  async setStage(tx: Tx, lead: LeadRow, body: { to: LeadStage; from: LeadStage; lostReason?: string; note?: string; undo: boolean }, actorUserId: string): Promise<LeadRow> {
    const cur = lead.stage as LeadStage;
    if (cur !== body.from) throw conflict(`${lead.name} is already in ${stageLabel(cur)} — refresh to see the latest`);
    if (body.to === cur) return lead;
    if (body.to === 'lost') {
      if (!body.lostReason) throw invalid('Pick a lost reason', { lostReason: 'Required' });
      if (cur === 'won') throw invalid(`${lead.name} is already Won`);
      if (cur === 'admission_in_progress') throw invalid('An application is in progress — return or cancel it before marking the lead lost');
    } else if (body.undo) {
      if (!MANUAL_STAGES.includes(body.to)) throw invalid(`${stageLabel(body.to)} is reached through the admission flow`);
      if (cur !== 'lost' && STAGE_ORDER.indexOf(body.to) > STAGE_ORDER.indexOf(cur)) throw invalid('Undo can only move a lead back');
      if (cur === 'admission_in_progress' || cur === 'won') throw invalid(`${stageLabel(cur)} is managed by the admission flow`);
    } else {
      const allowed = nextStage(cur);
      if (allowed !== body.to) {
        throw invalid(
          body.to === 'admission_in_progress' || body.to === 'won'
            ? `${stageLabel(body.to)} is reached through the admission flow — use Convert to admission`
            : `${lead.name} can move from ${stageLabel(cur)} to ${allowed ? stageLabel(allowed) : 'no other stage'} only`,
        );
      }
    }
    return this.moveStage(tx, lead, body.to, { actorUserId, lostReason: body.lostReason, note: body.note, undo: body.undo });
  }

  /* ───────────── activities & follow-ups ───────────── */

  async logActivity(tx: Tx, lead: LeadRow, a: { kind: 'call' | 'whatsapp' | 'email' | 'visit' | 'note'; summary: string; templateKey?: string; consentWhatsapp?: boolean }, actorUserId: string | null): Promise<void> {
    const contact = a.kind === 'call' || a.kind === 'whatsapp' || a.kind === 'email' || a.kind === 'visit';
    const now = new Date();
    const patch: Partial<typeof s.lead.$inferInsert> = { lastActivityAt: now };
    if (contact) {
      patch.responded = true;
      if (!lead.firstResponseAt) patch.firstResponseAt = now;
    }
    if (a.kind === 'visit') patch.visited = true;
    if (a.consentWhatsapp && !lead.consentWhatsapp) {
      patch.consentWhatsapp = true;
      patch.consentCapturedAt = now;
    }
    if (a.kind === 'email' && !lead.consentEmail) patch.consentEmail = true;
    patch.score = await this.score(tx, { ...lead, ...patch } as LeadRow);
    await tx.update(s.lead).set(patch).where(eq(s.lead.id, lead.id));
    const prefix = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Visit', note: 'Note' }[a.kind];
    await tx.insert(s.leadActivity).values({
      leadId: lead.id,
      actorUserId,
      kind: a.kind,
      summary: `${prefix} · ${a.summary}${a.templateKey ? ` (template: ${a.templateKey})` : ''}`.slice(0, 500),
      meta: { templateKey: a.templateKey ?? null, firstResponse: contact && !lead.firstResponseAt },
    });
    await this.audit.log(tx, {
      action: `Lead ${prefix.toLowerCase()} logged`,
      kind: 'update',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: lead.name,
      summary: `${prefix} · ${a.summary}`.slice(0, 300),
      branchId: lead.branchId,
    });
    this.notify.invalidate(tx, lead.branchId, [['sales']]);
  }

  /** Keep lead.nextFollowUpAt/Note in sync with the earliest open follow-up. */
  async syncNextFollowUp(tx: Tx, leadId: string): Promise<void> {
    const [f] = await tx
      .select({ dueAt: s.followUp.dueAt, note: s.followUp.note, channel: s.followUp.channel })
      .from(s.followUp)
      .where(and(eq(s.followUp.leadId, leadId), eq(s.followUp.status, 'open')))
      .orderBy(asc(s.followUp.dueAt))
      .limit(1);
    await tx
      .update(s.lead)
      .set({ nextFollowUpAt: f?.dueAt ?? null, nextFollowUpNote: f ? (f.note ?? channelLabel(f.channel)) : null })
      .where(eq(s.lead.id, leadId));
  }

  async scheduleFollowUp(tx: Tx, lead: LeadRow, f: { dueAt: Date; channel: 'call' | 'whatsapp' | 'email' | 'visit'; note?: string | null }, actorUserId: string): Promise<void> {
    if (Number.isNaN(f.dueAt.getTime())) throw invalid('Pick a valid date and time', { dueAt: 'Invalid date' });
    if (lead.stage === 'won' || lead.stage === 'lost') throw invalid(`${lead.name} is ${stageLabel(lead.stage)} — reopen the lead first`);
    await tx.insert(s.followUp).values({ leadId: lead.id, ownerUserId: lead.ownerUserId ?? actorUserId, dueAt: f.dueAt, channel: f.channel, note: f.note?.trim() || null });
    await this.syncNextFollowUp(tx, lead.id);
    const when = `${formatWeekdayDate(toISTDate(f.dueAt))} ${toISTTime(f.dueAt)}`;
    await tx.insert(s.leadActivity).values({ leadId: lead.id, actorUserId, kind: 'follow_up', summary: `Follow-up scheduled · ${channelLabel(f.channel)} · ${when}${f.note ? ` · ${f.note}` : ''}` });
    await this.audit.log(tx, {
      action: 'Follow-up scheduled',
      kind: 'create',
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: lead.name,
      summary: `${channelLabel(f.channel)} · ${when}`,
      branchId: lead.branchId,
    });
    this.notify.invalidate(tx, lead.branchId, [['sales']]);
  }

  /* ───────────── read models ───────────── */

  async cards(db: DbOrTx, rows: LeadRow[]): Promise<LeadCard[]> {
    const courseIds = [...new Set(rows.map((r) => r.courseId).filter((x): x is string => !!x))];
    const courses = courseIds.length ? await db.select({ id: s.course.id, name: s.course.name }).from(s.course).where(inArray(s.course.id, courseIds)) : [];
    const cmap = new Map(courses.map((c) => [c.id, c.name]));
    const names = await userNames(db, rows.map((r) => r.ownerUserId));
    const now = new Date();
    return rows.map((r) => {
      const n = nextLine(r, now);
      return {
        id: r.id,
        name: r.name,
        score: r.score,
        stage: r.stage,
        stageLabel: stageLabel(r.stage),
        courseId: r.courseId,
        courseName: r.courseId ? (cmap.get(r.courseId) ?? null) : null,
        source: r.source,
        ownerId: r.ownerUserId,
        ownerName: r.ownerUserId ? firstName(names.get(r.ownerUserId)) : 'Unassigned',
        nextLine: n.line,
        nextOverdue: n.overdue,
        nextStage: nextStage(r.stage as LeadStage),
      };
    });
  }

  async detail(db: DbOrTx, lead: LeadRow): Promise<z.input<typeof zLeadDetail>> {
    const [card] = await this.cards(db, [lead]);
    const acts = await db
      .select({ id: s.leadActivity.id, kind: s.leadActivity.kind, summary: s.leadActivity.summary, actorName: s.user.name, at: s.leadActivity.createdAt })
      .from(s.leadActivity)
      .leftJoin(s.user, eq(s.user.id, s.leadActivity.actorUserId))
      .where(eq(s.leadActivity.leadId, lead.id))
      .orderBy(desc(s.leadActivity.createdAt))
      .limit(50);
    let preferredBranchName: string | null = null;
    if (lead.preferredBranchId) {
      const [b] = await db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, lead.preferredBranchId));
      preferredBranchName = b?.name ?? null;
    }
    let admissionStatus: string | null = null;
    if (lead.admissionId) {
      const [a] = await db.select({ status: s.admission.status }).from(s.admission).where(eq(s.admission.id, lead.admissionId));
      admissionStatus = a?.status ?? null;
    }
    const activeApp = admissionStatus != null && !['cancelled'].includes(admissionStatus);
    return {
      ...card!,
      phone: lead.phone,
      phoneDisplay: formatPhone(lead.phone),
      email: lead.email,
      campaign: lead.campaign,
      createdAt: lead.createdAt,
      branchId: lead.branchId,
      preferredBranchId: lead.preferredBranchId,
      preferredBranchName,
      lostReason: lead.lostReason,
      consentWhatsapp: lead.consentWhatsapp,
      consentEmail: lead.consentEmail,
      responded: lead.responded,
      firstResponseAt: lead.firstResponseAt,
      nextFollowUpAt: lead.nextFollowUpAt,
      nextFollowUpNote: lead.nextFollowUpNote,
      admissionId: lead.admissionId,
      admissionStatus,
      studentId: lead.studentId,
      canConvert: !['won', 'lost'].includes(lead.stage) && (!activeApp || admissionStatus === 'draft' || admissionStatus === 'returned'),
      activities: acts.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, actorName: a.actorName, at: a.at.toISOString() })),
    };
  }

  /** Ensure the caller may act on behalf of (or as) sales — used for owner fallback. */
  actorIsSales(): boolean {
    const c = maybeCtx();
    return !!c && (c.roleKey === 'sales' || c.roleKey === 'salesmanager');
  }
}

export function channelLabel(c: string): string {
  return ({ call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Visit' } as Record<string, string>)[c] ?? c;
}
