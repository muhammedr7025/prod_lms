import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventEnvelope, DomainEvents, DomainEventType } from '@exatech/contracts';
import * as s from '@exatech/db';
import { sql, type Tx } from '@exatech/db';

type TxHandler<T extends DomainEventType> = (tx: Tx, payload: DomainEvents[T], event: DomainEventEnvelope<T>) => Promise<void>;
type AsyncHandler<T extends DomainEventType> = (payload: DomainEvents[T], event: DomainEventEnvelope<T>) => Promise<void>;

/**
 * Domain events. `emit(tx, …)` does two things in the caller's transaction:
 *  1. runs in-transaction subscribers (consistency: they commit or roll back
 *     together with the change that raised the event), and
 *  2. writes the event to the outbox, which the worker relays to async
 *     subscribers (notifications, messages, PDFs) — guaranteed at-least-once.
 *
 * Modules subscribe in their constructor / onModuleInit:
 *   events.onTx('AdmissionApproved', (tx, p) => …)       // same transaction
 *   events.onAsync('PaymentRecorded', 'send-receipt', (p) => …)  // worker, idempotent
 */
@Injectable()
export class EventBus {
  private readonly log = new Logger('Events');
  private readonly txHandlers = new Map<string, { name: string; fn: TxHandler<DomainEventType> }[]>();
  private readonly asyncHandlers = new Map<string, { name: string; fn: AsyncHandler<DomainEventType> }[]>();

  onTx<T extends DomainEventType>(type: T, fn: TxHandler<T>, name = fn.name || 'anonymous'): void {
    const list = this.txHandlers.get(type) ?? [];
    list.push({ name, fn: fn as unknown as TxHandler<DomainEventType> });
    this.txHandlers.set(type, list);
  }

  /** Async handlers run in the worker. `name` must be unique per event type (idempotency key). */
  onAsync<T extends DomainEventType>(type: T, name: string, fn: AsyncHandler<T>): void {
    const list = this.asyncHandlers.get(type) ?? [];
    if (list.some((h) => h.name === name)) return;
    list.push({ name, fn: fn as unknown as AsyncHandler<DomainEventType> });
    this.asyncHandlers.set(type, list);
  }

  async emit<T extends DomainEventType>(tx: Tx, type: T, payload: DomainEvents[T]): Promise<DomainEventEnvelope<T>> {
    const [row] = await tx.insert(s.outboxEvent).values({ type, payload: payload as unknown as Record<string, unknown> }).returning({ id: s.outboxEvent.id, occurredAt: s.outboxEvent.occurredAt });
    const envelope: DomainEventEnvelope<T> = { id: row!.id, type, payload, occurredAt: row!.occurredAt.toISOString() };
    for (const h of this.txHandlers.get(type) ?? []) {
      await h.fn(tx, payload as never, envelope as never);
    }
    await tx.execute(sql`select pg_notify('exa_outbox', ${row!.id})`);
    return envelope;
  }

  asyncHandlersFor(type: string) {
    return this.asyncHandlers.get(type) ?? [];
  }

  logError(type: string, handler: string, err: unknown) {
    this.log.error(`${type} → ${handler} failed: ${(err as Error)?.stack ?? String(err)}`);
  }
}
