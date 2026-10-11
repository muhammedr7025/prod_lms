import postgres from 'postgres';

/** Drops and recreates the database named in DATABASE_URL. Refuses to run in production. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Unsafe database name: ${name}`);
  u.pathname = '/postgres';
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`);
    await admin.unsafe(`drop database if exists "${name}"`);
    await admin.unsafe(`create database "${name}"`);
    console.log(`✓ database ${name} recreated`);
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
