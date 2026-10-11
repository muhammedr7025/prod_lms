import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ImportJob } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type DbOrTx, type ImportMapping } from '@exatech/db';
import { assignLead, isValidEmail, leadScore, normalizeEmail, normalizePhone, type AssignmentRuleDef } from '@exatech/domain';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { AuditService } from '../../core/audit/audit.service';
import { Db } from '../../core/db';
import { invalid } from '../../core/errors';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { QueueService } from '../../core/queue.service';
import { unavailableUsers, userNames } from './sales.shared';

export const MAX_IMPORT_ROWS = 10_000;
const CHUNK = 500;

type Target = ImportMapping[string];
type JobRow = typeof s.leadImportJob.$inferSelect;
interface RowError {
  row: number;
  field: string;
  message: string;
  value?: string;
}
interface Parsed {
  headers: string[];
  rows: string[][];
}
interface CheckedRow {
  row: number;
  name: string;
  phone: string;
  email: string | null;
  courseId: string | null;
  campaign: string | null;
  source: string | null;
  branchId: string | null;
  dup: { kind: 'lead'; id: string } | { kind: 'student'; id: string } | null;
}

/** Header → field guess ("Full Name" → name, "Mobile" → phone, "City" → skip…). */
export function guessTarget(header: string): Target {
  const h = header.trim().toLowerCase();
  if (/(^|\b)(full\s*name|name|student|lead\s*name|candidate)(\b|$)/.test(h) && !/(course|campaign|branch|father|parent|guardian)/.test(h)) return 'name';
  if (/(mobile|phone|contact\s*no|whatsapp|cell)/.test(h)) return 'phone';
  if (/e-?mail/.test(h)) return 'email';
  if (/(interest|course|program)/.test(h)) return 'course';
  if (/(campaign|utm)/.test(h)) return 'campaign';
  if (/^(lead\s*)?source$|channel/.test(h)) return 'source';
  if (/(branch|centre|center|preferred)/.test(h)) return 'branch';
  return 'skip';
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ('hyperlink' in v && typeof v.hyperlink === 'string') return v.hyperlink.replace(/^mailto:/, '');
  }
  return String(v);
}

/**
 * Lead import: parse CSV/XLSX (≤ 10,000 rows) server-side, guess the column
 * mapping, validate + dedupe against leads and students, then run as a
 * BullMQ job with batch inserts and round-robin assignment.
 */
@Injectable()
export class ImportsService implements OnModuleInit {
  private readonly log = new Logger('LeadImport');

  constructor(
    private readonly db: Db,
    private readonly files: FilesService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  onModuleInit() {
    this.queue.process(
      'imports',
      async (job) => {
        if (job.name === 'lead-import') await this.run((job.data as { jobId: string }).jobId);
      },
      1,
    );
  }

  /* ───────────── parsing ───────────── */

  async parse(fileId: string): Promise<Parsed> {
    const f = await this.files.get(fileId);
    const buf = await this.files.readKey(f.key);
    let table: string[][];
    if (f.mime.includes('spreadsheetml')) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) throw invalid('The workbook has no sheets');
      table = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values as ExcelJS.CellValue[];
        table.push(vals.slice(1).map((v) => cellText(v).trim()));
      });
    } else {
      const text = buf.toString('utf8').replace(/^﻿/, '');
      const res = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
      table = res.data.map((r) => r.map((c) => String(c ?? '').trim()));
    }
    const headerRow = table.shift() ?? [];
    const headers = headerRow.map((h, i) => h || `Column ${i + 1}`);
    if (headers.length === 0) throw invalid('The file is empty — add a header row and at least one lead');
    const rows = table.filter((r) => r.some((c) => c !== '')).map((r) => headers.map((_, i) => r[i] ?? ''));
    if (rows.length === 0) throw invalid('The file has a header row but no leads');
    if (rows.length > MAX_IMPORT_ROWS) throw invalid(`This file has ${rows.length.toLocaleString('en-IN')} rows — the limit is 10,000 per import`);
    return { headers, rows };
  }

  /* ───────────── validation ───────────── */

  private async lookups(db: DbOrTx, institutionId: string) {
    const [courses, branches, leads, students] = await Promise.all([
      db.select({ id: s.course.id, code: s.course.code, name: s.course.name }).from(s.course).where(eq(s.course.institutionId, institutionId)),
      db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name, city: s.branch.city }).from(s.branch),
      db.select({ id: s.lead.id, phone: s.lead.phone, email: s.lead.email }).from(s.lead).where(eq(s.lead.institutionId, institutionId)),
      db.select({ id: s.student.id, phone: s.student.phone, email: s.student.email }).from(s.student).where(eq(s.student.institutionId, institutionId)),
    ]);
    const leadKey = new Map<string, string>();
    for (const l of leads) {
      if (l.phone) leadKey.set(`p:${l.phone}`, l.id);
      if (l.email) leadKey.set(`e:${l.email.toLowerCase()}`, l.id);
    }
    const studentKey = new Map<string, string>();
    for (const st of students) {
      if (st.phone) studentKey.set(`p:${st.phone}`, st.id);
      if (st.email) studentKey.set(`e:${st.email.toLowerCase()}`, st.id);
    }
    const matchCourse = (v: string): string | null | undefined => {
      if (!v) return null;
      const x = v.trim().toLowerCase();
      const c =
        courses.find((c) => c.code.toLowerCase() === x || c.name.toLowerCase() === x) ??
        courses.find((c) => c.name.toLowerCase().startsWith(x) || x.startsWith(c.name.toLowerCase())) ??
        courses.find((c) => c.name.toLowerCase().replace(/[^a-z]/g, '').includes(x.replace(/[^a-z]/g, '')) && x.replace(/[^a-z]/g, '').length >= 2);
      return c ? c.id : undefined;
    };
    const matchBranch = (v: string): string | null => {
      if (!v) return null;
      const x = v.trim().toLowerCase();
      return branches.find((b) => b.code.toLowerCase() === x || b.name.toLowerCase() === x || b.city?.toLowerCase() === x)?.id ?? null;
    };
    return { leadKey, studentKey, matchCourse, matchBranch };
  }

  /** Validate every row; returns checked rows (valid ones) and errors. */
  async check(db: DbOrTx, institutionId: string, parsed: Parsed, mapping: ImportMapping) {
    const col = (t: Target) => parsed.headers.findIndex((h) => mapping[h] === t);
    const idx = { name: col('name'), phone: col('phone'), email: col('email'), course: col('course'), campaign: col('campaign'), source: col('source'), branch: col('branch') };
    if (idx.name < 0 || idx.phone < 0) throw invalid('Map a column to name and one to phone before validating', { mapping: 'name and phone are required' });
    const { leadKey, studentKey, matchCourse, matchBranch } = await this.lookups(db, institutionId);
    const seen = new Map<string, number>();
    const errors: RowError[] = [];
    const ok: CheckedRow[] = [];
    const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    parsed.rows.forEach((r, i) => {
      const row = i + 1;
      const name = get(r, idx.name);
      const rawPhone = get(r, idx.phone);
      const rawEmail = get(r, idx.email);
      const rawCourse = get(r, idx.course);
      const rowErrors: RowError[] = [];
      if (name.length < 2) rowErrors.push({ row, field: 'name', message: 'Name missing', value: name });
      const phone = normalizePhone(rawPhone);
      if (!phone) rowErrors.push({ row, field: 'phone', message: rawPhone ? 'Not a valid 10-digit mobile' : 'Phone missing', value: rawPhone });
      if (rawEmail && !isValidEmail(rawEmail)) rowErrors.push({ row, field: 'email', message: 'Not a valid email', value: rawEmail });
      const courseId = matchCourse(rawCourse);
      if (courseId === undefined) rowErrors.push({ row, field: 'course', message: 'Unknown course', value: rawCourse });
      if (phone && seen.has(phone)) rowErrors.push({ row, field: 'phone', message: `Repeats row ${seen.get(phone)}`, value: rawPhone });
      if (rowErrors.length) {
        errors.push(...rowErrors);
        return;
      }
      seen.set(phone!, row);
      const email = normalizeEmail(rawEmail || null);
      const stu = studentKey.get(`p:${phone}`) ?? (email ? studentKey.get(`e:${email}`) : undefined);
      const ld = leadKey.get(`p:${phone}`) ?? (email ? leadKey.get(`e:${email}`) : undefined);
      ok.push({
        row,
        name,
        phone: phone!,
        email,
        courseId: courseId ?? null,
        campaign: get(r, idx.campaign) || null,
        source: get(r, idx.source) || null,
        branchId: matchBranch(get(r, idx.branch)),
        dup: stu ? { kind: 'student', id: stu } : ld ? { kind: 'lead', id: ld } : null,
      });
    });
    const invalidRows = new Set(errors.map((e) => e.row)).size;
    const reasons = new Map<string, number>();
    for (const e of errors) {
      const k = e.field === 'phone' ? (e.message.startsWith('Repeats') ? 'repeated phone' : 'bad phone') : e.field === 'email' ? 'bad email' : e.field === 'course' ? 'unknown course' : 'missing name';
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    return {
      ok,
      errors,
      counts: {
        valid: ok.filter((x) => !x.dup).length,
        duplicates: ok.filter((x) => x.dup).length,
        duplicateLeads: ok.filter((x) => x.dup?.kind === 'lead').length,
        duplicateStudents: ok.filter((x) => x.dup?.kind === 'student').length,
        invalid: invalidRows,
        invalidLine: [...reasons.entries()].map(([k, n]) => `${n} ${k}`).join(' · ') || 'none',
      },
    };
  }

  /* ───────────── read model ───────────── */

  async view(job: JobRow, preview?: string[][]): Promise<ImportJob> {
    let assignees = 0;
    if (job.status === 'completed') {
      const [a] = await this.db.db.select({ n: sql<number>`count(distinct ${s.lead.ownerUserId})::int` }).from(s.lead).where(eq(s.lead.importJobId, job.id));
      assignees = Number(a?.n ?? 0);
    }
    const validated = job.status !== 'uploaded';
    const invalidLine = (job.errors ?? []).length
      ? (() => {
          const reasons = new Map<string, number>();
          for (const e of job.errors) {
            const k = e.field === 'phone' ? (e.message.startsWith('Repeats') ? 'repeated phone' : 'bad phone') : e.field === 'email' ? 'bad email' : e.field === 'course' ? 'unknown course' : e.field === 'job' ? 'job error' : 'missing name';
            reasons.set(k, (reasons.get(k) ?? 0) + 1);
          }
          return [...reasons.entries()].map(([k, n]) => `${n} ${k}`).join(' · ');
        })()
      : 'none';
    return {
      id: job.id,
      shortId: `#${(parseInt(job.id.replace(/-/g, '').slice(-6), 16) % 9000) + 1000}`,
      filename: job.filename,
      status: job.status,
      headers: job.headers,
      mapping: job.mapping ?? {},
      totalRows: job.totalRows,
      preview,
      validation: validated
        ? { valid: job.validRows, duplicates: job.duplicateRows, duplicateLeads: job.duplicateLeads, duplicateStudents: job.duplicateStudents, invalid: job.invalidRows, invalidLine }
        : null,
      dupStrategy: job.dupStrategy,
      progress: job.progress,
      processedRows: Math.round((job.progress / 100) * job.totalRows),
      created: job.createdCount,
      merged: job.mergedCount,
      skipped: job.skippedCount,
      errors: job.errorCount || job.invalidRows,
      assignees,
      durationSec: job.startedAt && job.finishedAt ? Math.max(1, Math.round((job.finishedAt.getTime() - job.startedAt.getTime()) / 1000)) : null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  /* ───────────── the job ───────────── */

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add('imports', 'lead-import', { jobId }, { attempts: 1, jobId: `lead-import-${jobId}` });
  }

  async run(jobId: string): Promise<void> {
    const db = this.db.db;
    const [job] = await db.select().from(s.leadImportJob).where(eq(s.leadImportJob.id, jobId));
    if (!job || job.status === 'completed' || job.status === 'running') return;
    const startedAt = new Date();
    await db.update(s.leadImportJob).set({ status: 'running', startedAt, progress: 0 }).where(eq(s.leadImportJob.id, jobId));
    try {
      const [branch] = await db.select({ institutionId: s.branch.institutionId, name: s.branch.name }).from(s.branch).where(eq(s.branch.id, job.branchId));
      if (!branch) throw new Error('Branch not found');
      const parsed = await this.parse(job.fileId!);
      const checked = await this.check(db, branch.institutionId, parsed, job.mapping ?? {});
      const total = parsed.rows.length;

      // Assignment: the branch's rules with in-memory round-robin cursors (persisted at the end).
      const rules = await db.select().from(s.assignmentRule).where(eq(s.assignmentRule.branchId, job.branchId)).orderBy(asc(s.assignmentRule.position));
      const away = await unavailableUsers(db, [...new Set(rules.flatMap((r) => r.assigneeUserIds))]);
      const defs: AssignmentRuleDef[] = rules.map((r) => ({ id: r.id, position: r.position, enabled: r.enabled, condition: r.condition, assigneeIds: r.assigneeUserIds, cursor: r.strategy === 'single' ? 0 : r.cursor }));
      const matched = new Map<string, number>();
      const names = await userNames(db, rules.flatMap((r) => r.assigneeUserIds));
      const openCourses = new Set(
        (
          await db
            .selectDistinct({ c: s.batch.courseId })
            .from(s.batch)
            .where(and(eq(s.batch.branchId, job.branchId), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist'])))
        ).map((r) => r.c),
      );

      let created = 0;
      let merged = 0;
      let skipped = 0;
      const perOwner = new Map<string, number>();
      const strategy = job.dupStrategy;
      for (let i = 0; i < checked.ok.length; i += CHUNK) {
        const chunk = checked.ok.slice(i, i + CHUNK);
        await this.db.tx(async (tx) => {
          const leadRows: (typeof s.lead.$inferInsert)[] = [];
          const acts: (typeof s.leadActivity.$inferInsert)[] = [];
          for (const r of chunk) {
            if (r.dup && (strategy === 'skip' || (strategy === 'merge' && r.dup.kind === 'student'))) {
              skipped++;
              continue;
            }
            if (r.dup?.kind === 'lead' && strategy === 'merge') {
              await tx
                .update(s.lead)
                .set({
                  campaign: r.campaign ?? sql`${s.lead.campaign}`,
                  email: sql`coalesce(${s.lead.email}, ${r.email})`,
                  courseId: sql`coalesce(${s.lead.courseId}, ${r.courseId})`,
                  lastActivityAt: new Date(),
                })
                .where(eq(s.lead.id, r.dup.id));
              acts.push({ leadId: r.dup.id, actorUserId: job.createdBy, kind: 'merged', summary: `Merged from import ${job.filename} · row ${r.row}${r.campaign ? ` · campaign ${r.campaign}` : ''}`, meta: { jobId } });
              merged++;
              continue;
            }
            const source = r.source || 'Import';
            const preferredBranchId = r.branchId ?? job.branchId;
            const hit = assignLead({ source, courseId: r.courseId, preferredBranchId }, defs, (id) => !away.has(id));
            if (hit) {
              const def = defs.find((d) => d.id === hit.ruleId)!;
              if (rules.find((x) => x.id === def.id)?.strategy !== 'single') def.cursor = hit.nextCursor;
              matched.set(def.id, (matched.get(def.id) ?? 0) + 1);
            }
            const owner = hit?.assigneeId ?? job.createdBy;
            perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
            const id = s.uuidv7();
            leadRows.push({
              id,
              institutionId: branch.institutionId,
              branchId: job.branchId,
              name: r.name,
              phone: r.phone,
              email: r.email,
              source,
              campaign: r.campaign,
              courseId: r.courseId,
              preferredBranchId,
              stage: 'new',
              ownerUserId: owner,
              score: leadScore({ source, stage: 'new', responded: false, visited: false, demoAttended: false, courseHasOpenBatch: !!r.courseId && openCourses.has(r.courseId), hasEmail: !!r.email }),
              importJobId: jobId,
              assignedByRuleId: hit?.ruleId ?? null,
              createdBy: job.createdBy,
            });
            const rule = hit ? rules.find((x) => x.id === hit.ruleId) : null;
            acts.push({ leadId: id, actorUserId: job.createdBy, kind: 'import', summary: `Imported from ${job.filename} · row ${r.row}${rule ? ` · assigned by rule ${rule.name} → ${names.get(owner) ?? '—'}` : ''}`, meta: { jobId } });
            created++;
          }
          if (leadRows.length) await tx.insert(s.lead).values(leadRows);
          if (acts.length) await tx.insert(s.leadActivity).values(acts);
        });
        const done = Math.min(total, Math.round(((i + chunk.length) / Math.max(1, checked.ok.length)) * total));
        await db
          .update(s.leadImportJob)
          .set({ progress: Math.min(99, Math.round((done / total) * 100)), createdCount: created, mergedCount: merged, skippedCount: skipped })
          .where(eq(s.leadImportJob.id, jobId));
      }

      await this.db.tx(async (tx) => {
        for (const d of defs) {
          const n = matched.get(d.id);
          if (n) await tx.update(s.assignmentRule).set({ cursor: d.cursor, matchedCount: sql`${s.assignmentRule.matchedCount} + ${n}` }).where(eq(s.assignmentRule.id, d.id));
        }
        await tx
          .update(s.leadImportJob)
          .set({
            status: 'completed',
            progress: 100,
            finishedAt: new Date(),
            createdCount: created,
            mergedCount: merged,
            skippedCount: skipped,
            errorCount: new Set(checked.errors.map((e) => e.row)).size,
            errors: checked.errors,
            invalidRows: new Set(checked.errors.map((e) => e.row)).size,
          })
          .where(eq(s.leadImportJob.id, jobId));
        await this.notify.notify(tx, {
          userIds: [job.createdBy],
          category: 'lead',
          title: `Import complete · ${created.toLocaleString('en-IN')} leads created`,
          body: `${job.filename} · ${merged} merged · ${skipped} skipped · ${new Set(checked.errors.map((e) => e.row)).size} errors`,
          link: '/sales/import',
        });
        for (const [owner, n] of perOwner) {
          if (owner === job.createdBy) continue;
          await this.notify.notify(tx, { userIds: [owner], category: 'lead', title: `${n} new lead${n === 1 ? '' : 's'} assigned`, body: `Imported from ${job.filename} · first response timers started`, link: '/sales/pipeline' });
        }
        await this.audit.log(tx, {
          action: 'Leads imported',
          kind: 'create',
          entityType: 'lead_import_job',
          entityId: jobId,
          entityLabel: job.filename,
          after: { created, merged, skipped, errors: checked.errors.length, owners: perOwner.size },
          summary: `${job.filename} · ${created} created · ${merged} merged · ${skipped} skipped · assigned to ${perOwner.size} salespeople`,
          branchId: job.branchId,
        });
        this.notify.invalidate(tx, job.branchId, [['sales']]);
      });
      this.log.log(`import ${jobId}: ${created} created, ${merged} merged in ${Date.now() - startedAt.getTime()} ms`);
    } catch (err) {
      this.log.error(`import ${jobId} failed: ${(err as Error).stack ?? err}`);
      await db
        .update(s.leadImportJob)
        .set({ status: 'failed', finishedAt: new Date(), errors: [...(job.errors ?? []), { row: 0, field: 'job', message: (err as Error).message.slice(0, 300) }] })
        .where(eq(s.leadImportJob.id, jobId));
    }
  }
}
