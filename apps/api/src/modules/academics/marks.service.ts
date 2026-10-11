import { Injectable } from '@nestjs/common';
import type { AcadExamDetail, AcadExamRow, AcadTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, type SQL } from '@exatech/db';
import { examMaxTotal, examStats, evaluateMarkRow, formatRelative, todayIST, toISTDate, toISTTime } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { ScopeService } from '../../core/scope.service';

const STATUS: Record<string, { label: string; tag: AcadTag; order: number }> = {
  submitted: { label: 'Submitted · review', tag: 'ink', order: 0 },
  returned: { label: 'Returned', tag: 'outline', order: 1 },
  draft: { label: 'Draft', tag: 'neutral', order: 2 },
  published: { label: 'Published', tag: 'accent', order: 3 },
};

const fmt = (n: number) => String(Math.round(n * 10) / 10);

function submittedLabel(at: Date | null): string {
  if (!at) return '—';
  const today = todayIST();
  const d = toISTDate(at);
  if (d === today) return `Today ${toISTTime(at)}`;
  return formatRelative(at);
}

/** Marks publishing (two-step): teacher submits, Branch Admin publishes or returns. Drafts are never visible to students. */
@Injectable()
export class MarksService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly scope: ScopeService,
  ) {}

  private async grids(examIds: string[]) {
    if (!examIds.length) return { comps: [], marks: [] };
    const comps = await this.db.db.select().from(s.examComponent).where(inArray(s.examComponent.examId, examIds)).orderBy(asc(s.examComponent.position));
    const marks = await this.db.db.select({ examId: s.mark.examId, componentId: s.mark.examComponentId, enrollmentId: s.mark.enrollmentId, value: s.mark.value }).from(s.mark).where(inArray(s.mark.examId, examIds));
    return { comps, marks };
  }

  private async rows(where: SQL | undefined) {
    return this.db.db
      .select({ e: s.exam, batchCode: s.batch.code, teacherName: s.user.name })
      .from(s.exam)
      .innerJoin(s.batch, eq(s.batch.id, s.exam.batchId))
      .innerJoin(s.user, eq(s.user.id, s.exam.teacherUserId))
      .where(where)
      .orderBy(desc(s.exam.date));
  }

  /** Roster = active enrollments of the batch plus anyone who already has marks. */
  private roster(batchId: string, examMarks: { enrollmentId: string }[], active: { id: string; batchId: string }[]) {
    return [...new Set([...active.filter((a) => a.batchId === batchId).map((a) => a.id), ...examMarks.map((m) => m.enrollmentId)])];
  }

  async list(): Promise<{ items: AcadExamRow[]; canPublish: boolean }> {
    const rows = await this.rows(inBranchScope(s.exam.branchId));
    const { comps, marks } = await this.grids(rows.map((r) => r.e.id));
    const batchIds = [...new Set(rows.map((r) => r.e.batchId))];
    const active = batchIds.length ? await this.db.db.select({ id: s.enrollment.id, batchId: s.enrollment.batchId }).from(s.enrollment).where(and(inArray(s.enrollment.batchId, batchIds), eq(s.enrollment.status, 'active'))) : [];
    const items = rows.map((r) => {
      const c = comps.filter((x) => x.examId === r.e.id);
      const m = marks.filter((x) => x.examId === r.e.id);
      const roster = this.roster(r.e.batchId, m, active);
      const defs = c.map((x) => ({ name: x.name, max: x.maxMarks }));
      const grid = roster.map((enr) => c.map((comp) => m.find((x) => x.enrollmentId === enr && x.componentId === comp.id)?.value ?? null));
      const st = examStats(grid, defs);
      const meta = STATUS[r.e.status]!;
      return {
        id: r.e.id,
        name: r.e.name,
        batchId: r.e.batchId,
        batchCode: r.batchCode,
        teacherName: r.teacherName,
        date: r.e.date,
        submittedLabel: submittedLabel(r.e.submittedAt),
        students: roster.length,
        average: st.average == null ? '—' : `${fmt(st.average)} / ${examMaxTotal(defs)}`,
        status: r.e.status,
        statusLabel: meta.label,
        tag: meta.tag,
      };
    });
    items.sort((a, b) => STATUS[a.status]!.order - STATUS[b.status]!.order || b.date.localeCompare(a.date));
    return { items, canPublish: can('academics:marks.publish') };
  }

  async detail(id: string): Promise<AcadExamDetail> {
    const [r] = await this.rows(eq(s.exam.id, id));
    if (!r) throw notFound('Exam');
    assertInScope(r.e.branchId);
    if (!can('academics:marks.read') && !can('academics:marks.publish')) await this.scope.assertTeacherOfBatch(r.e.batchId);
    const { comps, marks } = await this.grids([id]);
    const active = await this.db.db.select({ id: s.enrollment.id, batchId: s.enrollment.batchId }).from(s.enrollment).where(and(eq(s.enrollment.batchId, r.e.batchId), eq(s.enrollment.status, 'active')));
    const roster = this.roster(r.e.batchId, marks, active);
    const people = roster.length
      ? await this.db.db
          .select({ enrollmentId: s.enrollment.id, studentId: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo })
          .from(s.enrollment)
          .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
          .where(inArray(s.enrollment.id, roster))
      : [];
    const defs = comps.map((c) => ({ name: c.name, max: c.maxMarks }));
    const maxTotal = examMaxTotal(defs);
    const rows = people
      .map((p) => {
        const values = comps.map((c) => marks.find((m) => m.enrollmentId === p.enrollmentId && m.componentId === c.id)?.value ?? null);
        const ev = evaluateMarkRow(values, defs);
        return { ...p, values, total: ev.complete ? ev.total : null, pct: maxTotal > 0 && ev.complete ? Math.round((ev.total / maxTotal) * 100) : 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const st = examStats(
      rows.map((x) => x.values),
      defs,
    );
    const meta = STATUS[r.e.status]!;
    return {
      id: r.e.id,
      name: r.e.name,
      batchId: r.e.batchId,
      batchCode: r.batchCode,
      teacherName: r.teacherName,
      date: r.e.date,
      submittedLabel: submittedLabel(r.e.submittedAt),
      students: rows.length,
      average: st.average == null ? '—' : `${fmt(st.average)} / ${maxTotal}`,
      status: r.e.status,
      statusLabel: meta.label,
      tag: meta.tag,
      components: comps.map((c) => ({ id: c.id, name: c.name, max: c.maxMarks })),
      maxTotal,
      stats: st,
      rows,
      returnNote: r.e.returnNote,
      canPublish: r.e.status === 'submitted' && can('academics:marks.publish'),
    };
  }

  async publish(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [e] = await tx.select().from(s.exam).where(eq(s.exam.id, id)).for('update');
      if (!e) throw notFound('Exam');
      assertInScope(e.branchId);
      if (e.status !== 'submitted') throw conflict(e.status === 'published' ? 'These marks are already published' : `Only submitted marks can be published — this exam is ${e.status}`);
      const c = ctx();
      await tx.update(s.exam).set({ status: 'published', publishedAt: new Date(), publishedBy: c.userId }).where(eq(s.exam.id, id));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, e.batchId));
      const comps = await tx.select().from(s.examComponent).where(eq(s.examComponent.examId, id));
      const marks = await tx.select({ enrollmentId: s.mark.enrollmentId, value: s.mark.value }).from(s.mark).where(eq(s.mark.examId, id));
      const maxTotal = comps.reduce((a, x) => a + x.maxMarks, 0);
      const enrIds = [...new Set(marks.map((m) => m.enrollmentId))];
      const people = enrIds.length
        ? await tx
            .select({ enrollmentId: s.enrollment.id, studentId: s.student.id, name: s.student.name, userId: s.student.userId })
            .from(s.enrollment)
            .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
            .where(inArray(s.enrollment.id, enrIds))
        : [];
      const links = people.length
        ? await tx
            .select({ studentId: s.studentGuardian.studentId, userId: s.guardian.userId })
            .from(s.studentGuardian)
            .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
            .where(inArray(s.studentGuardian.studentId, people.map((p) => p.studentId)))
        : [];
      for (const p of people) {
        const score = marks.filter((m) => m.enrollmentId === p.enrollmentId).reduce((a, m) => a + (m.value ?? 0), 0);
        const scoreText = `${fmt(score)} / ${maxTotal}`;
        const userIds = [p.userId, ...links.filter((l) => l.studentId === p.studentId).map((l) => l.userId)].filter((x): x is string => !!x);
        await this.notify.notify(tx, {
          userIds,
          category: 'marks',
          title: `Marks published · ${e.name}`,
          body: `${p.name} · ${b?.code ?? ''} · ${scoreText}`,
          link: '/student/marks',
          entityType: 'exam',
          entityId: id,
          whatsapp: { template: 'marks_published', body: `Marks published for ${p.name}: ${e.name} — ${scoreText}. View details in the portal.` },
        });
      }
      await this.notify.notify(tx, { userIds: [e.teacherUserId], category: 'marks', title: `Published · ${e.name}`, body: `${b?.code ?? ''} · visible to students & parents`, link: '/teacher/marks', entityType: 'exam', entityId: id });
      await this.events.emit(tx, 'MarksPublished', { examId: id, branchId: e.branchId, batchId: e.batchId });
      await this.audit.log(tx, {
        action: 'Marks published',
        kind: 'publish',
        entityType: 'exam',
        entityId: id,
        entityLabel: `${b?.code ?? ''}/${e.name}`,
        before: { status: 'submitted' },
        after: { status: 'published' },
        summary: `submitted → published · ${e.name} · ${b?.code ?? ''} · ${people.length} rows · students & parents notified`,
        branchId: e.branchId,
      });
      this.notify.invalidate(tx, e.branchId, [['academics'], ['teaching'], ['portal']]);
    });
  }

  async returnExam(id: string, note: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [e] = await tx.select().from(s.exam).where(eq(s.exam.id, id)).for('update');
      if (!e) throw notFound('Exam');
      assertInScope(e.branchId);
      if (e.status !== 'submitted') throw conflict(`Only submitted marks can be returned — this exam is ${e.status}`);
      const c = ctx();
      await tx.update(s.exam).set({ status: 'returned', returnNote: note, returnedAt: new Date(), returnedBy: c.userId }).where(eq(s.exam.id, id));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, e.batchId));
      await this.events.emit(tx, 'MarksReturned', { examId: id, branchId: e.branchId, batchId: e.batchId, note });
      await this.audit.log(tx, {
        action: 'Marks returned',
        kind: 'update',
        entityType: 'exam',
        entityId: id,
        entityLabel: `${b?.code ?? ''}/${e.name}`,
        before: { status: 'submitted' },
        after: { status: 'returned', note },
        summary: `submitted → returned · ${e.name} · ${b?.code ?? ''} · ${note}`,
        branchId: e.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [e.teacherUserId],
        category: 'marks',
        title: `Marks returned · ${e.name}`,
        body: `${b?.code ?? ''} · ${note}`,
        link: '/teacher/marks',
        entityType: 'exam',
        entityId: id,
      });
      this.notify.invalidate(tx, e.branchId, [['academics'], ['teaching']]);
    });
  }
}
