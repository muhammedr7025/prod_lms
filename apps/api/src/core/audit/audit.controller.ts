import { Controller, Query, Res } from '@nestjs/common';
import { auditContract, type AuditEntry } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from '@exatech/db';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertCan, ctx } from '../context';
import { Db, inBranchScope } from '../db';
import { Can, Endpoint, Input, type Args } from '../http';
import { AuditService } from './audit.service';

const FINANCE_ENTITIES = ['payment', 'invoice', 'receipt', 'credit_note', 'cash_session', 'enrollment_fee', 'approval', 'settlement', 'instalment', 'report'];
const RANGE_MS: Record<string, number | null> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: null };

/** Cursor = "<iso time>|<id>" for keyset pagination over (at desc, id desc). */
function decodeCursor(c?: string): { at: Date; id: string } | null {
  if (!c) return null;
  const [at, id] = c.split('|');
  if (!at || !id) return null;
  return { at: new Date(at), id };
}

@Controller()
export class AuditController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private filters(q: { q?: string; actionKind?: string; roleKey?: string; range: string }): SQL[] {
    const c = ctx();
    const where: SQL[] = [];
    // Scope: Super Admin = everything; Branch Admin = their branches; Finance = finance entities in their branches.
    if (c.roleKey !== 'superadmin') {
      const scope = inBranchScope(s.auditLog.branchId);
      if (scope) where.push(or(scope, sql`${s.auditLog.branchId} is null and ${s.auditLog.actorUserId} = ${c.userId}`)!);
    }
    if (c.roleKey === 'finance') where.push(inArray(s.auditLog.entityType, FINANCE_ENTITIES));
    const ms = RANGE_MS[q.range];
    if (ms) where.push(gte(s.auditLog.at, new Date(Date.now() - ms)));
    if (q.actionKind) where.push(eq(s.auditLog.actionKind, q.actionKind));
    if (q.roleKey) where.push(eq(s.auditLog.roleKey, q.roleKey));
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, '')}%`;
      where.push(or(ilike(s.auditLog.actorName, like), ilike(s.auditLog.entityType, like), ilike(s.auditLog.entityId, like), ilike(s.auditLog.entityLabel, like), ilike(s.auditLog.summary, like), ilike(s.auditLog.action, like))!);
    }
    return where;
  }

  private toEntry(r: typeof s.auditLog.$inferSelect): AuditEntry {
    return {
      id: r.id,
      at: r.at.toISOString(),
      actorName: r.actorName,
      roleLabel: r.roleLabel,
      action: r.action,
      actionKind: r.actionKind,
      entity: `${r.entityType}/${r.entityLabel ?? (r.entityId ? `…${r.entityId.slice(-4)}` : '')}`,
      summary: r.summary,
      ip: r.ip,
    };
  }

  @Endpoint(auditContract.list)
  @Can('audit:read')
  async list(@Input() { query }: Args<typeof auditContract.list>) {
    const where = this.filters(query);
    const cur = decodeCursor(query.cursor);
    if (cur) where.push(or(lt(s.auditLog.at, cur.at), and(eq(s.auditLog.at, cur.at), lt(s.auditLog.id, cur.id)))!);
    const rows = await this.db.db
      .select()
      .from(s.auditLog)
      .where(and(...where))
      .orderBy(desc(s.auditLog.at), desc(s.auditLog.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.toEntry(r)), nextCursor: rows.length > query.limit && last ? `${last.at.toISOString()}|${last.id}` : null };
  }

  @Endpoint(auditContract.recent)
  @Can('audit:read')
  async recent() {
    const rows = await this.db.db
      .select()
      .from(s.auditLog)
      .where(and(...this.filters({ range: '24h' })))
      .orderBy(desc(s.auditLog.at))
      .limit(6);
    return rows.map((r) => this.toEntry(r));
  }

  /** Watermarked CSV export (logged). */
  @Endpoint({ method: 'GET', path: auditContract.exportPath, response: z.any() })
  @Can('audit:read')
  async export(@Query() raw: Record<string, string>, @Res() reply: FastifyReply) {
    assertCan('audit:read');
    const q = { q: raw.q, actionKind: raw.actionKind, roleKey: raw.roleKey, range: raw.range ?? '24h' };
    const rows = await this.db.db
      .select()
      .from(s.auditLog)
      .where(and(...this.filters(q)))
      .orderBy(desc(s.auditLog.at))
      .limit(10_000);
    const c = ctx();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      `# Exported by ${c.userName} (${c.roleLabel}) at ${new Date().toISOString()} — confidential, do not share`,
      ['time', 'actor', 'role', 'action', 'entity', 'summary', 'ip'].join(','),
      ...rows.map((r) => [r.at.toISOString(), r.actorName, r.roleLabel, r.action, `${r.entityType}/${r.entityLabel ?? r.entityId ?? ''}`, r.summary, r.ip].map(esc).join(',')),
    ];
    await this.audit.log(this.db.db, { action: 'Export', kind: 'export', entityType: 'report', entityLabel: 'audit-log', summary: `Audit CSV · ${rows.length} rows · watermarked` });
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(lines.join('\n'));
  }
}
