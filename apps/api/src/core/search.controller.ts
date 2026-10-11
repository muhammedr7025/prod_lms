import { Controller } from '@nestjs/common';
import { canSee, SCREENS, searchContract, type ScreenDef, type SearchItem } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, eq, ilike, inArray, or, sql } from '@exatech/db';
import { formatINR, maskPhone } from '@exatech/domain';
import { can, ctx } from './context';
import { Db, inBranchScope } from './db';
import { Endpoint, Input, type Args } from './http';

const ACTIONS: { label: string; screen: keyof typeof SCREENS; href?: string }[] = [
  { label: 'Collect a payment', screen: 'desk' },
  { label: 'New lead', screen: 'pipeline', href: '/sales/pipeline?new=1' },
  { label: 'Import leads', screen: 'import' },
  { label: 'New admission', screen: 'admit' },
  { label: 'Add timetable session', screen: 'timetable', href: '/timetable?add=1' },
  { label: 'New announcement', screen: 'announce' },
  { label: 'Publish marks', screen: 'publish' },
  { label: 'Close the day', screen: 'daybook' },
  { label: 'Invite staff', screen: 'staff', href: '/staff?invite=1' },
  { label: 'Export audit log', screen: 'audit' },
  { label: 'Mark attendance', screen: 'attendance' },
];

/** ⌘K palette: students, leads, invoices, batches, teachers, branches, exams and actions — scope respected. */
@Controller()
export class SearchController {
  constructor(private readonly db: Db) {}

  @Endpoint(searchContract.search)
  async search(@Input() { query }: Args<typeof searchContract.search>): Promise<{ items: SearchItem[] }> {
    const q = query.q.trim();
    const c = ctx();
    const perms = [...c.permissions];
    const items: SearchItem[] = [];
    const actions = ACTIONS.filter((a) => canSee(SCREENS[a.screen] as ScreenDef, perms) && (!q || a.label.toLowerCase().includes(q.toLowerCase())));
    const screens = (Object.values(SCREENS) as ScreenDef[]).filter((sc) => canSee(sc, perms) && sc.surface === 'staff' && q && sc.label.toLowerCase().includes(q.toLowerCase()));

    if (q.length >= 2) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const tasks: Promise<void>[] = [];
      if (can('academics:students.read') || can('finance:account.read')) {
        tasks.push(
          this.db.db
            .select({ id: s.student.id, name: s.student.name, adm: s.student.admissionNo, phone: s.student.phone, batch: s.batch.code })
            .from(s.student)
            .leftJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
            .leftJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
            .where(and(inBranchScope(s.student.branchId), or(ilike(s.student.name, like), ilike(s.student.admissionNo, like), ilike(s.student.phone, like))))
            .limit(6)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Student', label: r.name, meta: [r.batch, r.adm, maskPhone(r.phone)].filter(Boolean).join(' · '), href: null, drawer: { entity: 'student', id: r.id } });
            }),
        );
      }
      if (can('sales:leads.read')) {
        tasks.push(
          this.db.db
            .select({ id: s.lead.id, name: s.lead.name, stage: s.lead.stage, phone: s.lead.phone, source: s.lead.source })
            .from(s.lead)
            .where(and(inBranchScope(s.lead.branchId), can('sales:leads.all') ? undefined : eq(s.lead.ownerUserId, c.userId), or(ilike(s.lead.name, like), ilike(s.lead.phone, like), ilike(s.lead.email, like))))
            .limit(5)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Lead', label: r.name, meta: `${r.stage.replace(/_/g, ' ')} · ${r.source} · ${maskPhone(r.phone)}`, href: `/sales/leads?lead=${r.id}`, drawer: null });
            }),
        );
      }
      if (can('finance:invoices.manage') || can('finance:account.read')) {
        tasks.push(
          this.db.db
            .select({ id: s.invoice.id, number: s.invoice.number, total: s.invoice.total, status: s.invoice.status, student: s.student.name, enrollmentId: s.invoice.enrollmentId })
            .from(s.invoice)
            .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
            .where(and(inBranchScope(s.invoice.branchId), ilike(s.invoice.number, like)))
            .limit(5)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Invoice', label: r.number, meta: `${r.student} · ${formatINR(r.total)} · ${r.status.replace(/_/g, ' ')}`, href: `/finance/accounts/${r.enrollmentId}`, drawer: null });
            }),
        );
      }
      if (can('academics:courses.read')) {
        tasks.push(
          this.db.db
            .select({ id: s.batch.id, code: s.batch.code, status: s.batch.status, course: s.course.name })
            .from(s.batch)
            .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
            .where(and(inBranchScope(s.batch.branchId), or(ilike(s.batch.code, like), ilike(s.course.name, like))))
            .limit(5)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Batch', label: r.code, meta: `${r.course} · ${r.status}`, href: `/batches?batch=${r.code}`, drawer: null });
            }),
        );
      }
      if (can('institution:staff.read') || can('academics:courses.read')) {
        tasks.push(
          this.db.db
            .selectDistinct({ id: s.user.id, name: s.user.name, title: s.staffProfile.title })
            .from(s.user)
            .innerJoin(s.staffProfile, eq(s.staffProfile.userId, s.user.id))
            .where(and(eq(s.user.kind, 'staff'), ilike(s.user.name, like)))
            .limit(5)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Teacher', label: r.name, meta: r.title ?? 'Staff', href: null, drawer: { entity: 'teacher', id: r.id } });
            }),
        );
      }
      if (can('institution:branches.read')) {
        tasks.push(
          this.db.db
            .select({ id: s.branch.id, name: s.branch.name, code: s.branch.code, city: s.branch.city })
            .from(s.branch)
            .where(or(ilike(s.branch.name, like), ilike(s.branch.code, like)))
            .limit(3)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Branch', label: r.name, meta: `${r.code} · ${r.city ?? ''}`, href: null, drawer: { entity: 'branch', id: r.id } });
            }),
        );
      }
      if (can('academics:marks.read') || can('academics:marks.publish')) {
        tasks.push(
          this.db.db
            .select({ id: s.exam.id, name: s.exam.name, status: s.exam.status, batch: s.batch.code })
            .from(s.exam)
            .innerJoin(s.batch, eq(s.batch.id, s.exam.batchId))
            .where(and(inBranchScope(s.exam.branchId), inArray(s.exam.status, ['submitted', 'published', 'returned', 'draft']), or(ilike(s.exam.name, like), ilike(s.batch.code, like))))
            .limit(4)
            .then((rows) => {
              for (const r of rows) items.push({ kind: 'Exam', label: r.name, meta: `${r.batch} · ${r.status}`, href: null, drawer: { entity: 'exam', id: r.id } });
            }),
        );
      }
      await Promise.all(tasks);
    }

    for (const sc of screens.slice(0, 4)) items.push({ kind: 'Action', label: `Go to ${sc.label}`, meta: sc.path, href: sc.path, drawer: null });
    for (const a of actions.slice(0, q ? 6 : 8)) items.push({ kind: 'Action', label: a.label, meta: SCREENS[a.screen].label, href: a.href ?? SCREENS[a.screen].path, drawer: null });
    void sql;
    return { items: items.slice(0, 24) };
  }
}
