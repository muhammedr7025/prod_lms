/**
 * Permission catalogue. Access = role (these keys) × scope (membership
 * branches / assigned batches / own record / linked child). Both are checked
 * on the server for every request; the UI only hides what cannot be used.
 */
export type Letter = 'C' | 'R' | 'U' | 'D' | 'A';

export interface PermissionDef {
  key: string;
  resource: MatrixResource;
  letter: Letter;
  label: string;
}

export const MATRIX_RESOURCES = [
  'Branches, roles, settings',
  'Courses, batches, timetable',
  'Leads',
  'Admissions',
  'Fee plans',
  'Invoices, payments',
  'Attendance',
  'Assignments, notes',
  'Exams, marks',
  'Announcements',
  'Audit log',
] as const;
export type MatrixResource = (typeof MATRIX_RESOURCES)[number];

const p = (key: string, resource: MatrixResource, letter: Letter, label: string): PermissionDef => ({ key, resource, letter, label });

export const PERMISSIONS = [
  // Branches, roles, settings
  p('institution:overview.read', 'Branches, roles, settings', 'R', 'View institution overview'),
  p('institution:branches.read', 'Branches, roles, settings', 'R', 'View branches'),
  p('institution:branches.manage', 'Branches, roles, settings', 'C', 'Create and edit branches, rooms, holidays'),
  p('institution:settings.read', 'Branches, roles, settings', 'R', 'View settings'),
  p('institution:settings.manage', 'Branches, roles, settings', 'U', 'Change institution settings'),
  p('institution:roles.manage', 'Branches, roles, settings', 'U', 'Edit roles & permissions'),
  p('institution:staff.read', 'Branches, roles, settings', 'R', 'View staff & teachers'),
  p('institution:staff.manage', 'Branches, roles, settings', 'C', 'Invite staff, edit memberships'),
  p('institution:approvals.decide', 'Branches, roles, settings', 'A', 'Decide approvals above thresholds'),
  p('institution:impersonate', 'Branches, roles, settings', 'A', 'View as student (read-only, logged)'),
  p('institution:branches.delete', 'Branches, roles, settings', 'D', 'Archive branches'),
  // Courses, batches, timetable
  p('academics:overview.read', 'Courses, batches, timetable', 'R', 'Branch operations'),
  p('academics:courses.read', 'Courses, batches, timetable', 'R', 'View courses & batches'),
  p('academics:courses.manage', 'Courses, batches, timetable', 'C', 'Create and edit courses & batches'),
  p('academics:courses.delete', 'Courses, batches, timetable', 'D', 'Cancel batches'),
  p('academics:timetable.read', 'Courses, batches, timetable', 'R', 'View timetable'),
  p('academics:timetable.manage', 'Courses, batches, timetable', 'U', 'Edit timetable, substitutes'),
  p('academics:leave.approve', 'Courses, batches, timetable', 'A', 'Approve leave'),
  p('academics:students.read', 'Courses, batches, timetable', 'R', 'View students'),
  p('academics:students.manage', 'Courses, batches, timetable', 'U', 'Transfer, ID cards, go-live import'),
  // Leads
  p('sales:leads.read', 'Leads', 'R', 'View leads in scope'),
  p('sales:leads.create', 'Leads', 'C', 'Create leads'),
  p('sales:leads.update', 'Leads', 'U', 'Update leads'),
  p('sales:leads.delete', 'Leads', 'D', 'Delete leads'),
  p('sales:leads.all', 'Leads', 'R', 'See every lead in the branch (not only own)'),
  p('sales:followups.manage', 'Leads', 'U', 'Follow-ups & templates'),
  p('sales:import', 'Leads', 'C', 'Import leads'),
  p('sales:funnel.read', 'Leads', 'R', 'Funnel & conversion'),
  p('sales:rules.manage', 'Leads', 'U', 'Assignment rules & reassignment'),
  p('sales:targets.manage', 'Leads', 'U', 'Targets & leaderboard'),
  // Admissions
  p('admissions:read', 'Admissions', 'R', 'View admissions'),
  p('admissions:create', 'Admissions', 'C', 'Convert lead to admission'),
  p('admissions:update', 'Admissions', 'U', 'Edit admissions'),
  p('admissions:delete', 'Admissions', 'D', 'Cancel admissions'),
  p('admissions:approve', 'Admissions', 'A', 'Approve admissions (final step)'),
  p('admissions:verify_fee', 'Admissions', 'A', 'Verify fee terms (step 2)'),
  // Fee plans
  p('finance:feeplans.read', 'Fee plans', 'R', 'View fee plans'),
  p('finance:feeplans.manage', 'Fee plans', 'C', 'Create and edit fee plans'),
  p('finance:feeplans.update', 'Fee plans', 'U', 'Update fee plans'),
  p('finance:feeplans.delete', 'Fee plans', 'D', 'Retire fee plans'),
  p('finance:discount.approve', 'Fee plans', 'A', 'Approve discounts'),
  // Invoices, payments
  p('finance:dashboard.read', 'Invoices, payments', 'R', 'Finance dashboard'),
  p('finance:payment.collect', 'Invoices, payments', 'C', 'Collect payments at the desk'),
  p('finance:account.read', 'Invoices, payments', 'R', 'Student fee accounts'),
  p('finance:invoices.manage', 'Invoices, payments', 'U', 'Issue, reprint, cancel invoices'),
  p('finance:void', 'Invoices, payments', 'D', 'Void payments (maker-checker)'),
  p('finance:dues.manage', 'Invoices, payments', 'U', 'Dues, reminders, promises'),
  p('finance:daybook.manage', 'Invoices, payments', 'U', 'Day book & closing'),
  p('finance:reconcile', 'Invoices, payments', 'U', 'Reconciliation'),
  p('finance:settings.manage', 'Invoices, payments', 'U', 'Finance settings'),
  p('finance:exemption.grant', 'Invoices, payments', 'A', 'Grant clearance exemptions'),
  p('finance:restructure', 'Invoices, payments', 'A', 'Restructure schedules'),
  p('finance:approve', 'Invoices, payments', 'A', 'Approve refunds, waivers, restructures'),
  // Attendance
  p('teaching:attendance.mark', 'Attendance', 'C', 'Mark attendance (assigned + ad-hoc)'),
  p('academics:attendance.override', 'Attendance', 'U', 'Override attendance after 48 h'),
  p('academics:adhoc.acknowledge', 'Attendance', 'A', 'Acknowledge ad-hoc sessions'),
  p('academics:attendance.read', 'Attendance', 'R', 'View attendance'),
  // Assignments, notes
  p('teaching:assignments.manage', 'Assignments, notes', 'C', 'Assignments & grading'),
  p('teaching:materials.manage', 'Assignments, notes', 'U', 'Upload & manage material'),
  p('academics:materials.read', 'Assignments, notes', 'R', 'Notes & material oversight'),
  p('teaching:materials.delete', 'Assignments, notes', 'D', 'Remove material'),
  // Exams, marks
  p('teaching:marks.enter', 'Exams, marks', 'C', 'Create exams, enter, submit & recall marks'),
  p('academics:marks.read', 'Exams, marks', 'R', 'View exams & marks'),
  p('academics:marks.publish', 'Exams, marks', 'A', 'Publish / return marks'),
  // Announcements
  p('comms:announcements.manage', 'Announcements', 'C', 'Create announcements'),
  p('comms:announcements.read', 'Announcements', 'R', 'Read announcements'),
  p('comms:announcements.delete', 'Announcements', 'D', 'Withdraw announcements'),
  // Audit
  p('audit:read', 'Audit log', 'R', 'Read the audit log in scope'),
  p('audit:export', 'Audit log', 'R', 'Export the audit log'),
  // Teacher-only extras
  p('teaching:leave.request', 'Courses, batches, timetable', 'C', 'Request leave'),
  // Portals
  p('portal:student', 'Assignments, notes', 'R', 'Student portal'),
  p('portal:parent', 'Assignments, notes', 'R', 'Parent portal'),
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((x) => x.key);

/* ───────────────────────── System roles ───────────────────────── */

export const SYSTEM_ROLES = ['superadmin', 'branchadmin', 'sales', 'salesmanager', 'finance', 'teacher', 'student', 'parent'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLES)[number];
export type RoleKey = SystemRoleKey | (string & {});

export const ROLE_META: Record<SystemRoleKey, { label: string; short: string; scopeKind: 'institution' | 'branch' | 'batch' | 'own' | 'child'; surface: 'staff' | 'portal'; position: number }> = {
  superadmin: { label: 'Super Admin', short: 'Super Admin', scopeKind: 'institution', surface: 'staff', position: 1 },
  branchadmin: { label: 'Branch Administrator', short: 'Branch Admin', scopeKind: 'branch', surface: 'staff', position: 2 },
  sales: { label: 'Salesperson', short: 'Sales', scopeKind: 'own', surface: 'staff', position: 3 },
  salesmanager: { label: 'Sales Manager', short: 'Sales Manager', scopeKind: 'branch', surface: 'staff', position: 4 },
  finance: { label: 'Finance Manager', short: 'Finance', scopeKind: 'branch', surface: 'staff', position: 5 },
  teacher: { label: 'Teacher', short: 'Teacher', scopeKind: 'batch', surface: 'portal', position: 6 },
  student: { label: 'Student', short: 'Student', scopeKind: 'own', surface: 'portal', position: 7 },
  parent: { label: 'Parent', short: 'Parent', scopeKind: 'child', surface: 'portal', position: 8 },
};

const sa: Permission[] = ALL_PERMISSIONS.filter((k) => !k.startsWith('portal:') && k !== 'teaching:leave.request');

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleKey, Permission[]> = {
  superadmin: sa,
  branchadmin: [
    'institution:branches.read',
    'institution:settings.read',
    'institution:staff.read',
    'academics:overview.read',
    'academics:courses.read',
    'academics:courses.manage',
    'academics:courses.delete',
    'academics:timetable.read',
    'academics:timetable.manage',
    'academics:leave.approve',
    'academics:students.read',
    'academics:students.manage',
    'sales:leads.read',
    'sales:leads.all',
    'sales:leads.create',
    'sales:leads.update',
    'sales:leads.delete',
    'admissions:read',
    'admissions:create',
    'admissions:update',
    'admissions:approve',
    'finance:feeplans.read',
    'finance:account.read',
    'academics:attendance.read',
    'academics:attendance.override',
    'academics:adhoc.acknowledge',
    'academics:materials.read',
    'academics:marks.read',
    'academics:marks.publish',
    'comms:announcements.manage',
    'comms:announcements.read',
    'comms:announcements.delete',
    'audit:read',
  ],
  sales: [
    'academics:courses.read',
    'academics:timetable.read',
    'sales:leads.read',
    'sales:leads.create',
    'sales:leads.update',
    'sales:followups.manage',
    'sales:import',
    'admissions:read',
    'admissions:create',
    'admissions:update',
    'finance:feeplans.read',
  ],
  salesmanager: [
    'academics:courses.read',
    'academics:timetable.read',
    'sales:leads.read',
    'sales:leads.all',
    'sales:leads.create',
    'sales:leads.update',
    'sales:funnel.read',
    'sales:rules.manage',
    'sales:targets.manage',
    'admissions:read',
    'finance:feeplans.read',
  ],
  finance: [
    'institution:branches.read',
    'institution:settings.read',
    'academics:courses.read',
    'academics:timetable.read',
    'academics:students.read',
    'sales:leads.read',
    'sales:leads.all',
    'admissions:read',
    'admissions:verify_fee',
    'finance:feeplans.read',
    'finance:feeplans.manage',
    'finance:feeplans.update',
    'finance:feeplans.delete',
    'finance:discount.approve',
    'finance:dashboard.read',
    'finance:payment.collect',
    'finance:account.read',
    'finance:invoices.manage',
    'finance:void',
    'finance:dues.manage',
    'finance:daybook.manage',
    'finance:reconcile',
    'finance:settings.manage',
    'finance:exemption.grant',
    'finance:restructure',
    'finance:approve',
    'comms:announcements.manage',
    'comms:announcements.read',
    'audit:read',
  ],
  teacher: [
    'academics:courses.read',
    'academics:timetable.read',
    'teaching:attendance.mark',
    'teaching:assignments.manage',
    'teaching:materials.manage',
    'teaching:materials.delete',
    'teaching:marks.enter',
    'teaching:leave.request',
    'comms:announcements.manage',
    'comms:announcements.read',
  ],
  student: ['portal:student', 'comms:announcements.read'],
  parent: ['portal:parent', 'comms:announcements.read'],
};

/** How a role's scope is shown in the matrix ("R assigned", "R own", "R child"). */
export const SCOPE_SUFFIX: Record<string, string> = { institution: '', branch: '', batch: 'assigned', own: 'own', child: 'child' };

/** Matrix cell text for one role and resource, e.g. "CRUDA", "RA", "R own", "—". */
export function matrixCell(granted: readonly string[], resource: MatrixResource, scopeKind: string): string {
  const letters = new Set<Letter>();
  for (const def of PERMISSIONS) if (def.resource === resource && granted.includes(def.key)) letters.add(def.letter);
  if (letters.size === 0) return '—';
  const s = (['C', 'R', 'U', 'D', 'A'] as Letter[]).filter((l) => letters.has(l)).join('');
  const suffix = SCOPE_SUFFIX[scopeKind];
  return suffix ? `${s} ${suffix}` : s;
}

export function hasPermission(granted: readonly string[], perm: Permission): boolean {
  return granted.includes(perm);
}
