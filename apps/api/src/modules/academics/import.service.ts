import { Injectable } from '@nestjs/common';
import { STUDENT_IMPORT_REQUIRED, type AcadImportPreview } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, eq, inArray, sql, type Tx } from '@exatech/db';
import { financialYear, formatNumber, isValidISODate, normalizeEmail, normalizePhone, todayIST, DEFAULT_PATTERNS } from '@exatech/domain';
import crypto from 'node:crypto';
import Papa from 'papaparse';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid } from '../../core/errors';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { NumberingService } from '../../core/numbering.service';
import { AcademicsShared } from './academics.shared';

interface ParsedRow {
  row: number;
  name: string;
  phone: string | null;
  email: string | null;
  dob: string | null;
  batchCode: string;
  batchId: string | null;
  branchId: string | null;
  courseCode: string | null;
  joinedOn: string | null;
  admissionNo: string | null;
  guardianName: string;
  guardianPhone: string | null;
  guardianEmail: string | null;
  relationship: string;
  rawPhone: string;
  rawGuardianPhone: string;
  errors: { field: string; message: string; value: string }[];
}

const HEADER_ALIASES: Record<string, string> = {
  student: 'name',
  student_name: 'name',
  full_name: 'name',
  mobile: 'phone',
  student_phone: 'phone',
  batch_code: 'batch',
  date_of_birth: 'dob',
  joined: 'joined_on',
  join_date: 'joined_on',
  admission_number: 'admission_no',
  parent_name: 'guardian_name',
  guardian: 'guardian_name',
  parent_phone: 'guardian_phone',
  parent_email: 'guardian_email',
};

function normHeader(h: string): string {
  const k = h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return HEADER_ALIASES[k] ?? k;
}

/** "2004-05-17", "17/05/2004" or "17-05-2004" → ISO date, or null when invalid. */
function parseDate(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (isValidISODate(t)) return t;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

/**
 * Go-live import: existing students from a spreadsheet → students, guardians,
 * invited portal users, enrollments and memberships (fee accounts are set up
 * separately by Finance). Preview validates every row first.
 */
@Injectable()
export class StudentImportService {
  constructor(
    private readonly db: Db,
    private readonly files: FilesService,
    private readonly shared: AcademicsShared,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notify: NotifyService,
  ) {}

  private async parse(fileId: string): Promise<{ headers: string[]; missing: string[]; rows: ParsedRow[] }> {
    const f = await this.files.get(fileId);
    if (f.purpose !== 'import') throw invalid('Upload a CSV file for the import');
    if (f.ownerUserId !== ctx().userId) throw forbidden('This upload belongs to someone else');
    const text = (await this.files.read(fileId)).toString('utf8').replace(/^﻿/, '');
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: normHeader });
    const headers = parsed.meta.fields ?? [];
    const missing = STUDENT_IMPORT_REQUIRED.filter((c) => !headers.includes(c));
    if (parsed.data.length > 2000) throw invalid('Import up to 2,000 students per file — split the sheet');
    const sc = branchScope();
    const batches = await this.db.db
      .select({ id: s.batch.id, code: s.batch.code, branchId: s.batch.branchId, status: s.batch.status, startDate: s.batch.startDate, capacity: s.batch.capacity, courseCode: s.course.code })
      .from(s.batch)
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(sc ? inArray(s.batch.branchId, sc) : undefined);
    const enrolled = await this.db.db
      .select({ batchId: s.enrollment.batchId, n: sql<number>`count(*)::int` })
      .from(s.enrollment)
      .where(eq(s.enrollment.status, 'active'))
      .groupBy(s.enrollment.batchId);
    const seats = new Map(batches.map((b) => [b.id, b.capacity - Number(enrolled.find((e) => e.batchId === b.id)?.n ?? 0)]));
    const rows: ParsedRow[] = parsed.data.map((raw, i) => {
      const v = (k: string) => String(raw[k] ?? '').trim();
      const errors: ParsedRow['errors'] = [];
      const name = v('name');
      if (name.length < 2) errors.push({ field: 'name', message: 'Name is required', value: name });
      const phone = normalizePhone(v('phone'));
      if (!phone) errors.push({ field: 'phone', message: 'Enter a valid 10-digit mobile', value: v('phone') });
      const emailRaw = v('email');
      const email = emailRaw ? normalizeEmail(emailRaw) : null;
      if (emailRaw && !email) errors.push({ field: 'email', message: 'Invalid email', value: emailRaw });
      const dob = v('dob') ? parseDate(v('dob')) : null;
      if (v('dob') && !dob) errors.push({ field: 'dob', message: 'Use YYYY-MM-DD or DD/MM/YYYY', value: v('dob') });
      const code = v('batch').toUpperCase();
      const batch = batches.filter((b) => b.code.toUpperCase() === code);
      if (!code) errors.push({ field: 'batch', message: 'Batch code is required', value: '' });
      else if (batch.length === 0) errors.push({ field: 'batch', message: 'No such batch in your branch', value: code });
      else if (batch.length > 1) errors.push({ field: 'batch', message: 'Batch code exists in several branches — pick the branch in the header first', value: code });
      else if (['completed', 'cancelled'].includes(batch[0]!.status)) errors.push({ field: 'batch', message: `Batch is ${batch[0]!.status}`, value: code });
      const joinedRaw = v('joined_on');
      const joinedOn = joinedRaw ? parseDate(joinedRaw) : null;
      if (joinedRaw && !joinedOn) errors.push({ field: 'joined_on', message: 'Use YYYY-MM-DD or DD/MM/YYYY', value: joinedRaw });
      const guardianName = v('guardian_name');
      if (guardianName.length < 2) errors.push({ field: 'guardian_name', message: 'Guardian name is required', value: guardianName });
      const guardianPhone = normalizePhone(v('guardian_phone'));
      if (!guardianPhone) errors.push({ field: 'guardian_phone', message: 'Enter a valid 10-digit mobile', value: v('guardian_phone') });
      const gEmailRaw = v('guardian_email');
      const guardianEmail = gEmailRaw ? normalizeEmail(gEmailRaw) : null;
      if (gEmailRaw && !guardianEmail) errors.push({ field: 'guardian_email', message: 'Invalid email', value: gEmailRaw });
      if (phone && guardianPhone && phone === guardianPhone) errors.push({ field: 'guardian_phone', message: 'Guardian phone must differ from the student phone', value: v('guardian_phone') });
      const b = batch.length === 1 ? batch[0]! : null;
      return {
        row: i + 2,
        name,
        phone,
        email,
        dob,
        batchCode: code,
        batchId: b?.id ?? null,
        branchId: b?.branchId ?? null,
        courseCode: b?.courseCode ?? null,
        joinedOn: joinedOn ?? b?.startDate ?? null,
        admissionNo: v('admission_no') || null,
        guardianName,
        guardianPhone,
        guardianEmail,
        relationship: v('relationship') || 'Guardian',
        rawPhone: v('phone'),
        rawGuardianPhone: v('guardian_phone'),
        errors,
      };
    });
    // Duplicates inside the file and against existing records.
    const phones = rows.map((r) => r.phone).filter((x): x is string => !!x);
    const adms = rows.map((r) => r.admissionNo).filter((x): x is string => !!x);
    const existingStudents = phones.length ? await this.db.db.select({ phone: s.student.phone, adm: s.student.admissionNo }).from(s.student).where(inArray(s.student.phone, phones)) : [];
    const existingUsers = phones.length ? await this.db.db.select({ phone: s.user.phoneNumber, kind: s.user.kind }).from(s.user).where(inArray(s.user.phoneNumber, phones)) : [];
    const existingAdm = adms.length ? await this.db.db.select({ adm: s.student.admissionNo }).from(s.student).where(inArray(s.student.admissionNo, adms)) : [];
    const guardianPhones = rows.map((r) => r.guardianPhone).filter((x): x is string => !!x);
    const gUsers = guardianPhones.length ? await this.db.db.select({ phone: s.user.phoneNumber, kind: s.user.kind }).from(s.user).where(inArray(s.user.phoneNumber, guardianPhones)) : [];
    const emails = rows.flatMap((r) => [r.email, r.guardianEmail]).filter((x): x is string => !!x);
    const usedEmails = new Set(emails.length ? (await this.db.db.select({ email: s.user.email }).from(s.user).where(inArray(s.user.email, emails))).map((u) => u.email) : []);
    const existingGuardianPhones = new Set(
      guardianPhones.length ? (await this.db.db.select({ phone: s.guardian.phone }).from(s.guardian).where(inArray(s.guardian.phone, guardianPhones))).map((g) => g.phone) : [],
    );
    const seenEmails = new Set<string>();
    const seen = new Set<string>();
    const seenAdm = new Set<string>();
    const perBatch = new Map<string, number>();
    for (const r of rows) {
      if (r.phone) {
        const dup = existingStudents.find((x) => x.phone === r.phone);
        if (dup) r.errors.push({ field: 'phone', message: `Already a student (${dup.adm ?? 'no admission no.'})`, value: r.rawPhone });
        else if (existingUsers.some((u) => u.phone === r.phone)) r.errors.push({ field: 'phone', message: 'This phone belongs to an existing account', value: r.rawPhone });
        if (seen.has(r.phone)) r.errors.push({ field: 'phone', message: 'Duplicate phone in this file', value: r.rawPhone });
        seen.add(r.phone);
      }
      if (r.email) {
        if (usedEmails.has(r.email) || seenEmails.has(r.email)) r.errors.push({ field: 'email', message: 'Email already belongs to an account', value: r.email });
        seenEmails.add(r.email);
      }
      // A guardian shared by siblings (same phone) is reused, so their email is only checked for new guardians.
      if (r.guardianEmail && r.guardianPhone && !existingGuardianPhones.has(r.guardianPhone)) {
        const firstUse = !rows.some((o) => o.row < r.row && o.guardianPhone === r.guardianPhone);
        if (firstUse && (usedEmails.has(r.guardianEmail) || seenEmails.has(r.guardianEmail))) r.errors.push({ field: 'guardian_email', message: 'Email already belongs to an account', value: r.guardianEmail });
        if (firstUse) seenEmails.add(r.guardianEmail);
      }
      if (r.guardianPhone && gUsers.some((u) => u.phone === r.guardianPhone && u.kind !== 'guardian')) r.errors.push({ field: 'guardian_phone', message: 'This phone belongs to a staff or student account', value: r.rawGuardianPhone });
      if (r.admissionNo) {
        if (existingAdm.some((x) => x.adm === r.admissionNo) || seenAdm.has(r.admissionNo)) r.errors.push({ field: 'admission_no', message: 'Admission number already used', value: r.admissionNo });
        seenAdm.add(r.admissionNo);
      }
      if (r.batchId && r.errors.length === 0) {
        const used = (perBatch.get(r.batchId) ?? 0) + 1;
        perBatch.set(r.batchId, used);
        if (used > (seats.get(r.batchId) ?? 0)) r.errors.push({ field: 'batch', message: `${r.batchCode} has no seats left`, value: r.batchCode });
      }
    }
    return { headers, missing: [...missing], rows };
  }

  async preview(fileId: string): Promise<AcadImportPreview> {
    const { headers, missing, rows } = await this.parse(fileId);
    const valid = missing.length ? 0 : rows.filter((r) => r.errors.length === 0).length;
    return {
      headers,
      missingColumns: missing,
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      rows: rows.slice(0, 100).map((r) => ({
        row: r.row,
        name: r.name,
        phone: r.rawPhone,
        batchCode: r.batchCode,
        guardian: r.guardianName,
        admissionNo: r.admissionNo ?? 'auto',
        ok: r.errors.length === 0 && missing.length === 0,
        errors: r.errors.map((e) => `${e.field}: ${e.message}`),
      })),
      errors: rows.flatMap((r) => r.errors.map((e) => ({ row: r.row, field: e.field, message: e.message, value: e.value }))),
    };
  }

  async commit(fileId: string): Promise<{ created: number; skipped: number }> {
    const { missing, rows } = await this.parse(fileId);
    if (missing.length) throw invalid(`Missing columns: ${missing.join(', ')}`);
    const valid = rows.filter((r) => r.errors.length === 0);
    if (valid.length === 0) throw invalid('No valid rows to import — fix the errors and upload again');
    const institution = await this.shared.institutionName();
    const settings = await this.shared.settings();
    void institution;
    return this.db.tx(async (tx) => {
      const c = ctx();
      const roles = await tx.select({ id: s.role.id, key: s.role.key }).from(s.role).where(inArray(s.role.key, ['student', 'parent']));
      const studentRole = roles.find((r) => r.key === 'student')!.id;
      const parentRole = roles.find((r) => r.key === 'parent')!.id;
      const institutionId = c.institutionId;
      const branchCodes = new Map((await tx.select({ id: s.branch.id, code: s.branch.code }).from(s.branch)).map((b) => [b.id, b.code]));
      const admYear = String(Number(financialYear(todayIST()).slice(0, 4)) + 1);
      const now = new Date();
      let created = 0;
      const byBranch = new Map<string, number>();
      for (const r of valid) {
        const branchId = r.branchId!;
        const [batch] = await tx.select().from(s.batch).where(eq(s.batch.id, r.batchId!));
        const plan = batch!.feePlanId ? (await tx.select({ name: s.feePlan.name }).from(s.feePlan).where(eq(s.feePlan.id, batch!.feePlanId)))[0] : undefined;
        const admissionNo =
          r.admissionNo ??
          formatNumber(settings.admissionNumberPattern || DEFAULT_PATTERNS.admission, {
            BRANCH: branchCodes.get(branchId)!,
            COURSE: r.courseCode!,
            YEAR: admYear,
            SEQ: await this.numbering.next(tx, branchId, 'admission', admYear),
          });
        const [u] = await tx
          .insert(s.user)
          .values({
            name: r.name,
            email: r.email ?? `student-${crypto.randomUUID()}@import.invalid`,
            phoneNumber: r.phone,
            kind: 'student',
            status: 'invited',
            invitedAt: now,
          })
          .returning({ id: s.user.id });
        const [st] = await tx
          .insert(s.student)
          .values({
            institutionId,
            branchId,
            userId: u!.id,
            admissionNo,
            name: r.name,
            phone: r.phone,
            email: r.email,
            dob: r.dob,
            cardToken: crypto.randomBytes(18).toString('base64url'),
            cardIssuedAt: now,
          })
          .returning({ id: s.student.id });
        const guardian = await this.guardianFor(tx, r, branchId, parentRole);
        await tx.insert(s.studentGuardian).values({ studentId: st!.id, guardianId: guardian, relationship: r.relationship, isPrimary: true });
        await tx.insert(s.enrollment).values({
          studentId: st!.id,
          batchId: r.batchId!,
          branchId,
          status: 'active',
          joinedOn: r.joinedOn ?? batch!.startDate,
          feePlanId: batch!.feePlanId,
          feePlanName: plan?.name ?? null,
          feeTotal: 0,
          feeCleared: true,
          clearanceReason: 'Go-live import · fee account not set up yet',
        });
        await tx.insert(s.membership).values({ userId: u!.id, roleId: studentRole, branchIds: [branchId], scopeLabel: batch!.code, isDefault: true, createdBy: c.userId });
        byBranch.set(branchId, (byBranch.get(branchId) ?? 0) + 1);
        created++;
      }
      for (const [branchId, n] of byBranch) {
        await this.audit.log(tx, {
          action: 'Students imported',
          kind: 'create',
          entityType: 'import',
          entityId: fileId,
          entityLabel: 'go-live students',
          after: { created: n, skipped: rows.length - valid.length },
          summary: `Go-live import · ${n} students with guardians, invited portal accounts and enrollments · ${rows.length - valid.length} rows skipped`,
          branchId,
        });
        this.notify.invalidate(tx, branchId, [['academics'], ['reference']]);
      }
      return { created, skipped: rows.length - valid.length };
    });
  }

  /** Reuse a guardian (and their parent membership) when siblings share a phone. */
  private async guardianFor(tx: Tx, r: ParsedRow, branchId: string, parentRole: string): Promise<string> {
    const [existing] = await tx.select({ id: s.guardian.id, userId: s.guardian.userId }).from(s.guardian).where(eq(s.guardian.phone, r.guardianPhone!)).limit(1);
    if (existing) {
      if (existing.userId) {
        const [m] = await tx.select().from(s.membership).where(and(eq(s.membership.userId, existing.userId), eq(s.membership.roleId, parentRole)));
        if (m) {
          const kids = Number(/^(\d+)/.exec(m.scopeLabel ?? '1')?.[1] ?? 1) + 1;
          await tx.update(s.membership).set({ branchIds: [...new Set([...m.branchIds, branchId])], scopeLabel: `${kids} children` }).where(eq(s.membership.id, m.id));
        } else {
          await tx.insert(s.membership).values({ userId: existing.userId, roleId: parentRole, branchIds: [branchId], scopeLabel: '1 child', isDefault: true });
        }
      }
      return existing.id;
    }
    const [gu] = await tx
      .insert(s.user)
      .values({ name: r.guardianName, email: r.guardianEmail ?? `guardian-${crypto.randomUUID()}@import.invalid`, phoneNumber: r.guardianPhone, kind: 'guardian', status: 'invited', invitedAt: new Date() })
      .returning({ id: s.user.id });
    const [g] = await tx.insert(s.guardian).values({ userId: gu!.id, name: r.guardianName, phone: r.guardianPhone, email: r.guardianEmail }).returning({ id: s.guardian.id });
    await tx.insert(s.membership).values({ userId: gu!.id, roleId: parentRole, branchIds: [branchId], scopeLabel: '1 child', isDefault: true });
    return g!.id;
  }
}
