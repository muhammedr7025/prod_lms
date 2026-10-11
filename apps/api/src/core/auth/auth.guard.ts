import { type CallHandler, type CanActivate, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as s from '@exatech/db';
import { eq } from '@exatech/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { Observable } from 'rxjs';
import { runWithContext, type RequestContext } from '../context';
import { Db } from '../db';
import { DomainError, forbidden, unauthenticated } from '../errors';
import { ALLOW_2FA_PENDING, ALLOW_READONLY, PERMS, PUBLIC } from '../http';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';

export interface SessionInfo {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  activeMembershipId: string | null;
  activeBranchId: string | null;
  impersonatedBy: string | null;
  readOnly: boolean;
  lastSeenAt: Date | null;
  authMethod: string | null;
  twoFactorVerified: boolean;
}

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  kind: 'staff' | 'student' | 'guardian';
  status: string;
  twoFactorEnabled: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    exa?: { context: RequestContext; session: SessionInfo; user: UserInfo; needs2faEnrollment: boolean };
  }
}

/**
 * Global guard: session → membership → scope → permission. Runs on every
 * route; routes opt out with @Public(). The UI only hides what the server
 * already refuses.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly access: AccessService,
    private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();

    const result = await this.authService.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!result) throw unauthenticated();
    const session = result.session as unknown as SessionInfo;
    const user = result.user as unknown as UserInfo;
    if (user.status === 'deactivated') throw unauthenticated('This account has been deactivated');

    const institution = await this.access.institution();
    const security = institution.settings.security;
    const now = Date.now();

    // Staff sessions: 12 h hard limit, 30 min idle timeout.
    if (user.kind === 'staff' && !session.impersonatedBy) {
      const idleMs = security.staffIdleMinutes * 60_000;
      const tooOld = now - new Date(session.createdAt).getTime() > security.staffSessionHours * 3_600_000;
      const idle = session.lastSeenAt && now - new Date(session.lastSeenAt).getTime() > idleMs;
      if (tooOld || idle) {
        await this.db.db.delete(s.session).where(eq(s.session.id, session.id));
        throw new DomainError(idle ? 'SESSION_IDLE' : 'SESSION_EXPIRED', idle ? 'Signed out after 30 minutes of inactivity' : 'Your session has expired', 401);
      }
    }

    const memberships = await this.access.memberships(user.id);
    if (memberships.length === 0) throw forbidden('Your account has no active role. Ask an administrator to add one.');
    const m = memberships.find((x) => x.id === session.activeMembershipId) ?? memberships[0]!;

    // Mandatory 2FA for configured roles (and for anyone who enabled it).
    const requires2fa = user.twoFactorEnabled || security.require2faRoles.includes(m.roleKey);
    let needs2faEnrollment = false;
    if (requires2fa && !session.twoFactorVerified) {
      const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_2FA_PENDING, targets);
      if (user.twoFactorEnabled) {
        if (!allowPending) throw new DomainError('TWO_FACTOR_REQUIRED', 'Enter the code from your authenticator app', 401);
      } else {
        needs2faEnrollment = true;
        if (!allowPending) throw new DomainError('TWO_FACTOR_ENROLLMENT_REQUIRED', 'Set up two-factor authentication to continue', 403);
      }
    }

    // Read-only impersonation.
    if (session.readOnly && req.method !== 'GET' && !this.reflector.getAllAndOverride<boolean>(ALLOW_READONLY, targets)) {
      throw new DomainError('READ_ONLY', 'You are viewing as this user (read-only)', 403);
    }

    const membershipBranchIds = m.scopeKind === 'institution' || m.branchIds.length === 0 ? null : m.branchIds;
    let selectedBranchId: string | null = session.activeBranchId;
    if (selectedBranchId && membershipBranchIds && !membershipBranchIds.includes(selectedBranchId)) selectedBranchId = null;
    if (!selectedBranchId && membershipBranchIds && membershipBranchIds.length === 1) selectedBranchId = membershipBranchIds[0]!;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMS, targets);
    if (required && required.length > 0 && !required.some((p) => m.permissions.includes(p))) {
      throw forbidden('Your role does not allow this');
    }

    // Touch lastSeenAt at most once a minute (idle timeout).
    if (!session.lastSeenAt || now - new Date(session.lastSeenAt).getTime() > 60_000) {
      void this.db.db.update(s.session).set({ lastSeenAt: new Date() }).where(eq(s.session.id, session.id)).catch(() => undefined);
    }

    const ctx: RequestContext = {
      requestId: (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
      ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null,
      userId: user.id,
      userName: user.name,
      userKind: user.kind,
      sessionId: session.id,
      membershipId: m.id,
      roleKey: m.roleKey,
      roleLabel: m.roleLabel,
      scopeKind: m.scopeKind,
      permissions: new Set(m.permissions),
      institutionId: institution.id,
      membershipBranchIds,
      selectedBranchId,
      readOnly: session.readOnly,
      impersonatedBy: session.impersonatedBy,
    };
    req.exa = { context: ctx, session, user, needs2faEnrollment };
    return true;
  }
}

/** Runs the handler inside the request context resolved by the guard. */
@Injectable()
export class ContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const c = req.exa?.context;
    if (!c) return next.handle();
    return new Observable((subscriber) => runWithContext(c, () => next.handle().subscribe(subscriber)));
  }
}
