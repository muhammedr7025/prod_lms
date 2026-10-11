// Usage: node scripts/shot.mjs <email|-> <path> <out.png> [width] [height]
// Signs in as a demo persona (DEMO_MODE) and screenshots a page. Dev-only helper.
import { chromium } from '@playwright/test';
const [, , email, path, out, w = '1360', h = '900'] = process.argv;
const base = process.env.WEB_URL ?? 'http://localhost:3300';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
if (email && email !== '-') {
  const res = await page.request.post(`${base}/api/auth/exa/demo-login`, { data: { email }, headers: { Origin: base } });
  if (!res.ok()) { console.error('login failed', res.status(), await res.text()); process.exit(1); }
}
await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: true });
console.log('url:', page.url());
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
await browser.close();
