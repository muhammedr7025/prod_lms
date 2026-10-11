import { LEAD_STAGES } from '@exatech/domain';
import { z } from 'zod';
import { route, zDate, zId, zInstant, zOk, zPaise } from '../route';

/**
 * Sales CRM (PRD §7, source PRD §5.1): pipeline, leads, follow-ups, import,
 * assignment rules, funnel, targets. Admissions live in `admissions.ts`
 * (implemented by the same module); the wizard's pickers come from
 * `salesContract.admissionOptions`.
 */
export const zLeadStage = z.enum(LEAD_STAGES);
export const LOST_REASONS = ['Price', 'Timing', 'Location', 'Joined elsewhere', 'Other'] as const;
export const ACTIVITY_KINDS = ['call', 'whatsapp', 'email', 'visit', 'note'] as const;
export const FOLLOW_UP_CHANNELS = ['call', 'whatsapp', 'email', 'visit'] as const;
export const IMPORT_TARGETS = ['name', 'phone', 'email', 'course', 'campaign', 'source', 'branch', 'skip'] as const;
export const IMPORT_TARGET_LABEL: Record<(typeof IMPORT_TARGETS)[number], string> = {
  name: 'name',
  phone: 'phone (E.164)',
  email: 'email',
  course: 'course interest',
  campaign: 'campaign',
  source: 'source',
  branch: 'preferred branch',
  skip: '— skip —',
};

/* ───────────────────────── Leads ───────────────────────── */

export const zLeadCard = z.object({
  id: zId,
  name: z.string(),
  score: z.number().int(),
  stage: zLeadStage,
  stageLabel: z.string(),
  courseId: zId.nullable(),
  courseName: z.string().nullable(),
  source: z.string(),
  ownerId: zId.nullable(),
  ownerName: z.string(),
  /** "Today 15:00 · Call back after 4 pm", "Overdue · Fri 10 Oct", "No follow-up". */
  nextLine: z.string(),
  nextOverdue: z.boolean(),
  /** One-click advance target (null when the stage is reached through the admission flow). */
  nextStage: zLeadStage.nullable(),
});
export type LeadCard = z.output<typeof zLeadCard>;

export const zLeadRow = zLeadCard.extend({
  phone: z.string().nullable(),
  phoneDisplay: z.string(),
  email: z.string().nullable(),
  campaign: z.string().nullable(),
  createdAt: zInstant,
});
export type LeadRow = z.output<typeof zLeadRow>;

export const zLeadActivity = z.object({ id: zId, kind: z.string(), summary: z.string(), actorName: z.string().nullable(), at: zInstant });

export const zLeadDetail = zLeadRow.extend({
  branchId: zId,
  preferredBranchId: zId.nullable(),
  preferredBranchName: z.string().nullable(),
  lostReason: z.string().nullable(),
  consentWhatsapp: z.boolean(),
  consentEmail: z.boolean(),
  responded: z.boolean(),
  firstResponseAt: zInstant.nullable(),
  nextFollowUpAt: zInstant.nullable(),
  nextFollowUpNote: z.string().nullable(),
  admissionId: zId.nullable(),
  admissionStatus: z.string().nullable(),
  studentId: zId.nullable(),
  /** Convert to admission is possible (open lead without an active application). */
  canConvert: z.boolean(),
  activities: z.array(zLeadActivity),
});
export type LeadDetail = z.output<typeof zLeadDetail>;

export const zLeadInput = z.object({
  name: z.string().trim().min(2, 'Enter the full name'),
  phone: z.string().trim().min(1, 'Enter a valid 10-digit mobile'),
  /** Optional; validated server-side ("" = none). */
  email: z.string().trim().max(120).nullable().optional(),
  courseId: zId.nullable().optional(),
  source: z.string().trim().min(1, 'Pick a source'),
  campaign: z.string().trim().max(80).nullable().optional(),
  preferredBranchId: zId.nullable().optional(),
});
export type LeadInput = z.input<typeof zLeadInput>;

export const zLeadsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  stage: zLeadStage.optional(),
  courseId: zId.optional(),
  source: z.string().max(40).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  ownerId: zId.optional(),
  /** open = everything but won/lost */
  status: z.enum(['all', 'open']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const zLeadCheck = z.object({
  phoneValid: z.boolean(),
  phoneE164: z.string().nullable(),
  emailValid: z.boolean(),
  duplicate: z.object({ kind: z.enum(['lead', 'student']), id: zId, name: z.string(), line: z.string(), canOpen: z.boolean() }).nullable(),
  assignee: z.object({ userId: zId, name: z.string(), ruleName: z.string() }).nullable(),
});

/* ───────────────────────── Follow-ups & templates ───────────────────────── */

export const zFollowUpItem = z.object({
  id: zId,
  leadId: zId,
  leadName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  dueAt: zInstant,
  dueLabel: z.string(),
  channel: z.enum(FOLLOW_UP_CHANNELS),
  note: z.string().nullable(),
  ownerName: z.string(),
  stage: zLeadStage,
  nextStage: zLeadStage.nullable(),
});
export type FollowUpItem = z.output<typeof zFollowUpItem>;

export const zTemplate = z.object({
  id: zId,
  key: z.string(),
  name: z.string(),
  channel: z.string(),
  category: z.string(),
  body: z.string(),
  variables: z.array(z.string()),
  status: z.enum(['approved', 'pending', 'rejected']),
});
export type MessageTemplate = z.output<typeof zTemplate>;

export const zFollowUpNext = z.object({ dueAt: z.string().min(10, 'Pick a date and time'), channel: z.enum(FOLLOW_UP_CHANNELS), note: z.string().trim().max(300).nullable().optional() });

/* ───────────────────────── Assignment rules ───────────────────────── */

export const zRuleCondition = z.object({
  sources: z.array(z.string()).default([]),
  courseIds: z.array(zId).default([]),
  preferredBranchIds: z.array(zId).default([]),
});

export const zRuleRow = z.object({
  id: zId,
  position: z.number().int(),
  name: z.string(),
  whenLabel: z.string(),
  assignLabel: z.string(),
  fallback: z.string(),
  matched: z.number().int(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  strategy: z.enum(['single', 'round_robin']),
  condition: zRuleCondition,
  assigneeUserIds: z.array(zId),
});
export type RuleRow = z.output<typeof zRuleRow>;

export const zRuleInput = z.object({
  name: z.string().trim().min(2, 'Name the rule'),
  condition: zRuleCondition,
  assigneeUserIds: z.array(zId).min(1, 'Pick at least one salesperson'),
  strategy: z.enum(['single', 'round_robin']),
  fallback: z.string().trim().max(40).default('—'),
});
export type RuleInput = z.input<typeof zRuleInput>;

export const zTeamMember = z.object({ id: zId, name: z.string(), onLeave: z.boolean(), openLeads: z.number().int(), overdueLeads: z.number().int() });

/* ───────────────────────── Import ───────────────────────── */

export const zImportTarget = z.enum(IMPORT_TARGETS);
export const zImportJob = z.object({
  id: zId,
  shortId: z.string(),
  filename: z.string(),
  status: z.enum(['uploaded', 'validated', 'queued', 'running', 'completed', 'failed']),
  headers: z.array(z.string()),
  mapping: z.record(z.string(), zImportTarget),
  totalRows: z.number().int(),
  /** First 50 data rows as parsed (only on create/validate responses). */
  preview: z.array(z.array(z.string())).optional(),
  validation: z
    .object({
      valid: z.number().int(),
      duplicates: z.number().int(),
      duplicateLeads: z.number().int(),
      duplicateStudents: z.number().int(),
      invalid: z.number().int(),
      invalidLine: z.string(),
    })
    .nullable(),
  dupStrategy: z.enum(['merge', 'skip', 'create']),
  progress: z.number().int(),
  processedRows: z.number().int(),
  created: z.number().int(),
  merged: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  assignees: z.number().int(),
  durationSec: z.number().nullable(),
  startedAt: zInstant.nullable(),
  finishedAt: zInstant.nullable(),
});
export type ImportJob = z.output<typeof zImportJob>;

/* ───────────────────────── Admission wizard pickers ───────────────────────── */

export const zAdmissionOptions = z.object({
  today: zDate,
  thresholds: z.object({ financePct: z.number(), superAdminPct: z.number() }),
  courses: z.array(z.object({ id: zId, code: z.string(), name: z.string() })),
  batches: z.array(
    z.object({
      id: zId,
      code: z.string(),
      branchId: zId,
      branchName: z.string(),
      courseId: zId,
      status: z.string(),
      capacity: z.number().int(),
      enrolled: z.number().int(),
      seatsLeft: z.number().int(),
      waitlisted: z.number().int(),
      /** "Tue/Thu 16:30 · starts 3 Nov · Nithin Raj" */
      line: z.string(),
      feePlanId: zId.nullable(),
    }),
  ),
  plans: z.array(
    z.object({
      id: zId,
      courseId: zId,
      branchId: zId.nullable(),
      name: z.string(),
      kind: z.string(),
      components: z.array(z.object({ name: z.string(), amount: zPaise })),
      schedule: z.array(z.object({ label: z.string(), pct: z.number(), dueOffsetDays: z.number() })),
      gstRate: z.number(),
      earlyPayDiscountPct: z.number(),
      isDefault: z.boolean(),
    }),
  ),
});
export type AdmissionOptions = z.output<typeof zAdmissionOptions>;

/* ───────────────────────── Routes ───────────────────────── */

export const salesContract = {
  pipeline: route({
    method: 'GET',
    path: '/api/sales/pipeline',
    response: z.object({
      scopeLabel: z.string(),
      openTotal: z.number().int(),
      columns: z.array(z.object({ stage: zLeadStage, label: z.string(), count: z.number().int(), leads: z.array(zLeadCard) })),
    }),
  }),
  leads: route({ method: 'GET', path: '/api/sales/leads', query: zLeadsQuery, response: z.object({ scopeLabel: z.string(), items: z.array(zLeadRow), total: z.number().int() }) }),
  /** Live dedupe + rule preview for the New lead dialog (does not advance round-robin cursors). */
  checkLead: route({
    method: 'GET',
    path: '/api/sales/leads/check',
    query: z.object({ phone: z.string().max(30).optional(), email: z.string().max(120).optional(), courseId: zId.optional(), source: z.string().max(40).optional(), preferredBranchId: zId.optional() }),
    response: zLeadCheck,
  }),
  getLead: route({ method: 'GET', path: '/api/sales/leads/:id', response: zLeadDetail }),
  createLead: route({ method: 'POST', path: '/api/sales/leads', body: zLeadInput, response: zLeadDetail }),
  /** Advance (nextStage), Mark lost (with reason), or Undo (back to `to` when `undo`). */
  setStage: route({
    method: 'POST',
    path: '/api/sales/leads/:id/stage',
    body: z.object({ to: zLeadStage, from: zLeadStage, lostReason: z.enum(LOST_REASONS).optional(), note: z.string().trim().max(300).optional(), undo: z.boolean().default(false) }),
    response: zLeadCard,
  }),
  logActivity: route({
    method: 'POST',
    path: '/api/sales/leads/:id/activities',
    body: z.object({
      kind: z.enum(ACTIVITY_KINDS),
      summary: z.string().trim().min(2, 'Describe the outcome'),
      templateKey: z.string().max(60).optional(),
      consentWhatsapp: z.boolean().optional(),
    }),
    response: zLeadDetail,
  }),

  followUps: route({
    method: 'GET',
    path: '/api/sales/follow-ups',
    response: z.object({
      dateLabel: z.string(),
      medianFirstResponse: z.string(),
      overdue: z.array(zFollowUpItem),
      today: z.array(zFollowUpItem),
      upcoming: z.number().int(),
      templates: z.array(zTemplate),
      myMonth: z.object({ calls: z.number().int(), admissions: z.number().int(), target: z.number().int().nullable(), pct: z.number().int().nullable() }),
    }),
  }),
  scheduleFollowUp: route({
    method: 'POST',
    path: '/api/sales/follow-ups',
    body: zFollowUpNext.extend({ leadId: zId }),
    response: zOk,
  }),
  completeFollowUp: route({
    method: 'POST',
    path: '/api/sales/follow-ups/:id/complete',
    body: z.object({ outcome: z.string().trim().min(2, 'Describe the outcome'), next: zFollowUpNext.nullable().optional(), advance: z.boolean().default(false) }),
    response: zOk,
  }),
  templates: route({ method: 'GET', path: '/api/sales/templates', response: z.array(zTemplate) }),

  rules: route({
    method: 'GET',
    path: '/api/sales/rules',
    response: z.object({
      branchId: zId,
      branchName: z.string(),
      rules: z.array(zRuleRow),
      team: z.array(zTeamMember),
      courses: z.array(z.object({ id: zId, name: z.string() })),
      branches: z.array(z.object({ id: zId, name: z.string() })),
      sources: z.array(z.string()),
    }),
  }),
  createRule: route({ method: 'POST', path: '/api/sales/rules', body: zRuleInput, response: zOk }),
  updateRule: route({ method: 'PUT', path: '/api/sales/rules/:id', body: zRuleInput, response: zOk }),
  toggleRule: route({ method: 'POST', path: '/api/sales/rules/:id/toggle', body: z.object({ enabled: z.boolean() }), response: zOk }),
  moveRule: route({ method: 'POST', path: '/api/sales/rules/:id/move', body: z.object({ direction: z.enum(['up', 'down']) }), response: zOk }),
  deleteRule: route({ method: 'DELETE', path: '/api/sales/rules/:id', response: zOk }),
  reassign: route({
    method: 'POST',
    path: '/api/sales/reassign',
    body: z.object({ fromUserId: zId, toUserId: zId, which: z.enum(['open', 'overdue']) }),
    response: z.object({ count: z.number().int() }),
  }),

  funnel: route({
    method: 'GET',
    path: '/api/sales/funnel',
    query: z.object({ period: z.enum(['week', 'month', 'quarter']).default('month') }),
    response: z.object({
      scopeLabel: z.string(),
      periodLabel: z.string(),
      kpis: z.object({
        leads: z.number().int(),
        leadsMeta: z.string(),
        conversionPct: z.number(),
        conversionMeta: z.string(),
        medianFirstResponse: z.string(),
        revenue: zPaise,
        admissions: z.number().int(),
      }),
      stages: z.array(z.object({ stage: zLeadStage, label: z.string(), n: z.number().int(), pct: z.number(), conv: z.string() })),
      lostLine: z.string(),
      sources: z.array(z.object({ source: z.string(), leads: z.number().int(), won: z.number().int(), convPct: z.number(), best: z.boolean() })),
    }),
  }),
  leaderboard: route({
    method: 'GET',
    path: '/api/sales/leaderboard',
    response: z.object({
      scopeLabel: z.string(),
      monthLabel: z.string(),
      nextMonth: zDate,
      nextMonthLabel: z.string(),
      rows: z.array(
        z.object({
          rank: z.number().int(),
          userId: zId,
          name: z.string(),
          leads: z.number().int(),
          fastLine: z.string(),
          admissions: z.number().int(),
          target: z.number().int().nullable(),
          targetPct: z.number(),
          revenue: zPaise,
        }),
      ),
      nextTargets: z.array(z.object({ userId: zId, name: z.string(), admissions: z.number().int(), revenue: zPaise })),
    }),
  }),
  setTargets: route({
    method: 'PUT',
    path: '/api/sales/targets',
    body: z.object({ month: zDate, rows: z.array(z.object({ userId: zId, admissions: z.number().int().min(0), revenue: zPaise.min(0) })).min(1) }),
    response: zOk,
  }),

  createImport: route({ method: 'POST', path: '/api/sales/imports', body: z.object({ fileId: zId }), response: zImportJob }),
  getImport: route({ method: 'GET', path: '/api/sales/imports/:id', response: zImportJob }),
  validateImport: route({ method: 'POST', path: '/api/sales/imports/:id/validate', body: z.object({ mapping: z.record(z.string(), zImportTarget) }), response: zImportJob }),
  runImport: route({ method: 'POST', path: '/api/sales/imports/:id/run', body: z.object({ dupStrategy: z.enum(['merge', 'skip', 'create']) }), response: zImportJob }),
  /** CSV downloads (plain GET links). */
  importErrorsPath: '/api/sales/imports/:id/errors',
  importTemplatePath: '/api/sales/import-template',

  admissionOptions: route({ method: 'GET', path: '/api/sales/admission-options', response: zAdmissionOptions }),
};

/** Public website enquiry form (no session; honeypot + rate limit). */
export const publicLeadsContract = {
  enquiry: route({
    method: 'POST',
    path: '/api/public/leads',
    body: z.object({
      name: z.string().trim().min(2, 'Enter your name').max(120),
      phone: z.string().trim().min(6, 'Enter a valid 10-digit mobile').max(30),
      email: z.string().trim().max(120).optional(),
      /** Course id, code ("DM") or name. */
      course: z.string().trim().max(120).optional(),
      /** Branch id, code ("TVM") or city. */
      branch: z.string().trim().max(120).optional(),
      message: z.string().trim().max(1000).optional(),
      /** Honeypot — real browsers leave it empty. */
      website: z.string().max(200).optional(),
    }),
    response: z.object({ ok: z.literal(true), message: z.string() }),
  }),
};
