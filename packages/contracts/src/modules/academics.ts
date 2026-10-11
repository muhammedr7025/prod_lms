import { z } from 'zod';
import { route, zDate, zId, zInstant, zOk, zPage, zPaise, zTime } from '../route';

/**
 * Academics (Branch Administrator): branch operations, courses & batches,
 * timetable, students, notes oversight and marks publishing. Implemented by
 * the Academics module; every list is scoped to the selected branch.
 * Display-ready labels and tag variants are computed on the server.
 */

export const zAcadTag = z.enum(['accent', 'neutral', 'outline', 'ink', 'solid', 'plain']);
export type AcadTag = z.output<typeof zAcadTag>;

export const zAcadMode = z.enum(['offline', 'online', 'hybrid']);

/* ───────────────────────── Branch operations ───────────────────────── */

export const zAcadTodaySession = z.object({
  id: zId,
  date: zDate,
  /** "09:00", or "Thu 14:00" for an older ad-hoc session still awaiting acknowledgement. */
  time: z.string(),
  batchId: zId,
  batchCode: z.string(),
  topic: z.string(),
  teacherName: z.string(),
  roomName: z.string(),
  kind: z.enum(['timetabled', 'adhoc', 'exam']),
  status: z.enum(['marked', 'next', 'upcoming', 'not_marked', 'adhoc_pending', 'in_progress']),
  statusLabel: z.string(),
  tag: zAcadTag,
  canAcknowledge: z.boolean(),
  adhocNote: z.string().nullable(),
});
export type AcadTodaySession = z.output<typeof zAcadTodaySession>;

export const zAcadAtRiskRow = z.object({
  studentId: zId,
  name: z.string(),
  batchCode: z.string(),
  reasons: z.array(z.string()),
  attendancePct: z.number().int(),
  overdue: zPaise,
});
export type AcadAtRiskRow = z.output<typeof zAcadAtRiskRow>;

export const zAcadLeaveRow = z.object({
  id: zId,
  userId: zId,
  userName: z.string(),
  date: zDate,
  dateLabel: z.string(),
  type: z.string(),
  reason: z.string().nullable(),
  /** "2 sessions affected · DM-A 09:00, DM-B 16:30" */
  impact: z.string(),
  requestedAt: zInstant,
});
export type AcadLeaveRow = z.output<typeof zAcadLeaveRow>;

export const zAcadOverview = z.object({
  branchLabel: z.string(),
  dateLabel: z.string(),
  kpis: z.object({
    sessionsToday: z.number().int(),
    sessionsMarked: z.number().int(),
    runningBatches: z.number().int(),
    activeStudents: z.number().int(),
    admissionsPending: z.number().int(),
    marksToPublish: z.number().int(),
    atRisk: z.number().int(),
  }),
  sessions: z.array(zAcadTodaySession),
  atRisk: z.array(zAcadAtRiskRow),
  leave: z.array(zAcadLeaveRow),
});
export type AcadOverview = z.output<typeof zAcadOverview>;

/* ───────────────────────── Courses & batches ───────────────────────── */

export const ACAD_BATCH_STATUSES = ['planned', 'open', 'running', 'waitlist', 'completed', 'cancelled'] as const;
export type AcadBatchStatus = (typeof ACAD_BATCH_STATUSES)[number];

export const zAcadOffering = z.object({
  id: zId,
  courseId: zId,
  courseCode: z.string(),
  courseName: z.string(),
  branchId: zId,
  branchCode: z.string(),
  durationMonths: z.number().int(),
  modality: zAcadMode,
  /** "DM · 4 months · hybrid" */
  kicker: z.string(),
  /** "5 batches · 2 open · Split 50 / 50 default" */
  meta: z.string(),
  defaultFeePlanId: zId.nullable(),
  status: z.string(),
});
export type AcadOffering = z.output<typeof zAcadOffering>;

export const zAcadBatchAssignment = z.object({ teacherUserId: zId, teacherName: z.string(), subjectName: z.string(), isPrimary: z.boolean() });

export const zAcadBatchRow = z.object({
  id: zId,
  code: z.string(),
  name: z.string().nullable(),
  branchId: zId,
  branchCode: z.string(),
  courseId: zId,
  courseCode: z.string(),
  courseName: z.string(),
  schedule: z.string(),
  teacherUserId: zId.nullable(),
  teacherName: z.string().nullable(),
  subjectName: z.string().nullable(),
  assignments: z.array(zAcadBatchAssignment),
  roomId: zId.nullable(),
  roomName: z.string().nullable(),
  capacity: z.number().int(),
  enrolled: z.number().int(),
  seatsPct: z.number(),
  feePlanId: zId.nullable(),
  feePlanName: z.string().nullable(),
  status: z.enum(ACAD_BATCH_STATUSES),
  statusLabel: z.string(),
  tag: zAcadTag,
  startDate: zDate,
  endDate: zDate,
  mode: zAcadMode,
  meetLink: z.string().nullable(),
  /** Status transitions the current user may apply. */
  nextStatuses: z.array(z.enum(ACAD_BATCH_STATUSES)),
});
export type AcadBatchRow = z.output<typeof zAcadBatchRow>;

export const zAcadSlot = z.object({ weekday: z.number().int().min(0).max(6), start: zTime });

export const zAcadBatchInput = z.object({
  branchId: zId.optional(),
  courseId: zId,
  code: z
    .string()
    .trim()
    .min(2, 'Enter a batch code')
    .max(16, 'Keep the code short (16 characters)')
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only'),
  name: z.string().trim().max(80).optional().nullable(),
  startDate: zDate,
  endDate: zDate,
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(500),
  roomId: zId.nullable(),
  mode: zAcadMode,
  feePlanId: zId.nullable(),
  teacherUserId: zId,
  subjectName: z.string().trim().min(2, 'Enter the subject this teacher takes'),
  slots: z.array(zAcadSlot).min(1, 'Add at least one weekly slot').max(12),
});
export type AcadBatchInput = z.input<typeof zAcadBatchInput>;

export const zAcadBatchPlan = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()),
  sessions: z.number().int(),
  suppressed: z.number().int(),
  flagged: z.number().int(),
  firstDate: zDate.nullable(),
  lastDate: zDate.nullable(),
});
export type AcadBatchPlan = z.output<typeof zAcadBatchPlan>;

export const zAcadBatchUpdate = z.object({
  name: z.string().trim().max(80).nullable().optional(),
  startDate: zDate.optional(),
  endDate: zDate.optional(),
  capacity: z.number().int().min(1).max(500).optional(),
  roomId: zId.nullable().optional(),
  mode: zAcadMode.optional(),
  meetLink: z.string().trim().url('Enter a valid link').nullable().optional(),
  feePlanId: zId.nullable().optional(),
  status: z.enum(ACAD_BATCH_STATUSES).optional(),
  reason: z.string().trim().max(300).optional(),
});

export const academicsBatchesContract = {
  list: route({
    method: 'GET',
    path: '/api/academics/batches',
    response: z.object({ branchLabel: z.string(), offerings: z.array(zAcadOffering), batches: z.array(zAcadBatchRow), canManage: z.boolean() }),
  }),
  /** Dry run: sessions that would be generated and the blocking clashes. */
  plan: route({ method: 'POST', path: '/api/academics/batches/plan', body: zAcadBatchInput, response: zAcadBatchPlan }),
  create: route({ method: 'POST', path: '/api/academics/batches', body: zAcadBatchInput, response: zAcadBatchRow }),
  update: route({ method: 'PATCH', path: '/api/academics/batches/:id', body: zAcadBatchUpdate, response: zAcadBatchRow }),
  assign: route({
    method: 'POST',
    path: '/api/academics/batches/:id/assign',
    body: z.object({
      teacherUserId: zId,
      subjectName: z.string().trim().min(2, 'Enter the subject'),
      isPrimary: z.boolean().default(true),
      /** Swap this teacher out: their future sessions in the batch move to the new teacher. */
      replaceTeacherUserId: zId.nullable().optional(),
    }),
    response: zAcadBatchRow,
  }),
  offer: route({
    method: 'POST',
    path: '/api/academics/offerings',
    body: z.object({ courseId: zId, branchId: zId.optional(), defaultFeePlanId: zId }),
    response: zAcadOffering,
  }),
};

/* ───────────────────────── Timetable ───────────────────────── */

export const ACAD_SESSION_STYLES = ['normal', 'leave', 'substitute', 'planned', 'suppressed', 'exam', 'adhoc'] as const;

export const zAcadSessionChip = z.object({
  id: zId,
  date: zDate,
  start: zTime,
  end: zTime,
  /** Row of the week grid (one of the 2-hour slots). */
  slot: z.string(),
  branchId: zId,
  batchId: zId,
  batchCode: z.string(),
  teacherUserId: zId,
  teacherName: z.string(),
  subjectName: z.string(),
  roomId: zId.nullable(),
  roomName: z.string().nullable(),
  mode: zAcadMode,
  kind: z.enum(['timetabled', 'adhoc', 'exam']),
  status: z.enum(['scheduled', 'cancelled', 'held', 'suppressed']),
  flag: z.string().nullable(),
  substituteForName: z.string().nullable(),
  topic: z.string().nullable(),
  style: z.enum(ACAD_SESSION_STYLES),
  /** "Room 1 · Nithin Raj · Search · SEO & analytics" */
  sub: z.string(),
  editable: z.boolean(),
  lockedReason: z.string().nullable(),
});
export type AcadSessionChip = z.output<typeof zAcadSessionChip>;

export const zAcadWeekConflict = z.object({
  key: z.string(),
  code: z.string(),
  message: z.string(),
  sessionIds: z.array(zId),
  fix: z.object({ label: z.string(), sessionId: zId, roomId: zId }).nullable(),
});

export const zAcadSubstituteOption = z.object({ userId: zId, label: z.string(), status: z.enum(['free', 'busy', 'on_leave']) });

export const zAcadTimetableWeek = z.object({
  monday: zDate,
  weekNumber: z.number().int(),
  rangeLabel: z.string(),
  branchLabel: z.string(),
  isThisWeek: z.boolean(),
  days: z.array(z.object({ date: zDate, label: z.string(), holiday: z.string().nullable() })),
  slots: z.array(z.string()),
  sessions: z.array(zAcadSessionChip),
  conflicts: z.array(zAcadWeekConflict),
  checks: z.array(z.object({ ok: z.boolean(), text: z.string() })),
  substitutes: z.object({
    needed: z.array(z.object({ sessionId: zId, label: z.string(), options: z.array(zAcadSubstituteOption) })),
    done: z.array(z.object({ sessionId: zId, label: z.string(), name: z.string() })),
  }),
  rooms: z.array(z.object({ id: zId, name: z.string(), capacity: z.number().int(), branchId: zId })),
  teachers: z.array(z.object({ id: zId, name: z.string() })),
  batches: z.array(
    z.object({
      id: zId,
      code: z.string(),
      branchId: zId,
      status: z.string(),
      capacity: z.number().int(),
      roomId: zId.nullable(),
      mode: zAcadMode,
      assignments: z.array(z.object({ teacherUserId: zId, subjectName: z.string(), isPrimary: z.boolean() })),
    }),
  ),
  canManage: z.boolean(),
});
export type AcadTimetableWeek = z.output<typeof zAcadTimetableWeek>;

export const zAcadSessionInput = z.object({
  batchId: zId,
  teacherUserId: zId,
  subjectName: z.string().trim().min(2, 'Enter the subject'),
  date: zDate,
  start: zTime,
  roomId: zId.nullable(),
  mode: zAcadMode,
});
export type AcadSessionInput = z.input<typeof zAcadSessionInput>;

export const zAcadIssue = z.object({ code: z.string(), message: z.string() });

export const academicsTimetableContract = {
  week: route({
    method: 'GET',
    path: '/api/academics/timetable',
    query: z.object({ week: zDate.optional() }),
    response: zAcadTimetableWeek,
  }),
  /** Live validation for the session dialog (the server re-validates on save). */
  validate: route({
    method: 'POST',
    path: '/api/academics/sessions/validate',
    body: zAcadSessionInput.extend({ id: zId.optional() }),
    response: z.object({ ok: z.boolean(), issues: z.array(zAcadIssue) }),
  }),
  create: route({ method: 'POST', path: '/api/academics/sessions', body: zAcadSessionInput, response: z.object({ id: zId }) }),
  update: route({ method: 'PUT', path: '/api/academics/sessions/:id', body: zAcadSessionInput, response: z.object({ id: zId }) }),
  remove: route({ method: 'POST', path: '/api/academics/sessions/:id/remove', response: zOk }),
  restore: route({ method: 'POST', path: '/api/academics/sessions/:id/restore', response: zOk }),
  /** One-click conflict fix. */
  moveRoom: route({ method: 'POST', path: '/api/academics/sessions/:id/move-room', body: z.object({ roomId: zId }), response: zOk }),
  substitute: route({ method: 'POST', path: '/api/academics/sessions/:id/substitute', body: z.object({ teacherUserId: zId }), response: zOk }),
  /** Branch operations: count an ad-hoc session's attendance. */
  acknowledge: route({ method: 'POST', path: '/api/academics/sessions/:id/acknowledge', response: zOk }),
};

export const academicsOverviewContract = {
  overview: route({ method: 'GET', path: '/api/academics/overview', response: zAcadOverview }),
  decideLeave: route({
    method: 'POST',
    path: '/api/academics/leave/:id/decide',
    body: z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() }),
    response: zOk,
  }),
};

/* ───────────────────────── Students ───────────────────────── */

export const ACAD_FEE_STATUSES = ['cleared', 'partial', 'overdue'] as const;
export type AcadFeeStatus = (typeof ACAD_FEE_STATUSES)[number];

export const zAcadStudentRow = z.object({
  id: zId,
  admissionNo: z.string().nullable(),
  name: z.string(),
  batchId: zId.nullable(),
  batchCode: z.string().nullable(),
  guardian: z.string(),
  attendancePct: z.number().int(),
  feeStatus: z.enum(ACAD_FEE_STATUSES),
  feeLabel: z.string(),
  feeTag: zAcadTag,
  enrollmentLabel: z.string(),
});
export type AcadStudentRow = z.output<typeof zAcadStudentRow>;

export const zAcadStudentQuery = z.object({
  q: z.string().trim().max(200).optional(),
  batchId: zId.optional(),
  fee: z.enum(ACAD_FEE_STATUSES).optional(),
  lowAttendance: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const zAcadStudentDetail = z.object({
  id: zId,
  userId: zId.nullable(),
  name: z.string(),
  admissionNo: z.string().nullable(),
  branchId: zId,
  branchName: z.string(),
  enrollmentId: zId.nullable(),
  enrollmentStatus: z.string().nullable(),
  batchId: zId.nullable(),
  batchCode: z.string().nullable(),
  courseName: z.string().nullable(),
  /** "DM-A · Digital Marketing · TVM-DM-2027-00142" */
  sub: z.string(),
  tag: z.string(),
  tagVariant: zAcadTag,
  kpis: z.object({
    attendancePct: z.number().int(),
    attendanceNote: z.string(),
    feeBalance: zPaise,
    feeNext: z.string(),
    publishedMarks: z.number().int(),
    pendingWork: z.number().int(),
    pendingNote: z.string(),
  }),
  facts: z.array(z.tuple([z.string(), z.string()])),
  fee: z.object({
    label: z.string(),
    tag: zAcadTag,
    rows: z.array(
      z.object({
        id: zId,
        name: z.string(),
        due: zDate,
        dueLabel: z.string(),
        amount: zPaise,
        paid: zPaise,
        balance: zPaise,
        status: z.string(),
        tag: zAcadTag,
        highlight: z.boolean(),
      }),
    ),
  }),
  attendance: z.array(z.object({ date: zDate, label: z.string(), topic: z.string(), status: z.enum(['P', 'A', 'L', 'E']), statusLabel: z.string(), tag: zAcadTag })),
  marks: z.array(z.object({ examId: zId, name: z.string(), when: z.string(), average: z.string(), score: z.number(), max: z.number() })),
  documents: z.array(z.string()),
  timeline: z.array(z.object({ at: zInstant, when: z.string(), text: z.string() })),
  card: z.object({ issuedAt: zInstant.nullable() }),
});
export type AcadStudentDetail = z.output<typeof zAcadStudentDetail>;

export const zAcadTransferOptions = z.object({
  enrollmentId: zId,
  from: z.object({ batchId: zId, code: z.string(), startDate: zDate, endDate: zDate, feeTotal: zPaise }),
  targets: z.array(
    z.object({
      batchId: zId,
      code: z.string(),
      label: z.string(),
      seatsLeft: z.number().int(),
      feeTotal: zPaise,
      disabled: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  defaultEffectiveDate: zDate,
});
export type AcadTransferOptions = z.output<typeof zAcadTransferOptions>;

export const zAcadImportRow = z.object({
  row: z.number().int(),
  name: z.string(),
  phone: z.string(),
  batchCode: z.string(),
  guardian: z.string(),
  admissionNo: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
});

export const zAcadImportPreview = z.object({
  headers: z.array(z.string()),
  missingColumns: z.array(z.string()),
  total: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  rows: z.array(zAcadImportRow),
  errors: z.array(z.object({ row: z.number().int(), field: z.string(), message: z.string(), value: z.string() })),
});
export type AcadImportPreview = z.output<typeof zAcadImportPreview>;

/** Columns accepted by the go-live student import (CSV header row). */
export const STUDENT_IMPORT_COLUMNS = ['name', 'phone', 'email', 'dob', 'batch', 'joined_on', 'admission_no', 'guardian_name', 'guardian_phone', 'guardian_email', 'relationship'] as const;
export const STUDENT_IMPORT_REQUIRED = ['name', 'phone', 'batch', 'guardian_name', 'guardian_phone'] as const;

export const academicsStudentsContract = {
  list: route({
    method: 'GET',
    path: '/api/academics/students',
    query: zAcadStudentQuery,
    response: zPage(zAcadStudentRow).extend({ total: z.number().int(), activeTotal: z.number().int(), branchLabel: z.string(), batches: z.array(z.object({ id: zId, code: z.string() })) }),
  }),
  get: route({ method: 'GET', path: '/api/academics/students/:id', response: zAcadStudentDetail }),
  transferOptions: route({ method: 'GET', path: '/api/academics/students/:id/transfer-options', response: zAcadTransferOptions }),
  transfer: route({
    method: 'POST',
    path: '/api/academics/students/:id/transfer',
    body: z.object({ toBatchId: zId, effectiveDate: zDate, reason: z.string().trim().min(3, 'Give a reason — it is logged') }),
    response: z.object({ toEnrollmentId: zId, adjustment: zPaise }),
  }),
  reissueCard: route({ method: 'POST', path: '/api/academics/students/:id/reissue-card', response: zOk }),
  importPreview: route({ method: 'POST', path: '/api/academics/students/import/preview', body: z.object({ fileId: zId }), response: zAcadImportPreview }),
  importCommit: route({
    method: 'POST',
    path: '/api/academics/students/import',
    body: z.object({ fileId: zId }),
    response: z.object({ created: z.number().int(), skipped: z.number().int() }),
  }),
  /** PDF: one student's card (also DOCUMENT_PATHS.idCard) and a sheet for a batch (?batchId=). */
  idCardPath: (studentId: string) => `/api/documents/id-cards/${studentId}.pdf`,
  idCardSheetPath: '/api/documents/id-cards.pdf',
};

/* ───────────────────────── Notes & material ───────────────────────── */

export const ACAD_MATERIAL_TYPES = ['PDF', 'Slides', 'Video', 'XLSX', 'ZIP', 'Link'] as const;
export const ACAD_MATERIAL_VISIBILITIES = ['always', 'fee_gated', 'scheduled'] as const;

export const zAcadMaterialRow = z.object({
  id: zId,
  batchId: zId,
  batchCode: z.string(),
  module: z.string(),
  title: z.string(),
  type: z.enum(ACAD_MATERIAL_TYPES),
  visibility: z.enum(ACAD_MATERIAL_VISIBILITIES),
  visibilityLabel: z.string(),
  visibilityTag: zAcadTag,
  releaseOn: zDate.nullable(),
  uploadedBy: z.string(),
  opened: z.string(),
  meta: z.string().nullable(),
  previewable: z.boolean(),
});
export type AcadMaterialRow = z.output<typeof zAcadMaterialRow>;

export const academicsMaterialsContract = {
  list: route({
    method: 'GET',
    path: '/api/academics/materials',
    response: z.object({
      branchLabel: z.string(),
      kpis: z.object({ items: z.number().int(), feeGated: z.number().int(), lockedOut: z.number().int(), downloadsToday: z.number().int() }),
      items: z.array(zAcadMaterialRow),
      batches: z.array(z.object({ id: zId, code: z.string() })),
      rules: z.object({
        defaultPolicy: z.string(),
        courses: z.array(z.object({ code: z.string(), name: z.string(), policy: z.string() })),
      }),
      canUpload: z.boolean(),
    }),
  }),
  preview: route({ method: 'GET', path: '/api/academics/materials/:id/preview', response: z.object({ url: z.string(), expiresAt: zInstant }) }),
  visibility: route({
    method: 'POST',
    path: '/api/academics/materials/:id/visibility',
    body: z.object({ visibility: z.enum(ACAD_MATERIAL_VISIBILITIES), releaseOn: zDate.nullable().optional() }),
    response: zOk,
  }),
  upload: route({
    method: 'POST',
    path: '/api/academics/materials',
    body: z.object({
      batchId: zId,
      type: z.enum(ACAD_MATERIAL_TYPES),
      module: z.string().trim().min(2, 'Enter the module or topic'),
      title: z.string().trim().min(3, 'Enter a title'),
      visibility: z.enum(ACAD_MATERIAL_VISIBILITIES),
      releaseOn: zDate.nullable().optional(),
      fileId: zId.nullable().optional(),
      url: z.string().trim().url('Enter a valid link').nullable().optional(),
    }),
    response: z.object({ id: zId }),
  }),
};

/* ───────────────────────── Marks publishing ───────────────────────── */

export const zAcadExamRow = z.object({
  id: zId,
  name: z.string(),
  batchId: zId,
  batchCode: z.string(),
  teacherName: z.string(),
  date: zDate,
  submittedLabel: z.string(),
  students: z.number().int(),
  average: z.string(),
  status: z.enum(['draft', 'submitted', 'published', 'returned']),
  statusLabel: z.string(),
  tag: zAcadTag,
});
export type AcadExamRow = z.output<typeof zAcadExamRow>;

export const zAcadExamDetail = zAcadExamRow.extend({
  components: z.array(z.object({ id: zId, name: z.string(), max: z.number() })),
  maxTotal: z.number(),
  stats: z.object({ average: z.number().nullable(), highest: z.number().nullable(), lowest: z.number().nullable(), missing: z.number().int(), count: z.number().int() }),
  rows: z.array(
    z.object({
      enrollmentId: zId,
      studentId: zId,
      name: z.string(),
      admissionNo: z.string().nullable(),
      values: z.array(z.number().nullable()),
      total: z.number().nullable(),
      pct: z.number(),
    }),
  ),
  returnNote: z.string().nullable(),
  canPublish: z.boolean(),
});
export type AcadExamDetail = z.output<typeof zAcadExamDetail>;

export const academicsMarksContract = {
  list: route({ method: 'GET', path: '/api/academics/exams', response: z.object({ items: z.array(zAcadExamRow), canPublish: z.boolean() }) }),
  get: route({ method: 'GET', path: '/api/academics/exams/:id', response: zAcadExamDetail }),
  publish: route({ method: 'POST', path: '/api/academics/exams/:id/publish', response: zOk }),
  returnExam: route({
    method: 'POST',
    path: '/api/academics/exams/:id/return',
    body: z.object({ note: z.string().trim().min(3, 'Tell the teacher what to fix') }),
    response: zOk,
  }),
};
