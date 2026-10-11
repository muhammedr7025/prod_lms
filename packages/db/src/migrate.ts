import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

/**
 * Runs migrations, then (re)installs the database-level guarantees the PRD
 * asks for: append-only ledger and audit tables.
 */
export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  const h = createDb(url, { max: 1 });
  try {
    await h.sql`create extension if not exists pg_trgm`;
    await migrate(h.db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
    await h.sql.unsafe(`
      create or replace function exatech_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'table % is append-only (% not allowed)', tg_table_name, tg_op;
      end $$;

      drop trigger if exists ledger_entry_append_only on ledger_entry;
      create trigger ledger_entry_append_only before update or delete on ledger_entry
        for each row execute function exatech_append_only();

      drop trigger if exists audit_log_append_only on audit_log;
      create trigger audit_log_append_only before update or delete on audit_log
        for each row execute function exatech_append_only();
    `);
  } finally {
    await h.close();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('✓ migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
