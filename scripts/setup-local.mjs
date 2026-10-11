#!/usr/bin/env node
/**
 * One-command local setup: builds shared packages, creates the database,
 * runs migrations, seeds demo data and generates seeded files.
 *
 *   pnpm setup:local            # uses apps/api/.env (DATABASE_URL etc.)
 *   DATABASE_URL=... pnpm setup:local
 *
 * Requires Postgres 16, Redis, MinIO (or any S3) and optionally Mailpit — see README.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, 'apps/api/.env');
if (!fs.existsSync(envFile)) {
  fs.copyFileSync(path.join(root, '.env.example'), envFile);
  console.log('created apps/api/.env from .env.example');
}
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root, env: { ...process.env, DATABASE_URL: url }, ...opts });
};

run('pnpm --filter @exatech/domain --filter @exatech/contracts --filter @exatech/db build');
const dbName = new URL(url).pathname.slice(1);
try {
  execSync(`psql "${url.replace(/\/[^/]+$/, '/postgres')}" -tAc "select 1 from pg_database where datname='${dbName}'"`, { stdio: 'pipe' }).toString().trim() === '1'
    ? console.log(`database ${dbName} exists`)
    : run(`createdb ${dbName}`);
} catch {
  run(`createdb ${dbName}`);
}
run('pnpm --filter @exatech/db migrate');
run('pnpm --filter @exatech/db seed');
run('pnpm --filter @exatech/api build');
run('pnpm --filter @exatech/api seed:files');
console.log('\n✓ Local environment ready. Run `pnpm dev` and open the WEB_ORIGIN (default http://localhost:3300).');
