import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, eq, inArray } from '@exatech/db';
import { ctx } from './context';
import { Db } from './db';
import { forbidden } from './errors';

export interface StudentScope {
  studentId: string;
  name: string;
  admissionNo: string | null;
  enrollmentId: string;
  batchId: string;
  batchCode: string;
  branchId: string;
  courseId: string;
  courseName: string;
}

/**
 * Row-level scope for portal roles: a teacher's batches, a student's own
 * enrollment, a parent's linked children. Every portal query goes through here.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly db: Db) {}

  /** Batches the teacher is assigned to (one subject per batch). */
  async teacherAssignments(userId = ctx().userId) {
    return this.db.db
      .select({
        batchId: s.teacherAssignment.batchId,
        subjectName: s.teacherAssignment.subjectName,
        batchCode: s.batch.code,
        branchId: s.batch.branchId,
        courseId: s.batch.courseId,
        status: s.batch.status,
      })
      .from(s.teacherAssignment)
      .innerJoin(s.batch, eq(s.batch.id, s.teacherAssignment.batchId))
      .where(and(eq(s.teacherAssignment.teacherUserId, userId), eq(s.teacherAssignment.active, true)));
  }

  async teacherBatchIds(userId = ctx().userId): Promise<string[]> {
    return (await this.teacherAssignments(userId)).map((a) => a.batchId);
  }

  async assertTeacherOfBatch(batchId: string): Promise<void> {
    const ids = await this.teacherBatchIds();
    if (!ids.includes(batchId)) throw forbidden('This batch is not assigned to you');
  }

  /** The signed-in student's active enrollments. */
  async studentEnrollments(userId = ctx().userId): Promise<StudentScope[]> {
    return this.db.db
      .select({
        studentId: s.student.id,
        name: s.student.name,
        admissionNo: s.student.admissionNo,
        enrollmentId: s.enrollment.id,
        batchId: s.enrollment.batchId,
        batchCode: s.batch.code,
        branchId: s.enrollment.branchId,
        courseId: s.batch.courseId,
        courseName: s.course.name,
      })
      .from(s.student)
      .innerJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(eq(s.student.userId, userId));
  }

  /** Children linked to the signed-in parent (with their active enrollment). */
  async parentChildren(userId = ctx().userId): Promise<StudentScope[]> {
    const guardians = await this.db.db.select({ id: s.guardian.id }).from(s.guardian).where(eq(s.guardian.userId, userId));
    if (guardians.length === 0) return [];
    const links = await this.db.db
      .select({ studentId: s.studentGuardian.studentId })
      .from(s.studentGuardian)
      .where(inArray(s.studentGuardian.guardianId, guardians.map((g) => g.id)));
    if (links.length === 0) return [];
    return this.db.db
      .select({
        studentId: s.student.id,
        name: s.student.name,
        admissionNo: s.student.admissionNo,
        enrollmentId: s.enrollment.id,
        batchId: s.enrollment.batchId,
        batchCode: s.batch.code,
        branchId: s.enrollment.branchId,
        courseId: s.batch.courseId,
        courseName: s.course.name,
      })
      .from(s.student)
      .innerJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(inArray(s.student.id, links.map((l) => l.studentId)))
      .orderBy(s.student.name);
  }

  /**
   * Resolve which enrollment a portal request is about: a student's own, or a
   * parent's chosen child (?studentId=). Throws if outside scope.
   */
  async portalEnrollment(studentId?: string | null): Promise<StudentScope> {
    const c = ctx();
    const list = c.roleKey === 'parent' ? await this.parentChildren() : await this.studentEnrollments();
    if (list.length === 0) throw forbidden('No active enrollment linked to this account');
    if (!studentId) return list[0]!;
    const found = list.find((x) => x.studentId === studentId);
    if (!found) throw forbidden('That student is not linked to your account');
    return found;
  }

  /** Portal user ids (student + guardians) for a set of enrollments — used for fan-out. */
  async portalUsersForEnrollments(enrollmentIds: string[]): Promise<{ enrollmentId: string; studentUserId: string | null; guardianUserIds: string[] }[]> {
    if (enrollmentIds.length === 0) return [];
    const rows = await this.db.db
      .select({ enrollmentId: s.enrollment.id, studentUserId: s.student.userId, guardianUserId: s.guardian.userId })
      .from(s.enrollment)
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .leftJoin(s.studentGuardian, eq(s.studentGuardian.studentId, s.student.id))
      .leftJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
      .where(inArray(s.enrollment.id, enrollmentIds));
    const map = new Map<string, { enrollmentId: string; studentUserId: string | null; guardianUserIds: string[] }>();
    for (const r of rows) {
      const e = map.get(r.enrollmentId) ?? { enrollmentId: r.enrollmentId, studentUserId: r.studentUserId, guardianUserIds: [] };
      if (r.guardianUserId && !e.guardianUserIds.includes(r.guardianUserId)) e.guardianUserIds.push(r.guardianUserId);
      map.set(r.enrollmentId, e);
    }
    return [...map.values()];
  }
}
