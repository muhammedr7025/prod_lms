import { Controller, Req } from '@nestjs/common';
import { publicLeadsContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, ilike, or, sql } from '@exatech/db';
import { normalizeEmail, normalizePhone } from '@exatech/domain';
import type { FastifyRequest } from 'fastify';
import { AccessService } from '../../core/auth/access.service';
import { Db } from '../../core/db';
import { DomainError, invalid } from '../../core/errors';
import { Endpoint, Input, Public, type Args } from '../../core/http';
import { RedisService } from '../../core/redis';
import { LeadsService } from './leads.service';

const THANKS = 'Thanks — a counsellor will call you shortly.';

/**
 * Public website enquiry form → the same create path as manual leads
 * (dedupe, assignment rules, first-response timer), source "Website".
 * Protected by a honeypot field and Redis rate limits (5/hour per IP and per phone).
 */
@Controller()
export class PublicLeadsController {
  constructor(
    private readonly db: Db,
    private readonly leads: LeadsService,
    private readonly access: AccessService,
    private readonly redis: RedisService,
  ) {}

  @Endpoint(publicLeadsContract.enquiry)
  @Public()
  async enquiry(@Input() { body }: Args<typeof publicLeadsContract.enquiry>, @Req() req: FastifyRequest) {
    // Bots fill every field; humans never see this one. Pretend success.
    if (body.website) return { ok: true as const, message: THANKS };
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (!(await this.redis.rateLimit(`enquiry:ip:${ip}`, 5, 3600))) throw new DomainError('RATE_LIMITED', 'Too many enquiries from this network — please try again in an hour', 429);
    const phone = normalizePhone(body.phone);
    if (!phone) throw invalid('Enter a valid 10-digit mobile', { phone: 'Enter a valid 10-digit mobile' });
    if (!(await this.redis.rateLimit(`enquiry:phone:${phone}`, 5, 3600))) throw new DomainError('RATE_LIMITED', 'We already have your enquiry — a counsellor will call you shortly', 429);

    const inst = await this.access.institution();
    const branches = await this.db.db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name, city: s.branch.city }).from(s.branch).where(eq(s.branch.status, 'active')).orderBy(asc(s.branch.openedOn));
    const want = body.branch?.trim().toLowerCase();
    const branch = (want && branches.find((b) => b.id === body.branch || b.code.toLowerCase() === want || b.name.toLowerCase() === want || b.city?.toLowerCase() === want)) || branches[0];
    if (!branch) throw invalid('Enquiries are not open right now');

    let courseId: string | null = null;
    if (body.course) {
      const cw = body.course.trim();
      const [c] = await this.db.db
        .select({ id: s.course.id })
        .from(s.course)
        .where(and(eq(s.course.institutionId, inst.id), or(sql`${s.course.id}::text = ${cw}`, ilike(s.course.code, cw), ilike(s.course.name, `%${cw.replace(/[%_]/g, '')}%`))))
        .limit(1);
      courseId = c?.id ?? null;
    }

    const email = normalizeEmail(body.email ?? null);
    const dup = await this.leads.findDuplicate(this.db.db, inst.id, phone, email);
    if (dup?.kind === 'lead') {
      // Repeat enquiry: add it to the existing lead's timeline instead of creating a duplicate.
      await this.db.tx(async (tx) => {
        const lead = await this.leads.lockLead(tx, dup.id);
        await tx.insert(s.leadActivity).values({ leadId: lead.id, actorUserId: null, kind: 'note', summary: `Website enquiry again${body.message ? ` · ${body.message.slice(0, 240)}` : ''}` });
        await tx.update(s.lead).set({ lastActivityAt: new Date() }).where(eq(s.lead.id, lead.id));
      });
      return { ok: true as const, message: THANKS };
    }
    await this.db.tx((tx) =>
      this.leads.create(
        tx,
        { name: body.name, phone, email, courseId, source: 'Website', campaign: 'Website form', preferredBranchId: branch.id, note: body.message ?? null },
        { institutionId: inst.id, branchId: branch.id, actorUserId: null, actorIsSales: false, via: 'website' },
      ),
    );
    return { ok: true as const, message: THANKS };
  }
}
