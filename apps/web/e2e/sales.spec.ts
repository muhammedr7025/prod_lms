import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, loginAs, test } from './fixtures';
import { reseed } from './fixtures';

// Every spec starts from the known demo seed (specs mutate shared data).
test.beforeAll(() => reseed());

/**
 * Sales + Admissions journeys. Run against a freshly seeded stack
 * (`pnpm --filter @exatech/db seed`); names/phones carry a run stamp so the
 * spec can also be repeated without reseeding.
 */
const stamp = String(Date.now()).slice(-6);
const rnd = () => String(Math.floor(Math.random() * 90) + 10);
const phone = (prefix: string) => `${prefix}${stamp}${rnd()}`; // 2 + 6 + 2 = 10 digits, starts 6–9
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function api<T = unknown>(page: Page, method: 'GET' | 'POST', url: string, data?: unknown): Promise<T> {
  const base = test.info().project.use.baseURL!;
  const res = method === 'GET' ? await page.request.get(`${base}${url}`) : await page.request.post(`${base}${url}`, { data: data ?? {}, headers: { Origin: base } });
  expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

interface LeadRow {
  id: string;
  name: string;
  phone: string | null;
  stage: string;
}

const leadName = `Anu Joseph ${stamp}`;
const leadPhone = phone('97');

test.describe.serial('sales & admissions', () => {
  // Long journeys; also tolerates on-demand route compiles of the dev server.
  test.describe.configure({ timeout: 180_000 });
  test('new lead: validation, dedupe against existing leads, rule assignment', async ({ page }) => {
    await loginAs(page, 'sales');
    const existing = await api<{ items: LeadRow[] }>(page, 'GET', '/api/sales/leads?q=Arjun%20Nair');
    const dupPhone = existing.items[0]!.phone!.slice(3);

    await page.goto('/sales/pipeline?new=1');
    const dlg = page.getByRole('dialog', { name: 'New lead' });
    await expect(dlg).toBeVisible();

    // Validation: name + 10-digit phone.
    await dlg.getByRole('button', { name: 'Create lead' }).click();
    await expect(dlg.getByText('Enter the full name')).toBeVisible();
    await dlg.getByLabel('Full name').fill(leadName);
    await dlg.getByLabel('Phone (E.164 validated)').fill('9847');
    await dlg.getByLabel('Full name').click();
    await expect(dlg.getByText('Enter a valid 10-digit mobile')).toBeVisible();

    // Dedupe on phone against existing leads.
    await dlg.getByLabel('Phone (E.164 validated)').fill(dupPhone);
    await expect(dlg.getByText(/Already a lead — Arjun Nair/)).toBeVisible();
    await expect(dlg.getByRole('link', { name: 'Open existing' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Create lead' })).toBeDisabled();

    // Assignment rules preview live: tech courses → Sanjay (Arun is on leave), everything else → Meera.
    await dlg.getByLabel('Phone (E.164 validated)').fill(leadPhone);
    await dlg.getByLabel('Course interest').selectOption({ label: 'Full Stack Development' });
    await expect(dlg).toContainText('assigned by rule → Sanjay Kumar');
    await dlg.getByLabel('Course interest').selectOption({ label: 'Digital Marketing' });
    await dlg.getByLabel('Source').selectOption('Walk-in');
    await expect(dlg).toContainText('assigned by rule → Meera Pillai');
    await expect(dlg.getByText(/Already a lead/)).toHaveCount(0);

    await dlg.getByRole('button', { name: 'Create lead' }).click();
    await expect(page.getByText('Lead created · assigned to Meera')).toBeVisible();
    await expect(dlg).toBeHidden();
    await expect(page.locator(`section[data-stage="new"] [data-testid="lead-card"][aria-label="${leadName}"]`)).toBeVisible();

    // Server refuses the duplicate too.
    const base = test.info().project.use.baseURL!;
    const dup = await page.request.post(`${base}/api/sales/leads`, { data: { name: 'Dup', phone: leadPhone, source: 'Walk-in' }, headers: { Origin: base } });
    expect(dup.status()).toBe(409);
  });

  test('pipeline: one-click advance with undo, drag & drop to the next stage', async ({ page }) => {
    await loginAs(page, 'sales');
    await page.goto('/sales/pipeline');
    const inStage = (stage: string) => page.locator(`section[data-stage="${stage}"] [data-testid="lead-card"][aria-label="${leadName}"]`);
    await expect(inStage('new')).toBeVisible();

    await page.getByRole('button', { name: `Move ${leadName} to next stage` }).click();
    await expect(inStage('contacted')).toBeVisible();
    await expect(page.getByText(`${leadName} → Contacted`)).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText(`${leadName} moved back to New`)).toBeVisible();
    await expect(inStage('new')).toBeVisible();
    await expect(inStage('contacted')).toHaveCount(0);

    // Drag the card onto the next allowed column.
    await expect(async () => {
      // Re-drag only if a layout animation swallowed the previous attempt.
      if (await inStage('new').count()) await inStage('new').dragTo(page.locator('section[data-stage="contacted"]'), { targetPosition: { x: 60, y: 16 } });
      await expect(inStage('contacted')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(async () => {
      const leads = await api<{ items: LeadRow[] }>(page, 'GET', `/api/sales/leads?q=${encodeURIComponent(leadName)}`);
      expect(leads.items[0]!.stage).toBe('contacted');
    }).toPass();
  });

  test('lead record: next follow-up, then log the outcome from the follow-ups queue', async ({ page }) => {
    await loginAs(page, 'sales');
    const leads = await api<{ items: LeadRow[] }>(page, 'GET', `/api/sales/leads?q=${encodeURIComponent(leadName)}`);
    await page.goto(`/sales/leads?lead=${leads.items[0]!.id}`);
    const record = page.getByLabel('Lead record');
    await expect(record.getByText(leadName)).toBeVisible();
    // A follow-up that is already past due lands in the Overdue queue.
    await record.getByLabel('Next follow-up').fill('2026-01-05T10:30');
    await record.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Follow-up saved')).toBeVisible();
    await expect(record.getByText(/Follow-up scheduled · Call · Mon 5 Jan 10:30/)).toBeVisible();

    await page.goto('/sales/follow-ups');
    const overdue = page.locator('[aria-label="Overdue"]');
    const item = overdue.getByTestId('follow-up').filter({ hasText: leadName });
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: 'Log outcome' }).click();
    const dlg = page.getByRole('dialog', { name: `Log outcome · ${leadName}` });
    await dlg.getByLabel('Outcome').fill('Spoke for 5 min — will pay after salary credit');
    await dlg.getByText('Schedule the next follow-up').click();
    await expect(dlg.getByLabel('When')).toBeVisible();
    await dlg.getByLabel('Note').fill('Send EMI options');
    await dlg.getByText('Advance stage · Contacted → Counselled').click();
    await dlg.getByRole('button', { name: 'Save outcome' }).click();
    await expect(page.getByText('Outcome logged')).toBeVisible();
    await expect(item).toHaveCount(0);
    const after = await api<{ items: LeadRow[] }>(page, 'GET', `/api/sales/leads?q=${encodeURIComponent(leadName)}`);
    expect(after.items[0]!.stage).toBe('counselled');
  });

  test('import wizard: upload, map & preview, validate (bad rows + duplicate), run job, error report', async ({ page }) => {
    await loginAs(page, 'sales');
    const existing = await api<{ items: LeadRow[] }>(page, 'GET', '/api/sales/leads?q=Arjun%20Nair');
    const dupPhone = existing.items[0]!.phone!.slice(3);
    const rows = [
      'Full Name,Mobile,Email ID,Interested In,Campaign,City',
      ...Array.from({ length: 6 }, (_, i) => `Import Lead ${stamp}-${i},${phone(`9${i}`)},imp${stamp}${i}@example.test,${i % 2 ? 'Full Stack' : 'Digital Marketing'},IG_Oct_A,Trivandrum`),
      `Bineesh K ${stamp},9847,bineesh@yahoo.in,Full Stack,IG_Oct_A,Kochi`,
      `Deepak R ${stamp},${phone('86')},deepak.r@outlook,UI/UX,Referral,Trivandrum`,
      `Arjun Nair,${dupPhone},,Digital Marketing,GAds_Brand,Trivandrum`,
    ];
    const file = path.join(os.tmpdir(), `leads-${stamp}.csv`);
    fs.writeFileSync(file, rows.join('\n'));

    await page.goto('/sales/import');
    await expect(page.getByText('Drop a CSV or XLSX')).toBeVisible();
    await page.getByLabel('Lead file').setInputFiles(file);

    // Step 2 — mapping guessed from headers; invalid cells marked in the preview.
    await expect(page.getByText('Preview · first 9 of 9 rows')).toBeVisible();
    await expect(page.getByLabel('Full Name →')).toHaveValue('name');
    await expect(page.getByLabel('Mobile →')).toHaveValue('phone');
    await expect(page.getByLabel('Interested In →')).toHaveValue('course');
    await expect(page.getByLabel('City →')).toHaveValue('skip');
    await expect(page.locator('td[data-invalid]')).toHaveCount(2);
    await page.getByRole('button', { name: 'Validate →' }).click();

    // Step 3 — counts.
    await expect(page.getByText('Valid · will create').locator('..')).toContainText('6');
    await expect(page.getByText('1 existing lead · 0 enrolled students')).toBeVisible();
    await expect(page.getByText('1 bad phone · 1 bad email')).toBeVisible();
    const [report] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download error report' }).click()]);
    expect(report.suggestedFilename()).toMatch(/^import-errors-.*\.csv$/);
    const csv = fs.readFileSync(await report.path(), 'utf8');
    expect(csv).toContain('Not a valid 10-digit mobile');
    expect(csv).toContain('Not a valid email');
    await page.getByRole('button', { name: 'Run import' }).click();

    // Step 4 — background job completes.
    await expect(page.getByText('Import complete', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('6 created')).toBeVisible();
    await expect(page.getByText('1 merged')).toBeVisible();
    await expect(page.getByText('2 errors')).toBeVisible();
    await expect(page.getByText(/assigned round robin to \d sales(person|people)/)).toBeVisible();
    await page.getByRole('link', { name: 'Open pipeline' }).click();
    await expect(page).toHaveURL(/\/sales\/pipeline/);
  });

  test('convert lead → admission → Finance verifies → Super Admin approves 22% → Branch Admin approves', async ({ page }) => {
    // A fresh lead owned by Meera (Digital Marketing → "Everything else" rule).
    await loginAs(page, 'sales');
    const ref = await api<{ courses: { id: string; code: string }[] }>(page, 'GET', '/api/reference');
    const dm = ref.courses.find((c) => c.code === 'DM')!.id;
    const student = `Aiswarya Test ${stamp}`;
    const lead = await api<{ id: string; ownerName: string }>(page, 'POST', '/api/sales/leads', { name: student, phone: phone('96'), source: 'Referral', courseId: dm });
    expect(lead.ownerName).toBe('Meera');
    const before = await api<{ batches: { code: string; enrolled: number; seatsLeft: number }[] }>(page, 'GET', '/api/sales/admission-options');
    const dmB = before.batches.find((b) => b.code === 'DM-B')!;

    // Wizard: five steps prefilled from the lead.
    await page.goto(`/sales/admission?lead=${lead.id}`);
    await expect(page.getByRole('heading', { name: `New admission · ${student}` })).toBeVisible();
    await expect(page.getByText('Prefilled from lead')).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue(student);
    await page.getByLabel('Date of birth').fill('2001-05-14');
    await page.getByLabel('Address').fill('Pattom, Trivandrum 695004');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Draft autosaved')).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill(`Suresh Test ${stamp}`);
    await page.getByLabel('Phone (for parent login · OTP)').fill(phone('95'));
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: /^DM-B/ }).click();
    await expect(page.getByRole('radio', { name: /^DM-B/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Discount percent').fill('22');
    await expect(page.getByText('Needs Super Admin approval (>20%)')).toBeVisible();
    await page.getByLabel('Reason for the discount').fill('Sibling of alumnus + merit scholarship');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Upload ID proof').setInputFiles({ name: 'aadhaar.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(page.getByText('ID proof · aadhaar.pdf')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
    await page.getByText(/DPDP consent — purposes listed/).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('Submitted for approval', { exact: true })).toBeVisible();
    await expect(page.getByTestId('my-application').filter({ hasText: student })).toContainText('Awaiting Finance');

    const mine = await api<{ items: { id: string; studentName: string }[] }>(page, 'GET', '/api/admissions?status=mine');
    const admissionId = mine.items.find((a) => a.studentName === student)!.id;
    expect((await api<LeadRow>(page, 'GET', `/api/sales/leads/${lead.id}`)).stage).toBe('admission_in_progress');

    // Finance (Joseph) verifies the fee terms → above 20 % raises a Super Admin approval.
    await loginAs(page, 'finance');
    const queue = await api<{ items: { id: string }[] }>(page, 'GET', '/api/admissions?status=awaiting_finance');
    expect(queue.items.some((a) => a.id === admissionId)).toBeTruthy();
    const verified = await api<{ status: string; needsSuperAdmin: boolean; stepLabel: string }>(page, 'POST', `/api/admissions/${admissionId}/verify-fee`, { note: 'Plan and documents checked' });
    expect(verified).toMatchObject({ status: 'fee_verified', needsSuperAdmin: true, stepLabel: 'Awaiting Super Admin' });

    // Branch Admin cannot approve yet — the gate states why.
    await loginAs(page, 'branchadmin');
    await page.goto('/admissions');
    const row = page.getByTestId('admission-row').filter({ hasText: student });
    await expect(row).toContainText('Awaiting Super Admin');
    await expect(row.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(row).toContainText('Discount above 20% needs Super Admin approval');

    // Super Admin decides the discount through the core approvals queue.
    await loginAs(page, 'superadmin');
    const approvals = await api<{ id: string; title: string; pct: number }[]>(page, 'GET', '/api/approvals?status=pending');
    const req = approvals.find((a) => a.title === `Discount 22% · ${student}`)!;
    expect(req.pct).toBe(22);
    const decided = await api<{ status: string }>(page, 'POST', `/api/approvals/${req.id}/decide`, { decision: 'approved' });
    expect(decided.status).toBe('approved');

    // Branch Admin approves → admission number, student, lead Won, seat taken.
    await loginAs(page, 'branchadmin');
    await page.goto('/admissions');
    await expect(row).toContainText('Ready for approval');
    await expect(row).toContainText(`${dmB.seatsLeft} seats left`);
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(new RegExp(`Approved · TVM-DM-\\d{4}-\\d{5} · ${student}`))).toBeVisible();
    await page.getByRole('radio', { name: 'Approved' }).click();
    const done = page.getByTestId('admission-row').filter({ hasText: student });
    await expect(done).toContainText(/TVM-DM-\d{4}-\d{5}/);
    await expect(done).toContainText(`${dmB.seatsLeft - 1} seat`);
    const admissionNo = (await done.locator('.font-mono').textContent())!.trim();

    const found = await api<{ items: { kind: string; label: string; meta: string }[] }>(page, 'GET', `/api/search?q=${encodeURIComponent(student)}`);
    const stu = found.items.find((i) => i.kind === 'Student' && i.label === student);
    expect(stu?.meta).toContain(admissionNo);
    expect(stu?.meta).toContain('DM-B');

    await loginAs(page, 'sales');
    expect((await api<LeadRow>(page, 'GET', `/api/sales/leads/${lead.id}`)).stage).toBe('won');
    const after = await api<{ batches: { code: string; enrolled: number }[] }>(page, 'GET', '/api/sales/admission-options');
    expect(after.batches.find((b) => b.code === 'DM-B')!.enrolled).toBe(dmB.enrolled + 1);
  });

  test('Sales Manager: funnel, assignment rules and leaderboard render and act', async ({ page }) => {
    await loginAs(page, 'salesmanager');
    await page.goto('/sales/funnel');
    await expect(page.getByRole('heading', { name: 'Funnel & conversion' })).toBeVisible();
    await expect(page.getByText('Stage funnel')).toBeVisible();
    await expect(page.getByText('Median first response')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Referral' })).toBeVisible();
    await page.getByRole('radio', { name: 'Week' }).click();
    await expect(page.getByText(/· Week \d+/)).toBeVisible();

    await page.goto('/sales/assignment-rules');
    await expect(page.getByRole('heading', { name: 'Assignment rules' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /Source = Referral/ })).toBeVisible();
    await expect(page.getByText('Default', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete Everything else' })).toBeDisabled();
    await expect(page.getByLabel('From')).toContainText('Arun Dev (on leave)');
    await page.getByRole('button', { name: 'Add rule' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add rule' });
    await expect(dlg.getByText('Name the rule')).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    await page.goto('/sales/leaderboard');
    await expect(page.getByRole('heading', { name: 'Targets & leaderboard' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Meera Pillai' })).toBeVisible();
    await page.getByRole('button', { name: /^Set \w+ targets$/ }).click();
    const t = page.getByRole('dialog', { name: /^Set \w+ targets$/ });
    await t.getByLabel('Meera Pillai admissions target').fill('12');
    await t.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.getByText(/targets saved/)).toBeVisible();
  });
});
