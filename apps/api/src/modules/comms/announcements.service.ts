import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ROLE_META, zAnnouncementInput, type AnnouncementRow, type AnnouncementFeedItem, type AudienceTarget, type SystemRoleKey } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, inArray, isNull, or, sql, type SQL, type Tx } from '@exatech/db';
import { addDays, formatDayMonth, istDateTime, todayIST, toISTDate, toISTTime } from '@exatech/domain';
import type { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { NotifyService } from '../../core/notifications/notify.service';
import { QueueService } from '../../core/queue.service';
import { AudienceService } from './audience.service';

type Input = z.output<typeof zAnnouncementInput>;
type Row = typeof s.announcement.$inferSelect;
const JOB = 'announcement.publish';
const nf = new Intl.NumberFormat('en-IN');

/**
 * Announcements: compose (audience → recipients), publish now or on a
 * schedule (delayed BullMQ job on "maintenance" plus a safety sweep),
 * in-app fan-out + optional WhatsApp, read / ack receipts, withdraw.
 */
@Injectable()
export class AnnouncementsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Announcements');
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly audience: AudienceService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    // NB: QueueService keeps one processor per queue; job names we do not own are ignored here.
    this.queue.process('maintenance', async (job) => {
      if (job.name === JOB) await this.publishScheduled((job.data as { announcementId: string }).announcementId);
    });
    // Safety net when another module replaces the "maintenance" processor: publish anything overdue.
    this.sweep = setInterval(() => void this.publishDue().catch((err) => this.log.warn(`sweep: ${(err as Error).message}`)), 60_000);
    this.sweep.unref?.();
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
  }

  private kicker(a: { pinned: boolean; authorRoleKey: string; audience: AudienceTarget[]; status: string; publishAt: Date }): string {
    const role = ROLE_META[a.authorRoleKey as SystemRoleKey]?.short ?? a.authorRoleKey;
    const parts = [a.status === 'scheduled' ? `Scheduled · ${formatDayMonth(toISTDate(a.publishAt))} ${toISTTime(a.publishAt)}` : a.pinned ? 'Pinned' : null, role, this.audience.summary(a.audience)].filter(Boolean);
    return parts.join(' · ');
  }

  private toRow(a: Row, counts: { read: number; acked: number }, authorName: string): AnnouncementRow {
    const now = Date.now();
    const status = a.status === 'published' && a.expiresAt && a.expiresAt.getTime() <= now ? 'expired' : a.status;
    let metaLabel: string;
    let metaTag: AnnouncementRow['metaTag'];
    if (status === 'scheduled') [metaLabel, metaTag] = [`Scheduled · ${formatDayMonth(toISTDate(a.publishAt))} ${toISTTime(a.publishAt)}`, 'outline'];
    else if (status === 'withdrawn') [metaLabel, metaTag] = ['Withdrawn', 'ink'];
    else if (a.ackRequired) [metaLabel, metaTag] = [`Ack ${nf.format(counts.acked)} / ${nf.format(a.recipientCount)}`, 'neutral'];
    else [metaLabel, metaTag] = [`Read ${nf.format(counts.read)} / ${nf.format(a.recipientCount)}`, 'accent'];
    if (status === 'expired') metaLabel = `Expired · ${metaLabel}`;
    const c = ctx();
    return {
      id: a.id,
      kicker: a.kicker ?? this.kicker(a),
      title: a.title,
      body: a.body,
      pinned: a.pinned,
      status,
      publishAt: a.publishAt.toISOString(),
      expiresAt: a.expiresAt?.toISOString() ?? null,
      ackRequired: a.ackRequired,
      alsoWhatsapp: a.alsoWhatsapp,
      audience: a.audience,
      recipients: a.recipientCount,
      read: counts.read,
      acked: counts.acked,
      metaLabel,
      metaTag,
      authorName,
      canWithdraw: (status === 'published' || status === 'scheduled') && (can('comms:announcements.delete') || a.authorUserId === c.userId),
    };
  }

  private async rows(where: SQL | undefined, limit = 60): Promise<AnnouncementRow[]> {
    const list = await this.db.db
      .select({ a: s.announcement, author: s.user.name })
      .from(s.announcement)
      .innerJoin(s.user, eq(s.user.id, s.announcement.authorUserId))
      .where(where)
      .orderBy(desc(sql`(${s.announcement.pinned} and ${s.announcement.status} = 'published')`), desc(s.announcement.publishAt))
      .limit(limit);
    const ids = list.map((r) => r.a.id);
    const counts = ids.length
      ? await this.db.db
          .select({
            id: s.announcementRecipient.announcementId,
            read: sql<number>`count(*) filter (where ${s.announcementRecipient.readAt} is not null)::int`,
            acked: sql<number>`count(*) filter (where ${s.announcementRecipient.ackedAt} is not null)::int`,
          })
          .from(s.announcementRecipient)
          .where(inArray(s.announcementRecipient.announcementId, ids))
          .groupBy(s.announcementRecipient.announcementId)
      : [];
    return list.map((r) => {
      const cnt = counts.find((c) => c.id === r.a.id);
      return this.toRow(r.a, { read: Number(cnt?.read ?? 0), acked: Number(cnt?.acked ?? 0) }, r.author);
    });
  }

  async list() {
    const c = ctx();
    const sc = branchScope();
    const where: (SQL | undefined)[] = [];
    if (c.roleKey === 'teacher') where.push(eq(s.announcement.authorUserId, c.userId));
    else if (sc) where.push(or(inArray(s.announcement.branchId, sc.length ? sc : ['00000000-0000-0000-0000-000000000000']), isNull(s.announcement.branchId), eq(s.announcement.authorUserId, c.userId)));
    if (c.roleKey === 'finance') where.push(or(eq(s.announcement.authorRoleKey, 'finance'), eq(s.announcement.authorUserId, c.userId)));
    return { items: await this.rows(and(...where)), options: await this.audience.options(), aiEnabled: !!process.env.ANTHROPIC_API_KEY };
  }

  async preview(audience: AudienceTarget[]) {
    const n = await this.audience.normalise(audience);
    const r = await this.audience.resolve(this.db.db, n.audience, n.branchId);
    return { recipients: r.userIds.length, students: r.students, parents: r.parents, staff: r.staff };
  }

  async create(body: Input): Promise<AnnouncementRow> {
    const c = ctx();
    const { audience, branchId } = await this.audience.normalise(body.audience);
    const now = new Date();
    const publishAt = body.publishAt ? new Date(body.publishAt) : now;
    const scheduled = publishAt.getTime() > now.getTime() + 60_000;
    if (body.publishAt && publishAt.getTime() < now.getTime() - 5 * 60_000) throw invalid('The publish time is in the past — choose Now or a later time', { publishAt: 'Past' });
    if (publishAt.getTime() > now.getTime() + 90 * 86_400_000) throw invalid('Schedule within the next 90 days', { publishAt: 'Too far' });
    let expiresAt: Date | null = null;
    if (body.expiresOn) {
      if (body.expiresOn < todayIST() || body.expiresOn < toISTDate(publishAt)) throw invalid('Expiry must be on or after the publish date', { expiresOn: 'Too early' });
      expiresAt = istDateTime(addDays(body.expiresOn, 1));
    }
    const id = await this.db.tx(async (tx) => {
      const [a] = await tx
        .insert(s.announcement)
        .values({
          institutionId: c.institutionId,
          branchId,
          authorUserId: c.userId,
          authorRoleKey: c.roleKey,
          title: body.title,
          body: body.body,
          audience,
          publishAt: scheduled ? publishAt : now,
          expiresAt,
          pinned: body.pinned,
          ackRequired: body.ackRequired,
          alsoWhatsapp: body.alsoWhatsapp,
          status: scheduled ? 'scheduled' : 'published',
        })
        .returning();
      await tx.update(s.announcement).set({ kicker: this.kicker({ ...a!, audience, status: 'published' }) }).where(eq(s.announcement.id, a!.id));
      if (scheduled) {
        await this.audit.log(tx, {
          action: 'Announcement scheduled',
          kind: 'create',
          entityType: 'announcement',
          entityId: a!.id,
          entityLabel: body.title,
          after: { audience, publishAt, expiresAt, pinned: body.pinned, ackRequired: body.ackRequired, alsoWhatsapp: body.alsoWhatsapp },
          summary: `${body.title} · ${this.audience.summary(audience)} · publishes ${formatDayMonth(toISTDate(publishAt))} ${toISTTime(publishAt)}`,
          branchId,
        });
      } else {
        await this.fanOut(tx, a!.id);
      }
      return a!.id;
    });
    if (scheduled) {
      try {
        await this.queue.add('maintenance', JOB, { announcementId: id }, { delay: publishAt.getTime() - Date.now(), jobId: `announcement-${id}` });
      } catch (err) {
        this.log.warn(`could not queue scheduled announcement ${id}: ${(err as Error).message} — the sweep will publish it`);
      }
    }
    const [row] = await this.rows(eq(s.announcement.id, id), 1);
    return row!;
  }

  /** Resolve recipients, write receipts, notify (in-app + WhatsApp), emit AnnouncementPublished. */
  private async fanOut(tx: Tx, id: string): Promise<void> {
    const [a] = await tx.select().from(s.announcement).where(eq(s.announcement.id, id));
    if (!a) return;
    const resolved = await this.audience.resolve(tx, a.audience, a.branchId);
    const users = resolved.userIds.filter((u) => u !== a.authorUserId);
    for (let i = 0; i < users.length; i += 1000) {
      await tx
        .insert(s.announcementRecipient)
        .values(users.slice(i, i + 1000).map((userId) => ({ announcementId: id, userId })))
        .onConflictDoNothing();
    }
    await tx.update(s.announcement).set({ recipientCount: users.length, status: 'published' }).where(eq(s.announcement.id, id));
    await this.notify.notify(tx, {
      userIds: users,
      category: 'announcement',
      title: a.title,
      body: a.body.length > 160 ? `${a.body.slice(0, 157)}…` : a.body,
      link: null,
      entityType: 'announcement',
      entityId: id,
      whatsapp: a.alsoWhatsapp ? { template: 'announcement', body: `${a.title}\n\n${a.body}` } : undefined,
    });
    await this.events.emit(tx, 'AnnouncementPublished', { announcementId: id, branchId: a.branchId });
    await this.audit.log(tx, {
      action: 'Announcement published',
      kind: 'publish',
      entityType: 'announcement',
      entityId: id,
      entityLabel: a.title,
      after: { audience: a.audience, recipients: users.length, pinned: a.pinned, ackRequired: a.ackRequired, alsoWhatsapp: a.alsoWhatsapp },
      summary: `${a.title} · ${this.audience.summary(a.audience)} · ${users.length} recipients${a.ackRequired ? ' · ack required' : ''}${a.alsoWhatsapp ? ' · also WhatsApp' : ''}`,
      branchId: a.branchId,
    });
    this.notify.invalidateUsers(tx, users, [['comms'], ['portal']]);
    this.notify.invalidate(tx, a.branchId, [['comms']]);
  }

  /** Worker: publish a scheduled announcement (idempotent — only a still-scheduled row is claimed). */
  async publishScheduled(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const claimed = await tx
        .update(s.announcement)
        .set({ status: 'published' })
        .where(and(eq(s.announcement.id, id), eq(s.announcement.status, 'scheduled'), sql`${s.announcement.publishAt} <= now() + interval '1 minute'`))
        .returning({ id: s.announcement.id });
      if (claimed.length === 0) return;
      await this.fanOut(tx, id);
    });
  }

  async publishDue(): Promise<void> {
    const due = await this.db.db
      .select({ id: s.announcement.id })
      .from(s.announcement)
      .where(and(eq(s.announcement.status, 'scheduled'), sql`${s.announcement.publishAt} <= now()`))
      .limit(20);
    for (const d of due) await this.publishScheduled(d.id);
  }

  async withdraw(id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const [a] = await tx.select().from(s.announcement).where(eq(s.announcement.id, id)).for('update');
      if (!a) throw notFound('Announcement');
      const c = ctx();
      const sc = branchScope();
      if (a.authorUserId !== c.userId) {
        if (!can('comms:announcements.delete')) throw forbidden('Only the author or a Branch Admin can withdraw this');
        if (sc && a.branchId && !sc.includes(a.branchId)) throw forbidden('This announcement belongs to another branch');
        if (sc && !a.branchId) throw forbidden('Only a Super Admin can withdraw institution-wide announcements');
      }
      if (a.status === 'withdrawn') return;
      if (a.status !== 'published' && a.status !== 'scheduled') throw conflict(`This announcement is ${a.status}`);
      await tx.update(s.announcement).set({ status: 'withdrawn', pinned: false }).where(eq(s.announcement.id, id));
      await this.audit.log(tx, {
        action: 'Announcement withdrawn',
        kind: 'delete',
        entityType: 'announcement',
        entityId: id,
        entityLabel: a.title,
        before: { status: a.status },
        after: { status: 'withdrawn' },
        summary: `${a.title} · ${a.status} → withdrawn`,
        branchId: a.branchId,
      });
      const users = await tx.select({ id: s.announcementRecipient.userId }).from(s.announcementRecipient).where(eq(s.announcementRecipient.announcementId, id));
      this.notify.invalidateUsers(
        tx,
        users.map((u) => u.id),
        [['comms'], ['portal']],
      );
      this.notify.invalidate(tx, a.branchId, [['comms']]);
    });
  }

  /* ───────────────────────── Feed (portals, everyone) ───────────────────────── */

  async feed(): Promise<{ items: AnnouncementFeedItem[]; unread: number }> {
    const c = ctx();
    const rows = await this.db.db
      .select({ a: s.announcement, r: s.announcementRecipient, author: s.user.name })
      .from(s.announcementRecipient)
      .innerJoin(s.announcement, eq(s.announcement.id, s.announcementRecipient.announcementId))
      .innerJoin(s.user, eq(s.user.id, s.announcement.authorUserId))
      .where(and(eq(s.announcementRecipient.userId, c.userId), eq(s.announcement.status, 'published'), or(isNull(s.announcement.expiresAt), sql`${s.announcement.expiresAt} > now()`)))
      .orderBy(desc(s.announcement.pinned), desc(s.announcement.publishAt))
      .limit(50);
    const items = rows.map((x) => ({
      id: x.a.id,
      kicker: x.a.kicker ?? this.kicker(x.a),
      title: x.a.title,
      body: x.a.body,
      pinned: x.a.pinned,
      publishAt: x.a.publishAt.toISOString(),
      expiresAt: x.a.expiresAt?.toISOString() ?? null,
      ackRequired: x.a.ackRequired,
      readAt: x.r.readAt?.toISOString() ?? null,
      ackedAt: x.r.ackedAt?.toISOString() ?? null,
      authorName: x.author,
    }));
    return { items, unread: items.filter((i) => !i.readAt).length };
  }

  private async receipt(id: string) {
    const c = ctx();
    const [r] = await this.db.db
      .select({ r: s.announcementRecipient, a: s.announcement })
      .from(s.announcementRecipient)
      .innerJoin(s.announcement, eq(s.announcement.id, s.announcementRecipient.announcementId))
      .where(and(eq(s.announcementRecipient.announcementId, id), eq(s.announcementRecipient.userId, c.userId)));
    if (!r || r.a.status !== 'published') throw notFound('Announcement');
    return r;
  }

  async markRead(id: string): Promise<void> {
    await this.receipt(id);
    const c = ctx();
    await this.db.db
      .update(s.announcementRecipient)
      .set({ readAt: sql`coalesce(${s.announcementRecipient.readAt}, now())` })
      .where(and(eq(s.announcementRecipient.announcementId, id), eq(s.announcementRecipient.userId, c.userId)));
  }

  async ack(id: string): Promise<void> {
    const r = await this.receipt(id);
    if (!r.a.ackRequired) return this.markRead(id);
    if (r.r.ackedAt) return;
    const c = ctx();
    await this.db.tx(async (tx) => {
      await tx
        .update(s.announcementRecipient)
        .set({ ackedAt: new Date(), readAt: sql`coalesce(${s.announcementRecipient.readAt}, now())` })
        .where(and(eq(s.announcementRecipient.announcementId, id), eq(s.announcementRecipient.userId, c.userId)));
      await this.audit.log(tx, { action: 'Announcement acknowledged', kind: 'other', entityType: 'announcement', entityId: id, entityLabel: r.a.title, summary: `${c.userName} acknowledged “${r.a.title}”`, branchId: r.a.branchId });
      this.notify.invalidate(tx, r.a.branchId, [['comms']]);
    });
  }
}
