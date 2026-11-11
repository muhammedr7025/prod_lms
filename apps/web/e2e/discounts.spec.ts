import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, loginAs, reseed, test } from './fixtures';

/**
 * Fee reductions after admission: referral / special / scholarship / other.
 * Cumulative approval limits (Finance >10%, Super Admin >20% of list), only unpaid fee can be reduced,
 * one pending request per account, everything recorded and reported. Mutates data → reseeds first.
 * Rohan Menon (TVM-FS-2027-00098): fee ₹72,000, ₹36,600 still unpaid.
 */
test.beforeAll(() => reseed());
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}
const enrollmentId = () => sql(`select e.id from enrollment e join student s on s.id = e.student_id where s.admission_no = 'TVM-FS-2027-00098' and e.status = 'active'`);
const feeTotal = () => Number(sql(`select fee_total from enrollment where id = '${enrollmentId()}'`));

async function post(page: Page, url: string, data: unknown) {
  const base = test.info().project.use.baseURL!;
  return page.request.post(`${base}${url}`, { data, headers: { Origin: base } });
}
const grant = (page: Page, body: unknown) => post(page, `/api/finance/accounts/${enrollmentId()}/discount`, body);

test('a small referral discount is applied at once: fee, instalments, ledger, history and audit all agree', async ({ page }) => {
  await loginAs(page, 'finance');
  const before = feeTotal();
  const waivedBefore = Number(sql(`select coalesce(sum(waived),0) from instalment where enrollment_id = '${enrollmentId()}'`));

  const noSource = await grant(page, { kind: 'referral', amount: 360000, reason: 'Referred by an alumnus' });
  expect(noSource.status()).toBe(422);
  const tooMuch = await grant(page, { kind: 'special', amount: 99_999_900, reason: 'More than is unpaid' });
  expect(tooMuch.status()).toBe(422);
  expect(feeTotal()).toBe(before); // nothing saved by the refused attempts

  const ok = await grant(page, { kind: 'referral', amount: 360000, reason: 'Referred by an alumnus', sourceName: 'Anjali Menon (TVM-DM-2027-00142)' });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  expect(((await ok.json()) as { status: string }).status).toBe('applied');

  expect(feeTotal()).toBe(before - 360000);
  expect(Number(sql(`select coalesce(sum(waived),0) from instalment where enrollment_id = '${enrollmentId()}'`))).toBe(waivedBefore + 360000);
  expect(sql(`select count(*) from fee_discount where enrollment_id = '${enrollmentId()}' and kind = 'referral' and origin = 'adjustment' and amount = 360000`)).toBe('1');
  expect(sql(`select count(*) from ledger_entry where enrollment_id = '${enrollmentId()}' and credit = 360000 and kind = 'discount'`)).toBe('1');
  expect(Number(sql(`select discount_pct from enrollment where id = '${enrollmentId()}'`))).toBeCloseTo(5, 0);
  expect(sql(`select count(*) from audit_log where entity_id = '${enrollmentId()}' and action ilike '%discount%'`)).not.toBe('0');

  const acc = (await (await page.request.get(`${test.info().project.use.baseURL}/api/finance/accounts/${enrollmentId()}`)).json()) as {
    feeTotal: number;
    discounts: { history: { kind: string; sourceName: string | null }[]; pctBelowList: number };
  };
  expect(acc.feeTotal).toBe(before - 360000);
  expect(acc.discounts.history[0]).toMatchObject({ kind: 'referral', sourceName: 'Anjali Menon (TVM-DM-2027-00142)' });
  expect(acc.discounts.pctBelowList).toBeGreaterThan(4);
});

test('limits count the total reduction; a request above the limit waits for the Super Admin, one at a time', async ({ page }) => {
  await loginAs(page, 'finance');
  const before = feeTotal();
  // 5% already given; another 20% of list takes the total to ~25% → beyond Finance's own limit.
  const big = await grant(page, { kind: 'scholarship', amount: 1_440_000, reason: 'Merit scholarship awarded by trust', sourceName: 'Trust' });
  expect(big.ok(), await big.text()).toBeTruthy();
  const bigBody = (await big.json()) as { status: string; approvalId: string };
  expect(bigBody.status).toBe('approval_requested');
  expect(feeTotal()).toBe(before); // nothing changes until it is approved

  const again = await grant(page, { kind: 'special', amount: 100000, reason: 'A second request at the same time' });
  expect(again.status()).toBe(409);
  expect(await again.text()).toMatch(/already waiting/i);

  await loginAs(page, 'superadmin');
  const decided = await post(page, `/api/approvals/${bigBody.approvalId}/decide`, { decision: 'approved' });
  expect(decided.ok(), await decided.text()).toBeTruthy();
  expect(feeTotal()).toBe(before - 1_440_000);
  expect(sql(`select count(*) from fee_discount where enrollment_id = '${enrollmentId()}'`)).toBe('2');
  expect(Number(sql(`select discount_pct from enrollment where id = '${enrollmentId()}'`))).toBeGreaterThan(20);
});

test('the discount report totals by kind; teachers cannot give discounts', async ({ page }) => {
  await loginAs(page, 'finance');
  const rep = (await (await page.request.get(`${test.info().project.use.baseURL}/api/finance/discounts`)).json()) as {
    total: number;
    count: number;
    byKind: { kind: string; amount: number }[];
    rows: { studentName: string }[];
  };
  expect(rep.count).toBeGreaterThanOrEqual(2);
  expect(rep.total).toBe(rep.byKind.reduce((n, k) => n + k.amount, 0));
  expect(rep.byKind.map((k) => k.kind)).toEqual(expect.arrayContaining(['referral', 'scholarship']));
  expect(rep.rows.some((r) => r.studentName === 'Rohan Menon')).toBeTruthy();

  await loginAs(page, 'teacher');
  expect((await grant(page, { kind: 'special', amount: 100000, reason: 'Teacher should not be able to' })).status()).toBe(403);
});

test('Finance sees the discount on the fee account and can give another from the dialog', async ({ page }) => {
  await loginAs(page, 'finance');
  await page.goto(`/finance/accounts/${enrollmentId()}`);
  const card = page.getByTestId('discounts-card');
  await expect(card).toContainText('Discounts & scholarships');
  await expect(card.getByTestId('discount-row').first()).toContainText(/Scholarship|Referral/);

  await card.getByRole('button', { name: 'Give a discount' }).click();
  const dlg = page.getByRole('dialog', { name: /Give a discount/ });
  await dlg.getByLabel('Why is it given?').selectOption('other');
  await dlg.getByRole('radio', { name: '₹' }).click();
  await dlg.getByLabel('Amount (₹)').fill('500');
  await expect(dlg.getByText('Say why (at least 5 characters)')).toBeVisible();
  await dlg.getByLabel('Reason').fill('Goodwill — late start of batch');
  await expect(dlg.getByTestId('discount-effect')).toBeVisible();
  // Rohan is already past 20% in total, so even ₹500 more goes to the Super Admin — the button says so.
  await expect(dlg.getByRole('button', { name: 'Send for approval' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Send for approval' }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => sql(`select count(*) from approval_request where entity_id = '${enrollmentId()}' and kind = 'discount' and status = 'pending'`), { timeout: 15_000 }).toBe('1');
  expect(sql(`select count(*) from fee_discount where enrollment_id = '${enrollmentId()}'`)).toBe('2'); // unchanged until decided
});
