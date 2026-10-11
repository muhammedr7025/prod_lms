import { Injectable } from '@nestjs/common';
import type { AcadFeeStatus, AcadStudentDetail, AcadStudentRow, AcadTag, AcadTransferOptions } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, inArray, ne, or, sql, type SQL } from '@exatech/db';
import {
  addDays,
  daysBetween,
  formatDate,
  formatDayMonth,
  formatINR,
  formatPhone,
  formatWeekdayDate,
  maskPhone,
  mondayOf,
  normalizePhone,
  quoteFee,
  todayIST,
  toISTDate,
  transferAdjustment,
  weekday,
} from '@exatech/domain';
import crypto from 'node:crypto';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, assertInScope, branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { AcademicsShared, scopeSql } from './academics.shared';
import { CardTokens } from './card-tokens';

const ATT_LABEL = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' } as const;
const ATT_TAG: Record<string, AcadTag> = { P: 'accent', A: 'ink', L: 'neutral', E: 'outline' };
const ENR_LABEL: Record<string, string> = { active: 'Active', on_hold: 'On hold', transferred: 'Transferred', dropped: 'Dropped', completed: 'Completed' };

export function feeStatusOf(overdue: number, partial: number): { status: AcadFeeStatus; label: string; tag: AcadTag } {
  if (overdue > 0) return { status: 'overdue', label: `${formatINR(overdue)} overdue`, tag: 'ink' };
  if (partial > 0) return { status: 'partial', label: 'Partially paid', tag: 'neutral' };
  return { status: 'cleared', label: 'Cleared', tag: 'accent' };
}

/** Students directory, profile panel data, batch transfer and ID-card reissue. */
@Injectable()
export class StudentsService {
  constructor(
    private readonly db: Db,
    private readonly shared: AcademicsShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly cards: CardTokens,
  ) {}

  /* ───────────────────────── Directory ───────────────────────── */

  async list(q: { q?: string; batchId?: string; fee?: AcadFeeStatus; lowAttendance?: 'true' | 'false'; cursor?: string; limit: number }) {
    const today = todayIST();
    const settings = await this.shared.settings();
    const where: SQL[] = [scopeSql(sql`st.branch_id`), sql`st.status = 'active'`];
    const term = q.q?.trim();
    if (term) {
      const token = this.cards.resolve(term);
      if (token !== undefined) {
        where.push(token ? sql`st.card_token = ${token}` : sql`false`);
      } else {
        const like = `%${term.replace(/[%_\\]/g, '')}%`;
        const digits = term.replace(/\D/g, '');
        const phone = normalizePhone(term);
        const ors: SQL[] = [sql`st.name ilike ${like}`, sql`st.admission_no ilike ${like}`];
        if (phone) ors.push(sql`st.phone = ${phone}`, sql`g.phone = ${phone}`);
        if (digits.length >= 4) ors.push(sql`st.phone like ${`%${digits}%`}`, sql`g.phone like ${`%${digits}%`}`);
        where.push(sql`(${sql.join(ors, sql` or `)})`);
      }
    }
    if (q.batchId) where.push(sql`e.batch_id = ${q.batchId}`);
    if (q.lowAttendance === 'true') where.push(sql`coalesce(e.attendance_pct, 100) < ${settings.lowAttendanceThreshold}`);
    if (q.fee === 'overdue') where.push(sql`coalesce(f.overdue, 0) > 0`);
    if (q.fee === 'partial') where.push(sql`coalesce(f.overdue, 0) = 0 and coalesce(f.partial, 0) > 0`);
    if (q.fee === 'cleared') where.push(sql`coalesce(f.overdue, 0) = 0 and coalesce(f.partial, 0) = 0`);

    const base = sql`
      from student st
      left join lateral (
        select e.id, e.status, e.batch_id, e.attendance_pct from enrollment e
        where e.student_id = st.id order by (e.status = 'active') desc, e.joined_on desc, e.created_at desc limit 1
      ) e on true
      left join batch b on b.id = e.batch_id
      left join lateral (
        select g.name, g.phone, sg.relationship from student_guardian sg join guardian g on g.id = sg.guardian_id
        where sg.student_id = st.id order by sg.is_primary desc limit 1
      ) g on true
      left join lateral (
        select sum(greatest(i.amount - i.paid - i.waived, 0)) filter (where i.due_date < ${today}) as overdue,
               count(*) filter (where i.paid > 0 and i.paid < i.amount) as partial
        from instalment i join enrollment e2 on e2.id = i.enrollment_id
        where e2.student_id = st.id and e2.status in ('active', 'transferred', 'on_hold') and i.status not in ('cancelled', 'waived')
      ) f on true
      where ${sql.join(where, sql` and `)}`;

    let cursorCond = sql`true`;
    if (q.cursor) {
      const i = q.cursor.lastIndexOf('|');
      const name = q.cursor.slice(0, i);
      const id = q.cursor.slice(i + 1);
      if (name && id) cursorCond = sql`(st.name, st.id) > (${name}, ${id}::uuid)`;
    }
    const rows = await this.db.db.execute<{
      id: string;
      name: string;
      admission_no: string | null;
      batch_id: string | null;
      batch_code: string | null;
      enrollment_status: string | null;
      attendance_pct: number | null;
      guardian_name: string | null;
      guardian_phone: string | null;
      overdue: string | null;
      partial: string | null;
    }>(sql`
      select st.id, st.name, st.admission_no, e.batch_id, b.code as batch_code, e.status as enrollment_status, e.attendance_pct,
             g.name as guardian_name, g.phone as guardian_phone, f.overdue, f.partial
      ${base} and ${cursorCond}
      order by st.name, st.id
      limit ${q.limit + 1}`);
    const [count] = await this.db.db.execute<{ n: string }>(sql`select count(*) as n ${base}`);
    const [active] = await this.db.db.execute<{ n: string }>(sql`
      select count(distinct st.id) as n from student st join enrollment e on e.student_id = st.id and e.status = 'active'
      where ${scopeSql(sql`st.branch_id`)} and st.status = 'active'`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const items: AcadStudentRow[] = page.map((r) => {
      const fee = feeStatusOf(Number(r.overdue ?? 0), Number(r.partial ?? 0));
      return {
        id: r.id,
        admissionNo: r.admission_no,
        name: r.name,
        batchId: r.batch_id,
        batchCode: r.batch_code,
        guardian: r.guardian_name ? `${r.guardian_name} · ${maskPhone(r.guardian_phone)}` : '—',
        attendancePct: Number(r.attendance_pct ?? 100),
        feeStatus: fee.status,
        feeLabel: fee.label,
        feeTag: fee.tag,
        enrollmentLabel: r.enrollment_status ? (ENR_LABEL[r.enrollment_status] ?? r.enrollment_status) : 'Not enrolled',
      };
    });
    const batches = await this.db.db
      .select({ id: s.batch.id, code: s.batch.code })
      .from(s.batch)
      .where(and(scopeSql(sql`${s.batch.branchId}`), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist'])))
      .orderBy(asc(s.batch.code));
    return {
      items,
      nextCursor: rows.length > q.limit && last ? `${last.name}|${last.id}` : null,
      total: Number(count?.n ?? 0),
      activeTotal: Number(active?.n ?? 0),
      branchLabel: await this.shared.branchLabel(),
      batches,
    };
  }

  /* ───────────────────────── Profile panel ───────────────────────── */

  private async loadStudent(id: string) {
    const [st] = await this.db.db.select().from(s.student).where(eq(s.student.id, id));
    if (!st) throw notFound('Student');
    const sc = branchScope();
    const enrollments = await this.db.db
      .select({ e: s.enrollment, batchCode: s.batch.code, batchStart: s.batch.startDate, batchEnd: s.batch.endDate, courseName: s.course.name, courseId: s.course.id })
      .from(s.enrollment)
      .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .innerJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(eq(s.enrollment.studentId, id))
      .orderBy(desc(s.enrollment.joinedOn), desc(s.enrollment.createdAt));
    if (sc && !sc.includes(st.branchId) && !enrollments.some((x) => sc.includes(x.e.branchId))) assertInScope(st.branchId);
    return { st, enrollments };
  }

  async detail(id: string): Promise<AcadStudentDetail> {
    const today = todayIST();
    const { st, enrollments } = await this.loadStudent(id);
    const current = enrollments.find((x) => x.e.status === 'active') ?? enrollments[0] ?? null;
    const enrIds = enrollments.map((x) => x.e.id);
    const [branch] = await this.db.db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, st.branchId));
    const guardians = await this.db.db
      .select({ name: s.guardian.name, phone: s.guardian.phone, email: s.guardian.email, relationship: s.studentGuardian.relationship })
      .from(s.studentGuardian)
      .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
      .where(eq(s.studentGuardian.studentId, id))
      .orderBy(desc(s.studentGuardian.isPrimary));
    const [portal] = st.userId ? await this.db.db.select({ status: s.user.status, lastLoginAt: s.user.lastLoginAt }).from(s.user).where(eq(s.user.id, st.userId)) : [];

    // Fee account (instalments across this student's live enrollments).
    const feeEnr = enrollments.filter((x) => ['active', 'transferred', 'on_hold'].includes(x.e.status)).map((x) => x.e.id);
    const inst = feeEnr.length
      ? await this.db.db
          .select()
          .from(s.instalment)
          .where(and(inArray(s.instalment.enrollmentId, feeEnr), ne(s.instalment.status, 'cancelled')))
          .orderBy(asc(s.instalment.dueDate), asc(s.instalment.seq))
      : [];
    const bal = (i: (typeof inst)[number]) => (i.status === 'waived' ? 0 : Math.max(0, i.amount - i.paid - i.waived));
    const nextDue = inst.find((i) => bal(i) > 0);
    const overdue = inst.filter((i) => i.dueDate < today).reduce((a, i) => a + bal(i), 0);
    const partial = inst.filter((i) => i.paid > 0 && i.paid < i.amount).length;
    const fee = feeStatusOf(overdue, partial);
    const balance = inst.reduce((a, i) => a + bal(i), 0);
    const feeRows = inst.map((i) => {
      const b = bal(i);
      let status = 'Not due';
      let tag: AcadTag = 'neutral';
      if (i.status === 'waived') [status, tag] = ['Waived', 'plain'];
      else if (b === 0) [status, tag] = ['Paid', 'accent'];
      else if (i.dueDate < today) [status, tag] = [`Overdue ${daysBetween(i.dueDate, today)} day${daysBetween(i.dueDate, today) > 1 ? 's' : ''}`, 'ink'];
      else if (i.dueDate === today) [status, tag] = ['Due today', 'outline'];
      else if (i.paid > 0) [status, tag] = ['Partially paid', 'neutral'];
      return { id: i.id, name: i.label, due: i.dueDate, dueLabel: formatDayMonth(i.dueDate), amount: i.amount, paid: i.paid, balance: b, status, tag, highlight: nextDue?.id === i.id };
    });

    // Attendance (recent 8) — ad-hoc sessions shown, counted only when acknowledged.
    const att = enrIds.length
      ? await this.db.db
          .select({ date: s.classSession.date, start: s.classSession.startTime, topic: s.classSession.topic, subject: s.classSession.subjectName, status: s.attendance.status, kind: s.classSession.kind, ack: s.classSession.acknowledgedAt })
          .from(s.attendance)
          .innerJoin(s.classSession, eq(s.classSession.id, s.attendance.sessionId))
          .where(inArray(s.attendance.enrollmentId, enrIds))
          .orderBy(desc(s.classSession.date), desc(s.classSession.startTime))
          .limit(8)
      : [];

    // Published marks only (drafts are never shown).
    const marks = enrIds.length
      ? await this.db.db.execute<{ exam_id: string; name: string; date: string; published_at: Date | null; score: string | null; max: string | null; average: string | null }>(sql`
          select ex.id as exam_id, ex.name, ex.date::text as date, ex.published_at,
            (select sum(m.value) from mark m where m.exam_id = ex.id and m.enrollment_id in (${sql.join(enrIds.map((x) => sql`${x}::uuid`), sql`, `)})) as score,
            (select sum(c.max_marks) from exam_component c where c.exam_id = ex.id) as max,
            (select avg(t.total) from (
               select m.enrollment_id, sum(m.value) as total, count(m.value) as filled from mark m where m.exam_id = ex.id group by m.enrollment_id
             ) t where t.filled = (select count(*) from exam_component c2 where c2.exam_id = ex.id)) as average
          from exam ex
          where ex.status = 'published' and ex.batch_id in (select batch_id from enrollment where id in (${sql.join(enrIds.map((x) => sql`${x}::uuid`), sql`, `)}))
          order by ex.date desc`)
      : [];

    // Work: unsubmitted assignments for the current enrollment.
    let pending = 0;
    let missed = 0;
    if (current && current.e.status === 'active') {
      const work = await this.db.db.execute<{ pending: string; missed: string }>(sql`
        select count(*) filter (where a.due_at >= now()) as pending, count(*) filter (where a.due_at < now() and a.due_at >= ${current.e.joinedOn}::timestamp) as missed
        from assignment a
        where a.batch_id = ${current.e.batchId}
          and not exists (select 1 from submission sb where sb.assignment_id = a.id and sb.enrollment_id = ${current.e.id})`);
      pending = Number(work[0]?.pending ?? 0);
      missed = Number(work[0]?.missed ?? 0);
    }

    // Documents (student and admission application).
    const admissionIds = enrollments.map((x) => x.e.admissionId).filter((x): x is string => !!x);
    const docs = await this.db.db
      .select({ label: s.document.label, status: s.document.status })
      .from(s.document)
      .where(or(and(eq(s.document.ownerType, 'student'), eq(s.document.ownerId, id)), admissionIds.length ? and(eq(s.document.ownerType, 'admission'), inArray(s.document.ownerId, admissionIds)) : undefined));

    // Timeline.
    const timeline: { at: Date; text: string }[] = [];
    const first = enrollments[enrollments.length - 1];
    if (first) timeline.push({ at: new Date(`${first.e.joinedOn}T09:00:00+05:30`), text: `Admitted to ${first.batchCode} · ${st.admissionNo ?? 'no admission number'}` });
    const payments = enrIds.length
      ? await this.db.db
          .select({ at: s.payment.receivedAt, total: s.payment.total, status: s.payment.status, number: s.receipt.number })
          .from(s.payment)
          .leftJoin(s.receipt, eq(s.receipt.paymentId, s.payment.id))
          .where(and(inArray(s.payment.enrollmentId, enrIds), inArray(s.payment.status, ['cleared', 'pending_clearance', 'bounced', 'voided'])))
          .orderBy(desc(s.payment.receivedAt))
          .limit(10)
      : [];
    for (const p of payments) {
      const verb = p.status === 'voided' ? 'Payment voided' : p.status === 'bounced' ? 'Cheque bounced' : p.status === 'pending_clearance' ? 'Payment awaiting clearance' : 'Paid';
      timeline.push({ at: p.at, text: `${verb} ${formatINR(p.total)}${p.number ? ` · receipt ${p.number}` : ''}` });
    }
    const transfers = enrIds.length
      ? await this.db.db
          .select({ t: s.enrollmentTransfer })
          .from(s.enrollmentTransfer)
          .where(or(inArray(s.enrollmentTransfer.fromEnrollmentId, enrIds), inArray(s.enrollmentTransfer.toEnrollmentId, enrIds)))
      : [];
    for (const { t } of transfers) {
      const from = enrollments.find((x) => x.e.id === t.fromEnrollmentId)?.batchCode ?? '—';
      const to = enrollments.find((x) => x.e.id === t.toEnrollmentId)?.batchCode ?? '—';
      timeline.push({ at: t.createdAt, text: `Transferred ${from} → ${to} from ${formatDayMonth(t.effectiveDate)}${t.adjustment ? ` · adjustment ${t.adjustment > 0 ? '+' : ''}${formatINR(t.adjustment)}` : ''} · ${t.reason}` });
    }
    const absences = enrIds.length
      ? await this.db.db
          .select({ date: s.classSession.date, start: s.classSession.startTime, code: s.batch.code })
          .from(s.attendance)
          .innerJoin(s.classSession, eq(s.classSession.id, s.attendance.sessionId))
          .innerJoin(s.batch, eq(s.batch.id, s.classSession.batchId))
          .where(and(inArray(s.attendance.enrollmentId, enrIds), eq(s.attendance.status, 'A'), gte(s.classSession.date, addDays(today, -30))))
          .orderBy(desc(s.classSession.date))
          .limit(6)
      : [];
    for (const a of absences) timeline.push({ at: new Date(`${a.date}T${a.start}:00+05:30`), text: `Absent · ${a.code} ${a.start}` });
    for (const m of marks) if (m.published_at) timeline.push({ at: new Date(m.published_at), text: `Marks published · ${m.name} · ${Number(m.score ?? 0)} / ${Number(m.max ?? 0)}` });
    timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

    const g = guardians[0];
    const attPct = current?.e.attendancePct ?? 100;
    const settings = await this.shared.settings();
    const cleared = current?.e.feeCleared ?? true;
    const facts: [string, string][] = [
      ['Admission no.', st.admissionNo ?? '—'],
      ['Batch', current ? `${current.batchCode} · ${current.courseName}` : '—'],
      ['Branch', branch?.name ?? '—'],
      ['Joined', current ? formatDate(current.e.joinedOn) : '—'],
      ['Phone', formatPhone(st.phone)],
      ['Email', st.email ?? '—'],
      ['Date of birth', st.dob ? formatDate(st.dob) : '—'],
      ['Address', st.address ?? '—'],
      ['Guardian', g ? `${g.name} · ${g.relationship} · ${formatPhone(g.phone)}` : '—'],
      ['Fee plan', current?.e.feePlanName ? `${current.e.feePlanName} · ${formatINR(current.e.feeTotal)}` : '—'],
      ['Fee clearance', cleared ? (current?.e.exemptUntil && current.e.exemptUntil >= today ? `Exempt until ${formatDayMonth(current.e.exemptUntil)}` : 'Cleared · notes unlocked') : 'Not cleared · fee-gated notes locked'],
      ['Portal', portal ? (portal.status === 'active' ? `Active${portal.lastLoginAt ? ` · last sign-in ${formatDayMonth(toISTDate(portal.lastLoginAt))}` : ''}` : portal.status === 'invited' ? 'Invited · not signed in yet' : 'Deactivated') : 'No account'],
    ];
    const lockedOn = inst.find((i) => i.dueDate <= today && bal(i) > 0);
    return {
      id: st.id,
      userId: st.userId,
      name: st.name,
      admissionNo: st.admissionNo,
      branchId: st.branchId,
      branchName: branch?.name ?? '',
      enrollmentId: current?.e.id ?? null,
      enrollmentStatus: current?.e.status ?? null,
      batchId: current?.e.batchId ?? null,
      batchCode: current?.batchCode ?? null,
      courseName: current?.courseName ?? null,
      sub: [current?.batchCode, current?.courseName, st.admissionNo].filter(Boolean).join(' · '),
      tag: cleared ? 'Fee cleared' : `Locked · ${lockedOn ? `${lockedOn.label.split(' ·')[0]!.replace(/^(\d+)$/, 'instalment $1')} overdue` : 'fees due'}`,
      tagVariant: cleared ? 'accent' : 'ink',
      kpis: {
        attendancePct: attPct,
        attendanceNote: attPct < settings.lowAttendanceThreshold ? `below ${settings.lowAttendanceThreshold}%` : 'on track',
        feeBalance: balance,
        feeNext: nextDue ? `${formatINR(bal(nextDue))} · ${nextDue.dueDate < today ? `overdue since ${formatDayMonth(nextDue.dueDate)}` : formatDayMonth(nextDue.dueDate)}` : 'nothing due',
        publishedMarks: marks.length,
        pendingWork: pending + missed,
        pendingNote: missed ? `${missed} missed · ${pending} open` : 'assignments',
      },
      facts,
      fee: { label: fee.label, tag: fee.tag, rows: feeRows },
      attendance: att.map((a) => ({
        date: a.date,
        label: formatWeekdayDate(a.date),
        topic: `${a.topic ?? a.subject}${a.kind === 'adhoc' ? (a.ack ? ' · ad-hoc' : ' · ad-hoc, awaiting acknowledgement') : ''}`,
        status: a.status,
        statusLabel: ATT_LABEL[a.status],
        tag: ATT_TAG[a.status] ?? 'neutral',
      })),
      marks: marks.map((m) => ({
        examId: m.exam_id,
        name: m.name,
        when: formatDayMonth(m.date),
        average: m.average == null ? '—' : String(Math.round(Number(m.average) * 10) / 10),
        score: Number(m.score ?? 0),
        max: Number(m.max ?? 0),
      })),
      documents: docs.map((d) => `${d.label}${d.status === 'verified' ? ' · verified' : d.status === 'missing' ? ' · missing' : d.status === 'rejected' ? ' · rejected' : ''}`),
      timeline: timeline.slice(0, 12).map((t) => ({ at: t.at.toISOString(), when: formatDayMonth(toISTDate(t.at)), text: t.text })),
      card: { issuedAt: st.cardIssuedAt?.toISOString() ?? null },
    };
  }

  /* ───────────────────────── Transfer ───────────────────────── */

  async transferOptions(id: string): Promise<AcadTransferOptions> {
    const { enrollments } = await this.loadStudent(id);
    const current = enrollments.find((x) => x.e.status === 'active');
    if (!current) throw conflict('This student has no active enrollment to transfer');
    const [fromBatch] = await this.db.db.select().from(s.batch).where(eq(s.batch.id, current.e.batchId));
    const sc = ctx().membershipBranchIds;
    const targets = await this.db.db
      .select({
        b: s.batch,
        planComponents: s.feePlan.components,
        planGst: s.feePlan.gstRate,
        enrolled: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.batch.id} and e.status = 'active')`,
      })
      .from(s.batch)
      .leftJoin(s.feePlan, eq(s.feePlan.id, s.batch.feePlanId))
      .where(and(eq(s.batch.courseId, current.courseId), ne(s.batch.id, current.e.batchId), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']), sc ? inArray(s.batch.branchId, sc) : undefined))
      .orderBy(asc(s.batch.code));
    const today = todayIST();
    const wd = weekday(today);
    const nextMonday = wd === 1 ? today : addDays(mondayOf(today), 7);
    return {
      enrollmentId: current.e.id,
      from: { batchId: current.e.batchId, code: current.batchCode, startDate: fromBatch!.startDate, endDate: fromBatch!.endDate, feeTotal: current.e.feeTotal },
      targets: targets.map((t) => {
        const seatsLeft = t.b.capacity - Number(t.enrolled);
        const total = t.planComponents ? quoteFee(t.planComponents, current.e.discountPct, t.planGst ?? 18).total : current.e.feeTotal;
        const ended = t.b.endDate < today;
        return {
          batchId: t.b.id,
          code: t.b.code,
          label: `${t.b.code} · ${seatsLeft > 0 ? `${seatsLeft} seat${seatsLeft > 1 ? 's' : ''} left` : 'full'} · ${t.b.scheduleLabel ?? ''}${t.b.startDate > today ? ` · starts ${formatDayMonth(t.b.startDate)}` : ''}`,
          seatsLeft,
          feeTotal: total,
          disabled: seatsLeft <= 0 || ended,
          reason: seatsLeft <= 0 ? `${t.b.code} is full` : ended ? `${t.b.code} has ended` : null,
        };
      }),
      defaultEffectiveDate: nextMonday,
    };
  }

  async transfer(id: string, body: { toBatchId: string; effectiveDate: string; reason: string }) {
    const today = todayIST();
    if (body.effectiveDate < today) throw invalid('The effective date cannot be in the past', { effectiveDate: 'Past date' });
    return this.db.tx(async (tx) => {
      const [st] = await tx.select().from(s.student).where(eq(s.student.id, id));
      if (!st) throw notFound('Student');
      const [from] = await tx.select().from(s.enrollment).where(and(eq(s.enrollment.studentId, id), eq(s.enrollment.status, 'active'))).orderBy(desc(s.enrollment.joinedOn)).limit(1).for('update');
      if (!from) throw conflict('This student has no active enrollment to transfer');
      assertInScope(from.branchId);
      const [fromBatch] = await tx.select().from(s.batch).where(eq(s.batch.id, from.batchId));
      const [to] = await tx.select().from(s.batch).where(eq(s.batch.id, body.toBatchId)).for('update');
      if (!to) throw notFound('Target batch');
      assertBranchAccess(to.branchId);
      if (to.id === from.batchId) throw invalid('Choose a different batch', { toBatchId: 'Same batch' });
      if (to.courseId !== fromBatch!.courseId) throw invalid('Transfers stay within the same course', { toBatchId: 'Different course' });
      if (!['planned', 'open', 'running', 'waitlist'].includes(to.status)) throw invalid(`${to.code} is ${to.status}`, { toBatchId: 'Closed' });
      if (body.effectiveDate > to.endDate) throw invalid(`${to.code} ends on ${formatDayMonth(to.endDate)}`, { effectiveDate: 'After the batch ends' });
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.enrollment).where(and(eq(s.enrollment.batchId, to.id), eq(s.enrollment.status, 'active')));
      if (Number(n) >= to.capacity) throw conflict(`${to.code} is full (${to.capacity} seats)`);
      const [plan] = to.feePlanId ? await tx.select().from(s.feePlan).where(eq(s.feePlan.id, to.feePlanId)) : [];
      const toTotal = plan ? quoteFee(plan.components, from.discountPct, plan.gstRate).total : from.feeTotal;
      const span = Math.max(1, daysBetween(fromBatch!.startDate, fromBatch!.endDate));
      const progressPct = Math.max(0, Math.min(100, Math.round((daysBetween(fromBatch!.startDate, body.effectiveDate) / span) * 100)));
      const adjustment = transferAdjustment(from.feeTotal, toTotal, progressPct);

      await tx.update(s.enrollment).set({ status: 'transferred', leftOn: body.effectiveDate }).where(eq(s.enrollment.id, from.id));
      const [created] = await tx
        .insert(s.enrollment)
        .values({
          studentId: id,
          batchId: to.id,
          branchId: to.branchId,
          status: 'active',
          joinedOn: body.effectiveDate,
          feePlanId: from.feePlanId,
          feePlanName: from.feePlanName,
          feeTotal: from.feeTotal,
          discountPct: from.discountPct,
          feeCleared: from.feeCleared,
          clearedUntil: from.clearedUntil,
          clearanceReason: from.clearanceReason,
          exemptUntil: from.exemptUntil,
          exemptReason: from.exemptReason,
          admissionId: from.admissionId,
        })
        .returning();
      await tx.insert(s.enrollmentTransfer).values({ fromEnrollmentId: from.id, toEnrollmentId: created!.id, effectiveDate: body.effectiveDate, reason: body.reason, adjustment, createdBy: ctx().userId });
      // Future attendance scope moves with the student: the old batch roster no longer includes them from the effective date.
      await tx.execute(sql`delete from attendance a using class_session cs where cs.id = a.session_id and a.enrollment_id = ${from.id} and cs.date >= ${body.effectiveDate}`);
      if (to.branchId !== st.branchId) {
        await tx.update(s.student).set({ branchId: to.branchId }).where(eq(s.student.id, id));
        if (st.userId) {
          await tx.execute(sql`update membership set branch_ids = array[${to.branchId}::uuid], scope_label = ${to.code}
            where user_id = ${st.userId} and role_id in (select id from role where key = 'student')`);
        }
      } else if (st.userId) {
        await tx.execute(sql`update membership set scope_label = ${to.code} where user_id = ${st.userId} and role_id in (select id from role where key = 'student')`);
      }
      await this.events.emit(tx, 'BatchTransferred', { fromEnrollmentId: from.id, toEnrollmentId: created!.id, studentId: id, adjustment });
      await this.audit.log(tx, {
        action: 'Batch transfer',
        kind: 'update',
        entityType: 'enrollment',
        entityId: created!.id,
        entityLabel: `${st.name} · ${st.admissionNo ?? ''}`,
        before: { batch: fromBatch!.code, enrollmentId: from.id, status: 'active' },
        after: { batch: to.code, enrollmentId: created!.id, effectiveDate: body.effectiveDate, adjustment, progressPct },
        summary: `${st.name} · ${fromBatch!.code} → ${to.code} from ${formatDayMonth(body.effectiveDate)} · course ${progressPct}% done · adjustment ${adjustment >= 0 ? '+' : ''}${formatINR(adjustment)} · ${body.reason}`,
        branchId: from.branchId,
      });
      const guardians = await tx
        .select({ userId: s.guardian.userId })
        .from(s.studentGuardian)
        .innerJoin(s.guardian, eq(s.guardian.id, s.studentGuardian.guardianId))
        .where(eq(s.studentGuardian.studentId, id));
      await this.notify.notify(tx, {
        userIds: [st.userId, ...guardians.map((g) => g.userId)].filter((x): x is string => !!x),
        category: 'timetable',
        title: `Batch changed · ${fromBatch!.code} → ${to.code}`,
        body: `${st.name} moves to ${to.code} (${to.scheduleLabel ?? ''}) from ${formatWeekdayDate(body.effectiveDate)}`,
        link: null,
        entityType: 'enrollment',
        entityId: created!.id,
      });
      this.notify.invalidate(tx, from.branchId, [['academics'], ['students'], ['finance'], ['reference']]);
      if (to.branchId !== from.branchId) this.notify.invalidate(tx, to.branchId, [['academics'], ['reference']]);
      return { toEnrollmentId: created!.id, adjustment };
    });
  }

  async reissueCard(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [st] = await tx.select().from(s.student).where(eq(s.student.id, id)).for('update');
      if (!st) throw notFound('Student');
      assertInScope(st.branchId);
      await tx.update(s.student).set({ cardToken: crypto.randomBytes(18).toString('base64url'), cardIssuedAt: new Date() }).where(eq(s.student.id, id));
      await this.audit.log(tx, {
        action: 'ID card reissued',
        kind: 'update',
        entityType: 'student',
        entityId: id,
        entityLabel: `${st.name} · ${st.admissionNo ?? ''}`,
        summary: `${st.name} · card token rotated · previous QR no longer resolves`,
        branchId: st.branchId,
      });
      this.notify.invalidate(tx, st.branchId, [['academics']]);
    });
  }

  /** Used by the ID-card PDF route (scope-checked there). */
  async cardData(where: SQL) {
    return this.db.db
      .select({
        id: s.student.id,
        name: s.student.name,
        admissionNo: s.student.admissionNo,
        cardToken: s.student.cardToken,
        branchId: s.student.branchId,
        userId: s.student.userId,
        batchCode: s.batch.code,
        batchEnd: s.batch.endDate,
        courseName: s.course.name,
        branchName: s.branch.name,
      })
      .from(s.student)
      .innerJoin(s.branch, eq(s.branch.id, s.student.branchId))
      .leftJoin(s.enrollment, and(eq(s.enrollment.studentId, s.student.id), eq(s.enrollment.status, 'active')))
      .leftJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
      .leftJoin(s.course, eq(s.course.id, s.batch.courseId))
      .where(where)
      .orderBy(asc(s.student.name));
  }

  /** Make sure a card token exists (older imports may lack one). */
  async ensureToken(id: string): Promise<string> {
    const token = crypto.randomBytes(18).toString('base64url');
    const [row] = await this.db.db
      .update(s.student)
      .set({ cardToken: token, cardIssuedAt: new Date() })
      .where(and(eq(s.student.id, id), sql`${s.student.cardToken} is null`))
      .returning({ cardToken: s.student.cardToken });
    if (row?.cardToken) return row.cardToken;
    const [cur] = await this.db.db.select({ cardToken: s.student.cardToken }).from(s.student).where(eq(s.student.id, id));
    return cur!.cardToken!;
  }
}
