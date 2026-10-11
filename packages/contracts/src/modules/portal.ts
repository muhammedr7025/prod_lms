import { z } from 'zod';
import { route, zDate, zId, zInstant, zInstantNullable, zPaise } from '../route';
import { zTagVariant } from './finance';

/**
 * Student & Parent portals (Portal module — a backend-for-frontend over the
 * other contexts). Every endpoint resolves scope through
 * `ScopeService.portalEnrollment(studentId?)`: a student sees their own
 * enrollment; a parent passes `?studentId=` for a linked child. Labels and tag
 * variants are computed on the server so the mobile screens stay thin.
 *
 * Payments go through `paymentsContract` (Finance); announcements through
 * `commsContract.feed/read/ack` (Comms); QR check-in through `checkinContract`
 * (Teaching).
 */

export const zStudentQuery = z.object({ studentId: zId.optional() });

export const zFeeState = z.enum(['overdue', 'due', 'cleared']);
export type FeeState = z.output<typeof zFeeState>;

/** A linked child (parent) or the student themself — the child switcher. */
export const zPortalChild = z.object({
  studentId: zId,
  enrollmentId: zId,
  name: z.string(),
  firstName: z.string(),
  initials: z.string(),
  admissionNo: z.string().nullable(),
  batchCode: z.string(),
  /** "FS-B · Full Stack Development · Trivandrum" */
  batchLong: z.string(),
  feeState: zFeeState,
  /** Next-due amount when overdue / due soon, else 0. */
  dueAmount: zPaise,
});

/** What the pay sheet needs (amounts are recomputed by the server when the order is created). */
export const zPayInfo = z.object({
  studentId: zId,
  studentName: z.string(),
  firstName: z.string(),
  /** "Instalment 2" */
  instalmentLabel: z.string(),
  /** "Instalment 2 · ₹15,000" */
  title: z.string(),
  /** "due 10 Oct · 1 day overdue" */
  dueLine: z.string(),
  overdue: z.boolean(),
  nextDue: zPaise,
  full: zPaise,
  minPartial: zPaise,
  gateway: z.enum(['razorpay', 'sandbox']),
  /** "Razorpay" or "Sandbox gateway" (dev, no keys configured). */
  gatewayLabel: z.string(),
});
export type PayInfo = z.output<typeof zPayInfo>;

/** Child switcher row + its pay-sheet data when something is due ("Pay for both children"). */
export const zPortalChildRow = zPortalChild.extend({ pay: zPayInfo.nullable() });
export type PortalChild = z.output<typeof zPortalChildRow>;

export const zFeeCard = z.object({
  state: zFeeState,
  /** "₹15,000 overdue" / "₹15,000 due 15 Oct" / "All fees cleared" */
  headline: z.string(),
  /** "Instalment 2 was due 10 Oct · late fee after 3 days" / "Next due 1 Dec · ₹21,600" */
  sub: z.string(),
  amount: zPaise,
});
export type FeeCard = z.output<typeof zFeeCard>;

/* ───────────────────────── Home ───────────────────────── */

export const zPortalHome = z.object({
  student: z.object({
    studentId: zId,
    enrollmentId: zId,
    name: z.string(),
    firstName: z.string(),
    admissionNo: z.string().nullable(),
    batchCode: z.string(),
    courseName: z.string(),
    /** "DM-A · Digital Marketing · TVM-DM-2027-00142" */
    kicker: z.string(),
    /** "DM-A · Digital Marketing · Trivandrum" */
    batchLong: z.string(),
  }),
  fee: zFeeCard,
  pay: zPayInfo.nullable(),
  attendance: z.object({
    pct: z.number().int(),
    attended: z.number().int(),
    total: z.number().int(),
    threshold: z.number().int(),
    low: z.boolean(),
    /** "46 of 50 sessions · threshold 75%" */
    line: z.string(),
    /** Parent tile: "below 75% threshold" / "46 of 50 sessions" */
    note: z.string(),
    /** "Next: Tue 13 Oct 09:00 · Room 1 · Analytics setup" */
    next: z.string().nullable(),
  }),
  pendingWork: z.object({ count: z.number().int(), note: z.string() }),
  upcomingExam: z.object({ date: zDate, day: z.string(), label: z.string() }).nullable(),
  latestMarks: z.object({ score: z.string(), label: z.string() }).nullable(),
  /** Parent "Today" card. */
  today: z.object({ title: z.string(), sub: z.string(), tone: z.enum(['present', 'absent', 'pending', 'none']) }),
  /** Parent: who "Message class teacher" reaches, and when. */
  contact: z.object({ teacherNames: z.array(z.string()), staffHours: z.string() }),
});
export type PortalHome = z.output<typeof zPortalHome>;

/* ───────────────────────── Timetable ───────────────────────── */

export const zTimetableItem = z.object({
  id: z.string(),
  kind: z.enum(['class', 'exam', 'holiday']),
  title: z.string(),
  sub: z.string(),
  tag: z.string(),
  tagVariant: zTagVariant,
});

export const zTimetableDay = z.object({
  date: zDate,
  /** "Mon 13 Oct" */
  label: z.string(),
  today: z.boolean(),
  past: z.boolean(),
  items: z.array(zTimetableItem),
});

export const zPortalTimetable = z.object({
  /** "Week 42 · 12–18 Oct" */
  kicker: z.string(),
  monday: zDate,
  prev: zDate,
  next: zDate,
  isCurrent: z.boolean(),
  days: z.array(zTimetableDay),
});
export type PortalTimetable = z.output<typeof zPortalTimetable>;

/* ───────────────────────── Notes ───────────────────────── */

export const zNoteItem = z.object({
  id: zId,
  title: z.string(),
  type: z.enum(['PDF', 'Slides', 'Video', 'XLSX', 'ZIP', 'Link']),
  /** "PDF · 12 pages" */
  meta: z.string(),
  status: z.enum(['open', 'locked', 'scheduled']),
  /** "Open" / "Locked · Pay now" / "Scheduled · 24 Oct" */
  label: z.string(),
  tagVariant: zTagVariant,
});
export type NoteItem = z.output<typeof zNoteItem>;

export const zPortalNotes = z.object({
  /** "DM-A · 2 of 5 available" */
  kicker: z.string(),
  available: z.number().int(),
  total: z.number().int(),
  /** Shown when fee-gated items are locked: "Fee-gated items unlock when instalment 2 is paid." */
  lockedBanner: z.object({ text: z.string(), payLabel: z.string() }).nullable(),
  pay: zPayInfo.nullable(),
  groups: z.array(z.object({ module: z.string(), items: z.array(zNoteItem) })),
});
export type PortalNotes = z.output<typeof zPortalNotes>;

export const zNoteOpen = z.object({
  kind: z.enum(['file', 'link']),
  /** 5-minute signed URL (watermarked copy for PDFs) or the video/link URL. */
  url: z.string(),
  expiresAt: zInstantNullable,
  watermarked: z.boolean(),
});

/* ───────────────────────── Work ───────────────────────── */

export const zWorkItem = z.object({
  id: zId,
  batchCode: z.string(),
  title: z.string(),
  instructions: z.string().nullable(),
  /** "Due Fri 23 Oct" / "Was due Tue 13 Oct · 2 days late" */
  dueLabel: z.string(),
  max: z.number().int(),
  status: z.enum(['pending', 'submitted', 'graded', 'late', 'closed']),
  /** "Pending · due Fri 23 Oct" / "Submitted · awaiting grade" / "Graded · 42 / 50" / "Late · −10%/day" / "Closed" */
  statusLabel: z.string(),
  tagVariant: zTagVariant,
  canSubmit: z.boolean(),
  /** Why submit is not possible (shown next to the card). */
  blockedReason: z.string().nullable(),
  submission: z
    .object({
      submittedAt: zInstant,
      /** "Submitted Sun 11 Oct 18:00 · 1 day late" */
      line: z.string(),
      fileName: z.string().nullable(),
      text: z.string().nullable(),
      feedback: z.string().nullable(),
    })
    .nullable(),
});
export type WorkItem = z.output<typeof zWorkItem>;

export const zPortalWork = z.object({
  kicker: z.string(),
  items: z.array(zWorkItem),
  /** "Late submissions lose 10% per day · feedback appears here when graded" */
  footer: z.string(),
});

export const zWorkSubmitInput = z
  .object({
    text: z.string().trim().max(4000, 'Keep the note under 4,000 characters').optional(),
    fileId: zId.optional(),
  })
  .refine((v) => !!v.fileId || !!v.text, { message: 'Attach a file or write your answer', path: ['text'] });

/* ───────────────────────── Marks ───────────────────────── */

export const zMarkItem = z.object({
  examId: zId,
  /** "Thu 8 Oct" */
  when: z.string(),
  name: z.string(),
  score: z.number(),
  max: z.number(),
  pct: z.number().int(),
  grade: z.string(),
  /** "Batch average 71.5 · A" */
  meta: z.string(),
  components: z.array(z.object({ name: z.string(), score: z.number().nullable(), max: z.number() })),
});
export type MarkItem = z.output<typeof zMarkItem>;

export const zPortalMarks = z.object({
  kicker: z.string(),
  items: z.array(zMarkItem),
  /** Oldest → newest, last 6 published exams. */
  trend: z.array(z.object({ label: z.string(), pct: z.number().int() })),
  /** Next scheduled exam (dashed slot in the trend card). */
  nextExam: z.string().nullable(),
  reportCardUrl: z.string().nullable(),
  note: z.string(),
});
export type PortalMarks = z.output<typeof zPortalMarks>;

/* ───────────────────────── Fees ───────────────────────── */

export const zFeeInstalmentRow = z.object({
  id: zId,
  /** "Instalment 1 · 50% at admission" */
  name: z.string(),
  /** "Due 1 Aug · paid 1 Aug · UPI" */
  sub: z.string(),
  amount: zPaise,
  tag: z.string(),
  tagVariant: zTagVariant,
  /** The row the next payment goes to. */
  highlight: z.boolean(),
});

export const zFeeDocument = z.object({
  id: zId,
  kind: z.enum(['invoice', 'receipt', 'credit_note']),
  number: z.string(),
  /** "Invoice · 10 Aug · ₹24,000" */
  sub: z.string(),
  pdfUrl: z.string(),
  printUrl: z.string(),
});

export const zPortalFees = z.object({
  studentId: zId,
  enrollmentId: zId,
  studentName: z.string(),
  /** "Split 50 / 50 · ₹48,000 incl. GST" */
  kicker: z.string(),
  fee: zFeeCard,
  outstanding: zPaise,
  statementUrl: z.string(),
  instalments: z.array(zFeeInstalmentRow),
  pay: zPayInfo.nullable(),
  documents: z.array(zFeeDocument),
});
export type PortalFees = z.output<typeof zPortalFees>;

/* ───────────────────────── Parent: attendance, alerts, messages ───────────────────────── */

export const zPortalAttendance = z.object({
  /** "Rohan Menon · FS-B" */
  kicker: z.string(),
  pct: z.number().int(),
  threshold: z.number().int(),
  low: z.boolean(),
  history: z.array(
    z.object({
      id: zId,
      date: zDate,
      /** "Fri 9 Oct · 09:00" */
      dateLabel: z.string(),
      topic: z.string(),
      status: z.enum(['P', 'A', 'L', 'E']),
      label: z.string(),
      tagVariant: zTagVariant,
    }),
  ),
  footer: z.string(),
});
export type PortalAttendance = z.output<typeof zPortalAttendance>;

export const zPortalAlert = z.object({
  id: zId,
  /** "Absence" / "Fee overdue" / "Fee due" / "Payment" / "Marks" / "Attendance" / "Announcement" */
  kind: z.string(),
  tagVariant: zTagVariant,
  /** Ink border for absence & overdue. */
  attention: z.boolean(),
  /** "2 h" / "Yesterday" */
  when: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
});

export const zPortalAlerts = z.object({
  /** "Both children" / "Anjali & Rohan" */
  kicker: z.string(),
  items: z.array(zPortalAlert),
  channels: z.array(z.object({ label: z.string(), value: z.string(), tagVariant: zTagVariant })),
});
export type PortalAlerts = z.output<typeof zPortalAlerts>;

export const PTM_PARTS = ['morning', 'afternoon', 'evening'] as const;
export const PTM_PART_LABEL: Record<(typeof PTM_PARTS)[number], string> = { morning: 'Morning (9–12)', afternoon: 'Afternoon (12–4)', evening: 'Evening (4–6)' };

export const zParentMessageInput = z.object({
  studentId: zId,
  body: z.string().trim().min(10, 'Write at least a sentence (10 characters)').max(1000, 'Keep it under 1,000 characters'),
});

export const zPtmInput = z.object({
  studentId: zId,
  date: zDate,
  part: z.enum(PTM_PARTS),
  note: z.string().trim().max(500, 'Keep the note under 500 characters').optional(),
});

/* ───────────────────────── Routes ───────────────────────── */

/** Non-JSON portal downloads. */
export const PORTAL_PATHS = {
  /** text/calendar · next 8 weeks · `?studentId=` for a parent's child. */
  timetableIcs: '/api/portal/timetable.ics',
} as const;

export const portalContract = {
  children: route({ method: 'GET', path: '/api/portal/children', response: z.object({ items: z.array(zPortalChildRow) }) }),
  home: route({ method: 'GET', path: '/api/portal/home', query: zStudentQuery, response: zPortalHome }),
  timetable: route({ method: 'GET', path: '/api/portal/timetable', query: zStudentQuery.extend({ week: zDate.optional() }), response: zPortalTimetable }),
  notes: route({ method: 'GET', path: '/api/portal/notes', query: zStudentQuery, response: zPortalNotes }),
  /** Re-checks canAccessMaterial, logs material_access, returns a 5-minute signed URL (watermarked PDF). */
  openNote: route({ method: 'POST', path: '/api/portal/notes/:id/open', response: zNoteOpen }),
  work: route({ method: 'GET', path: '/api/portal/work', response: zPortalWork }),
  submitWork: route({ method: 'POST', path: '/api/portal/work/:id/submit', body: zWorkSubmitInput, response: zWorkItem }),
  marks: route({ method: 'GET', path: '/api/portal/marks', query: zStudentQuery, response: zPortalMarks }),
  fees: route({ method: 'GET', path: '/api/portal/fees', query: zStudentQuery, response: zPortalFees }),
  attendance: route({ method: 'GET', path: '/api/portal/attendance', query: zStudentQuery, response: zPortalAttendance }),
  alerts: route({ method: 'GET', path: '/api/portal/alerts', response: zPortalAlerts }),
  messageTeacher: route({
    method: 'POST',
    path: '/api/portal/messages',
    body: zParentMessageInput,
    response: z.object({ id: zId, status: z.literal('pending'), note: z.string() }),
  }),
  requestPtm: route({
    method: 'POST',
    path: '/api/portal/ptm',
    body: zPtmInput,
    response: z.object({ id: zId, slotLabel: z.string(), note: z.string() }),
  }),
};
