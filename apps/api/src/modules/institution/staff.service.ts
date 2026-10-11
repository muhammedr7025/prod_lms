import { Injectable } from '@nestjs/common';
import type { InstLeaveRow, InstMembership, InstStaffDetail, InstStaffList, InstStaffRow, InstTag, InviteInput, MembershipInput } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type DbOrTx, type SQL, type Tx } from '@exatech/db';
import { addDays, formatDate, formatDayMonth, formatWeekdayDate, maskEmail, maskPhone, minutesOf, normalizePhone, todayIST } from '@exatech/domain';
import { env } from '../../config/env';
import { AccessService } from '../../core/auth/access.service';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, branchScope, can, ctx } from '../../core/context';
import { afterCommit, Db } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { MessagingService } from '../../core/messaging/messaging.service';
import { NotifyService } from '../../core/notifications/notify.service';
import {
  AUTH_METHOD_LABEL,
  deviceLabel,
  idList,
  LEAVE_STATUS_META,
  LEAVE_TYPE_LABEL,
  LIVE_BATCH_STATUSES,
  membershipLabel,
  roleShort,
  scopeLabelFor,
  scopeSql,
} from './institution.shared';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface MembershipRow {
  id: string;
  userId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeKind: string;
  surface: string;
  branchIds: string[];
  scopeLabel: string | null;
  isDefault: boolean;
  position: number;
}

interface ResolvedMembership {
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeKind: string;
  branchIds: string[];
  scopeLabel: string;
}

/**
 * Staff & teachers: one person, many memberships (role × scope). System of
 * record for user (staff), staff_profile and membership; also writes
 * teacher_assignment (Assign to batch) and leave recorded on someone's
 * behalf — both owned by this screen per PRD §5.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly messaging: MessagingService,
  ) {}

  /* ───────────────────────── Reads ───────────────────────── */

  private async branchMap() {
    const rows = await this.db.db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name }).from(s.branch);
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async memberships(userIds: string[]): Promise<MembershipRow[]> {
    if (userIds.length === 0) return [];
    return this.db.db
      .select({
        id: s.membership.id,
        userId: s.membership.userId,
        roleId: s.role.id,
        roleKey: s.role.key,
        roleName: s.role.name,
        scopeKind: s.role.scopeKind,
        surface: s.role.surface,
        branchIds: s.membership.branchIds,
        scopeLabel: s.membership.scopeLabel,
        isDefault: s.membership.isDefault,
        position: s.role.position,
      })
      .from(s.membership)
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .where(and(inArray(s.membership.userId, userIds), eq(s.membership.status, 'active')))
      .orderBy(sql`${s.membership.isDefault} desc`, asc(s.role.position));
  }

  private toMembership(m: MembershipRow, codeOf: (id: string) => string): InstMembership {
    return {
      id: m.id,
      roleId: m.roleId,
      roleKey: m.roleKey,
      roleLabel: m.roleName,
      roleShort: roleShort(m.roleKey, m.roleName),
      scopeKind: m.scopeKind,
      branchIds: m.branchIds,
      scopeLabel: m.scopeLabel ?? '',
      label: membershipLabel(m, codeOf),
      isDefault: m.isDefault,
    };
  }

  /** Active teaching assignments (batch · subject) for a set of teachers. */
  private async assignments(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.db.db
      .select({
        id: s.teacherAssignment.id,
        userId: s.teacherAssignment.teacherUserId,
        batchId: s.batch.id,
        batchCode: s.batch.code,
        branchId: s.batch.branchId,
        subject: s.teacherAssignment.subjectName,
        courseName: s.course.name,
        capacity: s.batch.capacity,
        roomId: s.batch.roomId,
        mode: s.batch.mode,
        status: s.batch.status,
      })
      .from(s.teacherAssignment)
      .innerJoin(s.batch, eq(s.batch.id, s.teacherAssignment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(and(inArray(s.teacherAssignment.teacherUserId, userIds), eq(s.teacherAssignment.active, true), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
      .orderBy(asc(s.batch.code));
  }

  /** Timetabled hours over the next 7 days (today included) per teacher. */
  private async load(userIds: string[], from: string, to: string): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db.db
      .select({ userId: s.classSession.teacherUserId, start: s.classSession.startTime, end: s.classSession.endTime })
      .from(s.classSession)
      .where(and(inArray(s.classSession.teacherUserId, userIds), gte(s.classSession.date, from), lte(s.classSession.date, to), inArray(s.classSession.status, ['scheduled', 'held'])));
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.userId, (out.get(r.userId) ?? 0) + (minutesOf(r.end) - minutesOf(r.start)) / 60);
    return out;
  }

  private status(u: { status: string }, onLeaveToday: boolean, branches: Set<string>): { status: InstStaffRow['status']; label: string; tag: InstTag } {
    if (u.status === 'deactivated') return { status: 'deactivated', label: 'Deactivated', tag: 'ink' };
    if (u.status === 'invited') return { status: 'invited', label: 'Invited', tag: 'plain' };
    if (onLeaveToday) return { status: 'leave', label: 'On leave today', tag: 'outline' };
    if (branches.size > 1) return { status: 'cross_branch', label: 'Cross-branch', tag: 'neutral' };
    return { status: 'active', label: 'Active', tag: 'accent' };
  }

  /** Staff user ids visible in a branch scope (membership in, or home branch in, the scope). */
  private inScope(scope: string[] | null): SQL {
    if (scope === null) return sql`true`;
    if (scope.length === 0) return sql`false`;
    return sql`(exists (select 1 from membership m where m.user_id = "user"."id" and m.status = 'active' and m.branch_ids && array[${sql.join(
      scope.map((x) => sql`${x}::uuid`),
      sql`, `,
    )}]) or exists (select 1 from staff_profile sp where sp.user_id = "user"."id" and sp.home_branch_id in ${idList(scope)}))`;
  }

  async list(): Promise<InstStaffList> {
    const scope = branchScope();
    const today = todayIST();
    const users = await this.db.db
      .select({ id: s.user.id, name: s.user.name, status: s.user.status, title: s.staffProfile.title, home: s.staffProfile.homeBranchId, profileStatus: s.staffProfile.status })
      .from(s.user)
      .leftJoin(s.staffProfile, eq(s.staffProfile.userId, s.user.id))
      .where(and(eq(s.user.kind, 'staff'), this.inScope(scope)))
      .orderBy(asc(s.user.name));
    const ids = users.map((u) => u.id);
    const branches = await this.branchMap();
    const codeOf = (id: string) => branches.get(id)?.code ?? '?';
    const [mships, assigns, load, leaveToday] = await Promise.all([
      this.memberships(ids),
      this.assignments(ids),
      this.load(ids, today, addDays(today, 6)),
      ids.length
        ? this.db.db.select({ userId: s.leave.userId }).from(s.leave).where(and(inArray(s.leave.userId, ids), eq(s.leave.date, today), eq(s.leave.status, 'approved')))
        : Promise.resolve([] as { userId: string }[]),
    ]);
    const rows: InstStaffRow[] = users.map((u) => {
      const ms = mships.filter((m) => m.userId === u.id);
      const as = assigns.filter((a) => a.userId === u.id);
      const working = new Set<string>();
      for (const m of ms) if (m.scopeKind !== 'institution') m.branchIds.forEach((b) => working.add(b));
      for (const a of as) working.add(a.branchId);
      const st = this.status(u, leaveToday.some((l) => l.userId === u.id) || u.profileStatus === 'leave', working);
      const hours = Math.round((load.get(u.id) ?? 0) * 10) / 10;
      return {
        userId: u.id,
        name: u.name,
        title: u.title,
        memberships: ms.map((m) => membershipLabel(m, codeOf)).join(' · ') || 'No membership',
        homeBranch: u.home ? (branches.get(u.home)?.name ?? null) : null,
        teaches: as.length ? as.map((a) => `${a.batchCode} · ${a.subject}`).join('; ') : '—',
        loadHours: hours,
        loadLabel: hours > 0 ? `${hours} h / wk` : as.length ? '0 h / wk' : '—',
        status: st.status,
        statusLabel: st.label,
        statusTag: st.tag,
      };
    });
    return {
      scopeLabel: await this.scopeLabel(scope),
      count: rows.filter((r) => r.status !== 'deactivated').length,
      rows,
      notes: await this.notes(scope, today, branches, assigns),
      canManage: can('institution:staff.manage'),
    };
  }

  private async scopeLabel(scope: string[] | null): Promise<string> {
    if (scope === null) return 'All branches';
    const rows = scope.length ? await this.db.db.select({ name: s.branch.name }).from(s.branch).where(inArray(s.branch.id, scope)) : [];
    return rows.map((r) => r.name).join(' · ') || 'No branch';
  }

  /** "Leave & substitutes": upcoming leave needing cover, cross-branch on-site days, pending requests. */
  private async notes(
    scope: string[] | null,
    today: string,
    branches: Map<string, { id: string; code: string; name: string }>,
    assigns: { userId: string; branchId: string; batchCode: string }[],
  ): Promise<InstStaffList['notes']> {
    const out: InstStaffList['notes'] = [];
    const leaveRows = await this.db.db
      .select({ l: s.leave, name: s.user.name })
      .from(s.leave)
      .innerJoin(s.user, eq(s.user.id, s.leave.userId))
      .where(and(scopeSql(sql`${s.leave.branchId}`, scope), gte(s.leave.date, today), lte(s.leave.date, addDays(today, 30)), inArray(s.leave.status, ['approved', 'pending'])))
      .orderBy(asc(s.leave.date))
      .limit(12);
    for (const r of leaveRows.filter((x) => x.l.status === 'approved')) {
      const impact = await this.leaveImpact(r.l.userId, r.l.date);
      out.push({ key: `leave:${r.l.id}`, userId: r.l.userId, title: `${r.name} · ${formatWeekdayDate(r.l.date)}`, tag: impact.text, tagVariant: impact.tag });
    }
    // Cross-branch on-site days (teachers working in more than one branch).
    const inst = await this.access.institution();
    const profiles = await this.db.db
      .select({ userId: s.staffProfile.userId, name: s.user.name, home: s.staffProfile.homeBranchId, days: s.staffProfile.onSiteDays })
      .from(s.staffProfile)
      .innerJoin(s.user, eq(s.user.id, s.staffProfile.userId))
      .where(and(ne(s.user.status, 'deactivated'), sql`jsonb_typeof(${s.staffProfile.onSiteDays}) = 'object'`));
    for (const p of profiles) {
      const entries = Object.entries(p.days ?? {}).filter(([, d]) => Array.isArray(d) && d.length > 0);
      if (entries.length < 2) continue;
      for (const [branchId, days] of entries) {
        if (branchId === p.home) continue;
        if (scope && !scope.includes(branchId) && !(p.home && scope.includes(p.home))) continue;
        const codes = assigns.filter((a) => a.userId === p.userId && a.branchId === branchId).map((a) => a.batchCode);
        const dayLabel = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join('/');
        out.push({
          key: `site:${p.userId}:${branchId}`,
          userId: p.userId,
          title: `${p.name} · ${dayLabel}${codes.length ? ` ${codes.join(', ')}` : ''} (${branches.get(branchId)?.code ?? '?'})`,
          tag: `Cross-branch · ${inst.settings.travelBufferMinutes} min buffer`,
          tagVariant: 'neutral',
        });
      }
    }
    for (const r of leaveRows.filter((x) => x.l.status === 'pending')) {
      out.push({ key: `pending:${r.l.id}`, userId: r.l.userId, title: `${r.name} · ${formatDayMonth(r.l.date)}`, tag: 'Pending approval', tagVariant: 'outline' });
    }
    return out.slice(0, 8);
  }

  /** What a day off means for the timetable: sessions still needing a substitute, or covered. */
  private async leaveImpact(userId: string, date: string): Promise<{ text: string; tag: InstTag }> {
    const own = await this.db.db
      .select({ code: s.batch.code, start: s.classSession.startTime })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .where(and(eq(s.classSession.teacherUserId, userId), eq(s.classSession.date, date), eq(s.classSession.status, 'scheduled')))
      .orderBy(asc(s.classSession.startTime));
    if (own.length) return { text: `${own.map((x) => `${x.code} ${x.start}`).join(', ')} · substitute needed`, tag: 'outline' };
    const covered = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.classSession)
      .where(and(eq(s.classSession.substituteForUserId, userId), eq(s.classSession.date, date), eq(s.classSession.status, 'scheduled')));
    if (Number(covered[0]?.n ?? 0) > 0) return { text: `${covered[0]!.n} session${Number(covered[0]!.n) === 1 ? '' : 's'} covered`, tag: 'accent' };
    return { text: 'No sessions that day', tag: 'neutral' };
  }

  private async leaveRows(where: SQL | undefined, limit = 100): Promise<InstLeaveRow[]> {
    const rows = await this.db.db
      .select({ l: s.leave, name: s.user.name })
      .from(s.leave)
      .innerJoin(s.user, eq(s.user.id, s.leave.userId))
      .where(where)
      .orderBy(asc(s.leave.date), asc(s.user.name))
      .limit(limit);
    const out: InstLeaveRow[] = [];
    for (const r of rows) {
      const meta = LEAVE_STATUS_META[r.l.status] ?? { label: r.l.status, tag: 'neutral' as const };
      const impact = r.l.status === 'rejected' || r.l.status === 'cancelled' ? { text: '—' } : await this.leaveImpact(r.l.userId, r.l.date);
      out.push({
        id: r.l.id,
        userId: r.l.userId,
        name: r.name,
        date: r.l.date,
        dateLabel: formatWeekdayDate(r.l.date),
        type: LEAVE_TYPE_LABEL[r.l.type] ?? r.l.type,
        reason: r.l.reason,
        status: r.l.status,
        statusLabel: meta.label,
        statusTag: meta.tag,
        impact: impact.text,
      });
    }
    return out;
  }

  async leaveCalendar(): Promise<InstLeaveRow[]> {
    return this.leaveRows(and(scopeSql(sql`${s.leave.branchId}`), gte(s.leave.date, todayIST())));
  }

  async options() {
    const inst = await this.access.institution();
    const roles = await this.db.db
      .select()
      .from(s.role)
      .where(and(eq(s.role.institutionId, inst.id), or(eq(s.role.surface, 'staff'), eq(s.role.key, 'teacher'), eq(s.role.scopeKind, 'batch'))))
      .orderBy(asc(s.role.position), asc(s.role.name));
    const scope = ctx().membershipBranchIds;
    const branches = await this.access.activeBranches();
    return {
      roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, short: roleShort(r.key, r.name), scopeKind: r.scopeKind, surface: r.surface, isSystem: r.isSystem })),
      branches: scope ? branches.filter((b) => scope.includes(b.id)) : branches,
    };
  }

  /** Throws unless the person works inside the caller's membership branches. */
  private async assertPersonInScope(userId: string, home: string | null): Promise<void> {
    const mine = ctx().membershipBranchIds;
    if (mine === null) return;
    if (home && mine.includes(home)) return;
    const ms = await this.memberships([userId]);
    if (ms.some((m) => m.branchIds.some((b) => mine.includes(b)))) return;
    throw forbidden('This person works outside your branch');
  }

  async get(userId: string): Promise<InstStaffDetail> {
    const [u] = await this.db.db
      .select({ u: s.user, p: s.staffProfile })
      .from(s.user)
      .leftJoin(s.staffProfile, eq(s.staffProfile.userId, s.user.id))
      .where(eq(s.user.id, userId));
    if (!u || u.u.kind !== 'staff') throw notFound('Staff member');
    await this.assertPersonInScope(userId, u.p?.homeBranchId ?? null);
    const c = ctx();
    const today = todayIST();
    const end = addDays(today, 6);
    const branches = await this.branchMap();
    const codeOf = (id: string) => branches.get(id)?.code ?? '?';
    const [mships, assigns, load] = await Promise.all([this.memberships([userId]), this.assignments([userId]), this.load([userId], today, end)]);
    const memberships = mships.map((m) => this.toMembership(m, codeOf));
    const isTeacher = mships.some((m) => m.roleKey === 'teacher' || m.scopeKind === 'batch');

    // Teaching table.
    const roomIds = [...new Set(assigns.map((a) => a.roomId).filter((x): x is string => !!x))];
    const rooms = roomIds.length ? await this.db.db.select({ id: s.room.id, name: s.room.name }).from(s.room).where(inArray(s.room.id, roomIds)) : [];
    const batchIds = assigns.map((a) => a.batchId);
    const [enrolled, perWeek] = batchIds.length
      ? await Promise.all([
          this.db.db
            .select({ batchId: s.enrollment.batchId, n: sql<number>`count(*)::int` })
            .from(s.enrollment)
            .where(and(inArray(s.enrollment.batchId, batchIds), eq(s.enrollment.status, 'active')))
            .groupBy(s.enrollment.batchId),
          this.db.db
            .select({ batchId: s.classSession.batchId, n: sql<number>`count(*)::int` })
            .from(s.classSession)
            .where(
              and(
                inArray(s.classSession.batchId, batchIds),
                or(eq(s.classSession.teacherUserId, userId), eq(s.classSession.substituteForUserId, userId)),
                eq(s.classSession.kind, 'timetabled'),
                gte(s.classSession.date, today),
                lte(s.classSession.date, end),
                ne(s.classSession.status, 'cancelled'),
              ),
            )
            .groupBy(s.classSession.batchId),
        ])
      : [[], []];

    // This week (next 7 days): own sessions + sessions handed to a substitute.
    const sub = sql`(select name from "user" su where su.id = class_session.teacher_user_id)`;
    const week = await this.db.db
      .select({ cs: s.classSession, code: s.batch.code, room: s.room.name, subName: sql<string | null>`${sub}` })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(and(or(eq(s.classSession.teacherUserId, userId), eq(s.classSession.substituteForUserId, userId)), gte(s.classSession.date, today), lte(s.classSession.date, end), ne(s.classSession.status, 'cancelled')))
      .orderBy(asc(s.classSession.date), asc(s.classSession.startTime))
      .limit(40);

    // Marks pending: draft / returned exams with blank rows.
    const pending = await this.db.db.execute<{ name: string; rows: number }>(sql`
      select e.name, count(distinct m.enrollment_id)::int as rows
      from exam e join mark m on m.exam_id = e.id
      where e.teacher_user_id = ${userId} and e.status in ('draft', 'returned') and m.value is null
      group by e.id, e.name, e.date order by e.date asc`);
    const marksPending = pending.length ? `${pending[0]!.name} · ${pending[0]!.rows} row${Number(pending[0]!.rows) === 1 ? '' : 's'}${pending.length > 1 ? ` · +${pending.length - 1} more` : ''}` : 'Nothing pending';

    const materials = await this.db.db
      .select({ id: s.material.id, code: s.batch.code, title: s.material.title, visibility: s.material.visibility, releaseAt: s.material.releaseAt })
      .from(s.material)
      .innerJoin(s.batch, eq(s.batch.id, s.material.batchId))
      .where(and(eq(s.material.uploadedBy, userId), isNull(s.material.removedAt)))
      .orderBy(desc(s.material.createdAt));

    const leave = await this.leaveRows(and(eq(s.leave.userId, userId), gte(s.leave.date, addDays(today, -30))), 20);
    const upcomingLeave = leave.filter((l) => l.date >= today && (l.status === 'approved' || l.status === 'pending'));
    const leaveSummary = upcomingLeave.length
      ? upcomingLeave
          .slice(0, 2)
          .map((l) => `${l.dateLabel} · ${l.type.toLowerCase()} · ${l.statusLabel.toLowerCase()}${l.impact !== 'No sessions that day' ? ` · ${l.impact}` : ''}`)
          .join('; ')
      : 'No leave booked';

    const devices = await this.db.db
      .select()
      .from(s.session)
      .where(and(eq(s.session.userId, userId), sql`${s.session.expiresAt} > now()`))
      .orderBy(desc(s.session.createdAt))
      .limit(20);

    // Assignable batches: live batches in the person's teaching branches.
    const teachBranches = new Set<string>();
    for (const m of mships) if (m.roleKey === 'teacher' || m.scopeKind === 'batch') m.branchIds.forEach((b) => teachBranches.add(b));
    const mine = c.membershipBranchIds;
    const assignable = teachBranches.size
      ? await this.db.db
          .select({ id: s.batch.id, code: s.batch.code, status: s.batch.status, branchId: s.batch.branchId, courseId: s.batch.courseId, courseName: s.course.name })
          .from(s.batch)
          .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
          .where(and(inArray(s.batch.branchId, [...teachBranches].filter((b) => !mine || mine.includes(b))), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
          .orderBy(asc(s.batch.code))
      : [];
    const courseIds = [...new Set(assignable.map((b) => b.courseId))];
    const subjects = courseIds.length
      ? await this.db.db.select({ courseId: s.courseSubject.courseId, name: s.courseSubject.name }).from(s.courseSubject).where(inArray(s.courseSubject.courseId, courseIds)).orderBy(asc(s.courseSubject.position))
      : [];
    const taken = assignable.length
      ? await this.db.db
          .select({ batchId: s.teacherAssignment.batchId, subject: s.teacherAssignment.subjectName, teacherUserId: s.teacherAssignment.teacherUserId, teacherName: s.user.name })
          .from(s.teacherAssignment)
          .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
          .where(and(inArray(s.teacherAssignment.batchId, assignable.map((b) => b.id)), eq(s.teacherAssignment.active, true)))
      : [];

    const leaveToday = leave.some((l) => l.date === today && l.status === 'approved') || u.p?.status === 'leave';
    const working = new Set<string>();
    for (const m of mships) if (m.scopeKind !== 'institution') m.branchIds.forEach((b) => working.add(b));
    for (const a of assigns) working.add(a.branchId);
    const st = this.status(u.u, leaveToday, working);
    const def = mships[0];
    const hours = Math.round((load.get(userId) ?? 0) * 10) / 10;
    const VIS: Record<string, { label: string; tag: InstTag }> = { always: { label: 'Always visible', tag: 'accent' }, fee_gated: { label: 'Fee-gated', tag: 'neutral' }, scheduled: { label: 'Scheduled', tag: 'outline' } };

    return {
      userId,
      name: u.u.name,
      title: u.p?.title ?? null,
      kicker: `${def ? roleShort(def.roleKey, def.roleName) : 'Staff'} · ${u.p?.homeBranchId ? (branches.get(u.p.homeBranchId)?.name ?? '—') : 'No home branch'}`,
      userStatus: u.u.status,
      status: st.status,
      statusLabel: st.label,
      statusTag: st.tag,
      kpis: {
        batches: assigns.length,
        subjects: new Set(assigns.map((a) => a.subject)).size,
        hoursThisWeek: hours,
        hoursLabel: `${hours} h`,
        materials: materials.length,
        marksPending,
      },
      memberships,
      teaching: assigns.map((a) => ({
        assignmentId: a.id,
        batchId: a.batchId,
        batchCode: a.batchCode,
        branchCode: codeOf(a.branchId),
        courseName: a.courseName,
        subject: a.subject,
        sessionsPerWeek: Number(perWeek.find((x) => x.batchId === a.batchId)?.n ?? 0),
        room: a.mode === 'online' ? 'Online' : (rooms.find((r) => r.id === a.roomId)?.name ?? '—'),
        seats: `${Number(enrolled.find((x) => x.batchId === a.batchId)?.n ?? 0)} / ${a.capacity}`,
      })),
      week: week.map((w) => {
        const handedOver = w.cs.teacherUserId !== userId;
        const flag =
          w.cs.status === 'suppressed'
            ? 'holiday · suppressed'
            : handedOver
              ? `covered by ${w.subName ?? 'substitute'}`
              : (w.cs.flag ?? (w.cs.kind === 'adhoc' ? 'ad-hoc' : w.cs.kind === 'exam' ? 'exam' : w.cs.substituteForUserId ? 'substitute' : null));
        return {
          id: w.cs.id,
          date: w.cs.date,
          when: `${w.cs.date === today ? 'Today' : formatWeekdayDate(w.cs.date)} · ${w.cs.startTime}`,
          what: `${w.code} · ${w.cs.topic ?? w.cs.subjectName}`,
          where: w.cs.mode === 'online' ? 'Online' : (w.room ?? 'No room'),
          flag,
        };
      }),
      facts: {
        email: maskEmail(u.u.email),
        phone: maskPhone(u.u.phoneNumber),
        homeBranch: u.p?.homeBranchId ? (branches.get(u.p.homeBranchId)?.name ?? '—') : '—',
        title: u.p?.title ?? '—',
        employeeCode: u.p?.employeeCode ?? '—',
        joined: u.p?.joinedOn ? formatDate(u.p.joinedOn) : '—',
      },
      leaveSummary,
      leave,
      materials: materials.map((m) => {
        const v = VIS[m.visibility] ?? { label: m.visibility, tag: 'neutral' as const };
        return { id: m.id, batchCode: m.code, title: m.title, visibility: m.visibility, visLabel: m.visibility === 'scheduled' && m.releaseAt ? `Scheduled · ${formatDayMonth(m.releaseAt.toISOString().slice(0, 10))}` : v.label, visTag: v.tag };
      }),
      devices: devices.map((d) => ({
        id: d.id,
        device: deviceLabel(d.userAgent),
        method: AUTH_METHOD_LABEL[d.authMethod ?? ''] ?? d.authMethod ?? 'Sign-in',
        ip: d.ipAddress,
        createdAt: d.createdAt.toISOString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        current: d.id === c.sessionId,
      })),
      assignOptions: assignable.map((b) => ({
        batchId: b.id,
        code: b.code,
        courseName: b.courseName,
        branchCode: codeOf(b.branchId),
        status: b.status,
        subjects: subjects.filter((x) => x.courseId === b.courseId).map((x) => x.name),
        taken: taken.filter((t) => t.batchId === b.id).map((t) => ({ subject: t.subject, teacherName: t.teacherName, teacherUserId: t.teacherUserId })),
      })),
      isTeacher,
      isSelf: userId === c.userId,
      canManage: can('institution:staff.manage'),
    };
  }

  /* ───────────────────────── Memberships ───────────────────────── */

  /** Validate role × scope inputs and compute their scope labels. */
  private async resolve(tx: DbOrTx, userId: string | null, inputs: MembershipInput[]): Promise<ResolvedMembership[]> {
    const inst = await this.access.institution();
    const roleIds = inputs.map((m) => m.roleId);
    if (new Set(roleIds).size !== roleIds.length) throw invalid('Each role can be added once — add more branches to the same membership instead', { memberships: 'Duplicate role' });
    const roles = roleIds.length ? await tx.select().from(s.role).where(and(eq(s.role.institutionId, inst.id), inArray(s.role.id, roleIds))) : [];
    const branchRows = await tx.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name, status: s.branch.status }).from(s.branch);
    const assigned = userId
      ? await tx
          .select({ code: s.batch.code, branchId: s.batch.branchId })
          .from(s.teacherAssignment)
          .innerJoin(s.batch, eq(s.batch.id, s.teacherAssignment.batchId))
          .where(and(eq(s.teacherAssignment.teacherUserId, userId), eq(s.teacherAssignment.active, true), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
          .orderBy(asc(s.batch.code))
      : [];
    const out: ResolvedMembership[] = [];
    for (const input of inputs) {
      const role = roles.find((r) => r.id === input.roleId);
      if (!role) throw invalid('That role no longer exists — reload and pick again', { memberships: 'Unknown role' });
      if (role.surface === 'portal' && role.key !== 'teacher' && role.scopeKind !== 'batch') throw invalid(`${role.name} accounts come from admissions, not staff invites`, { memberships: 'Portal role' });
      if (role.scopeKind === 'institution') {
        if (!can('institution:roles.manage')) throw forbidden('Only a Super Admin can grant institution-wide access');
        out.push({ roleId: role.id, roleKey: role.key, roleName: role.name, scopeKind: role.scopeKind, branchIds: [], scopeLabel: 'Institution' });
        continue;
      }
      const ids = [...new Set(input.branchIds ?? [])];
      if (ids.length === 0) throw invalid(`Pick at least one branch for ${role.name}`, { memberships: 'Branch required' });
      const chosen = ids.map((id) => {
        const b = branchRows.find((x) => x.id === id);
        if (!b) throw invalid('That branch no longer exists', { memberships: 'Unknown branch' });
        if (b.status === 'archived') throw invalid(`${b.name} is archived — reactivate it first`, { memberships: 'Archived branch' });
        assertBranchAccess(id);
        return b;
      });
      chosen.sort((a, b) => a.code.localeCompare(b.code));
      const batchCodes = role.scopeKind === 'batch' ? assigned.filter((a) => ids.includes(a.branchId)).map((a) => a.code) : [];
      out.push({ roleId: role.id, roleKey: role.key, roleName: role.name, scopeKind: role.scopeKind, branchIds: chosen.map((b) => b.id), scopeLabel: scopeLabelFor(role, chosen, batchCodes) });
    }
    return out;
  }

  private async activeSuperAdmins(tx: DbOrTx, exceptUserId?: string): Promise<number> {
    const [row] = await tx.execute<{ n: number }>(sql`
      select count(distinct m.user_id)::int as n from membership m join role r on r.id = m.role_id join "user" u on u.id = m.user_id
      where r.key = 'superadmin' and m.status = 'active' and u.status <> 'deactivated' ${exceptUserId ? sql`and m.user_id <> ${exceptUserId}` : sql``}`);
    return Number(row?.n ?? 0);
  }

  private nextEmployeeCode = async (tx: Tx): Promise<string> => {
    const [row] = await tx.execute<{ n: number | null }>(sql`select max(nullif(regexp_replace(employee_code, '\\D', '', 'g'), '')::int) as n from staff_profile where employee_code like 'EX-%'`);
    return `EX-${String(Number(row?.n ?? 0) + 1).padStart(3, '0')}`;
  };

  async invite(body: InviteInput & { email: string }) {
    const c = ctx();
    const phone = normalizePhone(body.phone);
    if (!phone) throw invalid('Enter a valid 10-digit mobile', { phone: 'Enter a valid 10-digit mobile' });
    assertBranchAccess(body.homeBranchId);
    const result = await this.db.tx(async (tx) => {
      const [byEmail] = await tx.select({ name: s.user.name, kind: s.user.kind }).from(s.user).where(sql`lower(${s.user.email}) = ${body.email.toLowerCase()}`);
      if (byEmail) throw invalid(`${body.email} already belongs to ${byEmail.kind === 'staff' ? byEmail.name : `a ${byEmail.kind} account`} — one person, one account`, { email: 'Already in use' });
      const [byPhone] = await tx.select({ name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.phoneNumber, phone));
      if (byPhone) throw invalid(`${maskPhone(phone)} already belongs to ${byPhone.kind === 'staff' ? byPhone.name : `a ${byPhone.kind} account`}`, { phone: 'Already in use' });
      const [home] = await tx.select({ name: s.branch.name, code: s.branch.code }).from(s.branch).where(eq(s.branch.id, body.homeBranchId));
      if (!home) throw invalid('Choose the home branch', { homeBranchId: 'Unknown branch' });
      const memberships = await this.resolve(tx, null, body.memberships);
      const [u] = await tx
        .insert(s.user)
        .values({ name: body.name.trim(), email: body.email.toLowerCase(), emailVerified: false, phoneNumber: phone, phoneNumberVerified: false, kind: 'staff', status: 'invited', invitedAt: new Date() })
        .returning({ id: s.user.id, name: s.user.name, email: s.user.email });
      await tx.insert(s.staffProfile).values({ userId: u!.id, homeBranchId: body.homeBranchId, title: body.title?.trim() || null, employeeCode: await this.nextEmployeeCode(tx), status: 'active', joinedOn: todayIST() });
      await tx.insert(s.membership).values(memberships.map((m, i) => ({ userId: u!.id, roleId: m.roleId, branchIds: m.branchIds, scopeLabel: m.scopeLabel, isDefault: i === 0, createdBy: c.userId })));
      const branches = await this.branchMap();
      const labels = memberships.map((m) => membershipLabel({ ...m }, (id) => branches.get(id)?.code ?? '?'));
      const link = `${env().WEB_ORIGIN}/sign-in?email=${encodeURIComponent(u!.email)}`;
      const roleLine = memberships.map((m) => `${m.roleName} · ${m.scopeLabel}`).join(', ');
      const emailId = await this.messaging.queue(tx, {
        channel: 'email',
        to: u!.email,
        toUserId: u!.id,
        template: 'staff_invite',
        subject: `${c.userName} invited you to Exatech`,
        body: `Hi ${u!.name},\n\n${c.userName} has invited you to Exatech as ${roleLine}.\n\nSign in here — with a one-time email link, a code on your phone, or Google with this address:\n${link}\n\nAccounts are invite-only, so use ${u!.email} or ${phone}.\n\n— Exatech`,
      });
      const waId = await this.messaging.queue(tx, {
        channel: 'whatsapp',
        to: phone,
        toUserId: u!.id,
        template: 'staff_invite',
        body: `Hi ${u!.name}, ${c.userName} invited you to Exatech as ${roleLine}. Sign in: ${link}`,
      });
      afterCommit(tx, async () => {
        await this.messaging.deliver(emailId);
        await this.messaging.deliver(waId);
      });
      await this.audit.log(tx, {
        action: 'Staff invited',
        kind: 'create',
        entityType: 'user',
        entityId: u!.id,
        entityLabel: u!.name,
        after: { email: u!.email, phone: maskPhone(phone), homeBranch: home.code, title: body.title ?? null, memberships: labels },
        summary: `${u!.name} · ${labels.join(' · ')} · home ${home.code} · invite sent by email + WhatsApp`,
        branchId: body.homeBranchId,
      });
      this.notify.invalidate(tx, body.homeBranchId, [['institution'], ['reference']]);
      return { userId: u!.id, name: u!.name };
    });
    await this.access.bump();
    return result;
  }

  async setMemberships(userId: string, inputs: MembershipInput[]): Promise<InstMembership[]> {
    const c = ctx();
    if (inputs.length === 0) throw invalid('Keep at least one membership — to remove all access, deactivate the account instead', { memberships: 'At least one' });
    await this.db.tx(async (tx) => {
      const [u] = await tx.select({ name: s.user.name, kind: s.user.kind, status: s.user.status }).from(s.user).where(eq(s.user.id, userId)).for('update');
      if (!u || u.kind !== 'staff') throw notFound('Staff member');
      const [p] = await tx.select({ home: s.staffProfile.homeBranchId }).from(s.staffProfile).where(eq(s.staffProfile.userId, userId));
      await this.assertPersonInScope(userId, p?.home ?? null);
      const before = await tx
        .select({ id: s.membership.id, roleId: s.membership.roleId, roleKey: s.role.key, roleName: s.role.name, scopeKind: s.role.scopeKind, branchIds: s.membership.branchIds, scopeLabel: s.membership.scopeLabel, isDefault: s.membership.isDefault })
        .from(s.membership)
        .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
        .where(eq(s.membership.userId, userId));
      const next = await this.resolve(tx, userId, inputs);
      const hadSuper = before.some((m) => m.roleKey === 'superadmin');
      const keepsSuper = next.some((m) => m.roleKey === 'superadmin');
      if (hadSuper && !keepsSuper) {
        if (userId === c.userId) throw invalid('You can’t remove your own Super Admin membership — ask another Super Admin to do it', { memberships: 'Own Super Admin' });
        if ((await this.activeSuperAdmins(tx, userId)) === 0) throw invalid('The institution needs at least one active Super Admin', { memberships: 'Last Super Admin' });
      }
      // Branch-scoped managers cannot touch memberships outside their branches.
      const mine = c.membershipBranchIds;
      if (mine) for (const m of before) if (!next.some((n) => n.roleId === m.roleId) && m.branchIds.some((b) => !mine.includes(b))) throw forbidden(`${m.roleName} covers branches outside yours`);

      const removed = before.filter((m) => !next.some((n) => n.roleId === m.roleId));
      if (removed.length) await tx.delete(s.membership).where(inArray(s.membership.id, removed.map((m) => m.id)));
      const defaultKept = before.find((m) => m.isDefault && next.some((n) => n.roleId === m.roleId));
      for (const [i, m] of next.entries()) {
        const existing = before.find((b) => b.roleId === m.roleId);
        const isDefault = defaultKept ? existing?.id === defaultKept.id : i === 0;
        if (existing) await tx.update(s.membership).set({ branchIds: m.branchIds, scopeLabel: m.scopeLabel, isDefault, status: 'active' }).where(eq(s.membership.id, existing.id));
        else await tx.insert(s.membership).values({ userId, roleId: m.roleId, branchIds: m.branchIds, scopeLabel: m.scopeLabel, isDefault, createdBy: c.userId });
      }
      const branches = await this.branchMap();
      const codeOf = (id: string) => branches.get(id)?.code ?? '?';
      const beforeLabels = before.map((m) => membershipLabel(m, codeOf));
      const afterLabels = next.map((m) => membershipLabel(m, codeOf));
      if (beforeLabels.join('|') === afterLabels.join('|') && removed.length === 0 && before.length === next.length) return;
      await this.audit.log(tx, {
        action: 'Memberships changed',
        kind: 'update',
        entityType: 'user',
        entityId: userId,
        entityLabel: u.name,
        before: { memberships: beforeLabels },
        after: { memberships: afterLabels },
        summary: `${u.name}: ${beforeLabels.join(' · ') || 'none'} → ${afterLabels.join(' · ')}`,
        branchId: p?.home ?? null,
      });
      await this.notify.notify(tx, {
        userIds: [userId],
        category: 'message',
        title: 'Your access changed',
        body: `${c.userName} updated your memberships: ${afterLabels.join(' · ')}. Sign in again to use them.`,
        link: '/',
        entityType: 'user',
        entityId: userId,
      });
      // PRD §9.1: all sessions are revoked on role change (never the actor's own current session).
      if (userId !== c.userId) await tx.delete(s.session).where(eq(s.session.userId, userId));
      this.notify.invalidateUsers(tx, [userId], [['me']]);
      this.notify.invalidate(tx, null, [['institution']]);
    });
    await this.access.bump();
    const branches = await this.branchMap();
    return (await this.memberships([userId])).map((m) => this.toMembership(m, (id) => branches.get(id)?.code ?? '?'));
  }

  /* ───────────────────────── Teaching assignment ───────────────────────── */

  async assign(userId: string, body: { batchId: string; subjectName: string }) {
    await this.db.tx(async (tx) => {
      const [u] = await tx.select({ name: s.user.name, kind: s.user.kind, status: s.user.status }).from(s.user).where(eq(s.user.id, userId));
      if (!u || u.kind !== 'staff') throw notFound('Staff member');
      if (u.status === 'deactivated') throw invalid(`${u.name} is deactivated — reactivate the account first`);
      const [b] = await tx.select({ b: s.batch, courseName: s.course.name }).from(s.batch).innerJoin(s.course, eq(s.course.id, s.batch.courseId)).where(eq(s.batch.id, body.batchId)).for('update');
      if (!b) throw notFound('Batch');
      assertBranchAccess(b.b.branchId);
      if (!(LIVE_BATCH_STATUSES as readonly string[]).includes(b.b.status)) throw invalid(`${b.b.code} is ${b.b.status} — only live batches take new teachers`, { batchId: 'Not live' });
      const teacherMs = await tx
        .select({ id: s.membership.id, branchIds: s.membership.branchIds, roleKey: s.role.key, scopeKind: s.role.scopeKind, roleName: s.role.name })
        .from(s.membership)
        .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
        .where(and(eq(s.membership.userId, userId), eq(s.membership.status, 'active'), or(eq(s.role.key, 'teacher'), eq(s.role.scopeKind, 'batch'))));
      if (teacherMs.length === 0) throw invalid(`${u.name} has no Teacher membership — add one in Edit memberships first`, { batchId: 'Not a teacher' });
      const [branch] = await tx.select({ name: s.branch.name, code: s.branch.code }).from(s.branch).where(eq(s.branch.id, b.b.branchId));
      const ms = teacherMs.find((m) => m.branchIds.includes(b.b.branchId));
      if (!ms) throw invalid(`${b.b.code} is in ${branch?.name ?? 'another branch'} — add ${branch?.code ?? 'that branch'} to ${u.name}’s Teacher membership first`, { batchId: 'Outside teaching branches' });
      const [subject] = await tx.select({ id: s.courseSubject.id, name: s.courseSubject.name }).from(s.courseSubject).where(and(eq(s.courseSubject.courseId, b.b.courseId), eq(s.courseSubject.name, body.subjectName)));
      if (!subject) throw invalid(`${body.subjectName} is not in the ${b.courseName} syllabus`, { subjectName: 'Not in syllabus' });
      const rows = await tx
        .select({ id: s.teacherAssignment.id, teacherUserId: s.teacherAssignment.teacherUserId, subject: s.teacherAssignment.subjectName, active: s.teacherAssignment.active, isPrimary: s.teacherAssignment.isPrimary, name: s.user.name })
        .from(s.teacherAssignment)
        .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
        .where(eq(s.teacherAssignment.batchId, b.b.id));
      const own = rows.find((r) => r.teacherUserId === userId);
      if (own?.active) {
        if (own.subject === subject.name) throw conflict(`${u.name} already teaches ${subject.name} in ${b.b.code}`);
        throw invalid(`One subject per batch: ${u.name} already teaches ${own.subject} in ${b.b.code}`, { subjectName: 'One subject per batch' });
      }
      const other = rows.find((r) => r.active && r.teacherUserId !== userId && r.subject === subject.name);
      if (other) throw invalid(`${subject.name} in ${b.b.code} is taught by ${other.name} — hand it over from Courses & batches`, { subjectName: 'Taken' });
      const isPrimary = !rows.some((r) => r.active && r.isPrimary);
      if (own) await tx.update(s.teacherAssignment).set({ active: true, subjectName: subject.name, subjectId: subject.id, isPrimary }).where(eq(s.teacherAssignment.id, own.id));
      else await tx.insert(s.teacherAssignment).values({ batchId: b.b.id, teacherUserId: userId, subjectId: subject.id, subjectName: subject.name, isPrimary });
      // Keep the membership's display scope in step with the batches taught.
      const codes = await tx
        .select({ code: s.batch.code, branchId: s.batch.branchId })
        .from(s.teacherAssignment)
        .innerJoin(s.batch, eq(s.batch.id, s.teacherAssignment.batchId))
        .where(and(eq(s.teacherAssignment.teacherUserId, userId), eq(s.teacherAssignment.active, true), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
        .orderBy(asc(s.batch.code));
      await tx.update(s.membership).set({ scopeLabel: codes.filter((x) => ms.branchIds.includes(x.branchId)).map((x) => x.code).join(' · ') }).where(eq(s.membership.id, ms.id));
      await this.audit.log(tx, {
        action: 'Teacher assigned',
        kind: 'update',
        entityType: 'batch',
        entityId: b.b.id,
        entityLabel: b.b.code,
        before: own ? { subject: own.subject, active: false } : null,
        after: { teacher: u.name, subject: subject.name, isPrimary },
        summary: `${b.b.code} · ${u.name} → ${subject.name}${isPrimary ? ' (primary)' : ''}`,
        branchId: b.b.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [userId],
        category: 'timetable',
        title: `${b.b.code} · ${subject.name}`,
        body: `You now teach ${subject.name} in ${b.b.code} (${b.courseName}). Sessions follow the batch timetable.`,
        link: '/teacher',
        entityType: 'batch',
        entityId: b.b.id,
      });
      this.notify.invalidate(tx, b.b.branchId, [['institution'], ['academics'], ['reference'], ['teaching']]);
      this.notify.invalidateUsers(tx, [userId], [['me'], ['teaching']]);
    });
    await this.access.bump();
    return { ok: true as const };
  }

  /* ───────────────────────── Leave on behalf ───────────────────────── */

  async recordLeave(userId: string, body: { date: string; type: 'casual' | 'sick' | 'earned' | 'on_duty'; reason: string }) {
    const c = ctx();
    if (body.date < todayIST()) throw invalid('Leave can be recorded for today or a later date', { date: 'In the past' });
    return this.db.tx(async (tx) => {
      const [u] = await tx.select({ name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.id, userId));
      if (!u || u.kind !== 'staff') throw notFound('Staff member');
      const [p] = await tx.select({ home: s.staffProfile.homeBranchId }).from(s.staffProfile).where(eq(s.staffProfile.userId, userId));
      await this.assertPersonInScope(userId, p?.home ?? null);
      const [dup] = await tx.select({ status: s.leave.status }).from(s.leave).where(and(eq(s.leave.userId, userId), eq(s.leave.date, body.date), inArray(s.leave.status, ['pending', 'approved'])));
      if (dup) throw conflict(dup.status === 'approved' ? `${u.name} is already on leave ${formatWeekdayDate(body.date)}` : `${u.name} already asked for ${formatWeekdayDate(body.date)} — approve it from Branch operations`);
      const [firstSession] = await tx.select({ branchId: s.classSession.branchId }).from(s.classSession).where(and(eq(s.classSession.teacherUserId, userId), eq(s.classSession.date, body.date))).limit(1);
      const branchId = firstSession?.branchId ?? p?.home ?? (await this.memberships([userId])).flatMap((m) => m.branchIds)[0];
      if (!branchId) throw invalid(`${u.name} has no home branch — set one before recording leave`);
      const [l] = await tx
        .insert(s.leave)
        .values({ userId, branchId, date: body.date, type: body.type, reason: body.reason, status: 'approved', decidedBy: c.userId, decidedAt: new Date(), decisionNote: `Recorded by ${c.userName}` })
        .returning({ id: s.leave.id });
      const flagged = await tx
        .update(s.classSession)
        .set({ flag: 'leave · substitute?' })
        .where(and(eq(s.classSession.teacherUserId, userId), eq(s.classSession.date, body.date), eq(s.classSession.status, 'scheduled'), isNull(s.classSession.substituteForUserId)))
        .returning({ id: s.classSession.id, branchId: s.classSession.branchId });
      await this.events.emit(tx, 'LeaveDecided', { leaveId: l!.id, userId, branchId, date: body.date, status: 'approved' });
      await this.audit.log(tx, {
        action: 'Leave recorded',
        kind: 'create',
        entityType: 'leave',
        entityId: l!.id,
        entityLabel: `${u.name} · ${body.date}`,
        after: { date: body.date, type: body.type, reason: body.reason, status: 'approved' },
        summary: `${u.name} · ${formatWeekdayDate(body.date)} · ${LEAVE_TYPE_LABEL[body.type]} · approved on behalf${flagged.length ? ` · ${flagged.length} session${flagged.length === 1 ? '' : 's'} flagged for a substitute` : ''}`,
        branchId,
      });
      await this.notify.notify(tx, {
        userIds: [userId],
        category: 'leave',
        title: `Leave recorded · ${formatWeekdayDate(body.date)}`,
        body: `${c.userName} recorded ${LEAVE_TYPE_LABEL[body.type]!.toLowerCase()} leave for you${flagged.length ? ' — a substitute will be assigned for your sessions' : ''}.`,
        link: '/teacher',
        entityType: 'leave',
        entityId: l!.id,
      });
      for (const b of new Set(flagged.map((f) => f.branchId))) this.notify.invalidate(tx, b, [['academics'], ['teaching']]);
      this.notify.invalidate(tx, branchId, [['institution']]);
      return { id: l!.id, flagged: flagged.length };
    });
  }

  /* ───────────────────────── Status & sessions ───────────────────────── */

  async setStatus(userId: string, body: { status: 'active' | 'deactivated'; reason?: string }) {
    const c = ctx();
    const result = await this.db.tx(async (tx) => {
      const [u] = await tx.select().from(s.user).where(eq(s.user.id, userId)).for('update');
      if (!u || u.kind !== 'staff') throw notFound('Staff member');
      const [p] = await tx.select({ home: s.staffProfile.homeBranchId }).from(s.staffProfile).where(eq(s.staffProfile.userId, userId));
      await this.assertPersonInScope(userId, p?.home ?? null);
      if (body.status === 'deactivated') {
        if (userId === c.userId) throw invalid('You can’t deactivate your own account');
        if (u.status === 'deactivated') throw conflict(`${u.name} is already deactivated`);
        const isSuper = await tx.execute<{ n: number }>(sql`select count(*)::int as n from membership m join role r on r.id = m.role_id where m.user_id = ${userId} and r.key = 'superadmin' and m.status = 'active'`);
        if (Number(isSuper[0]?.n ?? 0) > 0 && (await this.activeSuperAdmins(tx, userId)) === 0) throw invalid('The institution needs at least one active Super Admin');
        await tx.update(s.user).set({ status: 'deactivated' }).where(eq(s.user.id, userId));
        await tx.update(s.staffProfile).set({ status: 'inactive' }).where(eq(s.staffProfile.userId, userId));
        const killed = await tx.delete(s.session).where(eq(s.session.userId, userId)).returning({ id: s.session.id });
        const [upcoming] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.classSession)
          .where(and(eq(s.classSession.teacherUserId, userId), gte(s.classSession.date, todayIST()), eq(s.classSession.status, 'scheduled')));
        await this.audit.log(tx, {
          action: 'Staff deactivated',
          kind: 'update',
          entityType: 'user',
          entityId: userId,
          entityLabel: u.name,
          before: { status: u.status },
          after: { status: 'deactivated', reason: body.reason ?? null },
          summary: `${u.name} · ${u.status} → deactivated · signed out of ${killed.length} session${killed.length === 1 ? '' : 's'}${Number(upcoming?.n ?? 0) ? ` · ${upcoming!.n} upcoming sessions need a teacher` : ''}${body.reason ? ` · ${body.reason}` : ''}`,
          branchId: p?.home ?? null,
        });
        this.notify.invalidate(tx, null, [['institution']]);
        return { ok: true as const, signedOut: killed.length };
      }
      if (u.status !== 'deactivated') throw conflict(`${u.name} is already active`);
      const next = u.lastLoginAt ? 'active' : 'invited';
      await tx.update(s.user).set({ status: next }).where(eq(s.user.id, userId));
      await tx.update(s.staffProfile).set({ status: 'active' }).where(eq(s.staffProfile.userId, userId));
      await this.audit.log(tx, {
        action: 'Staff reactivated',
        kind: 'update',
        entityType: 'user',
        entityId: userId,
        entityLabel: u.name,
        before: { status: 'deactivated' },
        after: { status: next },
        summary: `${u.name} · deactivated → ${next}${body.reason ? ` · ${body.reason}` : ''}`,
        branchId: p?.home ?? null,
      });
      this.notify.invalidate(tx, null, [['institution']]);
      return { ok: true as const, signedOut: 0 };
    });
    await this.access.bump();
    return result;
  }

  async signOutEverywhere(userId: string) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const [u] = await tx.select({ name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.id, userId));
      if (!u || u.kind !== 'staff') throw notFound('Staff member');
      const [p] = await tx.select({ home: s.staffProfile.homeBranchId }).from(s.staffProfile).where(eq(s.staffProfile.userId, userId));
      await this.assertPersonInScope(userId, p?.home ?? null);
      const killed = await tx
        .delete(s.session)
        .where(and(eq(s.session.userId, userId), userId === c.userId ? ne(s.session.id, c.sessionId) : undefined))
        .returning({ id: s.session.id });
      await this.audit.log(tx, {
        action: 'Signed out everywhere',
        kind: 'other',
        entityType: 'user',
        entityId: userId,
        entityLabel: u.name,
        summary: `${u.name} · ${killed.length} session${killed.length === 1 ? '' : 's'} revoked${userId === c.userId ? ' (this device kept)' : ''}`,
        branchId: p?.home ?? null,
      });
      return { ok: true as const, signedOut: killed.length };
    });
  }
}
