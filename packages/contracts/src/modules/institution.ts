import { validatePattern } from '@exatech/domain';
import { z } from 'zod';
import { PERMISSIONS } from '../permissions';
import { route, zDate, zId, zInstant, zOk, zPaise } from '../route';

/**
 * Institution bounded context (Super Admin workspace, PRD §5): overview KPIs,
 * branches (rooms, holidays), staff & teachers (memberships = role × scope),
 * roles & permissions, institution settings.
 */

export const INST_TAGS = ['accent', 'neutral', 'outline', 'ink', 'plain'] as const;
export const zInstTag = z.enum(INST_TAGS);
export type InstTag = z.output<typeof zInstTag>;

/* ───────────────────────── Overview ───────────────────────── */

export const zInstKpis = z.object({
  /** "October" */
  monthLabel: z.string(),
  /** "September" */
  prevMonthLabel: z.string(),
  /** Fees invoiced this month (paise). */
  revenue: zPaise,
  revenuePrev: zPaise,
  /** "+12% vs September" */
  revenueNote: z.string(),
  /** Cleared payments this month. */
  collected: zPaise,
  /** Sum of monthly collection targets of the branches in scope. */
  target: zPaise,
  collectedPct: z.number().int(),
  /** Unpaid instalments due on or before today. */
  dues: zPaise,
  duesOver60: zPaise,
  /** "₹3.1L over 60 days" */
  duesNote: z.string(),
  /** Admissions approved this month. */
  admissions: z.number().int(),
  leads: z.number().int(),
  /** "from 1,412 leads · 13.2%" */
  admissionsNote: z.string(),
  /** Admissions submitted or fee-verified, waiting for a decision. */
  awaitingApproval: z.number().int(),
  activeStudents: z.number().int(),
  runningBatches: z.number().int(),
  /** "in 41 running batches" */
  studentsNote: z.string(),
});
export type InstKpis = z.output<typeof zInstKpis>;

export const zInstBranchRow = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  students: z.number().int(),
  admissions: z.number().int(),
  collected: zPaise,
  dues: zPaise,
  target: zPaise,
  collectedPct: z.number().int(),
  statusLabel: z.string(),
  statusTag: zInstTag,
});
export type InstBranchRow = z.output<typeof zInstBranchRow>;

export const zInstOverview = z.object({
  scopeLabel: z.string(),
  kpis: zInstKpis,
  branches: z.array(zInstBranchRow),
  /** When the materialised aggregates were computed (refreshed at most every 60 s). */
  computedAt: zInstant,
});
export type InstOverview = z.output<typeof zInstOverview>;

/* ───────────────────────── Branches, rooms, holidays ───────────────────────── */

export const BRANCH_STATUSES = ['active', 'paused', 'archived'] as const;
export const ROOM_KINDS = ['room', 'lab', 'hall'] as const;

export const zInstHoliday = z.object({
  id: zId,
  date: zDate,
  /** "Oct 20" */
  shortLabel: z.string(),
  /** "Tue 20 Oct 2026" */
  longLabel: z.string(),
  name: z.string(),
  branchId: zId.nullable(),
  /** "All branches" or the branch name */
  scopeLabel: z.string(),
  past: z.boolean(),
  suppressedSessions: z.number().int(),
});
export type InstHoliday = z.output<typeof zInstHoliday>;

export const zInstBranchCard = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  /** "2019" or "Aug 2026" for recently opened branches */
  openedLabel: z.string(),
  openedOn: zDate.nullable(),
  status: z.enum(BRANCH_STATUSES),
  statusLabel: z.string(),
  statusTag: zInstTag,
  statusNote: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  gstin: z.string().nullable(),
  gstinNote: z.string().nullable(),
  /** "32AABCE1234F1Z5 · head office" or "shared with institution" */
  gstinLine: z.string(),
  monthlyTarget: zPaise,
  managerUserId: zId.nullable(),
  managerName: z.string().nullable(),
  roomCount: z.number().int(),
  batchCount: z.number().int(),
  studentCount: z.number().int(),
});
export type InstBranchCard = z.output<typeof zInstBranchCard>;

export const zInstBranches = z.object({
  branches: z.array(zInstBranchCard),
  /** "2026-27" */
  academicYearLabel: z.string(),
  /** Next holidays (all branches in scope), soonest first. */
  upcoming: z.array(zInstHoliday),
  canManage: z.boolean(),
});

export const zInstRoom = z.object({
  id: zId,
  branchId: zId,
  name: z.string(),
  capacity: z.number().int(),
  kind: z.enum(ROOM_KINDS),
  active: z.boolean(),
  /** Scheduled sessions from today on that use the room. */
  upcomingSessions: z.number().int(),
});
export type InstRoom = z.output<typeof zInstRoom>;

export const zInstBranchDetail = zInstBranchCard.extend({
  /** "Oct" */
  monthShort: z.string(),
  kpis: z.object({
    students: z.number().int(),
    studentsNote: z.string(),
    admissions: z.number().int(),
    admissionsNote: z.string(),
    collected: zPaise,
    collectedPct: z.number().int(),
    dues: zPaise,
    duesNote: z.string(),
  }),
  openedLong: z.string(),
  rooms: z.array(zInstRoom),
  batches: z.array(
    z.object({
      id: zId,
      code: z.string(),
      courseName: z.string(),
      teachers: z.array(z.object({ userId: zId, name: z.string(), subject: z.string() })),
      enrolled: z.number().int(),
      capacity: z.number().int(),
      status: z.string(),
      statusLabel: z.string(),
      statusTag: zInstTag,
    }),
  ),
  staff: z.array(z.object({ userId: zId, name: z.string(), roles: z.string() })),
  holidays: z.array(zInstHoliday),
  canManage: z.boolean(),
});
export type InstBranchDetail = z.output<typeof zInstBranchDetail>;

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const zGstin = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => GSTIN_RE.test(v), 'GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity number, Z and a check character (e.g. 32AABCE1234F1Z5)');

export const zRoomInput = z.object({
  name: z.string().trim().min(1, 'Name the room').max(40),
  capacity: z.number('Enter the capacity').int('Capacity is a whole number').min(1, 'Capacity must be at least 1').max(500, 'Capacity can be at most 500'),
  kind: z.enum(ROOM_KINDS).default('room'),
});
export type RoomInput = z.input<typeof zRoomInput>;

export const zBranchInput = z.object({
  name: z.string().trim().min(2, 'Enter the branch name').max(60),
  address: z.string().trim().min(3, 'Enter the address').max(200),
  city: z.string().trim().min(2, 'Enter the city').max(60),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email('Enter a valid email').nullable().optional(),
  /** null = GST registration shared with the institution */
  gstin: zGstin.nullable(),
  openedOn: zDate,
  /** Monthly collection target in paise. */
  monthlyTarget: zPaise.nonnegative('Target cannot be negative'),
  managerUserId: zId.nullable(),
});

export const zBranchCreate = zBranchInput.extend({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{2,5}$/.test(v), 'Code is 2–5 letters, e.g. TVM'),
  rooms: z.array(zRoomInput).max(30).default([]),
});
export type BranchCreateInput = z.input<typeof zBranchCreate>;

export const zBranchUpdate = zBranchInput.extend({
  status: z.enum(BRANCH_STATUSES),
  statusNote: z.string().trim().max(60).nullable().optional(),
});
export type BranchUpdateInput = z.input<typeof zBranchUpdate>;

export const zHolidayInput = z.object({
  date: zDate,
  name: z.string().trim().min(2, 'Name the holiday').max(60),
  /** null = all branches */
  branchId: zId.nullable(),
});

export const institutionBranchesContract = {
  list: route({ method: 'GET', path: '/api/institution/branches', response: zInstBranches }),
  get: route({ method: 'GET', path: '/api/institution/branches/:id', response: zInstBranchDetail }),
  create: route({ method: 'POST', path: '/api/institution/branches', body: zBranchCreate, response: zInstBranchCard }),
  update: route({ method: 'PUT', path: '/api/institution/branches/:id', body: zBranchUpdate, response: zInstBranchCard }),
  addRoom: route({ method: 'POST', path: '/api/institution/branches/:id/rooms', body: zRoomInput, response: zInstRoom }),
  /** Edit or (de)activate a room. Deactivating a room with upcoming sessions needs `confirm: true`. */
  updateRoom: route({
    method: 'PUT',
    path: '/api/institution/rooms/:id',
    body: zRoomInput.extend({ active: z.boolean(), confirm: z.boolean().default(false) }),
    response: zInstRoom,
  }),
  holidays: route({ method: 'GET', path: '/api/institution/holidays', response: z.object({ academicYearLabel: z.string(), items: z.array(zInstHoliday), canManage: z.boolean() }) }),
  addHoliday: route({ method: 'POST', path: '/api/institution/holidays', body: zHolidayInput, response: z.object({ holiday: zInstHoliday, suppressed: z.number().int() }) }),
  removeHoliday: route({ method: 'POST', path: '/api/institution/holidays/:id/remove', response: z.object({ restored: z.number().int() }) }),
};

/* ───────────────────────── Staff & teachers ───────────────────────── */

export const STAFF_STATUSES = ['active', 'leave', 'cross_branch', 'invited', 'deactivated'] as const;

export const zInstMembership = z.object({
  id: zId,
  roleId: zId,
  roleKey: z.string(),
  roleLabel: z.string(),
  /** Short role label, e.g. "Branch Admin" */
  roleShort: z.string(),
  scopeKind: z.string(),
  branchIds: z.array(zId),
  scopeLabel: z.string(),
  /** "Sales Manager TVM", "Teacher FS-B · FS-C", "Super Admin" */
  label: z.string(),
  isDefault: z.boolean(),
});
export type InstMembership = z.output<typeof zInstMembership>;

export const zInstStaffRow = z.object({
  userId: zId,
  name: z.string(),
  title: z.string().nullable(),
  /** "Sales Manager TVM · Teacher FS-B" */
  memberships: z.string(),
  homeBranch: z.string().nullable(),
  /** "DM-A · Search · SEO & analytics; DM-B · Paid media · Google Ads" or "—" */
  teaches: z.string(),
  loadHours: z.number(),
  /** "8 h / wk" or "—" */
  loadLabel: z.string(),
  status: z.enum(STAFF_STATUSES),
  statusLabel: z.string(),
  statusTag: zInstTag,
});
export type InstStaffRow = z.output<typeof zInstStaffRow>;

export const zInstLeaveNote = z.object({
  key: z.string(),
  userId: zId,
  title: z.string(),
  tag: z.string(),
  tagVariant: zInstTag,
});

export const zInstStaffList = z.object({
  scopeLabel: z.string(),
  count: z.number().int(),
  rows: z.array(zInstStaffRow),
  /** "Leave & substitutes" card. */
  notes: z.array(zInstLeaveNote),
  canManage: z.boolean(),
});
export type InstStaffList = z.output<typeof zInstStaffList>;

export const zInstLeaveRow = z.object({
  id: zId,
  userId: zId,
  name: z.string(),
  date: zDate,
  dateLabel: z.string(),
  type: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  statusTag: zInstTag,
  /** "DM-A 09:00 · substitute needed" / "No sessions that day" */
  impact: z.string(),
});
export type InstLeaveRow = z.output<typeof zInstLeaveRow>;

export const zInstRoleOption = z.object({
  id: zId,
  key: z.string(),
  name: z.string(),
  short: z.string(),
  scopeKind: z.string(),
  surface: z.string(),
  isSystem: z.boolean(),
});
export type InstRoleOption = z.output<typeof zInstRoleOption>;

export const zInstAssignOption = z.object({
  batchId: zId,
  code: z.string(),
  courseName: z.string(),
  branchCode: z.string(),
  status: z.string(),
  subjects: z.array(z.string()),
  /** Subjects already taught in the batch: "Search · SEO & analytics" → "Nithin Raj" */
  taken: z.array(z.object({ subject: z.string(), teacherName: z.string(), teacherUserId: zId })),
});

export const zInstStaffDetail = z.object({
  userId: zId,
  name: z.string(),
  title: z.string().nullable(),
  /** "Teacher · Trivandrum" */
  kicker: z.string(),
  userStatus: z.enum(['invited', 'active', 'deactivated']),
  status: z.enum(STAFF_STATUSES),
  statusLabel: z.string(),
  statusTag: zInstTag,
  kpis: z.object({
    batches: z.number().int(),
    subjects: z.number().int(),
    hoursThisWeek: z.number(),
    hoursLabel: z.string(),
    materials: z.number().int(),
    /** "Module 2 · Search · 2 rows" or "Nothing pending" */
    marksPending: z.string(),
  }),
  memberships: z.array(zInstMembership),
  teaching: z.array(
    z.object({
      assignmentId: zId,
      batchId: zId,
      batchCode: z.string(),
      branchCode: z.string(),
      courseName: z.string(),
      subject: z.string(),
      sessionsPerWeek: z.number().int(),
      room: z.string(),
      seats: z.string(),
    }),
  ),
  week: z.array(z.object({ id: zId, date: zDate, when: z.string(), what: z.string(), where: z.string(), flag: z.string().nullable() })),
  facts: z.object({
    email: z.string(),
    phone: z.string(),
    homeBranch: z.string(),
    title: z.string(),
    employeeCode: z.string(),
    joined: z.string(),
  }),
  leaveSummary: z.string(),
  leave: z.array(zInstLeaveRow),
  materials: z.array(z.object({ id: zId, batchCode: z.string(), title: z.string(), visibility: z.string(), visLabel: z.string(), visTag: zInstTag })),
  devices: z.array(z.object({ id: zId, device: z.string(), method: z.string(), ip: z.string().nullable(), createdAt: zInstant, lastSeenAt: zInstant.nullable(), current: z.boolean() })),
  /** Batches this person can be assigned to (their teaching branches). */
  assignOptions: z.array(zInstAssignOption),
  isTeacher: z.boolean(),
  isSelf: z.boolean(),
  canManage: z.boolean(),
});
export type InstStaffDetail = z.output<typeof zInstStaffDetail>;

export const zMembershipInput = z.object({
  roleId: zId,
  /** Branches the membership covers; empty for institution-wide roles. */
  branchIds: z.array(zId).max(20).default([]),
});
export type MembershipInput = z.input<typeof zMembershipInput>;

export const zInviteInput = z.object({
  name: z.string().trim().min(2, 'Enter the full name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone: z.string().trim().min(10, 'Enter a valid 10-digit mobile').max(20),
  homeBranchId: zId,
  title: z.string().trim().max(80).nullable().optional(),
  memberships: z.array(zMembershipInput).min(1, 'Add at least one membership (role × scope)').max(6),
});
export type InviteInput = z.input<typeof zInviteInput>;

export const LEAVE_TYPES = ['casual', 'sick', 'earned', 'on_duty'] as const;

export const institutionStaffContract = {
  list: route({ method: 'GET', path: '/api/institution/staff', response: zInstStaffList }),
  /** Roles and branches for the invite / memberships dialogs. */
  options: route({
    method: 'GET',
    path: '/api/institution/staff/options',
    response: z.object({ roles: z.array(zInstRoleOption), branches: z.array(z.object({ id: zId, code: z.string(), name: z.string() })) }),
  }),
  /** Leave calendar: upcoming leave across staff in scope. */
  leave: route({ method: 'GET', path: '/api/institution/staff/leave', response: z.array(zInstLeaveRow) }),
  get: route({ method: 'GET', path: '/api/institution/staff/:id', response: zInstStaffDetail }),
  invite: route({ method: 'POST', path: '/api/institution/staff', body: zInviteInput, response: z.object({ userId: zId, name: z.string() }) }),
  setMemberships: route({
    method: 'PUT',
    path: '/api/institution/staff/:id/memberships',
    body: z.object({ memberships: z.array(zMembershipInput).max(8) }),
    response: z.array(zInstMembership),
  }),
  assign: route({
    method: 'POST',
    path: '/api/institution/staff/:id/assignments',
    body: z.object({ batchId: zId, subjectName: z.string().trim().min(2, 'Choose the subject') }),
    response: zOk,
  }),
  recordLeave: route({
    method: 'POST',
    path: '/api/institution/staff/:id/leave',
    body: z.object({ date: zDate, type: z.enum(LEAVE_TYPES), reason: z.string().trim().min(2, 'Add a reason').max(200) }),
    response: z.object({ id: zId, flagged: z.number().int() }),
  }),
  setStatus: route({
    method: 'POST',
    path: '/api/institution/staff/:id/status',
    body: z.object({ status: z.enum(['active', 'deactivated']), reason: z.string().trim().max(200).optional() }),
    response: z.object({ ok: z.literal(true), signedOut: z.number().int() }),
  }),
  signOutEverywhere: route({ method: 'POST', path: '/api/institution/staff/:id/sign-out', response: z.object({ ok: z.literal(true), signedOut: z.number().int() }) }),
};

/* ───────────────────────── Roles & permissions ───────────────────────── */

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as [string, ...string[]];
export const zPermissionKey = z.enum(PERMISSION_KEYS);

export const zInstRole = z.object({
  id: zId,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopeKind: z.enum(['institution', 'branch', 'batch', 'own', 'child']),
  surface: z.enum(['staff', 'portal']),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  /** Active memberships using this role. */
  members: z.number().int(),
  position: z.number().int(),
});
export type InstRole = z.output<typeof zInstRole>;

/** Permissions a Super Admin role can never lose (the institution would lock itself out). */
export const SUPERADMIN_LOCKED_PERMISSIONS = ['institution:roles.manage', 'institution:approvals.decide'] as const;

export const zRoleCreate = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,29}$/, 'Key is a lowercase slug: letters, digits and _ (e.g. front_desk)'),
  name: z.string().trim().min(2, 'Name the role').max(40),
  scopeKind: z.enum(['institution', 'branch', 'batch', 'own']),
  surface: z.enum(['staff', 'portal']),
  description: z.string().trim().max(200).nullable().optional(),
});
export type RoleCreateInput = z.input<typeof zRoleCreate>;

export const institutionRolesContract = {
  list: route({
    method: 'GET',
    path: '/api/institution/roles',
    response: z.object({
      roles: z.array(zInstRole),
      thresholds: z.object({ financePct: z.number(), superAdminPct: z.number() }),
      impersonationMinutes: z.number().int(),
    }),
  }),
  create: route({ method: 'POST', path: '/api/institution/roles', body: zRoleCreate, response: zInstRole }),
  /** Save the matrix: every changed role at once (audited with a before → after diff). */
  saveMatrix: route({
    method: 'PUT',
    path: '/api/institution/roles',
    body: z.object({ changes: z.array(z.object({ roleId: zId, permissions: z.array(zPermissionKey) })).min(1, 'Nothing to save').max(40) }),
    response: z.array(zInstRole),
  }),
  remove: route({ method: 'POST', path: '/api/institution/roles/:id/delete', response: zOk }),
};

/* ───────────────────────── Settings ───────────────────────── */

export const BRAND_PRESETS = [
  { value: '#4f9d68', label: 'Exatech green (default)' },
  { value: '#2f6f9f', label: 'Harbour blue' },
  { value: '#5b5fb0', label: 'Indigo' },
  { value: '#9a4f7c', label: 'Plum' },
  { value: '#b0562f', label: 'Laterite' },
  { value: '#2f7f7a', label: 'Backwater teal' },
] as const;

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Contrast ratio of white text on the colour (buttons, active nav). */
export function contrastOnWhite(hex: string): number {
  return Math.round((1.05 / (relativeLuminance(hex) + 0.05)) * 100) / 100;
}

/** Minimum contrast for the brand colour against white (WCAG 1.4.11 UI components / large text). */
export const BRAND_MIN_CONTRAST = 3;

export const zClearancePolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current_instalment') }),
  z.object({ kind: z.literal('fully_paid') }),
  z.object({ kind: z.literal('percentage'), percentage: z.number().int('Use a whole percentage').min(1, 'Percentage must be 1–100').max(100, 'Percentage must be 1–100') }),
]);

const zSecurity = z.object({
  require2faRoles: z.array(z.string()).max(40),
  staffSessionHours: z.number().int().min(1, 'Staff sessions last 1–24 hours').max(24, 'Staff sessions last 1–24 hours'),
  staffIdleMinutes: z.number().int().min(5, 'Idle timeout is 5–120 minutes').max(120, 'Idle timeout is 5–120 minutes'),
  portalSessionDays: z.number().int().min(1, 'Portal sessions last 1–30 days').max(30, 'Portal sessions last 1–30 days'),
  impersonationMinutes: z.number().int().min(5, 'Impersonation lasts 5–60 minutes').max(60, 'Impersonation lasts 5–60 minutes'),
});

const zSettingsBase = z.object({
  name: z.string().trim().min(2, 'Enter the institution name').max(80),
  legalName: z.string().trim().max(120).nullable(),
  gstin: zGstin,
  academicYearLabel: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Academic year looks like 2026-27'),
  academicYearStart: zDate,
  brandColor: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Brand colour is a hex value like #4f9d68'),
  clearancePolicy: zClearancePolicy,
  discountThresholds: z.object({
    financePct: z.number().int('Use a whole percentage').min(0).max(100),
    superAdminPct: z.number().int('Use a whole percentage').min(0).max(100),
  }),
  admissionNumberPattern: z.string().trim().min(5, 'Enter the admission number format').max(60),
  security: zSecurity,
  leadRetentionMonths: z.number().int().min(6, 'Keep leads 6–60 months').max(60, 'Keep leads 6–60 months'),
});

/** Settings with the cross-field rules; every refinement states its reason (shown inline). */
export const zSettings = zSettingsBase.superRefine((v, ctx) => {
  const t = v.discountThresholds;
  if (t.financePct >= t.superAdminPct) {
    ctx.addIssue({ code: 'custom', path: ['discountThresholds', 'superAdminPct'], message: `The Super Admin threshold (${t.superAdminPct}%) must be above the Finance threshold (${t.financePct}%)` });
  }
  const pattern = validatePattern(v.admissionNumberPattern);
  if (!pattern.ok) ctx.addIssue({ code: 'custom', path: ['admissionNumberPattern'], message: pattern.reason ?? 'Invalid pattern' });
  else if (!v.admissionNumberPattern.includes('{BRANCH}')) ctx.addIssue({ code: 'custom', path: ['admissionNumberPattern'], message: 'Include {BRANCH} — sequences run per branch, so numbers would repeat across branches' });
  else if (!/\{(YEAR|FY)\}/.test(v.admissionNumberPattern)) ctx.addIssue({ code: 'custom', path: ['admissionNumberPattern'], message: 'Include {YEAR} or {FY} — sequences restart every year, so numbers would repeat' });
  if (/^#[0-9a-f]{6}$/.test(v.brandColor) && contrastOnWhite(v.brandColor) < BRAND_MIN_CONTRAST) {
    ctx.addIssue({ code: 'custom', path: ['brandColor'], message: `White text on ${v.brandColor} has ${contrastOnWhite(v.brandColor)}:1 contrast — pick a darker colour (at least ${BRAND_MIN_CONTRAST}:1)` });
  }
  if (!/^\d{4}-\d{2}$/.test(v.academicYearLabel)) return;
  const start = Number(v.academicYearLabel.slice(0, 4));
  if ((start + 1) % 100 !== Number(v.academicYearLabel.slice(5))) ctx.addIssue({ code: 'custom', path: ['academicYearLabel'], message: `Academic year ${start}-${String((start + 1) % 100).padStart(2, '0')} spans two consecutive years` });
  else if (!v.academicYearStart.startsWith(String(start))) ctx.addIssue({ code: 'custom', path: ['academicYearStart'], message: `The ${v.academicYearLabel} academic year starts in ${start}` });
});
export type SettingsInput = z.input<typeof zSettings>;

export const zSettingsView = zSettingsBase.extend({
  /** Live preview of the admission number using the next real sequence. */
  preview: z.object({ branchCode: z.string(), courseCode: z.string(), year: z.number().int(), fy: z.string(), nextSeq: z.number().int() }),
  /** Roles for the 2FA multi-select. */
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
  /** Roles that always require 2FA. */
  locked2faRoles: z.array(z.string()),
  canManage: z.boolean(),
});
export type SettingsView = z.output<typeof zSettingsView>;

export const ALWAYS_2FA_ROLES = ['superadmin', 'finance'] as const;

export const institutionSettingsContract = {
  get: route({ method: 'GET', path: '/api/institution/settings', response: zSettingsView }),
  save: route({ method: 'PUT', path: '/api/institution/settings', body: zSettings, response: zSettingsView }),
};

export const institutionContract = {
  overview: route({ method: 'GET', path: '/api/institution/overview', response: zInstOverview }),
  /** CSV download (watermarked, audited); text/csv, not JSON. */
  exportPath: '/api/institution/overview/export',
};
