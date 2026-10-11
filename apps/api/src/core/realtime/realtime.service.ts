import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RealtimeMessage } from '@exatech/contracts';
import { RedisService } from '../redis';

type Listener = (msg: RealtimeMessage) => void;

/**
 * Server-Sent Events fan-out across API replicas via Redis pub/sub.
 * Channels: per user, and per branch for broad invalidations.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private readonly listeners = new Map<string, Set<Listener>>();
  private subscribed = false;

  constructor(private readonly redis: RedisService) {}

  private channel(kind: 'user' | 'branch' | 'all', id = '*') {
    return this.redis.key('rt', kind, id);
  }

  /** Publish to users (works from the API or the worker). */
  async toUsers(userIds: readonly string[], msg: RealtimeMessage): Promise<void> {
    const payload = JSON.stringify(msg);
    await Promise.all([...new Set(userIds)].map((u) => this.redis.client.publish(this.channel('user', u), payload)));
  }

  /** Invalidate query-key prefixes for everyone watching a branch (null = everyone). */
  async invalidate(branchId: string | null, keys: string[][]): Promise<void> {
    const payload = JSON.stringify({ kind: 'invalidate', keys } satisfies RealtimeMessage);
    await this.redis.client.publish(branchId ? this.channel('branch', branchId) : this.channel('all', 'all'), payload);
  }

  /** Register an SSE connection; returns an unsubscribe function. */
  listen(userId: string, branchIds: string[] | null, fn: Listener): () => void {
    this.ensureSubscribed();
    const keys = [this.channel('user', userId), this.channel('all', 'all'), ...(branchIds ?? ['*']).map((b) => this.channel('branch', b))];
    for (const k of keys) {
      if (!this.listeners.has(k)) this.listeners.set(k, new Set());
      this.listeners.get(k)!.add(fn);
    }
    return () => {
      for (const k of keys) this.listeners.get(k)?.delete(fn);
    };
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    const sub = this.redis.sub();
    void sub.psubscribe(this.redis.key('rt', '*'));
    sub.on('pmessage', (_pattern, channel, message) => {
      let msg: RealtimeMessage;
      try {
        msg = JSON.parse(message) as RealtimeMessage;
      } catch {
        return;
      }
      const deliver = (key: string) => this.listeners.get(key)?.forEach((fn) => fn(msg));
      deliver(channel);
      // institution-wide listeners (branch "*") receive every branch message
      if (channel.startsWith(this.redis.key('rt', 'branch', ''))) deliver(this.channel('branch', '*'));
    });
    sub.on('error', (err) => this.log.warn(`subscriber error: ${err.message}`));
  }

  onModuleDestroy() {
    this.listeners.clear();
  }
}
