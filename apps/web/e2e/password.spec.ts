import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { apiEnv, expect, reseed, test } from './fixtures';

/**
 * Password sign-in for accounts an administrator gave a temporary password:
 * forced change on first sign-in, the API locked until then, password rules,
 * wrong-guess limits, and the administrator tool. Mutates data → reseeds first.
 */
const ROOT = path.resolve(__dirname, '../../..');
const TEMP = 'Exatech@123';
const NEW = 'Riverside-Lamp-42';
const EMAIL = 'meera@exatech.test';

test.beforeAll(() => reseed());
test.describe.configure({ mode: 'serial', timeout: 120_000 });

function adminTool(email: string, password: string, ...flags: string[]) {
  const env = { ...process.env, ...apiEnv(), EXA_NEW_PASSWORD: password } as NodeJS.ProcessEnv;
  return execFileSync('node', [path.join(ROOT, 'apps/api/dist/scripts/set-password.js'), email, ...flags], { env, cwd: path.join(ROOT, 'apps/api'), encoding: 'utf8' });
}

/** Wrong-guess counters live in Redis for 15 minutes — clear them so the spec can be re-run. */
async function clearGuessLimits() {
  const env = { ...apiEnv(), ...process.env };
  const Redis = createRequire(path.join(ROOT, 'apps/api/package.json'))('ioredis');
  const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379/0');
  const keys: string[] = await redis.keys(`${env.REDIS_PREFIX ?? 'exa'}:rl:pwd:*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('the administrator tool sets a temporary password; --check verifies it without signing anyone in', async () => {
  expect(adminTool(EMAIL, TEMP, '--temporary')).toContain('temporary password set');
  expect(adminTool(EMAIL, TEMP, '--check')).toContain('MATCHES');
  expect(() => adminTool(EMAIL, 'not-the-password', '--check')).toThrow();
});

test('temporary password: wrong password refused, right one forces a new password before anything else', async ({ page }) => {
  await clearGuessLimits();
  await page.goto('/sign-in');
  await expect(page.getByRole('radio', { name: 'Password' })).toHaveAttribute('aria-checked', 'true');

  await signIn(page, EMAIL, 'Wrong-pass-1');
  await expect(page.getByText('Invalid email or password')).toBeVisible();

  await signIn(page, EMAIL, TEMP);
  await expect(page).toHaveURL(/\/security\/password\?forced=1/);
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();

  // The API refuses everything except /api/me until a new password is chosen.
  const blocked = await page.request.get('/api/reference');
  expect(blocked.status()).toBe(403);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  const me = (await (await page.request.get('/api/me')).json()) as { mustChangePassword: boolean };
  expect(me.mustChangePassword).toBe(true);
  await page.goto('/sales/pipeline');
  await expect(page).toHaveURL(/\/security\/password/);

  // Password rules and mistakes are explained inline, nothing is saved.
  const fill = async (cur: string, a: string, b: string) => {
    await page.getByLabel('Temporary password').fill(cur);
    await page.getByLabel('New password', { exact: true }).fill(a);
    await page.getByLabel('New password again').fill(b);
    await page.getByRole('button', { name: 'Save new password' }).click();
  };
  await fill(TEMP, 'short1', 'short1');
  await expect(page.getByText('Use at least 10 characters')).toBeVisible();
  await fill(TEMP, 'Exatech-Learning-2026', 'Exatech-Learning-2026');
  await expect(page.getByText('Do not use the institute name in your password')).toBeVisible();
  await fill(TEMP, 'onlyletterspassword', 'onlyletterspassword');
  await expect(page.getByText('Use both letters and numbers')).toBeVisible();
  await fill(TEMP, NEW, 'Something-Else-99');
  await expect(page.getByText('The two new passwords are not the same')).toBeVisible();
  await fill('Wrong-temp-1', NEW, NEW);
  await expect(page.getByText('That is not the temporary password')).toBeVisible();

  await fill(TEMP, NEW, NEW);
  await expect(page).not.toHaveURL(/\/security\/password/, { timeout: 20_000 });
  expect((await page.request.get('/api/reference')).status()).toBe(200);
  const after = (await (await page.request.get('/api/me')).json()) as { mustChangePassword: boolean };
  expect(after.mustChangePassword).toBe(false);
});

test('afterwards only the new password works; the temporary one is dead', async ({ page }) => {
  await clearGuessLimits();
  await signIn(page, EMAIL, TEMP);
  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await signIn(page, EMAIL, NEW);
  await expect(page).not.toHaveURL(/\/sign-in|\/security\/password/, { timeout: 20_000 });
  // The account menu offers a voluntary change later.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('link', { name: 'Change password' })).toBeVisible();
});

test('wrong guesses are limited: 5 tries, then locked — whether or not the address has an account', async ({ page }) => {
  await clearGuessLimits();
  const email = 'locked.out@example.test';
  for (let i = 1; i <= 5; i++) {
    await signIn(page, email, `Wrong-guess-${i}`);
    await expect(page.getByText('Invalid email or password')).toBeVisible();
  }
  await signIn(page, email, 'Wrong-guess-6');
  await expect(page.getByText('Too many sign-in attempts. Wait 15 minutes and try again.')).toBeVisible();
  // A real account is limited the same way (and the message never says which addresses exist).
  for (let i = 1; i <= 5; i++) {
    await signIn(page, 'sanjay@exatech.test', `Wrong-guess-${i}`);
    await expect(page.getByText('Invalid email or password')).toBeVisible(); // wait, so each guess really reaches the server
  }
  await signIn(page, 'sanjay@exatech.test', 'Wrong-guess-6');
  await expect(page.getByText('Too many sign-in attempts. Wait 15 minutes and try again.')).toBeVisible();
  await clearGuessLimits();
});
