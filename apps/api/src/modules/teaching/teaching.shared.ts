import { Injectable } from '@nestjs/common';
import type { TeachBatch } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx } from '@exatech/db';
import { AccessService } from '../../core/auth/access.service';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, notFound } from '../../core/errors';
import { ScopeService } from '../../core/scope.service';

/** "Search · SEO & analytics" → "Search" (short subject for segmented filters). */
export function shortSubject(subject: string): string {
  return subject.split(' · ')[0] ?? subject;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Shared scope and lookup helpers for the Teaching controllers. */
@Injectable()
export class TeachingShared {
  constructor(
    private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly access: AccessService,
  ) {}

  async settings() {
    return (await this.access.institution()).settings;
  }

  /** My active teacher assignments (one subject per batch). */
  async assignments() {
    return this.scope.teacherAssignments();
  }

  async myBatchIds(): Promise<string[]> {
    return this.scope.teacherBatchIds();
  }

  /** My batches with roster size, for dialogs and filters (live batches first). */
  async myBatches(dbx: DbOrTx = this.db.db): Promise<TeachBatch[]> {
    const as = await this.assignments();
    if (as.length === 0) return [];
    const counts = await dbx
      .select({ batchId: s.enrollment.batchId, n: sql<number>`count(*)::int` })
      .from(s.enrollment)
      .where(and(inArray(s.enrollment.batchId, as.map((a) => a.batchId)), eq(s.enrollment.status, 'active')))
      .groupBy(s.enrollment.batchId);
    const order = ['running', 'open', 'waitlist', 'planned', 'completed', 'cancelled'];
    return as
      .filter((a) => a.status !== 'cancelled')
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.batchCode.localeCompare(b.batchCode))
      .map((a) => ({
        id: a.batchId,
        code: a.batchCode,
        label: `${a.batchCode} · ${shortSubject(a.subjectName)}`,
        subjectName: a.subjectName,
        students: Number(counts.find((c) => c.batchId === a.batchId)?.n ?? 0),
      }));
  }

  /** Batch row, asserting it is one of mine. */
  async myBatch(batchId: string, dbx: DbOrTx = this.db.db) {
    const [b] = await dbx.select().from(s.batch).where(eq(s.batch.id, batchId));
    if (!b) throw notFound('Batch');
    await this.scope.assertTeacherOfBatch(batchId);
    return b;
  }

  /** A class session I teach (timetabled, substitute or my ad-hoc). */
  async mySession(sessionId: string, dbx: DbOrTx = this.db.db, lock = false) {
    const q = dbx.select().from(s.classSession).where(eq(s.classSession.id, sessionId));
    const [cs] = lock ? await q.for('update') : await q;
    if (!cs) throw notFound('Session');
    if (cs.teacherUserId !== ctx().userId) throw forbidden('This session is not yours to mark');
    return cs;
  }

  /** Active roster of a batch (name order). */
  async roster(batchId: string, dbx: DbOrTx = this.db.db) {
    return dbx
      .select({ enrollmentId: s.enrollment.id, studentId: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo, userId: s.student.userId })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .where(and(eq(s.enrollment.batchId, batchId), eq(s.enrollment.status, 'active')))
      .orderBy(asc(s.student.name));
  }

  /** Branch Administrators of a branch (not institution-wide Super Admins). */
  async branchAdmins(dbx: DbOrTx, branchId: string): Promise<string[]> {
    const rows = await dbx
      .selectDistinct({ id: s.user.id })
      .from(s.membership)
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .innerJoin(s.user, eq(s.user.id, s.membership.userId))
      .where(and(eq(s.role.key, 'branchadmin'), eq(s.membership.status, 'active'), eq(s.user.status, 'active'), sql`${branchId} = any(${s.membership.branchIds})`));
    return rows.map((r) => r.id).filter((id) => id !== ctx().userId);
  }

  /** Student portal user ids of a batch's active roster. */
  async batchStudentUserIds(dbx: DbOrTx, batchId: string): Promise<string[]> {
    const rows = await this.roster(batchId, dbx);
    return rows.map((r) => r.userId).filter((x): x is string => !!x);
  }

  /** Guardian user ids per enrollment (absence alerts). */
  async guardians(enrollmentIds: string[]) {
    return this.scope.portalUsersForEnrollments(enrollmentIds);
  }

  async userName(dbx: DbOrTx, userId: string): Promise<string> {
    const [u] = await dbx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, userId));
    return u?.name ?? '';
  }
}
