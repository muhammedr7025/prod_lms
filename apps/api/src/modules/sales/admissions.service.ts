import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { DomainEvents, zAdmissionDetail, zAdmissionInput, zAdmissionRow } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, ne, or, sql, type DbOrTx, type SQL, type Tx } from '@exatech/db';
import {
  buildSchedule,
  DEFAULT_DISCOUNT_THRESHOLDS,
  DEFAULT_PATTERNS,
  discountApprovalLevel,
  formatDate,
  formatINR,
  formatNumber,
  normalizeEmail,
  normalizePhone,
  quoteFee,
  todayIST,
  type DiscountThresholds,
  type FeeQuote,
} from '@exatech/domain';
import crypto from 'node:crypto';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService } from '../../core/auth/access.service';
import { assertBranchAccess, can, ctx, maybeCtx } from '../../core/context';
import { afterCommit, Db, inBranchScope } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { MessagingService } from '../../core/messaging/messaging.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { NumberingService } from '../../core/numbering.service';
import { LeadsService } from './leads.service';
import { assertLeadAccess, superAdminIds, usersWithRoleInBranch } from './sales.shared';

type AdmissionRowIn = z.input<typeof zAdmissionRow>;
type AdmissionDetailIn = z.input<typeof zAdmissionDetail>;
type AdmissionInput = z.output<typeof zAdmissionInput> & { draft: boolean };
type Admission = typeof s.admission.$inferSelect;
type ListStatus = 'queue' | 'awaiting_finance' | 'awaiting_approval' | 'returned' | 'approved' | 'waitlist' | 'mine';

const REQUIRED_DOCS = [
  { kind: 'id_proof', label: 'ID proof' },
  { kind: 'photo', label: 'Photo' },
  { kind: 'certificate', label: 'Qualification certificate' },
] as const;

function ageOn(dob: string, today: string): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * Admissions (PRD §6, §7, §12 rules 1–2): Sales submits → Finance verifies
 * fee terms → Super Admin approves discounts above the threshold → Branch
 * Admin approves (one transaction: admission number, student + parent
 * accounts, enrollment, memberships, lead Won, AdmissionApproved).
 */
@Injectable()
export class AdmissionsService implements OnModuleInit {
  private readonly log = new Logger('Admissions');

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly numbering: NumberingService,
    private readonly access: AccessService,
    private readonly messaging: MessagingService,
    private readonly leads: LeadsService,
  ) {}

  onModuleInit() {
    this.events.onTx('ApprovalDecided', (tx, p) => this.onApprovalDecided(tx, p), 'admissions:discount-decided');
    this.events.onAsync('AdmissionApproved', 'send-invites', (p) => this.sendInvites(p));
    this.events.onAsync('BatchTransferred', 'waitlist-seat-offer', (p) => this.offerFreedSeat(p.fromEnrollmentId));
  }

  async thresholds(): Promise<DiscountThresholds> {
    const inst = await this.access.institution();
    return inst.settings.discountThresholds ?? DEFAULT_DISCOUNT_THRESHOLDS;
  }

  /* ───────────────────────── read models ───────────────────────── */

  async rows(db: DbOrTx, where: SQL | undefined, order: SQL[] = [desc(s.admission.submittedAt), desc(s.admission.createdAt)], limit = 200): Promise<AdmissionRowIn[]> {
    const rows = await db
      .select({
        a: s.admission,
        batchCode: s.batch.code,
        capacity: s.batch.capacity,
        courseName: s.course.name,
        salesName: s.user.name,
        planName: s.feePlan.name,
        planComponents: s.feePlan.components,
        planGst: s.feePlan.gstRate,
      })
      .from(s.admission)
      .innerJoin(s.batch, eq(s.batch.id, s.admission.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .innerJoin(s.user, eq(s.user.id, s.admission.salesUserId))
      .leftJoin(s.feePlan, eq(s.feePlan.id, s.admission.feePlanId))
      .where(where)
      .orderBy(...order)
      .limit(limit);
    if (rows.length === 0) return [];
    const batchIds = [...new Set(rows.map((r) => r.a.batchId))];
    const ids = rows.map((r) => r.a.id);
    const [enrolled, docs] = await Promise.all([
      db
        .select({ batchId: s.enrollment.batchId, n: sql<number>`count(*)::int` })
        .from(s.enrollment)
        .where(and(inArray(s.enrollment.batchId, batchIds), eq(s.enrollment.status, 'active')))
        .groupBy(s.enrollment.batchId),
      db
        .select({ ownerId: s.document.ownerId, kind: s.document.kind, label: s.document.label, status: s.document.status })
        .from(s.document)
        .where(and(eq(s.document.ownerType, 'admission'), inArray(s.document.ownerId, ids))),
    ]);
    const t = await this.thresholds();
    return rows.map(({ a, batchCode, capacity, courseName, salesName, planName, planComponents, planGst }) => {
      const seatsLeft = capacity - Number(enrolled.find((e) => e.batchId === a.batchId)?.n ?? 0);
      const mine = docs.filter((d) => d.ownerId === a.id);
      const uploaded = mine.filter((d) => d.status === 'uploaded' || d.status === 'verified');
      const missing = REQUIRED_DOCS.filter((r) => !uploaded.some((d) => d.kind === r.kind)).map((r) => r.label);
      const quote = a.quote;
      const total = quote?.total ?? 0;
      const needsSuperAdmin = a.needsSuperAdmin || discountApprovalLevel(a.discountPct, t) === 'super_admin';
      const financeVerified = !!a.financeVerifiedAt;
      const superAdminApproved = !!a.superAdminApprovedAt;
      let stepLabel: string;
      let blocked: string | null = null;
      switch (a.status) {
        case 'draft':
          stepLabel = 'Draft';
          blocked = 'Not submitted yet';
          break;
        case 'submitted':
          stepLabel = 'Awaiting Finance';
          blocked = 'Finance has not verified the fee terms yet';
          break;
        case 'fee_verified':
          if (needsSuperAdmin && !superAdminApproved) {
            stepLabel = 'Awaiting Super Admin';
            blocked = `Discount above ${t.superAdminPct}% needs Super Admin approval`;
          } else {
            stepLabel = 'Ready for approval';
            if (seatsLeft <= 0) blocked = `No seats left in ${batchCode} — move to waitlist`;
          }
          break;
        case 'returned':
          stepLabel = a.returnedTo === 'finance' ? 'Returned to Finance' : 'Returned to Sales';
          blocked = a.returnedTo === 'finance' ? 'Returned to Finance — waiting for re-verification' : 'Returned to Sales — waiting for resubmission';
          break;
        case 'approved':
          stepLabel = 'Approved';
          blocked = 'Already approved';
          break;
        case 'waitlisted':
          if (needsSuperAdmin && !superAdminApproved) {
            stepLabel = 'Waitlisted · awaiting Super Admin';
            blocked = `Discount above ${t.superAdminPct}% needs Super Admin approval`;
          } else if (seatsLeft > 0) {
            stepLabel = 'Seat available · ready for approval';
            blocked = null;
          } else {
            stepLabel = 'Waitlisted';
            blocked = `Waitlisted for ${batchCode} — approve when a seat frees up`;
          }
          break;
        default:
          stepLabel = 'Cancelled';
          blocked = 'Cancelled';
      }
      const rel = a.guardianRelationship?.toLowerCase();
      return {
        id: a.id,
        status: a.status,
        studentName: a.studentName,
        guardianLine: a.guardianName ? `${a.guardianName}${rel ? ` · ${rel}` : ''}` : 'No guardian added',
        branchId: a.branchId,
        batchId: a.batchId,
        batchCode,
        courseName,
        seatsLine: seatsLeft <= 0 ? '0 seats left · waitlist' : `${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`,
        seatsLeft,
        waitlist: a.waitlist,
        salesName,
        // List price incl. GST before discount (the discount has its own column).
        planLine: `${planName ?? 'Fee plan'} · ${formatINR(planComponents ? quoteFee(planComponents, 0, planGst ?? 18).total : total)}`,
        total,
        discountPct: a.discountPct,
        discountAmount: quote?.discount ?? 0,
        needsSuperAdmin,
        financeVerified,
        superAdminApproved,
        approveBlockedReason: blocked,
        stepLabel,
        docs: { uploaded: uploaded.length, required: Math.max(REQUIRED_DOCS.length, mine.length), missing },
        returnNote: a.status === 'returned' ? a.returnNote : null,
        returnedTo: a.status === 'returned' ? a.returnedTo : null,
        admissionNo: a.admissionNo,
        submittedAt: a.submittedAt,
        leadId: a.leadId,
      };
    });
  }

  /** Scope: branch scope; own-scope roles (Salesperson) see only their applications. */
  private scope(): SQL | undefined {
    const c = ctx();
    const parts = [inBranchScope(s.admission.branchId), c.scopeKind === 'own' ? eq(s.admission.salesUserId, c.userId) : undefined].filter(Boolean) as SQL[];
    return parts.length ? and(...parts) : undefined;
  }

  private statusWhere(status: ListStatus): SQL | undefined {
    const c = ctx();
    switch (status) {
      case 'queue':
        return inArray(s.admission.status, ['submitted', 'fee_verified']);
      case 'awaiting_finance':
        return or(eq(s.admission.status, 'submitted'), and(eq(s.admission.status, 'returned'), eq(s.admission.returnedTo, 'finance')));
      case 'awaiting_approval':
        return eq(s.admission.status, 'fee_verified');
      case 'returned':
        return eq(s.admission.status, 'returned');
      case 'approved':
        return eq(s.admission.status, 'approved');
      case 'waitlist':
        return eq(s.admission.status, 'waitlisted');
      case 'mine':
        return and(eq(s.admission.salesUserId, c.userId), ne(s.admission.status, 'cancelled'));
    }
  }

  async list(status: ListStatus) {
    const scope = this.scope();
    const order = status === 'approved' ? [desc(s.admission.approvedAt)] : status === 'mine' ? [desc(s.admission.updatedAt)] : undefined;
    const items = await this.rows(this.db.db, and(scope, this.statusWhere(status)), order, status === 'approved' || status === 'mine' ? 60 : 200);
    const counts: Record<string, number> = {};
    const keys: ListStatus[] = ['queue', 'awaiting_finance', 'awaiting_approval', 'returned', 'approved', 'waitlist', 'mine'];
    const res = await Promise.all(keys.map((k) => this.db.db.select({ n: sql<number>`count(*)::int` }).from(s.admission).where(and(scope, this.statusWhere(k)))));
    keys.forEach((k, i) => (counts[k] = Number(res[i]![0]?.n ?? 0)));
    return { items, counts };
  }

  async detail(db: DbOrTx, id: string, scoped = true): Promise<AdmissionDetailIn> {
    const [row] = await this.rows(db, and(eq(s.admission.id, id), scoped ? this.scope() : undefined));
    if (!row) throw notFound('Admission');
    const [a] = await db.select().from(s.admission).where(eq(s.admission.id, id));
    const [docs, history] = await Promise.all([
      db
        .select({ id: s.document.id, kind: s.document.kind, label: s.document.label, status: s.document.status, fileId: s.document.fileId })
        .from(s.document)
        .where(and(eq(s.document.ownerType, 'admission'), eq(s.document.ownerId, id)))
        .orderBy(asc(s.document.createdAt)),
      db
        .select({ at: s.admissionEvent.createdAt, step: s.admissionEvent.step, action: s.admissionEvent.action, actor: s.user.name, note: s.admissionEvent.note })
        .from(s.admissionEvent)
        .leftJoin(s.user, eq(s.user.id, s.admissionEvent.actorUserId))
        .where(eq(s.admissionEvent.admissionId, id))
        .orderBy(asc(s.admissionEvent.createdAt)),
    ]);
    const q = a!.quote;
    return {
      ...row,
      studentPhone: a!.studentPhone,
      studentEmail: a!.studentEmail,
      studentDob: a!.studentDob,
      studentAddress: a!.studentAddress,
      guardianName: a!.guardianName,
      guardianRelationship: a!.guardianRelationship,
      guardianPhone: a!.guardianPhone,
      guardianEmail: a!.guardianEmail,
      feePlanId: a!.feePlanId,
      discountReason: a!.discountReason,
      quote: q ? { subtotal: q.subtotal, discount: q.discount, taxable: q.taxable, gst: q.gst, total: q.total, gstRate: q.gstRate } : null,
      consent: a!.consent ? { dpdp: a!.consent.dpdp, purposes: a!.consent.purposes, parental: a!.consent.parental } : null,
      referralCode: a!.referralCode,
      documents: docs.map((d) => ({ id: d.id, kind: d.kind, label: d.label, status: d.status, fileId: d.fileId })),
      history: history.map((h) => ({ at: h.at, step: h.step, action: h.action, actor: h.actor ?? 'System', note: h.note })),
    };
  }

  /* ───────────────────────── submit / update ───────────────────────── */

  private async lock(tx: Tx, id: string): Promise<Admission> {
    const [a] = await tx.select().from(s.admission).where(eq(s.admission.id, id)).for('update');
    if (!a) throw notFound('Admission');
    assertBranchAccess(a.branchId);
    return a;
  }

  async save(input: AdmissionInput, existingId: string | null): Promise<string> {
    const c = ctx();
    const t = await this.thresholds();
    const id = await this.db.tx(async (tx) => {
      let existing: Admission | null = null;
      if (existingId) {
        existing = await this.lock(tx, existingId);
        if (c.scopeKind === 'own' && existing.salesUserId !== c.userId) throw forbidden('This application belongs to another salesperson');
        if (!['draft', 'returned'].includes(existing.status) || (existing.status === 'returned' && existing.returnedTo === 'finance')) {
          throw invalid(existing.status === 'returned' ? 'This application is with Finance — it can be edited once returned to Sales' : `Only drafts and returned applications can be edited (this one is ${existing.status.replace('_', ' ')})`);
        }
      }
      const [batch] = await tx.select().from(s.batch).where(eq(s.batch.id, input.batchId));
      if (!batch || ['completed', 'cancelled'].includes(batch.status)) throw invalid('Pick an open batch', { batchId: 'Batch is not open' });
      assertBranchAccess(batch.branchId);
      const [plan] = await tx.select().from(s.feePlan).where(eq(s.feePlan.id, input.feePlanId));
      if (!plan || !plan.active || plan.courseId !== batch.courseId || (plan.branchId && plan.branchId !== batch.branchId)) throw invalid(`Pick a fee plan for ${batch.code}`, { feePlanId: 'Plan does not belong to this course' });

      const studentPhone = normalizePhone(input.studentPhone);
      if (!studentPhone) throw invalid('Enter a valid 10-digit mobile', { studentPhone: 'Enter a valid 10-digit mobile' });
      const guardianPhone = input.guardianPhone ? normalizePhone(input.guardianPhone) : null;
      if (input.guardianPhone && !guardianPhone) throw invalid('Enter the guardian’s 10-digit mobile', { guardianPhone: 'Enter a valid 10-digit mobile' });

      // Lead link: one active application per lead.
      let lead: typeof s.lead.$inferSelect | null = null;
      if (input.leadId) {
        lead = await this.leads.lockLead(tx, input.leadId);
        assertLeadAccess(lead);
        if (lead.stage === 'won' || lead.stage === 'lost') throw invalid(`${lead.name} is ${lead.stage === 'won' ? 'already Won' : 'Lost'} — reopen the lead first`);
        if (lead.admissionId && lead.admissionId !== existing?.id) {
          const [other] = await tx.select({ status: s.admission.status }).from(s.admission).where(eq(s.admission.id, lead.admissionId));
          if (other && other.status !== 'cancelled') throw conflict(`${lead.name} already has an application (${other.status.replace('_', ' ')})`);
        }
      }

      const quote: FeeQuote = quoteFee(plan.components, input.discountPct, plan.gstRate, plan.earlyPayDiscountPct);
      const level = discountApprovalLevel(input.discountPct, t);
      const today = todayIST();
      const [{ n: enrolled } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.enrollment)
        .where(and(eq(s.enrollment.batchId, batch.id), eq(s.enrollment.status, 'active')));
      const seatsLeft = batch.capacity - Number(enrolled);
      if (!input.draft) {
        if (!input.consent.dpdp) throw invalid('Capture DPDP consent before submitting', { consent: 'DPDP consent is required' });
        const minor = input.studentDob ? ageOn(input.studentDob, today) < 18 : false;
        if (minor && !input.consent.parental) throw invalid('The student is under 18 — capture parental consent', { parental: 'Parental consent is required for under-18 learners' });
        if (minor && (!input.guardianName || !guardianPhone)) throw invalid('The student is under 18 — add a guardian with a mobile number', { guardianPhone: 'Required for under-18 learners' });
        if (level !== 'none' && !input.discountReason) throw invalid('Add a reason for the discount request', { discountReason: 'Required above the Finance threshold' });
        if (seatsLeft <= 0 && !input.waitlist) throw invalid(`${batch.code} is full — choose another batch or join the waitlist`, { batchId: 'No seats left' });
      }
      const now = new Date();
      const values = {
        institutionId: c.institutionId,
        branchId: batch.branchId,
        leadId: lead?.id ?? null,
        studentName: input.studentName,
        studentPhone,
        studentEmail: normalizeEmail(input.studentEmail ?? null),
        studentDob: input.studentDob ?? null,
        studentAddress: input.studentAddress ?? null,
        guardianName: input.guardianName ?? null,
        guardianRelationship: input.guardianRelationship ?? null,
        guardianPhone,
        guardianEmail: normalizeEmail(input.guardianEmail ?? null),
        batchId: batch.id,
        feePlanId: plan.id,
        discountPct: input.discountPct,
        discountReason: input.discountReason ?? null,
        quote,
        consent: { ...input.consent, capturedAt: now.toISOString() },
        referralCode: input.referralCode ?? null,
        waitlist: input.waitlist || seatsLeft <= 0,
      };
      const resubmit = existing?.status === 'returned' || (!!existing?.submittedAt && existing.status === 'draft');
      let admissionId: string;
      if (existing) {
        await tx
          .update(s.admission)
          .set({
            ...values,
            status: input.draft ? existing.status : 'submitted',
            ...(input.draft
              ? {}
              : {
                  submittedAt: now,
                  needsSuperAdmin: false,
                  financeVerifiedBy: null,
                  financeVerifiedAt: null,
                  superAdminApprovedBy: null,
                  superAdminApprovedAt: null,
                  returnedTo: null,
                  returnNote: null,
                }),
          })
          .where(eq(s.admission.id, existing.id));
        admissionId = existing.id;
      } else {
        const [row] = await tx
          .insert(s.admission)
          .values({ ...values, salesUserId: c.userId, status: input.draft ? 'draft' : 'submitted', submittedAt: input.draft ? null : now })
          .returning({ id: s.admission.id });
        admissionId = row!.id;
      }

      // Documents: update by kind, keep what is already there.
      if (input.documents.length) {
        const fileIds = input.documents.map((d) => d.fileId).filter((x): x is string => !!x);
        if (fileIds.length) {
          const files = await tx.select({ id: s.fileObject.id, purpose: s.fileObject.purpose, owner: s.fileObject.ownerUserId }).from(s.fileObject).where(inArray(s.fileObject.id, fileIds));
          for (const fid of fileIds) {
            const f = files.find((x) => x.id === fid);
            if (!f || f.purpose !== 'admission_doc') throw invalid('One of the documents is not an admission upload');
          }
        }
        const current = await tx.select().from(s.document).where(and(eq(s.document.ownerType, 'admission'), eq(s.document.ownerId, admissionId)));
        for (const d of input.documents) {
          const ex = current.find((x) => x.kind === d.kind && (d.kind !== 'other' || x.label === d.label));
          if (ex) {
            if (d.fileId && d.fileId !== ex.fileId) await tx.update(s.document).set({ fileId: d.fileId, label: d.label, status: 'uploaded', uploadedBy: c.userId }).where(eq(s.document.id, ex.id));
          } else {
            await tx.insert(s.document).values({ ownerType: 'admission', ownerId: admissionId, kind: d.kind, label: d.label, fileId: d.fileId, status: d.fileId ? 'uploaded' : 'missing', uploadedBy: c.userId });
          }
        }
      }

      const batchLabel = batch.code;
      if (lead && lead.admissionId !== admissionId) await tx.update(s.lead).set({ admissionId }).where(eq(s.lead.id, lead.id));
      if (input.draft) {
        await this.audit.log(tx, { action: existing ? 'Admission draft saved' : 'Admission draft created', kind: existing ? 'update' : 'create', entityType: 'admission', entityId: admissionId, entityLabel: input.studentName, summary: `${batchLabel} · ${plan.name} · draft`, branchId: batch.branchId });
        this.notify.invalidateUsers(tx, [c.userId], [['admissions']]);
        return admissionId;
      }

      await tx.insert(s.admissionEvent).values({ admissionId, step: 'sales', action: resubmit ? 'resubmitted' : 'submitted', actorUserId: c.userId, note: existing?.status === 'returned' ? `Fixed: ${existing.returnNote ?? ''}`.slice(0, 300) : null });
      if (lead) {
        const fresh = await this.leads.lockLead(tx, lead.id);
        if (fresh.stage !== 'admission_in_progress') await this.leads.moveStage(tx, fresh, 'admission_in_progress', { actorUserId: c.userId, extra: { admissionId } });
        await tx.insert(s.leadActivity).values({
          leadId: lead.id,
          actorUserId: c.userId,
          kind: 'admission',
          summary: `Application ${resubmit ? 'resubmitted' : 'submitted'} · ${batch.code} · ${plan.name}${input.discountPct ? ` · ${input.discountPct}% discount` : ''}`,
          meta: { admissionId },
        });
      }
      await this.events.emit(tx, 'ApplicationSubmitted', { admissionId, branchId: batch.branchId, salesUserId: existing?.salesUserId ?? c.userId, leadId: lead?.id ?? null });
      const finance = await usersWithRoleInBranch(tx, ['finance'], batch.branchId);
      await this.notify.notify(tx, {
        userIds: finance.map((f) => f.id),
        category: 'admission',
        title: 'Fee verification waiting',
        body: `${input.studentName} · ${batch.code} · ${input.discountPct ? `${input.discountPct}% discount requested` : 'no discount'}`,
        link: '/finance',
        entityType: 'admission',
        entityId: admissionId,
      });
      await this.audit.log(tx, {
        action: resubmit ? 'Admission resubmitted' : 'Admission submitted',
        kind: existing ? 'update' : 'create',
        entityType: 'admission',
        entityId: admissionId,
        entityLabel: input.studentName,
        after: { batch: batch.code, plan: plan.name, discountPct: input.discountPct, total: quote.total },
        summary: `${existing?.status ?? 'new'} → submitted · ${batch.code} · ${plan.name} · ${formatINR(quote.total)}${input.discountPct ? ` · ${input.discountPct}%` : ''}`,
        branchId: batch.branchId,
      });
      this.notify.invalidate(tx, batch.branchId, [['admissions'], ['sales'], ['finance']]);
      return admissionId;
    });
    return id;
  }

  /* ───────────────────────── Finance: verify fee terms ───────────────────────── */

  async verifyFee(id: string, note: string | undefined): Promise<void> {
    const c = ctx();
    const t = await this.thresholds();
    await this.db.tx(async (tx) => {
      const a = await this.lock(tx, id);
      const fromFinanceReturn = a.status === 'returned' && a.returnedTo === 'finance';
      if (a.status !== 'submitted' && !fromFinanceReturn) throw invalid(`Only submitted applications can be verified (this one is ${a.status.replace('_', ' ')})`);
      const needsSA = discountApprovalLevel(a.discountPct, t) === 'super_admin';
      const saDone = needsSA && !!a.superAdminApprovedAt;
      await tx
        .update(s.admission)
        .set({ status: 'fee_verified', financeVerifiedBy: c.userId, financeVerifiedAt: new Date(), needsSuperAdmin: needsSA, returnedTo: null, returnNote: null })
        .where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: 'finance', action: 'verified', actorUserId: c.userId, note: note ?? (a.discountPct > t.financePct ? `Discount ${a.discountPct}% verified` : null) });
      const [info] = await tx
        .select({ batchCode: s.batch.code, planName: s.feePlan.name, salesName: s.user.name })
        .from(s.batch)
        .innerJoin(s.feePlan, eq(s.feePlan.id, a.feePlanId))
        .innerJoin(s.user, eq(s.user.id, a.salesUserId))
        .where(eq(s.batch.id, a.batchId));
      if (needsSA && !saDone) {
        const [req] = await tx
          .insert(s.approvalRequest)
          .values({
            institutionId: a.institutionId,
            branchId: a.branchId,
            kind: 'discount',
            level: 'super_admin',
            title: `Discount ${a.discountPct}% · ${a.studentName}`,
            summary: `${info?.batchCode ?? ''} · ${info?.planName ?? ''} · requested by ${info?.salesName ?? 'Sales'} · verified by ${c.userName}${a.discountReason ? ` · ${a.discountReason}` : ''}`,
            entityType: 'admission',
            entityId: a.id,
            amount: a.quote?.discount ?? 0,
            pct: a.discountPct,
            payload: { admissionId: a.id, reason: a.discountReason },
            requestedBy: c.userId,
          })
          .returning({ id: s.approvalRequest.id });
        await this.events.emit(tx, 'ApprovalRequested', { approvalId: req!.id, kind: 'discount', level: 'super_admin', branchId: a.branchId });
        await this.notify.notify(tx, {
          userIds: await superAdminIds(tx),
          category: 'approval',
          title: 'Discount approval needed',
          body: `${a.studentName} · ${a.discountPct}% · ${info?.batchCode ?? ''} · verified by ${c.userName}`,
          link: '/overview',
          entityType: 'approval',
          entityId: req!.id,
        });
      } else {
        await this.notifyBranchAdmins(tx, a, `${a.studentName} · ${info?.batchCode ?? ''} · fee terms verified`);
      }
      await this.events.emit(tx, 'FeeTermsVerified', { admissionId: a.id, branchId: a.branchId, actorUserId: c.userId });
      await this.audit.log(tx, {
        action: 'Fee terms verified',
        kind: 'approve',
        entityType: 'admission',
        entityId: a.id,
        entityLabel: a.studentName,
        before: { status: a.status },
        after: { status: 'fee_verified', needsSuperAdmin: needsSA },
        summary: `${a.studentName} · discount ${a.discountPct}%${needsSA && !saDone ? ' → Super Admin' : ''}`,
        branchId: a.branchId,
      });
      this.notify.invalidate(tx, a.branchId, [['admissions'], ['finance'], ['approvals'], ['sales']]);
    });
  }

  private async notifyBranchAdmins(tx: Tx, a: Admission, body: string) {
    const admins = await usersWithRoleInBranch(tx, ['branchadmin'], a.branchId);
    await this.notify.notify(tx, { userIds: admins.map((u) => u.id), category: 'admission', title: 'Admission ready for approval', body, link: '/admissions', entityType: 'admission', entityId: a.id });
  }

  /* ───────────────────────── Return ───────────────────────── */

  async returnApp(id: string, to: 'sales' | 'finance', note: string): Promise<void> {
    const c = ctx();
    const isApprover = can('admissions:approve');
    if (to === 'finance' && !isApprover) throw forbidden('Finance can return applications to Sales only');
    await this.db.tx(async (tx) => {
      const a = await this.lock(tx, id);
      const withFinance = a.status === 'returned' && a.returnedTo === 'finance';
      if (!['submitted', 'fee_verified', 'waitlisted'].includes(a.status) && !withFinance) throw invalid(`This application is ${a.status.replace('_', ' ')} — nothing to return`);
      if (to === 'finance' && a.status === 'submitted') throw invalid('Finance has not verified this application yet — return it to Sales instead');
      if (to === 'finance' && withFinance) throw invalid('Already with Finance');
      const step = c.roleKey === 'finance' ? 'finance' : c.roleKey === 'superadmin' ? 'super_admin' : 'branch_admin';
      await tx
        .update(s.admission)
        .set({
          status: 'returned',
          returnedTo: to,
          returnedBy: c.userId,
          returnedAt: new Date(),
          returnNote: note,
          financeVerifiedBy: null,
          financeVerifiedAt: null,
          ...(to === 'sales' ? { superAdminApprovedBy: null, superAdminApprovedAt: null } : {}),
        })
        .where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step, action: 'returned', actorUserId: c.userId, note: `→ ${to === 'sales' ? 'Sales' : 'Finance'} · ${note}` });
      await this.events.emit(tx, 'AdmissionReturned', { admissionId: a.id, branchId: a.branchId, actorUserId: c.userId, to, note });
      if (to === 'sales') {
        await this.notify.notify(tx, { userIds: [a.salesUserId], category: 'admission', title: `Application returned · ${a.studentName}`, body: `${c.userName}: ${note}`, link: `/sales/admission?id=${a.id}`, entityType: 'admission', entityId: a.id });
      } else {
        const finance = await usersWithRoleInBranch(tx, ['finance'], a.branchId);
        await this.notify.notify(tx, { userIds: finance.map((f) => f.id), category: 'admission', title: `Application returned to Finance · ${a.studentName}`, body: `${c.userName}: ${note}`, link: '/finance', entityType: 'admission', entityId: a.id });
      }
      await this.audit.log(tx, {
        action: 'Admission returned',
        kind: 'update',
        entityType: 'admission',
        entityId: a.id,
        entityLabel: a.studentName,
        before: { status: a.status },
        after: { status: 'returned', to, note },
        summary: `${a.status.replace('_', ' ')} → returned to ${to === 'sales' ? 'Sales' : 'Finance'} · ${note}`,
        branchId: a.branchId,
      });
      this.notify.invalidate(tx, a.branchId, [['admissions'], ['finance'], ['sales']]);
    });
  }

  /* ───────────────────────── Super Admin decision (in-transaction subscriber) ───────────────────────── */

  private async onApprovalDecided(tx: Tx, p: DomainEvents['ApprovalDecided']): Promise<void> {
    if (p.kind !== 'discount') return;
    const [req] = await tx.select().from(s.approvalRequest).where(eq(s.approvalRequest.id, p.approvalId));
    if (!req || req.entityType !== 'admission') return;
    const [a] = await tx.select().from(s.admission).where(eq(s.admission.id, p.entityId)).for('update');
    if (!a || a.status !== 'fee_verified') return;
    const actor = req.decidedBy ?? maybeCtx()?.userId ?? null;
    if (p.status === 'approved') {
      await tx.update(s.admission).set({ superAdminApprovedBy: actor, superAdminApprovedAt: new Date() }).where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: 'super_admin', action: 'approved', actorUserId: actor, note: req.decisionNote ?? `Discount ${a.discountPct}% approved` });
      await this.events.emit(tx, 'DiscountApproved', { admissionId: a.id, branchId: a.branchId, actorUserId: actor ?? '', pct: a.discountPct });
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, a.batchId));
      await this.notifyBranchAdmins(tx, a, `${a.studentName} · ${b?.code ?? ''} · discount ${a.discountPct}% approved by Super Admin`);
      await this.audit.log(tx, { action: 'Discount approved', kind: 'approve', entityType: 'admission', entityId: a.id, entityLabel: a.studentName, summary: `Discount ${a.discountPct}% · Super Admin approved`, branchId: a.branchId });
    } else {
      const note = req.decisionNote ?? (p.status === 'denied' ? 'Discount denied' : 'Discount returned');
      await tx
        .update(s.admission)
        .set({ status: 'returned', returnedTo: 'finance', returnedBy: actor, returnedAt: new Date(), returnNote: note, financeVerifiedBy: null, financeVerifiedAt: null })
        .where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: 'super_admin', action: 'returned', actorUserId: actor, note: `→ Finance · ${note}` });
      await this.events.emit(tx, 'AdmissionReturned', { admissionId: a.id, branchId: a.branchId, actorUserId: actor ?? '', to: 'finance', note });
      await this.audit.log(tx, { action: p.status === 'denied' ? 'Discount denied' : 'Discount returned', kind: 'update', entityType: 'admission', entityId: a.id, entityLabel: a.studentName, summary: `Discount ${a.discountPct}% · ${p.status} · ${note}`, branchId: a.branchId });
    }
    this.notify.invalidate(tx, a.branchId, [['admissions'], ['finance']]);
  }

  /* ───────────────────────── Branch Admin: approve ───────────────────────── */

  private async uniqueEmail(tx: Tx, preferred: (string | null | undefined)[]): Promise<string> {
    for (const e of preferred) {
      if (!e) continue;
      const [taken] = await tx.select({ id: s.user.id }).from(s.user).where(sql`lower(${s.user.email}) = ${e.toLowerCase()}`);
      if (!taken) return e.toLowerCase();
    }
    const base = preferred.filter(Boolean).at(-1) ?? `p${crypto.randomBytes(4).toString('hex')}@phone.invalid`;
    const [local, domain] = base.split('@') as [string, string];
    for (let i = 2; i < 50; i++) {
      const e = `${local}+${i}@${domain}`;
      const [taken] = await tx.select({ id: s.user.id }).from(s.user).where(eq(s.user.email, e));
      if (!taken) return e;
    }
    return `${local}+${crypto.randomBytes(3).toString('hex')}@${domain}`;
  }

  private async upsertMembership(tx: Tx, userId: string, roleKey: 'student' | 'parent', institutionId: string, branchId: string, scopeLabel: string) {
    const [role] = await tx.select({ id: s.role.id }).from(s.role).where(and(eq(s.role.institutionId, institutionId), eq(s.role.key, roleKey)));
    if (!role) throw new Error(`Role ${roleKey} is missing`);
    const [m] = await tx.select().from(s.membership).where(and(eq(s.membership.userId, userId), eq(s.membership.roleId, role.id)));
    if (m) {
      await tx
        .update(s.membership)
        .set({ branchIds: [...new Set([...m.branchIds, branchId])], scopeLabel, status: 'active' })
        .where(eq(s.membership.id, m.id));
    } else {
      await tx.insert(s.membership).values({ userId, roleId: role.id, branchIds: [branchId], scopeLabel, isDefault: true, createdBy: maybeCtx()?.userId ?? null });
    }
  }

  async approve(id: string): Promise<void> {
    const c = ctx();
    const t = await this.thresholds();
    await this.db.tx(async (tx) => {
      const a = await this.lock(tx, id);
      if (a.status === 'approved') throw conflict(`Already approved · ${a.admissionNo ?? ''}`);
      if ((a.status !== 'fee_verified' && a.status !== 'waitlisted') || !a.financeVerifiedAt) throw invalid('Finance has not verified the fee terms yet');
      const needsSA = a.needsSuperAdmin || discountApprovalLevel(a.discountPct, t) === 'super_admin';
      if (needsSA && !a.superAdminApprovedAt) throw invalid(`Discount above ${t.superAdminPct}% needs Super Admin approval`);

      // Capacity is enforced here (PRD §12 rule 2): lock the batch so concurrent approvals queue up.
      const [batch] = await tx.select().from(s.batch).where(eq(s.batch.id, a.batchId)).for('update');
      if (!batch) throw notFound('Batch');
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.enrollment)
        .where(and(eq(s.enrollment.batchId, batch.id), eq(s.enrollment.status, 'active')));
      if (Number(n) >= batch.capacity) throw invalid(`No seats left in ${batch.code} — move to waitlist`);

      const [inst] = await tx.select().from(s.institution).where(eq(s.institution.id, a.institutionId));
      const [branch] = await tx.select({ code: s.branch.code }).from(s.branch).where(eq(s.branch.id, a.branchId));
      const [course] = await tx.select({ code: s.course.code, name: s.course.name }).from(s.course).where(eq(s.course.id, batch.courseId));
      const [plan] = await tx.select().from(s.feePlan).where(eq(s.feePlan.id, a.feePlanId));
      if (!inst || !branch || !course || !plan) throw notFound('Admission references');
      const yearEnd = Number(inst.academicYearStart.slice(0, 4)) + 1;
      const seq = await this.numbering.next(tx, a.branchId, 'admission', String(yearEnd));
      const admissionNo = formatNumber(inst.settings.admissionNumberPattern || DEFAULT_PATTERNS.admission, { BRANCH: branch.code, COURSE: course.code, YEAR: yearEnd, SEQ: seq });
      const quote = a.quote ?? quoteFee(plan.components, a.discountPct, plan.gstRate, plan.earlyPayDiscountPct);
      const now = new Date();
      const today = todayIST();

      // Guardian first: parents sign in with OTP on their phone (one parent → several children).
      const guardianUserIds: string[] = [];
      let guardianId: string | null = null;
      if (a.guardianName || a.guardianPhone) {
        let gUserId: string | null = null;
        if (a.guardianPhone) {
          const [u] = await tx.select().from(s.user).where(eq(s.user.phoneNumber, a.guardianPhone));
          if (u?.kind === 'guardian') gUserId = u.id;
          else {
            const email = await this.uniqueEmail(tx, [a.guardianEmail, `p${a.guardianPhone.replace(/\D/g, '')}@phone.invalid`]);
            const [nu] = await tx
              .insert(s.user)
              .values({ name: a.guardianName ?? 'Guardian', email, phoneNumber: u ? null : a.guardianPhone, kind: 'guardian', status: 'invited', invitedAt: now })
              .returning({ id: s.user.id });
            gUserId = nu!.id;
          }
        }
        if (gUserId) {
          const [g] = await tx.select({ id: s.guardian.id }).from(s.guardian).where(eq(s.guardian.userId, gUserId));
          guardianId = g?.id ?? null;
          guardianUserIds.push(gUserId);
        }
        if (!guardianId) {
          const [g] = await tx
            .insert(s.guardian)
            .values({ userId: gUserId, name: a.guardianName ?? 'Guardian', phone: a.guardianPhone, email: a.guardianEmail })
            .returning({ id: s.guardian.id });
          guardianId = g!.id;
        }
      }

      // Student portal account (reuse a returning student's account by phone).
      let studentUserId: string | null = null;
      if (a.studentPhone) {
        const [u] = await tx.select().from(s.user).where(eq(s.user.phoneNumber, a.studentPhone));
        if (u?.kind === 'student') studentUserId = u.id;
        if (!studentUserId) {
          const email = await this.uniqueEmail(tx, [a.studentEmail, `p${a.studentPhone.replace(/\D/g, '')}@phone.invalid`]);
          const [nu] = await tx
            .insert(s.user)
            .values({ name: a.studentName, email, phoneNumber: u ? null : a.studentPhone, kind: 'student', status: 'invited', invitedAt: now })
            .returning({ id: s.user.id });
          studentUserId = nu!.id;
        }
      }

      const [student] = await tx
        .insert(s.student)
        .values({
          institutionId: a.institutionId,
          branchId: a.branchId,
          userId: studentUserId,
          admissionNo,
          name: a.studentName,
          phone: a.studentPhone,
          email: a.studentEmail,
          dob: a.studentDob,
          address: a.studentAddress,
          cardToken: crypto.randomBytes(18).toString('base64url'),
          cardIssuedAt: now,
          status: 'active',
          leadId: a.leadId,
        })
        .returning({ id: s.student.id });
      const studentId = student!.id;
      if (guardianId) await tx.insert(s.studentGuardian).values({ studentId, guardianId, relationship: a.guardianRelationship ?? 'Guardian', isPrimary: true });

      const joinedOn = batch.startDate > today ? batch.startDate : today;
      const [enr] = await tx
        .insert(s.enrollment)
        .values({
          studentId,
          batchId: batch.id,
          branchId: a.branchId,
          status: 'active',
          joinedOn,
          feePlanId: plan.id,
          feePlanName: plan.name,
          feeTotal: quote.total,
          discountPct: a.discountPct,
          admissionId: a.id,
        })
        .returning({ id: s.enrollment.id });
      const enrollmentId = enr!.id;

      if (studentUserId) await this.upsertMembership(tx, studentUserId, 'student', a.institutionId, a.branchId, batch.code);
      for (const gu of guardianUserIds) {
        const [kids] = await tx
          .select({ n: sql<number>`count(distinct ${s.studentGuardian.studentId})::int` })
          .from(s.studentGuardian)
          .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
          .where(eq(s.guardian.userId, gu));
        const k = Number(kids?.n ?? 1);
        await this.upsertMembership(tx, gu, 'parent', a.institutionId, a.branchId, k === 1 ? '1 child' : `${k} children`);
      }
      // Documents follow the student (the admission copies stay as the application record).
      const docs = await tx.select().from(s.document).where(and(eq(s.document.ownerType, 'admission'), eq(s.document.ownerId, a.id)));
      if (docs.length) await tx.insert(s.document).values(docs.map((d) => ({ ownerType: 'student' as const, ownerId: studentId, kind: d.kind, label: d.label, fileId: d.fileId, status: d.status, uploadedBy: d.uploadedBy })));

      if (a.leadId) {
        const lead = await this.leads.lockLead(tx, a.leadId);
        if (lead.stage !== 'won') await this.leads.moveStage(tx, lead, 'won', { actorUserId: c.userId, extra: { studentId, admissionId: a.id } });
        else await tx.update(s.lead).set({ studentId }).where(eq(s.lead.id, lead.id));
        await tx.insert(s.leadActivity).values({ leadId: a.leadId, actorUserId: c.userId, kind: 'admission', summary: `Admission approved · ${admissionNo} · ${batch.code}`, meta: { admissionId: a.id, studentId } });
      }

      await tx
        .update(s.admission)
        .set({ status: 'approved', approvedBy: c.userId, approvedAt: now, admissionNo, studentId, enrollmentId, waitlist: false, quote })
        .where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: 'branch_admin', action: 'approved', actorUserId: c.userId, note: admissionNo });
      await this.audit.log(tx, {
        action: 'Admission approved',
        kind: 'approve',
        entityType: 'admission',
        entityId: a.id,
        entityLabel: a.studentName,
        before: { status: a.status },
        after: { status: 'approved', admissionNo, studentId, enrollmentId },
        summary: `${a.studentName} · ${admissionNo} · ${batch.code} · ${formatINR(quote.total)}`,
        branchId: a.branchId,
      });
      await this.events.emit(tx, 'AdmissionApproved', {
        admissionId: a.id,
        branchId: a.branchId,
        studentId,
        enrollmentId,
        batchId: batch.id,
        leadId: a.leadId,
        salesUserId: a.salesUserId,
        admissionNo,
        studentUserId,
        guardianUserIds,
        feePlanId: plan.id,
        discountPct: a.discountPct,
        joinedOn,
        actorUserId: c.userId,
      });
      await this.notify.notify(tx, {
        userIds: [a.salesUserId],
        category: 'admission',
        title: `Admission approved · ${admissionNo}`,
        body: `${a.studentName} · ${batch.code} · lead marked Won`,
        link: '/sales/admission',
        entityType: 'admission',
        entityId: a.id,
      });
      this.notify.invalidate(tx, a.branchId, [['admissions'], ['sales'], ['students'], ['batches'], ['finance'], ['reference']]);
      afterCommit(tx, () => this.access.bump());
    });
  }

  /* ───────────────────────── Waitlist ───────────────────────── */

  async waitlist(id: string): Promise<void> {
    const c = ctx();
    await this.db.tx(async (tx) => {
      const a = await this.lock(tx, id);
      if (a.status !== 'fee_verified') throw invalid('Only applications with verified fee terms can join the waitlist');
      const [batch] = await tx.select().from(s.batch).where(eq(s.batch.id, a.batchId)).for('update');
      if (!batch) throw notFound('Batch');
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.enrollment)
        .where(and(eq(s.enrollment.batchId, batch.id), eq(s.enrollment.status, 'active')));
      if (Number(n) < batch.capacity) throw invalid(`${batch.code} still has ${batch.capacity - Number(n)} seat(s) — approve instead`);
      await tx.update(s.admission).set({ status: 'waitlisted', waitlist: true }).where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: 'branch_admin', action: 'waitlisted', actorUserId: c.userId, note: `${batch.code} full` });
      await this.audit.log(tx, { action: 'Admission waitlisted', kind: 'update', entityType: 'admission', entityId: a.id, entityLabel: a.studentName, before: { status: a.status }, after: { status: 'waitlisted' }, summary: `${batch.code} full · waitlisted`, branchId: a.branchId });
      await this.notify.notify(tx, {
        userIds: [a.salesUserId],
        category: 'admission',
        title: `${a.studentName} is on the ${batch.code} waitlist`,
        body: 'The batch is full. You will be told when a seat frees up — or offer another batch.',
        link: '/sales/admission',
        entityType: 'admission',
        entityId: a.id,
      });
      this.notify.invalidate(tx, a.branchId, [['admissions'], ['sales']]);
    });
  }

  /** A seat freed in a batch (transfer out): tell the salesperson and Branch Admins who is next on its waitlist. */
  private async offerFreedSeat(fromEnrollmentId: string): Promise<void> {
    const db = this.db.db;
    const [enr] = await db.select({ batchId: s.enrollment.batchId, branchId: s.enrollment.branchId }).from(s.enrollment).where(eq(s.enrollment.id, fromEnrollmentId));
    if (!enr) return;
    const [next] = await db
      .select()
      .from(s.admission)
      .where(and(eq(s.admission.batchId, enr.batchId), eq(s.admission.status, 'waitlisted')))
      .orderBy(asc(s.admission.submittedAt))
      .limit(1);
    if (!next) return;
    const [batch] = await db.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, enr.batchId));
    const admins = await usersWithRoleInBranch(db, ['branchadmin'], enr.branchId);
    await this.notify.notify(db, {
      userIds: [next.salesUserId, ...admins.map((x) => x.id)],
      category: 'admission',
      title: `Seat free in ${batch?.code ?? 'the batch'}`,
      body: `${next.studentName} is first on the waitlist — approve from Admissions › Waitlist.`,
      link: '/admissions',
      entityType: 'admission',
      entityId: next.id,
    });
  }

  /* ───────────────────────── Cancel ───────────────────────── */

  async cancel(id: string, reason: string): Promise<void> {
    const c = ctx();
    await this.db.tx(async (tx) => {
      const a = await this.lock(tx, id);
      if (c.scopeKind === 'own' && a.salesUserId !== c.userId) throw forbidden('This application belongs to another salesperson');
      if (a.status === 'approved' || a.status === 'cancelled') throw invalid(`This application is ${a.status} — it cannot be cancelled`);
      await tx.update(s.admission).set({ status: 'cancelled' }).where(eq(s.admission.id, a.id));
      await tx.insert(s.admissionEvent).values({ admissionId: a.id, step: c.roleKey === 'finance' ? 'finance' : c.roleKey === 'branchadmin' ? 'branch_admin' : c.roleKey === 'superadmin' ? 'super_admin' : 'sales', action: 'cancelled', actorUserId: c.userId, note: reason });
      if (a.leadId) {
        const lead = await this.leads.lockLead(tx, a.leadId);
        await tx.update(s.lead).set({ admissionId: null }).where(eq(s.lead.id, lead.id));
        if (lead.stage === 'admission_in_progress') await this.leads.moveStage(tx, { ...lead, admissionId: null }, 'negotiation', { actorUserId: c.userId, note: `Application cancelled · ${reason}` });
      }
      await tx.update(s.approvalRequest).set({ status: 'denied', decisionNote: `Application cancelled · ${reason}`, decidedAt: new Date(), decidedBy: c.userId }).where(and(eq(s.approvalRequest.entityId, a.id), eq(s.approvalRequest.status, 'pending')));
      await this.audit.log(tx, { action: 'Admission cancelled', kind: 'delete', entityType: 'admission', entityId: a.id, entityLabel: a.studentName, before: { status: a.status }, after: { status: 'cancelled' }, summary: `${a.status} → cancelled · ${reason}`, branchId: a.branchId });
      this.notify.invalidate(tx, a.branchId, [['admissions'], ['sales'], ['finance'], ['approvals']]);
    });
  }

  /* ───────────────────────── AdmissionApproved → invites (worker, idempotent) ───────────────────────── */

  private async sendInvites(p: DomainEvents['AdmissionApproved']): Promise<void> {
    const db = this.db.db;
    const [a] = await db.select().from(s.admission).where(eq(s.admission.id, p.admissionId));
    if (!a || a.status !== 'approved') return;
    const [batch] = await db.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, p.batchId));
    const [enr] = await db.select().from(s.enrollment).where(eq(s.enrollment.id, p.enrollmentId));
    const [plan] = await db.select().from(s.feePlan).where(eq(s.feePlan.id, p.feePlanId));
    const [tpl] = await db.select().from(s.messageTemplate).where(eq(s.messageTemplate.key, 'welcome_admission'));
    // First invoice: Finance's instalment schedule when it exists, else the plan's schedule.
    const [inst] = await db.select({ amount: s.instalment.amount, dueDate: s.instalment.dueDate }).from(s.instalment).where(eq(s.instalment.enrollmentId, p.enrollmentId)).orderBy(asc(s.instalment.seq)).limit(1);
    const first = inst ?? (enr && plan ? buildSchedule(enr.feeTotal, plan.schedule, enr.joinedOn)[0] : undefined);
    const signIn = `${env().WEB_ORIGIN}/sign-in`;
    const recipients = [p.studentUserId, ...p.guardianUserIds].filter((x): x is string => !!x);
    if (recipients.length === 0) return;
    const users = await db.select({ id: s.user.id, name: s.user.name, email: s.user.email, phone: s.user.phoneNumber, kind: s.user.kind }).from(s.user).where(inArray(s.user.id, recipients));
    const already = await db
      .select({ to: s.outboundMessage.toUserId, channel: s.outboundMessage.channel })
      .from(s.outboundMessage)
      .where(and(inArray(s.outboundMessage.toUserId, recipients), sql`${s.outboundMessage.body} like ${`%${p.admissionNo}%`}`));
    const fill = (body: string, vars: Record<string, string>) => body.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
    await this.db.tx(async (tx) => {
      for (const u of users) {
        const vars = {
          name: a.studentName,
          admission_no: p.admissionNo,
          batch: batch?.code ?? '',
          amount: first ? formatINR(first.amount) : '—',
          due: first ? formatDate(first.dueDate) : '—',
        };
        const welcome = fill(tpl?.body ?? 'Welcome to Exatech, {name}! Admission {admission_no} · {batch}. Your first invoice of {amount} is due {due}.', vars);
        const who = u.kind === 'guardian' ? `${u.name}, ${a.studentName}’s admission is confirmed.` : `Hi ${u.name},`;
        if (u.phone && !already.some((x) => x.to === u.id && x.channel === 'whatsapp')) {
          await this.messaging.queue(tx, { channel: 'whatsapp', to: u.phone, toUserId: u.id, template: 'welcome_admission', body: `${welcome}\nSign in: ${signIn}` });
        }
        if (u.email && !u.email.endsWith('.invalid') && !already.some((x) => x.to === u.id && x.channel === 'email')) {
          await this.messaging.queue(tx, {
            channel: 'email',
            to: u.email,
            toUserId: u.id,
            subject: `Welcome to Exatech · ${p.admissionNo}`,
            body: `${who}\n\n${welcome}\n\nYour ${u.kind === 'guardian' ? 'parent' : 'student'} portal account is ready. Sign in at ${signIn} with this email or your mobile number (one-time code).\n\n— Exatech Admissions`,
          });
        }
        const [seen] = await tx
          .select({ id: s.notification.id })
          .from(s.notification)
          .where(and(eq(s.notification.userId, u.id), eq(s.notification.entityType, 'admission'), eq(s.notification.entityId, a.id)));
        if (!seen) {
          await this.notify.notify(tx, {
            userIds: [u.id],
            category: 'admission',
            title: `Welcome to Exatech · ${p.admissionNo}`,
            body: `${a.studentName} · ${batch?.code ?? ''}${first ? ` · first invoice ${formatINR(first.amount)} due ${formatDate(first.dueDate)}` : ''}`,
            link: u.kind === 'guardian' ? '/parent' : '/student',
            entityType: 'admission',
            entityId: a.id,
          });
        }
      }
      await tx.update(s.user).set({ invitedAt: new Date() }).where(and(inArray(s.user.id, recipients), eq(s.user.status, 'invited')));
    });
    this.log.log(`invites sent for ${p.admissionNo} → ${users.length} recipient(s)`);
  }
}
