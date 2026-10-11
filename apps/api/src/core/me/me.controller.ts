import { Controller, Req } from '@nestjs/common';
import { coreContract, type Me } from '@exatech/contracts';
import * as s from '@exatech/db';
import { eq } from '@exatech/db';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { AccessService } from '../auth/access.service';
import { Db } from '../db';
import { forbidden } from '../errors';
import { Allow2faPending, Endpoint, Input, type Args } from '../http';
import { AuditService } from '../audit/audit.service';

@Controller()
export class MeController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Endpoint(coreContract.me)
  @Allow2faPending()
  async me(@Req() req: FastifyRequest): Promise<Me> {
    return this.build(req);
  }

  @Endpoint(coreContract.switchMembership)
  @Allow2faPending()
  async switchMembership(@Req() req: FastifyRequest, @Input() { body }: Args<typeof coreContract.switchMembership>): Promise<Me> {
    const exa = req.exa!;
    const memberships = await this.access.memberships(exa.user.id);
    const target = memberships.find((m) => m.id === body.membershipId);
    if (!target) throw forbidden('That membership is not yours');
    if (exa.session.readOnly) throw forbidden('Read-only session');
    await this.db.db.update(s.session).set({ activeMembershipId: target.id, activeBranchId: null }).where(eq(s.session.id, exa.session.id));
    await this.audit.log(this.db.db, { action: 'Membership switched', kind: 'update', entityType: 'session', entityId: exa.session.id, summary: `→ ${target.roleLabel} · ${target.scopeLabel}` });
    exa.session.activeMembershipId = target.id;
    exa.session.activeBranchId = null;
    return this.build(req, target.id);
  }

  @Endpoint(coreContract.setBranch)
  async setBranch(@Req() req: FastifyRequest, @Input() { body }: Args<typeof coreContract.setBranch>): Promise<Me> {
    const exa = req.exa!;
    const c = exa.context;
    if (body.branchId) {
      if (c.membershipBranchIds && !c.membershipBranchIds.includes(body.branchId)) throw forbidden('That branch is outside your membership');
    } else if (c.membershipBranchIds && c.membershipBranchIds.length === 1) {
      throw forbidden('Your membership is bound to one branch');
    }
    await this.db.db.update(s.session).set({ activeBranchId: body.branchId }).where(eq(s.session.id, exa.session.id));
    exa.session.activeBranchId = body.branchId;
    return this.build(req);
  }

  private async build(req: FastifyRequest, membershipOverride?: string): Promise<Me> {
    const exa = req.exa!;
    const { user, session } = exa;
    const memberships = await this.access.memberships(user.id);
    const m = memberships.find((x) => x.id === (membershipOverride ?? session.activeMembershipId)) ?? memberships[0]!;
    const institution = await this.access.institution();
    const all = await this.access.activeBranches();
    const membershipBranchIds = m.scopeKind === 'institution' || m.branchIds.length === 0 ? null : m.branchIds;
    const allowed = membershipBranchIds ? all.filter((b) => membershipBranchIds.includes(b.id)) : all;
    let selectedId = session.activeBranchId && allowed.some((b) => b.id === session.activeBranchId) ? session.activeBranchId : null;
    if (!selectedId && allowed.length === 1) selectedId = allowed[0]!.id;

    let impersonation: Me['impersonation'] = null;
    if (session.impersonatedBy) {
      const [by] = await this.db.db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, session.impersonatedBy));
      impersonation = { byName: by?.name ?? 'Super Admin', expiresAt: new Date(session.expiresAt).toISOString() };
    }
    const requires2fa = user.twoFactorEnabled || institution.settings.security.require2faRoles.includes(m.roleKey);
    const initials = user.name
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0]!.toUpperCase())
      .slice(0, 2)
      .join('');

    return {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phoneNumber, initials, kind: user.kind, twoFactorEnabled: !!user.twoFactorEnabled },
      membership: {
        id: m.id,
        roleKey: m.roleKey,
        roleLabel: m.roleLabel,
        scopeLabel: m.scopeLabel,
        surface: m.surface,
        permissions: m.permissions,
        branchIds: m.branchIds,
        scopeKind: m.scopeKind,
      },
      memberships: memberships.map((x) => ({ id: x.id, roleKey: x.roleKey, roleLabel: x.roleLabel, scopeLabel: x.scopeLabel, surface: x.surface })),
      branch: { selectedId, allowed, locked: allowed.length <= 1, canSelectAll: allowed.length > 1 },
      institution: { id: institution.id, name: institution.name, brandColor: institution.brandColor },
      impersonation,
      readOnly: session.readOnly,
      needs2faEnrollment: requires2fa && !user.twoFactorEnabled && !session.twoFactorVerified,
      session: {
        idleTimeoutMin: user.kind === 'staff' && !session.impersonatedBy ? institution.settings.security.staffIdleMinutes : null,
        twoFactor: !!user.twoFactorEnabled || session.authMethod === 'demo',
      },
      demoMode: env().DEMO_MODE,
    };
  }
}
