import { Injectable } from '@nestjs/common';
import { TEACH_EXAM_STATUSES, type TeachBatch, type TeachExam, type TeachExamOption, type TeachImportResult, type TeachTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx } from '@exatech/db';
import { canSubmitMarks, examMaxTotal, examStats, formatWeekdayDate, isValidISODate, todayIST } from '@exatech/domain';
import Papa from 'papaparse';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { plural, TeachingShared } from './teaching.shared';

type ExamStatus = (typeof TEACH_EXAM_STATUSES)[number];

const STATUS: Record<ExamStatus, { label: string; tag: TeachTag; order: number }> = {
  returned: { label: 'Returned · fix & resubmit', tag: 'ink', order: 0 },
  draft: { label: 'Draft', tag: 'neutral', order: 1 },
  submitted: { label: 'Submitted · awaiting publish', tag: 'outline', order: 2 },
  published: { label: 'Published', tag: 'accent', order: 3 },
};

const fmt = (n: number) => String(Math.round(n * 10) / 10);
const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/** Teacher · Marks: exam picker, grid with autosave, fill 0, CSV import, submit / recall, new exam. */
@Injectable()
export class TeachingMarksService {
  constructor(
    private readonly db: Db,
    private readonly shared: TeachingShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
  ) {}

  async exams(): Promise<{ items: TeachExamOption[]; batches: TeachBatch[] }> {
    const batches = await this.shared.myBatches();
    if (!batches.length) return { items: [], batches };
    const rows = await this.db.db
      .select({ e: s.exam, batchCode: s.batch.code })
      .from(s.exam)
      .innerJoin(s.batch, eq(s.batch.id, s.exam.batchId))
      .where(inArray(s.exam.batchId, batches.map((b) => b.id)));
    const items = rows
      .map((r) => ({
        id: r.e.id,
        name: r.e.name,
        batchId: r.e.batchId,
        batchCode: r.batchCode,
        status: r.e.status as ExamStatus,
        label: `${r.e.name} · ${r.batchCode} · ${r.e.status}`,
        date: r.e.date,
      }))
      .sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || a.date.localeCompare(b.date));
    return { items, batches };
  }

  private async mine(id: string, dbx: DbOrTx = this.db.db, lock = false) {
    const q = dbx.select().from(s.exam).where(eq(s.exam.id, id));
    const [e] = lock ? await q.for('update') : await q;
    if (!e) throw notFound('Exam');
    const b = await this.shared.myBatch(e.batchId, dbx);
    return { e, b };
  }

  private async grid(dbx: DbOrTx, e: typeof s.exam.$inferSelect) {
    const comps = await dbx.select().from(s.examComponent).where(eq(s.examComponent.examId, e.id)).orderBy(asc(s.examComponent.position));
    const marks = await dbx.select({ enrollmentId: s.mark.enrollmentId, componentId: s.mark.examComponentId, value: s.mark.value }).from(s.mark).where(eq(s.mark.examId, e.id));
    const active = await this.shared.roster(e.batchId, dbx);
    const extraIds = [...new Set(marks.map((m) => m.enrollmentId))].filter((id) => !active.some((a) => a.enrollmentId === id));
    const extra = extraIds.length
      ? await dbx
          .select({ enrollmentId: s.enrollment.id, studentId: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo, userId: s.student.userId })
          .from(s.enrollment)
          .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
          .where(inArray(s.enrollment.id, extraIds))
      : [];
    const people = [...active, ...extra].sort((a, b) => a.name.localeCompare(b.name));
    const rows = people.map((p) => ({
      enrollmentId: p.enrollmentId,
      name: p.name,
      admissionNo: p.admissionNo,
      values: comps.map((c) => marks.find((m) => m.enrollmentId === p.enrollmentId && m.componentId === c.id)?.value ?? null),
    }));
    const defs = comps.map((c) => ({ name: c.name, max: c.maxMarks }));
    return { comps, rows, defs };
  }

  async exam(id: string): Promise<TeachExam> {
    const { e, b } = await this.mine(id);
    const { comps, rows, defs } = await this.grid(this.db.db, e);
    const status = e.status as ExamStatus;
    return {
      id: e.id,
      name: e.name,
      batchId: e.batchId,
      batchCode: b.code,
      kicker: `${b.code} · ${formatWeekdayDate(e.date)} · ${plural(rows.length, 'student')}`,
      date: e.date,
      status,
      statusLabel: STATUS[status].label,
      tag: STATUS[status].tag,
      editable: status === 'draft' || status === 'returned',
      components: comps.map((c) => ({ id: c.id, name: c.name, max: c.maxMarks })),
      maxTotal: examMaxTotal(defs),
      rows,
      returnNote: status === 'returned' ? e.returnNote : null,
    };
  }

  private assertEditable(status: string) {
    if (status === 'submitted') throw conflict('These marks are submitted — recall to draft before editing');
    if (status === 'published') throw forbidden('Published marks are read-only — corrections need a Branch Admin override with a reason');
  }

  async create(body: { batchId: string; date: string; name: string; components: { name: string; max: number }[] }): Promise<{ id: string }> {
    const b = await this.shared.myBatch(body.batchId);
    if (!isValidISODate(body.date)) throw invalid('Pick a valid date', { date: 'Invalid' });
    const names = body.components.map((c) => norm(c.name));
    if (new Set(names).size !== names.length) throw invalid('Component names must be different', { components: 'Duplicate' });
    const c = ctx();
    const mine = (await this.shared.assignments()).find((a) => a.batchId === b.id);
    return this.db.tx(async (tx) => {
      const [dup] = await tx
        .select({ id: s.exam.id })
        .from(s.exam)
        .where(and(eq(s.exam.batchId, b.id), sql`lower(${s.exam.name}) = ${body.name.toLowerCase()}`));
      if (dup) throw conflict(`"${body.name}" already exists for ${b.code} — pick another name`, 'DUPLICATE_EXAM');
      const [row] = await tx
        .insert(s.exam)
        .values({ batchId: b.id, branchId: b.branchId, teacherUserId: c.userId, name: body.name, date: body.date, startTime: '10:00', status: 'draft' })
        .returning({ id: s.exam.id });
      const examId = row!.id;
      const comps = await tx
        .insert(s.examComponent)
        .values(body.components.map((x, i) => ({ examId, position: i, name: x.name, maxMarks: x.max })))
        .returning({ id: s.examComponent.id });
      const roster = await this.shared.roster(b.id, tx);
      if (roster.length) {
        await tx.insert(s.mark).values(roster.flatMap((r) => comps.map((cp) => ({ examId, examComponentId: cp.id, enrollmentId: r.enrollmentId, value: null, updatedBy: c.userId }))));
      }
      const [sess] = await tx
        .insert(s.classSession)
        .values({
          branchId: b.branchId,
          batchId: b.id,
          teacherUserId: c.userId,
          subjectName: mine?.subjectName ?? b.code,
          date: body.date,
          startTime: '10:00',
          endTime: '12:00',
          mode: b.mode,
          kind: 'exam',
          status: body.date < todayIST() ? 'held' : 'scheduled',
          topic: `Exam · ${body.name}`,
          createdBy: c.userId,
        })
        .returning({ id: s.classSession.id });
      await this.events.emit(tx, 'SessionCreated', { sessionId: sess!.id, branchId: b.branchId, batchId: b.id });
      const total = body.components.reduce((a, x) => a + x.max, 0);
      await this.audit.log(tx, {
        action: 'Exam created',
        kind: 'create',
        entityType: 'exam',
        entityId: examId,
        entityLabel: `${b.code}/${body.name}`,
        after: { date: body.date, components: body.components },
        summary: `${b.code} · ${body.name} · ${formatWeekdayDate(body.date)} · ${body.components.map((x) => `${x.name} ${fmt(x.max)}`).join(' + ')} = ${fmt(total)} · ${plural(roster.length, 'roster row')}`,
        branchId: b.branchId,
      });
      if (body.date >= todayIST()) {
        await this.notify.notify(tx, {
          userIds: roster.map((r) => r.userId).filter((x): x is string => !!x),
          category: 'exam_schedule',
          title: `Exam scheduled · ${body.name}`,
          body: `${b.code} · ${formatWeekdayDate(body.date)} 10:00 · ${fmt(total)} marks`,
          link: '/student/timetable',
          entityType: 'exam',
          entityId: examId,
        });
      }
      this.notify.invalidate(tx, b.branchId, [['teaching'], ['academics'], ['portal']]);
      return { id: examId };
    });
  }

  private async upsertCells(tx: DbOrTx, examId: string, cells: { enrollmentId: string; componentId: string; value: number | null }[]) {
    if (!cells.length) return;
    const by = ctx().userId;
    await tx
      .insert(s.mark)
      .values(cells.map((x) => ({ examId, examComponentId: x.componentId, enrollmentId: x.enrollmentId, value: x.value, updatedBy: by })))
      .onConflictDoUpdate({
        target: [s.mark.examComponentId, s.mark.enrollmentId],
        set: { value: sql`excluded.value`, updatedBy: sql`excluded.updated_by`, updatedAt: new Date() },
      });
  }

  /** Draft autosave (debounced per cell on the client). Drafts are never visible to students. */
  async save(id: string, cells: { enrollmentId: string; componentId: string; value: number | null }[]): Promise<{ savedAt: Date }> {
    return this.db.tx(async (tx) => {
      const { e } = await this.mine(id, tx, true);
      this.assertEditable(e.status);
      const { comps, rows } = await this.grid(tx, e);
      for (const x of cells) {
        if (!comps.some((c) => c.id === x.componentId)) throw invalid('Unknown exam component');
        if (!rows.some((r) => r.enrollmentId === x.enrollmentId)) throw invalid('That student is not on this exam roster');
      }
      await this.upsertCells(tx, e.id, cells);
      return { savedAt: new Date() };
    });
  }

  async fillZero(id: string): Promise<{ filled: number }> {
    return this.db.tx(async (tx) => {
      const { e, b } = await this.mine(id, tx, true);
      this.assertEditable(e.status);
      const { comps, rows } = await this.grid(tx, e);
      const cells = rows.flatMap((r) => comps.map((c, i) => ({ enrollmentId: r.enrollmentId, componentId: c.id, value: r.values[i] }))).filter((x) => x.value == null);
      await this.upsertCells(
        tx,
        e.id,
        cells.map((x) => ({ ...x, value: 0 })),
      );
      if (cells.length) {
        await this.audit.log(tx, {
          action: 'Marks filled with 0',
          kind: 'update',
          entityType: 'exam',
          entityId: e.id,
          entityLabel: `${b.code}/${e.name}`,
          after: { filled: cells.length },
          summary: `${b.code} · ${e.name} · ${plural(cells.length, 'empty cell')} → 0 (draft)`,
          branchId: e.branchId,
        });
      }
      return { filled: cells.length };
    });
  }

  async importCsv(id: string, csv: string, dryRun: boolean): Promise<TeachImportResult> {
    return this.db.tx(async (tx) => {
      const { e, b } = await this.mine(id, tx, true);
      this.assertEditable(e.status);
      const { comps, rows } = await this.grid(tx, e);
      const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: norm });
      const headers = parsed.meta.fields ?? [];
      const admKey = headers.find((h) => ['admission_no', 'admission no', 'admission number', 'adm no', 'admission_number'].includes(h));
      const colFor = comps.map((c) => headers.find((h) => h === norm(c.name) || h.replace(/\s*\(.*\)$/, '') === norm(c.name)) ?? null);
      const missingColumns = [...(admKey ? [] : ['admission_no']), ...comps.filter((_, i) => !colFor[i]).map((c) => c.name)];
      const unknown: string[] = [];
      const cells: { enrollmentId: string; componentId: string; value: number | null }[] = [];
      let matched = 0;
      let overMax = 0;
      if (admKey) {
        for (const r of parsed.data) {
          const adm = String(r[admKey] ?? '').trim();
          if (!adm) continue;
          const row = rows.find((x) => (x.admissionNo ?? '').toUpperCase() === adm.toUpperCase());
          if (!row) {
            unknown.push(adm);
            continue;
          }
          matched++;
          comps.forEach((c, i) => {
            const col = colFor[i];
            if (!col) return;
            const raw = String(r[col] ?? '').trim();
            if (raw === '') return;
            const v = Number(raw);
            if (!Number.isFinite(v) || v < 0) return;
            if (v > c.maxMarks) overMax++;
            cells.push({ enrollmentId: row.enrollmentId, componentId: c.id, value: v });
          });
        }
      }
      const result = { rows: parsed.data.length, matched, cells: cells.length, overMax, unknown, missingColumns, applied: false };
      if (dryRun || !cells.length) return result;
      await this.upsertCells(tx, e.id, cells);
      await this.audit.log(tx, {
        action: 'Marks imported',
        kind: 'update',
        entityType: 'exam',
        entityId: e.id,
        entityLabel: `${b.code}/${e.name}`,
        after: { cells: cells.length, matched, unknown: unknown.length, overMax },
        summary: `${b.code} · ${e.name} · CSV · ${plural(matched, 'student')} · ${plural(cells.length, 'cell')}${unknown.length ? ` · ${unknown.length} unknown admission no.` : ''}${overMax ? ` · ${overMax} over max` : ''} (draft)`,
        branchId: e.branchId,
      });
      return { ...result, applied: true };
    });
  }

  async submit(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const { e, b } = await this.mine(id, tx, true);
      if (e.status === 'submitted') throw conflict('These marks are already submitted and waiting for the Branch Admin');
      if (e.status === 'published') throw conflict('These marks are already published');
      const { rows, defs } = await this.grid(tx, e);
      const values = rows.map((r) => r.values);
      const check = canSubmitMarks(values, defs);
      if (!check.ok) throw invalid(`Cannot submit — ${check.reason}`);
      const st = examStats(values, defs);
      const from = e.status;
      await tx.update(s.exam).set({ status: 'submitted', submittedAt: new Date() }).where(eq(s.exam.id, e.id));
      await this.events.emit(tx, 'MarksSubmitted', { examId: e.id, branchId: e.branchId, batchId: e.batchId });
      const avg = st.average == null ? '—' : `${fmt(st.average)} / ${fmt(examMaxTotal(defs))}`;
      await this.audit.log(tx, {
        action: 'Marks submitted',
        kind: 'update',
        entityType: 'exam',
        entityId: e.id,
        entityLabel: `${b.code}/${e.name}`,
        before: { status: from },
        after: { status: 'submitted' },
        summary: `${from} → submitted · ${e.name} · ${b.code} · ${plural(rows.length, 'row')} · avg ${avg}`,
        branchId: e.branchId,
      });
      await this.notify.notify(tx, {
        userIds: await this.shared.branchAdmins(tx, e.branchId),
        category: 'marks',
        title: `Marks submitted · ${e.name}`,
        body: `${b.code} · ${ctx().userName} · ${plural(rows.length, 'student')} · avg ${avg} — review & publish`,
        link: '/marks-publishing',
        entityType: 'exam',
        entityId: e.id,
      });
      this.notify.invalidate(tx, e.branchId, [['teaching'], ['academics']]);
    });
  }

  async recall(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const { e, b } = await this.mine(id, tx, true);
      if (e.status !== 'submitted') throw conflict(e.status === 'published' ? 'Published marks cannot be recalled — ask the Branch Admin for an override' : 'Only submitted marks can be recalled');
      await tx.update(s.exam).set({ status: 'draft', submittedAt: null }).where(eq(s.exam.id, e.id));
      await this.audit.log(tx, {
        action: 'Marks recalled',
        kind: 'update',
        entityType: 'exam',
        entityId: e.id,
        entityLabel: `${b.code}/${e.name}`,
        before: { status: 'submitted' },
        after: { status: 'draft' },
        summary: `submitted → draft · ${e.name} · ${b.code} · recalled by the teacher`,
        branchId: e.branchId,
      });
      await this.notify.notify(tx, {
        userIds: await this.shared.branchAdmins(tx, e.branchId),
        category: 'marks',
        title: `Marks recalled · ${e.name}`,
        body: `${b.code} · ${ctx().userName} recalled the marks to draft`,
        link: '/marks-publishing',
        entityType: 'exam',
        entityId: e.id,
      });
      this.notify.invalidate(tx, e.branchId, [['teaching'], ['academics']]);
    });
  }
}
