import { z } from 'zod';
import { route, zId, zInstant, zOk, zPage } from '../route';

/* ───────────────────────── Session / me ───────────────────────── */

export const zBranchLite = z.object({ id: zId, code: z.string(), name: z.string() });
export type BranchLite = z.output<typeof zBranchLite>;

export const zMembershipLite = z.object({
  id: zId,
  roleKey: z.string(),
  roleLabel: z.string(),
  scopeLabel: z.string(),
  surface: z.enum(['staff', 'portal']),
});

export const zMe = z.object({
  user: z.object({
    id: zId,
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    initials: z.string(),
    kind: z.enum(['staff', 'student', 'guardian']),
    twoFactorEnabled: z.boolean(),
  }),
  membership: zMembershipLite.extend({
    permissions: z.array(z.string()),
    branchIds: z.array(zId),
    scopeKind: z.string(),
  }),
  memberships: z.array(zMembershipLite),
  branch: z.object({
    /** null = "All branches" (only for institution-wide memberships or several branches). */
    selectedId: zId.nullable(),
    allowed: z.array(zBranchLite),
    locked: z.boolean(),
    canSelectAll: z.boolean(),
  }),
  institution: z.object({ id: zId, name: z.string(), brandColor: z.string() }),
  impersonation: z.object({ byName: z.string(), expiresAt: zInstant }).nullable(),
  readOnly: z.boolean(),
  /** Enrolment in 2FA is mandatory for this role and not done yet. */
  needs2faEnrollment: z.boolean(),
  session: z.object({ idleTimeoutMin: z.number().nullable(), twoFactor: z.boolean() }),
  demoMode: z.boolean(),
});
export type Me = z.output<typeof zMe>;

export const coreContract = {
  me: route({ method: 'GET', path: '/api/me', response: zMe }),
  switchMembership: route({ method: 'POST', path: '/api/me/membership', body: z.object({ membershipId: zId }), response: zMe }),
  setBranch: route({ method: 'POST', path: '/api/me/branch', body: z.object({ branchId: zId.nullable() }), response: zMe }),
};

/** Better Auth endpoints (served under /api/auth) used by the web app. */
export const AUTH_PATHS = {
  magicLink: '/api/auth/sign-in/magic-link',
  sendOtp: '/api/auth/phone-number/send-otp',
  verifyOtp: '/api/auth/phone-number/verify',
  google: '/api/auth/sign-in/social',
  signOut: '/api/auth/sign-out',
  demoLogin: '/api/auth/exa/demo-login',
  impersonate: '/api/auth/exa/impersonate',
  stopImpersonation: '/api/auth/exa/stop-impersonation',
} as const;

export const twoFactorContract = {
  setup: route({ method: 'POST', path: '/api/2fa/setup', response: z.object({ secret: z.string(), uri: z.string(), qrSvg: z.string() }) }),
  enable: route({ method: 'POST', path: '/api/2fa/enable', body: z.object({ code: z.string().min(6).max(12) }), response: z.object({ backupCodes: z.array(z.string()) }) }),
  verify: route({ method: 'POST', path: '/api/2fa/verify', body: z.object({ code: z.string().min(6).max(12) }), response: zOk }),
};

/* ───────────────────────── Reference data ───────────────────────── */

export const zReference = z.object({
  branches: z.array(zBranchLite.extend({ status: z.string() })),
  courses: z.array(z.object({ id: zId, code: z.string(), name: z.string(), subjects: z.array(z.object({ id: zId, name: z.string() })) })),
  rooms: z.array(z.object({ id: zId, branchId: zId, name: z.string(), capacity: z.number() })),
  batches: z.array(
    z.object({
      id: zId,
      branchId: zId,
      courseId: zId,
      code: z.string(),
      status: z.string(),
      capacity: z.number(),
      enrolled: z.number(),
      feePlanId: zId.nullable(),
    }),
  ),
  teachers: z.array(z.object({ id: zId, name: z.string(), homeBranchId: zId.nullable() })),
  staff: z.array(z.object({ id: zId, name: z.string(), roleKeys: z.array(z.string()), branchIds: z.array(zId) })),
  feePlans: z.array(z.object({ id: zId, courseId: zId, branchId: zId.nullable(), name: z.string(), kind: z.string() })),
});
export type Reference = z.output<typeof zReference>;

export const referenceContract = {
  get: route({ method: 'GET', path: '/api/reference', response: zReference }),
};

/* ───────────────────────── Notifications ───────────────────────── */

export const zNotification = z.object({
  id: zId,
  category: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  readAt: zInstant.nullable(),
  createdAt: zInstant,
});

export const NOTIFICATION_PREFS = [
  { category: 'fee_due', label: 'Fee due / overdue', mutable: false, defaults: ['whatsapp', 'email', 'in_app'] },
  { category: 'exam_schedule', label: 'Exam schedule', mutable: false, defaults: ['whatsapp', 'in_app'] },
  { category: 'attendance', label: 'Absence same day', mutable: true, defaults: ['whatsapp', 'in_app'] },
  { category: 'marks', label: 'Marks published', mutable: true, defaults: ['in_app'] },
  { category: 'payment', label: 'Payments & receipts', mutable: true, defaults: ['whatsapp', 'email', 'in_app'] },
  { category: 'announcement', label: 'Announcements', mutable: true, defaults: ['in_app'] },
  { category: 'timetable', label: 'Timetable changes', mutable: true, defaults: ['in_app'] },
  { category: 'material', label: 'New material', mutable: true, defaults: ['in_app'] },
  { category: 'assignment', label: 'Assignments', mutable: true, defaults: ['in_app'] },
] as const;

export const notificationsContract = {
  list: route({
    method: 'GET',
    path: '/api/notifications',
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
    response: z.object({ items: z.array(zNotification), unread: z.number().int() }),
  }),
  markAllRead: route({ method: 'POST', path: '/api/notifications/read-all', response: zOk }),
  markRead: route({ method: 'POST', path: '/api/notifications/:id/read', response: zOk }),
  preferences: route({
    method: 'GET',
    path: '/api/notifications/preferences',
    response: z.array(z.object({ category: z.string(), label: z.string(), mutable: z.boolean(), channels: z.array(z.string()) })),
  }),
  setPreference: route({
    method: 'PUT',
    path: '/api/notifications/preferences',
    body: z.object({ category: z.string(), channels: z.array(z.enum(['whatsapp', 'email', 'in_app'])) }),
    response: zOk,
  }),
};

/* ───────────────────────── Search (⌘K) ───────────────────────── */

export const zSearchItem = z.object({
  kind: z.enum(['Student', 'Lead', 'Invoice', 'Batch', 'Teacher', 'Branch', 'Exam', 'Action']),
  label: z.string(),
  meta: z.string(),
  /** Navigate to this path… */
  href: z.string().nullable(),
  /** …or open this detail drawer. */
  drawer: z.object({ entity: z.enum(['student', 'teacher', 'branch', 'exam']), id: zId }).nullable(),
});
export type SearchItem = z.output<typeof zSearchItem>;

export const searchContract = {
  search: route({ method: 'GET', path: '/api/search', query: z.object({ q: z.string().max(100).default('') }), response: z.object({ items: z.array(zSearchItem) }) }),
};

/* ───────────────────────── Audit log ───────────────────────── */

export const AUDIT_ACTION_KINDS = ['create', 'update', 'approve', 'login', 'export', 'impersonate', 'publish', 'payment', 'delete', 'other'] as const;

export const zAuditEntry = z.object({
  id: zId,
  at: zInstant,
  actorName: z.string(),
  roleLabel: z.string().nullable(),
  action: z.string(),
  actionKind: z.string(),
  entity: z.string(),
  summary: z.string().nullable(),
  ip: z.string().nullable(),
});
export type AuditEntry = z.output<typeof zAuditEntry>;

export const zAuditQuery = z.object({
  q: z.string().max(100).optional(),
  actionKind: z.enum(AUDIT_ACTION_KINDS).optional(),
  roleKey: z.string().optional(),
  range: z.enum(['1h', '24h', '7d', '30d', 'all']).default('24h'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditContract = {
  list: route({ method: 'GET', path: '/api/audit', query: zAuditQuery, response: zPage(zAuditEntry) }),
  recent: route({ method: 'GET', path: '/api/audit/recent', response: z.array(zAuditEntry) }),
  /** CSV download; response is text/csv, not JSON. */
  exportPath: '/api/audit/export',
};

/* ───────────────────────── Files ───────────────────────── */

export const FILE_PURPOSES = ['material', 'submission', 'admission_doc', 'import', 'photo', 'statement', 'logo'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const zFileRef = z.object({ id: zId, filename: z.string(), mime: z.string(), size: z.number() });
export type FileRef = z.output<typeof zFileRef>;

export const filesContract = {
  /** multipart/form-data: field "file", query purpose */
  uploadPath: '/api/files',
  signedUrl: route({ method: 'GET', path: '/api/files/:id/url', response: z.object({ url: z.string(), expiresAt: zInstant }) }),
};

/* ───────────────────────── Public ───────────────────────── */

export const publicContract = {
  config: route({
    method: 'GET',
    path: '/api/public/config',
    response: z.object({
      institution: z.string(),
      branches: z.array(z.object({ name: z.string(), city: z.string().nullable() })),
      googleEnabled: z.boolean(),
      demoMode: z.boolean(),
      activeStudents: z.number().int(),
      roles: z.number().int(),
    }),
  }),
};

/* ───────────────────────── Dev (DEMO_MODE only) ───────────────────────── */

export const devContract = {
  accounts: route({
    method: 'GET',
    path: '/api/dev/accounts',
    response: z.array(z.object({ email: z.string(), name: z.string(), roleKey: z.string(), label: z.string(), scope: z.string() })),
  }),
  outbox: route({
    method: 'GET',
    path: '/api/dev/outbox',
    response: z.array(
      z.object({
        id: zId,
        channel: z.string(),
        toAddress: z.string(),
        subject: z.string().nullable(),
        body: z.string(),
        status: z.string(),
        createdAt: zInstant,
        attachments: z.array(z.object({ filename: z.string(), url: z.string().optional() })),
      }),
    ),
  }),
};
