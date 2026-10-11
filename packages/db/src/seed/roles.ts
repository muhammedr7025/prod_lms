/**
 * Mirror of the role defaults in @exatech/contracts (kept zod-free for the db
 * package). A contracts test asserts these stay identical.
 */
export const ROLE_META_SEED = {
  superadmin: { label: 'Super Admin', description: 'Institution owner: settings, branches, roles, approvals, audit', scopeKind: 'institution', surface: 'staff', position: 1 },
  branchadmin: { label: 'Branch Administrator', description: 'Operations within assigned branches', scopeKind: 'branch', surface: 'staff', position: 2 },
  sales: { label: 'Salesperson', description: 'Own leads, follow-ups, admission handoff', scopeKind: 'own', surface: 'staff', position: 3 },
  salesmanager: { label: 'Sales Manager', description: 'Funnel, assignment rules, targets', scopeKind: 'branch', surface: 'staff', position: 4 },
  finance: { label: 'Finance Manager', description: 'Collections, invoices, dues, reconciliation', scopeKind: 'branch', surface: 'staff', position: 5 },
  teacher: { label: 'Teacher', description: 'Assigned batches: attendance, marks, assignments, notes', scopeKind: 'batch', surface: 'portal', position: 6 },
  student: { label: 'Student', description: 'Own enrollment', scopeKind: 'own', surface: 'portal', position: 7 },
  parent: { label: 'Parent', description: 'Linked children', scopeKind: 'child', surface: 'portal', position: 8 },
} as const;

const ALL = [
  'institution:overview.read', 'institution:branches.read', 'institution:branches.manage', 'institution:settings.read', 'institution:settings.manage',
  'institution:roles.manage', 'institution:staff.read', 'institution:staff.manage', 'institution:approvals.decide', 'institution:impersonate',
  'institution:branches.delete', 'academics:overview.read', 'academics:courses.read', 'academics:courses.manage', 'academics:courses.delete',
  'academics:timetable.read', 'academics:timetable.manage', 'academics:leave.approve', 'academics:students.read', 'academics:students.manage',
  'sales:leads.read', 'sales:leads.create', 'sales:leads.update', 'sales:leads.delete', 'sales:leads.all', 'sales:followups.manage', 'sales:import',
  'sales:funnel.read', 'sales:rules.manage', 'sales:targets.manage', 'admissions:read', 'admissions:create', 'admissions:update', 'admissions:delete',
  'admissions:approve', 'admissions:verify_fee', 'finance:feeplans.read', 'finance:feeplans.manage', 'finance:feeplans.update', 'finance:feeplans.delete',
  'finance:discount.approve', 'finance:dashboard.read', 'finance:payment.collect', 'finance:account.read', 'finance:invoices.manage', 'finance:void',
  'finance:dues.manage', 'finance:daybook.manage', 'finance:reconcile', 'finance:settings.manage', 'finance:exemption.grant', 'finance:restructure',
  'finance:approve', 'teaching:attendance.mark', 'academics:attendance.override', 'academics:adhoc.acknowledge', 'academics:attendance.read',
  'teaching:assignments.manage', 'teaching:materials.manage', 'academics:materials.read', 'teaching:materials.delete', 'teaching:marks.enter',
  'academics:marks.read', 'academics:marks.publish', 'comms:announcements.manage', 'comms:announcements.read', 'comms:announcements.delete',
  'audit:read', 'audit:export', 'teaching:leave.request', 'portal:student', 'portal:parent',
];

export const DEFAULT_ROLE_PERMISSIONS_SEED: Record<keyof typeof ROLE_META_SEED, string[]> = {
  superadmin: ALL.filter((k) => !k.startsWith('portal:') && k !== 'teaching:leave.request'),
  branchadmin: [
    'institution:branches.read', 'institution:settings.read', 'institution:staff.read', 'academics:overview.read', 'academics:courses.read',
    'academics:courses.manage', 'academics:courses.delete', 'academics:timetable.read', 'academics:timetable.manage', 'academics:leave.approve',
    'academics:students.read', 'academics:students.manage', 'sales:leads.read', 'sales:leads.all', 'sales:leads.create', 'sales:leads.update',
    'sales:leads.delete', 'admissions:read', 'admissions:create', 'admissions:update', 'admissions:approve', 'finance:feeplans.read',
    'finance:account.read', 'academics:attendance.read', 'academics:attendance.override', 'academics:adhoc.acknowledge', 'academics:materials.read',
    'academics:marks.read', 'academics:marks.publish', 'comms:announcements.manage', 'comms:announcements.read', 'comms:announcements.delete', 'audit:read',
  ],
  sales: [
    'academics:courses.read', 'academics:timetable.read', 'sales:leads.read', 'sales:leads.create', 'sales:leads.update', 'sales:followups.manage',
    'sales:import', 'admissions:read', 'admissions:create', 'admissions:update', 'finance:feeplans.read',
  ],
  salesmanager: [
    'academics:courses.read', 'academics:timetable.read', 'sales:leads.read', 'sales:leads.all', 'sales:leads.create', 'sales:leads.update',
    'sales:funnel.read', 'sales:rules.manage', 'sales:targets.manage', 'admissions:read', 'finance:feeplans.read',
  ],
  finance: [
    'institution:branches.read', 'institution:settings.read', 'academics:courses.read', 'academics:timetable.read', 'academics:students.read',
    'sales:leads.read', 'sales:leads.all', 'admissions:read', 'admissions:verify_fee', 'finance:feeplans.read', 'finance:feeplans.manage',
    'finance:feeplans.update', 'finance:feeplans.delete', 'finance:discount.approve', 'finance:dashboard.read', 'finance:payment.collect',
    'finance:account.read', 'finance:invoices.manage', 'finance:void', 'finance:dues.manage', 'finance:daybook.manage', 'finance:reconcile',
    'finance:settings.manage', 'finance:exemption.grant', 'finance:restructure', 'finance:approve', 'comms:announcements.manage',
    'comms:announcements.read', 'audit:read',
  ],
  teacher: [
    'academics:courses.read', 'academics:timetable.read', 'teaching:attendance.mark', 'teaching:assignments.manage', 'teaching:materials.manage',
    'teaching:materials.delete', 'teaching:marks.enter', 'teaching:leave.request', 'comms:announcements.manage', 'comms:announcements.read',
  ],
  student: ['portal:student', 'comms:announcements.read'],
  parent: ['portal:parent', 'comms:announcements.read'],
};
