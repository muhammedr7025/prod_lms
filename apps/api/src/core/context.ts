import { AsyncLocalStorage } from 'node:async_hooks';
import type { Permission } from '@exatech/contracts';
import { forbidden } from './errors';

/**
 * Who is acting, as what, and where. Resolved once per request by the
 * session guard and available everywhere through `ctx()`.
 */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userId: string;
  userName: string;
  userKind: 'staff' | 'student' | 'guardian';
  sessionId: string;
  membershipId: string;
  roleKey: string;
  roleLabel: string;
  scopeKind: 'institution' | 'branch' | 'batch' | 'own' | 'child';
  permissions: ReadonlySet<string>;
  institutionId: string;
  /** Branches the membership covers; null = institution-wide. */
  membershipBranchIds: string[] | null;
  /** The branch picked in the header; null = all branches the membership allows. */
  selectedBranchId: string | null;
  readOnly: boolean;
  impersonatedBy: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function ctx(): RequestContext {
  const c = storage.getStore();
  if (!c) throw new Error('No request context (are you outside an authenticated request?)');
  return c;
}

export function maybeCtx(): RequestContext | undefined {
  return storage.getStore();
}

export function can(perm: Permission): boolean {
  return ctx().permissions.has(perm);
}

export function assertCan(perm: Permission, message?: string): void {
  if (!can(perm)) throw forbidden(message);
}

/**
 * Branch ids the current request may read, honouring the header branch switcher.
 * null = no restriction (institution-wide membership with "All branches" selected).
 */
export function branchScope(): string[] | null {
  const c = ctx();
  if (c.selectedBranchId) return [c.selectedBranchId];
  return c.membershipBranchIds;
}

/** Throws unless the branch is inside the membership (switcher selection ignored). */
export function assertBranchAccess(branchId: string): void {
  const c = ctx();
  if (c.membershipBranchIds && !c.membershipBranchIds.includes(branchId)) {
    throw forbidden('This record belongs to a branch outside your membership');
  }
}

/** Throws unless the branch is inside the current branch scope (switcher respected). */
export function assertInScope(branchId: string): void {
  const scope = branchScope();
  if (scope && !scope.includes(branchId)) throw forbidden('This record is outside the selected branch');
}
