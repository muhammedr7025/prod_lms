import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { apiEnv, expect, loginAs, reseed, test } from './fixtures';

/**
 * Password sign-in for accounts an administrator gave a temporary password:
 * forced change on first sign-in, the API locked until then, password rules,
 * wrong-guess limits, and the administrator tool. Mutates data → reseeds first.
 */
const ROOT = path.resolve(__dirname, '../../..');
const TEMP = 'Exatech@123';
const NEW = 'Riverside-Lamp-42';
const EMAIL = 'meera@exatech.test';

const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

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
  await page.getByLabel('Email, mobile or admission no.').fill(email);
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
  await expect(page.getByText('The sign-in details or the password are not right')).toBeVisible();

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
  await expect(page.getByText('The sign-in details or the password are not right')).toBeVisible();
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
    await expect(page.getByText('The sign-in details or the password are not right')).toBeVisible();
  }
  await signIn(page, email, 'Wrong-guess-6');
  await expect(page.getByText('Too many sign-in attempts. Wait 15 minutes and try again.')).toBeVisible();
  // A real account is limited the same way (and the message never says which addresses exist).
  for (let i = 1; i <= 5; i++) {
    await signIn(page, 'sanjay@exatech.test', `Wrong-guess-${i}`);
    await expect(page.getByText('The sign-in details or the password are not right')).toBeVisible(); // wait, so each guess really reaches the server
  }
  await signIn(page, 'sanjay@exatech.test', 'Wrong-guess-6');
  await expect(page.getByText('Too many sign-in attempts. Wait 15 minutes and try again.')).toBeVisible();
  await clearGuessLimits();
});

/* ───────────── a student's password, set by an admin ───────────── */

const ANJALI = 'TVM-DM-2027-00142';
const STUDENT_NEW = 'Sunrise-Ledger-77';

test('Branch Admin sets a student’s initial password; the student signs in by mobile, must change it, then uses the admission number', async ({ page, browser }) => {
  await clearGuessLimits();
  const phone = sql(`select phone_number from "user" where email = 'anjali.menon@example.test'`).replace('+91', '');
  await loginAs(page, 'branchadmin');
  await page.goto('/students');
  await page.getByLabel('Search students').fill('Anjali');
  await page.getByTestId('student-row').filter({ hasText: 'Anjali Menon' }).getByRole('button', { name: 'Anjali Menon' }).click();
  await page.getByRole('button', { name: 'Set password' }).click();
  const dlg = page.getByRole('dialog', { name: 'Password for Anjali Menon' });
  await dlg.getByLabel('Password', { exact: true }).fill('short');
  await dlg.getByRole('button', { name: 'Set password' }).click();
  await expect(dlg.getByText('Use at least 8 characters')).toBeVisible();
  await dlg.getByRole('button', { name: 'Generate' }).click();
  const generated = await dlg.getByLabel('Password', { exact: true }).inputValue();
  expect(generated).toMatch(/^[A-Za-z0-9]{10}$/);
  await dlg.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByTestId('password-set')).toContainText('must choose their own password');
  await expect(page.getByTestId('password-shown')).toHaveText(generated);
  await expect(page.getByTestId('password-set')).toContainText(ANJALI);
  expect(sql(`select count(*) from audit_log where action = 'Student password set by admin' and summary like '%temporary%'`)).toBe('1');
  expect(sql(`select count(*) from audit_log where summary like '%${generated}%'`)).toBe('0'); // the password is never logged

  // The student signs in with the mobile number + the initial password and must choose their own.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sp = await ctx.newPage();
  await signIn(sp, phone, generated);
  await expect(sp).toHaveURL(/\/security\/password\?forced=1/);
  await sp.getByLabel('Temporary password').fill(generated);
  await sp.getByLabel('New password', { exact: true }).fill(STUDENT_NEW);
  await sp.getByLabel('New password again').fill(STUDENT_NEW);
  await sp.getByRole('button', { name: 'Save new password' }).click();
  await expect(sp).not.toHaveURL(/\/security\/password/, { timeout: 20_000 });
  await expect(sp).toHaveURL(/\/student/);
  await ctx.close();

  // Afterwards the admission number works as the username, and the initial password is dead.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sp2 = await ctx2.newPage();
  await signIn(sp2, ANJALI, generated);
  await expect(sp2.getByText('The sign-in details or the password are not right')).toBeVisible();
  await signIn(sp2, ANJALI.toLowerCase(), STUDENT_NEW);
  await expect(sp2).toHaveURL(/\/student/, { timeout: 20_000 });
  await ctx2.close();
});

test('an initial password the student may keep skips the forced change; only people who manage students can set one', async ({ page }) => {
  await clearGuessLimits();
  const id = sql(`select id from student where admission_no = '${ANJALI}'`);
  const base = test.info().project.use.baseURL!;
  const post = (body: unknown) => page.request.post(`${base}/api/academics/students/${id}/password`, { data: body, headers: { Origin: base } });

  await loginAs(page, 'finance');
  expect((await post({ password: 'Keep-This-One-9', mustChange: false })).status()).toBe(403);

  await loginAs(page, 'branchadmin');
  const weak = await post({ password: 'abcdefgh', mustChange: false }); // letters only
  expect(weak.status()).toBe(422);
  const ok = await post({ password: 'Keep-This-One-9', mustChange: false });
  expect(ok.ok()).toBeTruthy();
  expect(((await ok.json()) as { mustChange: boolean }).mustChange).toBe(false);
  expect(sql(`select must_change_password from "user" where email = 'anjali.menon@example.test'`)).toBe('f');

  const sp = await page.context().browser()!.newContext();
  const p2 = await sp.newPage();
  await signIn(p2, ANJALI, 'Keep-This-One-9');
  await expect(p2).toHaveURL(/\/student/, { timeout: 20_000 });
  await sp.close();
});
