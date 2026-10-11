import { Injectable } from '@nestjs/common';
import { TEACH_LATE_POLICIES, type TeachAssignmentCard, type TeachGrading, type TeachTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, isNull, sql } from '@exatech/db';
import { applyLatePenalty, formatWeekdayDate, istDateTime, LATE_POLICY_LABEL, lateDays, todayIST, toISTDate, toISTTime, type LatePolicy } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { plural, TeachingShared } from './teaching.shared';

type Policy = (typeof TEACH_LATE_POLICIES)[number];

function dueLabel(dueAt: Date): string {
  const t = toISTTime(dueAt);
  return `${formatWeekdayDate(toISTDate(dueAt))}${t === '23:59' ? '' : ` ${t}`}`;
}

function lateLine(policy: LatePolicy): string {
  if (policy === 'no_penalty') return 'no late penalty';
  if (policy === 'not_accepted') return 'late work not accepted';
  return `${LATE_POLICY_LABEL[policy]} late`;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Teacher · Assignments: cards with progress, new assignment, grade & release, remind, extend. */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly db: Db,
    private readonly shared: TeachingShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly files: FilesService,
  ) {}

  async list(batchId?: string): Promise<{ toGrade: number; batches: Awaited<ReturnType<TeachingShared['myBatches']>>; items: TeachAssignmentCard[] }> {
    const batches = await this.shared.myBatches();
    const ids = batches.map((b) => b.id);
    if (batchId && !ids.includes(batchId)) throw forbidden('This batch is not assigned to you');
    const filter = batchId ? [batchId] : ids;
    if (!filter.length) return { toGrade: 0, batches, items: [] };
    const rows = await this.db.db
      .select({
        a: s.assignment,
        batchCode: s.batch.code,
        submitted: sql<number>`(select count(*)::int from submission sb where sb.assignment_id = ${s.assignment.id})`,
        graded: sql<number>`(select count(*)::int from submission sb where sb.assignment_id = ${s.assignment.id} and sb.graded_at is not null)`,
        notSubmitted: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.assignment.batchId} and e.status = 'active'
          and not exists (select 1 from submission sb where sb.assignment_id = ${s.assignment.id} and sb.enrollment_id = e.id))`,
        total: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.assignment.batchId} and e.status = 'active')`,
      })
      .from(s.assignment)
      .innerJoin(s.batch, eq(s.batch.id, s.assignment.batchId))
      .where(inArray(s.assignment.batchId, filter));
    const now = Date.now();
    const today = todayIST();
    const items = rows.map((r): TeachAssignmentCard => {
      const a = r.a;
      const submitted = Number(r.submitted);
      const graded = Number(r.graded);
      const total = Math.max(Number(r.total), submitted);
      const toGrade = submitted - graded;
      const past = a.dueAt.getTime() < now;
      let tag: TeachAssignmentCard['tag'];
      let tagVariant: TeachTag;
      if (past && toGrade === 0 && submitted > 0) [tag, tagVariant] = ['Graded', 'accent'];
      else if (!past && toISTDate(a.dueAt) === today) [tag, tagVariant] = ['Due today', 'ink'];
      else if (past) [tag, tagVariant] = ['Closed', 'neutral'];
      else [tag, tagVariant] = ['Open', 'outline'];
      return {
        id: a.id,
        batchId: a.batchId,
        batchCode: r.batchCode,
        title: a.title,
        dueLabel: dueLabel(a.dueAt),
        dueAt: a.dueAt.toISOString(),
        max: a.maxMarks,
        tag,
        tagVariant,
        submitted,
        total,
        graded,
        toGrade,
        notSubmitted: Number(r.notSubmitted),
        pct: total > 0 ? Math.round((submitted / total) * 100) : 0,
        meta: `${submitted} / ${total} submitted · ${graded} graded · ${lateLine(a.latePolicy as LatePolicy)}`,
      };
    });
    const rank = (x: TeachAssignmentCard) => (x.tag === 'Due today' ? 0 : x.tag === 'Open' ? 1 : x.toGrade > 0 ? 2 : 3);
    items.sort((x, y) => rank(x) - rank(y) || (rank(x) <= 1 ? Date.parse(x.dueAt) - Date.parse(y.dueAt) : Date.parse(y.dueAt) - Date.parse(x.dueAt)));
    const toGrade = rows.reduce((acc, r) => acc + Number(r.submitted) - Number(r.graded), 0);
    return { toGrade, batches, items };
  }

  private async mine(id: string) {
    const [a] = await this.db.db.select().from(s.assignment).where(eq(s.assignment.id, id));
    if (!a) throw notFound('Assignment');
    const b = await this.shared.myBatch(a.batchId);
    return { a, b };
  }

  async create(body: { batchId: string; title: string; dueDate: string; dueTime: string; maxMarks: number; latePolicy: Policy; instructions?: string }): Promise<{ id: string }> {
    const b = await this.shared.myBatch(body.batchId);
    const dueAt = istDateTime(body.dueDate, body.dueTime);
    if (dueAt.getTime() <= Date.now()) throw invalid('The due date is in the past', { dueDate: 'Past date' });
    const c = ctx();
    return this.db.tx(async (tx) => {
      const [row] = await tx
        .insert(s.assignment)
        .values({
          batchId: b.id,
          branchId: b.branchId,
          teacherUserId: c.userId,
          title: body.title,
          instructions: body.instructions || null,
          rubric: body.instructions || null,
          dueAt,
          maxMarks: body.maxMarks,
          latePolicy: body.latePolicy,
          status: 'open',
        })
        .returning({ id: s.assignment.id });
      const id = row!.id;
      await this.events.emit(tx, 'AssignmentCreated', { assignmentId: id, batchId: b.id, branchId: b.branchId });
      await this.audit.log(tx, {
        action: 'Assignment created',
        kind: 'create',
        entityType: 'assignment',
        entityId: id,
        entityLabel: `${b.code} · ${body.title}`,
        after: { dueAt, maxMarks: body.maxMarks, latePolicy: body.latePolicy },
        summary: `${b.code} · ${body.title} · due ${dueLabel(dueAt)} · ${body.maxMarks} marks · ${LATE_POLICY_LABEL[body.latePolicy]}`,
        branchId: b.branchId,
      });
      await this.notify.notify(tx, {
        userIds: await this.shared.batchStudentUserIds(tx, b.id),
        category: 'assignment',
        title: `New assignment · ${b.code}`,
        body: `${body.title} · due ${dueLabel(dueAt)} · ${body.maxMarks} marks`,
        link: '/student/work',
        entityType: 'assignment',
        entityId: id,
      });
      this.notify.invalidate(tx, b.branchId, [['teaching'], ['portal']]);
      return { id };
    });
  }

  async grading(id: string): Promise<TeachGrading> {
    const { a, b } = await this.mine(id);
    const rows = await this.db.db
      .select({ sb: s.submission, name: s.student.name, admissionNo: s.student.admissionNo })
      .from(s.submission)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.submission.enrollmentId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .where(and(eq(s.submission.assignmentId, id), isNull(s.submission.gradedAt)))
      .orderBy(asc(s.student.name));
    return {
      id: a.id,
      title: a.title,
      batchCode: b.code,
      max: a.maxMarks,
      latePolicy: a.latePolicy as Policy,
      latePolicyLabel: LATE_POLICY_LABEL[a.latePolicy as LatePolicy],
      rows: rows.map((r) => {
        const days = lateDays(a.dueAt, r.sb.submittedAt);
        return {
          submissionId: r.sb.id,
          name: r.name,
          admissionNo: r.admissionNo,
          lateDays: days,
          lateLabel: days > 0 ? `late ${plural(days, 'day')}` : 'on time',
          submittedLabel: `Submitted ${formatWeekdayDate(toISTDate(r.sb.submittedAt))} ${toISTTime(r.sb.submittedAt)}`,
          hasFile: !!r.sb.fileId,
          text: r.sb.text,
        };
      }),
    };
  }

  async fileUrl(submissionId: string) {
    const [sb] = await this.db.db.select().from(s.submission).where(eq(s.submission.id, submissionId));
    if (!sb) throw notFound('Submission');
    await this.mine(sb.assignmentId);
    if (!sb.fileId) throw notFound('File');
    return this.files.signedUrl(sb.fileId, 300);
  }

  async grade(id: string, grades: { submissionId: string; marks: number; feedback?: string }[]): Promise<{ released: number; penalised: number }> {
    const { a, b } = await this.mine(id);
    const c = ctx();
    return this.db.tx(async (tx) => {
      const subs = await tx
        .select({ sb: s.submission, name: s.student.name, userId: s.student.userId })
        .from(s.submission)
        .innerJoin(s.enrollment, eq(s.enrollment.id, s.submission.enrollmentId))
        .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
        .where(
          and(
            eq(s.submission.assignmentId, id),
            inArray(
              s.submission.id,
              grades.map((g) => g.submissionId),
            ),
          ),
        );
      const now = new Date();
      let penalised = 0;
      const released: string[] = [];
      for (const g of grades) {
        const row = subs.find((x) => x.sb.id === g.submissionId);
        if (!row) throw invalid('One of the submissions does not belong to this assignment');
        if (g.marks > a.maxMarks) throw invalid(`${row.name}: ${fmt(g.marks)} is over the maximum of ${a.maxMarks}`, { [g.submissionId]: 'Over max' });
        const days = lateDays(a.dueAt, row.sb.submittedAt);
        const finalMarks = applyLatePenalty(g.marks, a.maxMarks, a.latePolicy as LatePolicy, days);
        if (finalMarks < g.marks) penalised++;
        await tx
          .update(s.submission)
          .set({ marks: g.marks, finalMarks, feedback: g.feedback || null, gradedAt: now, gradedBy: c.userId, released: true, isLate: days > 0, lateDays: days })
          .where(eq(s.submission.id, g.submissionId));
        released.push(g.submissionId);
        if (row.userId) {
          await this.notify.notify(tx, {
            userIds: [row.userId],
            category: 'assignment',
            title: `Graded · ${a.title}`,
            body: `${fmt(finalMarks)} / ${a.maxMarks}${finalMarks < g.marks ? ` (late penalty ${LATE_POLICY_LABEL[a.latePolicy as LatePolicy]} × ${days})` : ''}${g.feedback ? ` · ${g.feedback}` : ''}`,
            link: '/student/work',
            entityType: 'submission',
            entityId: g.submissionId,
          });
        }
      }
      await this.events.emit(tx, 'GradesReleased', { assignmentId: id, batchId: a.batchId, submissionIds: released });
      await this.audit.log(tx, {
        action: 'Grades released',
        kind: 'publish',
        entityType: 'assignment',
        entityId: id,
        entityLabel: `${b.code} · ${a.title}`,
        after: { released: released.length, penalised },
        summary: `${b.code} · ${a.title} · ${plural(released.length, 'submission')} graded & released${penalised ? ` · late penalty on ${penalised}` : ''}`,
        branchId: a.branchId,
      });
      this.notify.invalidate(tx, a.branchId, [['teaching'], ['portal']]);
      return { released: released.length, penalised };
    });
  }

  async remind(id: string): Promise<{ reminded: number }> {
    const { a, b } = await this.mine(id);
    if (a.dueAt.getTime() < Date.now() && a.latePolicy === 'not_accepted') throw invalid('Late work is not accepted for this assignment — extend the due date first');
    return this.db.tx(async (tx) => {
      const pending = await tx
        .select({ userId: s.student.userId, name: s.student.name })
        .from(s.enrollment)
        .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
        .where(
          and(
            eq(s.enrollment.batchId, a.batchId),
            eq(s.enrollment.status, 'active'),
            sql`not exists (select 1 from submission sb where sb.assignment_id = ${a.id} and sb.enrollment_id = ${s.enrollment.id})`,
          ),
        );
      const userIds = pending.map((p) => p.userId).filter((x): x is string => !!x);
      if (!userIds.length) throw invalid('Everyone has submitted — nobody to remind');
      const due = dueLabel(a.dueAt);
      await this.notify.notify(tx, {
        userIds,
        category: 'assignment',
        title: `Reminder · ${a.title}`,
        body: `${b.code} · due ${due} · not submitted yet`,
        link: '/student/work',
        entityType: 'assignment',
        entityId: a.id,
        whatsapp: { template: 'assignment_reminder', body: `Exatech: reminder — "${a.title}" (${b.code}) is due ${due}. Submit it from the student portal.` },
      });
      await this.audit.log(tx, {
        action: 'Assignment reminder sent',
        kind: 'other',
        entityType: 'assignment',
        entityId: a.id,
        entityLabel: `${b.code} · ${a.title}`,
        after: { reminded: userIds.length },
        summary: `${b.code} · ${a.title} · ${plural(userIds.length, 'student')} reminded (in-app + WhatsApp)`,
        branchId: a.branchId,
      });
      return { reminded: userIds.length };
    });
  }

  async extend(id: string, dueDate: string, dueTime: string): Promise<void> {
    const { a, b } = await this.mine(id);
    const dueAt = istDateTime(dueDate, dueTime);
    if (dueAt.getTime() <= Date.now()) throw invalid('Pick a new due date in the future', { dueDate: 'Past date' });
    if (dueAt.getTime() <= a.dueAt.getTime()) throw invalid(`Pick a date after the current due date (${dueLabel(a.dueAt)})`, { dueDate: 'Not later' });
    await this.db.tx(async (tx) => {
      await tx.update(s.assignment).set({ dueAt, extendedAt: new Date(), status: 'open' }).where(eq(s.assignment.id, a.id));
      await this.audit.log(tx, {
        action: 'Assignment extended',
        kind: 'update',
        entityType: 'assignment',
        entityId: a.id,
        entityLabel: `${b.code} · ${a.title}`,
        before: { dueAt: a.dueAt },
        after: { dueAt },
        summary: `${b.code} · ${a.title} · due ${dueLabel(a.dueAt)} → ${dueLabel(dueAt)}`,
        branchId: a.branchId,
      });
      await this.notify.notify(tx, {
        userIds: await this.shared.batchStudentUserIds(tx, a.batchId),
        category: 'assignment',
        title: `Due date extended · ${a.title}`,
        body: `${b.code} · now due ${dueLabel(dueAt)}`,
        link: '/student/work',
        entityType: 'assignment',
        entityId: a.id,
      });
      this.notify.invalidate(tx, a.branchId, [['teaching'], ['portal']]);
    });
  }
}
