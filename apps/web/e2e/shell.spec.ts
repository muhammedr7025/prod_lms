import { expect, loginAs, test } from './fixtures';

test.describe('shell & identity', () => {
  test('signed-out users are sent to sign-in', async ({ page }) => {
    await page.goto('/overview');
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  });

  test('magic link request never reveals whether an account exists', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
  });

  test('super admin lands on overview with all four nav groups and can open the audit log', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/');
    await expect(page).toHaveURL(/\/overview/);
    for (const head of ['Institution', 'Academics', 'Sales', 'Finance']) await expect(page.locator('aside').getByText(head, { exact: true })).toBeVisible();
    await page.locator('aside').getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Signed in' }).first()).toBeVisible();
  });

  test('branch-bound roles cannot change branch; teacher gets the mobile portal', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/');
    await expect(page.getByLabel('Branch')).toBeDisabled();
    await loginAs(page, 'teacher');
    await page.goto('/');
    await expect(page).toHaveURL(/\/teacher/);
    await expect(page.locator('nav').getByRole('link', { name: 'Attendance' })).toBeVisible();
  });

  test('membership switch: Sanjay moves from Sales Manager to Teacher', async ({ page }) => {
    await loginAs(page, 'salesmanager');
    await page.goto('/');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('button', { name: /Teacher/ }).click();
    await expect(page).toHaveURL(/\/teacher/);
  });

  test('screens outside the membership show no-access', async ({ page }) => {
    await loginAs(page, 'sales');
    await page.goto('/finance');
    await expect(page.getByText(/is not part of your Salesperson membership/)).toBeVisible();
  });

  test('command palette finds a student and opens the panel', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/branch');
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByPlaceholder('Jump to a student, lead, batch or action…').fill('Rohan');
    await page.getByRole('option', { name: /Rohan Menon/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
