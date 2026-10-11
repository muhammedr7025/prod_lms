import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  /** General-purpose client (cache, rate limits, pub). */
  readonly client: Redis;
  private subscriber: Redis | null = null;

  constructor() {
    this.client = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  key(...parts: string[]): string {
    return [env().REDIS_PREFIX, ...parts].join(':');
  }

  /** A dedicated connection for SUBSCRIBE (cannot share with commands). */
  sub(): Redis {
    if (!this.subscriber) this.subscriber = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
    return this.subscriber;
  }

  /** Connection options for BullMQ (it creates its own connections). */
  bullConnection() {
    return { url: env().REDIS_URL, maxRetriesPerRequest: null } as const;
  }

  async cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const k = this.key('cache', key);
    const hit = await this.client.get(k);
    if (hit) return JSON.parse(hit) as T;
    const value = await load();
    await this.client.set(k, JSON.stringify(value), 'EX', ttlSec);
    return value;
  }

  async invalidate(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys.map((k) => this.key('cache', k)));
  }

  /** Sliding-window-ish fixed window rate limit. Returns false when exceeded. */
  async rateLimit(bucket: string, limit: number, windowSec: number): Promise<boolean> {
    const k = this.key('rl', bucket);
    const n = await this.client.incr(k);
    if (n === 1) await this.client.expire(k, windowSec);
    return n <= limit;
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
