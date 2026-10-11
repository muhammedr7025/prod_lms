import { Injectable } from '@nestjs/common';
import type { AcadSessionChip, AcadTimetableWeek } from '@exatech/contracts';
import * as s from '@exatech/db';
import { alias, and, asc, eq, gte, inArray, lte, ne, notInArray, or, sql, type DbOrTx, type SQL, type Tx } from '@exatech/db';
import {
  addDays,
  DEFAULT_SLOTS,
  findWeekConflicts,
  formatDayMonth,
  formatWeekdayDate,
  formatWeekdayShort,
  isoWeekNumber,
  minutesOf,
  mondayOf,
  todayIST,
  validateSession,
  weekday,
  weekRangeLabel,
  type ScheduleIssue,
  type SlotSession,
} from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { ScopeService } from '../../core/scope.service';
import { AcademicsShared, endOf } from './academics.shared';

export interface SessionCandidate {
  id?: string;
  batchId: string;
  teacherUserId: string;
  subjectName: string;
  date: string;
  start: string;
  roomId: string | null;
  mode: 'offline' | 'online' | 'hybrid';
}

type SessionRow = typeof s.classSession.$inferSelect;
const WDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BLOCKING_ON_SAVE = new Set(['ROOM_CLASH', 'TEACHER_CLASH', 'TEACHER_TRAVEL', 'TEACHER_ON_LEAVE', 'HOLIDAY', 'ROOM_CAPACITY', 'OFF_SITE_DAY', 'BATCH_CLOSED', 'OUT_OF_RANGE', 'PAST', 'ROOM_REQUIRED', 'ROOM_BRANCH', 'LOCKED']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function rangeOf(from: string, to: string): string {
  const [, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [, m2, d2] = to.split('-').map(Number) as [number, number, number];
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m1 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`;
}

/** Row bucket of the week grid: the last default slot starting at or before the session. */
export function slotOf(start: string): string {
  let slot: string = DEFAULT_SLOTS[0];
  for (const x of DEFAULT_SLOTS) if (minutesOf(x) <= minutesOf(start)) slot = x;
  return slot;
}

/**
 * Timetable: week grid, live validation (room / teacher / travel buffer /
 * on-site days / leave / holiday / capacity), substitutes and one-click fixes.
 * Every change is audited, emits a Session* event and notifies the batch.
 */
@Injectable()
export class TimetableService {
  constructor(
    private readonly db: Db,
    private readonly shared: AcademicsShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly scope: ScopeService,
  ) {}

  /** Sessions as conflict-engine slots (teacher + room names resolved). */
  async slots(dbx: DbOrTx, where: SQL | undefined): Promise<(SlotSession & { row: SessionRow; batchStatus: string; batchCapacity: number; substituteForName: string | null })[]> {
    const teacher = alias(s.user, 'teacher');
    const original = alias(s.user, 'original');
    const rows = await dbx
      .select({ cs: s.classSession, batchCode: s.batch.code, batchStatus: s.batch.status, batchCapacity: s.batch.capacity, teacherName: teacher.name, roomName: s.room.name, originalName: original.name })
      .from(s.classSession)
      .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
      .innerJoin(teacher, eq(teacher.id, s.classSession.teacherUserId))
      .leftJoin(original, eq(original.id, s.classSession.substituteForUserId))
      .leftJoin(s.room, eq(s.room.id, s.classSession.roomId))
      .where(where)
      .orderBy(asc(s.classSession.date), asc(s.classSession.startTime));
    return rows.map((r) => ({
      id: r.cs.id,
      branchId: r.cs.branchId,
      batchId: r.cs.batchId,
      batchCode: r.batchCode,
      teacherId: r.cs.teacherUserId,
      teacherName: r.teacherName,
      roomId: r.cs.roomId,
      roomName: r.roomName,
      date: r.cs.date,
      start: r.cs.startTime,
      end: r.cs.endTime,
      status: r.cs.status,
      row: r.cs,
      batchStatus: r.batchStatus,
      batchCapacity: r.batchCapacity,
      substituteForName: r.originalName,
    }));
  }

  /** Validate a candidate session; returns blocking issues with their reasons. */
  async validate(dbx: DbOrTx, input: SessionCandidate): Promise<{ issues: ScheduleIssue[]; batch: typeof s.batch.$inferSelect; teacherName: string; roomName: string | null }> {
    const [batch] = await dbx.select().from(s.batch).where(eq(s.batch.id, input.batchId));
    if (!batch) throw notFound('Batch');
    assertInScope(batch.branchId);
    const [teacher] = await dbx.select({ id: s.user.id, name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.id, input.teacherUserId));
    if (!teacher || teacher.kind !== 'staff') throw invalid('Choose a teacher', { teacherUserId: 'Unknown teacher' });
    const issues: ScheduleIssue[] = [];
    let room: { id: string; name: string; capacity: number; branchId: string } | undefined;
    if (input.roomId) {
      [room] = await dbx.select({ id: s.room.id, name: s.room.name, capacity: s.room.capacity, branchId: s.room.branchId }).from(s.room).where(eq(s.room.id, input.roomId));
      if (!room) throw invalid('Choose a room', { roomId: 'Unknown room' });
      if (room.branchId !== batch.branchId) issues.push({ code: 'ROOM_BRANCH' as never, message: `${room.name} is not in ${batch.code}'s branch` });
    } else if (input.mode !== 'online') {
      issues.push({ code: 'ROOM_REQUIRED' as never, message: 'Choose a room — only online sessions can run without one' });
    }
    if (batch.status === 'completed' || batch.status === 'cancelled') issues.push({ code: 'BATCH_CLOSED' as never, message: `${batch.code} is ${batch.status} — it cannot get new sessions` });
    if (input.date < todayIST()) issues.push({ code: 'PAST' as never, message: `${formatWeekdayDate(input.date)} has passed — pick a day from today` });
    if (input.date < batch.startDate || input.date > batch.endDate) {
      issues.push({ code: 'OUT_OF_RANGE' as never, message: `Outside ${batch.code}'s dates (${formatDayMonth(batch.startDate)} – ${formatDayMonth(batch.endDate)})` });
    }
    const settings = await this.shared.settings();
    const existing = await this.slots(
      dbx,
      and(eq(s.classSession.date, input.date), or(eq(s.classSession.branchId, batch.branchId), eq(s.classSession.teacherUserId, input.teacherUserId)), notInArray(s.classSession.status, ['cancelled', 'suppressed'])),
    );
    const holidays = await dbx
      .select({ date: s.holiday.date, name: s.holiday.name, branchId: s.holiday.branchId })
      .from(s.holiday)
      .where(and(eq(s.holiday.date, input.date), or(sql`${s.holiday.branchId} is null`, eq(s.holiday.branchId, batch.branchId))));
    const leave = await dbx
      .select({ teacherId: s.leave.userId, date: s.leave.date })
      .from(s.leave)
      .where(and(eq(s.leave.userId, input.teacherUserId), eq(s.leave.date, input.date), eq(s.leave.status, 'approved')));
    const [profile] = await dbx.select({ onSiteDays: s.staffProfile.onSiteDays }).from(s.staffProfile).where(eq(s.staffProfile.userId, input.teacherUserId));
    const candidate: SlotSession = {
      id: input.id ?? 'new',
      branchId: batch.branchId,
      batchId: batch.id,
      batchCode: batch.code,
      teacherId: input.teacherUserId,
      teacherName: teacher.name,
      roomId: room?.id ?? null,
      roomName: room?.name ?? null,
      date: input.date,
      start: input.start,
      end: endOf(input.start),
      status: 'scheduled',
    };
    issues.push(
      ...validateSession(candidate, {
        existing,
        holidays,
        approvedLeave: leave,
        roomCapacity: room?.capacity ?? null,
        batchSeats: room ? batch.capacity : null,
        teacherOnSiteDays: profile?.onSiteDays?.[batch.branchId] ?? [],
        travelBufferMin: settings.travelBufferMinutes,
      }),
    );
    return { issues, batch, teacherName: teacher.name, roomName: room?.name ?? null };
  }

  private async lockSession(tx: Tx, id: string): Promise<SessionRow> {
    const [row] = await tx.select().from(s.classSession).where(eq(s.classSession.id, id)).for('update');
    if (!row) throw notFound('Session');
    assertInScope(row.branchId);
    return row;
  }

  private assertEditable(row: SessionRow) {
    if (row.attendanceSubmittedAt) throw conflict('Attendance is already submitted for this session — it is part of the record and cannot be changed');
    if (row.kind === 'exam') throw conflict('Exam sessions follow the exam schedule — change the exam instead');
    if (row.status === 'suppressed') throw conflict('This session falls on a holiday and is suppressed');
    if (row.date < todayIST()) throw conflict('This session is in the past and cannot be changed');
  }

  private blockOn(issues: ScheduleIssue[]) {
    const blocking = issues.filter((i) => BLOCKING_ON_SAVE.has(i.code));
    if (blocking.length) throw invalid(blocking.map((i) => i.message).join(' · '));
  }

  private label(batchCode: string, date: string, start: string) {
    return `${batchCode} · ${formatWeekdayDate(date)} ${start}`;
  }

  async create(input: SessionCandidate): Promise<{ id: string }> {
    return this.db.tx(async (tx) => {
      const v = await this.validate(tx, input);
      this.blockOn(v.issues);
      const [row] = await tx
        .insert(s.classSession)
        .values({
          branchId: v.batch.branchId,
          batchId: v.batch.id,
          teacherUserId: input.teacherUserId,
          subjectName: input.subjectName,
          roomId: input.roomId,
          date: input.date,
          startTime: input.start,
          endTime: endOf(input.start),
          mode: input.mode,
          kind: 'timetabled',
          status: 'scheduled',
          createdBy: ctx().userId,
        })
        .returning();
      const label = this.label(v.batch.code, input.date, input.start);
      await this.events.emit(tx, 'SessionCreated', { sessionId: row!.id, branchId: v.batch.branchId, batchId: v.batch.id });
      await this.audit.log(tx, {
        action: 'Session added',
        kind: 'create',
        entityType: 'class_session',
        entityId: row!.id,
        entityLabel: label,
        after: { date: input.date, start: input.start, room: v.roomName, teacher: v.teacherName, subject: input.subjectName, mode: input.mode },
        summary: `${label} · ${v.roomName ?? input.mode} · ${v.teacherName} · ${input.subjectName}`,
        branchId: v.batch.branchId,
      });
      await this.shared.notifyBatch(tx, v.batch.id, {
        title: `Timetable · ${v.batch.code} session added`,
        body: `${formatWeekdayDate(input.date)} ${input.start}–${endOf(input.start)} · ${v.roomName ?? 'Online'} · ${input.subjectName}`,
        link: null,
        entityId: row!.id,
      });
      this.notify.invalidate(tx, v.batch.branchId, [['academics']]);
      return { id: row!.id };
    });
  }

  async update(id: string, input: SessionCandidate): Promise<{ id: string }> {
    return this.db.tx(async (tx) => {
      const before = await this.lockSession(tx, id);
      this.assertEditable(before);
      if (before.status === 'cancelled') throw conflict('This session was removed — restore it first');
      if (input.batchId !== before.batchId) throw invalid('A session cannot move to another batch — remove it and add a new one', { batchId: 'Cannot change' });
      const v = await this.validate(tx, { ...input, id });
      this.blockOn(v.issues);
      const changes: string[] = [];
      if (before.date !== input.date || before.startTime !== input.start) changes.push('time');
      if (before.roomId !== input.roomId) changes.push('room');
      if (before.teacherUserId !== input.teacherUserId) changes.push('teacher');
      if (before.subjectName !== input.subjectName) changes.push('subject');
      if (before.mode !== input.mode) changes.push('mode');
      if (changes.length === 0) return { id };
      await tx
        .update(s.classSession)
        .set({
          teacherUserId: input.teacherUserId,
          subjectName: input.subjectName,
          roomId: input.roomId,
          date: input.date,
          startTime: input.start,
          endTime: endOf(input.start),
          mode: input.mode,
          flag: before.teacherUserId !== input.teacherUserId ? null : before.flag,
        })
        .where(eq(s.classSession.id, id));
      const [oldRoom] = before.roomId ? await tx.select({ name: s.room.name }).from(s.room).where(eq(s.room.id, before.roomId)) : [];
      const [oldTeacher] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, before.teacherUserId));
      const labelBefore = this.label(v.batch.code, before.date, before.startTime);
      const labelAfter = this.label(v.batch.code, input.date, input.start);
      const parts: string[] = [];
      if (changes.includes('time')) parts.push(`${formatWeekdayDate(before.date)} ${before.startTime} → ${formatWeekdayDate(input.date)} ${input.start}`);
      if (changes.includes('room')) parts.push(`${oldRoom?.name ?? 'no room'} → ${v.roomName ?? 'no room'}`);
      if (changes.includes('teacher')) parts.push(`${oldTeacher?.name ?? '—'} → ${v.teacherName}`);
      if (changes.includes('subject')) parts.push(`${before.subjectName} → ${input.subjectName}`);
      if (changes.includes('mode')) parts.push(`${before.mode} → ${input.mode}`);
      await this.events.emit(tx, 'SessionUpdated', { sessionId: id, branchId: v.batch.branchId, batchId: v.batch.id, changes });
      await this.audit.log(tx, {
        action: 'Session changed',
        kind: 'update',
        entityType: 'class_session',
        entityId: id,
        entityLabel: labelAfter,
        before: { date: before.date, start: before.startTime, roomId: before.roomId, teacherUserId: before.teacherUserId, subject: before.subjectName, mode: before.mode },
        after: { date: input.date, start: input.start, roomId: input.roomId, teacherUserId: input.teacherUserId, subject: input.subjectName, mode: input.mode },
        summary: `${labelBefore} · ${parts.join(' · ')}`,
        branchId: v.batch.branchId,
      });
      await this.shared.notifyBatch(tx, v.batch.id, {
        title: `Timetable · ${v.batch.code} session changed`,
        body: `${labelAfter} · ${parts.join(' · ')}`,
        extraUserIds: before.teacherUserId !== input.teacherUserId ? [before.teacherUserId, input.teacherUserId] : [],
        entityId: id,
      });
      this.notify.invalidate(tx, v.batch.branchId, [['academics']]);
      return { id };
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.lockSession(tx, id);
      this.assertEditable(row);
      if (row.status === 'cancelled') return;
      await tx.update(s.classSession).set({ status: 'cancelled' }).where(eq(s.classSession.id, id));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, row.batchId));
      const label = this.label(b?.code ?? 'Batch', row.date, row.startTime);
      await this.events.emit(tx, 'SessionRemoved', { sessionId: id, branchId: row.branchId, batchId: row.batchId });
      await this.audit.log(tx, { action: 'Session removed', kind: 'delete', entityType: 'class_session', entityId: id, entityLabel: label, before: { status: row.status }, after: { status: 'cancelled' }, summary: `${label} · ${row.status} → cancelled`, branchId: row.branchId });
      await this.shared.notifyBatch(tx, row.batchId, { title: `Timetable · ${b?.code ?? ''} session cancelled`, body: `${formatWeekdayDate(row.date)} ${row.startTime} will not take place`, entityId: id });
      this.notify.invalidate(tx, row.branchId, [['academics']]);
    });
  }

  async restore(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.lockSession(tx, id);
      if (row.status !== 'cancelled') return;
      const v = await this.validate(tx, { id, batchId: row.batchId, teacherUserId: row.teacherUserId, subjectName: row.subjectName, date: row.date, start: row.startTime, roomId: row.roomId, mode: row.mode });
      this.blockOn(v.issues);
      await tx.update(s.classSession).set({ status: 'scheduled' }).where(eq(s.classSession.id, id));
      const label = this.label(v.batch.code, row.date, row.startTime);
      await this.events.emit(tx, 'SessionUpdated', { sessionId: id, branchId: row.branchId, batchId: row.batchId, changes: ['restored'] });
      await this.audit.log(tx, { action: 'Session restored', kind: 'update', entityType: 'class_session', entityId: id, entityLabel: label, before: { status: 'cancelled' }, after: { status: 'scheduled' }, summary: `${label} · cancelled → scheduled (undo)`, branchId: row.branchId });
      await this.shared.notifyBatch(tx, row.batchId, { title: `Timetable · ${v.batch.code} session back on`, body: `${formatWeekdayDate(row.date)} ${row.startTime} · ${v.roomName ?? 'Online'}`, entityId: id });
      this.notify.invalidate(tx, row.branchId, [['academics']]);
    });
  }

  /** One-click fix from the conflicts panel: move a session to a free room. */
  async moveRoom(id: string, roomId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.lockSession(tx, id);
      this.assertEditable(row);
      const v = await this.validate(tx, { id, batchId: row.batchId, teacherUserId: row.teacherUserId, subjectName: row.subjectName, date: row.date, start: row.startTime, roomId, mode: row.mode });
      this.blockOn(v.issues.filter((i) => ['ROOM_CLASH', 'ROOM_CAPACITY', 'ROOM_BRANCH'].includes(i.code)));
      const [oldRoom] = row.roomId ? await tx.select({ name: s.room.name }).from(s.room).where(eq(s.room.id, row.roomId)) : [];
      await tx.update(s.classSession).set({ roomId }).where(eq(s.classSession.id, id));
      const label = this.label(v.batch.code, row.date, row.startTime);
      await this.events.emit(tx, 'SessionUpdated', { sessionId: id, branchId: row.branchId, batchId: row.batchId, changes: ['room'] });
      await this.audit.log(tx, { action: 'Session room changed', kind: 'update', entityType: 'class_session', entityId: id, entityLabel: label, before: { roomId: row.roomId }, after: { roomId }, summary: `${label} · ${oldRoom?.name ?? 'no room'} → ${v.roomName} (conflict fix)`, branchId: row.branchId });
      await this.shared.notifyBatch(tx, row.batchId, { title: `Timetable · ${v.batch.code} room changed`, body: `${formatWeekdayDate(row.date)} ${row.startTime} now in ${v.roomName}`, entityId: id });
      this.notify.invalidate(tx, row.branchId, [['academics']]);
    });
  }

  /** Cover a session whose teacher is on leave; clashes re-run on the next week fetch. */
  async substitute(id: string, teacherUserId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.lockSession(tx, id);
      this.assertEditable(row);
      if (row.status !== 'scheduled') throw conflict('Only scheduled sessions can get a substitute');
      if (row.date < todayIST()) throw conflict('This session is in the past');
      if (row.teacherUserId === teacherUserId) throw invalid('Choose a different teacher', { teacherUserId: 'Same teacher' });
      const [sub] = await tx.select({ id: s.user.id, name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.id, teacherUserId));
      if (!sub || sub.kind !== 'staff') throw invalid('Choose a teacher', { teacherUserId: 'Unknown' });
      const onLeave = await tx.select({ id: s.leave.id }).from(s.leave).where(and(eq(s.leave.userId, teacherUserId), eq(s.leave.date, row.date), eq(s.leave.status, 'approved')));
      if (onLeave.length) throw invalid(`${sub.name} has approved leave on ${formatWeekdayDate(row.date)}`);
      const originalId = row.substituteForUserId ?? row.teacherUserId;
      const [orig] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, originalId));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, row.batchId));
      await tx.update(s.classSession).set({ teacherUserId, substituteForUserId: originalId === teacherUserId ? null : originalId, flag: null }).where(eq(s.classSession.id, id));
      const label = this.label(b?.code ?? 'Batch', row.date, row.startTime);
      await this.events.emit(tx, 'SubstituteAssigned', { sessionId: id, branchId: row.branchId, batchId: row.batchId, teacherUserId, originalTeacherUserId: originalId });
      await this.audit.log(tx, {
        action: 'Substitute assigned',
        kind: 'update',
        entityType: 'class_session',
        entityId: id,
        entityLabel: label,
        before: { teacherUserId: row.teacherUserId },
        after: { teacherUserId, substituteForUserId: originalId },
        summary: `${label} · ${orig?.name ?? '—'} → ${sub.name} (substitute)`,
        branchId: row.branchId,
      });
      await this.shared.notifyBatch(tx, row.batchId, {
        title: `Substitute · ${b?.code ?? ''} ${WDS[weekday(row.date)]} ${row.startTime}`,
        body: `${sub.name} covers for ${orig?.name ?? 'the regular teacher'} · ${row.subjectName}`,
        extraUserIds: [originalId, teacherUserId],
        entityId: id,
      });
      this.notify.invalidate(tx, row.branchId, [['academics']]);
    });
  }

  /* ───────────────────────── Week view ───────────────────────── */

  async week(weekArg?: string): Promise<AcadTimetableWeek> {
    const today = todayIST();
    const monday = mondayOf(weekArg ?? today);
    const sunday = addDays(monday, 6);
    const settings = await this.shared.settings();
    const buffer = settings.travelBufferMinutes;
    const canManage = can('academics:timetable.manage');
    // Teachers (no manage permission) only see their assigned batches.
    const teacherBatchIds = !canManage && ctx().roleKey === 'teacher' ? await this.scope.teacherBatchIds() : null;
    const scopeWhere = and(inBranchScope(s.classSession.branchId), teacherBatchIds ? inArray(s.classSession.batchId, teacherBatchIds.length ? teacherBatchIds : ['00000000-0000-0000-0000-000000000000']) : undefined);

    const range = (from: string, to: string) => and(gte(s.classSession.date, from), lte(s.classSession.date, to));
    const inScope = await this.slots(this.db.db, and(scopeWhere, range(monday, sunday), ne(s.classSession.status, 'cancelled')));
    const teacherIds = [...new Set(inScope.map((x) => x.teacherId))];
    const scopeIds = new Set(inScope.map((x) => x.id));
    const outside = teacherIds.length
      ? (await this.slots(this.db.db, and(range(monday, sunday), inArray(s.classSession.teacherUserId, teacherIds), notInArray(s.classSession.status, ['cancelled', 'suppressed'])))).filter((x) => !scopeIds.has(x.id))
      : [];
    const subFrom = mondayOf(today);
    const subTo = addDays(subFrom, 13);
    const leaves = await this.db.db
      .select({ teacherId: s.leave.userId, date: s.leave.date })
      .from(s.leave)
      .where(and(eq(s.leave.status, 'approved'), gte(s.leave.date, monday < subFrom ? monday : subFrom), lte(s.leave.date, sunday > subTo ? sunday : subTo)));
    const holidays = await this.db.db
      .select({ date: s.holiday.date, name: s.holiday.name, branchId: s.holiday.branchId })
      .from(s.holiday)
      .where(and(gte(s.holiday.date, monday), lte(s.holiday.date, addDays(sunday, 7))));
    const rooms = await this.db.db
      .select({ id: s.room.id, name: s.room.name, capacity: s.room.capacity, branchId: s.room.branchId })
      .from(s.room)
      .where(and(eq(s.room.active, true), inBranchScope(s.room.branchId)))
      .orderBy(asc(s.room.name));
    const batches = await this.db.db
      .select({ id: s.batch.id, code: s.batch.code, branchId: s.batch.branchId, status: s.batch.status, capacity: s.batch.capacity, roomId: s.batch.roomId, mode: s.batch.mode })
      .from(s.batch)
      .where(and(inBranchScope(s.batch.branchId), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']), teacherBatchIds ? inArray(s.batch.id, teacherBatchIds.length ? teacherBatchIds : ['00000000-0000-0000-0000-000000000000']) : undefined))
      .orderBy(asc(s.batch.code));
    const assignments = batches.length
      ? await this.db.db
          .select({ batchId: s.teacherAssignment.batchId, teacherUserId: s.teacherAssignment.teacherUserId, subjectName: s.teacherAssignment.subjectName, isPrimary: s.teacherAssignment.isPrimary })
          .from(s.teacherAssignment)
          .where(and(inArray(s.teacherAssignment.batchId, batches.map((b) => b.id)), eq(s.teacherAssignment.active, true)))
      : [];
    const teachers = await this.teacherList();

    const scopeBranches = new Set([...rooms.map((r) => r.branchId), ...batches.map((b) => b.branchId)]);
    const holidayOn = (date: string, branchId?: string) => holidays.find((h) => h.date === date && (h.branchId === null || !branchId || h.branchId === branchId || scopeBranches.has(h.branchId)));
    const leaveOn = (teacherId: string, date: string) => leaves.some((l) => l.teacherId === teacherId && l.date === date);

    // Grid columns: Mon–Sat, plus Sunday when the week has Sunday sessions.
    const days = Array.from({ length: 6 }, (_, i) => addDays(monday, i));
    if (inScope.some((x) => x.date === sunday)) days.push(sunday);

    const chips: AcadSessionChip[] = inScope.map((x) => {
      const r = x.row;
      const onLeave = leaveOn(x.teacherId, x.date) && !r.substituteForUserId;
      const holiday = r.status === 'suppressed' ? holidayOn(x.date, x.branchId) : undefined;
      const style: AcadSessionChip['style'] =
        r.status === 'suppressed'
          ? 'suppressed'
          : r.kind === 'exam'
            ? 'exam'
            : r.kind === 'adhoc'
              ? 'adhoc'
              : r.substituteForUserId
                ? 'substitute'
                : onLeave || r.flag?.startsWith('leave')
                  ? 'leave'
                  : ['planned', 'open', 'waitlist'].includes(x.batchStatus) || r.flag === 'planned'
                    ? 'planned'
                    : 'normal';
      const where = x.roomName ?? (r.mode === 'online' ? 'Online' : 'No room');
      const teacherPart = r.substituteForUserId ? `${x.teacherName} (sub for ${x.substituteForName})` : x.teacherName;
      const sub =
        style === 'suppressed'
          ? `${holiday?.name ?? 'Holiday'} · suppressed`
          : style === 'leave'
            ? `${where} · ${x.teacherName} on leave · substitute?`
            : style === 'exam'
              ? `${where} · ${r.topic ?? 'Exam'}`
              : `${where} · ${teacherPart} · ${r.subjectName}`;
      let lockedReason: string | null = null;
      if (!canManage) lockedReason = 'You can view the timetable but not change it';
      else if (r.attendanceSubmittedAt) lockedReason = 'Attendance submitted — this session is part of the record';
      else if (r.kind === 'exam') lockedReason = 'Exam sessions follow the exam schedule';
      else if (r.status === 'suppressed') lockedReason = 'Holiday — sessions are suppressed';
      else if (x.date < today) lockedReason = 'This session is in the past';
      return {
        id: x.id,
        date: x.date,
        start: x.start,
        end: x.end,
        slot: slotOf(x.start),
        branchId: x.branchId,
        batchId: x.batchId,
        batchCode: x.batchCode,
        teacherUserId: x.teacherId,
        teacherName: x.teacherName,
        subjectName: r.subjectName,
        roomId: x.roomId,
        roomName: x.roomName,
        mode: r.mode,
        kind: r.kind,
        status: r.status,
        flag: r.flag,
        substituteForName: x.substituteForName,
        topic: r.topic,
        style,
        sub: x.start !== slotOf(x.start) ? `${x.start} · ${sub}` : sub,
        editable: lockedReason === null,
        lockedReason,
      };
    });

    // Live conflicts for the visible week (cross-branch sessions of the same teachers included for travel).
    const seats = Object.fromEntries([...inScope, ...outside].map((x) => [x.batchId, x.batchCapacity]));
    const active = [...inScope, ...outside].filter((x) => x.status !== 'suppressed' && x.date >= today);
    const conflicts = findWeekConflicts(active, { rooms, seatsByBatch: seats, approvedLeave: leaves, travelBufferMin: buffer })
      .filter((c) => c.sessionIds.some((id) => scopeIds.has(id)))
      .filter((c) => c.code !== 'TEACHER_ON_LEAVE' || !inScope.find((x) => x.id === c.sessionIds[0])?.row.substituteForUserId)
      .map((c) => ({ key: c.key, code: c.code, message: c.message, sessionIds: c.sessionIds, fix: c.fix?.roomId && canManage ? { label: c.fix.label, sessionId: c.fix.sessionId, roomId: c.fix.roomId } : null }));

    // "Validated on save" — real checks for this week.
    const roomCap = new Map(rooms.map((r) => [r.id, r]));
    const capIssues = inScope.filter((x) => x.roomId && x.status !== 'suppressed' && (roomCap.get(x.roomId)?.capacity ?? 999) < x.batchCapacity);
    const travel = conflicts.filter((c) => c.code === 'TEACHER_TRAVEL' || c.code === 'TEACHER_CLASH');
    const nextMonday = addDays(monday, 7);
    const suppressedNext = await this.db.db
      .select({ date: s.classSession.date, n: sql<number>`count(*)::int` })
      .from(s.classSession)
      .where(and(scopeWhere, range(nextMonday, addDays(nextMonday, 6)), eq(s.classSession.status, 'suppressed')))
      .groupBy(s.classSession.date)
      .orderBy(asc(s.classSession.date));
    const suppressedThis = inScope.filter((x) => x.status === 'suppressed');
    const checks: { ok: boolean; text: string }[] = [
      { ok: travel.length === 0, text: travel.length === 0 ? `Teacher availability across branches (${buffer} min travel buffer)` : `${travel.length} teacher clash${travel.length > 1 ? 'es' : ''} this week (${buffer} min travel buffer)` },
      {
        ok: capIssues.length === 0,
        text: capIssues.length === 0 ? 'Room capacity ≥ batch seats' : `${capIssues[0]!.roomName} seats ${roomCap.get(capIssues[0]!.roomId!)?.capacity}, ${capIssues[0]!.batchCode} has ${capIssues[0]!.batchCapacity} seats${capIssues.length > 1 ? ` (+${capIssues.length - 1} more)` : ''}`,
      },
    ];
    if (suppressedThis.length) {
      const d = suppressedThis[0]!.date;
      checks.push({ ok: true, text: `Holiday ${formatDayMonth(d)} suppresses ${suppressedThis.length} session${suppressedThis.length > 1 ? 's' : ''} this week` });
    }
    if (suppressedNext.length) {
      const total = suppressedNext.reduce((a, r) => a + Number(r.n), 0);
      checks.push({ ok: true, text: `Holiday ${suppressedNext.map((r) => formatDayMonth(r.date)).join(', ')} suppresses ${total} session${total > 1 ? 's' : ''} next week` });
    }
    if (!suppressedThis.length && !suppressedNext.length) checks.push({ ok: true, text: 'No holidays this week or next — nothing suppressed' });
    const leaveOpen = conflicts.filter((c) => c.code === 'TEACHER_ON_LEAVE').length;
    if (leaveOpen) checks.push({ ok: false, text: `${leaveOpen} session${leaveOpen > 1 ? 's' : ''} need${leaveOpen > 1 ? '' : 's'} a substitute (approved leave)` });

    const substitutes = await this.substituteCard(subFrom, subTo, today, scopeWhere, leaves, teachers, buffer);

    return {
      monday,
      weekNumber: isoWeekNumber(monday),
      rangeLabel: days.length === 7 ? rangeOf(monday, sunday) : weekRangeLabel(monday),
      branchLabel: await this.shared.branchLabel(),
      isThisWeek: monday === mondayOf(today),
      days: days.map((d) => ({ date: d, label: formatWeekdayShort(d), holiday: holidayOn(d)?.name ?? null })),
      slots: [...DEFAULT_SLOTS],
      sessions: chips,
      conflicts,
      checks,
      substitutes,
      rooms,
      teachers: teachers.map((t) => ({ id: t.id, name: t.name })),
      batches: batches.map((b) => ({
        ...b,
        assignments: assignments.filter((a) => a.batchId === b.id).map((a) => ({ teacherUserId: a.teacherUserId, subjectName: a.subjectName, isPrimary: a.isPrimary })),
      })),
      canManage,
    };
  }

  /** Active teachers (anyone holding a teacher membership). */
  async teacherList(): Promise<{ id: string; name: string }[]> {
    return this.db.db
      .selectDistinct({ id: s.user.id, name: s.user.name })
      .from(s.user)
      .innerJoin(s.membership, and(eq(s.membership.userId, s.user.id), eq(s.membership.status, 'active')))
      .innerJoin(s.role, and(eq(s.role.id, s.membership.roleId), eq(s.role.key, 'teacher')))
      .where(eq(s.user.status, 'active'))
      .orderBy(asc(s.user.name));
  }

  /** Sessions this/next week whose teacher has approved leave, with substitute options. */
  private async substituteCard(from: string, to: string, today: string, scopeWhere: SQL | undefined, leaves: { teacherId: string; date: string }[], teachers: { id: string; name: string }[], buffer: number) {
    const list = await this.slots(this.db.db, and(scopeWhere, gte(s.classSession.date, from), lte(s.classSession.date, to)));
    const relevant = list.filter((x) => x.date >= today && x.row.kind !== 'exam');
    const needed = relevant.filter((x) => x.status === 'scheduled' && !x.row.substituteForUserId && !x.row.attendanceSubmittedAt && (leaves.some((l) => l.teacherId === x.teacherId && l.date === x.date) || x.row.flag?.startsWith('leave')));
    const done = relevant.filter((x) => x.row.substituteForUserId && x.status !== 'cancelled');
    if (needed.length === 0) return { needed: [], done: done.map((x) => this.doneLabel(x)) };
    const dates = [...new Set(needed.map((x) => x.date))];
    const busyRows = await this.slots(this.db.db, and(inArray(s.classSession.date, dates), notInArray(s.classSession.status, ['cancelled', 'suppressed'])));
    return {
      needed: needed.map((x) => {
        const options = teachers
          .filter((t) => t.id !== x.teacherId)
          .map((t) => {
            if (leaves.some((l) => l.teacherId === t.id && l.date === x.date)) return { userId: t.id, label: `${t.name} · on leave`, status: 'on_leave' as const };
            const clash = busyRows.find((b) => b.teacherId === t.id && b.date === x.date && b.id !== x.id && minutesOf(b.start) < minutesOf(x.end) + (b.branchId === x.branchId ? 0 : buffer) && minutesOf(x.start) < minutesOf(b.end) + (b.branchId === x.branchId ? 0 : buffer));
            if (clash) return { userId: t.id, label: `${t.name} · busy with ${clash.batchCode} (will clash)`, status: 'busy' as const };
            return { userId: t.id, label: `${t.name} · free ${WDS[weekday(x.date)]} ${x.start}`, status: 'free' as const };
          })
          .sort((a, b) => ['free', 'busy', 'on_leave'].indexOf(a.status) - ['free', 'busy', 'on_leave'].indexOf(b.status) || a.label.localeCompare(b.label));
        return { sessionId: x.id, label: `${x.teacherName} on leave ${formatWeekdayShort(x.date)} · ${x.batchCode} ${x.start} (${x.row.subjectName}) needs a substitute.`, options };
      }),
      done: done.map((x) => this.doneLabel(x)),
    };
  }

  private doneLabel(x: SlotSession & { row: SessionRow; substituteForName: string | null }) {
    return { sessionId: x.id, label: `${x.batchCode} ${WDS[weekday(x.date)]} ${formatDayMonth(x.date)} ${x.start} · covered by`, name: x.teacherName };
  }

  /** Guard used by the session dialog endpoints. */
  assertManage() {
    if (!can('academics:timetable.manage')) throw forbidden('You cannot change the timetable');
  }
}
