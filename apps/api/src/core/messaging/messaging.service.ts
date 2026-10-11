import { Injectable, Logger } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, eq, inArray, sql, type DbOrTx } from '@exatech/db';
import { Db } from '../db';
import { FilesService } from '../files/files.service';
import { buildChannels, type NotificationChannel, type OutgoingMessage } from './channels';

export interface MessageInput {
  channel: 'whatsapp' | 'email' | 'sms';
  to: string;
  toUserId?: string | null;
  subject?: string | null;
  body: string;
  template?: string | null;
  /** fileId → attached (email) or linked via signed URL (WhatsApp). */
  attachments?: { filename: string; fileId?: string; url?: string }[];
}

/**
 * Every WhatsApp / email / SMS goes through `outbound_message` so delivery is
 * tracked and retried. `queue()` is transactional (written with the change
 * that caused it); the worker's dispatcher delivers queued rows.
 */
@Injectable()
export class MessagingService {
  private readonly log = new Logger('Messaging');
  private readonly channels: NotificationChannel[] = buildChannels();

  constructor(
    private readonly db: Db,
    private readonly files: FilesService,
  ) {}

  async queue(tx: DbOrTx, msg: MessageInput): Promise<string> {
    const [row] = await tx
      .insert(s.outboundMessage)
      .values({
        channel: msg.channel,
        toAddress: msg.to,
        toUserId: msg.toUserId ?? null,
        template: msg.template ?? null,
        subject: msg.subject ?? null,
        body: msg.body,
        attachments: msg.attachments ?? [],
        status: 'queued',
      })
      .returning({ id: s.outboundMessage.id });
    await tx.execute(sql`select pg_notify('exa_outbound', ${row!.id})`);
    return row!.id;
  }

  /** Insert and deliver immediately (auth codes and links must not wait for a worker). */
  async sendNow(msg: MessageInput): Promise<void> {
    const id = await this.queue(this.db.db, msg);
    await this.deliver(id);
  }

  /** Deliver one queued message. Safe to call concurrently (row lock). */
  async deliver(id: string): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`select id from outbound_message where id = ${id} and status = 'queued' for update skip locked`);
      if (rows.length === 0) return;
      const [m] = await tx.select().from(s.outboundMessage).where(eq(s.outboundMessage.id, id));
      if (!m) return;
      const channel = this.channels.find((c) => c.supports(m.channel));
      try {
        if (!channel) throw new Error(`No provider for ${m.channel}`);
        const attachments: OutgoingMessage['attachments'] = [];
        for (const a of m.attachments) {
          if (a.fileId && m.channel === 'email') attachments.push({ filename: a.filename, content: await this.files.read(a.fileId) });
          else if (a.fileId) attachments.push({ filename: a.filename, url: (await this.files.signedUrl(a.fileId, 60 * 60 * 24)).url });
          else if (a.url) attachments.push({ filename: a.filename, url: a.url });
        }
        const r = await channel.send({ channel: m.channel, to: m.toAddress, subject: m.subject, body: m.body, template: m.template, attachments });
        await tx
          .update(s.outboundMessage)
          .set({ status: 'sent', provider: r.provider, providerMessageId: r.providerMessageId, sentAt: new Date(), attempts: m.attempts + 1, error: null })
          .where(eq(s.outboundMessage.id, id));
      } catch (err) {
        const attempts = m.attempts + 1;
        this.log.warn(`Delivery failed (${m.channel} → ${m.toAddress}, attempt ${attempts}): ${(err as Error).message}`);
        await tx
          .update(s.outboundMessage)
          .set({ status: attempts >= 5 ? 'failed' : 'queued', attempts, error: (err as Error).message.slice(0, 500) })
          .where(eq(s.outboundMessage.id, id));
      }
    });
  }

  /** Worker loop body: deliver whatever is queued (oldest first, with backoff by attempts). */
  async dispatchQueued(limit = 50): Promise<number> {
    const rows = await this.db.db
      .select({ id: s.outboundMessage.id, attempts: s.outboundMessage.attempts, createdAt: s.outboundMessage.createdAt })
      .from(s.outboundMessage)
      .where(and(eq(s.outboundMessage.status, 'queued'), sql`${s.outboundMessage.createdAt} < now() - (interval '20 seconds' * ${s.outboundMessage.attempts} * ${s.outboundMessage.attempts})`))
      .orderBy(s.outboundMessage.createdAt)
      .limit(limit);
    for (const r of rows) await this.deliver(r.id);
    return rows.length;
  }

  /** Resolve contact details for users (email + phone) for fan-out. */
  async contacts(tx: DbOrTx, userIds: string[]) {
    if (userIds.length === 0) return [];
    return tx.select({ id: s.user.id, name: s.user.name, email: s.user.email, phone: s.user.phoneNumber }).from(s.user).where(inArray(s.user.id, userIds));
  }
}
