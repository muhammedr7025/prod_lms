import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { DomainEventEnvelope, DomainEventType } from '@exatech/contracts';
import * as s from '@exatech/db';
import { eq, sql } from '@exatech/db';
import { Db } from '../db';
import { EventBus } from '../events/event-bus';
import { MessagingService } from '../messaging/messaging.service';
import { QueueService } from '../queue.service';

/**
 * The worker's loops: outbox relay (domain events → async handlers),
 * message dispatcher (WhatsApp/email), and BullMQ processors.
 * LISTEN/NOTIFY wakes them instantly; a poll is the safety net.
 */
@Injectable()
export class BackgroundService implements OnModuleDestroy {
  private readonly log = new Logger('Worker');
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private busyOutbox = false;
  private busyMessages = false;
  private unlisten: (() => Promise<void>)[] = [];

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly messaging: MessagingService,
    private readonly queues: QueueService,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const l1 = await this.db.sql.listen('exa_outbox', () => void this.tickOutbox());
    const l2 = await this.db.sql.listen('exa_outbound', () => void this.tickMessages());
    this.unlisten.push(() => l1.unlisten(), () => l2.unlisten());
    this.timers.push(setInterval(() => void this.tickOutbox(), 3000), setInterval(() => void this.tickMessages(), 5000));
    this.queues.startWorkers();
    this.log.log('background loops started (outbox relay, message dispatcher, queues)');
    void this.tickOutbox();
    void this.tickMessages();
  }

  private async tickMessages() {
    if (this.busyMessages) return;
    this.busyMessages = true;
    try {
      while ((await this.messaging.dispatchQueued(25)) === 25);
    } catch (err) {
      this.log.warn(`message dispatch: ${(err as Error).message}`);
    } finally {
      this.busyMessages = false;
    }
  }

  private async tickOutbox() {
    if (this.busyOutbox) return;
    this.busyOutbox = true;
    try {
      while ((await this.relayBatch(25)) > 0);
    } catch (err) {
      this.log.warn(`outbox relay: ${(err as Error).message}`);
    } finally {
      this.busyOutbox = false;
    }
  }

  /** Process up to `limit` events; each handler runs at most once successfully per event. */
  async relayBatch(limit: number): Promise<number> {
    const rows = await this.db.sql<{ id: string; type: string; payload: Record<string, unknown>; occurred_at: Date; attempts: number; handled: string[] }[]>`
      select id, type, payload, occurred_at, attempts, handled from outbox_event
      where processed_at is null and attempts < 10
        and (attempts = 0 or occurred_at < now() - (interval '15 seconds' * attempts * attempts))
      order by occurred_at limit ${limit}`;
    let done = 0;
    for (const row of rows) {
      // Claim the row so concurrent workers skip it.
      const claimed = await this.db.sql`update outbox_event set attempts = attempts + 1 where id = ${row.id} and processed_at is null and attempts = ${row.attempts} returning id`;
      if (claimed.length === 0) continue;
      const envelope: DomainEventEnvelope = { id: row.id, type: row.type as DomainEventType, payload: row.payload as never, occurredAt: new Date(row.occurred_at).toISOString() };
      const handled = new Set(row.handled);
      let failed: string | null = null;
      for (const h of this.events.asyncHandlersFor(row.type)) {
        if (handled.has(h.name)) continue;
        try {
          await h.fn(envelope.payload, envelope);
          handled.add(h.name);
          await this.db.db.update(s.outboxEvent).set({ handled: [...handled] }).where(eq(s.outboxEvent.id, row.id));
        } catch (err) {
          this.events.logError(row.type, h.name, err);
          failed = `${h.name}: ${(err as Error).message}`.slice(0, 500);
        }
      }
      await this.db.db
        .update(s.outboxEvent)
        .set(failed ? { lastError: failed } : { processedAt: new Date(), lastError: null })
        .where(eq(s.outboxEvent.id, row.id));
      done++;
    }
    void sql;
    return done;
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    await Promise.all(this.unlisten.map((f) => f().catch(() => undefined)));
  }
}
