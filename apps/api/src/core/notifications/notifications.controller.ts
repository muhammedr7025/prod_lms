import { Controller } from '@nestjs/common';
import { NOTIFICATION_PREFS, notificationsContract, ok } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, count, desc, eq, isNull } from '@exatech/db';
import { ctx } from '../context';
import { Db } from '../db';
import { invalid } from '../errors';
import { AllowReadOnly, Endpoint, Input, type Args } from '../http';

@Controller()
export class NotificationsController {
  constructor(private readonly db: Db) {}

  @Endpoint(notificationsContract.list)
  async list(@Input() { query }: Args<typeof notificationsContract.list>) {
    const userId = ctx().userId;
    const [items, [unread]] = await Promise.all([
      this.db.db.select().from(s.notification).where(eq(s.notification.userId, userId)).orderBy(desc(s.notification.createdAt)).limit(query.limit),
      this.db.db.select({ n: count() }).from(s.notification).where(and(eq(s.notification.userId, userId), isNull(s.notification.readAt))),
    ]);
    return {
      items: items.map((n) => ({ id: n.id, category: n.category, title: n.title, body: n.body, link: n.link, readAt: n.readAt, createdAt: n.createdAt })),
      unread: Number(unread?.n ?? 0),
    };
  }

  @Endpoint(notificationsContract.markAllRead)
  @AllowReadOnly()
  async markAllRead() {
    if (ctx().readOnly) return ok;
    await this.db.db.update(s.notification).set({ readAt: new Date() }).where(and(eq(s.notification.userId, ctx().userId), isNull(s.notification.readAt)));
    return ok;
  }

  @Endpoint(notificationsContract.markRead)
  @AllowReadOnly()
  async markRead(@Input() { params }: Args<typeof notificationsContract.markRead>) {
    if (ctx().readOnly) return ok;
    await this.db.db
      .update(s.notification)
      .set({ readAt: new Date() })
      .where(and(eq(s.notification.id, params.id), eq(s.notification.userId, ctx().userId)));
    return ok;
  }

  @Endpoint(notificationsContract.preferences)
  async preferences() {
    const rows = await this.db.db.select().from(s.notificationPreference).where(eq(s.notificationPreference.userId, ctx().userId));
    return NOTIFICATION_PREFS.map((p) => ({
      category: p.category,
      label: p.label,
      mutable: p.mutable,
      channels: rows.find((r) => r.category === p.category)?.channels ?? [...p.defaults],
    }));
  }

  @Endpoint(notificationsContract.setPreference)
  async setPreference(@Input() { body }: Args<typeof notificationsContract.setPreference>) {
    const def = NOTIFICATION_PREFS.find((p) => p.category === body.category);
    if (!def) throw invalid('Unknown category');
    if (!def.mutable && def.defaults.some((d) => !body.channels.includes(d))) throw invalid(`${def.label} cannot be muted`);
    await this.db.db
      .insert(s.notificationPreference)
      .values({ userId: ctx().userId, category: body.category, channels: body.channels })
      .onConflictDoUpdate({ target: [s.notificationPreference.userId, s.notificationPreference.category], set: { channels: body.channels } });
    return ok;
  }
}
