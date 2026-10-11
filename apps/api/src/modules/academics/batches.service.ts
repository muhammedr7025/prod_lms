import { Injectable } from '@nestjs/common';
import type { AcadBatchPlan, AcadBatchRow, AcadBatchStatus, AcadOffering } from '@exatech/contracts';
import { zAcadBatchInput, zAcadBatchUpdate } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, gte, inArray, lte, ne, notInArray, or, sql, type DbOrTx, type Tx } from '@exatech/db';
import { addDays, daysBetween, formatDayMonth, formatWeekdayDate, todayIST, validateSession, weekday, type SlotSession } from '@exatech/domain';
import type { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { AcademicsShared, BATCH_STATUS_META, BATCH_TRANSITIONS, endOf, scheduleLabel } from './academics.shared';
import { TimetableService } from './timetable.service';

type BatchInput = z.output<typeof zAcadBatchInput>;
type BatchUpdate = z.output<typeof zAcadBatchUpdate>;

interface GeneratedSession {
  date: string;
  start: string;
  suppressed: boolean;
  flagged: boolean;
}

const BLOCKING = new Set(['ROOM_CLASH', 'TEACHER_CLASH', 'TEACHER_TRAVEL', 'OFF_SITE_DAY', 'ROOM_CAPACITY']);

/** Courses & batches: offerings per branch, batch lifecycle, teacher assignment and session generation. */
@Injectable()
export class BatchesService {
  constructor(
    private readonly db: Db,
    private readonly shared: AcademicsShared,
    private readonly timetable: TimetableService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
  ) {}

  async list() {
    const offerings = await this.offerings();
    const batches = await this.shared.batchRows(inBranchScope(s.batch.branchId));
    return { branchLabel: await this.shared.branchLabel(), offerings, batches, canManage: can('academics:courses.manage') };
  }

  async offerings(where = inBranchScope(s.courseOffering.branchId), dbx: DbOrTx = this.db.db): Promise<AcadOffering[]> {
    const rows = await dbx
      .select({ o: s.courseOffering, course: s.course, branchCode: s.branch.code, planName: s.feePlan.name })
      .from(s.courseOffering)
      .innerJoin(s.course, eq(s.course.id, s.courseOffering.courseId))
      .innerJoin(s.branch, eq(s.branch.id, s.courseOffering.branchId))
      .leftJoin(s.feePlan, eq(s.feePlan.id, s.courseOffering.defaultFeePlanId))
      .where(where)
      .orderBy(asc(s.branch.code), asc(s.course.code));
    const counts = rows.length
      ? await dbx
          .select({ courseId: s.batch.courseId, branchId: s.batch.branchId, status: s.batch.status, n: sql<number>`count(*)::int` })
          .from(s.batch)
          .where(and(inArray(s.batch.courseId, [...new Set(rows.map((r) => r.o.courseId))]), notInArray(s.batch.status, ['cancelled'])))
          .groupBy(s.batch.courseId, s.batch.branchId, s.batch.status)
      : [];
    const multi = new Set(rows.map((r) => r.o.branchId)).size > 1;
    return rows.map((r) => {
      const mine = counts.filter((c) => c.courseId === r.o.courseId && c.branchId === r.o.branchId);
      const total = mine.reduce((a, c) => a + Number(c.n), 0);
      const open = mine.filter((c) => c.status === 'open').reduce((a, c) => a + Number(c.n), 0);
      const waitlist = mine.filter((c) => c.status === 'waitlist').reduce((a, c) => a + Number(c.n), 0);
      const parts = [`${total} batch${total === 1 ? '' : 'es'}`, `${open} open`];
      if (waitlist) parts.push(`${waitlist} on waitlist`);
      parts.push(r.planName ? `${r.planName} default` : 'no default plan');
      return {
        id: r.o.id,
        courseId: r.o.courseId,
        courseCode: r.course.code,
        courseName: r.course.name,
        branchId: r.o.branchId,
        branchCode: r.branchCode,
        durationMonths: r.course.durationMonths,
        modality: r.course.modality,
        kicker: `${multi ? `${r.branchCode} · ` : ''}${r.course.code} · ${r.course.durationMonths} months · ${r.course.modality}`,
        meta: parts.join(' · '),
        defaultFeePlanId: r.o.defaultFeePlanId,
        status: r.o.status,
      };
    });
  }

  /* ───────────────────────── Plan & create ───────────────────────── */

  /** Generate the weekly sessions for a batch and check every one against the timetable. */
  private async planSessions(dbx: DbOrTx, input: { branchId: string; batchCode: string; capacity: number; startDate: string; endDate: string; roomId: string | null; teacherUserId: string; slots: { weekday: number; start: string }[]; excludeBatchId?: string }) {
    const today = todayIST();
    const from = input.startDate > today ? input.startDate : today;
    const issues = new Map<string, string[]>();
    const sessions: GeneratedSession[] = [];
    if (input.endDate < input.startDate) return { sessions, issues: ['End date is before the start date'] };
    if (daysBetween(input.startDate, input.endDate) > 800) return { sessions, issues: ['A batch can run for at most two years'] };
    const slots = [...new Map(input.slots.map((x) => [`${x.weekday}|${x.start}`, x])).values()];
    const settings = await this.shared.settings();
    const [teacher] = await dbx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, input.teacherUserId));
    if (!teacher) throw invalid('Choose a teacher', { teacherUserId: 'Unknown teacher' });
    const [room] = input.roomId ? await dbx.select().from(s.room).where(eq(s.room.id, input.roomId)) : [];
    if (input.roomId && !room) throw invalid('Choose a room', { roomId: 'Unknown room' });
    if (room && room.branchId !== input.branchId) throw invalid(`${room.name} is in another branch`, { roomId: 'Wrong branch' });
    const [profile] = await dbx.select({ onSiteDays: s.staffProfile.onSiteDays }).from(s.staffProfile).where(eq(s.staffProfile.userId, input.teacherUserId));
    const holidays = await dbx
      .select({ date: s.holiday.date, name: s.holiday.name, branchId: s.holiday.branchId })
      .from(s.holiday)
      .where(and(gte(s.holiday.date, from), lte(s.holiday.date, input.endDate), or(sql`${s.holiday.branchId} is null`, eq(s.holiday.branchId, input.branchId))));
    const leave = await dbx
      .select({ teacherId: s.leave.userId, date: s.leave.date })
      .from(s.leave)
      .where(and(eq(s.leave.userId, input.teacherUserId), eq(s.leave.status, 'approved'), gte(s.leave.date, from), lte(s.leave.date, input.endDate)));
    const existing = await this.timetable.slots(
      dbx,
      and(
        gte(s.classSession.date, from),
        lte(s.classSession.date, input.endDate),
        or(eq(s.classSession.branchId, input.branchId), eq(s.classSession.teacherUserId, input.teacherUserId)),
        notInArray(s.classSession.status, ['cancelled', 'suppressed']),
        input.excludeBatchId ? ne(s.classSession.batchId, input.excludeBatchId) : undefined,
      ),
    );
    const byDate = new Map<string, SlotSession[]>();
    for (const e of existing) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    for (let d = from; d <= input.endDate; d = addDays(d, 1)) {
      const wd = weekday(d);
      for (const slot of slots.filter((x) => x.weekday === wd)) {
        const holiday = holidays.find((h) => h.date === d);
        if (holiday) {
          sessions.push({ date: d, start: slot.start, suppressed: true, flagged: false });
          continue;
        }
        const candidate: SlotSession = {
          id: 'new',
          branchId: input.branchId,
          batchId: 'new',
          batchCode: input.batchCode,
          teacherId: input.teacherUserId,
          teacherName: teacher.name,
          roomId: room?.id ?? null,
          roomName: room?.name ?? null,
          date: d,
          start: slot.start,
          end: endOf(slot.start),
        };
        const found = validateSession(candidate, {
          existing: byDate.get(d) ?? [],
          holidays: [],
          approvedLeave: leave,
          roomCapacity: room?.capacity ?? null,
          batchSeats: room ? input.capacity : null,
          teacherOnSiteDays: profile?.onSiteDays?.[input.branchId] ?? [],
          travelBufferMin: settings.travelBufferMinutes,
        });
        const blocking = found.filter((i) => BLOCKING.has(i.code));
        for (const i of blocking) {
          const key = i.code === 'ROOM_CAPACITY' ? i.message : `${i.message}`;
          issues.set(key, [...(issues.get(key) ?? []), `${formatWeekdayDate(d)} ${slot.start}`]);
        }
        sessions.push({ date: d, start: slot.start, suppressed: false, flagged: found.some((i) => i.code === 'TEACHER_ON_LEAVE') });
      }
    }
    const lines = [...issues.entries()].map(([msg, when]) => (msg.includes(' seats ') ? msg : `${when[0]} · ${msg}${when.length > 1 ? ` (and ${when.length - 1} more date${when.length > 2 ? 's' : ''})` : ''}`));
    return { sessions, issues: lines };
  }

  private async checkInput(dbx: DbOrTx, input: BatchInput) {
    const branchId = this.shared.resolveBranch(input.branchId ?? null);
    const [offering] = await dbx.select().from(s.courseOffering).where(and(eq(s.courseOffering.courseId, input.courseId), eq(s.courseOffering.branchId, branchId)));
    const [course] = await dbx.select().from(s.course).where(eq(s.course.id, input.courseId));
    if (!course) throw notFound('Course');
    const [branch] = await dbx.select({ code: s.branch.code, name: s.branch.name }).from(s.branch).where(eq(s.branch.id, branchId));
    const issues: string[] = [];
    if (!offering) issues.push(`${course.name} is not offered at ${branch?.name ?? 'this branch'} — use “Offer a course here” first`);
    const code = input.code.toUpperCase();
    const [dup] = await dbx.select({ id: s.batch.id }).from(s.batch).where(and(eq(s.batch.branchId, branchId), sql`upper(${s.batch.code}) = ${code}`));
    if (dup) issues.push(`Batch code ${code} already exists in ${branch?.name ?? 'this branch'}`);
    if (input.feePlanId) {
      const [plan] = await dbx.select({ courseId: s.feePlan.courseId, branchId: s.feePlan.branchId }).from(s.feePlan).where(eq(s.feePlan.id, input.feePlanId));
      if (!plan || plan.courseId !== input.courseId || (plan.branchId && plan.branchId !== branchId)) issues.push('That fee plan does not belong to this course');
    }
    if (input.endDate <= input.startDate) issues.push('End date must be after the start date');
    if (input.endDate < todayIST()) issues.push('End date is in the past');
    return { branchId, offering, course, code, issues, branch };
  }

  async plan(input: BatchInput): Promise<AcadBatchPlan> {
    const base = await this.checkInput(this.db.db, input);
    const p = await this.planSessions(this.db.db, { branchId: base.branchId, batchCode: base.code, capacity: input.capacity, startDate: input.startDate, endDate: input.endDate, roomId: input.roomId, teacherUserId: input.teacherUserId, slots: input.slots });
    const issues = [...base.issues, ...p.issues];
    const live = p.sessions.filter((x) => !x.suppressed);
    return {
      ok: issues.length === 0,
      issues,
      sessions: live.length,
      suppressed: p.sessions.filter((x) => x.suppressed).length,
      flagged: p.sessions.filter((x) => x.flagged).length,
      firstDate: p.sessions[0]?.date ?? null,
      lastDate: p.sessions[p.sessions.length - 1]?.date ?? null,
    };
  }

  async create(input: BatchInput): Promise<AcadBatchRow> {
    const id = await this.db.tx(async (tx) => {
      const base = await this.checkInput(tx, input);
      const p = await this.planSessions(tx, { branchId: base.branchId, batchCode: base.code, capacity: input.capacity, startDate: input.startDate, endDate: input.endDate, roomId: input.roomId, teacherUserId: input.teacherUserId, slots: input.slots });
      const issues = [...base.issues, ...p.issues];
      if (issues.length) throw invalid(issues.join(' · '));
      const [batch] = await tx
        .insert(s.batch)
        .values({
          branchId: base.branchId,
          courseId: input.courseId,
          offeringId: base.offering!.id,
          code: base.code,
          name: input.name?.trim() || `${base.course.name} · ${base.code}`,
          startDate: input.startDate,
          endDate: input.endDate,
          capacity: input.capacity,
          scheduleLabel: scheduleLabel(input.slots),
          roomId: input.roomId,
          feePlanId: input.feePlanId ?? base.offering!.defaultFeePlanId,
          mode: input.mode,
          status: 'planned',
        })
        .returning();
      const [subject] = await tx.select({ id: s.courseSubject.id }).from(s.courseSubject).where(and(eq(s.courseSubject.courseId, input.courseId), eq(s.courseSubject.name, input.subjectName)));
      await tx.insert(s.teacherAssignment).values({ batchId: batch!.id, teacherUserId: input.teacherUserId, subjectId: subject?.id ?? null, subjectName: input.subjectName, isPrimary: true });
      const generated = await this.insertSessions(tx, batch!, input.teacherUserId, input.subjectName, p.sessions);
      await this.audit.log(tx, {
        action: 'Batch created',
        kind: 'create',
        entityType: 'batch',
        entityId: batch!.id,
        entityLabel: batch!.code,
        after: { code: batch!.code, course: base.course.code, start: input.startDate, end: input.endDate, capacity: input.capacity, schedule: batch!.scheduleLabel },
        summary: `${batch!.code} · ${base.course.name} · ${formatDayMonth(input.startDate)} – ${formatDayMonth(input.endDate)} · ${batch!.scheduleLabel} · ${generated.live} sessions${generated.suppressed ? ` (${generated.suppressed} suppressed for holidays)` : ''}`,
        branchId: base.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [input.teacherUserId],
        category: 'timetable',
        title: `New batch · ${batch!.code}`,
        body: `You take ${input.subjectName} · ${batch!.scheduleLabel} from ${formatDayMonth(input.startDate)}`,
        link: '/teacher',
        entityType: 'batch',
        entityId: batch!.id,
      });
      this.notify.invalidate(tx, base.branchId, [['academics'], ['reference']]);
      return batch!.id;
    });
    const [row] = await this.shared.batchRows(eq(s.batch.id, id));
    return row!;
  }

  private async insertSessions(tx: Tx, batch: typeof s.batch.$inferSelect, teacherUserId: string, subjectName: string, sessions: GeneratedSession[]) {
    let live = 0;
    let suppressed = 0;
    const me = ctx().userId;
    for (let i = 0; i < sessions.length; i += 200) {
      const chunk = sessions.slice(i, i + 200);
      const rows = await tx
        .insert(s.classSession)
        .values(
          chunk.map((x) => ({
            branchId: batch.branchId,
            batchId: batch.id,
            teacherUserId,
            subjectName,
            roomId: batch.roomId,
            date: x.date,
            startTime: x.start,
            endTime: endOf(x.start),
            mode: batch.mode,
            kind: 'timetabled' as const,
            status: x.suppressed ? ('suppressed' as const) : ('scheduled' as const),
            flag: x.flagged ? 'leave · substitute?' : null,
            createdBy: me,
          })),
        )
        .returning({ id: s.classSession.id, status: s.classSession.status });
      for (const r of rows) {
        if (r.status === 'suppressed') suppressed++;
        else {
          live++;
          await this.events.emit(tx, 'SessionCreated', { sessionId: r.id, branchId: batch.branchId, batchId: batch.id });
        }
      }
    }
    return { live, suppressed };
  }

  /* ───────────────────────── Edit & lifecycle ───────────────────────── */

  private async lockBatch(tx: Tx, id: string) {
    const [b] = await tx.select().from(s.batch).where(eq(s.batch.id, id)).for('update');
    if (!b) throw notFound('Batch');
    assertInScope(b.branchId);
    return b;
  }

  async update(id: string, body: BatchUpdate): Promise<AcadBatchRow> {
    await this.db.tx(async (tx) => {
      const b = await this.lockBatch(tx, id);
      const today = todayIST();
      const [{ n: enrolled } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.enrollment)
        .where(and(eq(s.enrollment.batchId, id), eq(s.enrollment.status, 'active')));
      const changes: string[] = [];
      const patch: Partial<typeof s.batch.$inferInsert> = {};
      if (body.capacity !== undefined && body.capacity !== b.capacity) {
        if (body.capacity < Number(enrolled)) throw invalid(`${b.code} has ${enrolled} active students — capacity cannot go below that`, { capacity: `At least ${enrolled}` });
        patch.capacity = body.capacity;
        changes.push(`capacity ${b.capacity} → ${body.capacity}`);
      }
      if (body.name !== undefined && (body.name ?? null) !== b.name) {
        patch.name = body.name;
        changes.push('name');
      }
      if (body.feePlanId !== undefined && body.feePlanId !== b.feePlanId) {
        if (body.feePlanId) {
          const [plan] = await tx.select({ courseId: s.feePlan.courseId }).from(s.feePlan).where(eq(s.feePlan.id, body.feePlanId));
          if (!plan || plan.courseId !== b.courseId) throw invalid('That fee plan does not belong to this course', { feePlanId: 'Wrong course' });
        }
        patch.feePlanId = body.feePlanId;
        changes.push('fee plan (new admissions only)');
      }
      if (body.meetLink !== undefined && body.meetLink !== b.meetLink) {
        patch.meetLink = body.meetLink;
        changes.push('meet link');
      }
      const status = body.status as AcadBatchStatus | undefined;
      if (status && status !== b.status) {
        const allowed = BATCH_TRANSITIONS[b.status as AcadBatchStatus];
        if (!allowed.includes(status)) throw invalid(`A ${BATCH_STATUS_META[b.status as AcadBatchStatus].label.toLowerCase()} batch cannot become ${BATCH_STATUS_META[status].label.toLowerCase()}`, { status: 'Not allowed' });
        if (status === 'cancelled') {
          if (!can('academics:courses.delete')) throw forbidden('You cannot cancel batches');
          if (!body.reason) throw invalid('Give a reason for cancelling — it is logged and sent to enrolled students', { reason: 'Required' });
        }
        if (status === 'running' && b.startDate > addDays(today, 7)) throw invalid(`${b.code} starts on ${formatDayMonth(b.startDate)} — keep it open for admission until its first week`, { status: 'Too early' });
        if (status === 'completed' && b.endDate > today) throw invalid(`${b.code} runs until ${formatDayMonth(b.endDate)} — complete it after the last session`, { status: 'Too early' });
        patch.status = status;
        changes.push(`status ${b.status} → ${status}`);
      }
      // Date, room and mode changes reshape future sessions.
      const startDate = body.startDate ?? b.startDate;
      const endDate = body.endDate ?? b.endDate;
      const roomId = body.roomId !== undefined ? body.roomId : b.roomId;
      const mode = body.mode ?? b.mode;
      const datesChanged = startDate !== b.startDate || endDate !== b.endDate;
      if (datesChanged) {
        if (endDate <= startDate) throw invalid('End date must be after the start date', { endDate: 'Too early' });
        if (startDate !== b.startDate && b.status === 'running') throw invalid('A running batch keeps its start date', { startDate: 'Locked' });
        patch.startDate = startDate;
        patch.endDate = endDate;
        changes.push(`dates ${formatDayMonth(b.startDate)}–${formatDayMonth(b.endDate)} → ${formatDayMonth(startDate)}–${formatDayMonth(endDate)}`);
      }
      if (roomId !== b.roomId) {
        patch.roomId = roomId;
        changes.push('room');
      }
      if (mode !== b.mode) {
        patch.mode = mode;
        changes.push(`mode ${b.mode} → ${mode}`);
      }
      if (changes.length === 0) return;

      const future = await tx
        .select()
        .from(s.classSession)
        .where(and(eq(s.classSession.batchId, id), gte(s.classSession.date, today), eq(s.classSession.kind, 'timetabled'), inArray(s.classSession.status, ['scheduled', 'suppressed']), sql`${s.classSession.attendanceSubmittedAt} is null`));
      let reshaped = '';
      if (patch.status === 'cancelled') {
        if (future.length) await tx.update(s.classSession).set({ status: 'cancelled' }).where(inArray(s.classSession.id, future.map((f) => f.id)));
        for (const f of future.filter((x) => x.status === 'scheduled')) await this.events.emit(tx, 'SessionRemoved', { sessionId: f.id, branchId: b.branchId, batchId: id });
        reshaped = ` · ${future.length} future sessions cancelled`;
      } else if (roomId !== b.roomId || mode !== b.mode || datesChanged) {
        // Room / mode: move future sessions that used the batch room; re-validate them.
        if (roomId !== b.roomId || mode !== b.mode) {
          const moving = future.filter((f) => f.status === 'scheduled' && (f.roomId === b.roomId || f.mode !== mode));
          const problems: string[] = [];
          for (const f of moving) {
            const v = await this.timetable.validate(tx, { id: f.id, batchId: id, teacherUserId: f.teacherUserId, subjectName: f.subjectName, date: f.date, start: f.startTime, roomId: f.roomId === b.roomId ? roomId : f.roomId, mode });
            const bad = v.issues.filter((i) => ['ROOM_CLASH', 'ROOM_CAPACITY', 'ROOM_REQUIRED'].includes(i.code));
            if (bad.length) problems.push(`${formatWeekdayDate(f.date)} ${f.startTime} · ${bad[0]!.message}`);
          }
          if (problems.length) throw invalid(`Cannot move ${b.code}'s future sessions: ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`);
          for (const f of moving) {
            await tx.update(s.classSession).set({ roomId: f.roomId === b.roomId ? roomId : f.roomId, mode }).where(eq(s.classSession.id, f.id));
            await this.events.emit(tx, 'SessionUpdated', { sessionId: f.id, branchId: b.branchId, batchId: id, changes: ['room'] });
          }
          if (moving.length) reshaped += ` · ${moving.length} future sessions moved`;
        }
        if (datesChanged) {
          const outside = future.filter((f) => f.date < startDate || f.date > endDate);
          if (outside.length) {
            await tx.update(s.classSession).set({ status: 'cancelled' }).where(inArray(s.classSession.id, outside.map((f) => f.id)));
            for (const f of outside) await this.events.emit(tx, 'SessionRemoved', { sessionId: f.id, branchId: b.branchId, batchId: id });
            reshaped += ` · ${outside.length} sessions outside the new dates cancelled`;
          }
          // Extend the weekly pattern into newly covered dates.
          const pattern = await tx
            .selectDistinct({ wd: sql<number>`extract(isodow from ${s.classSession.date})::int % 7`, start: s.classSession.startTime, teacherUserId: s.classSession.teacherUserId, subjectName: s.classSession.subjectName })
            .from(s.classSession)
            .where(and(eq(s.classSession.batchId, id), eq(s.classSession.kind, 'timetabled'), ne(s.classSession.status, 'cancelled'), sql`${s.classSession.substituteForUserId} is null`));
          const lastExisting = await tx.select({ d: sql<string | null>`max(${s.classSession.date})::text` }).from(s.classSession).where(and(eq(s.classSession.batchId, id), ne(s.classSession.status, 'cancelled')));
          const firstExisting = await tx.select({ d: sql<string | null>`min(${s.classSession.date})::text` }).from(s.classSession).where(and(eq(s.classSession.batchId, id), ne(s.classSession.status, 'cancelled')));
          const primary = pattern[0];
          if (primary) {
            const ranges: [string, string][] = [];
            const last = lastExisting[0]?.d ?? null;
            const first = firstExisting[0]?.d ?? null;
            if (last && endDate > last) ranges.push([addDays(last, 1), endDate]);
            if (first && startDate < first) ranges.push([startDate, addDays(first, -1)]);
            let added = 0;
            for (const [from, to] of ranges) {
              const p = await this.planSessions(tx, { branchId: b.branchId, batchCode: b.code, capacity: patch.capacity ?? b.capacity, startDate: from, endDate: to, roomId, teacherUserId: primary.teacherUserId, slots: pattern.map((x) => ({ weekday: Number(x.wd), start: x.start })), excludeBatchId: id });
              if (p.issues.length) throw invalid(`New dates clash: ${p.issues.slice(0, 3).join(' · ')}`);
              const g = await this.insertSessions(tx, { ...b, roomId, mode }, primary.teacherUserId, primary.subjectName, p.sessions);
              added += g.live;
            }
            if (added) reshaped += ` · ${added} sessions added`;
          }
        }
      }
      await tx.update(s.batch).set(patch).where(eq(s.batch.id, id));
      await this.audit.log(tx, {
        action: patch.status === 'cancelled' ? 'Batch cancelled' : patch.status ? 'Batch status changed' : 'Batch updated',
        kind: patch.status === 'cancelled' ? 'delete' : 'update',
        entityType: 'batch',
        entityId: id,
        entityLabel: b.code,
        before: { status: b.status, capacity: b.capacity, startDate: b.startDate, endDate: b.endDate, roomId: b.roomId, mode: b.mode, feePlanId: b.feePlanId },
        after: patch,
        summary: `${b.code} · ${changes.join(' · ')}${reshaped}${body.reason ? ` · ${body.reason}` : ''}`,
        branchId: b.branchId,
      });
      if (patch.status === 'cancelled' || datesChanged || patch.roomId !== undefined || patch.mode !== undefined) {
        await this.shared.notifyBatch(tx, id, {
          title: patch.status === 'cancelled' ? `${b.code} cancelled` : `${b.code} schedule updated`,
          body: patch.status === 'cancelled' ? (body.reason ?? 'The batch will not run') : changes.join(' · '),
          entityId: id,
        });
      }
      this.notify.invalidate(tx, b.branchId, [['academics'], ['reference']]);
    });
    const [row] = await this.shared.batchRows(eq(s.batch.id, id));
    return row!;
  }

  async assign(id: string, body: { teacherUserId: string; subjectName: string; isPrimary: boolean; replaceTeacherUserId?: string | null }): Promise<AcadBatchRow> {
    await this.db.tx(async (tx) => {
      const b = await this.lockBatch(tx, id);
      const [teacher] = await tx.select({ name: s.user.name, kind: s.user.kind }).from(s.user).where(eq(s.user.id, body.teacherUserId));
      if (!teacher || teacher.kind !== 'staff') throw invalid('Choose a teacher', { teacherUserId: 'Unknown' });
      const [subject] = await tx.select({ id: s.courseSubject.id }).from(s.courseSubject).where(and(eq(s.courseSubject.courseId, b.courseId), eq(s.courseSubject.name, body.subjectName)));
      const [existing] = await tx.select().from(s.teacherAssignment).where(and(eq(s.teacherAssignment.batchId, id), eq(s.teacherAssignment.teacherUserId, body.teacherUserId)));
      if (body.isPrimary) await tx.update(s.teacherAssignment).set({ isPrimary: false }).where(eq(s.teacherAssignment.batchId, id));
      if (existing) {
        await tx.update(s.teacherAssignment).set({ subjectName: body.subjectName, subjectId: subject?.id ?? null, isPrimary: body.isPrimary, active: true }).where(eq(s.teacherAssignment.id, existing.id));
      } else {
        await tx.insert(s.teacherAssignment).values({ batchId: id, teacherUserId: body.teacherUserId, subjectId: subject?.id ?? null, subjectName: body.subjectName, isPrimary: body.isPrimary });
      }
      let moved = 0;
      let replacedName: string | null = null;
      if (body.replaceTeacherUserId && body.replaceTeacherUserId !== body.teacherUserId) {
        const [old] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, body.replaceTeacherUserId));
        replacedName = old?.name ?? null;
        await tx.update(s.teacherAssignment).set({ active: false, isPrimary: false }).where(and(eq(s.teacherAssignment.batchId, id), eq(s.teacherAssignment.teacherUserId, body.replaceTeacherUserId)));
        const future = await tx
          .update(s.classSession)
          .set({ teacherUserId: body.teacherUserId, subjectName: body.subjectName, flag: null })
          .where(and(eq(s.classSession.batchId, id), eq(s.classSession.teacherUserId, body.replaceTeacherUserId), gte(s.classSession.date, todayIST()), eq(s.classSession.status, 'scheduled'), sql`${s.classSession.attendanceSubmittedAt} is null`))
          .returning({ id: s.classSession.id });
        moved = future.length;
        for (const f of future) await this.events.emit(tx, 'SessionUpdated', { sessionId: f.id, branchId: b.branchId, batchId: id, changes: ['teacher'] });
      }
      await this.audit.log(tx, {
        action: 'Teacher assigned',
        kind: 'update',
        entityType: 'batch',
        entityId: id,
        entityLabel: b.code,
        before: existing ? { subject: existing.subjectName, isPrimary: existing.isPrimary } : null,
        after: { teacher: teacher.name, subject: body.subjectName, isPrimary: body.isPrimary },
        summary: `${b.code} · ${teacher.name} → ${body.subjectName}${body.isPrimary ? ' (primary)' : ''}${replacedName ? ` · replaces ${replacedName} · ${moved} future sessions moved` : ''}`,
        branchId: b.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [body.teacherUserId, ...(body.replaceTeacherUserId ? [body.replaceTeacherUserId] : [])],
        category: 'timetable',
        title: `${b.code} · ${body.subjectName}`,
        body: replacedName ? `${teacher.name} takes over from ${replacedName}${moved ? ` · ${moved} sessions` : ''}` : `${teacher.name} assigned to ${b.code}`,
        link: '/teacher',
        entityType: 'batch',
        entityId: id,
      });
      if (moved) await this.shared.notifyBatch(tx, id, { title: `${b.code} · new teacher`, body: `${teacher.name} takes ${body.subjectName} from now on`, entityId: id });
      this.notify.invalidate(tx, b.branchId, [['academics'], ['reference']]);
    });
    const [row] = await this.shared.batchRows(eq(s.batch.id, id));
    return row!;
  }

  async offer(body: { courseId: string; branchId?: string; defaultFeePlanId: string }): Promise<AcadOffering> {
    const id = await this.db.tx(async (tx) => {
      const branchId = this.shared.resolveBranch(body.branchId ?? null);
      const [course] = await tx.select().from(s.course).where(eq(s.course.id, body.courseId));
      if (!course) throw notFound('Course');
      const [plan] = await tx.select().from(s.feePlan).where(eq(s.feePlan.id, body.defaultFeePlanId));
      if (!plan || plan.courseId !== course.id || (plan.branchId && plan.branchId !== branchId)) throw invalid('Choose a fee plan of this course', { defaultFeePlanId: 'Wrong course' });
      const [dup] = await tx.select({ id: s.courseOffering.id }).from(s.courseOffering).where(and(eq(s.courseOffering.courseId, course.id), eq(s.courseOffering.branchId, branchId)));
      const [branch] = await tx.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, branchId));
      if (dup) throw conflict(`${course.name} is already offered at ${branch?.name ?? 'this branch'}`);
      const [o] = await tx.insert(s.courseOffering).values({ courseId: course.id, branchId, defaultFeePlanId: plan.id }).returning();
      await this.audit.log(tx, {
        action: 'Course offered',
        kind: 'create',
        entityType: 'course_offering',
        entityId: o!.id,
        entityLabel: `${course.code} · ${branch?.name ?? ''}`,
        after: { course: course.code, plan: plan.name },
        summary: `${course.name} offered at ${branch?.name ?? ''} · default plan ${plan.name}`,
        branchId,
      });
      this.notify.invalidate(tx, branchId, [['academics']]);
      return o!.id;
    });
    const [row] = await this.offerings(eq(s.courseOffering.id, id));
    return row!;
  }
}
