import { boolean, date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_helpers';

export const attendance = pgTable(
  'attendance',
  {
    id: pk(),
    sessionId: uuid().notNull(),
    enrollmentId: uuid().notNull(),
    status: text({ enum: ['P', 'A', 'L', 'E'] }).notNull(),
    source: text({ enum: ['teacher', 'qr', 'override'] }).default('teacher').notNull(),
    markedBy: uuid(),
    markedAt: tsz().defaultNow().notNull(),
    overrideReason: text(),
  },
  (t) => [uniqueIndex().on(t.sessionId, t.enrollmentId), index().on(t.enrollmentId)],
);

export const exam = pgTable(
  'exam',
  {
    id: pk(),
    batchId: uuid().notNull(),
    branchId: uuid().notNull(),
    teacherUserId: uuid().notNull(),
    name: text().notNull(),
    date: date().notNull(),
    startTime: text(),
    room: text(),
    status: text({ enum: ['draft', 'submitted', 'published', 'returned'] }).default('draft').notNull(),
    submittedAt: tsz(),
    publishedAt: tsz(),
    publishedBy: uuid(),
    returnNote: text(),
    returnedAt: tsz(),
    returnedBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.batchId, t.name), index().on(t.branchId, t.status)],
);

export const examComponent = pgTable(
  'exam_component',
  {
    id: pk(),
    examId: uuid()
      .notNull()
      .references(() => exam.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    name: text().notNull(),
    maxMarks: numeric({ mode: 'number' }).notNull(),
  },
  (t) => [index().on(t.examId)],
);

export const mark = pgTable(
  'mark',
  {
    id: pk(),
    examId: uuid().notNull(),
    examComponentId: uuid().notNull(),
    enrollmentId: uuid().notNull(),
    value: numeric({ mode: 'number' }),
    updatedBy: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.examComponentId, t.enrollmentId), index().on(t.examId)],
);

export const assignment = pgTable(
  'assignment',
  {
    id: pk(),
    batchId: uuid().notNull(),
    branchId: uuid().notNull(),
    teacherUserId: uuid().notNull(),
    title: text().notNull(),
    instructions: text(),
    dueAt: tsz().notNull(),
    maxMarks: integer().notNull(),
    latePolicy: text({ enum: ['minus_10_per_day', 'minus_5_per_day', 'not_accepted', 'no_penalty'] }).default('minus_10_per_day').notNull(),
    rubric: text(),
    status: text({ enum: ['open', 'closed'] }).default('open').notNull(),
    extendedAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.batchId)],
);

export const submission = pgTable(
  'submission',
  {
    id: pk(),
    assignmentId: uuid().notNull(),
    enrollmentId: uuid().notNull(),
    submittedAt: tsz().defaultNow().notNull(),
    text: text(),
    fileId: uuid(),
    isLate: boolean().default(false).notNull(),
    lateDays: integer().default(0).notNull(),
    marks: numeric({ mode: 'number' }),
    /** After late penalty. */
    finalMarks: numeric({ mode: 'number' }),
    feedback: text(),
    gradedAt: tsz(),
    gradedBy: uuid(),
    released: boolean().default(false).notNull(),
  },
  (t) => [uniqueIndex().on(t.assignmentId, t.enrollmentId)],
);

export const material = pgTable(
  'material',
  {
    id: pk(),
    batchId: uuid().notNull(),
    branchId: uuid().notNull(),
    module: text().notNull(),
    title: text().notNull(),
    type: text({ enum: ['PDF', 'Slides', 'Video', 'XLSX', 'ZIP', 'Link'] }).notNull(),
    visibility: text({ enum: ['always', 'fee_gated', 'scheduled'] }).notNull(),
    releaseAt: tsz(),
    fileId: uuid(),
    url: text(),
    meta: text(),
    uploadedBy: uuid().notNull(),
    removedAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.batchId), index().on(t.branchId)],
);

export const materialAccess = pgTable(
  'material_access',
  {
    id: pk(),
    materialId: uuid().notNull(),
    userId: uuid().notNull(),
    enrollmentId: uuid(),
    at: tsz().defaultNow().notNull(),
  },
  (t) => [index().on(t.materialId), index().on(t.at)],
);
