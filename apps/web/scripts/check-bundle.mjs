#!/usr/bin/env node
/**
 * PRD NFR: initial JS per authenticated route under 180 kB gzip.
 * Reads the route table printed by `next build` and fails when a route's
 * "First Load JS" is over budget. Usage: node scripts/check-bundle.mjs next-build.log
 */
import fs from 'node:fs';

const BUDGET_KB = 180;
/** Routes allowed over budget, with the reason (keep this list short). */
const ALLOW = {
  '/sales/pipeline': 'motion — spring-physics card drag (PRD motion table: lead stage change)',
};

const file = process.argv[2];
if (!file) {
  console.error('usage: check-bundle.mjs <next build output>');
  process.exit(2);
}
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = /^[┌├└]\s+[○ƒ●λ]\s+(\S+)\s+[\d.]+\s+k?B\s+([\d.]+)\s+(k?B)\s*$/.exec(line);
  if (m) rows.push({ route: m[1], kb: m[3] === 'kB' ? Number(m[2]) : Number(m[2]) / 1024 });
}
if (rows.length === 0) {
  console.error('No route table found — was this the output of `next build`?');
  process.exit(2);
}
const over = rows.filter((r) => r.kb > BUDGET_KB && !ALLOW[r.route]);
const max = rows.reduce((a, r) => (r.kb > a.kb && !ALLOW[r.route] ? r : a), { route: '-', kb: 0 });
for (const r of rows.filter((x) => x.kb > BUDGET_KB && ALLOW[x.route])) console.log(`allowed  ${r.route} ${r.kb} kB — ${ALLOW[r.route]}`);
if (over.length) {
  for (const r of over) console.error(`OVER     ${r.route} ${r.kb} kB (budget ${BUDGET_KB} kB)`);
  process.exit(1);
}
console.log(`bundle budget ok: ${rows.length} routes, largest ${max.route} ${max.kb} kB ≤ ${BUDGET_KB} kB`);
