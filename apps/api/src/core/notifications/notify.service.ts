import { Injectable } from '@nestjs/common';
import { NOTIFICATION_PREFS } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, inArray, type DbOrTx } from '@exatech/db';
import { afterCommit } from '../db';
import { MessagingService } from '../messaging/messaging.service';
import { RealtimeService } from '../realtime/realtime.service';

export interface NotifyInput {
  userIds: readonly string[];
  category: s.NotificationCategory;
  title: string;
  body: string;
  link?: string | null;
  entityType?: string;
  entityId?: string;
  /** Also send on external channels per the user's preferences. */
  whatsapp?: { body: string; template?: string; attachments?: { filename: string; fileId?: string; url?: string }[] };
  email?: { subject: string; body: string; attachments?: { filename: string; fileId?: string }[] };
}

const UNMUTABLE = new Set(NOTIFICATION_PREFS.filter((p) => !p.mutable).map((p) => p.category));
const DEFAULTS = Object.fromEntries(NOTIFICATION_PREFS.map((p) => [p.category, [...p.defaults]])) as Record<string, string[]>;

/**
 * In-app notification (live bell via SSE) plus WhatsApp/email per category
 * rules. Fee-due and exam-schedule messages cannot be muted.
 */
@Injectable()
export class NotifyService {
  constructor(
    private readonly messaging: MessagingService,
    private readonly realtime: RealtimeService,
  ) {}

  async notify(tx: DbOrTx, input: NotifyInput): Promise<void> {
    const userIds = [...new Set(input.userIds)].filter(Boolean);
    if (userIds.length === 0) return;
    const rows = await tx
      .insert(s.notification)
      .values(
        userIds.map((userId) => ({
          userId,
          category: input.category,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
        })),
      )
      .returning();

    if (input.whatsapp || input.email) {
      const prefs = await tx
        .select()
        .from(s.notificationPreference)
        .where(and(inArray(s.notificationPreference.userId, userIds), inArray(s.notificationPreference.category, [input.category])));
      const contacts = await this.messaging.contacts(tx, userIds);
      for (const c of contacts) {
        const pref = prefs.find((p) => p.userId === c.id)?.channels ?? DEFAULTS[input.category] ?? ['in_app'];
        const channels = UNMUTABLE.has(input.category as never) ? new Set([...pref, ...(DEFAULTS[input.category] ?? [])]) : new Set(pref);
        if (input.whatsapp && c.phone && channels.has('whatsapp')) {
          await this.messaging.queue(tx, { channel: 'whatsapp', to: c.phone, toUserId: c.id, body: input.whatsapp.body, template: input.whatsapp.template, attachments: input.whatsapp.attachments });
        }
        if (input.email && c.email && channels.has('email') && !c.email.endsWith('.invalid')) {
          await this.messaging.queue(tx, { channel: 'email', to: c.email, toUserId: c.id, subject: input.email.subject, body: input.email.body, attachments: input.email.attachments });
        }
      }
    }

    // Live bell — pushed once the transaction has committed so clients never refetch stale data.
    afterCommit(tx, () =>
      Promise.all(
        rows.map((n) =>
          this.realtime.toUsers([n.userId], {
            kind: 'notification',
            notification: { id: n.id, title: n.title, body: n.body, category: n.category, link: n.link, createdAt: n.createdAt.toISOString() },
            keys: [['notifications']],
          }),
        ),
      ),
    );
  }

  /** Ask clients in a branch (null = everyone) to refetch query-key prefixes after commit. */
  invalidate(tx: DbOrTx, branchId: string | null, keys: string[][]): void {
    afterCommit(tx, () => this.realtime.invalidate(branchId, keys));
  }

  /** Ask specific users' clients to refetch after commit. */
  invalidateUsers(tx: DbOrTx, userIds: readonly string[], keys: string[][]): void {
    afterCommit(tx, () => this.realtime.toUsers(userIds, { kind: 'invalidate', keys }));
  }
}
