import '../config/load-env';
import * as s from '@exatech/db';
import { and, createDb, eq, sql } from '@exatech/db';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

/**
 * Administrator tool: give an account a password (or check one) without going through email.
 *
 *   EXA_NEW_PASSWORD='…' node dist/scripts/set-password.js <email> [--temporary]
 *   EXA_NEW_PASSWORD='…' node dist/scripts/set-password.js <email> --check      (verifies, signs nobody in)
 *
 * --temporary: the person must choose their own password at the next sign-in.
 * Setting a password signs the account out everywhere. The password is read from the environment
 * (never the command line, which other users on the machine can see) and is never printed or logged.
 */
async function main() {
  const [email, ...flags] = process.argv.slice(2);
  const password = process.env.EXA_NEW_PASSWORD;
  if (!email || !password) {
    console.error('usage: EXA_NEW_PASSWORD=… node dist/scripts/set-password.js <email> [--temporary | --check]');
    process.exit(2);
  }
  const h = createDb(process.env.DATABASE_URL, { max: 2 });
  try {
    const [user] = await h.db.select({ id: s.user.id, name: s.user.name, status: s.user.status }).from(s.user).where(eq(s.user.email, email.toLowerCase())).limit(1);
    if (!user) {
      console.error(`No account with email ${email}`);
      process.exit(1);
    }
    const [account] = await h.db
      .select({ id: s.account.id, password: s.account.password })
      .from(s.account)
      .where(and(eq(s.account.userId, user.id), eq(s.account.providerId, 'credential')))
      .limit(1);

    if (flags.includes('--check')) {
      const ok = !!account?.password && (await verifyPassword({ hash: account.password, password }));
      console.log(`${user.name}: password ${ok ? 'MATCHES' : 'does not match'}`);
      process.exit(ok ? 0 : 1);
    }

    const hash = await hashPassword(password);
    if (account) await h.db.update(s.account).set({ password: hash, updatedAt: new Date() }).where(eq(s.account.id, account.id));
    else await h.db.insert(s.account).values({ userId: user.id, accountId: user.id, providerId: 'credential', password: hash });
    const temporary = flags.includes('--temporary');
    await h.db.update(s.user).set({ mustChangePassword: temporary }).where(eq(s.user.id, user.id));
    await h.db.delete(s.session).where(eq(s.session.userId, user.id));
    await h.db.insert(s.auditLog).values({
      actorName: 'Administrator (server)',
      action: 'Password set by administrator',
      actionKind: 'update',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.name,
      summary: temporary ? 'temporary password · must be changed at next sign-in' : 'password set',
    });
    console.log(`✓ ${user.name}: ${temporary ? 'temporary password set (must be changed at next sign-in)' : 'password set'}; signed out everywhere`);
  } finally {
    await h.sql.end();
  }
}

void sql;
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
