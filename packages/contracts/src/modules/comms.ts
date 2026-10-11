import { z } from 'zod';
import { route, zDate, zId, zInstant, zOk } from '../route';

/**
 * Communications: announcements with audience targeting, scheduling, pin,
 * acknowledgement and WhatsApp fan-out (Comms module). Portals read the feed
 * and post read / ack receipts through the same contract.
 */

export const AUDIENCE_TYPES = ['institution', 'branch', 'course', 'batch', 'role', 'segment'] as const;
export const AUDIENCE_ROLES = ['students', 'parents', 'teachers', 'staff'] as const;
export const AUDIENCE_SEGMENTS = ['overdue_fees', 'low_attendance'] as const;
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];
export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number];

export const AUDIENCE_ROLE_LABEL: Record<AudienceRole, string> = { students: 'Students', parents: 'Parents', teachers: 'Teachers', staff: 'Staff' };
export const AUDIENCE_SEGMENT_LABEL: Record<AudienceSegment, string> = { overdue_fees: 'overdue fees', low_attendance: 'attendance below 75%' };

export const zAudienceTarget = z.object({
  type: z.enum(AUDIENCE_TYPES),
  /** id of branch / course / batch, a role key or a segment key ("institution" for everyone). */
  value: z.string().min(1),
  label: z.string().min(1),
});
export type AudienceTarget = z.output<typeof zAudienceTarget>;

export const zAnnouncementRow = z.object({
  id: zId,
  kicker: z.string(),
  title: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  status: z.enum(['scheduled', 'published', 'expired', 'withdrawn']),
  publishAt: zInstant,
  expiresAt: zInstant.nullable(),
  ackRequired: z.boolean(),
  alsoWhatsapp: z.boolean(),
  audience: z.array(zAudienceTarget),
  recipients: z.number().int(),
  read: z.number().int(),
  acked: z.number().int(),
  /** "Read 812 / 1,120" or "Ack 61 / 94" or "Scheduled · 14 Oct 09:00" */
  metaLabel: z.string(),
  metaTag: z.enum(['accent', 'neutral', 'outline', 'ink']),
  authorName: z.string(),
  canWithdraw: z.boolean(),
});
export type AnnouncementRow = z.output<typeof zAnnouncementRow>;

export const zAnnouncementInput = z.object({
  title: z.string().trim().min(3, 'Add a title').max(140),
  body: z.string().trim().min(3, 'Write the message').max(4000),
  audience: z.array(zAudienceTarget).min(1, 'Choose who should receive it'),
  /** ISO instant; omitted/null = publish now. */
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Last day it stays visible (IST, inclusive). */
  expiresOn: zDate.nullable().optional(),
  pinned: z.boolean().default(false),
  ackRequired: z.boolean().default(false),
  alsoWhatsapp: z.boolean().default(false),
});
export type AnnouncementInput = z.input<typeof zAnnouncementInput>;

export const zAudienceOptions = z.object({
  branches: z.array(z.object({ id: zId, label: z.string() })),
  courses: z.array(z.object({ id: zId, label: z.string() })),
  batches: z.array(z.object({ id: zId, label: z.string() })),
  roles: z.array(z.enum(AUDIENCE_ROLES)),
  segments: z.array(z.enum(AUDIENCE_SEGMENTS)),
  institution: z.boolean(),
  /** What this role may target, shown under the composer. */
  limitNote: z.string(),
});
export type AudienceOptions = z.output<typeof zAudienceOptions>;

export const zAnnouncementFeedItem = z.object({
  id: zId,
  kicker: z.string(),
  title: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  publishAt: zInstant,
  expiresAt: zInstant.nullable(),
  ackRequired: z.boolean(),
  readAt: zInstant.nullable(),
  ackedAt: zInstant.nullable(),
  authorName: z.string(),
});
export type AnnouncementFeedItem = z.output<typeof zAnnouncementFeedItem>;

export const commsContract = {
  list: route({
    method: 'GET',
    path: '/api/comms/announcements',
    response: z.object({ items: z.array(zAnnouncementRow), options: zAudienceOptions, aiEnabled: z.boolean() }),
  }),
  create: route({ method: 'POST', path: '/api/comms/announcements', body: zAnnouncementInput, response: zAnnouncementRow }),
  /** Recipient count for an audience before publishing. */
  preview: route({
    method: 'POST',
    path: '/api/comms/announcements/preview',
    body: z.object({ audience: z.array(zAudienceTarget) }),
    response: z.object({ recipients: z.number().int(), students: z.number().int(), parents: z.number().int(), staff: z.number().int() }),
  }),
  withdraw: route({ method: 'POST', path: '/api/comms/announcements/:id/withdraw', response: zOk }),
  /** Opt-in AI assist (only when ANTHROPIC_API_KEY is configured). Never sends anything. */
  draft: route({
    method: 'POST',
    path: '/api/comms/announcements/draft',
    body: z.object({ title: z.string().trim().max(140).default(''), notes: z.string().trim().max(4000).default(''), audience: z.string().max(300).optional() }),
    response: z.object({ title: z.string(), body: z.string() }),
  }),
  /* Portal / everyone: the signed-in user's announcements. */
  feed: route({ method: 'GET', path: '/api/comms/announcements/feed', response: z.object({ items: z.array(zAnnouncementFeedItem), unread: z.number().int() }) }),
  read: route({ method: 'POST', path: '/api/comms/announcements/:id/read', response: zOk }),
  ack: route({ method: 'POST', path: '/api/comms/announcements/:id/ack', response: zOk }),
};
