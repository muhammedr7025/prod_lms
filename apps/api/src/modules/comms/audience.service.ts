import { Injectable } from '@nestjs/common';
import { AUDIENCE_ROLES, AUDIENCE_SEGMENT_LABEL, AUDIENCE_SEGMENTS, type AudienceOptions, type AudienceRole, type AudienceSegment, type AudienceTarget } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx, type SQL } from '@exatech/db';
import { todayIST } from '@exatech/domain';
import { AccessService } from '../../core/auth/access.service';
import { branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid } from '../../core/errors';
import { ScopeService } from '../../core/scope.service';

export type AuthorKind = 'superadmin' | 'branch' | 'finance' | 'teacher';

export interface Resolved {
  userIds: string[];
  students: number;
  parents: number;
  staff: number;
}

const SCOPE_TYPES = new Set(['institution', 'branch', 'course', 'batch']);
const uuidList = (ids: readonly string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

/**
 * Audience targeting. Scope targets (institution / branch / course / batch)
 * are unioned into a population of active enrollments; segments filter that
 * population (overdue fees, low attendance); role targets pick who receives
 * it (students, parents, teachers, staff — students + parents by default).
 * Role limits are enforced here, server-side.
 */
@Injectable()
export class AudienceService {
  constructor(
    private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly access: AccessService,
  ) {}

  authorKind(): AuthorKind {
    const c = ctx();
    if (c.roleKey === 'superadmin' || c.membershipBranchIds === null) return 'superadmin';
    if (c.roleKey === 'finance') return 'finance';
    if (c.roleKey === 'teacher') return 'teacher';
    return 'branch';
  }

  async options(): Promise<AudienceOptions> {
    const kind = this.authorKind();
    const sc = branchScope();
    const branchCond = sc ? inArray(s.branch.id, sc) : undefined;
    const branches = kind === 'teacher' ? [] : await this.db.db.select({ id: s.branch.id, label: s.branch.name }).from(s.branch).where(and(eq(s.branch.status, 'active'), branchCond)).orderBy(asc(s.branch.name));
    const courses =
      kind === 'branch' || kind === 'superadmin'
        ? await this.db.db
            .selectDistinct({ id: s.course.id, label: s.course.name })
            .from(s.course)
            .innerJoin(s.courseOffering, eq(s.courseOffering.courseId, s.course.id))
            .where(sc ? inArray(s.courseOffering.branchId, sc) : undefined)
            .orderBy(asc(s.course.name))
        : [];
    let batches: { id: string; label: string }[] = [];
    if (kind !== 'finance') {
      const teacherIds = kind === 'teacher' ? await this.scope.teacherBatchIds() : null;
      batches = await this.db.db
        .select({ id: s.batch.id, label: s.batch.code })
        .from(s.batch)
        .where(and(inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']), sc ? inArray(s.batch.branchId, sc) : undefined, teacherIds ? inArray(s.batch.id, teacherIds.length ? teacherIds : ['00000000-0000-0000-0000-000000000000']) : undefined))
        .orderBy(asc(s.batch.code));
    }
    const roles: AudienceRole[] = kind === 'finance' || kind === 'teacher' ? ['students', 'parents'] : [...AUDIENCE_ROLES];
    const segments: AudienceSegment[] = kind === 'finance' ? ['overdue_fees'] : kind === 'teacher' ? [] : [...AUDIENCE_SEGMENTS];
    const limitNote =
      kind === 'superadmin'
        ? 'Super Admin · any audience across branches'
        : kind === 'finance'
          ? 'Finance · fee topics only: the overdue-fees segment, students and parents'
          : kind === 'teacher'
            ? 'Teacher · your own batches only'
            : 'Branch Admin · your branch only';
    return { branches, courses, batches, roles, segments, institution: kind === 'superadmin', limitNote };
  }

  /** Validate the audience against the author's role limits and add the implicit scope. */
  async normalise(targets: AudienceTarget[]): Promise<{ audience: AudienceTarget[]; branchId: string | null }> {
    const kind = this.authorKind();
    const opts = await this.options();
    const sc = branchScope();
    const seen = new Set<string>();
    const out: AudienceTarget[] = [];
    for (const t of targets) {
      const key = `${t.type}:${t.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      switch (t.type) {
        case 'institution':
          if (kind !== 'superadmin') throw forbidden('Only a Super Admin can announce to the whole institution');
          break;
        case 'branch':
          if (!opts.branches.some((b) => b.id === t.value)) throw forbidden(kind === 'teacher' ? 'Teachers can only announce to their own batches' : 'That branch is outside your scope');
          break;
        case 'course':
          if (!opts.courses.some((c) => c.id === t.value)) throw forbidden(kind === 'finance' ? 'Finance announcements are limited to fee topics' : kind === 'teacher' ? 'Teachers can only announce to their own batches' : 'That course is not offered in your branch');
          if (sc && sc.length > 1) throw invalid('Pick a branch in the header before targeting a course');
          break;
        case 'batch':
          if (!opts.batches.some((b) => b.id === t.value)) throw forbidden(kind === 'finance' ? 'Finance announcements are limited to fee topics' : kind === 'teacher' ? 'That batch is not assigned to you' : 'That batch is outside your branch');
          break;
        case 'role':
          if (!opts.roles.includes(t.value as AudienceRole)) throw forbidden(kind === 'finance' ? 'Finance can announce to students and parents only' : kind === 'teacher' ? 'Teachers can announce to their students and parents only' : `Unknown audience role ${t.value}`);
          break;
        case 'segment':
          if (!opts.segments.includes(t.value as AudienceSegment)) throw forbidden(kind === 'finance' ? 'Finance can only use the overdue-fees segment' : kind === 'teacher' ? 'Teachers cannot target segments' : `Unknown segment ${t.value}`);
          break;
      }
      out.push(t);
    }
    if (kind === 'teacher' && !out.some((t) => t.type === 'batch')) throw invalid('Choose at least one of your batches');
    if (!out.some((t) => SCOPE_TYPES.has(t.type))) {
      if (sc === null) out.push({ type: 'institution', value: 'institution', label: 'Institution · everyone' });
      else {
        const names = await this.db.db.select({ id: s.branch.id, name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, sc));
        for (const b of names) out.push({ type: 'branch', value: b.id, label: `Branch · ${b.name}` });
      }
    }
    const branchId = sc && sc.length === 1 ? sc[0]! : null;
    return { audience: out, branchId };
  }

  /** Resolve an audience (stored on the announcement) into recipient user ids. */
  async resolve(dbx: DbOrTx, audience: AudienceTarget[], branchId: string | null): Promise<Resolved> {
    const batches = audience.filter((t) => t.type === 'batch').map((t) => t.value);
    const courses = audience.filter((t) => t.type === 'course').map((t) => t.value);
    const branches = audience.filter((t) => t.type === 'branch').map((t) => t.value);
    const everyone = audience.some((t) => t.type === 'institution');
    const segments = audience.filter((t) => t.type === 'segment').map((t) => t.value);
    const rolesRaw = audience.filter((t) => t.type === 'role').map((t) => t.value as AudienceRole);
    const roles = new Set<AudienceRole>(rolesRaw.length ? rolesRaw : ['students', 'parents']);
    const ors: SQL[] = [];
    if (everyone) ors.push(sql`true`);
    if (batches.length) ors.push(sql`e.batch_id in ${uuidList(batches)}`);
    if (branches.length) ors.push(sql`e.branch_id in ${uuidList(branches)}`);
    if (courses.length) ors.push(sql`(b.course_id in ${uuidList(courses)}${branchId ? sql` and e.branch_id = ${branchId}::uuid` : sql``})`);
    if (ors.length === 0) return { userIds: [], students: 0, parents: 0, staff: 0 };
    const filters: SQL[] = [];
    const today = todayIST();
    if (segments.includes('overdue_fees')) {
      filters.push(sql`exists (select 1 from instalment i where i.enrollment_id = e.id and i.due_date <= ${today} and i.status not in ('paid', 'waived', 'cancelled') and i.paid + i.waived < i.amount)`);
    }
    if (segments.includes('low_attendance')) {
      const threshold = (await this.access.institution()).settings.lowAttendanceThreshold;
      filters.push(sql`e.attendance_pct < ${threshold}`);
    }
    const population = await dbx.execute<{ student_user: string | null; student_id: string; batch_id: string; branch_id: string }>(sql`
      select st.user_id as student_user, st.id as student_id, e.batch_id, e.branch_id
      from enrollment e join student st on st.id = e.student_id join batch b on b.id = e.batch_id
      where e.status = 'active' and (${sql.join(ors, sql` or `)})${filters.length ? sql` and ${sql.join(filters, sql` and `)}` : sql``}`);
    const users = new Set<string>();
    let students = 0;
    let parents = 0;
    let staff = 0;
    if (roles.has('students')) {
      for (const p of population) if (p.student_user && !users.has(p.student_user)) {
        users.add(p.student_user);
        students++;
      }
    }
    const studentIds = [...new Set(population.map((p) => p.student_id))];
    if (roles.has('parents') && studentIds.length) {
      const g = await dbx.execute<{ user_id: string | null }>(sql`
        select distinct g.user_id from student_guardian sg join guardian g on g.id = sg.guardian_id where sg.student_id in ${uuidList(studentIds)}`);
      for (const r of g) if (r.user_id && !users.has(r.user_id)) {
        users.add(r.user_id);
        parents++;
      }
    }
    const popBatches = [...new Set([...population.map((p) => p.batch_id), ...batches])];
    if (roles.has('teachers') && popBatches.length) {
      const t = await dbx.select({ id: s.teacherAssignment.teacherUserId }).from(s.teacherAssignment).where(and(inArray(s.teacherAssignment.batchId, popBatches), eq(s.teacherAssignment.active, true)));
      for (const r of t) if (!users.has(r.id)) {
        users.add(r.id);
        staff++;
      }
    }
    if (roles.has('staff')) {
      const popBranches = [...new Set([...population.map((p) => p.branch_id), ...branches])];
      const rows = await dbx.execute<{ user_id: string }>(sql`
        select distinct m.user_id from membership m join role r on r.id = m.role_id join "user" u on u.id = m.user_id
        where m.status = 'active' and r.surface = 'staff' and u.status <> 'deactivated'
          and ${everyone ? sql`true` : popBranches.length ? sql`m.branch_ids && array[${sql.join(popBranches.map((b) => sql`${b}::uuid`), sql`, `)}]` : sql`false`}`);
      for (const r of rows) if (!users.has(r.user_id)) {
        users.add(r.user_id);
        staff++;
      }
    }
    return { userIds: [...users], students, parents, staff };
  }

  summary(audience: AudienceTarget[]): string {
    return audience.map((t) => (t.type === 'segment' ? `Segment: ${AUDIENCE_SEGMENT_LABEL[t.value as AudienceSegment] ?? t.value}` : t.label)).join(' · ');
  }
}
