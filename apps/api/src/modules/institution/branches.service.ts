import { Injectable } from '@nestjs/common';
import type { BranchCreateInput, BranchUpdateInput, InstBranchCard, InstBranchDetail, InstHoliday, InstRoom, RoomInput } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, gte, inArray, isNull, ne, or, sql, type DbOrTx, type SQL } from '@exatech/db';
import { formatDate, formatINR, formatINRCompact, formatWeekdayDate, todayIST } from '@exatech/domain';
import { AccessService } from '../../core/auth/access.service';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { BATCH_STATUS_META, branchStatus, gstinLine, idList, LIVE_BATCH_STATUSES, membershipLabel, monthDay, openedLabel, openedLong, pct } from './institution.shared';
import { MetricsService } from './metrics.service';

type BranchRow = typeof s.branch.$inferSelect;
type HolidayRow = typeof s.holiday.$inferSelect;

/**
 * Branches (system of record: branch, room, holiday). Adding a holiday
 * suppresses that day's scheduled sessions in the affected branches and
 * removing it restores them — the one documented write this context makes
 * to class_session (status column only), announced with SessionUpdated.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly metrics: MetricsService,
  ) {}

  /** Branches the membership covers (the header switcher does not hide branches from the directory). */
  private membershipScope(): SQL | undefined {
    const ids = ctx().membershipBranchIds;
    if (ids === null) return undefined;
    return ids.length ? inArray(s.branch.id, ids) : sql`false`;
  }

  private async cards(where: SQL | undefined): Promise<InstBranchCard[]> {
    const rows = await this.db.db
      .select({ b: s.branch, manager: s.user.name })
      .from(s.branch)
      .leftJoin(s.user, eq(s.user.id, s.branch.managerUserId))
      .where(where)
      .orderBy(asc(s.branch.openedOn), asc(s.branch.code));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.b.id);
    const [rooms, batches, students] = await Promise.all([
      this.db.db
        .select({ branchId: s.room.branchId, n: sql<number>`count(*)::int` })
        .from(s.room)
        .where(and(inArray(s.room.branchId, ids), eq(s.room.active, true)))
        .groupBy(s.room.branchId),
      this.db.db
        .select({ branchId: s.batch.branchId, n: sql<number>`count(*)::int` })
        .from(s.batch)
        .where(and(inArray(s.batch.branchId, ids), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
        .groupBy(s.batch.branchId),
      this.db.db
        .select({ branchId: s.enrollment.branchId, n: sql<number>`count(distinct ${s.enrollment.studentId})::int` })
        .from(s.enrollment)
        .where(and(inArray(s.enrollment.branchId, ids), eq(s.enrollment.status, 'active')))
        .groupBy(s.enrollment.branchId),
    ]);
    const n = (list: { branchId: string; n: number }[], id: string) => Number(list.find((x) => x.branchId === id)?.n ?? 0);
    return rows.map(({ b, manager }) => this.card(b, manager, n(rooms, b.id), n(batches, b.id), n(students, b.id)));
  }

  private card(b: BranchRow, manager: string | null, roomCount: number, batchCount: number, studentCount: number): InstBranchCard {
    const st = branchStatus(b);
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      openedLabel: openedLabel(b.openedOn),
      openedOn: b.openedOn,
      status: b.status,
      statusLabel: st.label,
      statusTag: st.tag,
      statusNote: b.statusNote,
      address: b.address,
      city: b.city,
      phone: b.phone,
      email: b.email,
      gstin: b.gstin,
      gstinNote: b.gstinNote,
      gstinLine: gstinLine(b.gstin, b.gstinNote),
      monthlyTarget: b.monthlyTarget,
      managerUserId: b.managerUserId,
      managerName: manager,
      roomCount,
      batchCount,
      studentCount,
    };
  }

  async list() {
    const inst = await this.access.institution();
    const [row] = await this.db.db.select({ label: s.institution.academicYearLabel }).from(s.institution).where(eq(s.institution.id, inst.id));
    const branches = await this.cards(this.membershipScope());
    const holidays = await this.holidayRows(gte(s.holiday.date, todayIST()));
    return { branches, academicYearLabel: row?.label ?? '', upcoming: holidays, canManage: can('institution:branches.manage') };
  }

  async get(id: string): Promise<InstBranchDetail> {
    assertBranchAccess(id);
    const [card] = await this.cards(eq(s.branch.id, id));
    if (!card) throw notFound('Branch');
    const today = todayIST();
    const m = this.metrics.months(today);
    const metric = this.metrics.metricFor(await this.metrics.perBranch([id]), id);

    const rooms = await this.rooms(eq(s.room.branchId, id));
    const batchRows = await this.db.db
      .select({ b: s.batch, courseName: s.course.name, enrolled: sql<number>`(select count(*)::int from enrollment e where e.batch_id = batch.id and e.status = 'active')` })
      .from(s.batch)
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(and(eq(s.batch.branchId, id), inArray(s.batch.status, [...LIVE_BATCH_STATUSES])))
      .orderBy(asc(s.batch.code));
    const assignments = batchRows.length
      ? await this.db.db
          .select({ batchId: s.teacherAssignment.batchId, userId: s.teacherAssignment.teacherUserId, subject: s.teacherAssignment.subjectName, name: s.user.name, isPrimary: s.teacherAssignment.isPrimary })
          .from(s.teacherAssignment)
          .innerJoin(s.user, eq(s.user.id, s.teacherAssignment.teacherUserId))
          .where(and(inArray(s.teacherAssignment.batchId, batchRows.map((r) => r.b.id)), eq(s.teacherAssignment.active, true)))
          .orderBy(sql`${s.teacherAssignment.isPrimary} desc`, asc(s.user.name))
      : [];

    // Staff: anyone with a membership covering this branch, or based here.
    const branchCodes = await this.branchCodes();
    const staffRows = await this.db.db
      .select({ userId: s.user.id, name: s.user.name, roleKey: s.role.key, roleName: s.role.name, scopeKind: s.role.scopeKind, branchIds: s.membership.branchIds, scopeLabel: s.membership.scopeLabel, position: s.role.position, home: s.staffProfile.homeBranchId })
      .from(s.user)
      .innerJoin(s.membership, and(eq(s.membership.userId, s.user.id), eq(s.membership.status, 'active')))
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .leftJoin(s.staffProfile, eq(s.staffProfile.userId, s.user.id))
      .where(and(eq(s.user.kind, 'staff'), ne(s.user.status, 'deactivated'), or(sql`${id}::uuid = any(${s.membership.branchIds})`, eq(s.staffProfile.homeBranchId, id))))
      .orderBy(asc(s.role.position), asc(s.user.name));
    const staff = new Map<string, { userId: string; name: string; roles: string[] }>();
    for (const r of staffRows) {
      const e = staff.get(r.userId) ?? { userId: r.userId, name: r.name, roles: [] };
      e.roles.push(membershipLabel({ roleKey: r.roleKey, roleName: r.roleName, scopeKind: r.scopeKind, branchIds: r.branchIds, scopeLabel: r.scopeLabel }, (x) => branchCodes.get(x) ?? '?'));
      staff.set(r.userId, e);
    }

    const holidays = await this.holidayRows(and(gte(s.holiday.date, today), or(isNull(s.holiday.branchId), eq(s.holiday.branchId, id))));
    return {
      ...card,
      monthShort: m.short,
      kpis: {
        students: metric.students,
        studentsNote: `in ${metric.runningBatches} running batch${metric.runningBatches === 1 ? '' : 'es'}`,
        admissions: metric.admissions,
        admissionsNote: `from ${metric.leads} lead${metric.leads === 1 ? '' : 's'} · ${metric.awaiting} awaiting`,
        collected: metric.collected,
        collectedPct: pct(metric.collected, card.monthlyTarget),
        dues: metric.dues,
        duesNote: `${formatINRCompact(metric.duesOver60)} over 60 days`,
      },
      openedLong: openedLong(card.openedOn),
      rooms,
      batches: batchRows.map((r) => ({
        id: r.b.id,
        code: r.b.code,
        courseName: r.courseName,
        teachers: assignments.filter((a) => a.batchId === r.b.id).map((a) => ({ userId: a.userId, name: a.name, subject: a.subject })),
        enrolled: Number(r.enrolled),
        capacity: r.b.capacity,
        status: r.b.status,
        statusLabel: BATCH_STATUS_META[r.b.status]?.label ?? r.b.status,
        statusTag: BATCH_STATUS_META[r.b.status]?.tag ?? 'neutral',
      })),
      staff: [...staff.values()].map((x) => ({ userId: x.userId, name: x.name, roles: x.roles.join(' · ') })),
      holidays,
      canManage: can('institution:branches.manage'),
    };
  }

  private async branchCodes(): Promise<Map<string, string>> {
    const rows = await this.db.db.select({ id: s.branch.id, code: s.branch.code }).from(s.branch);
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  private async rooms(where: SQL | undefined): Promise<InstRoom[]> {
    const today = todayIST();
    const rows = await this.db.db
      .select({
        r: s.room,
        upcoming: sql<number>`(select count(*)::int from class_session cs where cs.room_id = room.id and cs.date >= ${today} and cs.status = 'scheduled')`,
      })
      .from(s.room)
      .where(where)
      .orderBy(sql`${s.room.active} desc`, sql`case ${s.room.kind} when 'room' then 0 when 'lab' then 1 else 2 end`, asc(s.room.name));
    return rows.map(({ r, upcoming }) => ({ id: r.id, branchId: r.branchId, name: r.name, capacity: r.capacity, kind: r.kind, active: r.active, upcomingSessions: Number(upcoming) }));
  }

  /* ───────────────────────── Create / edit ───────────────────────── */

  private async assertManager(tx: DbOrTx, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const [u] = await tx.select({ name: s.user.name, kind: s.user.kind, status: s.user.status }).from(s.user).where(eq(s.user.id, userId));
    if (!u || u.kind !== 'staff') throw invalid('Choose a staff member as the branch manager', { managerUserId: 'Not a staff member' });
    if (u.status === 'deactivated') throw invalid(`${u.name} is deactivated — reactivate them or choose someone else`, { managerUserId: 'Deactivated' });
    return u.name;
  }

  async create(body: BranchCreateInput & { code: string; rooms: RoomInput[] }): Promise<InstBranchCard> {
    const inst = await this.access.institution();
    const id = await this.db.tx(async (tx) => {
      const [dup] = await tx.select({ name: s.branch.name }).from(s.branch).where(and(eq(s.branch.institutionId, inst.id), sql`upper(${s.branch.code}) = ${body.code}`));
      if (dup) throw invalid(`Code ${body.code} is already used by ${dup.name}`, { code: 'Already used' });
      const names = body.rooms.map((r) => r.name.trim().toLowerCase());
      const dupRoom = names.find((n, i) => names.indexOf(n) !== i);
      if (dupRoom) throw invalid(`Two rooms are called “${body.rooms.find((r) => r.name.trim().toLowerCase() === dupRoom)!.name}” — room names are unique per branch`, { rooms: 'Duplicate name' });
      const managerName = await this.assertManager(tx, body.managerUserId);
      const [b] = await tx
        .insert(s.branch)
        .values({
          institutionId: inst.id,
          code: body.code,
          name: body.name,
          address: body.address,
          city: body.city,
          phone: body.phone ?? null,
          email: body.email ?? null,
          gstin: body.gstin,
          gstinNote: body.gstin ? null : 'shared with institution',
          managerUserId: body.managerUserId,
          openedOn: body.openedOn,
          status: 'active',
          monthlyTarget: body.monthlyTarget,
        })
        .returning();
      if (body.rooms.length) await tx.insert(s.room).values(body.rooms.map((r) => ({ branchId: b!.id, name: r.name.trim(), capacity: r.capacity, kind: r.kind ?? 'room' })));
      await this.audit.log(tx, {
        action: 'Branch created',
        kind: 'create',
        entityType: 'branch',
        entityId: b!.id,
        entityLabel: `${b!.code} · ${b!.name}`,
        after: { code: b!.code, name: b!.name, city: b!.city, gstin: b!.gstin, openedOn: b!.openedOn, monthlyTarget: b!.monthlyTarget, rooms: body.rooms.map((r) => `${r.name} · ${r.capacity}`) },
        summary: `${b!.code} · ${b!.name}, ${b!.city} · opened ${formatDate(body.openedOn)} · target ${formatINR(body.monthlyTarget)}/month · ${body.rooms.length} room${body.rooms.length === 1 ? '' : 's'}${managerName ? ` · manager ${managerName}` : ''}`,
        branchId: b!.id,
      });
      this.notify.invalidate(tx, null, [['institution'], ['reference'], ['me']]);
      return b!.id;
    });
    await this.access.bump();
    const [card] = await this.cards(eq(s.branch.id, id));
    return card!;
  }

  async update(id: string, body: BranchUpdateInput & { gstin: string | null }): Promise<InstBranchCard> {
    assertBranchAccess(id);
    await this.db.tx(async (tx) => {
      const [b] = await tx.select().from(s.branch).where(eq(s.branch.id, id)).for('update');
      if (!b) throw notFound('Branch');
      const managerName = await this.assertManager(tx, body.managerUserId);
      if (body.status === 'archived' && b.status !== 'archived' && !can('institution:branches.delete')) throw forbidden('Archiving a branch needs the “Archive branches” permission');
      if (body.status !== 'active' && b.status === 'active') {
        const [live] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.batch)
          .where(and(eq(s.batch.branchId, id), eq(s.batch.status, 'running')));
        if (body.status === 'archived' && Number(live?.n ?? 0) > 0) throw invalid(`${b.name} still has ${live!.n} running batch${Number(live!.n) === 1 ? '' : 'es'} — complete or move them before archiving`, { status: 'Running batches' });
      }
      const next = {
        name: body.name,
        address: body.address,
        city: body.city,
        phone: body.phone ?? null,
        email: body.email ?? null,
        gstin: body.gstin,
        gstinNote: body.gstin ? (b.gstin === body.gstin ? b.gstinNote : null) : 'shared with institution',
        managerUserId: body.managerUserId,
        openedOn: body.openedOn,
        monthlyTarget: body.monthlyTarget,
        status: body.status,
        statusNote: body.status !== b.status ? (body.statusNote ?? null) : body.statusNote === undefined ? b.statusNote : body.statusNote,
      };
      const changes: string[] = [];
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of Object.keys(next) as (keyof typeof next)[]) {
        if ((b[k] ?? null) === (next[k] ?? null)) continue;
        before[k] = b[k];
        after[k] = next[k];
        const fmt = (v: unknown) => (v == null || v === '' ? '—' : k === 'monthlyTarget' ? formatINR(Number(v)) : String(v));
        changes.push(k === 'managerUserId' ? `manager → ${managerName ?? '—'}` : `${k} ${fmt(b[k])} → ${fmt(next[k])}`);
      }
      if (changes.length === 0) return;
      await tx.update(s.branch).set(next).where(eq(s.branch.id, id));
      await this.audit.log(tx, { action: 'Branch updated', kind: 'update', entityType: 'branch', entityId: id, entityLabel: `${b.code} · ${next.name}`, before, after, summary: changes.join(' · '), branchId: id });
      this.notify.invalidate(tx, null, [['institution'], ['reference'], ['me']]);
    });
    await this.access.bump();
    const [card] = await this.cards(eq(s.branch.id, id));
    return card!;
  }

  /* ───────────────────────── Rooms ───────────────────────── */

  async addRoom(branchId: string, body: RoomInput): Promise<InstRoom> {
    assertBranchAccess(branchId);
    const roomId = await this.db.tx(async (tx) => {
      const [b] = await tx.select({ code: s.branch.code, name: s.branch.name }).from(s.branch).where(eq(s.branch.id, branchId));
      if (!b) throw notFound('Branch');
      const name = body.name.trim();
      const [dup] = await tx.select({ id: s.room.id }).from(s.room).where(and(eq(s.room.branchId, branchId), sql`lower(${s.room.name}) = ${name.toLowerCase()}`));
      if (dup) throw invalid(`${name} already exists in ${b.name}`, { name: 'Already exists' });
      const [r] = await tx.insert(s.room).values({ branchId, name, capacity: body.capacity, kind: body.kind ?? 'room' }).returning();
      await this.audit.log(tx, { action: 'Room added', kind: 'create', entityType: 'room', entityId: r!.id, entityLabel: `${b.code} · ${name}`, after: { name, capacity: body.capacity, kind: r!.kind }, summary: `${b.code} · ${name} · ${body.capacity} seats · ${r!.kind}`, branchId });
      this.notify.invalidate(tx, branchId, [['institution'], ['reference'], ['academics']]);
      return r!.id;
    });
    const [room] = await this.rooms(eq(s.room.id, roomId));
    return room!;
  }

  async updateRoom(id: string, body: RoomInput & { active: boolean; confirm: boolean }): Promise<InstRoom> {
    await this.db.tx(async (tx) => {
      const [r] = await tx.select().from(s.room).where(eq(s.room.id, id)).for('update');
      if (!r) throw notFound('Room');
      assertBranchAccess(r.branchId);
      const [b] = await tx.select({ code: s.branch.code, name: s.branch.name }).from(s.branch).where(eq(s.branch.id, r.branchId));
      const name = body.name.trim();
      if (name.toLowerCase() !== r.name.toLowerCase()) {
        const [dup] = await tx.select({ id: s.room.id }).from(s.room).where(and(eq(s.room.branchId, r.branchId), sql`lower(${s.room.name}) = ${name.toLowerCase()}`, ne(s.room.id, id)));
        if (dup) throw invalid(`${name} already exists in ${b?.name ?? 'this branch'}`, { name: 'Already exists' });
      }
      if (r.active && !body.active) {
        const upcoming = await tx
          .select({ code: s.batch.code, n: sql<number>`count(*)::int` })
          .from(s.classSession)
          .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
          .where(and(eq(s.classSession.roomId, id), gte(s.classSession.date, todayIST()), eq(s.classSession.status, 'scheduled')))
          .groupBy(s.batch.code);
        const total = upcoming.reduce((a, x) => a + Number(x.n), 0);
        if (total > 0 && !body.confirm) {
          throw conflict(
            `${r.name} has ${total} upcoming session${total === 1 ? '' : 's'} (${upcoming.map((x) => x.code).join(', ')}). They stay booked in it until you move them in the timetable — confirm to deactivate anyway.`,
            'ROOM_IN_USE',
          );
        }
      }
      const changes: string[] = [];
      if (name !== r.name) changes.push(`name ${r.name} → ${name}`);
      if (body.capacity !== r.capacity) changes.push(`capacity ${r.capacity} → ${body.capacity}`);
      if ((body.kind ?? r.kind) !== r.kind) changes.push(`kind ${r.kind} → ${body.kind}`);
      if (body.active !== r.active) changes.push(body.active ? 'reactivated' : 'deactivated');
      if (changes.length === 0) return;
      await tx.update(s.room).set({ name, capacity: body.capacity, kind: body.kind ?? r.kind, active: body.active }).where(eq(s.room.id, id));
      await this.audit.log(tx, {
        action: body.active !== r.active ? (body.active ? 'Room reactivated' : 'Room deactivated') : 'Room updated',
        kind: 'update',
        entityType: 'room',
        entityId: id,
        entityLabel: `${b?.code ?? ''} · ${name}`,
        before: { name: r.name, capacity: r.capacity, kind: r.kind, active: r.active },
        after: { name, capacity: body.capacity, kind: body.kind ?? r.kind, active: body.active },
        summary: `${b?.code ?? ''} · ${changes.join(' · ')}`,
        branchId: r.branchId,
      });
      this.notify.invalidate(tx, r.branchId, [['institution'], ['reference'], ['academics']]);
    });
    const [room] = await this.rooms(eq(s.room.id, id));
    return room!;
  }

  /* ───────────────────────── Holidays ───────────────────────── */

  private holidayScope(): SQL | undefined {
    const ids = ctx().membershipBranchIds;
    if (ids === null) return undefined;
    return or(isNull(s.holiday.branchId), ids.length ? inArray(s.holiday.branchId, ids) : sql`false`);
  }

  private async holidayRows(where: SQL | undefined): Promise<InstHoliday[]> {
    const inst = await this.access.institution();
    const rows = await this.db.db
      .select({ h: s.holiday, branchName: s.branch.name })
      .from(s.holiday)
      .leftJoin(s.branch, eq(s.branch.id, s.holiday.branchId))
      .where(and(eq(s.holiday.institutionId, inst.id), this.holidayScope(), where))
      .orderBy(asc(s.holiday.date));
    if (rows.length === 0) return [];
    const counts = await this.db.db.execute<{ date: string; branch_id: string | null; n: number }>(sql`
      select h.date::text as date, h.branch_id, count(cs.id)::int as n
      from holiday h join class_session cs on cs.date = h.date and cs.status = 'suppressed' and (h.branch_id is null or cs.branch_id = h.branch_id)
      where h.id in ${idList(rows.map((r) => r.h.id))}
      group by h.date, h.branch_id`);
    const today = todayIST();
    return rows.map(({ h, branchName }) => this.holiday(h, branchName, today, Number(counts.find((c) => c.date === h.date && c.branch_id === h.branchId)?.n ?? 0)));
  }

  private holiday(h: HolidayRow, branchName: string | null, today: string, suppressed: number): InstHoliday {
    return {
      id: h.id,
      date: h.date,
      shortLabel: monthDay(h.date),
      longLabel: `${formatWeekdayDate(h.date)} ${h.date.slice(0, 4)}`,
      name: h.name,
      branchId: h.branchId,
      scopeLabel: h.branchId ? (branchName ?? 'Branch') : 'All branches',
      past: h.date < today,
      suppressedSessions: suppressed,
    };
  }

  async holidays() {
    const inst = await this.access.institution();
    const [row] = await this.db.db.select({ label: s.institution.academicYearLabel, start: s.institution.academicYearStart }).from(s.institution).where(eq(s.institution.id, inst.id));
    const items = await this.holidayRows(row ? gte(s.holiday.date, row.start) : undefined);
    return { academicYearLabel: row?.label ?? '', items, canManage: can('institution:branches.manage') };
  }

  async addHoliday(body: { date: string; name: string; branchId: string | null }) {
    const inst = await this.access.institution();
    const today = todayIST();
    if (body.date < today) throw invalid('Pick today or a later date — past sessions keep their attendance', { date: 'In the past' });
    if (body.branchId) assertBranchAccess(body.branchId);
    else if (ctx().membershipBranchIds !== null) throw invalid('Only an institution-wide role can add a holiday for all branches — choose your branch', { branchId: 'Choose a branch' });
    const result = await this.db.tx(async (tx) => {
      let branchName: string | null = null;
      if (body.branchId) {
        const [b] = await tx.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, body.branchId));
        if (!b) throw notFound('Branch');
        branchName = b.name;
      }
      const clash = await tx
        .select({ name: s.holiday.name, branchId: s.holiday.branchId, branchName: s.branch.name })
        .from(s.holiday)
        .leftJoin(s.branch, eq(s.branch.id, s.holiday.branchId))
        .where(and(eq(s.holiday.institutionId, inst.id), eq(s.holiday.date, body.date), body.branchId ? or(isNull(s.holiday.branchId), eq(s.holiday.branchId, body.branchId)) : isNull(s.holiday.branchId)));
      if (clash[0]) throw invalid(`${formatWeekdayDate(body.date)} is already a holiday (${clash[0].name} · ${clash[0].branchId ? clash[0].branchName : 'all branches'})`, { date: 'Already a holiday' });
      const [h] = await tx.insert(s.holiday).values({ institutionId: inst.id, branchId: body.branchId, date: body.date, name: body.name.trim() }).returning();
      const suppressed = await tx
        .update(s.classSession)
        .set({ status: 'suppressed', updatedAt: new Date() })
        .where(and(eq(s.classSession.date, body.date), eq(s.classSession.status, 'scheduled'), body.branchId ? eq(s.classSession.branchId, body.branchId) : undefined))
        .returning({ id: s.classSession.id, branchId: s.classSession.branchId, batchId: s.classSession.batchId, teacherUserId: s.classSession.teacherUserId });
      for (const x of suppressed) await this.events.emit(tx, 'SessionUpdated', { sessionId: x.id, branchId: x.branchId, batchId: x.batchId, changes: ['status:suppressed', 'holiday'] });
      const scope = branchName ?? 'all branches';
      await this.audit.log(tx, {
        action: 'Holiday added',
        kind: 'create',
        entityType: 'holiday',
        entityId: h!.id,
        entityLabel: `${h!.name} · ${h!.date}`,
        after: { date: h!.date, name: h!.name, branch: scope, suppressedSessions: suppressed.length },
        summary: `${h!.name} · ${formatWeekdayDate(h!.date)} · ${scope} · ${suppressed.length} session${suppressed.length === 1 ? '' : 's'} suppressed`,
        branchId: body.branchId,
      });
      const teachers = [...new Set(suppressed.map((x) => x.teacherUserId))];
      if (teachers.length) {
        await this.notify.notify(tx, {
          userIds: teachers,
          category: 'timetable',
          title: `Holiday · ${formatWeekdayDate(h!.date)} · ${h!.name}`,
          body: `Your sessions that day are suppressed (${scope}).`,
          link: '/teacher',
          entityType: 'holiday',
          entityId: h!.id,
        });
      }
      this.notify.invalidate(tx, body.branchId, [['institution'], ['academics'], ['teaching']]);
      return { holiday: this.holiday(h!, branchName, today, suppressed.length), suppressed: suppressed.length };
    });
    return result;
  }

  async removeHoliday(id: string) {
    const today = todayIST();
    return this.db.tx(async (tx) => {
      const [h] = await tx.select().from(s.holiday).where(eq(s.holiday.id, id)).for('update');
      if (!h) throw notFound('Holiday');
      if (h.branchId) assertBranchAccess(h.branchId);
      else if (ctx().membershipBranchIds !== null) throw invalid('This holiday covers all branches — only an institution-wide role can remove it');
      if (h.date < today) throw invalid('Past holidays stay on record — sessions that day were never held');
      await tx.delete(s.holiday).where(eq(s.holiday.id, id));
      // Restore sessions no other holiday still covers.
      const others = await tx.select({ branchId: s.holiday.branchId }).from(s.holiday).where(and(eq(s.holiday.institutionId, h.institutionId), eq(s.holiday.date, h.date)));
      if (others.some((o) => o.branchId === null)) {
        await this.audit.log(tx, { action: 'Holiday removed', kind: 'delete', entityType: 'holiday', entityId: id, entityLabel: `${h.name} · ${h.date}`, before: { date: h.date, name: h.name }, summary: `${h.name} · ${formatWeekdayDate(h.date)} · still a holiday for all branches`, branchId: h.branchId });
        return { restored: 0 };
      }
      const stillOff = others.map((o) => o.branchId).filter((x): x is string => !!x);
      const restored = await tx
        .update(s.classSession)
        .set({ status: 'scheduled', updatedAt: new Date() })
        .where(
          and(
            eq(s.classSession.date, h.date),
            eq(s.classSession.status, 'suppressed'),
            h.branchId ? eq(s.classSession.branchId, h.branchId) : undefined,
            stillOff.length ? sql`${s.classSession.branchId} not in ${idList(stillOff)}` : undefined,
          ),
        )
        .returning({ id: s.classSession.id, branchId: s.classSession.branchId, batchId: s.classSession.batchId, teacherUserId: s.classSession.teacherUserId });
      for (const x of restored) await this.events.emit(tx, 'SessionUpdated', { sessionId: x.id, branchId: x.branchId, batchId: x.batchId, changes: ['status:scheduled', 'holiday removed'] });
      const [b] = h.branchId ? await tx.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, h.branchId)) : [];
      const scope = b?.name ?? 'all branches';
      await this.audit.log(tx, {
        action: 'Holiday removed',
        kind: 'delete',
        entityType: 'holiday',
        entityId: id,
        entityLabel: `${h.name} · ${h.date}`,
        before: { date: h.date, name: h.name, branch: scope },
        summary: `${h.name} · ${formatWeekdayDate(h.date)} · ${scope} · ${restored.length} session${restored.length === 1 ? '' : 's'} back on the timetable`,
        branchId: h.branchId,
      });
      const teachers = [...new Set(restored.map((x) => x.teacherUserId))];
      if (teachers.length) {
        await this.notify.notify(tx, {
          userIds: teachers,
          category: 'timetable',
          title: `${formatWeekdayDate(h.date)} is a working day again`,
          body: `${h.name} was removed from the calendar — your sessions that day are back on.`,
          link: '/teacher',
          entityType: 'holiday',
          entityId: id,
        });
      }
      this.notify.invalidate(tx, h.branchId, [['institution'], ['academics'], ['teaching']]);
      return { restored: restored.length };
    });
  }
}
