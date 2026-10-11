import { z } from 'zod';
import { route, zDate, zId, zInstant, zOk, zTime } from '../route';

/**
 * Teaching (teacher's mobile-first workspace): Today, attendance (incl. ad-hoc
 * cover and QR self check-in), leave requests, assignments & grading, notes &
 * material, exams & marks entry. Every list is scoped on the server to the
 * signed-in teacher's assignments; ad-hoc cover may target any batch in the
 * teacher's membership branches.
 */

export const zTeachTag = z.enum(['accent', 'neutral', 'outline', 'ink', 'solid', 'plain']);
export type TeachTag = z.output<typeof zTeachTag>;

export const TEACH_ATT_STATUSES = ['P', 'A', 'L', 'E'] as const;
export const zTeachAttStatus = z.enum(TEACH_ATT_STATUSES);

export const TEACH_ADHOC_TYPES = ['substitute', 'extra', 'doubt_clearing', 'guest'] as const;
export const TEACH_ADHOC_LABEL: Record<(typeof TEACH_ADHOC_TYPES)[number], string> = {
  substitute: 'Substitute',
  extra: 'Extra class',
  doubt_clearing: 'Doubt-clearing',
  guest: 'Guest session',
};

export const TEACH_LEAVE_TYPES = ['casual', 'sick', 'earned', 'on_duty'] as const;
export const TEACH_LEAVE_LABEL: Record<(typeof TEACH_LEAVE_TYPES)[number], string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', on_duty: 'On duty' };

export const TEACH_LATE_POLICIES = ['minus_10_per_day', 'minus_5_per_day', 'not_accepted', 'no_penalty'] as const;
export const TEACH_MATERIAL_TYPES = ['PDF', 'Slides', 'Video', 'XLSX', 'ZIP', 'Link'] as const;
export const TEACH_VISIBILITIES = ['always', 'fee_gated', 'scheduled'] as const;

/** Subject-taught extras offered next to the course's syllabus subjects. */
export const TEACH_SUBJECT_EXTRAS = ['Doubt-clearing', 'Revision', 'Guest lecture'] as const;

/** One of the teacher's batches (dialogs and segmented filters). */
export const zTeachBatch = z.object({ id: zId, code: z.string(), label: z.string(), subjectName: z.string(), students: z.number().int() });
export type TeachBatch = z.output<typeof zTeachBatch>;

/* ───────────────────────── Today ───────────────────────── */

export const zTeachTodaySession = z.object({
  id: zId,
  batchId: zId,
  batchCode: z.string(),
  kind: z.enum(['timetabled', 'adhoc']),
  /** "09:00–11:00 · Room 1 · Search · SEO & analytics" or "11:30 · ad-hoc · substitute" */
  kicker: z.string(),
  /** "DM-A · Keyword research" */
  title: z.string(),
  tag: z.string(),
  tagVariant: zTeachTag,
  marked: z.number().int(),
  roster: z.number().int(),
  submitted: z.boolean(),
  /** The next unmarked session — gets the primary "Mark attendance" button. */
  primary: z.boolean(),
  /** "11 students · Meet link attached for hybrid learners" */
  rosterLine: z.string(),
  adhocPending: z.boolean(),
});
export type TeachTodaySession = z.output<typeof zTeachTodaySession>;

export const zTeachLeaveRow = z.object({
  id: zId,
  date: zDate,
  /** "Fri 17 Oct · Casual" */
  title: z.string(),
  /** "Personal · DM-A 09:00 needs a substitute" */
  sub: z.string(),
  statusLabel: z.string(),
  tag: zTeachTag,
});
export type TeachLeaveRow = z.output<typeof zTeachLeaveRow>;

export const zTeachToday = z.object({
  /** "Sunday 11 Oct" (IST) */
  dateLabel: z.string(),
  /** "Good evening, Nithin" */
  greeting: z.string(),
  sessions: z.array(zTeachTodaySession),
  adhoc: z.array(zTeachTodaySession),
  /** "No sessions today · next: Mon 13 Oct 09:00 DM-A" when there are none. */
  emptyNote: z.string().nullable(),
  toGrade: z.number().int(),
  marksMissing: z.number().int(),
  /** "in Module 2 · Search" */
  marksMissingNote: z.string(),
  leaves: z.array(zTeachLeaveRow),
  canRequestLeave: z.boolean(),
});
export type TeachToday = z.output<typeof zTeachToday>;

export const teachingTodayContract = {
  today: route({ method: 'GET', path: '/api/teaching/today', response: zTeachToday }),
};

/* ───────────────────────── Attendance ───────────────────────── */

export const zTeachSessionOption = z.object({ id: zId, label: z.string() });

export const zTeachRosterRow = z.object({
  enrollmentId: zId,
  studentId: zId,
  name: z.string(),
  admissionNo: z.string().nullable(),
  status: zTeachAttStatus.nullable(),
  source: z.enum(['teacher', 'qr', 'override']).nullable(),
  /** A same-day absence alert has gone to the parents. */
  alerted: z.boolean(),
});
export type TeachRosterRow = z.output<typeof zTeachRosterRow>;

export const zTeachAttCounts = z.object({ P: z.number().int(), A: z.number().int(), L: z.number().int(), E: z.number().int() });
export type TeachAttCounts = z.output<typeof zTeachAttCounts>;

export const zTeachAttendanceSession = z.object({
  sessionId: zId,
  batchId: zId,
  batchCode: z.string(),
  /** "DM-B · Tue 14 Oct · 16:30" */
  kicker: z.string(),
  date: zDate,
  startTime: zTime,
  kind: z.enum(['timetabled', 'adhoc']),
  /** Ad-hoc session not yet acknowledged by the Branch Admin (does not count yet). */
  adhocPending: z.boolean(),
  submitted: z.boolean(),
  /** "Submitted 16:42" */
  submittedLabel: z.string().nullable(),
  /** "Saved 16:41" / "Not started" */
  savedLabel: z.string(),
  canEdit: z.boolean(),
  /** Why the roster is read-only (shown verbatim). */
  lockedReason: z.string().nullable(),
  /** Hours after submission the teacher may still edit. */
  editWindowHours: z.number().int(),
  assignedSubject: z.string(),
  subjectTaught: z.string(),
  subjectOptions: z.array(z.string()),
  roster: z.array(zTeachRosterRow),
  counts: zTeachAttCounts,
});
export type TeachAttendanceSession = z.output<typeof zTeachAttendanceSession>;

export const zTeachAttendance = z.object({
  /** My sessions today and in the last 48 h (newest first). */
  options: z.array(zTeachSessionOption),
  session: zTeachAttendanceSession.nullable(),
});

export const zTeachMarkInput = z.object({ enrollmentId: zId, status: zTeachAttStatus });

export const zTeachQr = z.object({
  /** Short human code, e.g. "EXA-4F7K-2Q". */
  code: z.string(),
  expiresAt: zInstant,
  rotateSeconds: z.number().int(),
  presentSoFar: z.number().int(),
  roster: z.number().int(),
  /** QR (bwip-js SVG markup) encoding the code. */
  svg: z.string(),
});

export const teachingAttendanceContract = {
  /** Session to mark (default: the next unmarked session today) + the picker options. */
  get: route({
    method: 'GET',
    path: '/api/teaching/attendance',
    query: z.object({ session: zId.optional() }),
    response: zTeachAttendance,
  }),
  /** Idempotent upsert keyed by session + enrollment (taps, Mark all present, offline sync). */
  mark: route({
    method: 'PUT',
    path: '/api/teaching/sessions/:id/attendance',
    body: z.object({ marks: z.array(zTeachMarkInput).min(1).max(500) }),
    response: z.object({ savedAt: zInstant, counts: zTeachAttCounts }),
  }),
  subject: route({
    method: 'POST',
    path: '/api/teaching/sessions/:id/subject',
    body: z.object({ subject: z.string().trim().min(1).max(120) }),
    response: zOk,
  }),
  submit: route({
    method: 'POST',
    path: '/api/teaching/sessions/:id/submit',
    response: z.object({ present: z.number().int(), absent: z.number().int(), alerted: z.number().int() }),
  }),
  qr: route({ method: 'GET', path: '/api/teaching/sessions/:id/qr', response: zTeachQr }),
};

/* ───────────────────────── Cover another class (ad-hoc) ───────────────────────── */

export const zTeachCoverOptions = z.object({
  batches: z.array(z.object({ id: zId, code: z.string(), label: z.string(), regularTeacher: z.string().nullable() })),
  types: z.array(z.object({ value: z.enum(TEACH_ADHOC_TYPES), label: z.string() })),
  slots: z.array(z.object({ value: zTime, label: z.string() })),
});

export const teachingCoverContract = {
  options: route({ method: 'GET', path: '/api/teaching/cover/options', response: zTeachCoverOptions }),
  start: route({
    method: 'POST',
    path: '/api/teaching/cover',
    body: z.object({
      batchId: zId,
      type: z.enum(TEACH_ADHOC_TYPES),
      start: zTime,
      reason: z.string().trim().min(3, 'Give a reason (it is logged)').max(200),
    }),
    response: z.object({ sessionId: zId }),
  }),
};

/* ───────────────────────── Leave ───────────────────────── */

export const teachingLeaveContract = {
  impact: route({
    method: 'GET',
    path: '/api/teaching/leave/impact',
    query: z.object({ date: zDate }),
    response: z.object({ label: z.string(), sessions: z.number().int(), existing: z.string().nullable() }),
  }),
  request: route({
    method: 'POST',
    path: '/api/teaching/leave',
    body: z.object({ date: zDate, type: z.enum(TEACH_LEAVE_TYPES), reason: z.string().trim().min(2, 'Give a reason').max(200) }),
    response: z.object({ id: zId }),
  }),
};

/* ───────────────────────── Assignments ───────────────────────── */

export const zTeachAssignmentCard = z.object({
  id: zId,
  batchId: zId,
  batchCode: z.string(),
  title: z.string(),
  /** "Mon 13 Oct" (+ " 18:00" when not end of day) */
  dueLabel: z.string(),
  dueAt: zInstant,
  max: z.number().int(),
  tag: z.enum(['Open', 'Due today', 'Closed', 'Graded']),
  tagVariant: zTeachTag,
  submitted: z.number().int(),
  total: z.number().int(),
  graded: z.number().int(),
  toGrade: z.number().int(),
  notSubmitted: z.number().int(),
  pct: z.number(),
  /** "22 / 28 submitted · 16 graded · −10% per day late" */
  meta: z.string(),
});
export type TeachAssignmentCard = z.output<typeof zTeachAssignmentCard>;

export const zTeachGradeRow = z.object({
  submissionId: zId,
  name: z.string(),
  admissionNo: z.string().nullable(),
  lateDays: z.number().int(),
  /** "on time" | "late 2 days" */
  lateLabel: z.string(),
  submittedLabel: z.string(),
  hasFile: z.boolean(),
  text: z.string().nullable(),
});

export const zTeachGrading = z.object({
  id: zId,
  title: z.string(),
  batchCode: z.string(),
  max: z.number().int(),
  latePolicy: z.enum(TEACH_LATE_POLICIES),
  latePolicyLabel: z.string(),
  rows: z.array(zTeachGradeRow),
});
export type TeachGrading = z.output<typeof zTeachGrading>;

export const teachingAssignmentsContract = {
  list: route({
    method: 'GET',
    path: '/api/teaching/assignments',
    query: z.object({ batchId: zId.optional() }),
    response: z.object({ toGrade: z.number().int(), batches: z.array(zTeachBatch), items: z.array(zTeachAssignmentCard) }),
  }),
  create: route({
    method: 'POST',
    path: '/api/teaching/assignments',
    body: z.object({
      batchId: zId,
      title: z.string().trim().min(3).max(140),
      dueDate: zDate,
      dueTime: zTime.default('23:59'),
      maxMarks: z.number().int().min(1).max(1000),
      latePolicy: z.enum(TEACH_LATE_POLICIES),
      instructions: z.string().trim().max(4000).optional(),
    }),
    response: z.object({ id: zId }),
  }),
  grading: route({ method: 'GET', path: '/api/teaching/assignments/:id/grading', response: zTeachGrading }),
  file: route({ method: 'GET', path: '/api/teaching/submissions/:id/file', response: z.object({ url: z.string(), expiresAt: zInstant }) }),
  grade: route({
    method: 'POST',
    path: '/api/teaching/assignments/:id/grades',
    body: z.object({ grades: z.array(z.object({ submissionId: zId, marks: z.number().min(0), feedback: z.string().trim().max(1000).optional() })).min(1).max(500) }),
    response: z.object({ released: z.number().int(), penalised: z.number().int() }),
  }),
  remind: route({ method: 'POST', path: '/api/teaching/assignments/:id/remind', response: z.object({ reminded: z.number().int() }) }),
  extend: route({
    method: 'POST',
    path: '/api/teaching/assignments/:id/extend',
    body: z.object({ dueDate: zDate, dueTime: zTime.default('23:59') }),
    response: zOk,
  }),
};

/* ───────────────────────── Notes & material ───────────────────────── */

export const zTeachMaterialRow = z.object({
  id: zId,
  type: z.enum(TEACH_MATERIAL_TYPES),
  title: z.string(),
  meta: z.string(),
  /** "22 / 28" or "—" */
  opened: z.string(),
  visibility: z.enum(TEACH_VISIBILITIES),
  visibilityLabel: z.string(),
  tag: zTeachTag,
  releaseOn: zDate.nullable(),
});
export type TeachMaterialRow = z.output<typeof zTeachMaterialRow>;

export const teachingMaterialsContract = {
  list: route({
    method: 'GET',
    path: '/api/teaching/materials',
    query: z.object({ batchId: zId.optional() }),
    response: z.object({
      batches: z.array(zTeachBatch),
      batchId: zId.nullable(),
      batchCode: z.string().nullable(),
      count: z.number().int(),
      groups: z.array(z.object({ module: z.string(), items: z.array(zTeachMaterialRow) })),
      /** Module names used so far in my batches (upload suggestions). */
      modules: z.array(z.string()),
    }),
  }),
  upload: route({
    method: 'POST',
    path: '/api/teaching/materials',
    body: z.object({
      batchId: zId,
      type: z.enum(TEACH_MATERIAL_TYPES),
      module: z.string().trim().min(1).max(120),
      title: z.string().trim().min(2).max(160),
      visibility: z.enum(TEACH_VISIBILITIES),
      releaseOn: zDate.nullable().optional(),
      fileId: zId.nullable().optional(),
      url: z.string().trim().url().max(500).nullable().optional(),
    }),
    response: z.object({ id: zId }),
  }),
  visibility: route({
    method: 'POST',
    path: '/api/teaching/materials/:id/visibility',
    body: z.object({ visibility: z.enum(TEACH_VISIBILITIES), releaseOn: zDate.nullable().optional() }),
    response: zOk,
  }),
  remove: route({ method: 'POST', path: '/api/teaching/materials/:id/remove', response: zOk }),
  restore: route({ method: 'POST', path: '/api/teaching/materials/:id/restore', response: zOk }),
};

/* ───────────────────────── Exams & marks ───────────────────────── */

export const TEACH_EXAM_STATUSES = ['draft', 'submitted', 'published', 'returned'] as const;

export const zTeachExamOption = z.object({
  id: zId,
  name: z.string(),
  batchId: zId,
  batchCode: z.string(),
  status: z.enum(TEACH_EXAM_STATUSES),
  /** "Module 2 · Search · DM-A · draft" */
  label: z.string(),
  date: zDate,
});
export type TeachExamOption = z.output<typeof zTeachExamOption>;

export const zTeachExamRow = z.object({ enrollmentId: zId, name: z.string(), admissionNo: z.string().nullable(), values: z.array(z.number().nullable()) });
export type TeachExamRow = z.output<typeof zTeachExamRow>;

export const zTeachExam = z.object({
  id: zId,
  name: z.string(),
  batchId: zId,
  batchCode: z.string(),
  /** "DM-A · Thu 16 Oct · 28 students" */
  kicker: z.string(),
  date: zDate,
  status: z.enum(TEACH_EXAM_STATUSES),
  statusLabel: z.string(),
  tag: zTeachTag,
  /** Draft or returned — cells can be edited. */
  editable: z.boolean(),
  components: z.array(z.object({ id: zId, name: z.string(), max: z.number() })),
  maxTotal: z.number(),
  rows: z.array(zTeachExamRow),
  returnNote: z.string().nullable(),
});
export type TeachExam = z.output<typeof zTeachExam>;

export const zTeachImportResult = z.object({
  rows: z.number().int(),
  matched: z.number().int(),
  cells: z.number().int(),
  overMax: z.number().int(),
  unknown: z.array(z.string()),
  missingColumns: z.array(z.string()),
  applied: z.boolean(),
});
export type TeachImportResult = z.output<typeof zTeachImportResult>;

export const teachingMarksContract = {
  exams: route({
    method: 'GET',
    path: '/api/teaching/exams',
    response: z.object({ items: z.array(zTeachExamOption), batches: z.array(zTeachBatch) }),
  }),
  exam: route({ method: 'GET', path: '/api/teaching/exams/:id', response: zTeachExam }),
  create: route({
    method: 'POST',
    path: '/api/teaching/exams',
    body: z.object({
      batchId: zId,
      date: zDate,
      name: z.string().trim().min(3).max(120),
      components: z.array(z.object({ name: z.string().trim().min(1).max(60), max: z.number().positive().max(1000) })).min(1).max(4),
    }),
    response: z.object({ id: zId }),
  }),
  save: route({
    method: 'PUT',
    path: '/api/teaching/exams/:id/marks',
    body: z.object({ cells: z.array(z.object({ enrollmentId: zId, componentId: zId, value: z.number().min(0).max(10_000).nullable() })).min(1).max(2000) }),
    response: z.object({ savedAt: zInstant }),
  }),
  fillZero: route({ method: 'POST', path: '/api/teaching/exams/:id/fill-zero', response: z.object({ filled: z.number().int() }) }),
  importCsv: route({
    method: 'POST',
    path: '/api/teaching/exams/:id/import',
    body: z.object({ csv: z.string().min(1).max(500_000), dryRun: z.boolean().default(true) }),
    response: zTeachImportResult,
  }),
  submit: route({ method: 'POST', path: '/api/teaching/exams/:id/submit', response: zOk }),
  recall: route({ method: 'POST', path: '/api/teaching/exams/:id/recall', response: zOk }),
};
