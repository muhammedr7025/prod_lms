import crypto from 'node:crypto';
import fs from 'node:fs';
import { computeClearance, financialYear, formatNumber, istDateTime, rupees, todayIST, DEFAULT_PATTERNS, type ClearancePolicy } from '@exatech/domain';
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { assertNotLive } from '../live-guard';
import * as s from '../schema';
import { uuidv7 } from '../schema/_helpers';
import type { InstitutionSettings } from '../schema/org';
import { TEMPLATES } from '../seed/data';
import { DEFAULT_SETTINGS, flushApiCaches } from '../seed/index';
import { DEFAULT_ROLE_PERMISSIONS_SEED, ROLE_META_SEED } from '../seed/roles';

/**
 * Onboard a real institute from onboarding.json (built from the data-review
 * workbook). Replaces everything in the target database, then marks it live
 * so the demo seed, e2e reseed and db:reset refuse to wipe it.
 *
 *   DATABASE_URL=postgres://localhost:5432/exatech_live node dist/onboard/index.js ~/Documents/exatech-private/onboarding.json
 *
 * Re-running against a live database needs EXATECH_WIPE_LIVE=<db name> (it starts from scratch again).
 */

interface Data {
  institute: { name: string; legalName: string | null; gstin: string | null; address: string; phone: string; email: string; website: string | null };
  branches: { code: string; name: string; address: string; phone: string | null; email: string | null }[];
  staff: { name: string; role: string; branch: string | null; phone: string | null; email: string | null }[];
  courses: { code: string; name: string; body: string | null; eligibility: string | null; months: number; note: string | null; fee: number; regFee: number }[];
  batches: { code: string; course: string; branch: string; start: string; end: string; days: string | null; time: string | null; trainer: string | null }[];
  students: {
    admissionNo: string; name: string; mobile: string | null; email: string | null; dob: string | null;
    parentName: string | null; parentMobile: string | null; branch: string; batch: string; course: string;
    body: string | null; bodyRegNo: string | null; bodyFee: number | null; bodyFeeSubmittedOn: string | null;
    joinedOn: string; fee: number; net: number; paid: number; payDate: string | null; payMode: 'cash' | 'transfer';
    regFee: number | null; regFeeDate: string | null;
  }[];
  settings: { gst: boolean; lateFee: { graceDays: number; perDay: number; capPct: number; capAmount: number }; lockMaterialWhenOverdue: boolean };
  provisional: { ref: string; who: string; what: string }[];
}

const id = () => uuidv7();
const token = () => crypto.randomBytes(18).toString('base64url');
const NO_EMAIL = 'no-email.invalid'; // RFC 2606: never routes. Students without email sign in by mobile OTP.
const e164 = (m: string | null) => (m ? `+91${m}` : null);

export async function onboard(file: string, url = process.env.DATABASE_URL): Promise<void> {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Data;
  const h = createDb(url, { max: 4 });
  const db = h.db;
  const dbName = new URL(url ?? 'postgres://localhost/exatech').pathname.slice(1);
  const today = todayIST();
  const SAC = '999293';
  try {
    await assertNotLive(h.sql, dbName);
    const tables = await h.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%'`;
    await h.sql.unsafe(`truncate table ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`);

    /* ── institution ── */
    const fy = financialYear(today);
    const settings: InstitutionSettings = {
      ...DEFAULT_SETTINGS,
      live: true,
      // Study material locks when an instalment is overdue (the institute answered yes).
      clearancePolicy: { kind: 'current_instalment' },
      finance: { ...DEFAULT_SETTINGS.finance, gstRate: data.settings.gst ? 18 : 0, lateFee: data.settings.lateFee },
    };
    const institutionId = id();
    await db.insert(s.institution).values({
      id: institutionId,
      name: data.institute.name,
      legalName: data.institute.legalName ?? data.institute.name,
      gstin: data.institute.gstin,
      address: data.institute.address,
      phone: data.institute.phone,
      email: data.institute.email,
      brandColor: '#4f9d68',
      academicYearLabel: fy,
      academicYearStart: `${fy.slice(0, 4)}-06-01`,
      settings,
    });

    /* ── roles ── */
    const roleIds: Record<string, string> = {};
    for (const [key, m] of Object.entries(ROLE_META_SEED)) {
      roleIds[key] = id();
      await db.insert(s.role).values({
        id: roleIds[key], institutionId, key, name: m.label, description: m.description, scopeKind: m.scopeKind, surface: m.surface, isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS_SEED[key as keyof typeof DEFAULT_ROLE_PERMISSIONS_SEED], position: m.position,
      });
    }

    /* ── branches ── */
    const branchIds: Record<string, string> = {};
    for (const b of data.branches) {
      branchIds[b.code] = id();
      await db.insert(s.branch).values({
        id: branchIds[b.code], institutionId, code: b.code, name: b.name, address: b.address, city: b.name, phone: b.phone, email: b.email,
        gstin: data.institute.gstin, gstinNote: data.institute.gstin ? null : 'Not registered for GST', status: 'active',
      });
    }

    /* ── staff ── */
    const usedEmails = new Set<string>();
    const usedPhones = new Set<string>();
    const staffIds: Record<string, string> = {};
    let empNo = 0;
    for (const st of data.staff) {
      const uid = id();
      staffIds[st.name] = uid;
      const email = st.email ?? `${st.name.toLowerCase().replace(/[^a-z]+/g, '.')}@${NO_EMAIL}`;
      usedEmails.add(email);
      if (st.phone) usedPhones.add(e164(st.phone)!);
      await db.insert(s.user).values({ id: uid, name: st.name, email, emailVerified: !!st.email, phoneNumber: e164(st.phone), phoneNumberVerified: false, kind: 'staff', status: 'invited', invitedAt: new Date() });
      await db.insert(s.staffProfile).values({ userId: uid, homeBranchId: st.branch ? branchIds[st.branch] : null, title: ROLE_META_SEED[st.role as keyof typeof ROLE_META_SEED].label, employeeCode: `EX-${String(++empNo).padStart(3, '0')}`, status: 'active' });
      const branches = st.role === 'superadmin' ? [] : st.role === 'finance' ? Object.values(branchIds) : st.branch ? [branchIds[st.branch]!] : [];
      await db.insert(s.membership).values({
        userId: uid, roleId: roleIds[st.role]!, branchIds: branches, isDefault: true,
        scopeLabel: st.role === 'superadmin' ? 'Institution' : branches.length > 1 ? data.branches.map((b) => b.code).join(' · ') : (data.branches.find((b) => branchIds[b.code] === branches[0])?.name ?? ''),
      });
    }
    const owner = data.staff.find((x) => x.role === 'superadmin');
    const finance = data.staff.find((x) => x.role === 'finance') ?? owner;
    for (const b of data.branches) await db.update(s.branch).set({ managerUserId: owner ? staffIds[owner.name] : null }).where(sql`id = ${branchIds[b.code]!}`);

    /* ── courses, fee plans, offerings ── */
    const courseByName: Record<string, { id: string; code: string; planId: string; fee: number; regFee: number; policy: ClearancePolicy }> = {};
    const offeringIds: Record<string, string> = {};
    for (const c of data.courses) {
      const cid = id();
      const planId = id();
      const policy = settings.clearancePolicy;
      await db.insert(s.course).values({
        id: cid, institutionId, code: c.code, name: c.name, category: c.body ?? null, durationMonths: c.months, modality: 'offline',
        description: c.note, awardingBody: c.body, eligibility: c.eligibility, clearancePolicy: policy,
      });
      await db.insert(s.feePlan).values({
        id: planId, institutionId, courseId: cid, branchId: null, name: 'Standard', kind: 'custom',
        components: [{ name: 'Course fee', amount: rupees(c.fee) }, { name: 'Registration fee', amount: rupees(c.regFee) }],
        schedule: [{ label: 'Registration fee', pct: 0, dueOffsetDays: 0 }, { label: 'Course fee', pct: 100, dueOffsetDays: 0 }],
        gstRate: settings.finance.gstRate, isDefault: true,
      });
      courseByName[c.name] = { id: cid, code: c.code, planId, fee: c.fee, regFee: c.regFee, policy };
      for (const b of data.branches) {
        const oid = id();
        offeringIds[`${b.code}:${c.name}`] = oid;
        await db.insert(s.courseOffering).values({ id: oid, courseId: cid, branchId: branchIds[b.code]!, defaultFeePlanId: planId });
      }
    }

    /* ── batches (no timetable yet: real timings still to come) ── */
    const batchByCode: Record<string, { id: string; branchId: string; end: string; course: string }> = {};
    const count: Record<string, number> = {};
    for (const st of data.students) count[st.batch] = (count[st.batch] ?? 0) + 1;
    for (const b of data.batches) {
      const course = courseByName[b.course];
      if (!course) throw new Error(`Batch ${b.code}: unknown course ${b.course}`);
      const bid = id();
      batchByCode[b.code] = { id: bid, branchId: branchIds[b.branch]!, end: b.end, course: b.course };
      await db.insert(s.batch).values({
        id: bid, branchId: branchIds[b.branch]!, courseId: course.id, offeringId: offeringIds[`${b.branch}:${b.course}`], code: b.code, name: `${b.course} · ${b.code}`,
        startDate: b.start, endDate: b.end, capacity: Math.max(30, count[b.code] ?? 0), scheduleLabel: [b.days, b.time].filter(Boolean).join(' · ') || null,
        feePlanId: course.planId, mode: 'offline', status: b.start <= today && today <= b.end ? 'running' : b.start > today ? 'planned' : 'completed',
      });
      const trainer = b.trainer ? staffIds[b.trainer] : undefined;
      if (trainer) await db.insert(s.teacherAssignment).values({ batchId: bid, teacherUserId: trainer, subjectName: b.course, isPrimary: true });
    }

    /* ── students, guardians, enrollments, fees ── */
    interface FinEvent { date: string; branch: string; kind: 'invoice' | 'receipt'; apply: (number: string, seq: number, fy: string) => Promise<void> }
    const events: FinEvent[] = [];
    const guardianByPhone: Record<string, { userId: string; guardianId: string; branches: Set<string>; kids: number }> = {};
    const studentMemberships: (typeof s.membership.$inferInsert)[] = [];

    for (const st of data.students) {
      const batch = batchByCode[st.batch];
      if (!batch) throw new Error(`${st.admissionNo}: unknown batch ${st.batch}`);
      if (batch.course !== st.course) throw new Error(`${st.admissionNo}: batch ${st.batch} is ${batch.course}, student course is ${st.course}`);
      const course = courseByName[st.course]!;
      const branchId = branchIds[st.branch]!;
      const sid = id();
      const uid = id();
      let email = st.email ?? `${st.admissionNo.toLowerCase()}@${NO_EMAIL}`;
      if (usedEmails.has(email)) email = `${st.admissionNo.toLowerCase()}@${NO_EMAIL}`;
      usedEmails.add(email);
      const phone = e164(st.mobile);
      const phoneFree = phone && !usedPhones.has(phone);
      if (phone) usedPhones.add(phone);
      await db.insert(s.user).values({ id: uid, name: st.name, email, emailVerified: false, phoneNumber: phoneFree ? phone : null, kind: 'student', status: 'invited', invitedAt: new Date() });
      await db.insert(s.student).values({
        id: sid, institutionId, branchId, userId: uid, admissionNo: st.admissionNo, name: st.name, phone, email: st.email, dob: st.dob,
        cardToken: token(), cardIssuedAt: istDateTime(st.joinedOn),
      });
      studentMemberships.push({ userId: uid, roleId: roleIds.student!, branchIds: [branchId], scopeLabel: st.batch, isDefault: true });

      if (st.parentName) {
        const pphone = e164(st.parentMobile);
        let g = pphone ? guardianByPhone[pphone] : undefined;
        if (!g) {
          const guardianId = id();
          let guardianUserId: string | null = null;
          if (pphone && !usedPhones.has(pphone)) {
            guardianUserId = id();
            usedPhones.add(pphone);
            await db.insert(s.user).values({ id: guardianUserId, name: st.parentName, email: `parent.${st.admissionNo.toLowerCase()}@${NO_EMAIL}`, phoneNumber: pphone, kind: 'guardian', status: 'invited', invitedAt: new Date() });
          }
          await db.insert(s.guardian).values({ id: guardianId, userId: guardianUserId, name: st.parentName, phone: pphone });
          g = { userId: guardianUserId ?? '', guardianId, branches: new Set(), kids: 0 };
          if (pphone) guardianByPhone[pphone] = g;
          if (guardianUserId) g.userId = guardianUserId;
          else if (!pphone) guardianByPhone[`none:${guardianId}`] = g;
        }
        g.branches.add(branchId);
        g.kids++;
        await db.insert(s.studentGuardian).values({ studentId: sid, guardianId: g.guardianId, relationship: 'Parent / guardian', isPrimary: true });
      }

      // Fee account: registration fee + course fee (after discount). Paid so far, then the balance on the batch end date.
      const reg = rupees(st.regFee ?? 0);
      const net = rupees(st.net);
      const paid = rupees(st.paid);
      const balance = net - paid;
      const discountPct = st.fee > 0 ? Math.round((1 - st.net / st.fee) * 10000) / 100 : 0;
      const enrollmentId = id();
      await db.insert(s.enrollment).values({
        id: enrollmentId, studentId: sid, batchId: batch.id, branchId, status: 'active', joinedOn: st.joinedOn,
        feePlanId: course.planId, feePlanName: 'Standard', feeTotal: net + reg, discountPct,
        awardingBody: st.body, bodyRegNo: st.bodyRegNo, bodyFee: st.bodyFee != null ? rupees(st.bodyFee) : null, bodyFeeSubmittedOn: st.bodyFeeSubmittedOn,
      });
      const insts: { id: string; seq: number; label: string; dueDate: string; amount: number; paid: number; payDate: string | null; mode: 'cash' | 'transfer' }[] = [];
      if (reg > 0) insts.push({ id: id(), seq: 0, label: 'Registration fee', dueDate: st.regFeeDate ?? st.joinedOn, amount: reg, paid: reg, payDate: st.regFeeDate ?? st.joinedOn, mode: 'cash' });
      if (paid > 0) insts.push({ id: id(), seq: 0, label: 'Course fee · paid at admission', dueDate: st.payDate ?? st.joinedOn, amount: paid, paid, payDate: st.payDate ?? st.joinedOn, mode: st.payMode });
      if (balance > 0) insts.push({ id: id(), seq: 0, label: 'Course fee · balance', dueDate: batch.end, amount: balance, paid: 0, payDate: null, mode: st.payMode });
      insts.forEach((x, i) => (x.seq = i + 1));
      for (const x of insts) {
        await db.insert(s.instalment).values({
          id: x.id, enrollmentId, branchId, seq: x.seq, label: x.label, dueDate: x.dueDate, amount: x.amount, paid: x.paid,
          status: x.paid >= x.amount ? 'paid' : x.paid > 0 ? 'partially_paid' : 'due',
        });
        if (x.paid <= 0) continue; // invoices for the balance are issued by the platform closer to the due date
        const invId = id();
        const pid = id();
        const day = x.payDate!;
        const receivedAt = istDateTime(day, '11:00');
        events.push({
          date: `${day}a`, branch: st.branch, kind: 'invoice',
          apply: async (number, seq, docFy) => {
            await db.insert(s.invoice).values({
              id: invId, branchId, enrollmentId, studentId: sid, instalmentId: x.id, number, fy: docFy, seq, issueDate: day, dueDate: x.dueDate,
              lines: [{ description: `${st.course} · ${x.label}`, sac: SAC, amount: x.amount, taxRate: 0, tax: 0 }],
              subtotal: x.amount, tax: 0, total: x.amount, paid: x.amount, status: 'paid', createdBy: finance ? staffIds[finance.name] : null, createdAt: istDateTime(day, '10:00'),
            });
            await db.insert(s.ledgerEntry).values({ enrollmentId, branchId, at: istDateTime(day, '10:00'), kind: 'charge', description: `Invoice · ${x.label}`, reference: number, debit: x.amount, invoiceId: invId });
          },
        });
        events.push({
          date: `${day}b`, branch: st.branch, kind: 'receipt',
          apply: async (number, seq, docFy) => {
            await db.insert(s.payment).values({ id: pid, branchId, enrollmentId, studentId: sid, receivedAt, total: x.paid, status: 'cleared', channel: 'desk', receivedBy: finance ? staffIds[finance.name] : null, idempotencyKey: `onboard-${pid}`, notes: 'Imported from the institute’s records' });
            await db.insert(s.paymentTender).values({ paymentId: pid, method: x.mode, amount: x.paid, reference: null });
            await db.insert(s.paymentAllocation).values({ paymentId: pid, instalmentId: x.id, invoiceId: invId, amount: x.paid });
            await db.insert(s.receipt).values({ branchId, paymentId: pid, number, fy: docFy, seq, issuedAt: receivedAt, verifyToken: token() });
            await db.insert(s.ledgerEntry).values({ enrollmentId, branchId, at: receivedAt, kind: 'payment', description: `Payment · ${x.mode === 'cash' ? 'Cash' : 'Bank transfer'}`, reference: number, credit: x.paid, paymentId: pid });
          },
        });
      }
      // The balance is not due yet, so no balance invoice; the charge still shows on the ledger.
      if (balance > 0) {
        await db.insert(s.ledgerEntry).values({ enrollmentId, branchId, at: istDateTime(st.joinedOn, '09:00'), kind: 'charge', description: 'Course fee · balance (imported)', reference: null, debit: balance });
      }
      const clr = computeClearance({ instalments: insts.map((x) => ({ dueDate: x.dueDate, amount: x.amount, paid: x.paid })), policy: course.policy, today });
      await db.update(s.enrollment).set({ feeCleared: clr.cleared, clearedUntil: clr.clearedUntil, clearanceReason: clr.reason }).where(sql`id = ${enrollmentId}`);
    }
    for (let i = 0; i < studentMemberships.length; i += 200) await db.insert(s.membership).values(studentMemberships.slice(i, i + 200));
    for (const g of Object.values(guardianByPhone)) {
      if (!g.userId) continue;
      await db.insert(s.membership).values({ userId: g.userId, roleId: roleIds.parent!, branchIds: [...g.branches], scopeLabel: g.kids === 1 ? '1 child' : `${g.kids} children`, isDefault: true });
    }

    /* ── gap-free numbers per branch per financial year, in date order ── */
    const counters: Record<string, number> = {};
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));
    for (const ev of events) {
      const docFy = financialYear(ev.date.slice(0, 10));
      const key = `${ev.branch}:${ev.kind}:${docFy}`;
      counters[key] = (counters[key] ?? 0) + 1;
      await ev.apply(formatNumber(DEFAULT_PATTERNS[ev.kind], { BRANCH: ev.branch, FY: docFy, SEQ: counters[key]! }), counters[key]!, docFy);
    }
    for (const [key, n] of Object.entries(counters)) {
      const [code, docType, period] = key.split(':') as [string, string, string];
      await db.insert(s.docSequence).values({ scopeId: branchIds[code]!, docType, period, nextSeq: n + 1 });
    }
    for (const b of data.branches) {
      for (const docType of ['invoice', 'receipt', 'credit_note']) {
        if (!counters[`${b.code}:${docType}:${fy}`]) await db.insert(s.docSequence).values({ scopeId: branchIds[b.code]!, docType, period: fy, nextSeq: 1 }).onConflictDoNothing();
      }
    }

    await db.insert(s.messageTemplate).values(TEMPLATES.map((t) => ({ ...t, variables: [...t.variables] })));
    await flushApiCaches();

    const [tot] = await h.sql<{ n: string; fee: string; paid: string; due: string }[]>`
      select count(*)::text n, sum(fee_total)::text fee,
        (select sum(paid) from instalment)::text paid, (select sum(amount - paid) from instalment)::text due from enrollment`;
    const rs = (p: string | undefined) => `₹${(Number(p ?? 0) / 100).toLocaleString('en-IN')}`;
    console.log(`✓ onboarded ${data.institute.name} into ${dbName}`);
    console.log(`  ${data.branches.length} branches · ${data.staff.length} staff · ${data.courses.length} courses · ${data.batches.length} batches · ${tot?.n} students`);
    console.log(`  billed ${rs(tot?.fee)} (incl. registration fees) · collected ${rs(tot?.paid)} · outstanding ${rs(tot?.due)}`);
    console.log(`  ${data.provisional.length} provisional decisions to confirm with the institute`);
  } finally {
    await h.sql.end();
  }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node dist/onboard/index.js <onboarding.json>');
    process.exit(2);
  }
  onboard(file)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
