import { Injectable } from '@nestjs/common';
import type { ParentMessageItem, PtmItem } from '@exatech/contracts';
import * as s from '@exatech/db';
import { alias, and, asc, desc, eq, inArray, isNull, sql, type DbOrTx, type SQL } from '@exatech/db';
import { formatLongWeekdayDate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { NotifyService } from '../../core/notifications/notify.service';
import { ScopeService } from '../../core/scope.service';

const PART_LABEL: Record<string, string> = { morning: 'Morning (10:00–12:00)', afternoon: 'Afternoon (14:00–16:00)', evening: 'Evening (16:30–18:00)' };

function slotLabel(slot: string): string {
  const [date, part] = slot.split(' ');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return slot;
  return `${formatLongWeekdayDate(date)}${part ? ` · ${PART_LABEL[part] ?? part}` : ''}`;
}

/**
 * Moderation and replies for parent messages, decisions on PTM requests.
 * Branch Admins (academics:students.manage) moderate within their branch;
 * teachers answer messages and decide PTM requests for students in their batches.
 */
@Injectable()
export class ParentRequestsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly scope: ScopeService,
  ) {}

  private isModerator() {
    return can('academics:students.manage');
  }

  /** Student → (batch, branch) of the active enrollment. */
  private studentBatch = (studentId: string, dbx: DbOrTx = this.db.db) =>
    dbx
      .select({ batchId: s.enrollment.batchId, branchId: s.enrollment.branchId, batchCode: s.batch.code, studentName: s.student.name })
      .from(s.enrollment)
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .where(and(eq(s.enrollment.studentId, studentId), eq(s.enrollment.status, 'active')))
      .limit(1)
      .then((r) => r[0]);

  private async assertCanHandle(studentId: string, dbx: DbOrTx) {
    const sb = await this.studentBatch(studentId, dbx);
    if (!sb) throw notFound('Student');
    if (this.isModerator()) {
      const c = ctx();
      if (c.membershipBranchIds && !c.membershipBranchIds.includes(sb.branchId)) throw forbidden('This student belongs to another branch');
      return sb;
    }
    const mine = await this.scope.teacherBatchIds();
    if (!mine.includes(sb.batchId)) throw forbidden('This student is not in your batches');
    return sb;
  }

  private async messageRows(where: SQL | undefined): Promise<ParentMessageItem[]> {
    const parent = alias(s.user, 'parent');
    const teacher = alias(s.user, 'teacher');
    const rows = await this.db.db
      .select({ m: s.parentMessage, parentName: parent.name, teacherName: teacher.name, studentName: s.student.name, batchCode: s.batch.code })
      .from(s.parentMessage)
      .innerJoin(parent, eq(parent.id, s.parentMessage.guardianUserId))
      .leftJoin(teacher, eq(teacher.id, s.parentMessage.teacherUserId))
      .innerJoin(s.student, eq(s.student.id, s.parentMessage.studentId))
      .innerJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .where(where)
      .orderBy(asc(s.parentMessage.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.m.id,
      parentName: r.parentName,
      studentName: r.studentName,
      batchCode: r.batchCode,
      teacherName: r.teacherName,
      body: r.m.body,
      status: r.m.status,
      reply: r.m.reply,
      createdAt: r.m.createdAt.toISOString(),
    }));
  }

  private async ptmRows(where: SQL | undefined): Promise<PtmItem[]> {
    const parent = alias(s.user, 'parent');
    const rows = await this.db.db
      .select({ p: s.ptmRequest, parentName: parent.name, studentName: s.student.name, batchCode: s.batch.code })
      .from(s.ptmRequest)
      .innerJoin(parent, eq(parent.id, s.ptmRequest.guardianUserId))
      .innerJoin(s.student, eq(s.student.id, s.ptmRequest.studentId))
      .innerJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .where(where)
      .orderBy(desc(s.ptmRequest.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.p.id,
      parentName: r.parentName,
      studentName: r.studentName,
      batchCode: r.batchCode,
      slotLabel: slotLabel(r.p.preferredSlot),
      note: r.p.note,
      status: r.p.status,
      createdAt: r.p.createdAt.toISOString(),
    }));
  }

  async inbox() {
    if (this.isModerator()) {
      return {
        role: 'moderator' as const,
        messages: await this.messageRows(and(eq(s.parentMessage.status, 'pending'), inBranchScope(s.enrollment.branchId))),
        ptm: await this.ptmRows(and(eq(s.ptmRequest.status, 'requested'), inBranchScope(s.enrollment.branchId))),
      };
    }
    const mine = await this.scope.teacherBatchIds();
    if (mine.length === 0) return { role: 'teacher' as const, messages: [], ptm: [] };
    return {
      role: 'teacher' as const,
      messages: await this.messageRows(and(eq(s.parentMessage.status, 'delivered'), isNull(s.parentMessage.reply), inArray(s.enrollment.batchId, mine))),
      ptm: await this.ptmRows(and(eq(s.ptmRequest.status, 'requested'), inArray(s.enrollment.batchId, mine))),
    };
  }

  async moderate(id: string, decision: 'approve' | 'reject', note?: string) {
    if (!this.isModerator()) throw forbidden('Only a Branch Administrator moderates parent messages');
    if (decision === 'reject' && !note) throw invalid('Tell the parent why the message was not delivered', { note: 'Required' });
    await this.db.tx(async (tx) => {
      const [m] = await tx.select().from(s.parentMessage).where(eq(s.parentMessage.id, id)).for('update');
      if (!m) throw notFound('Message');
      if (m.status !== 'pending') throw conflict('This message has already been moderated');
      const sb = await this.assertCanHandle(m.studentId, tx);
      await tx
        .update(s.parentMessage)
        .set({ status: decision === 'approve' ? 'delivered' : 'rejected', moderatedBy: ctx().userId, reply: decision === 'reject' ? null : m.reply })
        .where(eq(s.parentMessage.id, id));
      await this.audit.log(tx, {
        action: decision === 'approve' ? 'Parent message approved' : 'Parent message rejected',
        kind: 'approve',
        entityType: 'parent_message',
        entityId: id,
        entityLabel: sb.studentName,
        summary: `pending → ${decision === 'approve' ? 'delivered' : 'rejected'}${note ? ` · ${note}` : ''}`,
        branchId: sb.branchId,
      });
      if (decision === 'approve' && m.teacherUserId) {
        await this.notify.notify(tx, {
          userIds: [m.teacherUserId],
          category: 'message',
          title: `Message from a parent · ${sb.studentName.split(' ')[0]} (${sb.batchCode})`,
          body: m.body.slice(0, 140),
          link: '/teacher',
          entityType: 'parent_message',
          entityId: id,
        });
      }
      if (decision === 'reject') {
        await this.notify.notify(tx, {
          userIds: [m.guardianUserId],
          category: 'message',
          title: 'Your message was not delivered',
          body: note!,
          link: '/parent',
          entityType: 'parent_message',
          entityId: id,
        });
      }
      this.notify.invalidate(tx, sb.branchId, [['comms', 'parent-requests']]);
    });
    return (await this.messageRows(eq(s.parentMessage.id, id)))[0]!;
  }

  async reply(id: string, reply: string) {
    await this.db.tx(async (tx) => {
      const [m] = await tx.select().from(s.parentMessage).where(eq(s.parentMessage.id, id)).for('update');
      if (!m) throw notFound('Message');
      if (m.status !== 'delivered') throw conflict('Only delivered messages can be answered');
      if (m.reply) throw conflict('This message has already been answered');
      const sb = await this.assertCanHandle(m.studentId, tx);
      await tx.update(s.parentMessage).set({ reply }).where(eq(s.parentMessage.id, id));
      await this.audit.log(tx, { action: 'Parent message answered', kind: 'update', entityType: 'parent_message', entityId: id, entityLabel: sb.studentName, summary: reply.slice(0, 120), branchId: sb.branchId });
      await this.notify.notify(tx, {
        userIds: [m.guardianUserId],
        category: 'message',
        title: `Reply from ${ctx().userName}`,
        body: reply,
        link: '/parent',
        entityType: 'parent_message',
        entityId: id,
        whatsapp: { body: `${ctx().userName} (${sb.batchCode}) replied about ${sb.studentName.split(' ')[0]}: ${reply}` },
      });
      this.notify.invalidate(tx, sb.branchId, [['comms', 'parent-requests']]);
    });
    return (await this.messageRows(eq(s.parentMessage.id, id)))[0]!;
  }

  async decidePtm(id: string, decision: 'confirmed' | 'declined', note?: string) {
    if (decision === 'declined' && !note) throw invalid('Suggest another time or say why', { note: 'Required' });
    await this.db.tx(async (tx) => {
      const [p] = await tx.select().from(s.ptmRequest).where(eq(s.ptmRequest.id, id)).for('update');
      if (!p) throw notFound('PTM request');
      if (p.status !== 'requested') throw conflict('This request has already been answered');
      const sb = await this.assertCanHandle(p.studentId, tx);
      await tx.update(s.ptmRequest).set({ status: decision }).where(eq(s.ptmRequest.id, id));
      const label = slotLabel(p.preferredSlot);
      await this.audit.log(tx, { action: decision === 'confirmed' ? 'PTM confirmed' : 'PTM declined', kind: 'approve', entityType: 'ptm_request', entityId: id, entityLabel: sb.studentName, summary: `${label}${note ? ` · ${note}` : ''}`, branchId: sb.branchId });
      await this.notify.notify(tx, {
        userIds: [p.guardianUserId],
        category: 'message',
        title: decision === 'confirmed' ? `PTM confirmed · ${label}` : 'PTM request declined',
        body: decision === 'confirmed' ? `${ctx().userName} will meet you about ${sb.studentName.split(' ')[0]}${note ? ` · ${note}` : ''}` : note!,
        link: '/parent',
        entityType: 'ptm_request',
        entityId: id,
        whatsapp: { body: decision === 'confirmed' ? `PTM confirmed for ${sb.studentName.split(' ')[0]} (${sb.batchCode}): ${label}.${note ? ` ${note}` : ''}` : `PTM request for ${sb.studentName.split(' ')[0]}: ${note}` },
      });
      this.notify.invalidate(tx, sb.branchId, [['comms', 'parent-requests']]);
    });
    return (await this.ptmRows(eq(s.ptmRequest.id, id)))[0]!;
  }
}

void sql;
