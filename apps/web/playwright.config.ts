import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.WEB_URL ?? 'http://localhost:3300';

/**
 * End-to-end tests run against a running stack (pnpm dev) with DEMO_MODE on
 * and a freshly seeded database. Each spec signs in as a seeded persona.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } }],
});
