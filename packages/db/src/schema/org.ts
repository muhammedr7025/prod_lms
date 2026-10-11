import type { ClearancePolicy, DiscountThresholds, FeeComponent, ScheduleStep, GradeBand, LateFeeRule, AllocationOrder } from '@exatech/domain';
import { boolean, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, tsz, updatedAt } from './_helpers';

export interface InstitutionSettings {
  clearancePolicy: ClearancePolicy;
  discountThresholds: DiscountThresholds;
  admissionNumberPattern: string;
  security: {
    require2faRoles: string[];
    staffSessionHours: number;
    staffIdleMinutes: number;
    portalSessionDays: number;
    impersonationMinutes: number;
  };
  leadRetentionMonths: number;
  attendanceEditWindowHours: number;
  lowAttendanceThreshold: number;
  travelBufferMinutes: number;
  finance: FinanceSettings;
}

export interface FinanceSettings {
  numbering: { invoice: string; receipt: string; credit_note: string };
  gstRate: number;
  sac: string;
  lateFee: LateFeeRule;
  minPartial: number; // paise
  restructureApprovalAbove: number; // paise
  allocationOrder: AllocationOrder;
  methods: { upi: boolean; cash: boolean; card: boolean; cheque: boolean; transfer: boolean; online: boolean };
  chequeUnlocksAfterClearance: boolean;
  reminderDaysBefore: number[];
  reminderDaysAfter: number[];
  /** UPI VPA used for the desk's exact-amount QR (e.g. exatech@hdfcbank). */
  upiVpa?: string | null;
}

export const institution = pgTable('institution', {
  id: pk(),
  name: text().notNull(),
  legalName: text(),
  gstin: text(),
  address: text(),
  phone: text(),
  email: text(),
  website: text(),
  logoFileId: uuid(),
  brandColor: text().default('#4f9d68').notNull(),
  academicYearLabel: text().notNull(),
  academicYearStart: date().notNull(),
  settings: jsonb().$type<InstitutionSettings>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const branch = pgTable(
  'branch',
  {
    id: pk(),
    institutionId: uuid()
      .notNull()
      .references(() => institution.id),
    code: text().notNull(),
    name: text().notNull(),
    address: text(),
    city: text(),
    phone: text(),
    email: text(),
    gstin: text(),
    gstinNote: text(),
    managerUserId: uuid(),
    openedOn: date(),
    status: text({ enum: ['active', 'paused', 'archived'] }).default('active').notNull(),
    statusNote: text(),
    /** Monthly collection target in paise (collection vs target). */
    monthlyTarget: money().default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.institutionId, t.code)],
);

export const room = pgTable(
  'room',
  {
    id: pk(),
    branchId: uuid()
      .notNull()
      .references(() => branch.id),
    name: text().notNull(),
    capacity: integer().notNull(),
    kind: text({ enum: ['room', 'lab', 'hall'] }).default('room').notNull(),
    active: boolean().default(true).notNull(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.name)],
);

export const holiday = pgTable(
  'holiday',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    /** null = all branches */
    branchId: uuid(),
    date: date().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.date)],
);

/* ───────────────────────── Catalogue ───────────────────────── */

export const course = pgTable(
  'course',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    category: text(),
    durationMonths: integer().notNull(),
    modality: text({ enum: ['offline', 'online', 'hybrid'] }).notNull(),
    description: text(),
    /** Per-course override of the institution clearance policy. */
    clearancePolicy: jsonb().$type<ClearancePolicy>(),
    gradeScheme: jsonb().$type<GradeBand[]>(),
    status: text({ enum: ['active', 'archived'] }).default('active').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.institutionId, t.code)],
);

/** Syllabus subjects; a teacher teaches one subject per batch. */
export const courseSubject = pgTable('course_subject', {
  id: pk(),
  courseId: uuid()
    .notNull()
    .references(() => course.id),
  name: text().notNull(),
  position: integer().default(0).notNull(),
});

export const feePlan = pgTable('fee_plan', {
  id: pk(),
  institutionId: uuid().notNull(),
  courseId: uuid()
    .notNull()
    .references(() => course.id),
  /** null = institution default for the course */
  branchId: uuid(),
  name: text().notNull(),
  kind: text({ enum: ['one_time', 'split', 'instalments', 'custom'] }).notNull(),
  components: jsonb().$type<FeeComponent[]>().notNull(),
  schedule: jsonb().$type<ScheduleStep[]>().notNull(),
  gstRate: numeric({ mode: 'number' }).default(18).notNull(),
  earlyPayDiscountPct: numeric({ mode: 'number' }).default(0).notNull(),
  version: integer().default(1).notNull(),
  isDefault: boolean().default(false).notNull(),
  active: boolean().default(true).notNull(),
  createdAt: createdAt(),
});

export const courseOffering = pgTable(
  'course_offering',
  {
    id: pk(),
    courseId: uuid()
      .notNull()
      .references(() => course.id),
    branchId: uuid()
      .notNull()
      .references(() => branch.id),
    defaultFeePlanId: uuid(),
    status: text({ enum: ['active', 'paused'] }).default('active').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.courseId, t.branchId)],
);

export const batch = pgTable(
  'batch',
  {
    id: pk(),
    branchId: uuid()
      .notNull()
      .references(() => branch.id),
    courseId: uuid()
      .notNull()
      .references(() => course.id),
    offeringId: uuid().references(() => courseOffering.id),
    code: text().notNull(),
    name: text(),
    startDate: date().notNull(),
    endDate: date().notNull(),
    capacity: integer().notNull(),
    /** "Mon/Wed/Fri 09:00" */
    scheduleLabel: text(),
    roomId: uuid(),
    feePlanId: uuid(),
    mode: text({ enum: ['offline', 'online', 'hybrid'] }).default('offline').notNull(),
    meetLink: text(),
    status: text({ enum: ['planned', 'open', 'running', 'waitlist', 'completed', 'cancelled'] }).default('planned').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.branchId, t.code), index().on(t.status)],
);

/** (teacher, batch) → subject */
export const teacherAssignment = pgTable(
  'teacher_assignment',
  {
    id: pk(),
    batchId: uuid()
      .notNull()
      .references(() => batch.id),
    teacherUserId: uuid().notNull(),
    subjectId: uuid(),
    subjectName: text().notNull(),
    isPrimary: boolean().default(true).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.batchId, t.teacherUserId), index().on(t.teacherUserId)],
);

/* ───────────────────────── Scheduling ───────────────────────── */

export const classSession = pgTable(
  'class_session',
  {
    id: pk(),
    branchId: uuid()
      .notNull()
      .references(() => branch.id),
    batchId: uuid()
      .notNull()
      .references(() => batch.id),
    teacherUserId: uuid().notNull(),
    subjectName: text().notNull(),
    roomId: uuid(),
    date: date().notNull(),
    startTime: text().notNull(),
    endTime: text().notNull(),
    mode: text({ enum: ['offline', 'online', 'hybrid'] }).default('offline').notNull(),
    kind: text({ enum: ['timetabled', 'adhoc', 'exam'] }).default('timetabled').notNull(),
    adhocType: text({ enum: ['substitute', 'extra', 'doubt_clearing', 'guest'] }),
    adhocReason: text(),
    status: text({ enum: ['scheduled', 'cancelled', 'held', 'suppressed'] }).default('scheduled').notNull(),
    topic: text(),
    /** Original teacher when a substitute has been assigned. */
    substituteForUserId: uuid(),
    flag: text(),
    acknowledgedAt: tsz(),
    acknowledgedBy: uuid(),
    attendanceSubmittedAt: tsz(),
    attendanceSubmittedBy: uuid(),
    /** Set when the subject taught differs from the assigned subject. */
    subjectTaught: text(),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.branchId, t.date), index().on(t.batchId, t.date), index().on(t.teacherUserId, t.date)],
);

export const leave = pgTable(
  'leave',
  {
    id: pk(),
    userId: uuid().notNull(),
    branchId: uuid().notNull(),
    date: date().notNull(),
    type: text({ enum: ['casual', 'sick', 'earned', 'on_duty'] }).notNull(),
    reason: text(),
    status: text({ enum: ['pending', 'approved', 'rejected', 'cancelled'] }).default('pending').notNull(),
    decidedBy: uuid(),
    decidedAt: tsz(),
    decisionNote: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.date), index().on(t.branchId, t.status)],
);
