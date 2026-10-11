import { Injectable } from '@nestjs/common';
import type { WorkItem } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, isNull } from '@exatech/db';
import { canSubmitAfterDue, formatWeekdayDate, LATE_POLICY_LABEL, lateDays, toISTDate, toISTTime, type LatePolicy } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { badRequest, conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import type { StudentScope } from '../../core/scope.service';
import { plural, PortalShared } from './portal.shared';

type AssignmentRow = typeof s.assignment.$inferSelect;
type SubmissionRow = typeof s.submission.$inferSelect;

const fmt = (n: number) => String(Math.round(n * 10) / 10);

function dueLabel(dueAt: Date): string {
  const t = toISTTime(dueAt);
  return `${formatWeekdayDate(toISTDate(dueAt))}${t === '23:59' ? '' : ` ${t}`}`;
}

/** "Late submissions lose 10% per day · feedback appears here when graded" from the batch's actual policies. */
export function policyFooter(policies: LatePolicy[]): string {
  const uniq = [...new Set(policies)];
  const line = (p: LatePolicy) =>
    p === 'minus_10_per_day' ? 'Late submissions lose 10% per day' : p === 'minus_5_per_day' ? 'Late submissions lose 5% per day' : p === 'not_accepted' ? 'Late submissions are not accepted' : 'No penalty for late submissions';
  const head = uniq.length === 1 ? line(uniq[0]!) : uniq.length === 0 ? 'Late policy is shown on each assignment' : 'Late policy varies by assignment';
  return `${head} · feedback appears here when graded`;
}

/** Student · Work: assignments with status, attach & submit (portal writes the student's own submission row). */
@Injectable()
export class WorkService {
  constructor(
    private readonly shared: PortalShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
  ) {}

  private item(a: AssignmentRow, sub: SubmissionRow | null, fileName: string | null, batchCode: string, now: Date): WorkItem {
    const policy = a.latePolicy as LatePolicy;
    const past = a.dueAt.getTime() < now.getTime();
    const due = dueLabel(a.dueAt);
    const perDay = policy === 'minus_10_per_day' ? '−10%/day' : policy === 'minus_5_per_day' ? '−5%/day' : null;
    let status: WorkItem['status'];
    let statusLabel: string;
    let tagVariant: WorkItem['tagVariant'];
    let canSubmit = false;
    let blockedReason: string | null = null;

    if (sub?.gradedAt && sub.released) {
      status = 'graded';
      statusLabel = `Graded · ${fmt(sub.finalMarks ?? sub.marks ?? 0)} / ${a.maxMarks}`;
      tagVariant = 'accent';
    } else if (sub) {
      status = 'submitted';
      statusLabel = 'Submitted · awaiting grade';
      tagVariant = 'outline';
      if (sub.gradedAt) blockedReason = 'Graded — results appear once the teacher releases them';
      else if (a.status === 'closed') blockedReason = 'Closed by the teacher — resubmission is no longer possible';
      else if (past && !canSubmitAfterDue(policy)) blockedReason = 'Past the due date — late work is not accepted';
      else canSubmit = true;
    } else if (a.status === 'closed') {
      status = 'closed';
      statusLabel = 'Closed';
      tagVariant = 'neutral';
      blockedReason = 'Closed by the teacher — submissions are no longer accepted';
    } else if (past) {
      if (canSubmitAfterDue(policy)) {
        status = 'late';
        statusLabel = perDay ? `Late · ${perDay}` : 'Late · no penalty';
        tagVariant = 'ink';
        canSubmit = true;
      } else {
        status = 'closed';
        statusLabel = 'Closed';
        tagVariant = 'neutral';
        blockedReason = 'Past the due date — late work is not accepted for this assignment';
      }
    } else {
      status = 'pending';
      statusLabel = `Pending · due ${formatWeekdayDate(toISTDate(a.dueAt))}`;
      tagVariant = 'outline';
      canSubmit = true;
    }

    const lateNow = past ? lateDays(a.dueAt, now) : 0;
    return {
      id: a.id,
      batchCode,
      title: a.title,
      instructions: a.instructions,
      dueLabel: past && !sub ? `Was due ${due} · ${plural(lateNow, 'day')} late` : `Due ${due} · max ${a.maxMarks} · ${LATE_POLICY_LABEL[policy]}`,
      max: a.maxMarks,
      status,
      statusLabel,
      tagVariant,
      canSubmit,
      blockedReason,
      submission: sub
        ? {
            submittedAt: sub.submittedAt.toISOString(),
            line: `Submitted ${formatWeekdayDate(toISTDate(sub.submittedAt))} ${toISTTime(sub.submittedAt)}${sub.isLate ? ` · ${plural(sub.lateDays, 'day')} late` : ''}`,
            fileName,
            text: sub.text,
            feedback: sub.gradedAt && sub.released ? sub.feedback : null,
          }
        : null,
    };
  }

  private async rows(sc: StudentScope, assignmentId?: string) {
    const db = this.shared.db.db;
    return db
      .select({ a: s.assignment, sub: s.submission, fileName: s.fileObject.filename })
      .from(s.assignment)
      .leftJoin(s.submission, and(eq(s.submission.assignmentId, s.assignment.id), eq(s.submission.enrollmentId, sc.enrollmentId)))
      .leftJoin(s.fileObject, eq(s.fileObject.id, s.submission.fileId))
      .where(and(eq(s.assignment.batchId, sc.batchId), assignmentId ? eq(s.assignment.id, assignmentId) : undefined))
      .orderBy(asc(s.assignment.dueAt));
  }

  async list() {
    const sc = await this.shared.ownEnrollment();
    const now = new Date();
    const rows = await this.rows(sc);
    const items = rows.map((r) => this.item(r.a, r.sub, r.fileName, sc.batchCode, now));
    // Actionable first (pending / late by due date), then submitted, graded, closed.
    const rank: Record<WorkItem['status'], number> = { late: 0, pending: 1, submitted: 2, graded: 3, closed: 4 };
    items.sort((x, y) => rank[x.status] - rank[y.status]);
    return {
      kicker: `${sc.batchCode} · assignments`,
      items,
      footer: policyFooter(rows.map((r) => r.a.latePolicy as LatePolicy)),
    };
  }

  async submit(assignmentId: string, body: { text?: string; fileId?: string }): Promise<WorkItem> {
    const sc = await this.shared.ownEnrollment();
    const c = ctx();
    const db = this.shared.db;
    const [a] = await db.db.select().from(s.assignment).where(eq(s.assignment.id, assignmentId));
    if (!a || a.batchId !== sc.batchId) throw notFound('Assignment');
    const now = new Date();
    const policy = a.latePolicy as LatePolicy;
    if (a.status === 'closed') throw invalid('This assignment is closed — submissions are no longer accepted');
    const late = a.dueAt.getTime() < now.getTime();
    if (late && !canSubmitAfterDue(policy)) throw invalid(`Late work is not accepted for “${a.title}” (was due ${dueLabel(a.dueAt)})`);
    if (body.fileId) {
      const [f] = await db.db.select().from(s.fileObject).where(eq(s.fileObject.id, body.fileId));
      if (!f) throw badRequest('The attached file was not found — upload it again');
      if (f.ownerUserId !== c.userId || f.purpose !== 'submission') throw forbidden('That file is not one of your uploads');
    }
    const days = late ? lateDays(a.dueAt, now) : 0;

    const submissionId = await db.tx(async (tx) => {
      const [existing] = await tx
        .select()
        .from(s.submission)
        .where(and(eq(s.submission.assignmentId, a.id), eq(s.submission.enrollmentId, sc.enrollmentId)))
        .for('update');
      if (existing?.gradedAt) throw conflict('Already graded — resubmission is closed', 'ALREADY_GRADED');
      let id: string;
      if (existing) {
        const [u] = await tx
          .update(s.submission)
          .set({ submittedAt: now, text: body.text ?? null, fileId: body.fileId ?? null, isLate: late, lateDays: days })
          .where(and(eq(s.submission.id, existing.id), isNull(s.submission.gradedAt)))
          .returning({ id: s.submission.id });
        if (!u) throw conflict('Already graded — resubmission is closed', 'ALREADY_GRADED');
        id = u.id;
      } else {
        const [ins] = await tx
          .insert(s.submission)
          .values({ assignmentId: a.id, enrollmentId: sc.enrollmentId, submittedAt: now, text: body.text ?? null, fileId: body.fileId ?? null, isLate: late, lateDays: days })
          .returning({ id: s.submission.id });
        id = ins!.id;
      }
      await this.audit.log(tx, {
        action: existing ? 'Assignment resubmitted' : 'Assignment submitted',
        kind: 'create',
        entityType: 'submission',
        entityId: id,
        entityLabel: `${sc.name} · ${a.title}`,
        summary: `${sc.batchCode} · ${a.title}${body.fileId ? ' · file attached' : ''}${late ? ` · ${plural(days, 'day')} late (${LATE_POLICY_LABEL[policy]})` : ''}`,
        branchId: sc.branchId,
      });
      await this.events.emit(tx, 'SubmissionReceived', { submissionId: id, assignmentId: a.id, enrollmentId: sc.enrollmentId });
      // The teacher's to-grade counts refetch live.
      this.notify.invalidateUsers(tx, [a.teacherUserId], [['teaching']]);
      return id;
    });
    const [row] = await this.rows(sc, a.id);
    if (!row || row.sub?.id !== submissionId) throw notFound('Submission');
    return this.item(row.a, row.sub, row.fileName, sc.batchCode, new Date());
  }
}
