import { Injectable } from '@nestjs/common';
import { PERMISSIONS, SUPERADMIN_LOCKED_PERMISSIONS, SYSTEM_ROLES, type InstRole, type RoleCreateInput } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, sql, type SQL } from '@exatech/db';
import { AccessService } from '../../core/auth/access.service';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { invalid, notFound } from '../../core/errors';
import { NotifyService } from '../../core/notifications/notify.service';

const LABEL = new Map<string, string>(PERMISSIONS.map((p) => [p.key, p.label]));
const label = (k: string) => LABEL.get(k) ?? k;

/** Roles & permissions (system of record: role). Least privilege: new roles start empty. */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async rows(where?: SQL): Promise<InstRole[]> {
    const inst = await this.access.institution();
    const rows = await this.db.db
      .select({
        r: s.role,
        members: sql<number>`(select count(*)::int from membership m join "user" u on u.id = m.user_id where m.role_id = role.id and m.status = 'active' and u.status <> 'deactivated')`,
      })
      .from(s.role)
      .where(and(eq(s.role.institutionId, inst.id), where))
      .orderBy(asc(s.role.position), asc(s.role.name));
    return rows.map(({ r, members }) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      scopeKind: r.scopeKind,
      surface: r.surface,
      isSystem: r.isSystem,
      permissions: r.permissions,
      members: Number(members),
      position: r.position,
    }));
  }

  async list() {
    const inst = await this.access.institution();
    return { roles: await this.rows(), thresholds: inst.settings.discountThresholds, impersonationMinutes: inst.settings.security.impersonationMinutes };
  }

  async create(body: RoleCreateInput & { key: string }): Promise<InstRole> {
    const inst = await this.access.institution();
    if ((SYSTEM_ROLES as readonly string[]).includes(body.key)) throw invalid(`${body.key} is a system role key — choose another`, { key: 'Reserved' });
    const id = await this.db.tx(async (tx) => {
      const [dup] = await tx.select({ name: s.role.name }).from(s.role).where(and(eq(s.role.institutionId, inst.id), eq(s.role.key, body.key)));
      if (dup) throw invalid(`The key ${body.key} is already used by ${dup.name}`, { key: 'Already used' });
      const [dupName] = await tx.select({ key: s.role.key }).from(s.role).where(and(eq(s.role.institutionId, inst.id), sql`lower(${s.role.name}) = ${body.name.trim().toLowerCase()}`));
      if (dupName) throw invalid(`A role called ${body.name.trim()} already exists`, { name: 'Already used' });
      const [pos] = await tx.select({ n: sql<number>`coalesce(max(${s.role.position}), 0)::int` }).from(s.role).where(eq(s.role.institutionId, inst.id));
      const [r] = await tx
        .insert(s.role)
        .values({ institutionId: inst.id, key: body.key, name: body.name.trim(), description: body.description ?? null, scopeKind: body.scopeKind, surface: body.surface, isSystem: false, permissions: [], position: Number(pos?.n ?? 0) + 1 })
        .returning({ id: s.role.id });
      await this.audit.log(tx, {
        action: 'Role created',
        kind: 'create',
        entityType: 'role',
        entityId: r!.id,
        entityLabel: body.name.trim(),
        after: { key: body.key, name: body.name.trim(), scopeKind: body.scopeKind, surface: body.surface, permissions: [] },
        summary: `${body.name.trim()} (${body.key}) · ${body.scopeKind} scope · ${body.surface} · starts with no permissions`,
        branchId: null,
      });
      this.notify.invalidate(tx, null, [['institution', 'roles']]);
      return r!.id;
    });
    await this.access.bump();
    const [row] = await this.rows(eq(s.role.id, id));
    return row!;
  }

  async saveMatrix(changes: { roleId: string; permissions: string[] }[]): Promise<InstRole[]> {
    const c = ctx();
    const inst = await this.access.institution();
    const ids = changes.map((x) => x.roleId);
    if (new Set(ids).size !== ids.length) throw invalid('Each role appears once in a save');
    await this.db.tx(async (tx) => {
      const roles = await tx.select().from(s.role).where(and(eq(s.role.institutionId, inst.id), inArray(s.role.id, ids))).for('update');
      const [mine] = await tx.select({ roleId: s.membership.roleId }).from(s.membership).where(eq(s.membership.id, c.membershipId));
      let changed = 0;
      for (const ch of changes) {
        const role = roles.find((r) => r.id === ch.roleId);
        if (!role) throw notFound('Role');
        const next = [...new Set(ch.permissions)].sort();
        if (role.key === 'superadmin') {
          const missing = SUPERADMIN_LOCKED_PERMISSIONS.filter((p) => !next.includes(p));
          if (missing.length) throw invalid(`Super Admin must keep “${missing.map(label).join('” and “')}” — without it nobody could change roles or decide approvals`, { [role.id]: 'Locked permission' });
        }
        if (mine?.roleId === role.id && !next.includes('institution:roles.manage')) throw invalid(`You would lose “${label('institution:roles.manage')}” on the role you are using — ask another administrator`, { [role.id]: 'Own access' });
        if ((role.key === 'student' || role.key === 'parent') && next.some((p) => !p.startsWith('portal:') && p !== 'comms:announcements.read')) {
          throw invalid(`${role.name} is a portal role — students and parents only get portal permissions`, { [role.id]: 'Portal role' });
        }
        const before = [...role.permissions].sort();
        const added = next.filter((p) => !before.includes(p));
        const removed = before.filter((p) => !next.includes(p));
        if (added.length === 0 && removed.length === 0) continue;
        changed++;
        await tx.update(s.role).set({ permissions: next, updatedAt: new Date() }).where(eq(s.role.id, role.id));
        await this.audit.log(tx, {
          action: 'Permissions changed',
          kind: 'update',
          entityType: 'role',
          entityId: role.id,
          entityLabel: role.name,
          before: { permissions: before },
          after: { permissions: next },
          summary: `${role.name}: ${[...added.map((p) => `+ ${label(p)}`), ...removed.map((p) => `− ${label(p)}`)].join(' · ')}`,
          branchId: null,
        });
      }
      if (changed === 0) throw invalid('Nothing changed — tick or untick permissions first');
      this.notify.invalidate(tx, null, [['institution', 'roles'], ['me']]);
    });
    await this.access.bump();
    return this.rows(inArray(s.role.id, ids));
  }

  async remove(id: string) {
    const inst = await this.access.institution();
    await this.db.tx(async (tx) => {
      const [r] = await tx.select().from(s.role).where(and(eq(s.role.id, id), eq(s.role.institutionId, inst.id))).for('update');
      if (!r) throw notFound('Role');
      if (r.isSystem) throw invalid(`${r.name} is a system role and can’t be deleted — untick its permissions instead`);
      const [m] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.membership)
        .innerJoin(s.user, eq(s.user.id, s.membership.userId))
        .where(and(eq(s.membership.roleId, id), eq(s.membership.status, 'active'), sql`${s.user.status} <> 'deactivated'`));
      const n = Number(m?.n ?? 0);
      if (n > 0) throw invalid(`${n} ${n === 1 ? 'person still holds' : 'people still hold'} ${r.name} — change their memberships first`);
      await tx.delete(s.membership).where(eq(s.membership.roleId, id));
      await tx.delete(s.role).where(eq(s.role.id, id));
      await this.audit.log(tx, { action: 'Role deleted', kind: 'delete', entityType: 'role', entityId: id, entityLabel: r.name, before: { key: r.key, permissions: r.permissions }, summary: `${r.name} (${r.key}) deleted · had ${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`, branchId: null });
      this.notify.invalidate(tx, null, [['institution', 'roles']]);
    });
    await this.access.bump();
    return { ok: true as const };
  }
}
