import type { FeeQuote } from '@exatech/domain';
import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, tsz, updatedAt } from './_helpers';

/* ───────────────────────── Students & guardians ───────────────────────── */

export const student = pgTable(
  'student',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    branchId: uuid().notNull(),
    /** Portal account; created on admission approval. */
    userId: uuid(),
    admissionNo: text().unique(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    dob: date(),
    gender: text(),
    address: text(),
    photoFileId: uuid(),
    /** Opaque random token encoded in the signed QR on ID cards; rotated on reissue. */
    cardToken: text().unique(),
    cardIssuedAt: tsz(),
    status: text({ enum: ['active', 'inactive', 'alumni'] }).default('active').notNull(),
    leadId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.branchId), index().on(t.phone), index('student_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`)],
);

export const guardian = pgTable('guardian', {
  id: pk(),
  userId: uuid(),
  name: text().notNull(),
  phone: text(),
  email: text(),
  createdAt: createdAt(),
});

export const studentGuardian = pgTable(
  'student_guardian',
  {
    studentId: uuid()
      .notNull()
      .references(() => student.id),
    guardianId: uuid()
      .notNull()
      .references(() => guardian.id),
    relationship: text().notNull(),
    isPrimary: boolean().default(true).notNull(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.guardianId] })],
);

export const enrollment = pgTable(
  'enrollment',
  {
    id: pk(),
    studentId: uuid()
      .notNull()
      .references(() => student.id),
    batchId: uuid().notNull(),
    branchId: uuid().notNull(),
    status: text({ enum: ['active', 'on_hold', 'transferred', 'dropped', 'completed'] }).default('active').notNull(),
    joinedOn: date().notNull(),
    leftOn: date(),
    feePlanId: uuid(),
    feePlanName: text(),
    feeTotal: money().default(0).notNull(),
    discountPct: numeric({ mode: 'number' }).default(0).notNull(),
    /** Cached clearance, recomputed on payment / void / waiver / exemption. */
    feeCleared: boolean().default(false).notNull(),
    clearedUntil: date(),
    clearanceReason: text(),
    exemptUntil: date(),
    exemptReason: text(),
    /** Cached attendance %, recomputed on attendance submission. */
    attendancePct: integer().default(100).notNull(),
    /** Credit balance held on the fee account (overpayments, advances). */
    creditBalance: money().default(0).notNull(),
    admissionId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.batchId),
    index().on(t.studentId),
    index().on(t.branchId, t.status),
    uniqueIndex('enrollment_active_unique').on(t.studentId, t.batchId).where(sql`${t.status} = 'active'`),
  ],
);

export const enrollmentTransfer = pgTable('enrollment_transfer', {
  id: pk(),
  fromEnrollmentId: uuid().notNull(),
  toEnrollmentId: uuid().notNull(),
  effectiveDate: date().notNull(),
  reason: text().notNull(),
  adjustment: money().default(0).notNull(),
  createdBy: uuid(),
  createdAt: createdAt(),
});

export const document = pgTable(
  'document',
  {
    id: pk(),
    ownerType: text({ enum: ['admission', 'student', 'staff'] }).notNull(),
    ownerId: uuid().notNull(),
    kind: text({ enum: ['id_proof', 'photo', 'certificate', 'other'] }).notNull(),
    label: text().notNull(),
    fileId: uuid(),
    status: text({ enum: ['uploaded', 'verified', 'missing', 'rejected'] }).default('uploaded').notNull(),
    uploadedBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ownerType, t.ownerId)],
);

/* ───────────────────────── CRM ───────────────────────── */

export const lead = pgTable(
  'lead',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    branchId: uuid().notNull(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    source: text().notNull(),
    campaign: text(),
    courseId: uuid(),
    preferredBranchId: uuid(),
    preferredTiming: text(),
    stage: text({ enum: ['new', 'contacted', 'counselled', 'demo_scheduled', 'negotiation', 'admission_in_progress', 'won', 'lost'] })
      .default('new')
      .notNull(),
    lostReason: text(),
    ownerUserId: uuid(),
    score: integer().default(0).notNull(),
    tags: text().array().default([]).notNull(),
    consentWhatsapp: boolean().default(false).notNull(),
    consentEmail: boolean().default(false).notNull(),
    consentCapturedAt: tsz(),
    responded: boolean().default(false).notNull(),
    visited: boolean().default(false).notNull(),
    demoAttended: boolean().default(false).notNull(),
    firstResponseAt: tsz(),
    nextFollowUpAt: tsz(),
    nextFollowUpNote: text(),
    studentId: uuid(),
    admissionId: uuid(),
    importJobId: uuid(),
    assignedByRuleId: uuid(),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: tsz().defaultNow().notNull(),
  },
  (t) => [
    index().on(t.branchId, t.stage),
    index().on(t.ownerUserId),
    index().on(t.phone),
    index().on(t.email),
    index('lead_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const leadActivity = pgTable(
  'lead_activity',
  {
    id: pk(),
    leadId: uuid()
      .notNull()
      .references(() => lead.id),
    actorUserId: uuid(),
    kind: text({ enum: ['created', 'stage', 'call', 'whatsapp', 'email', 'note', 'visit', 'follow_up', 'assigned', 'merged', 'import', 'admission'] }).notNull(),
    summary: text().notNull(),
    meta: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.leadId, t.createdAt)],
);

export const followUp = pgTable(
  'follow_up',
  {
    id: pk(),
    leadId: uuid()
      .notNull()
      .references(() => lead.id),
    ownerUserId: uuid().notNull(),
    dueAt: tsz().notNull(),
    channel: text({ enum: ['call', 'whatsapp', 'email', 'visit'] }).notNull(),
    note: text(),
    status: text({ enum: ['open', 'done', 'cancelled'] }).default('open').notNull(),
    outcome: text(),
    doneAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ownerUserId, t.status, t.dueAt)],
);

export interface ImportMapping {
  [sourceColumn: string]: 'name' | 'phone' | 'email' | 'course' | 'campaign' | 'source' | 'branch' | 'skip';
}

export const leadImportJob = pgTable('lead_import_job', {
  id: pk(),
  branchId: uuid().notNull(),
  createdBy: uuid().notNull(),
  filename: text().notNull(),
  fileId: uuid(),
  status: text({ enum: ['uploaded', 'validated', 'queued', 'running', 'completed', 'failed'] }).default('uploaded').notNull(),
  headers: text().array().default([]).notNull(),
  mapping: jsonb().$type<ImportMapping>(),
  dupStrategy: text({ enum: ['merge', 'skip', 'create'] }).default('merge').notNull(),
  totalRows: integer().default(0).notNull(),
  validRows: integer().default(0).notNull(),
  duplicateRows: integer().default(0).notNull(),
  duplicateLeads: integer().default(0).notNull(),
  duplicateStudents: integer().default(0).notNull(),
  invalidRows: integer().default(0).notNull(),
  createdCount: integer().default(0).notNull(),
  mergedCount: integer().default(0).notNull(),
  skippedCount: integer().default(0).notNull(),
  errorCount: integer().default(0).notNull(),
  errors: jsonb().$type<{ row: number; field: string; message: string; value?: string }[]>().default([]).notNull(),
  progress: integer().default(0).notNull(),
  startedAt: tsz(),
  finishedAt: tsz(),
  createdAt: createdAt(),
});

export const assignmentRule = pgTable('assignment_rule', {
  id: pk(),
  branchId: uuid().notNull(),
  position: integer().notNull(),
  name: text().notNull(),
  condition: jsonb().$type<{ sources?: string[]; courseIds?: string[]; preferredBranchIds?: string[] }>().default({}).notNull(),
  assigneeUserIds: uuid().array().default([]).notNull(),
  assigneeLabel: text(),
  strategy: text({ enum: ['single', 'round_robin'] }).default('round_robin').notNull(),
  cursor: integer().default(0).notNull(),
  fallback: text(),
  enabled: boolean().default(true).notNull(),
  isDefault: boolean().default(false).notNull(),
  matchedCount: integer().default(0).notNull(),
  createdAt: createdAt(),
});

export const salesTarget = pgTable(
  'sales_target',
  {
    id: pk(),
    userId: uuid().notNull(),
    branchId: uuid().notNull(),
    month: date().notNull(),
    targetAdmissions: integer().notNull(),
    targetRevenue: money().default(0).notNull(),
  },
  (t) => [uniqueIndex().on(t.userId, t.month)],
);

export const messageTemplate = pgTable('message_template', {
  id: pk(),
  channel: text({ enum: ['whatsapp', 'email', 'sms'] }).notNull(),
  key: text().notNull().unique(),
  name: text().notNull(),
  subject: text(),
  body: text().notNull(),
  variables: text().array().default([]).notNull(),
  status: text({ enum: ['approved', 'pending', 'rejected'] }).default('pending').notNull(),
  category: text().notNull(),
  createdAt: createdAt(),
});

/* ───────────────────────── Admissions ───────────────────────── */

export const admission = pgTable(
  'admission',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    branchId: uuid().notNull(),
    leadId: uuid(),
    salesUserId: uuid().notNull(),
    studentName: text().notNull(),
    studentPhone: text(),
    studentEmail: text(),
    studentDob: date(),
    studentAddress: text(),
    guardianName: text(),
    guardianRelationship: text(),
    guardianPhone: text(),
    guardianEmail: text(),
    batchId: uuid().notNull(),
    feePlanId: uuid().notNull(),
    discountPct: numeric({ mode: 'number' }).default(0).notNull(),
    discountReason: text(),
    quote: jsonb().$type<FeeQuote>(),
    consent: jsonb().$type<{ dpdp: boolean; purposes: string[]; parental: boolean; capturedAt: string }>(),
    referralCode: text(),
    waitlist: boolean().default(false).notNull(),
    status: text({ enum: ['draft', 'submitted', 'fee_verified', 'approved', 'returned', 'waitlisted', 'cancelled'] }).default('draft').notNull(),
    /** Discount above the Super Admin threshold. */
    needsSuperAdmin: boolean().default(false).notNull(),
    financeVerifiedBy: uuid(),
    financeVerifiedAt: tsz(),
    superAdminApprovedBy: uuid(),
    superAdminApprovedAt: tsz(),
    approvedBy: uuid(),
    approvedAt: tsz(),
    returnedBy: uuid(),
    returnedAt: tsz(),
    returnedTo: text({ enum: ['sales', 'finance'] }),
    returnNote: text(),
    admissionNo: text(),
    studentId: uuid(),
    enrollmentId: uuid(),
    seatHoldUntil: tsz(),
    submittedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.branchId, t.status)],
);

export const admissionEvent = pgTable(
  'admission_event',
  {
    id: pk(),
    admissionId: uuid()
      .notNull()
      .references(() => admission.id),
    step: text({ enum: ['sales', 'finance', 'super_admin', 'branch_admin'] }).notNull(),
    action: text({ enum: ['submitted', 'verified', 'approved', 'returned', 'resubmitted', 'cancelled', 'waitlisted'] }).notNull(),
    actorUserId: uuid(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.admissionId)],
);
