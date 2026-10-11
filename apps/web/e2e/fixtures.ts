import { expect, test as base, type Page } from '@playwright/test';

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
