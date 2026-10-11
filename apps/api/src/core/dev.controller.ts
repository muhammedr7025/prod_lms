import { Controller } from '@nestjs/common';
import { devContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray } from '@exatech/db';
import { env } from '../config/env';
import { Db } from './db';
import { DomainError } from './errors';
import { Endpoint, Public } from './http';

/** DEMO_MODE only: demo personas for the sign-in page and the message outbox. */
@Controller()
export class DevController {
  constructor(private readonly db: Db) {}

  private guard() {
    if (!env().DEMO_MODE) throw new DomainError('NOT_FOUND', 'Not found', 404);
  }

  @Endpoint(devContract.accounts)
  @Public()
  async accounts() {
    this.guard();
    const personas = ['deepu@exatech.test', 'priya@exatech.test', 'meera@exatech.test', 'sanjay@exatech.test', 'joseph@exatech.test', 'nithin@exatech.test', 'anjali.menon@example.test', 'suresh.menon@example.test'];
    const rows = await this.db.db
      .select({ email: s.user.email, name: s.user.name, roleKey: s.role.key, label: s.role.name, scope: s.membership.scopeLabel, isDefault: s.membership.isDefault })
      .from(s.user)
      .innerJoin(s.membership, eq(s.membership.userId, s.user.id))
      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
      .where(and(inArray(s.user.email, personas), eq(s.membership.isDefault, true)))
      .orderBy(asc(s.role.position));
    return rows.map((r) => ({ email: r.email, name: r.name, roleKey: r.roleKey, label: r.label, scope: r.scope ?? '' }));
  }

  @Endpoint(devContract.outbox)
  @Public()
  async outbox() {
    this.guard();
    const rows = await this.db.db.select().from(s.outboundMessage).orderBy(desc(s.outboundMessage.createdAt)).limit(100);
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      toAddress: r.toAddress,
      subject: r.subject,
      body: r.body,
      status: r.status,
      createdAt: r.createdAt,
      attachments: r.attachments.map((a) => ({ filename: a.filename, url: a.url })),
    }));
  }
}
