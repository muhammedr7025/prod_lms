import { Injectable } from '@nestjs/common';
import { NOTIFICATION_PREFS, PTM_PART_LABEL, type PortalAlerts, type PortalAttendance, type TagVariant } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, gte, inArray, sql } from '@exatech/db';
import { addDays, ATTENDANCE_LABEL, formatLongWeekdayDate, formatRelative, formatWeekdayDate, isValidISODate, todayIST } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { forbidden, invalid } from '../../core/errors';
import { NotifyService } from '../../core/notifications/notify.service';
import { ATT_TAG, firstName, PortalShared, STAFF_HOURS } from './portal.shared';

const ALERT_CATEGORIES = ['attendance', 'fee_due', 'payment', 'marks', 'announcement', 'exam_schedule'] as const;
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', email: 'email', in_app: 'In-app' };

/** "WhatsApp + email" / "WhatsApp" / "In-app" from a channel list. */
function channelLine(channels: readonly string[]): string {
  const ext = channels.filter((c) => c !== 'in_app');
  if (ext.length === 0) return 'In-app';
  const parts = ext.map((c) => CHANNEL_LABEL[c] ?? c);
  return parts.join(' + ');
}

/** Parent · Attendance, Alerts, Message class teacher, Request PTM slot. */
@Injectable()
export class ParentService {
  constructor(
    private readonly shared: PortalShared,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  async attendance(studentId?: string): Promise<PortalAttendance> {
    const sc = await this.shared.resolve(studentId);
    const att = await this.shared.attendance(sc.enrollmentId);
    return {
      kicker: `${sc.name} · ${sc.batchCode}`,
      pct: att.pct,
      threshold: att.threshold,
      low: att.low,
      history: att.rows.slice(0, 60).map((r) => ({
        id: r.sessionId,
        date: r.date,
        dateLabel: `${formatWeekdayDate(r.date)} · ${r.startTime}`,
        topic: r.topic ?? r.subject,
        status: r.status,
        label: ATTENDANCE_LABEL[r.status],
        tagVariant: ATT_TAG[r.status],
      })),
      footer: `Same-day absence alerts by WhatsApp · threshold warning below ${att.threshold}%`,
    };
  }

  async alerts(): Promise<PortalAlerts> {
    const c = ctx();
    const db = this.shared.db.db;
    const [kids, rows, prefs] = await Promise.all([
      this.shared.all(),
      db
        .select()
        .from(s.notification)
        .where(and(eq(s.notification.userId, c.userId), inArray(s.notification.category, [...ALERT_CATEGORIES])))
        .orderBy(desc(s.notification.createdAt))
        .limit(50),
      db.select().from(s.notificationPreference).where(eq(s.notificationPreference.userId, c.userId)),
    ]);
    const now = new Date();
    const items = rows.map((n) => {
      let kind: string;
      let tagVariant: TagVariant;
      let attention = false;
      switch (n.category) {
        case 'attendance':
          if (/absent/i.test(n.title)) [kind, tagVariant, attention] = ['Absence', 'ink', true];
          else [kind, tagVariant] = ['Attendance', 'outline'];
          break;
        case 'fee_due':
          if (/overdue/i.test(`${n.title} ${n.body}`)) [kind, tagVariant, attention] = ['Fee overdue', 'ink', true];
          else [kind, tagVariant] = ['Fee due', 'outline'];
          break;
        case 'payment':
          [kind, tagVariant] = ['Payment', 'accent'];
          break;
        case 'marks':
          [kind, tagVariant] = ['Marks', 'accent'];
          break;
        case 'exam_schedule':
          [kind, tagVariant] = ['Exam', 'outline'];
          break;
        default:
          [kind, tagVariant] = ['Announcement', 'neutral'];
      }
      return { id: n.id, kind, tagVariant, attention, when: formatRelative(n.createdAt, now), title: n.title, body: n.body, link: n.link };
    });
    const pref = (category: string) => {
      const def = NOTIFICATION_PREFS.find((p) => p.category === category)!;
      const chosen = prefs.find((p) => p.category === category)?.channels ?? [...def.defaults];
      const channels = def.mutable ? chosen : [...new Set([...chosen, ...def.defaults])];
      return { def, line: channelLine(channels) };
    };
    const channels: PortalAlerts['channels'] = (['fee_due', 'exam_schedule', 'attendance', 'marks'] as const).map((cat) => {
      const { def, line } = pref(cat);
      return { label: def.label, value: def.mutable ? line : `${line} · cannot mute`, tagVariant: (def.mutable ? 'outline' : 'accent') as TagVariant };
    });
    channels.push({ label: 'Language', value: 'English · മലയാളം soon', tagVariant: 'neutral' });
    return {
      kicker: kids.length === 2 ? 'Both children' : kids.length === 1 ? kids[0]!.name : kids.length > 2 ? 'All children' : 'Alerts',
      items,
      channels,
    };
  }

  /** Message the class teacher: moderated (status pending) and delivered during staff hours. */
  async message(input: { studentId: string; body: string }) {
    const c = ctx();
    if (c.roleKey !== 'parent') throw forbidden('Only a parent can message the class teacher');
    const sc = await this.shared.resolve(input.studentId);
    const db = this.shared.db;
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [recent] = await db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.parentMessage)
      .where(and(eq(s.parentMessage.guardianUserId, c.userId), gte(s.parentMessage.createdAt, since)));
    if (Number(recent?.n ?? 0) >= 5) throw invalid('You have sent 5 messages in the last 24 hours — the class teacher will reply soon');
    const teachers = await this.shared.batchTeachers(sc.batchId);
    const primary = teachers[0];
    const id = await db.tx(async (tx) => {
      const [row] = await tx
        .insert(s.parentMessage)
        .values({ guardianUserId: c.userId, studentId: sc.studentId, teacherUserId: primary?.id ?? null, body: input.body, status: 'pending' })
        .returning({ id: s.parentMessage.id });
      await this.audit.log(tx, {
        action: 'Parent message sent',
        kind: 'create',
        entityType: 'parent_message',
        entityId: row!.id,
        entityLabel: `${c.userName} → ${primary?.name ?? 'class teacher'}`,
        summary: `About ${sc.name} (${sc.batchCode}) · pending moderation`,
        branchId: sc.branchId,
      });
      // Moderated: Branch Admins approve first; the teacher is notified on approval.
      const moderators = await this.shared.branchAdmins(sc.branchId, tx);
      if (moderators.length) {
        await this.notify.notify(tx, {
          userIds: moderators,
          category: 'message',
          title: `Parent message to moderate · ${sc.batchCode}`,
          body: `${c.userName} (parent of ${sc.name}) → ${primary?.name ?? 'class teacher'}`,
          link: '/branch',
          entityType: 'parent_message',
          entityId: row!.id,
        });
      }
      return row!.id;
    });
    return { id, status: 'pending' as const, note: `Sent for moderation · ${primary ? `${primary.name} replies` : 'the class teacher replies'} during staff hours (${STAFF_HOURS})` };
  }

  /** Request a parent–teacher meeting slot (date + part of day); teacher and branch admins are notified. */
  async ptm(input: { studentId: string; date: string; part: 'morning' | 'afternoon' | 'evening'; note?: string }) {
    const c = ctx();
    if (c.roleKey !== 'parent') throw forbidden('Only a parent can request a PTM slot');
    const sc = await this.shared.resolve(input.studentId);
    const today = todayIST();
    if (!isValidISODate(input.date)) throw invalid('Choose a valid date', { date: 'Invalid date' });
    if (input.date <= today) throw invalid('Choose a date from tomorrow onwards', { date: 'From tomorrow' });
    if (input.date > addDays(today, 60)) throw invalid('Choose a date within the next 60 days', { date: 'Within 60 days' });
    const db = this.shared.db;
    const [hol] = await db.db
      .select({ name: s.holiday.name })
      .from(s.holiday)
      .where(and(eq(s.holiday.date, input.date), sql`(${s.holiday.branchId} is null or ${s.holiday.branchId} = ${sc.branchId})`));
    if (hol) throw invalid(`${formatWeekdayDate(input.date)} is a holiday (${hol.name}) — choose another day`, { date: 'Holiday' });
    const [dup] = await db.db
      .select({ id: s.ptmRequest.id })
      .from(s.ptmRequest)
      .where(and(eq(s.ptmRequest.guardianUserId, c.userId), eq(s.ptmRequest.studentId, sc.studentId), eq(s.ptmRequest.status, 'requested'), sql`${s.ptmRequest.preferredSlot} like ${`${input.date}%`}`));
    if (dup) throw invalid('You already requested a slot on this day — the teacher will confirm it');
    const slotLabel = `${formatLongWeekdayDate(input.date)} · ${PTM_PART_LABEL[input.part]}`;
    const teachers = await this.shared.batchTeachers(sc.batchId);
    const admins = await this.shared.branchAdmins(sc.branchId);
    const id = await db.tx(async (tx) => {
      const [row] = await tx
        .insert(s.ptmRequest)
        .values({ guardianUserId: c.userId, studentId: sc.studentId, preferredSlot: `${input.date} ${input.part}`, note: input.note || null, status: 'requested' })
        .returning({ id: s.ptmRequest.id });
      await this.audit.log(tx, {
        action: 'PTM slot requested',
        kind: 'create',
        entityType: 'ptm_request',
        entityId: row!.id,
        entityLabel: `${c.userName} · ${sc.name}`,
        summary: `${sc.batchCode} · ${slotLabel}`,
        branchId: sc.branchId,
      });
      await this.notify.notify(tx, {
        userIds: [...new Set([...teachers.map((t) => t.id), ...admins])],
        category: 'message',
        title: `PTM request · ${firstName(sc.name)} (${sc.batchCode})`,
        body: `${c.userName} prefers ${slotLabel}${input.note ? ` · “${input.note}”` : ''}`,
        link: null,
        entityType: 'ptm_request',
        entityId: row!.id,
      });
      return row!.id;
    });
    return { id, slotLabel, note: `Requested ${slotLabel} · the class teacher confirms the time` };
  }
}
