import { Controller, Get } from '@nestjs/common';
import { sql } from '@exatech/db';
import { Db } from './db';
import { Public } from './http';
import { RedisService } from './redis';

@Controller()
export class HealthController {
  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
  ) {}

  @Get('/api/health')
  @Public()
  async health() {
    const started = Date.now();
    const [dbOk, redisOk] = await Promise.all([
      this.db.db.execute(sql`select 1`).then(() => true, () => false),
      this.redis.client.ping().then((r) => r === 'PONG', () => false),
    ]);
    return { ok: dbOk && redisOk, db: dbOk, redis: redisOk, ms: Date.now() - started };
  }
}
