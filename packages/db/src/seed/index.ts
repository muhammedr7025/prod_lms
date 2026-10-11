import crypto from 'node:crypto';
import {
  addDays,
  attendancePercent,
  buildSchedule,
  computeClearance,
  financialYear,
  formatNumber,
  istDateTime,
  leadScore,
  monthStart,
  quoteFee,
  rupees,
  todayIST,
  weekday,
  DEFAULT_PATTERNS,
  type AttendanceStatus,
  type ClearancePolicy,
  type LeadStage,
} from '@exatech/domain';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createDb, type Database } from '../client';
import * as s from '../schema';
import { uuidv7 } from '../schema/_helpers';
import type { InstitutionSettings } from '../schema/org';
import { BATCHES, BRANCHES, CAMPAIGNS, COURSES, DMA_NAMES, FEE_PLANS, FIRST_NAMES, HOLIDAYS_2026_27, INSTITUTION, LAST_NAMES, LEAD_SOURCES, STAFF, TEMPLATES } from './data';
import { rng } from './rng';

/* Role defaults are duplicated here (not imported from contracts) to keep the db package free of zod. */
import { DEFAULT_ROLE_PERMISSIONS_SEED, ROLE_META_SEED } from './roles';

const R = rng(20261011);
const id = () => uuidv7();
const token = () => crypto.randomBytes(18).toString('base64url');

async function insertMany<T extends PgTable>(db: Database, table: T, rows: T['$inferInsert'][], chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table).values(rows.slice(i, i + chunk) as any);
  }
}

export const DEFAULT_SETTINGS: InstitutionSettings = {
  clearancePolicy: { kind: 'current_instalment' },
  discountThresholds: { financePct: 10, superAdminPct: 20 },
  admissionNumberPattern: DEFAULT_PATTERNS.admission,
  security: { require2faRoles: ['superadmin', 'finance'], staffSessionHours: 12, staffIdleMinutes: 30, portalSessionDays: 7, impersonationMinutes: 15 },
  leadRetentionMonths: 24,
  attendanceEditWindowHours: 48,
  lowAttendanceThreshold: 75,
  travelBufferMinutes: 45,
  finance: {
    numbering: { invoice: DEFAULT_PATTERNS.invoice, receipt: DEFAULT_PATTERNS.receipt, credit_note: DEFAULT_PATTERNS.credit_note },
    gstRate: 18,
    sac: '999293',
    lateFee: { graceDays: 3, perDay: rupees(100), capPct: 5 },
    minPartial: rupees(1000),
    restructureApprovalAbove: rupees(10000),
    allocationOrder: 'oldest_first',
    methods: { upi: true, cash: true, card: true, cheque: true, transfer: true, online: true },
    chequeUnlocksAfterClearance: true,
    reminderDaysBefore: [3],
    reminderDaysAfter: [1, 4, 8],
  },
};

export async function seed(url = process.env.DATABASE_URL, anchorArg?: string) {
  const anchor = anchorArg ?? process.env.SEED_ANCHOR ?? todayIST();
  const h = createDb(url, { max: 4 });
  const db = h.db;
  const now = new Date();
  const fy = financialYear(anchor);
  const admYear = Number(fy.slice(0, 4)) + 1; // "2027" for AY 2026-27

  try {
    /* ── wipe ── */
    const tables = await h.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%'`;
    await h.sql.unsafe(`truncate table ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`);

    /* ── institution ── */
    const institutionId = id();
    await db.insert(s.institution).values({
      id: institutionId,
      ...INSTITUTION,
      academicYearLabel: fy,
      academicYearStart: `${fy.slice(0, 4)}-06-01`,
      settings: DEFAULT_SETTINGS,
    });

    /* ── roles ── */
    const roleIds: Record<string, string> = {};
    await insertMany(
      db,
      s.role,
      Object.entries(ROLE_META_SEED).map(([key, m]) => {
        roleIds[key] = id();
        return {
          id: roleIds[key],
          institutionId,
          key,
          name: m.label,
          description: m.description,
          scopeKind: m.scopeKind,
          surface: m.surface,
          isSystem: true,
          permissions: DEFAULT_ROLE_PERMISSIONS_SEED[key as keyof typeof DEFAULT_ROLE_PERMISSIONS_SEED],
          position: m.position,
        };
      }),
    );

    /* ── branches, rooms, holidays ── */
    const branchIds: Record<string, string> = {};
    const roomIds: Record<string, string> = {};
    const roomCap: Record<string, number> = {};
    for (const b of BRANCHES) {
      branchIds[b.code] = id();
      await db.insert(s.branch).values({
        id: branchIds[b.code],
        institutionId,
        code: b.code,
        name: b.name,
        address: b.address,
        city: b.city,
        phone: b.phone,
        email: `${b.code.toLowerCase()}@exatech.test`,
        gstin: b.gstin,
        gstinNote: b.gstinNote,
        openedOn: b.opened,
        status: b.status,
        statusNote: b.statusNote,
        monthlyTarget: rupees(b.target),
      });
      for (const [name, cap, kind] of b.rooms) {
        roomIds[name] = id();
        roomCap[name] = cap;
        await db.insert(s.room).values({ id: roomIds[name], branchId: branchIds[b.code]!, name, capacity: cap, kind });
      }
    }
    await insertMany(db, s.holiday, HOLIDAYS_2026_27.map(([date, name]) => ({ institutionId, branchId: null, date, name })));
    const holidayDates = new Set(HOLIDAYS_2026_27.map(([d]) => d));

    /* ── staff ── */
    const userIds: Record<string, string> = {};
    const userNames: Record<string, string> = {};
    for (const st of STAFF) {
      userIds[st.key] = id();
      userNames[st.key] = st.name;
      await db.insert(s.user).values({
        id: userIds[st.key],
        name: st.name,
        email: st.email,
        emailVerified: true,
        phoneNumber: st.phone,
        phoneNumberVerified: true,
        kind: 'staff',
        status: 'active',
        invitedAt: addDaysDate(now, -200),
        lastLoginAt: addDaysDate(now, -1),
      });
      await db.insert(s.staffProfile).values({
        userId: userIds[st.key]!,
        homeBranchId: branchIds[st.home],
        title: st.title,
        employeeCode: `EX-${String(Object.keys(userIds).length).padStart(3, '0')}`,
        status: st.status ?? 'active',
        onSiteDays: st.key === 'anitha' ? { [branchIds.TVM!]: [3, 6], [branchIds.CLT!]: [1, 2, 4, 5] } : {},
        joinedOn: '2021-06-01',
      });
      for (const m of st.memberships) {
        await db.insert(s.membership).values({
          userId: userIds[st.key]!,
          roleId: roleIds[m.role]!,
          branchIds: m.branches.map((c) => branchIds[c]!),
          scopeLabel: m.scope,
          isDefault: !!m.isDefault,
        });
      }
    }
    await db.update(s.branch).set({ managerUserId: userIds.priya }).where(sql`code = 'TVM'`);
    await db.update(s.branch).set({ managerUserId: userIds.joseph }).where(sql`code = 'EKM'`);
    await db.update(s.branch).set({ managerUserId: userIds.anitha }).where(sql`code = 'CLT'`);

    /* ── courses, subjects, fee plans, offerings ── */
    const courseIds: Record<string, string> = {};
    const subjectIds: Record<string, string> = {};
    const planIds: Record<string, string> = {}; // `${course}:${name}`
    const planDefs: Record<string, (typeof FEE_PLANS)[string][number]> = {};
    for (const c of COURSES) {
      courseIds[c.code] = id();
      await db.insert(s.course).values({
        id: courseIds[c.code],
        institutionId,
        code: c.code,
        name: c.name,
        category: c.category,
        durationMonths: c.months,
        modality: c.modality,
        clearancePolicy: c.policy,
      });
      await insertMany(
        db,
        s.courseSubject,
        c.subjects.map((name, i) => {
          subjectIds[`${c.code}:${name}`] = id();
          return { id: subjectIds[`${c.code}:${name}`], courseId: courseIds[c.code]!, name, position: i };
        }),
      );
      for (const p of FEE_PLANS[c.code]!) {
        const pid = id();
        planIds[`${c.code}:${p.name}`] = pid;
        planDefs[pid] = p;
        await db.insert(s.feePlan).values({
          id: pid,
          institutionId,
          courseId: courseIds[c.code]!,
          branchId: null,
          name: p.name,
          kind: p.kind,
          components: p.components.map(([name, amt]) => ({ name, amount: rupees(amt) })),
          schedule: p.schedule.map(([label, pct, dueOffsetDays]) => ({ label, pct, dueOffsetDays })),
          gstRate: 18,
          earlyPayDiscountPct: p.earlyPay ?? 0,
          isDefault: !!p.isDefault,
        });
      }
    }
    const offeringIds: Record<string, string> = {};
    for (const b of BRANCHES) {
      for (const c of COURSES) {
        if (b.code === 'CLT' && c.code !== 'DA' && c.code !== 'DM') continue;
        const oid = id();
        offeringIds[`${b.code}:${c.code}`] = oid;
        const def = FEE_PLANS[c.code]!.find((p) => p.isDefault)!;
        await db.insert(s.courseOffering).values({ id: oid, courseId: courseIds[c.code]!, branchId: branchIds[b.code]!, defaultFeePlanId: planIds[`${c.code}:${def.name}`] });
      }
    }

    /* ── batches & teacher assignments ── */
    // "today"-relative slots keep the teacher persona busy on the seed date
    // (weekend batches run on Sundays, so a Sunday anchor gets a Sunday slot).
    const anchorWd = weekday(anchor);
    const wdOf = (spec: string): number => {
      const map: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      if (spec in map) return map[spec]!;
      const plus = spec === 'today' ? 0 : Number(spec.replace('today+', ''));
      return (anchorWd + plus) % 7;
    };
    interface BatchInfo {
      id: string;
      code: string;
      branch: string;
      branchId: string;
      course: string;
      courseId: string;
      start: string;
      end: string;
      capacity: number;
      teacher: string;
      subject: string;
      roomId: string;
      planId: string;
      slots: { wd: number; time: string }[];
      status: string;
      mode: 'offline' | 'online' | 'hybrid';
    }
    const batches: BatchInfo[] = [];
    for (const b of BATCHES) {
      const course = COURSES.find((c) => c.code === b.course)!;
      const start = b.code === 'DM-A' ? addDays(anchor, -62) : addDays(anchor, b.startOffset);
      const info: BatchInfo = {
        id: id(),
        code: b.code,
        branch: b.branch,
        branchId: branchIds[b.branch]!,
        course: b.course,
        courseId: courseIds[b.course]!,
        start,
        end: addDays(start, course.months * 30),
        capacity: b.capacity,
        teacher: b.teacher,
        subject: b.subject,
        roomId: roomIds[b.room]!,
        planId: planIds[`${b.course}:${b.plan}`]!,
        slots: b.slots.map(([d, t]) => ({ wd: wdOf(d), time: t })),
        status: b.status,
        mode: b.mode,
      };
      batches.push(info);
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const uniqueTimes = [...new Set(info.slots.map((x) => x.time))];
      const label = uniqueTimes
        .map((t) => `${[...new Set(info.slots.filter((x) => x.time === t).map((x) => x.wd))].sort().map((d) => days[d]).join('/')} ${t}`)
        .join(' · ');
      await db.insert(s.batch).values({
        id: info.id,
        branchId: info.branchId,
        courseId: info.courseId,
        offeringId: offeringIds[`${b.branch}:${b.course}`],
        code: b.code,
        name: `${course.name} · ${b.code}`,
        startDate: start,
        endDate: info.end,
        capacity: b.capacity,
        scheduleLabel: label,
        roomId: info.roomId,
        feePlanId: info.planId,
        mode: b.mode,
        meetLink: b.mode !== 'offline' ? `https://meet.google.com/exa-${b.code.toLowerCase()}` : null,
        status: b.status,
      });
      await db.insert(s.teacherAssignment).values({
        batchId: info.id,
        teacherUserId: userIds[b.teacher]!,
        subjectId: subjectIds[`${b.course}:${b.subject}`],
        subjectName: b.subject,
        isPrimary: true,
      });
    }
    const batchByCode = Object.fromEntries(batches.map((b) => [b.code, b]));

    /* ── students, guardians, enrollments ── */
    interface StudentInfo {
      id: string;
      userId: string;
      name: string;
      batch: BatchInfo;
      enrollmentId: string;
      admissionNo: string;
      joinedOn: string;
      profile: 'current' | 'partial' | 'overdue';
      guardianUserId: string;
      guardianName: string;
    }
    const students: StudentInfo[] = [];
    const seqStart: Record<string, number> = { TVM: 75, EKM: 40, CLT: 1 };
    const order = ['FS-B', 'DA-C', 'UX-A', 'DM-A', 'DM-B', 'DM-K1', 'FS-K2', 'DA-C1'];
    const usedNames = new Set<string>();
    const sureshUserId = id();
    const sureshGuardianId = id();
    await db.insert(s.user).values({
      id: sureshUserId,
      name: 'Suresh Menon',
      email: 'suresh.menon@example.test',
      emailVerified: true,
      phoneNumber: '+919847000210',
      phoneNumberVerified: true,
      kind: 'guardian',
      status: 'active',
      invitedAt: addDaysDate(now, -100),
    });
    await db.insert(s.guardian).values({ id: sureshGuardianId, userId: sureshUserId, name: 'Suresh Menon', phone: '+919847000210', email: 'suresh.menon@example.test' });

    let phoneCounter = 9400000000;
    for (const code of order) {
      const b = batchByCode[code]!;
      const count = BATCHES.find((x) => x.code === code)!.students;
      for (let i = 0; i < count; i++) {
        let name: string;
        if (code === 'DM-A' && i < DMA_NAMES.length) name = DMA_NAMES[i]!;
        else if (code === 'FS-B' && i === count - 1) name = 'Rohan Menon';
        else if (code === 'DA-C' && i === 3) name = 'Thara Jose';
        else {
          do name = `${R.pick(FIRST_NAMES)} ${R.pick(LAST_NAMES)}`;
          while (usedNames.has(name));
        }
        usedNames.add(name);
        const seq = seqStart[b.branch]!++;
        const admissionNo = formatNumber(DEFAULT_PATTERNS.admission, { BRANCH: b.branch, COURSE: b.course, YEAR: admYear, SEQ: seq });
        const sid = id();
        const uid = id();
        const first = name.split(' ')[0]!.toLowerCase().replace(/[^a-z]/g, '');
        const phone = `+91${phoneCounter++}`;
        const isAnjali = name === 'Anjali Menon';
        const isRohan = name === 'Rohan Menon';
        await db.insert(s.user).values({
          id: uid,
          name,
          email: isAnjali ? 'anjali.menon@example.test' : isRohan ? 'rohan.menon@example.test' : `${first}.${seq}@students.exatech.test`,
          emailVerified: true,
          phoneNumber: phone,
          phoneNumberVerified: true,
          kind: 'student',
          status: 'active',
          invitedAt: istDateTime(b.start),
        });
        const joinedOn = b.start;
        const lastName = name.split(' ').slice(-1)[0];
        let guardianUserId = sureshUserId;
        let guardianId = sureshGuardianId;
        let guardianName = 'Suresh Menon';
        if (!isAnjali && !isRohan) {
          guardianUserId = id();
          guardianId = id();
          guardianName = `${R.pick(['Suresh', 'Rekha', 'Mohan', 'Latha', 'Babu', 'Geetha', 'Thomas', 'Mini', 'Joseph', 'Sindhu', 'Rajan', 'Beena'])} ${lastName}`;
          await db.insert(s.user).values({
            id: guardianUserId,
            name: guardianName,
            email: `guardian.${seq}.${b.branch.toLowerCase()}@example.test`,
            emailVerified: false,
            phoneNumber: `+91${phoneCounter++}`,
            kind: 'guardian',
            status: R.chance(0.6) ? 'active' : 'invited',
            invitedAt: istDateTime(b.start),
          });
          await db.insert(s.guardian).values({ id: guardianId, userId: guardianUserId, name: guardianName, phone: `+91${phoneCounter - 1}`, email: `guardian.${seq}.${b.branch.toLowerCase()}@example.test` });
        }
        await db.insert(s.student).values({
          id: sid,
          institutionId,
          branchId: b.branchId,
          userId: uid,
          admissionNo,
          name,
          phone,
          email: isAnjali ? 'anjali.menon@example.test' : null,
          dob: `${2003 + R.int(0, 4)}-${String(R.int(1, 12)).padStart(2, '0')}-${String(R.int(1, 28)).padStart(2, '0')}`,
          address: `${R.pick(['Pattom', 'Kowdiar', 'Vazhuthacaud', 'Kazhakkoottam', 'Sreekaryam', 'Ulloor', 'Kakkanad', 'Edappally', 'Palazhi'])}, ${BRANCHES.find((x) => x.code === b.branch)!.city}`,
          cardToken: token(),
          cardIssuedAt: istDateTime(b.start),
        });
        await db.insert(s.studentGuardian).values({ studentId: sid, guardianId, relationship: guardianName.startsWith('Rekha') || guardianName.startsWith('Latha') || guardianName.startsWith('Geetha') || guardianName.startsWith('Mini') || guardianName.startsWith('Sindhu') || guardianName.startsWith('Beena') ? 'Mother' : 'Father', isPrimary: true });
        const profile: StudentInfo['profile'] = isAnjali || isRohan ? 'overdue' : R.chance(0.07) ? 'overdue' : R.chance(0.05) ? 'partial' : 'current';
        students.push({ id: sid, userId: uid, name, batch: b, enrollmentId: id(), admissionNo, joinedOn, profile, guardianUserId, guardianName });
      }
    }

    /* ── portal memberships: every student and guardian gets their role ── */
    const guardianBranches = new Map<string, { branches: Set<string>; kids: number }>();
    await insertMany(
      db,
      s.membership,
      students.map((st) => {
        const g = guardianBranches.get(st.guardianUserId) ?? { branches: new Set<string>(), kids: 0 };
        g.branches.add(st.batch.branchId);
        g.kids++;
        guardianBranches.set(st.guardianUserId, g);
        return { userId: st.userId, roleId: roleIds.student!, branchIds: [st.batch.branchId], scopeLabel: st.batch.code, isDefault: true };
      }),
    );
    await insertMany(
      db,
      s.membership,
      [...guardianBranches.entries()].map(([userId, g]) => ({
        userId,
        roleId: roleIds.parent!,
        branchIds: [...g.branches],
        scopeLabel: g.kids === 1 ? '1 child' : `${g.kids} children`,
        isDefault: true,
      })),
    );

    /* ── finance: enrollments, instalments, invoices, payments, receipts, ledger ── */
    interface FinEvent {
      kind: 'invoice' | 'payment';
      date: string;
      branch: string;
      apply: (number: string, seq: number) => Promise<void>;
    }
    const finEvents: FinEvent[] = [];
    const cashSessionIds: Record<string, string> = {};
    cashSessionIds['TVM:Counter 1'] = id();
    cashSessionIds['TVM:Counter 2'] = id();
    cashSessionIds['EKM:Counter 1'] = id();
    const onlinePayments: { gatewayPaymentId: string; amount: number; paymentId: string; date: string; name: string }[] = [];
    const policyByCourse = Object.fromEntries(COURSES.map((c) => [c.code, c.policy as ClearancePolicy]));
    const instalmentRowsByEnrollment: Record<string, { id: string; dueDate: string; amount: number; paid: number }[]> = {};
    const todayDeskTargets: Record<string, number> = { TVM: 0 };

    for (const st of students) {
      const b = st.batch;
      const plan = planDefs[b.planId]!;
      const discountPct = st.name === 'Anjali Menon' || st.name === 'Rohan Menon' ? 0 : R.chance(0.25) ? R.pick([5, 8, 10]) : 0;
      const q = quoteFee(plan.components.map(([name, amt]) => ({ name, amount: rupees(amt) })), discountPct, 18);
      const schedule = buildSchedule(q.total, plan.schedule.map(([label, pct, dueOffsetDays]) => ({ label, pct, dueOffsetDays })), st.joinedOn);
      await db.insert(s.enrollment).values({
        id: st.enrollmentId,
        studentId: st.id,
        batchId: b.id,
        branchId: b.branchId,
        status: 'active',
        joinedOn: st.joinedOn,
        feePlanId: b.planId,
        feePlanName: plan.name,
        feeTotal: q.total,
        discountPct,
      });
      const insts = schedule.map((row) => ({ id: id(), ...row, paid: 0 }));
      // Decide what is paid
      const due = insts.filter((i) => i.dueDate <= anchor);
      const payments: { amount: number; date: string; instIdx: number[] }[] = [];
      due.forEach((inst, idx) => {
        const isLast = idx === due.length - 1;
        if (!isLast || st.profile === 'current') {
          payments.push({ amount: inst.amount, date: clampDate(addDays(inst.dueDate, R.int(-4, 2)), st.joinedOn, anchor), instIdx: [insts.indexOf(inst)] });
        } else if (st.name === 'Anjali Menon') {
          payments.push({ amount: rupees(9000), date: addDays(anchor, -20), instIdx: [insts.indexOf(inst)] });
        } else if (st.name === 'Rohan Menon') {
          payments.push({ amount: rupees(6600), date: addDays(inst.dueDate, -2), instIdx: [insts.indexOf(inst)] });
        } else if (st.profile === 'partial') {
          payments.push({ amount: roundTo(inst.amount * R.pick([0.3, 0.5, 0.6]), 100_00), date: addDays(inst.dueDate, R.int(-3, 3)), instIdx: [insts.indexOf(inst)] });
        }
        // overdue: nothing paid on the latest due instalment
      });
      // A few TVM students pay their next instalment today at the desk (collection desk activity).
      const nextUnpaid = insts.find((i) => i.dueDate > anchor);
      if (b.branch === 'TVM' && st.profile === 'current' && nextUnpaid && todayDeskTargets.TVM! < 12 && R.chance(0.2)) {
        todayDeskTargets.TVM!++;
        payments.push({ amount: nextUnpaid.amount, date: anchor, instIdx: [insts.indexOf(nextUnpaid)] });
      }
      for (const p of payments) for (const ix of p.instIdx) insts[ix]!.paid += p.amount;
      instalmentRowsByEnrollment[st.enrollmentId] = insts.map((i) => ({ id: i.id, dueDate: i.dueDate, amount: i.amount, paid: i.paid }));
      await insertMany(
        db,
        s.instalment,
        insts.map((i) => ({
          id: i.id,
          enrollmentId: st.enrollmentId,
          branchId: b.branchId,
          seq: i.seq,
          label: i.label,
          dueDate: i.dueDate,
          amount: i.amount,
          paid: i.paid,
          status: i.paid >= i.amount ? ('paid' as const) : i.paid > 0 ? ('partially_paid' as const) : ('due' as const),
        })),
      );

      // invoices: one per instalment issued 7 days before due (first at joining); only if issued by anchor
      const invoiceIdByInst: Record<string, string> = {};
      for (const inst of insts) {
        const issue = inst.seq === 1 ? st.joinedOn : addDays(inst.dueDate, -7);
        if (issue > anchor) continue;
        const invId = id();
        invoiceIdByInst[inst.id] = invId;
        const taxable = Math.round(inst.amount / 1.18 / 100) * 100;
        const tax = inst.amount - taxable;
        finEvents.push({
          kind: 'invoice',
          date: issue,
          branch: b.branch,
          apply: async (number, seq) => {
            await db.insert(s.invoice).values({
              id: invId,
              branchId: b.branchId,
              enrollmentId: st.enrollmentId,
              studentId: st.id,
              instalmentId: inst.id,
              number,
              fy,
              seq,
              issueDate: issue,
              dueDate: inst.dueDate,
              lines: [{ description: `${COURSES.find((c) => c.code === b.course)!.name} · ${inst.label}`, sac: '999293', amount: taxable, taxRate: 18, tax }],
              subtotal: taxable,
              tax,
              total: inst.amount,
              paid: inst.paid,
              status: inst.paid >= inst.amount ? 'paid' : inst.paid > 0 ? 'partially_paid' : 'issued',
              createdBy: userIds.joseph,
              createdAt: istDateTime(issue, '10:00'),
            });
            await db.insert(s.ledgerEntry).values({
              enrollmentId: st.enrollmentId,
              branchId: b.branchId,
              at: istDateTime(issue, '10:00'),
              kind: 'charge',
              description: `Invoice · ${inst.label}`,
              reference: number,
              debit: inst.amount,
              invoiceId: invId,
              createdBy: userIds.joseph,
            });
          },
        });
      }

      for (const p of payments) {
        const pid = id();
        const isToday = p.date === anchor;
        const method = isToday ? R.pick(['upi', 'cash', 'cash', 'card', 'upi'] as const) : R.pick(['upi', 'upi', 'cash', 'card', 'online', 'online', 'transfer'] as const);
        const counter = isToday ? (R.chance(0.7) ? 'Counter 1' : 'Counter 2') : null;
        const gatewayPaymentId = method === 'online' ? `pay_${crypto.randomBytes(7).toString('hex')}` : null;
        const hour = isToday ? `${String(R.int(9, 12)).padStart(2, '0')}:${String(R.int(0, 59)).padStart(2, '0')}` : '11:00';
        const receivedAt = istDateTime(p.date, hour);
        if (gatewayPaymentId) onlinePayments.push({ gatewayPaymentId, amount: p.amount, paymentId: pid, date: p.date, name: st.name });
        finEvents.push({
          kind: 'payment',
          date: p.date + hour,
          branch: b.branch,
          apply: async (number, seq) => {
            await db.insert(s.payment).values({
              id: pid,
              branchId: b.branchId,
              enrollmentId: st.enrollmentId,
              studentId: st.id,
              receivedAt,
              total: p.amount,
              status: 'cleared',
              channel: method === 'online' ? 'online' : 'desk',
              gatewayPaymentId,
              gatewayOrderId: gatewayPaymentId ? `order_${crypto.randomBytes(7).toString('hex')}` : null,
              cashSessionId: counter ? cashSessionIds[`TVM:${counter}`] : null,
              receivedBy: method === 'online' ? null : counter === 'Counter 2' ? userIds.rema : userIds.joseph,
              idempotencyKey: `seed-${pid}`,
            });
            await db.insert(s.paymentTender).values({
              paymentId: pid,
              method,
              amount: p.amount,
              reference: method === 'cash' ? null : method === 'online' ? gatewayPaymentId : `${method.toUpperCase()}${R.int(100000, 999999)}`,
            });
            for (const ix of p.instIdx) {
              const inst = insts[ix]!;
              await db.insert(s.paymentAllocation).values({ paymentId: pid, instalmentId: inst.id, invoiceId: invoiceIdByInst[inst.id] ?? null, amount: p.amount });
            }
            await db.insert(s.receipt).values({ branchId: b.branchId, paymentId: pid, number, fy, seq, issuedAt: receivedAt, verifyToken: token() });
            await db.insert(s.ledgerEntry).values({
              enrollmentId: st.enrollmentId,
              branchId: b.branchId,
              at: receivedAt,
              kind: 'payment',
              description: `Payment · ${method === 'online' ? 'Razorpay' : method.toUpperCase()}`,
              reference: number,
              credit: p.amount,
              paymentId: pid,
              createdBy: method === 'online' ? null : userIds.joseph,
            });
          },
        });
      }

      // clearance
      const clr = computeClearance({ instalments: insts.map((i) => ({ dueDate: i.dueDate, amount: i.amount, paid: i.paid })), policy: policyByCourse[b.course]!, today: anchor });
      await db.update(s.enrollment).set({ feeCleared: clr.cleared, clearedUntil: clr.clearedUntil, clearanceReason: clr.reason }).where(sql`id = ${st.enrollmentId}`);
    }

    // Cheques pending clearance (do not unlock) — two TVM students paid their next instalment by cheque yesterday.
    const chequeStudents = students.filter((x) => x.batch.branch === 'TVM' && x.profile === 'current').slice(3, 5);
    for (const st of chequeStudents) {
      const next = instalmentRowsByEnrollment[st.enrollmentId]!.find((i) => i.paid < i.amount);
      if (!next) continue;
      const pid = id();
      const amount = next.amount - next.paid;
      const day = addDays(anchor, -1);
      const receivedAt = istDateTime(day, '15:10');
      finEvents.push({
        kind: 'payment',
        date: `${day}15:10`,
        branch: st.batch.branch,
        apply: async (number, seq) => {
          await db.insert(s.payment).values({ id: pid, branchId: st.batch.branchId, enrollmentId: st.enrollmentId, studentId: st.id, receivedAt, total: amount, status: 'pending_clearance', channel: 'desk', receivedBy: userIds.joseph, idempotencyKey: `seed-${pid}` });
          await db.insert(s.paymentTender).values({ paymentId: pid, method: 'cheque', amount, reference: `CHQ ${R.int(100000, 999999)}`, chequeStatus: 'pending' });
          await db.insert(s.paymentAllocation).values({ paymentId: pid, instalmentId: next.id, invoiceId: null, amount, pending: true });
          await db.update(s.instalment).set({ pendingPaid: amount }).where(sql`id = ${next.id}`);
          await db.insert(s.receipt).values({ branchId: st.batch.branchId, paymentId: pid, number, fy, seq, issuedAt: receivedAt, verifyToken: token() });
          await db.insert(s.ledgerEntry).values({ enrollmentId: st.enrollmentId, branchId: st.batch.branchId, at: receivedAt, kind: 'payment', description: 'Payment · Cheque · pending clearance', reference: number, credit: amount, paymentId: pid, createdBy: userIds.joseph });
        },
      });
    }

    // Dues follow-up history: reminders for everyone overdue, promises-to-pay for some (incl. Rohan's parent).
    const duesRows: (typeof s.duesActivity.$inferInsert)[] = [];
    for (const st of students.filter((x) => x.profile !== 'current')) {
      duesRows.push({ enrollmentId: st.enrollmentId, kind: 'reminder', channel: 'whatsapp', note: 'Reminder · WhatsApp + invoice PDF', createdBy: userIds.joseph, createdAt: addDaysDate(now, -3) });
      if (st.name === 'Rohan Menon' || R.chance(0.35)) {
        duesRows.push({ enrollmentId: st.enrollmentId, kind: 'promise', channel: 'call', note: 'Call · parent promised to pay', promiseDate: addDays(anchor, R.int(1, 5)), createdBy: userIds.joseph, createdAt: addDaysDate(now, -2) });
      }
    }
    await insertMany(db, s.duesActivity, duesRows);

    // Number invoices and receipts gap-free per branch in date order.
    const counters: Record<string, number> = {};
    finEvents.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));
    for (const ev of finEvents) {
      const docType = ev.kind === 'invoice' ? 'invoice' : 'receipt';
      const key = `${ev.branch}:${docType}`;
      counters[key] = (counters[key] ?? 0) + 1;
      const seq = counters[key]!;
      await ev.apply(formatNumber(DEFAULT_PATTERNS[docType], { BRANCH: ev.branch, FY: fy, SEQ: seq }), seq);
    }

    /* ── cash sessions (today) ── */
    await db.insert(s.cashSession).values([
      { id: cashSessionIds['TVM:Counter 1']!, branchId: branchIds.TVM!, counterName: 'Counter 1', cashierUserId: userIds.joseph!, date: anchor, openedAt: istDateTime(anchor, '09:02'), openingCash: rupees(5000) },
      {
        id: cashSessionIds['TVM:Counter 2']!,
        branchId: branchIds.TVM!,
        counterName: 'Counter 2',
        cashierUserId: userIds.rema!,
        date: anchor,
        openedAt: istDateTime(anchor, '09:10'),
        openingCash: rupees(5000),
        status: 'closed',
        closedAt: istDateTime(anchor, '13:30'),
        closedBy: userIds.rema,
        deposited: 0,
        counted: 0,
        expectedCash: 0,
        difference: 0,
        denominations: {},
      },
    ]);
    // Counter 2 closing figures from its cash payments
    const c2 = await h.sql<{ cash: string | null }[]>`
      select coalesce(sum(t.amount),0) as cash from payment p join payment_tender t on t.payment_id = p.id
      where p.cash_session_id = ${cashSessionIds['TVM:Counter 2']!} and t.method = 'cash'`;
    const c2cash = Number(c2[0]?.cash ?? 0);
    // Counter 2 closed at 13:30 and deposited everything (closing cash ₹0).
    await db
      .update(s.cashSession)
      .set({ deposited: rupees(5000) + c2cash, counted: 0, expectedCash: 0, difference: 0, denominations: {} })
      .where(sql`id = ${cashSessionIds['TVM:Counter 2']!}`);

    /* ── doc sequences ── */
    for (const [key, n] of Object.entries(counters)) {
      const [code, docType] = key.split(':') as [string, string];
      await db.insert(s.docSequence).values({ scopeId: branchIds[code]!, docType, period: fy, nextSeq: n + 1 });
    }
    for (const b of BRANCHES) {
      await db.insert(s.docSequence).values({ scopeId: branchIds[b.code]!, docType: 'admission', period: String(admYear), nextSeq: seqStart[b.code]! });
      await db.insert(s.docSequence).values({ scopeId: branchIds[b.code]!, docType: 'credit_note', period: fy, nextSeq: 1 });
    }

    /* ── period locks: previous month closed ── */
    const prevMonth = monthStart(addDays(monthStart(anchor), -1));
    for (const code of ['TVM', 'EKM', 'CLT']) {
      await db.insert(s.periodLock).values({ branchId: branchIds[code]!, month: prevMonth, lockedBy: userIds.joseph, lockedAt: istDateTime(addDays(monthStart(anchor), 2), '18:00') });
    }

    /* ── settlement (yesterday): matched online payments + 2 exceptions ── */
    const recentOnline = onlinePayments.filter((p) => p.date < anchor && p.date >= addDays(anchor, -10));
    // The last one settles ₹500 short of what was recorded ("amount differs" needs investigation).
    const differs = recentOnline.length > 1 ? recentOnline[recentOnline.length - 1]! : null;
    const settleItems = differs ? recentOnline.slice(0, -1) : recentOnline;
    const settlementId = id();
    const settleTotal = settleItems.reduce((a, p) => a + p.amount, 0) + rupees(12000) + (differs ? differs.amount - rupees(500) : 0);
    await db.insert(s.settlement).values({
      id: settlementId,
      gateway: 'razorpay',
      externalId: `setl_${crypto.randomBytes(6).toString('hex')}`,
      settledOn: addDays(anchor, -1),
      amount: settleTotal,
      fees: Math.round(settleTotal * 0.02),
      utr: `UTR${R.int(10000000, 99999999)}`,
      paymentCount: settleItems.length + 1 + (differs ? 1 : 0),
    });
    await insertMany(db, s.settlementItem, [
      ...settleItems.map((p) => ({ settlementId, gatewayPaymentId: p.gatewayPaymentId, amount: p.amount, matchedPaymentId: p.paymentId, status: 'matched' as const })),
      { settlementId, gatewayPaymentId: `pay_${crypto.randomBytes(7).toString('hex')}`, amount: rupees(12000), notes: 'FS fee', status: 'unmatched' as const },
      ...(differs
        ? [{ settlementId, gatewayPaymentId: differs.gatewayPaymentId, amount: differs.amount - rupees(500), notes: `${differs.name} · instalment`, matchedPaymentId: differs.paymentId, status: 'amount_differs' as const }]
        : []),
    ]);

    /* ── sessions & attendance ── */
    const sessionsByBatch: Record<string, { id: string; date: string; start: string }[]> = {};
    const sessionRows: (typeof s.classSession.$inferInsert)[] = [];
    // Same weekday next week = a DM-A "today" slot, so the leave flags a real session needing a substitute.
    const leaveNithin = addDays(anchor, 7);
    for (const b of batches) {
      sessionsByBatch[b.id] = [];
      const from = b.start > addDays(anchor, -42) ? b.start : addDays(anchor, -42);
      const to = addDays(anchor, 21);
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const wd = weekday(d);
        if (wd === 0 && !b.slots.some((x) => x.wd === 0)) continue;
        if (d < b.start || d > b.end) continue;
        for (const slot of b.slots.filter((x) => x.wd === wd)) {
          const sid = id();
          const isHoliday = holidayDates.has(d);
          const endH = Number(slot.time.slice(0, 2)) + 2;
          const row: typeof s.classSession.$inferInsert = {
            id: sid,
            branchId: b.branchId,
            batchId: b.id,
            teacherUserId: userIds[b.teacher]!,
            subjectName: b.subject,
            roomId: b.roomId,
            date: d,
            startTime: slot.time,
            endTime: `${String(endH).padStart(2, '0')}:${slot.time.slice(3)}`,
            mode: b.mode,
            kind: 'timetabled',
            status: isHoliday ? 'suppressed' : 'scheduled',
            topic: topicFor(b.course, d),
            flag: b.status === 'open' ? 'planned' : b.code === 'DM-A' && d === leaveNithin ? 'leave · substitute?' : null,
          };
          sessionRows.push(row);
          if (!isHoliday) sessionsByBatch[b.id]!.push({ id: sid, date: d, start: slot.time });
        }
      }
    }
    await insertMany(db, s.classSession, sessionRows);

    const attendanceRows: (typeof s.attendance.$inferInsert)[] = [];
    const statusesByEnrollment: Record<string, AttendanceStatus[]> = {};
    const submittedSessionIds: string[] = [];
    for (const b of batches) {
      const roster = students.filter((x) => x.batch.id === b.id);
      const past = sessionsByBatch[b.id]!.filter((x) => x.date < anchor || (x.date === anchor && b.code === 'DM-A'));
      past.forEach((sess, idx) => {
        submittedSessionIds.push(sess.id);
        const isRecent = idx >= past.length - 3;
        for (const st of roster) {
          let status: AttendanceStatus = R.chance(0.9) ? 'P' : R.chance(0.6) ? 'A' : R.chance(0.6) ? 'L' : 'E';
          if (st.name === 'Rohan Menon') status = [1, 4, 7].includes(idx % 10) ? 'A' : 'P';
          if (st.name === 'Sandeep M') status = idx % 3 === 1 ? 'A' : 'P';
          if (st.name === 'Thara Jose' && isRecent) status = 'A';
          if (st.name === 'Anjali Menon') status = R.chance(0.93) ? 'P' : 'A';
          attendanceRows.push({ sessionId: sess.id, enrollmentId: st.enrollmentId, status, source: 'teacher', markedBy: userIds[b.teacher], markedAt: istDateTime(sess.date, sess.start) });
          (statusesByEnrollment[st.enrollmentId] ??= []).push(status);
        }
      });
    }
    await insertMany(db, s.attendance, attendanceRows, 1000);
    await h.sql`update class_session set attendance_submitted_at = (date::timestamp + start_time::time + interval '2 hours') at time zone 'Asia/Kolkata', attendance_submitted_by = teacher_user_id, status = 'held'
                where id = any(${submittedSessionIds}::uuid[])`;
    for (const [enr, sts] of Object.entries(statusesByEnrollment)) {
      await db.update(s.enrollment).set({ attendancePct: attendancePercent(sts) }).where(sql`id = ${enr}`);
    }

    /* ── leave ── */
    await db.insert(s.leave).values([
      { userId: userIds.nithin!, branchId: branchIds.TVM!, date: leaveNithin, type: 'casual', reason: 'Personal', status: 'approved', decidedBy: userIds.priya, decidedAt: addDaysDate(now, -2) },
      { userId: userIds.rema!, branchId: branchIds.TVM!, date: addDays(anchor, 13), type: 'casual', reason: 'Family function', status: 'pending' },
      { userId: userIds.arun!, branchId: branchIds.TVM!, date: anchor, type: 'earned', reason: 'Annual leave', status: 'approved', decidedBy: userIds.priya, decidedAt: addDaysDate(now, -5) },
    ]);

    /* ── exams & marks ── */
    const dma = batchByCode['DM-A']!;
    const examSpecs = [
      { batch: 'DM-A', name: 'Module 1 · Foundations', date: addDays(anchor, -3), status: 'published' as const, comps: [['Theory', 60], ['Practical', 40]] as const, fill: 1 },
      { batch: 'FS-B', name: 'Sprint 2 · React', date: addDays(anchor, -2), status: 'submitted' as const, comps: [['Total', 100]] as const, fill: 1 },
      { batch: 'DA-C', name: 'SQL practical', date: addDays(anchor, -2), status: 'submitted' as const, comps: [['Practical', 50]] as const, fill: 1 },
      { batch: 'DM-A', name: 'Module 2 · Search', date: addDays(anchor, 5), status: 'draft' as const, comps: [['Theory', 60], ['Practical', 40]] as const, fill: 0.8 },
      { batch: 'DM-B', name: 'Module 1 · Paid media', date: addDays(anchor, 7), status: 'draft' as const, comps: [['Quiz', 20], ['Campaign project', 80]] as const, fill: 0 },
      { batch: 'DM-K1', name: 'Module 1 · Content', date: addDays(anchor, -6), status: 'published' as const, comps: [['Theory', 50], ['Project', 50]] as const, fill: 1 },
    ];
    for (const ex of examSpecs) {
      const b = batchByCode[ex.batch]!;
      const examId = id();
      await db.insert(s.exam).values({
        id: examId,
        batchId: b.id,
        branchId: b.branchId,
        teacherUserId: userIds[b.teacher]!,
        name: ex.name,
        date: ex.date,
        startTime: '10:00',
        room: b.branch === 'TVM' ? 'Hall A' : 'EKM Hall',
        status: ex.status,
        submittedAt: ex.status !== 'draft' ? addDaysDate(now, ex.status === 'published' ? -1 : -1) : null,
        publishedAt: ex.status === 'published' ? addDaysDate(now, 0, -2) : null,
        publishedBy: ex.status === 'published' ? (b.branch === 'TVM' ? userIds.priya : userIds.joseph) : null,
      });
      const compIds = ex.comps.map(() => id());
      await insertMany(db, s.examComponent, ex.comps.map(([name, max], i) => ({ id: compIds[i]!, examId, position: i, name, maxMarks: max })));
      const roster = students.filter((x) => x.batch.id === b.id);
      const marks: (typeof s.mark.$inferInsert)[] = [];
      roster.forEach((st, ri) => {
        const blank = ex.fill < 1 && (ri === 2 || ri === 6) ? true : ex.fill === 0;
        ex.comps.forEach(([, max], ci) => {
          const base = st.name === 'Rohan Menon' ? 0.62 : st.name === 'Anjali Menon' ? 0.86 : 0.55 + R.next() * 0.4;
          marks.push({ examId, examComponentId: compIds[ci]!, enrollmentId: st.enrollmentId, value: blank ? null : Math.min(max, Math.round(max * base)) });
        });
      });
      await insertMany(db, s.mark, marks);
      // exams appear on the timetable
      await db.insert(s.classSession).values({
        branchId: b.branchId,
        batchId: b.id,
        teacherUserId: userIds[b.teacher]!,
        subjectName: b.subject,
        roomId: roomIds[b.branch === 'TVM' ? 'Hall A' : 'EKM Hall'],
        date: ex.date,
        startTime: '10:00',
        endTime: '12:00',
        kind: 'exam',
        status: ex.date < anchor ? 'held' : 'scheduled',
        topic: `Exam · ${ex.name}`,
      });
    }
    void dma;

    /* ── assignments & submissions ── */
    const asgSpecs = [
      { batch: 'DM-A', title: 'SEO audit of a local business', due: addDays(anchor, 2), max: 50, submitted: 22, graded: 16 },
      { batch: 'DM-A', title: 'Keyword map for a product page', due: addDays(anchor, 12), max: 30, submitted: 3, graded: 0 },
      { batch: 'DM-B', title: 'Brand positioning brief', due: addDays(anchor, -11), max: 40, submitted: 11, graded: 11 },
      { batch: 'FS-B', title: 'Build a todo app with hooks', due: addDays(anchor, -8), max: 50, submitted: 21, graded: 21 },
      { batch: 'FS-B', title: 'REST client with error states', due: addDays(anchor, -3), max: 50, submitted: 20, graded: 12 },
      { batch: 'DA-C', title: 'Normalise the sales dataset', due: addDays(anchor, -5), max: 40, submitted: 18, graded: 18 },
    ];
    for (const a of asgSpecs) {
      const b = batchByCode[a.batch]!;
      const asgId = id();
      await db.insert(s.assignment).values({
        id: asgId,
        batchId: b.id,
        branchId: b.branchId,
        teacherUserId: userIds[b.teacher]!,
        title: a.title,
        instructions: 'Submit a PDF or a link. Show your working and cite sources.',
        dueAt: istDateTime(a.due, '23:59'),
        maxMarks: a.max,
        latePolicy: 'minus_10_per_day',
        rubric: 'Accuracy 40% · Insight 40% · Presentation 20%',
        status: a.due < anchor ? 'closed' : 'open',
        createdAt: istDateTime(addDays(a.due, -10), '10:00'),
      });
      const roster = students.filter((x) => x.batch.id === b.id);
      const subs: (typeof s.submission.$inferInsert)[] = [];
      let submittedCount = 0;
      for (const st of roster) {
        if (submittedCount >= a.submitted) break;
        if (st.name === 'Rohan Menon' && a.batch === 'FS-B') continue; // missed both
        if (st.name === 'Sandeep M' && a.title.startsWith('SEO')) continue;
        if (st.name === 'Anjali Menon' && a.title.startsWith('Keyword')) continue;
        const graded = submittedCount < a.graded;
        const late = R.chance(0.1);
        const m = Math.round(a.max * (0.6 + R.next() * 0.35));
        subs.push({
          assignmentId: asgId,
          enrollmentId: st.enrollmentId,
          submittedAt: istDateTime(addDays(a.due, late ? 1 : -R.int(0, 3)), '18:00'),
          text: 'Submission attached.',
          isLate: late,
          lateDays: late ? 1 : 0,
          marks: graded ? m : null,
          finalMarks: graded ? (late ? Math.max(0, m - a.max * 0.1) : m) : null,
          feedback: graded ? R.pick(['Good structure.', 'Clear and well argued.', 'Needs more data.', 'Excellent work.', null]) : null,
          gradedAt: graded ? addDaysDate(now, -1) : null,
          gradedBy: graded ? userIds[b.teacher] : null,
          released: graded,
        });
        submittedCount++;
      }
      await insertMany(db, s.submission, subs);
    }

    /* ── materials ── */
    const matSpecs: [string, string, string, 'PDF' | 'Slides' | 'Video' | 'XLSX' | 'ZIP' | 'Link', 'always' | 'fee_gated' | 'scheduled', string, number][] = [
      ['DM-A', 'Module 1 · Foundations', 'Course orientation & syllabus', 'PDF', 'always', '12 pages', -60],
      ['DM-A', 'Module 1 · Foundations', 'Marketing fundamentals — slides', 'PDF', 'fee_gated', '48 slides', -55],
      ['DM-A', 'Module 2 · Search', 'SEO playbook', 'PDF', 'fee_gated', '31 pages · watermarked', -20],
      ['DM-A', 'Module 2 · Search', 'Keyword research — class recording', 'Video', 'fee_gated', '1 h 42 m', -12],
      ['DM-A', 'Module 3 · Paid media', 'Google Ads lab worksheet', 'PDF', 'scheduled', 'scheduled', -2],
      ['DM-B', 'Module 1 · Paid media', 'Google Ads account setup guide', 'PDF', 'always', '9 pages', -20],
      ['FS-B', 'Sprint 2 · React', 'Hooks cheat-sheet', 'PDF', 'fee_gated', '4 pages', -15],
      ['FS-B', 'Sprint 1 · JavaScript', 'ES2023 reference', 'PDF', 'always', '18 pages', -50],
      ['DA-C', 'SQL', 'Joins practice dataset', 'ZIP', 'always', '2 MB', -25],
      ['UX-A', 'Wireframing', 'Low-fi wireframe kit', 'PDF', 'fee_gated', '22 pages', -18],
      ['DM-K1', 'Module 1', 'Orientation deck', 'PDF', 'always', '14 slides', -55],
      ['DA-C1', 'Module 1', 'Excel to SQL workbook', 'XLSX', 'fee_gated', '1 MB', -20],
    ];
    const materialRows: (typeof s.material.$inferInsert)[] = [];
    const fileRows: (typeof s.fileObject.$inferInsert)[] = [];
    for (const [code, module, title, type, vis, meta, ago] of matSpecs) {
      const b = batchByCode[code]!;
      const fid = id();
      const ext = type === 'Video' ? 'mp4' : type === 'XLSX' ? 'xlsx' : type === 'ZIP' ? 'zip' : 'pdf';
      if (type !== 'Video') {
        fileRows.push({
          id: fid,
          bucket: 'exatech',
          key: `seed/materials/${fid}.${ext}`,
          filename: `${title.replace(/[^\w]+/g, '-').toLowerCase()}.${ext}`,
          mime: ext === 'pdf' ? 'application/pdf' : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip',
          size: 0,
          purpose: 'material',
          ownerUserId: userIds[b.teacher],
        });
      }
      materialRows.push({
        batchId: b.id,
        branchId: b.branchId,
        module,
        title,
        type,
        visibility: vis,
        releaseAt: vis === 'scheduled' ? istDateTime(addDays(anchor, 13), '08:00') : null,
        fileId: type === 'Video' ? null : fid,
        url: type === 'Video' ? 'https://www.youtube.com/watch?v=exatech-recording' : null,
        meta,
        uploadedBy: userIds[b.teacher]!,
        createdAt: istDateTime(addDays(anchor, ago), '17:00'),
      });
    }
    await insertMany(db, s.fileObject, fileRows);
    await insertMany(db, s.material, materialRows);
    // open rates
    const mats = await db.select({ id: s.material.id, batchId: s.material.batchId, visibility: s.material.visibility }).from(s.material);
    const access: (typeof s.materialAccess.$inferInsert)[] = [];
    for (const m of mats) {
      if (m.visibility === 'scheduled') continue;
      for (const st of students.filter((x) => x.batch.id === m.batchId)) {
        if (R.chance(0.82)) access.push({ materialId: m.id, userId: st.userId, enrollmentId: st.enrollmentId, at: istDateTime(addDays(anchor, -R.int(0, 10)), '19:00') });
      }
    }
    await insertMany(db, s.materialAccess, access, 1000);

    /* ── message templates ── */
    await insertMany(db, s.messageTemplate, TEMPLATES.map((t) => ({ ...t, variables: [...t.variables] })));

    /* ── leads, activities, follow-ups ── */
    const stageMix: [LeadStage, number][] = [
      ['new', 9],
      ['contacted', 8],
      ['counselled', 7],
      ['demo_scheduled', 5],
      ['negotiation', 4],
      ['admission_in_progress', 0],
      ['won', 6],
      ['lost', 8],
    ];
    const courseByName = Object.fromEntries(COURSES.map((c) => [c.code, courseIds[c.code]!]));
    const leadRows: (typeof s.lead.$inferInsert)[] = [];
    const activityRows: (typeof s.leadActivity.$inferInsert)[] = [];
    const followRows: (typeof s.followUp.$inferInsert)[] = [];
    const tvmSales = ['meera', 'arun', 'sanjay'];
    let leadPhone = 9846000000;
    const mkLead = (opts: { branch: 'TVM' | 'EKM'; stage: LeadStage; name?: string; owner?: string; source?: string; course?: string; ageDays?: number }) => {
      const lid = id();
      const source = opts.source ?? R.pick(LEAD_SOURCES);
      const course = opts.course ?? R.pick(['DM', 'DM', 'FS', 'DA', 'UX']);
      const owner = opts.owner ?? (opts.branch === 'EKM' ? 'fathima' : source === 'Referral' ? 'meera' : R.pick(tvmSales));
      const name = opts.name ?? `${R.pick(FIRST_NAMES)} ${R.pick(LAST_NAMES)}`;
      const age = opts.ageDays ?? R.int(0, 28);
      const createdAt = addDaysDate(now, -age, -R.int(0, 8));
      const responded = opts.stage !== 'new';
      const visited = ['demo_scheduled', 'negotiation', 'admission_in_progress', 'won'].includes(opts.stage);
      const row: typeof s.lead.$inferInsert = {
        id: lid,
        institutionId,
        branchId: branchIds[opts.branch]!,
        name,
        phone: `+91${leadPhone++}`,
        email: R.chance(0.7) ? `${name.split(' ')[0]!.toLowerCase()}.${R.int(10, 99)}@gmail.example` : null,
        source,
        campaign: R.pick(CAMPAIGNS[source]!),
        courseId: courseByName[course],
        preferredBranchId: branchIds[opts.branch],
        preferredTiming: R.pick(['Weekday mornings', 'Weekday evenings', 'Weekends']),
        stage: opts.stage,
        lostReason: opts.stage === 'lost' ? R.pick(['Price', 'Price', 'Timing', 'Location', 'Joined elsewhere']) : null,
        ownerUserId: userIds[owner],
        score: leadScore({ source, stage: opts.stage, responded, visited, demoAttended: visited && R.chance(0.6), courseHasOpenBatch: true, hasEmail: true }),
        consentWhatsapp: responded,
        consentCapturedAt: responded ? createdAt : null,
        responded,
        visited,
        firstResponseAt: responded ? new Date(createdAt.getTime() + R.int(20, 180) * 60_000) : null,
        nextFollowUpAt: ['won', 'lost'].includes(opts.stage) ? null : addDaysDate(now, R.int(-1, 3)),
        nextFollowUpNote: ['won', 'lost'].includes(opts.stage) ? null : R.pick(['Call back after 4 pm', 'Send EMI options', 'Confirm demo slot', 'Share batch dates']),
        createdBy: userIds[owner],
        createdAt,
        lastActivityAt: addDaysDate(now, -Math.min(age, R.int(0, 3))),
      };
      leadRows.push(row);
      activityRows.push({ leadId: lid, actorUserId: null, kind: 'created', summary: `Created from ${source} · auto-assigned`, createdAt });
      if (responded) activityRows.push({ leadId: lid, actorUserId: userIds[owner], kind: 'whatsapp', summary: 'WhatsApp · brochure sent (template: intro_v3)', createdAt: new Date(createdAt.getTime() + 3_600_000) });
      if (responded) activityRows.push({ leadId: lid, actorUserId: userIds[owner], kind: 'call', summary: 'Call · 6 min · interested, asked about EMI', createdAt: new Date(createdAt.getTime() + 86_400_000) });
      if (opts.stage !== 'new' && opts.stage !== 'contacted') activityRows.push({ leadId: lid, actorUserId: userIds[owner], kind: 'stage', summary: `Stage → ${opts.stage.replace(/_/g, ' ')}`, createdAt: addDaysDate(now, -R.int(0, 2)) });
      return lid;
    };
    for (const [stage, n] of stageMix) for (let i = 0; i < n; i++) mkLead({ branch: 'TVM', stage });
    mkLead({ branch: 'TVM', stage: 'negotiation', name: 'Arjun Nair', owner: 'meera', source: 'Referral', course: 'DM', ageDays: 4 });
    for (let i = 0; i < 14; i++) mkLead({ branch: 'EKM', stage: R.pick(['new', 'contacted', 'counselled', 'demo_scheduled', 'won', 'lost'] as const) });
    // Meera's follow-ups: 2 overdue, 4 today
    const meeraLeads = leadRows.filter((l) => l.ownerUserId === userIds.meera && !['won', 'lost'].includes(l.stage!));
    meeraLeads.slice(0, 6).forEach((l, i) => {
      const overdue = i < 2;
      followRows.push({
        leadId: l.id!,
        ownerUserId: userIds.meera!,
        dueAt: overdue ? addDaysDate(now, -1, 0) : istDateTime(anchor, ['10:30', '12:00', '15:00', '17:30'][i - 2]!),
        channel: i % 3 === 0 ? 'whatsapp' : 'call',
        note: overdue ? R.pick(['Promised to confirm batch after salary credit', 'Asked for EMI options — send split plan']) : R.pick(['Demo follow-up', 'Share fee breakdown', 'Confirm weekend batch', 'Parent wants a campus visit']),
      });
    });
    // stamp won leads to students
    const won = leadRows.filter((l) => l.stage === 'won' && l.branchId === branchIds.TVM);
    const someStudents = students.filter((x) => x.batch.branch === 'TVM').slice(-won.length);
    won.forEach((l, i) => {
      l.studentId = someStudents[i]?.id ?? null;
      l.name = someStudents[i]?.name ?? l.name;
    });

    /* ── admissions queue (also needs leads in "admission in progress") ── */
    const admSpecs = [
      { name: 'Aiswarya Suresh', guardian: ['Suresh Babu', 'Father'], batch: 'FS-C', plan: 'FS:3 instalments 40/30/30', disc: 22, status: 'fee_verified' as const, needsSA: true, waitlistFrom: 'FS-B' },
      { name: 'Divya Pillai', guardian: ['Rekha Pillai', 'Mother'], batch: 'DM-B', plan: 'DM:Split 50 / 50', disc: 5, status: 'fee_verified' as const, needsSA: false },
      { name: 'Kiran Thomas', guardian: ['Thomas Mathew', 'Father'], batch: 'DA-C', plan: 'DA:Split 50 / 50', disc: 12, status: 'submitted' as const, needsSA: false },
      { name: 'Neha George', guardian: ['Mini George', 'Mother'], batch: 'UX-A', plan: 'UX:One-time', disc: 0, status: 'submitted' as const, needsSA: false },
      { name: 'Ashwin Mohan', guardian: ['Mohan Kumar', 'Father'], batch: 'DM-B', plan: 'DM:Split 50 / 50', disc: 0, status: 'returned' as const, needsSA: false },
    ];
    const approvalRows: (typeof s.approvalRequest.$inferInsert)[] = [];
    for (const a of admSpecs) {
      const b = batchByCode[a.batch]!;
      const lid = mkLead({ branch: 'TVM', stage: 'admission_in_progress', name: a.name, owner: 'meera', course: b.course, ageDays: R.int(5, 15) });
      const plan = planDefs[planIds[a.plan]!]!;
      const quote = quoteFee(plan.components.map(([n, amt]) => ({ name: n, amount: rupees(amt) })), a.disc, 18);
      const admId = id();
      const submittedAt = addDaysDate(now, -R.int(1, 3));
      await db.insert(s.admission).values({
        id: admId,
        institutionId,
        branchId: b.branchId,
        leadId: lid,
        salesUserId: userIds.meera!,
        studentName: a.name,
        studentPhone: `+91${leadPhone + 5000}`,
        studentEmail: `${a.name.split(' ')[0]!.toLowerCase()}@gmail.example`,
        studentDob: '2005-03-14',
        studentAddress: 'Pattom, Trivandrum 695004',
        guardianName: a.guardian[0],
        guardianRelationship: a.guardian[1],
        guardianPhone: `+91${leadPhone + 6000}`,
        batchId: b.id,
        feePlanId: planIds[a.plan]!,
        discountPct: a.disc,
        discountReason: a.disc > 0 ? (a.disc > 20 ? 'Sibling of alumnus + merit scholarship' : 'Early enrolment') : null,
        quote,
        consent: { dpdp: true, purposes: ['Academic records', 'Fee communication', 'WhatsApp reminders'], parental: false, capturedAt: submittedAt.toISOString() },
        waitlist: !!a.waitlistFrom,
        status: a.status,
        needsSuperAdmin: a.needsSA,
        financeVerifiedBy: a.status === 'fee_verified' ? userIds.joseph : null,
        financeVerifiedAt: a.status === 'fee_verified' ? addDaysDate(now, 0, -3) : null,
        returnedBy: a.status === 'returned' ? userIds.joseph : null,
        returnedAt: a.status === 'returned' ? addDaysDate(now, 0, -5) : null,
        returnedTo: a.status === 'returned' ? 'sales' : null,
        returnNote: a.status === 'returned' ? 'Qualification certificate missing — please upload before resubmitting.' : null,
        submittedAt,
      });
      await db.insert(s.admissionEvent).values({ admissionId: admId, step: 'sales', action: 'submitted', actorUserId: userIds.meera, createdAt: submittedAt });
      if (a.status === 'fee_verified') await db.insert(s.admissionEvent).values({ admissionId: admId, step: 'finance', action: 'verified', actorUserId: userIds.joseph, note: a.disc > 10 ? `Discount ${a.disc}% verified` : null });
      if (a.status === 'returned') await db.insert(s.admissionEvent).values({ admissionId: admId, step: 'finance', action: 'returned', actorUserId: userIds.joseph, note: 'Qualification certificate missing' });
      await insertMany(db, s.document, [
        { ownerType: 'admission', ownerId: admId, kind: 'id_proof', label: 'ID proof · Aadhaar.pdf', status: 'uploaded', uploadedBy: userIds.meera },
        { ownerType: 'admission', ownerId: admId, kind: 'photo', label: 'Photo · passport size', status: 'uploaded', uploadedBy: userIds.meera },
        { ownerType: 'admission', ownerId: admId, kind: 'certificate', label: 'Qualification certificate', status: a.status === 'returned' ? 'missing' : 'uploaded', uploadedBy: userIds.meera },
        { ownerType: 'admission', ownerId: admId, kind: 'other', label: 'Guardian ID', status: 'uploaded', uploadedBy: userIds.meera },
      ]);
      leadRows.find((l) => l.id === lid)!.admissionId = admId;
      if (a.needsSA) {
        approvalRows.push({
          institutionId,
          branchId: b.branchId,
          kind: 'discount',
          level: 'super_admin',
          title: `Discount ${a.disc}% · ${a.name}`,
          summary: `${a.batch} · ${plan.name} · requested by Meera Pillai · verified by Finance`,
          entityType: 'admission',
          entityId: admId,
          pct: a.disc,
          amount: quote.discount,
          requestedBy: userIds.joseph!,
          requestedAt: addDaysDate(now, 0, -3),
        });
      }
    }
    // other Super Admin approvals
    const someReceipt = await h.sql<{ id: string; number: string; payment_id: string; branch_id: string }[]>`
      select r.id, r.number, r.payment_id, r.branch_id from receipt r where r.issued_at < ${istDateTime(monthStart(anchor)).toISOString()} order by r.issued_at desc limit 1`;
    if (someReceipt[0]) {
      approvalRows.push({
        institutionId,
        branchId: someReceipt[0].branch_id,
        kind: 'locked_period',
        level: 'super_admin',
        title: `Locked-period entry · void ${someReceipt[0].number}`,
        summary: 'Duplicate entry in a closed month · Finance needs the period reopened for one entry',
        entityType: 'payment',
        entityId: someReceipt[0].payment_id,
        payload: { action: 'void', reason: 'Duplicate entry' },
        requestedBy: userIds.joseph!,
        requestedAt: addDaysDate(now, 0, -1),
      });
    }
    const refundStudent = students.find((x) => x.batch.code === 'UX-A' && x.profile === 'current')!;
    approvalRows.push({
      institutionId,
      branchId: refundStudent.batch.branchId,
      kind: 'refund',
      level: 'super_admin',
      title: `Refund ₹6,000 · ${refundStudent.name}`,
      summary: 'Drop-out within the 14-day policy window · UX-A · credit note on approval',
      entityType: 'enrollment',
      entityId: refundStudent.enrollmentId,
      amount: rupees(6000),
      payload: { reason: 'Relocating for work' },
      requestedBy: userIds.joseph!,
      requestedAt: addDaysDate(now, 0, -6),
    });
    await insertMany(db, s.approvalRequest, approvalRows);
    await insertMany(db, s.lead, leadRows);
    await insertMany(db, s.leadActivity, activityRows);
    await insertMany(db, s.followUp, followRows);

    /* ── assignment rules & targets ── */
    await insertMany(db, s.assignmentRule, [
      { branchId: branchIds.TVM!, position: 1, name: 'Referrals', condition: { sources: ['Referral'] }, assigneeUserIds: [userIds.meera!], assigneeLabel: 'Meera Pillai (referral specialist)', strategy: 'single', fallback: 'Round robin', matchedCount: 142 },
      { branchId: branchIds.TVM!, position: 2, name: 'Tech courses', condition: { courseIds: [courseIds.FS!, courseIds.DA!] }, assigneeUserIds: [userIds.sanjay!, userIds.arun!], assigneeLabel: 'Round robin · Sanjay, Arun', strategy: 'round_robin', fallback: 'Any', matchedCount: 611 },
      { branchId: branchIds.TVM!, position: 3, name: 'Kochi preference', condition: { preferredBranchIds: [branchIds.EKM!] }, assigneeUserIds: [userIds.fathima!], assigneeLabel: 'Kochi team', strategy: 'round_robin', fallback: '—', matchedCount: 238 },
      { branchId: branchIds.TVM!, position: 4, name: 'Everything else', condition: {}, assigneeUserIds: [userIds.meera!, userIds.arun!], assigneeLabel: 'Round robin · all TVM', strategy: 'round_robin', fallback: '—', isDefault: true, matchedCount: 421 },
      { branchId: branchIds.EKM!, position: 1, name: 'Everything else', condition: {}, assigneeUserIds: [userIds.fathima!], assigneeLabel: 'Fathima Rasheed', strategy: 'single', fallback: '—', isDefault: true, matchedCount: 96 },
    ]);
    const month = monthStart(anchor);
    await insertMany(db, s.salesTarget, [
      { userId: userIds.meera!, branchId: branchIds.TVM!, month, targetAdmissions: 10, targetRevenue: rupees(500000) },
      { userId: userIds.arun!, branchId: branchIds.TVM!, month, targetAdmissions: 8, targetRevenue: rupees(400000) },
      { userId: userIds.sanjay!, branchId: branchIds.TVM!, month, targetAdmissions: 6, targetRevenue: rupees(300000) },
      { userId: userIds.fathima!, branchId: branchIds.EKM!, month, targetAdmissions: 8, targetRevenue: rupees(400000) },
    ]);

    /* ── announcements ── */
    const allStudentUsers = students.map((x) => x.userId);
    const annRows = [
      { kicker: 'Pinned · Branch', title: `Vijayadashami holiday · ${'20 Oct'}`, body: 'No sessions. Fee reminders paused for the day.', branch: 'TVM', author: 'priya', role: 'branchadmin', pinned: true, ack: false, audience: [{ type: 'branch' as const, value: branchIds.TVM!, label: 'Branch · Trivandrum' }], recipients: students.filter((x) => x.batch.branch === 'TVM').flatMap((x) => [x.userId, x.guardianUserId]), readPct: 0.72, ago: -3 },
      { kicker: 'Finance · Segment: overdue', title: 'Instalment due this week', body: 'Pay online from the portal; invoice attached. Late fee applies after 3 days.', branch: 'TVM', author: 'joseph', role: 'finance', pinned: false, ack: true, audience: [{ type: 'segment' as const, value: 'overdue_fees', label: 'Segment · overdue fees' }], recipients: students.filter((x) => x.profile !== 'current').flatMap((x) => [x.userId, x.guardianUserId]), readPct: 0.65, ago: -2 },
      { kicker: 'Teacher · DM-A', title: 'Module 2 exam moved', body: 'Same syllabus. Hall A, 10:00. — Nithin Raj', branch: 'TVM', author: 'nithin', role: 'teacher', pinned: false, ack: false, audience: [{ type: 'batch' as const, value: batchByCode['DM-A']!.id, label: 'Batch · DM-A' }], recipients: students.filter((x) => x.batch.code === 'DM-A').map((x) => x.userId), readPct: 0.93, ago: -1 },
    ];
    for (const a of annRows) {
      const aid = id();
      const uniq = [...new Set(a.recipients)];
      await db.insert(s.announcement).values({
        id: aid,
        institutionId,
        branchId: branchIds[a.branch],
        authorUserId: userIds[a.author]!,
        authorRoleKey: a.role,
        kicker: a.kicker,
        title: a.title,
        body: a.body,
        audience: a.audience,
        publishAt: addDaysDate(now, a.ago),
        expiresAt: addDaysDate(now, 14),
        pinned: a.pinned,
        ackRequired: a.ack,
        alsoWhatsapp: true,
        status: 'published',
        recipientCount: uniq.length,
      });
      await insertMany(
        db,
        s.announcementRecipient,
        uniq.map((u) => {
          const read = R.chance(a.readPct);
          return { announcementId: aid, userId: u, readAt: read ? addDaysDate(now, a.ago + 1) : null, ackedAt: a.ack && read && R.chance(0.9) ? addDaysDate(now, a.ago + 1) : null };
        }),
        1000,
      );
    }
    void allStudentUsers;

    /* ── notifications ── */
    const anjali = students.find((x) => x.name === 'Anjali Menon')!;
    const rohan = students.find((x) => x.name === 'Rohan Menon')!;
    const notif = (user: string, category: string, title: string, body: string, minsAgo: number, link: string | null = null) => ({
      userId: user,
      category: category as never,
      title,
      body,
      link,
      createdAt: new Date(now.getTime() - minsAgo * 60_000),
    });
    await insertMany(db, s.notification, [
      notif(userIds.joseph!, 'payment', 'Payment received · ₹15,000', `${students[30]!.name} · UPI · receipt sent by WhatsApp`, 2, '/finance/invoices'),
      notif(userIds.joseph!, 'admission', 'Fee verification waiting', 'Kiran Thomas · DA-C · 12% discount requested', 40, '/finance'),
      notif(userIds.priya!, 'marks', 'Marks submitted · Sprint 2 · React', 'FS-B · Sanjay Kumar · ready to publish', 25, '/marks-publishing'),
      notif(userIds.priya!, 'attendance', 'Attendance below 75%', `Rohan Menon · FS-B · ${await pct(h, rohan.enrollmentId)}% after today`, 60, '/students'),
      notif(userIds.priya!, 'admission', 'Admission ready for approval', 'Divya Pillai · DM-B · fee terms verified', 90, '/admissions'),
      notif(userIds.deepu!, 'approval', 'Discount 22% needs your approval', 'Aiswarya Suresh · FS-C · verified by Finance', 180, '/overview'),
      notif(userIds.deepu!, 'payment', 'Collections update', 'Trivandrum at 87% of monthly target', 300, '/finance'),
      notif(userIds.nithin!, 'leave', 'Leave approved', `${'Casual'} · ${leaveNithin} · substitute will be assigned`, 2880, '/teacher'),
      notif(anjali.userId, 'fee_due', 'Instalment 2 · ₹15,000 due', 'Fee-gated notes unlock as soon as the payment clears', 600, '/student/fees'),
      notif(anjali.userId, 'marks', 'Marks published · Module 1', 'Foundations · view your score', 1500, '/student/marks'),
      notif(sureshUserId, 'fee_due', 'Fee overdue · Rohan', '₹15,000 overdue for FS-B · pay online', 1440, '/parent/fees'),
      notif(sureshUserId, 'attendance', 'Rohan absent today', 'FS-B · Full Stack · marked absent', 300, '/parent/attendance'),
      notif(sureshUserId, 'marks', 'Marks published · Anjali', 'Module 1 · Foundations', 1500, '/parent/marks'),
      notif(userIds.meera!, 'lead', 'New lead assigned', 'Referral · Digital Marketing · first response timer started', 15, '/sales/pipeline'),
    ]);

    /* ── audit log (recent activity) ── */
    const audit = (minsAgo: number, actor: string, roleKey: string, roleLabel: string, action: string, kind: string, entityType: string, summary: string, ip: string) => ({
      at: new Date(now.getTime() - minsAgo * 60_000),
      actorUserId: userIds[actor],
      actorName: userNames[actor]!,
      roleKey,
      roleLabel,
      action,
      actionKind: kind,
      entityType,
      entityId: id(),
      summary,
      ip,
    });
    await insertMany(db, s.auditLog, [
      audit(9, 'joseph', 'finance', 'Finance', 'Payment recorded', 'payment', 'payment', '₹15,000 UPI → invoice Paid', '103.21.•••.14'),
      audit(14, 'priya', 'branchadmin', 'Branch Admin', 'Marks published', 'publish', 'exam', 'draft → published · Module 1 · Foundations', '103.21.•••.9'),
      audit(31, 'meera', 'sales', 'Sales', 'Lead stage changed', 'update', 'lead', 'Negotiation → Admission in progress', '49.37.•••.201'),
      audit(53, 'deepu', 'superadmin', 'Super Admin', 'Impersonation started', 'impersonate', 'user', 'view as student · 15 min · reason: support', '103.21.•••.2'),
      audit(70, 'nithin', 'teacher', 'Teacher', 'Attendance edited', 'update', 'class_session', 'Sandeep M: absent → late (within 48 h)', '49.37.•••.77'),
      audit(99, 'joseph', 'finance', 'Finance', 'Export', 'export', 'report', 'Dues CSV · watermarked', '103.21.•••.14'),
      audit(240, 'joseph', 'finance', 'Finance', 'Fee terms verified', 'approve', 'admission', 'Aiswarya Suresh · discount 22% → Super Admin', '103.21.•••.14'),
      audit(1440, 'priya', 'branchadmin', 'Branch Admin', 'Leave approved', 'approve', 'leave', `Nithin Raj · ${leaveNithin}`, '103.21.•••.9'),
    ]);

    /* ── parent messages / PTM ── */
    await db.insert(s.parentMessage).values({ guardianUserId: sureshUserId, studentId: rohan.id, teacherUserId: userIds.sanjay, body: 'Could you share how Rohan is doing in React sprint 2?', status: 'delivered', reply: 'He is catching up — attendance is the main concern.' });

    await flushApiCaches();
    console.log(`✓ seeded · anchor ${anchor} · ${students.length} students · ${leadRows.length} leads · ${finEvents.length} finance documents`);
  } finally {
    await h.close();
  }
}

/**
 * A reseed replaces every id, so drop the API's Redis caches (memberships,
 * branches, public config…) and bump the access version that keys them.
 */
async function flushApiCaches(): Promise<void> {
  const prefix = process.env.REDIS_PREFIX ?? 'exa';
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379/0', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:cache:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
    await redis.incr(`${prefix}:access:ver`);
  } catch (err) {
    console.warn(`(could not flush API caches in Redis: ${(err as Error).message})`);
  } finally {
    redis.disconnect();
  }
}

async function pct(h: ReturnType<typeof createDb>, enrollmentId: string): Promise<number> {
  const r = await h.sql<{ attendance_pct: number }[]>`select attendance_pct from enrollment where id = ${enrollmentId}`;
  return r[0]?.attendance_pct ?? 0;
}

function addDaysDate(d: Date, days: number, hours = 0): Date {
  return new Date(d.getTime() + days * 86_400_000 + hours * 3_600_000);
}

function clampDate(d: string, min: string, max: string): string {
  return d < min ? min : d > max ? max : d;
}

function roundTo(paise: number, step: number): number {
  return Math.max(step, Math.round(paise / step) * step);
}

function topicFor(course: string, date: string): string {
  const topics: Record<string, string[]> = {
    DM: ['SEO playbook', 'Keyword research', 'Google Ads lab', 'Analytics setup', 'Content calendar', 'Landing pages'],
    FS: ['React state', 'Hooks deep-dive', 'REST clients', 'Routing', 'Testing components', 'Forms'],
    DA: ['Joins', 'Window functions', 'Normalisation', 'Pivot tables', 'Dashboards', 'Data cleaning'],
    UX: ['User interviews', 'Wireframes', 'Prototyping', 'Usability tests', 'Design systems'],
  };
  const list = topics[course] ?? ['Session'];
  const n = Number(date.replace(/-/g, '')) % list.length;
  return list[n]!;
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
