import { Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from '@exatech/db';
import * as s from '@exatech/db';
import { normalizePhone } from '@exatech/domain';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { magicLink, phoneNumber } from 'better-auth/plugins';
import { z } from 'zod';
import { env } from '../../config/env';
import { Db } from '../db';
import { RedisService } from '../redis';
import { MessagingService } from '../messaging/messaging.service';

const RETURN_COOKIE = 'exa_imp_return';

function methodFromPath(path: string | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('/magic-link')) return 'magic_link';
  if (path.startsWith('/phone-number')) return 'phone_otp';
  if (path.startsWith('/callback') || path.startsWith('/oauth2')) return 'google';
  return null;
}

export interface AuthDeps {
  db: Db;
  redis: RedisService;
  messaging: MessagingService;
}

/**
 * Better Auth, mounted inside the API at /api/auth/*. Accounts are
 * invite-only: Better Auth never creates users; we do (admission approval,
 * staff invite) and Better Auth only signs existing users in.
 */
export function createAuth(deps: AuthDeps) {
    const e = env();
    const { db, redis, messaging } = deps;
    const log = new Logger('Auth');

    const findUserByPhone = async (phone: string) =>
      (await db.db.select({ id: s.user.id, status: s.user.status }).from(s.user).where(eq(s.user.phoneNumber, phone)).limit(1))[0];

    const exaPlugin = {
      id: 'exa',
      endpoints: {
        /** DEMO_MODE only: sign in as a seeded persona (the prototype's "open as"). */
        exaDemoLogin: createAuthEndpoint('/exa/demo-login', { method: 'POST', body: z.object({ email: z.string().email() }) }, async (ctx) => {
          if (!env().DEMO_MODE) throw new APIError('NOT_FOUND');
          const found = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email);
          if (!found?.user) throw new APIError('BAD_REQUEST', { message: 'Unknown demo account' });
          const session = await ctx.context.internalAdapter.createSession(found.user.id, ctx, false, { authMethod: 'demo', twoFactorVerified: true });
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR');
          await setSessionCookie(ctx, { session, user: found.user });
          return ctx.json({ ok: true });
        }),
        /** Super Admin "View as student": read-only, time-boxed, logged. */
        exaImpersonate: createAuthEndpoint(
          '/exa/impersonate',
          { method: 'POST', body: z.object({ userId: z.string().uuid(), reason: z.string().min(3).max(200) }) },
          async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            if (!current) throw new APIError('UNAUTHORIZED');
            const cs = current.session as unknown as { id: string; token: string; activeMembershipId: string | null; impersonatedBy: string | null; twoFactorVerified: boolean };
            if (cs.impersonatedBy) throw new APIError('BAD_REQUEST', { message: 'Already viewing as another user' });
            // Impersonation is a privileged action: the session must have passed 2FA.
            if (!cs.twoFactorVerified) throw new APIError('FORBIDDEN', { message: 'Complete two-factor authentication first' });
            const perms = await db.sql<{ permissions: string[]; key: string; name: string }[]>`
              select r.permissions, r.key, r.name from membership m join role r on r.id = m.role_id
              where m.user_id = ${current.user.id} and m.status = 'active'
              ${cs.activeMembershipId ? db.sql`and m.id = ${cs.activeMembershipId}` : db.sql`order by m.is_default desc`} limit 1`;
            if (!perms[0]?.permissions.includes('institution:impersonate')) throw new APIError('FORBIDDEN', { message: 'You cannot view as another user' });
            const target = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
            if (!target) throw new APIError('NOT_FOUND', { message: 'User not found' });
            const kind = (target as unknown as { kind: string }).kind;
            if (kind === 'staff') throw new APIError('FORBIDDEN', { message: 'Only student and parent accounts can be viewed' });
            const [inst] = await db.db.select({ settings: s.institution.settings }).from(s.institution).limit(1);
            const minutes = inst?.settings.security.impersonationMinutes ?? 15;
            const session = await ctx.context.internalAdapter.createSession(
              target.id,
              ctx,
              true,
              {
                impersonatedBy: current.user.id,
                readOnly: true,
                authMethod: 'impersonation',
                twoFactorVerified: true,
                expiresAt: new Date(Date.now() + minutes * 60_000),
              },
              true,
            );
            if (!session) throw new APIError('INTERNAL_SERVER_ERROR');
            await ctx.setSignedCookie(RETURN_COOKIE, cs.token, ctx.context.secret, {
              httpOnly: true,
              sameSite: 'lax',
              path: '/',
              secure: env().NODE_ENV === 'production',
              maxAge: minutes * 60,
            });
            await setSessionCookie(ctx, { session, user: target }, true);
            await db.db.insert(s.auditLog).values({
              actorUserId: current.user.id,
              actorName: current.user.name,
              roleKey: perms[0].key,
              roleLabel: perms[0].name,
              action: 'Impersonation started',
              actionKind: 'impersonate',
              entityType: 'user',
              entityId: target.id,
              entityLabel: target.name,
              summary: `view as ${kind === 'student' ? 'student' : 'parent'} · ${minutes} min · reason: ${ctx.body.reason}`,
              ip: ctx.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
            });
            return ctx.json({ ok: true, expiresAt: session.expiresAt });
          },
        ),
        exaStopImpersonation: createAuthEndpoint('/exa/stop-impersonation', { method: 'POST' }, async (ctx) => {
          const current = await getSessionFromCtx(ctx);
          const returnToken = await ctx.getSignedCookie(RETURN_COOKIE, ctx.context.secret);
          if (current && (current.session as unknown as { impersonatedBy: string | null }).impersonatedBy) {
            await ctx.context.internalAdapter.deleteSession(current.session.token);
          }
          ctx.setCookie(RETURN_COOKIE, '', { path: '/', maxAge: 0 });
          if (!returnToken) return ctx.json({ ok: true, restored: false });
          const original = await ctx.context.internalAdapter.findSession(returnToken);
          if (!original || original.session.expiresAt < new Date()) return ctx.json({ ok: true, restored: false });
          await setSessionCookie(ctx, original);
          return ctx.json({ ok: true, restored: true });
        }),
      },
    } as const;

    return betterAuth({
      appName: 'Exatech',
      baseURL: e.WEB_ORIGIN,
      basePath: '/api/auth',
      secret: e.AUTH_SECRET,
      trustedOrigins: [e.WEB_ORIGIN],
      database: drizzleAdapter(db.db, {
        provider: 'pg',
        schema: { user: s.user, session: s.session, account: s.account, verification: s.verification },
      }),
      emailAndPassword: { enabled: false },
      advanced: {
        database: { generateId: () => s.uuidv7() },
        cookiePrefix: 'exa',
        useSecureCookies: e.NODE_ENV === 'production',
        ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] },
      },
      session: {
        // Outer bound; the API guard applies the configured limits (staff 12 h + idle timeout,
        // portal N days rolling since last activity) from institution settings.
        expiresIn: 60 * 60 * 24 * 30,
        updateAge: 60 * 60 * 24,
        additionalFields: {
          activeMembershipId: { type: 'string', required: false, input: false },
          activeBranchId: { type: 'string', required: false, input: false },
          impersonatedBy: { type: 'string', required: false, input: false },
          readOnly: { type: 'boolean', required: false, input: false, defaultValue: false },
          lastSeenAt: { type: 'date', required: false, input: false },
          authMethod: { type: 'string', required: false, input: false },
          twoFactorVerified: { type: 'boolean', required: false, input: false, defaultValue: false },
        },
      },
      user: {
        additionalFields: {
          kind: { type: 'string', required: false, input: false },
          status: { type: 'string', required: false, input: false },
          twoFactorEnabled: { type: 'boolean', required: false, input: false },
        },
      },
      account: {
        accountLinking: { enabled: true, trustedProviders: ['google'] },
      },
      socialProviders:
        e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
          ? { google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, disableSignUp: true, disableImplicitSignUp: true } }
          : {},
      rateLimit: {
        enabled: e.NODE_ENV !== 'test',
        window: 60,
        max: 120,
        storage: 'memory',
        customRules: {
          '/sign-in/magic-link': { window: 60, max: 5 },
          '/phone-number/send-otp': { window: 60, max: 5 },
          '/phone-number/verify': { window: 60, max: 10 },
        },
      },
      databaseHooks: {
        user: {
          create: {
            // Invite-only: Better Auth never creates users.
            before: async () => false,
          },
        },
        session: {
          create: {
            before: async (session, context) => {
              const data = session as typeof session & Record<string, unknown>;
              const u = (await db.db.select({ status: s.user.status }).from(s.user).where(eq(s.user.id, session.userId)).limit(1))[0];
              if (!u || u.status === 'deactivated') return false;
              const m = (
                await db.db
                  .select({ id: s.membership.id })
                  .from(s.membership)
                  .where(and(eq(s.membership.userId, session.userId), eq(s.membership.status, 'active')))
                  .orderBy(sql`${s.membership.isDefault} desc`, s.membership.createdAt)
                  .limit(1)
              )[0];
              return {
                data: {
                  ...data,
                  authMethod: (data.authMethod as string | undefined) ?? methodFromPath(context?.path) ?? 'unknown',
                  twoFactorVerified: (data.twoFactorVerified as boolean | undefined) ?? false,
                  activeMembershipId: (data.activeMembershipId as string | undefined) ?? m?.id ?? null,
                  lastSeenAt: new Date(),
                },
              };
            },
            after: async (session) => {
              const data = session as typeof session & { authMethod?: string; activeMembershipId?: string | null };
              if (data.authMethod === 'impersonation') return;
              const [u] = await db.db
                .update(s.user)
                .set({ lastLoginAt: new Date(), status: sql`case when ${s.user.status} = 'invited' then 'active' else ${s.user.status} end` })
                .where(eq(s.user.id, session.userId))
                .returning({ name: s.user.name });
              const role = data.activeMembershipId
                ? (
                    await db.db
                      .select({ key: s.role.key, name: s.role.name })
                      .from(s.membership)
                      .innerJoin(s.role, eq(s.role.id, s.membership.roleId))
                      .where(eq(s.membership.id, data.activeMembershipId))
                  )[0]
                : undefined;
              await db.db.insert(s.auditLog).values({
                actorUserId: session.userId,
                actorName: u?.name ?? 'Unknown',
                roleKey: role?.key ?? null,
                roleLabel: role?.name ?? null,
                action: 'Signed in',
                actionKind: 'login',
                entityType: 'session',
                entityId: session.id,
                summary: `via ${String(data.authMethod ?? 'unknown').replace('_', ' ')}`,
                ip: session.ipAddress ?? null,
              });
            },
          },
        },
      },
      plugins: [
        magicLink({
          disableSignUp: true,
          expiresIn: 60 * 15,
          sendMagicLink: async ({ email, url }) => {
            if (!(await redis.rateLimit(`magic:${email.toLowerCase()}`, 5, 3600))) {
              throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in links requested. Try again in an hour.' });
            }
            const known = (await db.db.select({ id: s.user.id, name: s.user.name, status: s.user.status }).from(s.user).where(eq(s.user.email, email.toLowerCase())).limit(1))[0];
            // Same response either way so emails cannot be enumerated; only invited users get mail.
            if (!known || known.status === 'deactivated') return;
            await messaging.sendNow({
              channel: 'email',
              to: email,
              toUserId: known.id,
              subject: 'Your Exatech sign-in link',
              body: `Hi ${known.name},\n\nUse this link to sign in to Exatech. It expires in 15 minutes and works once.\n\n${url}\n\nIf you did not ask for this, you can ignore this email.`,
              template: 'magic_link',
            });
          },
        }),
        phoneNumber({
          otpLength: 6,
          expiresIn: 300,
          allowedAttempts: 5,
          phoneNumberValidator: (phone) => normalizePhone(phone) === phone,
          sendOTP: async ({ phoneNumber: phone, code }) => {
            if (!(await redis.rateLimit(`otp:${phone}`, 5, 3600))) {
              throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes requested. Try again in an hour.' });
            }
            const known = await findUserByPhone(phone);
            if (!known || known.status === 'deactivated') return;
            await messaging.sendNow({
              channel: 'whatsapp',
              to: phone,
              toUserId: known.id,
              template: 'otp',
              body: `Your Exatech sign-in code is ${code}. It expires in 5 minutes. Do not share it.`,
            });
            if (env().DEMO_MODE) log.log(`OTP for ${phone}: ${code}`);
          },
        }),
        exaPlugin,
      ],
      hooks: {
        before: createAuthMiddleware(async (inner) => {
          // Phone OTP verification must never create users (invite-only).
          if (inner.path === '/phone-number/verify') {
            const phone = (inner.body as { phoneNumber?: string } | undefined)?.phoneNumber;
            const known = phone ? await findUserByPhone(phone) : undefined;
            if (!known || known.status === 'deactivated') throw new APIError('BAD_REQUEST', { message: 'Invalid code' });
          }
        }),
        after: createAuthMiddleware(async (inner) => {
          // Never reveal whether an email has an account: unknown addresses get the same reply.
          if (inner.path === '/sign-in/magic-link') {
            const returned = inner.context.returned as { body?: { code?: string }; status?: string } | undefined;
            if (returned instanceof APIError && (returned.body as { code?: string } | undefined)?.code === 'USER_NOT_FOUND') {
              return inner.json({ status: true });
            }
          }
        }),
      },
    });
}

export type Auth = ReturnType<typeof createAuth>;

@Injectable()
export class AuthService {
  readonly auth: Auth;
  constructor(db: Db, redis: RedisService, messaging: MessagingService) {
    this.auth = createAuth({ db, redis, messaging });
  }
}
