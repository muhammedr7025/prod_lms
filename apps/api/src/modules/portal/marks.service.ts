import { Injectable } from '@nestjs/common';
import { DOCUMENT_PATHS, type MarkItem, type PortalMarks } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, sql } from '@exatech/db';
import { examStats, formatDate, formatDayMonth, formatWeekdayDate, gradeFor, todayIST, type GradeBand } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, can, ctx } from '../../core/context';
import { DocumentKit, MUTED } from '../../core/documents/document-kit';
import { forbidden, invalid, notFound } from '../../core/errors';
import { ScopeService, type StudentScope } from '../../core/scope.service';
import { PortalShared } from './portal.shared';

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Student / Parent · Marks (published only) and the report card PDF. */
@Injectable()
export class MarksService {
  constructor(
    private readonly shared: PortalShared,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Published exams for an enrollment with the student's score, batch average and grade. Drafts never leave the server. */
  async published(sc: Pick<StudentScope, 'batchId' | 'enrollmentId'>): Promise<(MarkItem & { date: string })[]> {
    const db = this.shared.db.db;
    const exams = await db
      .select({ id: s.exam.id, name: s.exam.name, date: s.exam.date, scheme: s.course.gradeScheme })
      .from(s.exam)
      .innerJoin(s.batch, eq(s.batch.id, s.exam.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(and(eq(s.exam.batchId, sc.batchId), eq(s.exam.status, 'published')))
      .orderBy(desc(s.exam.date));
    if (exams.length === 0) return [];
    const ids = exams.map((e) => e.id);
    const [comps, marks] = await Promise.all([
      db.select().from(s.examComponent).where(inArray(s.examComponent.examId, ids)).orderBy(asc(s.examComponent.position)),
      db.select({ examId: s.mark.examId, componentId: s.mark.examComponentId, enrollmentId: s.mark.enrollmentId, value: s.mark.value }).from(s.mark).where(inArray(s.mark.examId, ids)),
    ]);
    const out: (MarkItem & { date: string })[] = [];
    for (const e of exams) {
      const ec = comps.filter((c) => c.examId === e.id);
      const defs = ec.map((c) => ({ name: c.name, max: c.maxMarks }));
      const em = marks.filter((m) => m.examId === e.id);
      const valueOf = (enr: string, compId: string) => em.find((m) => m.enrollmentId === enr && m.componentId === compId)?.value ?? null;
      const mine = ec.map((c) => valueOf(sc.enrollmentId, c.id));
      if (mine.every((v) => v == null)) continue; // not on this exam's roster
      const enrollments = [...new Set(em.map((m) => m.enrollmentId))];
      const stats = examStats(
        enrollments.map((enr) => ec.map((c) => valueOf(enr, c.id))),
        defs,
      );
      const max = defs.reduce((a, c) => a + c.max, 0);
      const score = mine.reduce<number>((a, v) => a + (v ?? 0), 0);
      const pct = max ? Math.round((score / max) * 100) : 0;
      const grade = gradeFor(pct, (e.scheme as GradeBand[] | null) ?? undefined);
      out.push({
        examId: e.id,
        date: e.date,
        when: formatWeekdayDate(e.date),
        name: e.name,
        score,
        max,
        pct,
        grade,
        meta: `Batch average ${stats.average == null ? '—' : fmt(stats.average)} · ${grade}`,
        components: ec.map((c, i) => ({ name: c.name, score: mine[i] ?? null, max: c.maxMarks })),
      });
    }
    return out;
  }

  async marks(studentId?: string): Promise<PortalMarks> {
    const sc = await this.shared.resolve(studentId);
    const items = await this.published(sc);
    const today = todayIST();
    const [next] = await this.shared.db.db
      .select({ name: s.exam.name, date: s.exam.date })
      .from(s.exam)
      .where(and(eq(s.exam.batchId, sc.batchId), sql`${s.exam.status} <> 'published'`, sql`${s.exam.date} >= ${today}::date`))
      .orderBy(asc(s.exam.date))
      .limit(1);
    const trend = items
      .slice(0, 6)
      .reverse()
      .map((m) => ({ label: m.name.split(' · ')[0] ?? m.name, pct: m.pct }));
    return {
      kicker: ctx().roleKey === 'parent' ? `${sc.name} · published only` : 'Published only · draft marks are never shown',
      items,
      trend,
      nextExam: next ? `${next.name.split(' · ')[0]} · ${formatDayMonth(next.date)}` : null,
      reportCardUrl: items.length ? DOCUMENT_PATHS.reportCard(sc.enrollmentId) : null,
      note: items.length ? 'Report card includes every published exam and attendance · certificate on completion' : 'Report card and certificate download once the first exam is published',
    };
  }

  /** Report card PDF: student, batch, published exams with components, %, grade, attendance. */
  async reportCard(enrollmentId: string): Promise<{ buffer: Buffer; filename: string }> {
    const db = this.shared.db.db;
    const [row] = await db
      .select({ enr: s.enrollment, student: s.student, batchCode: s.batch.code, batchName: s.batch.name, courseName: s.course.name, scheme: s.course.gradeScheme, branchName: s.branch.name, branchCity: s.branch.city })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .innerJoin(s.branch, eq(s.branch.id, s.enrollment.branchId))
      .where(eq(s.enrollment.id, enrollmentId));
    if (!row) throw notFound('Report card');
    // Staff (branch scope) or the student / parent who owns the enrollment.
    if (can('academics:students.read')) {
      const sc = branchScope();
      if (sc && !sc.includes(row.enr.branchId)) throw forbidden('This student is outside the selected branch');
    } else {
      const mine = ctx().roleKey === 'parent' ? await this.scope.parentChildren() : await this.scope.studentEnrollments();
      if (!mine.some((m) => m.enrollmentId === enrollmentId)) throw forbidden('This report card belongs to another account');
    }
    const items = await this.published({ batchId: row.enr.batchId, enrollmentId });
    if (items.length === 0) throw invalid('The report card is available once the first exam is published');
    const att = await this.shared.attendance(enrollmentId);
    const inst = await this.shared.institution();
    const today = todayIST();

    const kit = await DocumentKit.create('A4', { title: `Report card · ${row.student.name}` });
    kit.header({ institution: inst.name, branch: { name: `${inst.name} · ${row.branchName}`, lines: row.branchCity && row.branchCity !== row.branchName ? [row.branchCity] : [] }, title: 'Report card', number: row.student.admissionNo ?? undefined, date: formatDate(today) });
    kit.keyValues([
      ['Student', row.student.name],
      ['Admission no.', row.student.admissionNo ?? '—'],
      ['Course', row.courseName],
      ['Batch', row.batchName && !row.batchName.includes(row.batchCode) ? `${row.batchCode} · ${row.batchName}` : row.batchCode],
      ['Attendance', att.total ? `${att.pct}% · ${att.attended} of ${att.total} sessions (threshold ${att.threshold}%)` : 'No sessions marked yet'],
    ]);
    kit.gap(4).text('Published exams', { bold: true, size: 11 }).gap(2);
    kit.table(
      [
        { label: 'Exam', width: 0.3 },
        { label: 'Date', width: 0.12 },
        { label: 'Components', width: 0.3 },
        { label: 'Score', width: 0.1, align: 'right' },
        { label: '%', width: 0.08, align: 'right' },
        { label: 'Grade', width: 0.1, align: 'right' },
      ],
      [...items].reverse().map((m) => [
        m.name,
        formatDayMonth(m.date),
        m.components.map((c) => `${c.name} ${c.score == null ? '—' : fmt(c.score)}/${fmt(c.max)}`).join(' · '),
        `${fmt(m.score)} / ${fmt(m.max)}`,
        `${m.pct}%`,
        m.grade,
      ]),
    );
    const totalScore = items.reduce((a, m) => a + m.score, 0);
    const totalMax = items.reduce((a, m) => a + m.max, 0);
    const overall = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;
    kit.keyValues([
      ['Overall', `${fmt(totalScore)} / ${fmt(totalMax)} · ${overall}% · grade ${gradeFor(overall, (row.scheme as GradeBand[] | null) ?? undefined)}`],
      ['Batch averages', items.map((m) => `${m.name.split(' · ')[0]}: ${m.meta.replace(/^Batch average /, '').split(' · ')[0]}`).join(' · ')],
    ]);
    kit.gap(6).text('Marks shown are published by the Branch Administrator. Draft marks are never included.', { size: 8, color: MUTED });
    kit.footer(`${inst.name} · report card · ${row.student.name} · ${row.student.admissionNo ?? ''} · generated ${formatDate(today)}`);
    const buffer = await kit.save();
    await this.audit.log(db, {
      action: 'Report card downloaded',
      kind: 'export',
      entityType: 'enrollment',
      entityId: enrollmentId,
      entityLabel: `${row.student.name} · ${row.batchCode}`,
      summary: `Report card PDF · ${items.length} published exam${items.length === 1 ? '' : 's'}`,
      branchId: row.enr.branchId,
    });
    return { buffer, filename: `report-card-${(row.student.admissionNo ?? row.student.id).replace(/[^\w-]+/g, '_')}.pdf` };
  }
}
