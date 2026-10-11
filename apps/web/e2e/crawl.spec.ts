import { ROLE_NAV, SCREENS, type ScreenKey, type SystemRoleKey } from '@exatech/contracts';
import { expect, loginAs, test, type Persona } from './fixtures';
import { reseed } from './fixtures';

// Every spec starts from the known demo seed (specs mutate shared data).
test.beforeAll(() => reseed());

/**
 * Smoke crawl: every persona visits every screen in its navigation. Fails on
 * page errors / console errors (guard fixture), any API 5xx, error states, or
 * a missing page heading. Catches integration regressions across modules.
 */
const PERSONA_ROLE: [Persona, SystemRoleKey, { width: number; height: number }][] = [
  ['superadmin', 'superadmin', { width: 1360, height: 900 }],
  ['branchadmin', 'branchadmin', { width: 1360, height: 900 }],
  ['sales', 'sales', { width: 1360, height: 900 }],
  ['salesmanager', 'salesmanager', { width: 1360, height: 900 }],
  ['finance', 'finance', { width: 1360, height: 900 }],
  ['teacher', 'teacher', { width: 390, height: 844 }],
  ['student', 'student', { width: 390, height: 844 }],
  ['parent', 'parent', { width: 390, height: 844 }],
];

for (const [persona, role, viewport] of PERSONA_ROLE) {
  test(`${persona}: every screen in the nav renders without errors`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(viewport);
    const serverErrors: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    await loginAs(page, persona);
    const keys = ROLE_NAV[role].filter((e): e is ScreenKey => typeof e === 'string');
    for (const key of keys) {
      const screen = SCREENS[key];
      await page.goto(screen.path, { waitUntil: 'networkidle' });
      await expect(page.locator('h2').first(), `${screen.path} heading`).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Something went wrong|is not part of your .* membership|Could not load/i), `${screen.path} error state`).toHaveCount(0);
    }
    expect(serverErrors, serverErrors.join('\n')).toEqual([]);
  });
}
