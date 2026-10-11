import { execFileSync } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, loginAs, PERSONAS, test, type Persona } from './fixtures';

/**
 * Student & Parent portals (phone, 390×844). Mutates data (payments,
 * submissions, check-in, messages) — the spec reseeds the database (and the
 * seeded material files) before the student journeys and again before the
 * parent journeys, so it is re-runnable against a running stack.
 */
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
const ROOT = path.resolve(__dirname, '..', '..', '..');

function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

function reseed() {
  execFileSync('pnpm', ['--filter', '@exatech/db', 'seed'], { cwd: ROOT, stdio: 'pipe', env: process.env });
  execFileSync('pnpm', ['--filter', '@exatech/api', 'seed:files'], { cwd: ROOT, stdio: 'pipe', env: process.env });
}

/** Text drawn with simple fonts: inflate the PDF's streams and decode Tj strings. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let body: string;
    try {
      body = zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      body = buf.subarray(start, end).toString('latin1');
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) out.push(Buffer.from(t[1]!.replace(/\s+/g, ''), 'hex').toString('latin1'));
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]!);
    re.lastIndex = end;
  }
  return out.join('\n');
}

async function apiAs(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, persona: Persona) {
  const base = test.info().project.use.baseURL ?? 'http://localhost:3300';
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
  const res = await ctx.post('/api/auth/exa/demo-login', { data: { email: PERSONAS[persona] } });
  expect(res.ok(), `demo login for ${persona}`).toBeTruthy();
  return ctx;
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `GET ${url} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** Open a note row and return the signed URL the API handed out. */
async function openNote(page: Page, title: string): Promise<{ url: string; watermarked: boolean }> {
  const [res, tab] = await Promise.all([
    page.waitForResponse((r) => /\/api\/portal\/notes\/[^/]+\/open$/.test(r.url()) && r.request().method() === 'POST'),
    page.context().waitForEvent('page'),
    page.getByTestId('note-row').filter({ hasText: title }).click(),
  ]);
  expect(res.ok(), `open note → ${res.status()} ${await res.text()}`).toBeTruthy();
  await tab.close().catch(() => undefined);
  return (await res.json()) as { url: string; watermarked: boolean };
}

async function expectWatermarkedPdf(page: Page, url: string, name: string) {
  const pdf = await page.request.get(url);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect(pdfText(await pdf.body())).toContain(name);
}

/** Complete the sandbox checkout that the pay sheet opened in a popup. */
async function payInSandbox(page: Page, payButton: RegExp | string, studentName: string) {
  const dialog = page.getByRole('dialog');
  const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.getByRole('button', { name: payButton }).click()]);
  await popup.waitForURL(/\/pay\/sandbox\//);
  const checkout = popup.getByTestId('sandbox-checkout');
  await expect(checkout).toContainText(studentName);
  await popup.getByRole('button', { name: /^Pay ₹/ }).click();
  return popup;
}

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let anjaliUserId = '';

test.describe('student portal (Anjali · DM-A)', () => {
  test.beforeAll(() => {
    reseed();
    anjaliUserId = sql(`select id from "user" where email = '${PERSONAS.student}'`);
  });

  test('home: overdue fee card, attendance ring, tiles; announcement acknowledge', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto('/student');
    await expect(page.getByText('DM-A · Digital Marketing · TVM-DM-2027-00142')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hi, Anjali' })).toBeVisible();
    const fee = page.getByTestId('fee-card');
    await expect(fee).toHaveAttribute('data-state', 'overdue');
    await expect(fee).toContainText('₹15,000 overdue');
    await expect(fee).toContainText('late fee after');
    await expect(fee.getByRole('button', { name: 'Pay now' })).toBeVisible();
    await expect(page.getByTestId('attendance-card')).toContainText(/\d+ of \d+ sessions · threshold 75%/);
    await expect(page.getByTestId('attendance-card')).toContainText('Next:');
    await expect(page.getByTestId('pending-work')).toContainText('1');
    await expect(page.getByText('Module 2 · Hall A · 10:00')).toBeVisible();

    const ann = page.getByTestId('announcement-card');
    await expect(ann).toContainText('Instalment due this week');
    await ann.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('Acknowledged').first()).toBeVisible();
    await expect(ann.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
    const feed = await getJson<{ items: { title: string; ackedAt: string | null; readAt: string | null }[] }>(page, '/api/comms/announcements/feed');
    const item = feed.items.find((i) => i.title === 'Instalment due this week')!;
    expect(item.ackedAt).not.toBeNull();
    expect(item.readAt).not.toBeNull();
  });

  test('notes: locked items show Pay now; tapping one wiggles and opens the pay sheet; always-visible notes open (watermarked) while locked', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto('/student/notes');
    await expect(page.getByText('DM-A · 1 of 5 available')).toBeVisible();
    await expect(page.getByTestId('fee-gate-banner')).toContainText('Fee-gated items unlock when instalment 2 is paid.');
    await expect(page.getByTestId('fee-gate-banner').getByRole('button', { name: 'Pay ₹15,000' })).toBeVisible();
    const seo = page.getByTestId('note-row').filter({ hasText: 'SEO playbook' });
    await expect(seo).toHaveAttribute('data-status', 'locked');
    await expect(seo).toContainText('Locked · Pay now');
    await expect(page.getByTestId('note-row').filter({ hasText: 'Google Ads lab worksheet' })).toContainText(/Scheduled · \d+ \w{3}/);

    await seo.click();
    const sheet = page.getByRole('dialog', { name: 'Instalment 2 · ₹15,000' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Pay now · Sandbox gateway');
    await expect(sheet).toContainText('Anjali Menon · due');
    await expect(sheet).toContainText('Clearing this unlocks fee-gated notes immediately');
    await expect(sheet.getByRole('radio', { name: /Next due/ })).toHaveAttribute('aria-checked', 'true');
    await sheet.getByRole('radio', { name: 'Custom amount' }).click();
    await sheet.getByLabel('Amount (₹)').fill('500');
    await expect(sheet.getByText('Minimum partial payment is ₹1,000')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Pay ₹500' })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Later' }).click();
    await expect(sheet).toBeHidden();

    // The server refuses the locked note, whatever the client does.
    const notes = await getJson<{ groups: { items: { id: string; title: string }[] }[] }>(page, '/api/portal/notes');
    const seoId = notes.groups.flatMap((g) => g.items).find((i) => i.title === 'SEO playbook')!.id;
    const base = test.info().project.use.baseURL!;
    const refused = await page.request.post(`${base}/api/portal/notes/${seoId}/open`, { headers: { Origin: base } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('FEE_LOCKED');

    const opened = await openNote(page, 'Course orientation & syllabus');
    expect(opened.watermarked).toBe(true);
    expect(opened.url).toContain('X-Amz-Expires=300');
    await expectWatermarkedPdf(page, opened.url, 'Anjali Menon');
  });

  test('pay next due through the sandbox → receipt shows, fee clears, the same notes open', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto('/student/fees');
    await expect(page.getByText('Split 50 / 50 · ₹48,000 incl. GST')).toBeVisible();
    await expect(page.getByTestId('instalment-row').filter({ hasText: 'Instalment 2' })).toContainText('Overdue');
    await expect(page.getByTestId('document-row').first()).toContainText(/TVM\/(INV|RCPT)\//);
    await page.getByTestId('pay-now').click();
    await expect(page.getByRole('dialog', { name: 'Instalment 2 · ₹15,000' })).toBeVisible();
    await payInSandbox(page, 'Pay ₹15,000', 'Anjali Menon');

    const success = page.getByTestId('pay-success');
    await expect(success).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('dialog', { name: '₹15,000 paid' })).toBeVisible();
    await expect(success.getByTestId('pay-receipt')).toContainText(/Receipt TVM\/RCPT\/\d{4}-\d{2}\/\d{6}/);
    await expect(success).toContainText('Receipt sent by WhatsApp + email');
    await expect(success.getByTestId('fee-badge')).toHaveText('Paid');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('instalment-row').filter({ hasText: 'Instalment 2' })).toContainText('Paid');
    await expect(page.getByTestId('pay-now')).toHaveCount(0);

    await page.goto('/student');
    await expect(page.getByTestId('fee-card')).toHaveAttribute('data-state', 'cleared');
    await expect(page.getByTestId('fee-card')).toContainText('All fees cleared');

    await page.goto('/student/notes');
    await expect(page.getByText('DM-A · 4 of 5 available')).toBeVisible();
    await expect(page.getByTestId('fee-gate-banner')).toHaveCount(0);
    const seo = page.getByTestId('note-row').filter({ hasText: 'SEO playbook' });
    await expect(seo).toHaveAttribute('data-status', 'open');
    const opened = await openNote(page, 'SEO playbook');
    await expectWatermarkedPdf(page, opened.url, 'Anjali Menon');
    expect(Number(sql(`select count(*) from material_access ma join material m on m.id = ma.material_id where m.title = 'SEO playbook' and ma.user_id = '${anjaliUserId}'`))).toBeGreaterThanOrEqual(1);
  });

  test('work: attach a file and submit → Submitted · awaiting grade; teacher to-grade count goes up', async ({ page, playwright }) => {
    const nithin = await apiAs(playwright, 'teacher');
    const before = ((await (await nithin.get('/api/teaching/today')).json()) as { toGrade: number }).toGrade;

    await loginAs(page, 'student');
    await page.goto('/student/work');
    await expect(page.getByText('Late submissions lose 10% per day · feedback appears here when graded')).toBeVisible();
    const card = page.getByTestId('work-card').filter({ hasText: 'Keyword map for a product page' });
    await expect(card.getByTestId('work-status')).toHaveText(/^Pending · due /);
    await expect(card.getByRole('button', { name: 'Submit' })).toBeDisabled();
    await expect(card).toContainText('Attach a file or write your answer to submit');
    await card.getByTestId('work-file').setInputFiles({ name: 'keyword-map.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') });
    await expect(card.getByTestId('work-attachment')).toContainText('keyword-map.pdf');
    await card.getByRole('button', { name: 'Submit' }).click();
    await expect(card.getByTestId('work-status')).toHaveText('Submitted · awaiting grade');
    await expect(card).toContainText('keyword-map.pdf');
    await expect(card.getByRole('button', { name: 'Resubmit' })).toBeVisible();
    const graded = page.getByTestId('work-card').filter({ hasText: 'SEO audit of a local business' });
    await expect(graded.getByTestId('work-status')).toHaveText(/^Graded · \d+(\.\d)? \/ 50$/);

    await expect.poll(async () => ((await (await nithin.get('/api/teaching/today')).json()) as { toGrade: number }).toGrade).toBe(before + 1);
    await nithin.dispose();
  });

  test('marks: published exams only (drafts never shown) + report card PDF', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto('/student/marks');
    await expect(page.getByText('Published only · draft marks are never shown')).toBeVisible();
    const cards = page.getByTestId('mark-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Module 1 · Foundations');
    await expect(cards.first()).toContainText(/Batch average [\d.]+ · [A-F]\+?/);
    await expect(page.getByText('Module 2 · Search')).toHaveCount(0);
    const api = await getJson<{ items: { name: string }[]; reportCardUrl: string | null }>(page, '/api/portal/marks');
    expect(api.items.map((i) => i.name)).toEqual(['Module 1 · Foundations']);
    expect(Number(sql(`select count(*) from exam e join batch b on b.id = e.batch_id where b.code = 'DM-A' and e.status <> 'published'`))).toBeGreaterThan(0);
    await expect(page.getByTestId('report-card')).toBeVisible();
    const rc = await page.request.get(api.reportCardUrl!);
    expect(rc.status()).toBe(200);
    expect(rc.headers()['content-type']).toContain('application/pdf');
  });

  test('timetable: week list with exams and holidays; ICS downloads as text/calendar', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto('/student/timetable');
    await expect(page.getByText(/^Week \d+ · \d+/)).toBeVisible();
    await expect(page.getByTestId('tt-day')).toHaveCount(7);
    // Seeded exams sit 3 days before and 5 days after today: this week or the next shows one.
    if ((await page.getByTestId('tt-day').filter({ hasText: 'Exam' }).count()) === 0) {
      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(page.getByRole('button', { name: 'This week' })).toBeEnabled();
    }
    await expect(page.getByTestId('tt-day').filter({ hasText: 'Exam' }).first()).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-ics').click()]);
    expect(download.suggestedFilename()).toBe('DM-A-timetable.ics');
    const ics = await page.request.get('/api/portal/timetable.ics');
    expect(ics.status()).toBe(200);
    expect(ics.headers()['content-type']).toContain('text/calendar');
    const body = await ics.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('BEGIN:VEVENT');
    expect(body).toMatch(/LOCATION:.+/);
    expect(body).toMatch(/SUMMARY:Exam · Module 2 · Search/);
  });

  test('QR check-in: code from the teacher endpoint (Nithin, API) marks Anjali present', async ({ page, playwright }) => {
    const nithin = await apiAs(playwright, 'teacher');
    const opts = (await (await nithin.get('/api/teaching/cover/options')).json()) as { batches: { id: string; code: string }[]; slots: { value: string }[] };
    const dma = opts.batches.find((b) => b.code === 'DM-A')!;
    let sessionId: string | null = null;
    for (const slot of opts.slots) {
      const res = await nithin.post('/api/teaching/cover', { data: { batchId: dma.id, type: 'extra', start: slot.value, reason: 'E2E portal check-in' } });
      if (res.ok()) {
        sessionId = ((await res.json()) as { sessionId: string }).sessionId;
        break;
      }
    }
    expect(sessionId, 'an extra DM-A session today').toBeTruthy();
    const qr = (await (await nithin.get(`/api/teaching/sessions/${sessionId}/qr`)).json()) as { code: string; presentSoFar: number };
    expect(qr.code).toMatch(/^EXA-/);

    await loginAs(page, 'student');
    await page.goto('/student');
    const card = page.getByTestId('checkin-card');
    await card.getByLabel('Check-in code').fill(qr.code);
    await card.getByRole('button', { name: 'Check in' }).click();
    await expect(page.getByText(/^Marked (present|late) · DM-A \d\d:\d\d$/)).toBeVisible();
    const enr = sql(`select e.id from enrollment e join student s on s.id = e.student_id where s.name = 'Anjali Menon' and e.status = 'active'`);
    expect(sql(`select status || ':' || source from attendance where session_id = '${sessionId}' and enrollment_id = '${enr}'`)).toMatch(/^[PL]:qr$/);
    await nithin.dispose();
  });

  test('read-only impersonation: Super Admin views as Anjali — screens render, Pay is blocked', async ({ page }) => {
    await loginAs(page, 'superadmin');
    const base = test.info().project.use.baseURL!;
    const res = await page.request.post(`${base}/api/auth/exa/impersonate`, { data: { userId: anjaliUserId, reason: 'E2E portal check' }, headers: { Origin: base } });
    expect(res.ok(), `impersonate → ${res.status()} ${await res.text()}`).toBeTruthy();
    await page.goto('/student');
    await expect(page.getByText(/Viewing as Anjali Menon · read-only/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hi, Anjali' })).toBeVisible();
    for (const p of ['/student/timetable', '/student/notes', '/student/work', '/student/marks', '/student/fees']) {
      await page.goto(p);
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    }
    // Writes are refused server-side during impersonation (the pay sheet itself is checked in the parent block, where a fee is due).
    const refused = await page.request.post(`${base}/api/portal/payments/orders`, { data: { purpose: 'next_due' }, headers: { Origin: base } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('read-only');
  });
});

test.describe('parent portal (Suresh · Anjali + Rohan)', () => {
  let rohanId = '';
  let anjaliId = '';
  test.beforeAll(() => {
    reseed();
    rohanId = sql(`select id from student where name = 'Rohan Menon'`);
    anjaliId = sql(`select id from student where name = 'Anjali Menon'`);
  });

  test('read-only impersonation blocks Pay in the sheet with the read-only message', async ({ page }) => {
    const userId = sql(`select id from "user" where email = '${PERSONAS.student}'`);
    await loginAs(page, 'superadmin');
    const base = test.info().project.use.baseURL!;
    expect((await page.request.post(`${base}/api/auth/exa/impersonate`, { data: { userId, reason: 'E2E pay blocked' }, headers: { Origin: base } })).ok()).toBeTruthy();
    await page.goto('/student');
    await expect(page.getByTestId('fee-card')).toHaveAttribute('data-state', 'overdue');
    await page.getByTestId('fee-card').getByRole('button', { name: 'Pay now' }).click();
    const sheet = page.getByRole('dialog', { name: 'Instalment 2 · ₹15,000' });
    await expect(sheet.getByText('You are viewing as this user (read-only) — payments are blocked')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Pay ₹15,000' })).toBeDisabled();
  });

  test('child switcher changes every screen (URL + remembered across the bottom nav)', async ({ page }) => {
    await loginAs(page, 'parent');
    await page.goto('/parent');
    const chips = page.getByTestId('child-chip');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: 'Anjali' }).click();
    await expect(page.getByTestId('child-name')).toHaveText('Anjali Menon');
    await expect(page.getByText('DM-A · Digital Marketing · Trivandrum')).toBeVisible();
    await chips.filter({ hasText: 'Rohan' }).click();
    await expect(page).toHaveURL(new RegExp(`child=${rohanId}`));
    await expect(page.getByTestId('child-name')).toHaveText('Rohan Menon');
    await expect(page.getByText('FS-B · Full Stack Development · Trivandrum')).toBeVisible();
    await expect(chips.filter({ hasText: 'Rohan' })).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('link', { name: 'Attendance' }).click();
    await expect(page.getByText('Rohan Menon · FS-B')).toBeVisible();
    await page.getByRole('link', { name: 'Marks' }).click();
    await expect(page.getByText('Rohan Menon · published only')).toBeVisible();
    await expect(page.getByTestId('mark-card')).toHaveCount(0);
    await page.getByRole('link', { name: 'Fees' }).click();
    await expect(page.getByText(/^Rohan Menon · 3 instalments/)).toBeVisible();
    await chips.filter({ hasText: 'Anjali' }).click();
    await expect(page.getByText(/^Anjali Menon · Split 50 \/ 50/)).toBeVisible();
    await page.getByRole('link', { name: 'Marks' }).click();
    await expect(page.getByText('Anjali Menon · published only')).toBeVisible();
    await expect(page.getByTestId('mark-card')).toHaveCount(1);
  });

  test('Rohan: attendance below 75% is shown in ink (home tile + attendance bar)', async ({ page }) => {
    await loginAs(page, 'parent');
    await page.goto(`/parent?child=${rohanId}`);
    const tile = page.getByTestId('attendance-tile');
    await expect(tile).toHaveAttribute('data-low', 'true');
    await expect(tile).toContainText(/6\d%/);
    await expect(tile).toContainText('below 75% threshold');
    await expect(tile).toHaveClass(/border-ink/);
    await page.goto(`/parent/attendance?child=${rohanId}`);
    await expect(page.getByRole('heading', { name: /^Attendance · 6\d%$/ })).toBeVisible();
    const bar = page.getByTestId('attendance-bar');
    await expect(bar).toHaveAttribute('data-low', 'true');
    await expect(bar.locator('.bg-ink')).toHaveCount(1);
    await expect(page.getByText('Below the 75% threshold')).toBeVisible();
    await expect(page.getByTestId('attendance-row').filter({ hasText: 'Absent' }).first()).toBeVisible();
    await expect(page.getByText('Same-day absence alerts by WhatsApp · threshold warning below 75%')).toBeVisible();
  });

  test('pay for Rohan via the sandbox → his fee card flips to cleared', async ({ page }) => {
    await loginAs(page, 'parent');
    await page.goto(`/parent?child=${rohanId}`);
    const fee = page.getByTestId('fee-card');
    await expect(fee).toHaveAttribute('data-state', 'overdue');
    await fee.getByRole('button', { name: 'Pay now' }).click();
    const sheet = page.getByRole('dialog', { name: 'Instalment 2 · ₹15,000' });
    await expect(sheet).toContainText(/Rohan Menon · due \d+ \w{3} · \d+ days overdue/);
    await payInSandbox(page, 'Pay ₹15,000', 'Rohan Menon');
    await expect(page.getByTestId('pay-success')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('pay-receipt')).toContainText('Rohan Menon');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(fee).toHaveAttribute('data-state', 'cleared');
    await expect(fee.getByText('Cleared', { exact: true })).toBeVisible();
    await expect(fee).toContainText('All fees cleared');
  });

  test('message class teacher + request PTM slot create moderated records', async ({ page }) => {
    const msgsBefore = Number(sql(`select count(*) from parent_message where student_id = '${rohanId}' and status = 'pending'`));
    await loginAs(page, 'parent');
    await page.goto(`/parent?child=${rohanId}`);
    await page.getByRole('button', { name: 'Message class teacher' }).click();
    const msg = page.getByRole('dialog', { name: 'Message class teacher' });
    await expect(msg).toContainText('Messages are moderated and delivered during staff hours');
    await expect(msg.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await msg.getByLabel(/^To /).fill('Could we talk about Rohan’s attendance this month?');
    await msg.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText(/^Sent for moderation · Sanjay Kumar replies during staff hours/)).toBeVisible();
    expect(Number(sql(`select count(*) from parent_message where student_id = '${rohanId}' and status = 'pending'`))).toBe(msgsBefore + 1);
    expect(Number(sql(`select count(*) from notification n join "user" u on u.id = n.user_id where u.email = '${PERSONAS.teacher2}' and n.category = 'message' and n.title = 'Message from Suresh Menon'`))).toBeGreaterThanOrEqual(1);

    // A day that is not a holiday, from tomorrow.
    const day = sql(`select d::date from generate_series((now() at time zone 'Asia/Kolkata')::date + 1, (now() at time zone 'Asia/Kolkata')::date + 20, interval '1 day') d where d::date not in (select date from holiday) order by d limit 1`);
    await page.getByRole('button', { name: 'Request PTM slot' }).click();
    const ptm = page.getByRole('dialog', { name: 'Request PTM slot' });
    await ptm.getByLabel('Preferred date').fill(day);
    await ptm.getByRole('radio', { name: /Afternoon/ }).click();
    await ptm.getByLabel('Note for the teacher (optional)').fill('Attendance and React sprint');
    await ptm.getByRole('button', { name: 'Request slot' }).click();
    await expect(page.getByText(/^Requested .* · Afternoon \(12–4\) · the class teacher confirms the time$/)).toBeVisible();
    expect(sql(`select preferred_slot || '|' || status from ptm_request where student_id = '${rohanId}' order by created_at desc limit 1`)).toBe(`${day} afternoon|requested`);
    expect(Number(sql(`select count(*) from notification n join "user" u on u.id = n.user_id where u.email = '${PERSONAS.branchadmin}' and n.title like 'PTM request · Rohan%'`))).toBe(1);
  });

  test('alerts: absence & fee items (ink), channels with unmutable fee due / exam schedule', async ({ page }) => {
    await loginAs(page, 'parent');
    await page.goto('/parent/alerts');
    await expect(page.getByText('Both children')).toBeVisible();
    const absence = page.getByTestId('alert-card').filter({ hasText: 'Rohan absent today' });
    await expect(absence).toContainText('Absence');
    await expect(absence.locator('.border-ink')).toHaveCount(1);
    const fee = page.getByTestId('alert-card').filter({ hasText: 'Fee overdue · Rohan' });
    await expect(fee).toContainText('Fee overdue');
    await expect(page.getByText('WhatsApp + email · cannot mute')).toBeVisible();
    await expect(page.getByText('WhatsApp · cannot mute')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change' })).toHaveAttribute('href', '/account/notifications');
  });

  test('"Pay for both children" handles the remaining child with dues (Anjali)', async ({ page }) => {
    await loginAs(page, 'parent');
    await page.goto(`/parent/fees?child=${rohanId}`);
    await expect(page.getByText('Rohan cleared')).toBeVisible();
    await page.getByTestId('pay-all').click();
    const sheet = page.getByRole('dialog', { name: 'Pay for 1 child · ₹15,000' });
    await expect(sheet.getByTestId('pay-progress')).toContainText('Anjali Menon');
    await payInSandbox(page, 'Pay ₹15,000', 'Anjali Menon');
    await expect(page.getByTestId('pay-success')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('pay-receipt')).toContainText('Anjali Menon');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Nothing is due for any child right now')).toBeVisible();
    const kids = await getJson<{ items: { studentId: string; feeState: string }[] }>(page, '/api/portal/children');
    expect(kids.items.find((k) => k.studentId === anjaliId)?.feeState).toBe('cleared');
    expect(kids.items.find((k) => k.studentId === rohanId)?.feeState).toBe('cleared');
  });
});
