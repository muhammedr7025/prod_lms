import { Controller } from '@nestjs/common';
import { referenceContract, type Reference } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql } from '@exatech/db';
import { ctx } from './context';
import { Db } from './db';
import { forbidden } from './errors';
import { Endpoint } from './http';

/** Reference data used by pickers and dialogs everywhere (cached client-side for 30 min). */
@Controller()
export class ReferenceController {
  constructor(private readonly db: Db) {}

  @Endpoint(referenceContract.get)
  async get(): Promise<Reference> {
    // Staff directory and catalogue data are for staff (incl. teachers) only — least privilege for portals.
    if (ctx().userKind !== 'staff') throw forbidden();
    const db = this.db.db;
    const [branches, courses, subjects, rooms, batches, teachers, staff, feePlans] = await Promise.all([
      db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name, status: s.branch.status }).from(s.branch).orderBy(asc(s.branch.openedOn)),
      db.select({ id: s.course.id, code: s.course.code, name: s.course.name }).from(s.course).where(eq(s.course.status, 'active')).orderBy(asc(s.course.code)),
      db.select({ id: s.courseSubject.id, courseId: s.courseSubject.courseId, name: s.courseSubject.name }).from(s.courseSubject).orderBy(asc(s.courseSubject.position)),
      db.select({ id: s.room.id, branchId: s.room.branchId, name: s.room.name, capacity: s.room.capacity }).from(s.room).where(eq(s.room.active, true)).orderBy(asc(s.room.name)),
      db
        .select({
          id: s.batch.id,
          branchId: s.batch.branchId,
          courseId: s.batch.courseId,
          code: s.batch.code,
          status: s.batch.status,
          capacity: s.batch.capacity,
          feePlanId: s.batch.feePlanId,
          enrolled: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.batch.id} and e.status = 'active')`,
        })
        .from(s.batch)
        .where(inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']))
        .orderBy(asc(s.batch.code)),
      db
        .selectDistinct({ id: s.user.id, name: s.user.name, homeBranchId: s.staffProfile.homeBranchId })
        .from(s.user)
        .innerJoin(s.membership, eq(s.membership.userId, s.user.id))
        .innerJoin(s.role, and(eq(s.role.id, s.membership.roleId), eq(s.role.key, 'teacher')))
        .leftJoin(s.staffProfile, eq(s.staffProfile.userId, s.user.id))
        .where(eq(s.user.status, 'active'))
        .orderBy(asc(s.user.name)),
      db
        .select({ id: s.user.id, name: s.user.name, roleKey: s.role.key, branchIds: s.membership.branchIds })
        .from(s.user)
        .innerJoin(s.membership, eq(s.membership.userId, s.user.id))
        .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
        .where(and(eq(s.user.kind, 'staff'), eq(s.membership.status, 'active')))
        .orderBy(asc(s.user.name)),
      db.select({ id: s.feePlan.id, courseId: s.feePlan.courseId, branchId: s.feePlan.branchId, name: s.feePlan.name, kind: s.feePlan.kind }).from(s.feePlan).where(eq(s.feePlan.active, true)),
    ]);
    const staffMap = new Map<string, { id: string; name: string; roleKeys: string[]; branchIds: string[] }>();
    for (const row of staff) {
      const e = staffMap.get(row.id) ?? { id: row.id, name: row.name, roleKeys: [], branchIds: [] };
      e.roleKeys.push(row.roleKey);
      e.branchIds = [...new Set([...e.branchIds, ...row.branchIds])];
      staffMap.set(row.id, e);
    }
    return {
      branches,
      courses: courses.map((c) => ({ ...c, subjects: subjects.filter((x) => x.courseId === c.id).map(({ id, name }) => ({ id, name })) })),
      rooms,
      batches: batches.map((b) => ({ ...b, enrolled: Number(b.enrolled) })),
      teachers,
      staff: [...staffMap.values()],
      feePlans,
    };
  }
}
