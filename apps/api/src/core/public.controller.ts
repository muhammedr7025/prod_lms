import { Controller } from '@nestjs/common';
import { publicContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { asc, count, eq, inArray } from '@exatech/db';
import { env } from '../config/env';
import { Db } from './db';
import { Endpoint, Public } from './http';
import { RedisService } from './redis';

/** Public, non-sensitive facts for the sign-in screen. */
@Controller()
export class PublicController {
  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
  ) {}

  @Endpoint(publicContract.config)
  @Public()
  async config() {
    return this.redis.cached('public:config', 60, async () => {
      const [inst] = await this.db.db.select({ name: s.institution.name }).from(s.institution).limit(1);
      const branches = await this.db.db
        .select({ name: s.branch.name, city: s.branch.city })
        .from(s.branch)
        .where(inArray(s.branch.status, ['active', 'paused']))
        .orderBy(asc(s.branch.openedOn));
      const [students] = await this.db.db.select({ n: count() }).from(s.enrollment).where(eq(s.enrollment.status, 'active'));
      const [roles] = await this.db.db.select({ n: count() }).from(s.role);
      const e = env();
      return {
        institution: inst?.name ?? 'Exatech',
        branches,
        googleEnabled: !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
        demoMode: e.DEMO_MODE,
        activeStudents: Number(students?.n ?? 0),
        roles: Number(roles?.n ?? 0),
      };
    });
  }
}
