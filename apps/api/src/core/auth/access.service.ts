import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray } from '@exatech/db';
import type { InstitutionSettings } from '@exatech/db';
import { Db } from '../db';
import { RedisService } from '../redis';

export interface MembershipInfo {
  id: string;
  roleId: string;
  roleKey: string;
  roleLabel: string;
  scopeKind: 'institution' | 'branch' | 'batch' | 'own' | 'child';
  surface: 'staff' | 'portal';
  permissions: string[];
  branchIds: string[];
  scopeLabel: string;
  isDefault: boolean;
}

export interface InstitutionInfo {
  id: string;
  name: string;
  brandColor: string;
  settings: InstitutionSettings;
}

/**
 * Resolves a user's memberships (role × scope) with a short Redis cache.
 * Any role or membership change bumps a version so caches drop instantly.
 */
@Injectable()
export class AccessService {
  private institutionCache: { at: number; ver: string; value: InstitutionInfo } | null = null;

  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
  ) {}

  private async version(): Promise<string> {
    return (await this.redis.client.get(this.redis.key('access', 'ver'))) ?? '0';
  }

  /** Call after editing roles, permissions or memberships. */
  async bump(): Promise<void> {
    await this.redis.client.incr(this.redis.key('access', 'ver'));
    this.institutionCache = null;
  }

  async memberships(userId: string): Promise<MembershipInfo[]> {
    const ver = await this.version();
    return this.redis.cached(`access:${ver}:${userId}`, 300, async () => {
      const rows = await this.db.db
        .select({
          id: s.membership.id,
          roleId: s.role.id,
          roleKey: s.role.key,
          roleLabel: s.role.name,
          scopeKind: s.role.scopeKind,
          surface: s.role.surface,
          permissions: s.role.permissions,
          branchIds: s.membership.branchIds,
          scopeLabel: s.membership.scopeLabel,
          isDefault: s.membership.isDefault,
        })
        .from(s.membership)
        .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
        .where(and(eq(s.membership.userId, userId), eq(s.membership.status, 'active')))
        .orderBy(desc(s.membership.isDefault), asc(s.role.position));
      return rows.map((r) => ({ ...r, scopeLabel: r.scopeLabel ?? '' }));
    });
  }

  async institution(): Promise<InstitutionInfo> {
    const ver = await this.version();
    if (this.institutionCache && this.institutionCache.ver === ver && Date.now() - this.institutionCache.at < 60_000) return this.institutionCache.value;
    const [row] = await this.db.db.select().from(s.institution).limit(1);
    if (!row) throw new Error('Institution not configured — run the seed or setup');
    const value = { id: row.id, name: row.name, brandColor: row.brandColor, settings: row.settings };
    this.institutionCache = { at: Date.now(), ver, value };
    return value;
  }

  invalidateInstitution() {
    this.institutionCache = null;
  }

  async activeBranches(): Promise<{ id: string; code: string; name: string }[]> {
    const ver = await this.version();
    return this.redis.cached(`branches:active:${ver}`, 60, () =>
      this.db.db.select({ id: s.branch.id, code: s.branch.code, name: s.branch.name }).from(s.branch).where(inArray(s.branch.status, ['active', 'paused'])).orderBy(asc(s.branch.openedOn)),
    );
  }
}
