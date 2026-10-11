import { expect, test as base, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function apiEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(ROOT, 'apps/api/.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!;
    }
  }
  return out;
}

/**
 * Reset the demo data (and the seeded material files) so a spec starts from
 * the known seed. Call in `test.beforeAll` of specs that mutate data.
 * Uses the same DATABASE_URL / REDIS_PREFIX / S3_BUCKET as the running API.
 */
export function reseed(): void {
  const env = { ...apiEnv(), ...process.env } as NodeJS.ProcessEnv;
  execFileSync('node', [path.join(ROOT, 'packages/db/dist/seed/index.js')], { env, stdio: 'pipe', timeout: 120_000 });
  execFileSync('node', [path.join(ROOT, 'apps/api/dist/scripts/seed-files.js')], { env, stdio: 'pipe', timeout: 120_000, cwd: path.join(ROOT, 'apps/api') });
}

/** Seeded personas (DEMO_MODE). */
export const PERSONAS = {
  superadmin: 'deepu@exatech.test',
  branchadmin: 'priya@exatech.test',
  sales: 'meera@exatech.test',
  salesmanager: 'sanjay@exatech.test',
  finance: 'joseph@exatech.test',
  cashier: 'rema@exatech.test',
  teacher: 'nithin@exatech.test',
  teacher2: 'sanjay@exatech.test',
  student: 'anjali.menon@example.test',
  parent: 'suresh.menon@example.test',
  kochiTeacher: 'rahul@exatech.test',
} as const;

export type Persona = keyof typeof PERSONAS;

/** Sign in as a persona via the demo endpoint (sets the session cookie on the page's context). */
export async function loginAs(page: Page, persona: Persona) {
  const base = test.info().project.use.baseURL ?? 'http://localhost:3300';
  const res = await page.request.post(`${base}/api/auth/exa/demo-login`, { data: { email: PERSONAS[persona] }, headers: { Origin: base } });
  expect(res.ok(), `demo login for ${persona}`).toBeTruthy();
}

/** Fails the test on uncaught page errors or React errors in the console. */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/Failed to load resource|ERR_ABORTED|net::|EventSource|404 \(Not Found\)/.test(m.text())) errors.push(m.text());
      });
      await use();
      expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
