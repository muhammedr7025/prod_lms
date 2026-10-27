import type { Sql } from 'postgres';

/**
 * Refuse to wipe a database that holds a real institute's data (marked by the
 * onboarding import with institution.settings.live = true). The demo seed, the
 * e2e reseed and db:reset all call this first. Override only on purpose:
 * EXATECH_WIPE_LIVE=<database name>.
 */
export async function assertNotLive(sql: Sql, dbName: string): Promise<void> {
  const [t] = await sql<{ exists: boolean }[]>`select to_regclass('public.institution') is not null as exists`;
  if (!t?.exists) return;
  const live = await sql<{ name: string }[]>`select name from institution where settings->>'live' = 'true' limit 1`;
  if (live.length && process.env.EXATECH_WIPE_LIVE !== dbName) {
    throw new Error(
      `Database "${dbName}" holds live data for ${live[0]!.name}. Refusing to wipe it. ` +
        `Point DATABASE_URL at the demo database, or set EXATECH_WIPE_LIVE=${dbName} if you really mean it.`,
    );
  }
}
