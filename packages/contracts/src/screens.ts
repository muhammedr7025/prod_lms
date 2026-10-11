import type { Permission, SystemRoleKey } from './permissions';

export type IconKey =
  | 'grid'
  | 'building'
  | 'shield'
  | 'list'
  | 'sliders'
  | 'users'
  | 'calendar'
  | 'book'
  | 'check'
  | 'megaphone'
  | 'kanban'
  | 'table'
  | 'bell'
  | 'upload'
  | 'rupee'
  | 'scan'
  | 'receipt'
  | 'clock'
  | 'file'
  | 'clipboard'
  | 'home'
  | 'award'
  | 'trending'
  | 'chart'
  | 'refresh';

export interface ScreenDef {
  key: string;
  path: string;
  label: string;
  icon: IconKey;
  /** Any one of these grants access. */
  perms: Permission[];
  surface: 'staff' | 'portal';
}

const s = (key: string, path: string, label: string, icon: IconKey, perms: Permission[], surface: 'staff' | 'portal' = 'staff'): ScreenDef => ({
  key,
  path,
  label,
  icon,
  perms,
  surface,
});

/** Every screen in the product. Route guards and the sidebar both read this. */
export const SCREENS = {
  // Institution
  dashboard: s('dashboard', '/overview', 'Overview', 'grid', ['institution:overview.read']),
  branches: s('branches', '/branches', 'Branches', 'building', ['institution:branches.read']),
  staff: s('staff', '/staff', 'Staff & teachers', 'users', ['institution:staff.read']),
  roles: s('roles', '/roles', 'Roles & permissions', 'shield', ['institution:roles.manage']),
  audit: s('audit', '/audit', 'Audit log', 'list', ['audit:read']),
  settings: s('settings', '/settings', 'Settings', 'sliders', ['institution:settings.manage']),
  // Academics
  bdash: s('bdash', '/branch', 'Branch operations', 'grid', ['academics:overview.read']),
  batches: s('batches', '/batches', 'Courses & batches', 'book', ['academics:courses.read']),
  timetable: s('timetable', '/timetable', 'Timetable', 'calendar', ['academics:timetable.manage']),
  admissions: s('admissions', '/admissions', 'Admissions', 'check', ['admissions:approve']),
  students: s('students', '/students', 'Students', 'users', ['academics:students.read']),
  notesAdmin: s('notesAdmin', '/notes', 'Notes & material', 'file', ['academics:materials.read']),
  publish: s('publish', '/marks-publishing', 'Marks publishing', 'award', ['academics:marks.publish']),
  announce: s('announce', '/announcements', 'Announcements', 'megaphone', ['comms:announcements.manage']),
  // Sales
  funnel: s('funnel', '/sales/funnel', 'Funnel', 'chart', ['sales:funnel.read']),
  pipeline: s('pipeline', '/sales/pipeline', 'Pipeline', 'kanban', ['sales:leads.read']),
  leads: s('leads', '/sales/leads', 'Leads', 'table', ['sales:leads.read']),
  followups: s('followups', '/sales/follow-ups', 'Follow-ups', 'clock', ['sales:followups.manage']),
  import: s('import', '/sales/import', 'Import leads', 'upload', ['sales:import']),
  admit: s('admit', '/sales/admission', 'New admission', 'check', ['admissions:create']),
  assign: s('assign', '/sales/assignment-rules', 'Assignment rules', 'users', ['sales:rules.manage']),
  leaderboard: s('leaderboard', '/sales/leaderboard', 'Targets & leaderboard', 'trending', ['sales:targets.manage']),
  // Finance
  fdash: s('fdash', '/finance', 'Finance dashboard', 'grid', ['finance:dashboard.read']),
  desk: s('desk', '/finance/desk', 'Collection desk', 'scan', ['finance:payment.collect']),
  account: s('account', '/finance/accounts', 'Student fee account', 'rupee', ['finance:account.read']),
  invoices: s('invoices', '/finance/invoices', 'Invoices & receipts', 'receipt', ['finance:invoices.manage']),
  dues: s('dues', '/finance/dues', 'Dues & follow-up', 'clock', ['finance:dues.manage']),
  daybook: s('daybook', '/finance/day-book', 'Day book & closing', 'book', ['finance:daybook.manage']),
  reconcile: s('reconcile', '/finance/reconciliation', 'Reconciliation', 'refresh', ['finance:reconcile']),
  fsettings: s('fsettings', '/finance/settings', 'Finance settings', 'sliders', ['finance:settings.manage']),
  // Teacher (mobile-first)
  today: s('today', '/teacher', 'Today', 'home', ['teaching:attendance.mark'], 'portal'),
  attendance: s('attendance', '/teacher/attendance', 'Attendance', 'clipboard', ['teaching:attendance.mark'], 'portal'),
  assignments: s('assignments', '/teacher/assignments', 'Assignments', 'file', ['teaching:assignments.manage'], 'portal'),
  materials: s('materials', '/teacher/notes', 'Notes', 'book', ['teaching:materials.manage'], 'portal'),
  marks: s('marks', '/teacher/marks', 'Marks', 'award', ['teaching:marks.enter'], 'portal'),
  // Student
  shome: s('shome', '/student', 'Home', 'home', ['portal:student'], 'portal'),
  stimetable: s('stimetable', '/student/timetable', 'Timetable', 'calendar', ['portal:student'], 'portal'),
  snotes: s('snotes', '/student/notes', 'Notes', 'book', ['portal:student'], 'portal'),
  swork: s('swork', '/student/work', 'Work', 'file', ['portal:student'], 'portal'),
  smarks: s('smarks', '/student/marks', 'Marks', 'award', ['portal:student'], 'portal'),
  sfees: s('sfees', '/student/fees', 'Fees', 'rupee', ['portal:student'], 'portal'),
  // Parent
  phome: s('phome', '/parent', 'Home', 'home', ['portal:parent'], 'portal'),
  pattend: s('pattend', '/parent/attendance', 'Attendance', 'clipboard', ['portal:parent'], 'portal'),
  pmarks: s('pmarks', '/parent/marks', 'Marks', 'award', ['portal:parent'], 'portal'),
  pfees: s('pfees', '/parent/fees', 'Fees', 'rupee', ['portal:parent'], 'portal'),
  palerts: s('palerts', '/parent/alerts', 'Alerts', 'bell', ['portal:parent'], 'portal'),
} as const satisfies Record<string, ScreenDef>;

export type ScreenKey = keyof typeof SCREENS;

/** Group heading or a screen key — mirrors the prototype's sidebar per role. */
export type NavEntry = { head: string } | ScreenKey;

export const ROLE_NAV: Record<SystemRoleKey, NavEntry[]> = {
  superadmin: [
    { head: 'Institution' }, 'dashboard', 'branches', 'staff', 'roles', 'audit', 'settings',
    { head: 'Academics' }, 'bdash', 'batches', 'timetable', 'admissions', 'students', 'notesAdmin', 'publish', 'announce',
    { head: 'Sales' }, 'funnel', 'pipeline', 'leads', 'leaderboard',
    { head: 'Finance' }, 'fdash', 'desk', 'invoices', 'dues', 'daybook', 'reconcile',
  ],
  branchadmin: [
    { head: 'Operations' }, 'bdash', 'staff', 'announce',
    { head: 'Academics' }, 'batches', 'timetable', 'admissions', 'students', 'notesAdmin', 'publish',
    { head: 'Sales' }, 'pipeline', 'leads',
  ],
  sales: [{ head: 'Sales' }, 'pipeline', 'leads', 'followups', 'import', 'admit'],
  salesmanager: [{ head: 'Sales' }, 'funnel', 'pipeline', 'leads', 'assign', 'leaderboard'],
  finance: [{ head: 'Finance' }, 'fdash', 'desk', 'account', 'invoices', 'dues', 'daybook', 'reconcile', 'fsettings'],
  teacher: ['today', 'attendance', 'assignments', 'materials', 'marks'],
  student: ['shome', 'stimetable', 'snotes', 'swork', 'smarks', 'sfees'],
  parent: ['phome', 'pattend', 'pmarks', 'pfees', 'palerts'],
};

export const ROLE_HOME: Record<SystemRoleKey, ScreenKey> = {
  superadmin: 'dashboard',
  branchadmin: 'bdash',
  sales: 'pipeline',
  salesmanager: 'funnel',
  finance: 'fdash',
  teacher: 'today',
  student: 'shome',
  parent: 'phome',
};

/** Order screens for custom roles (permission-derived nav). */
export const NAV_GROUPS: { head: string; keys: ScreenKey[] }[] = [
  { head: 'Institution', keys: ['dashboard', 'branches', 'staff', 'roles', 'audit', 'settings'] },
  { head: 'Academics', keys: ['bdash', 'batches', 'timetable', 'admissions', 'students', 'notesAdmin', 'publish', 'announce'] },
  { head: 'Sales', keys: ['funnel', 'pipeline', 'leads', 'followups', 'import', 'admit', 'assign', 'leaderboard'] },
  { head: 'Finance', keys: ['fdash', 'desk', 'account', 'invoices', 'dues', 'daybook', 'reconcile', 'fsettings'] },
];

export function canSee(screen: ScreenDef, permissions: readonly string[]): boolean {
  return screen.perms.some((perm) => permissions.includes(perm));
}

/** Find the screen that owns a pathname (longest matching prefix). */
export function screenForPath(pathname: string): ScreenDef | null {
  let best: ScreenDef | null = null;
  for (const sc of Object.values(SCREENS) as ScreenDef[]) {
    if (pathname === sc.path || pathname.startsWith(sc.path + '/')) {
      if (!best || sc.path.length > best.path.length) best = sc;
    }
  }
  return best;
}
