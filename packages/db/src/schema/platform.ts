import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz } from './_helpers';

/* ───────────────────────── Communications ───────────────────────── */

export interface AudienceTarget {
  type: 'institution' | 'branch' | 'course' | 'batch' | 'role' | 'segment';
  /** id of branch/course/batch, role key (students|parents|teachers|staff), or segment key (overdue_fees|low_attendance) */
  value: string;
  label: string;
}

export const announcement = pgTable(
  'announcement',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    branchId: uuid(),
    authorUserId: uuid().notNull(),
    authorRoleKey: text().notNull(),
    kicker: text(),
    title: text().notNull(),
    body: text().notNull(),
    audience: jsonb().$type<AudienceTarget[]>().notNull(),
    publishAt: tsz().defaultNow().notNull(),
    expiresAt: tsz(),
    pinned: boolean().default(false).notNull(),
    ackRequired: boolean().default(false).notNull(),
    alsoWhatsapp: boolean().default(false).notNull(),
    status: text({ enum: ['scheduled', 'published', 'expired', 'withdrawn'] }).default('published').notNull(),
    recipientCount: integer().default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.branchId, t.publishAt)],
);

export const announcementRecipient = pgTable(
  'announcement_recipient',
  {
    announcementId: uuid().notNull(),
    userId: uuid().notNull(),
    readAt: tsz(),
    ackedAt: tsz(),
  },
  (t) => [primaryKey({ columns: [t.announcementId, t.userId] }), index().on(t.userId)],
);

export const NOTIFICATION_CATEGORIES = [
  'payment',
  'fee_due',
  'admission',
  'marks',
  'exam_schedule',
  'attendance',
  'timetable',
  'material',
  'leave',
  'adhoc_session',
  'announcement',
  'lead',
  'assignment',
  'approval',
  'message',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const notification = pgTable(
  'notification',
  {
    id: pk(),
    userId: uuid().notNull(),
    category: text().$type<NotificationCategory>().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    link: text(),
    entityType: text(),
    entityId: uuid(),
    readAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

export const notificationPreference = pgTable(
  'notification_preference',
  {
    userId: uuid().notNull(),
    category: text().notNull(),
    channels: text().array().default([]).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

/** Every WhatsApp / email / SMS sent goes through here (delivery tracking + dev outbox). */
export const outboundMessage = pgTable(
  'outbound_message',
  {
    id: pk(),
    channel: text({ enum: ['whatsapp', 'email', 'sms'] }).notNull(),
    toAddress: text().notNull(),
    toUserId: uuid(),
    template: text(),
    subject: text(),
    body: text().notNull(),
    attachments: jsonb().$type<{ filename: string; fileId?: string; url?: string }[]>().default([]).notNull(),
    status: text({ enum: ['queued', 'sent', 'failed'] }).default('queued').notNull(),
    provider: text(),
    providerMessageId: text(),
    error: text(),
    attempts: integer().default(0).notNull(),
    createdAt: createdAt(),
    sentAt: tsz(),
  },
  (t) => [index().on(t.createdAt), index().on(t.toUserId)],
);

export const parentMessage = pgTable('parent_message', {
  id: pk(),
  guardianUserId: uuid().notNull(),
  studentId: uuid().notNull(),
  teacherUserId: uuid(),
  body: text().notNull(),
  status: text({ enum: ['pending', 'delivered', 'rejected'] }).default('pending').notNull(),
  moderatedBy: uuid(),
  reply: text(),
  createdAt: createdAt(),
});

export const ptmRequest = pgTable('ptm_request', {
  id: pk(),
  guardianUserId: uuid().notNull(),
  studentId: uuid().notNull(),
  preferredSlot: text().notNull(),
  note: text(),
  status: text({ enum: ['requested', 'confirmed', 'declined'] }).default('requested').notNull(),
  createdAt: createdAt(),
});

/* ───────────────────────── Platform ───────────────────────── */

/** Append-only (insert-only trigger). Retained 7 years. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    at: tsz().defaultNow().notNull(),
    actorUserId: uuid(),
    actorName: text().notNull(),
    roleKey: text(),
    roleLabel: text(),
    action: text().notNull(),
    /** create | update | approve | login | export | impersonate | delete | publish | payment | other */
    actionKind: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    entityLabel: text(),
    before: jsonb(),
    after: jsonb(),
    summary: text(),
    ip: text(),
    branchId: uuid(),
    requestId: text(),
  },
  (t) => [index().on(t.at), index().on(t.actorUserId), index().on(t.branchId, t.at), index().on(t.entityType, t.entityId)],
);

/** Transactional outbox: written in the same transaction as the change, relayed by the worker. */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: pk(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    occurredAt: tsz().defaultNow().notNull(),
    processedAt: tsz(),
    attempts: integer().default(0).notNull(),
    lastError: text(),
    /** Async handlers that already succeeded (per-handler idempotency across retries). */
    handled: text().array().default([]).notNull(),
  },
  (t) => [index('outbox_unprocessed').on(t.occurredAt).where(sql`${t.processedAt} is null`)],
);

export const fileObject = pgTable('file_object', {
  id: pk(),
  bucket: text().notNull(),
  key: text().notNull().unique(),
  filename: text().notNull(),
  mime: text().notNull(),
  size: bigint({ mode: 'number' }).notNull(),
  sha256: text(),
  purpose: text().notNull(),
  ownerUserId: uuid(),
  createdAt: createdAt(),
});
