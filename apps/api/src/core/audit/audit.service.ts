import { Injectable } from '@nestjs/common';
import * as s from '@exatech/db';
import type { DbOrTx } from '@exatech/db';
import { maybeCtx } from '../context';

export type ActionKind = 'create' | 'update' | 'approve' | 'login' | 'export' | 'impersonate' | 'publish' | 'payment' | 'delete' | 'other';

export interface AuditInput {
  action: string;
  kind: ActionKind;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  /** Human "before → after" text shown in the log. */
  summary?: string | null;
  branchId?: string | null;
}

/**
 * Append-only audit (insert-only trigger in the database). Write it in the
 * same transaction as the change so the log never disagrees with the data.
 */
@Injectable()
export class AuditService {
  async log(tx: DbOrTx, input: AuditInput): Promise<void> {
    const c = maybeCtx();
    await tx.insert(s.auditLog).values({
      actorUserId: c?.userId ?? null,
      actorName: c ? (c.impersonatedBy ? `${c.userName} (impersonated)` : c.userName) : 'System',
      roleKey: c?.roleKey ?? 'system',
      roleLabel: c?.roleLabel ?? 'System',
      action: input.action,
      actionKind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      before: input.before === undefined ? null : (input.before as object),
      after: input.after === undefined ? null : (input.after as object),
      summary: input.summary ?? null,
      ip: c?.ip ?? null,
      branchId: input.branchId ?? c?.selectedBranchId ?? null,
      requestId: c?.requestId ?? null,
    });
  }
}
