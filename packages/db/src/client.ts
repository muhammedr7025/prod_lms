import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
/** A transaction handle has the same query surface as the database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number; debug?: boolean } = {}): DbHandle {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: 'snake_case', logger: opts.debug ?? false });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
