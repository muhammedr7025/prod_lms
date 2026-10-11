import crypto from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, loginAs, test } from './fixtures';
import { reseed } from './fixtures';

// Every spec starts from the known demo seed (specs mutate shared data).
test.beforeAll(() => reseed());

/**
 * Finance journeys. Run against a freshly seeded stack
 * (`pnpm --filter @exatech/db seed`) — the spec records payments, closes the
 * Trivandrum day book and cancels an invoice, so it is not idempotent.
 */
const SANDBOX_SECRET = process.env.SANDBOX_WEBHOOK_SECRET ?? 'sandbox-webhook-secret';

async function api<T = unknown>(page: Page, method: 'GET' | 'POST' | 'PUT', url: string, data?: unknown): Promise<T> {
  const base = test.info().project.use.baseURL!;
  const res =
    method === 'GET'
      ? await page.request.get(`${base}${url}`)
      : await page.request.fetch(`${base}${url}`, { method, data: data ?? {}, headers: { Origin: base } });
  expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

interface Match {
  studentId: string;
  enrollmentId: string;
  name: string;
  admissionNo: string | null;
}
interface Account {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  admissionNo: string | null;
  branchName: string;
  outstanding: number;
  overdue: number;
  suggestedAmount: number;
  pendingClearance: number;
  clearance: { cleared: boolean };
  instalments: { id: string; seq: number; invoiceNumber: string | null; balance: number }[];
}
interface ReceiptRow {
  id: string;
  number: string;
  studentName: string;
  amount: number;
  channel: string;
  date: string;
  verifyPath: string;
  paymentStatus: string;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const ANJALI = 'TVM-DM-2027-00142';
const ROHAN = 'TVM-FS-2027-00098';

async function findOne(page: Page, q: string): Promise<Match> {
  const r = await api<{ items: Match[] }>(page, 'GET', `/api/finance/desk/search?q=${encodeURIComponent(q)}`);
  expect(r.items.length, `desk search ${q}`).toBeGreaterThan(0);
  return r.items[0]!;
}

/** Locked Trivandrum accounts with an overdue balance (excluding the named personas). */
async function lockedTvmAccounts(page: Page) {
  const r = await api<{ items: { enrollmentId: string; studentName: string; admissionNo: string | null; branchName: string; overdue: number; feeCleared: boolean }[] }>(page, 'GET', '/api/finance/accounts?filter=locked&limit=100');
  return r.items.filter((a) => a.branchName === 'Trivandrum' && a.overdue > 0 && a.admissionNo && !['Anjali Menon', 'Rohan Menon'].includes(a.studentName));
}

async function openOnDesk(page: Page, admissionNo: string) {
  await page.goto('/finance/desk');
  const search = page.getByLabel('Scan or search');
  await expect(search).toBeFocused();
  await search.fill(admissionNo);
  await search.press('Enter');
  await expect(page.getByTestId('collect-panel').getByLabel(/^Amount \(suggested/)).toBeVisible();
}

test.describe.serial('finance', () => {
  test.describe.configure({ timeout: 180_000 });

  test('desk: scan Anjali → ₹15,000 UPI → next gap-free receipt → fee cleared → PDF → public verification', async ({ page, browser }) => {
    await loginAs(page, 'finance');
    const before = await api<{ items: ReceiptRow[] }>(page, 'GET', `/api/finance/receipts?q=${encodeURIComponent('TVM/RCPT')}&limit=1`);
    const last = before.items[0]!.number;
    const seq = Number(/(\d+)$/.exec(last)![1]);
    const expected = `${last.replace(/\d+$/, '')}${String(seq + 1).padStart(6, '0')}`;
    const anjali = await findOne(page, ANJALI);
    const acc0 = await api<Account>(page, 'GET', `/api/finance/accounts/${anjali.enrollmentId}`);
    expect(acc0.clearance.cleared).toBe(false);
    expect(acc0.suggestedAmount).toBe(15_000_00);

    await openOnDesk(page, ANJALI);
    const panel = page.getByTestId('collect-panel');
    await expect(page.getByRole('heading', { name: 'Collection desk' })).toBeVisible();
    await expect(page.getByText('Anjali Menon', { exact: true })).toBeVisible();
    await expect(page.getByTestId('clearance-tag')).toHaveText(/Locked · instalment 2/);
    await expect(panel.getByText('Amount (suggested: next due ₹15,000 · minimum ₹1,000)')).toBeVisible();
    await expect(panel.getByLabel(/^Amount \(suggested/)).toHaveValue('15000');
    await panel.getByLabel('Method').selectOption('upi');
    // Reference is required for UPI — the reason is stated inline and Confirm stays disabled.
    await expect(panel.getByText('Enter the UPI transaction ID')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Confirm & print receipt/ })).toBeDisabled();
    await panel.getByLabel('Reference', { exact: true }).fill('UPI-E2E-0001');
    await panel.getByLabel('Reference', { exact: true }).press('Enter');

    const card = page.getByTestId('receipt-card');
    await expect(card).toContainText(`Receipt ${expected}`);
    await expect(card).toContainText('UPI ₹15,000');
    await expect(card).toContainText('Sent · WhatsApp + email');
    await expect(page.getByTestId('clearance-tag')).toHaveText(/Fee cleared/);

    // Fee clearance flipped on the enrollment (notes unlock).
    const acc1 = await api<Account>(page, 'GET', `/api/finance/accounts/${anjali.enrollmentId}`);
    expect(acc1.clearance.cleared).toBe(true);

    // Receipt PDF (A4 and 80 mm) + public verification page (no login).
    const rec = (await api<{ items: ReceiptRow[] }>(page, 'GET', `/api/finance/receipts?q=${encodeURIComponent(expected)}`)).items[0]!;
    expect(rec.amount).toBe(15_000_00);
    const base = test.info().project.use.baseURL!;
    for (const format of ['A4', '80mm']) {
      const pdf = await page.request.get(`${base}/api/documents/receipts/${rec.id}.pdf?format=${format}`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('application/pdf');
      expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const anon = await browser.newContext();
    const pub = await anon.newPage();
    await pub.goto(`${base}${rec.verifyPath}`);
    await expect(pub.getByTestId('verify-card')).toContainText(expected);
    await expect(pub.getByTestId('verify-card')).toContainText('Verified');
    await expect(pub.getByTestId('verify-card')).toContainText('₹15,000');
    await expect(pub.getByTestId('verify-card')).toContainText('Trivandrum');
    await anon.close();
  });

  test('desk: partial below ₹1,000 is blocked with the reason; split tender; cheque stays pending and does not clear', async ({ page }) => {
    await loginAs(page, 'finance');
    // Partial below the minimum (Rohan owes more than ₹1,000).
    await openOnDesk(page, ROHAN);
    const panel = page.getByTestId('collect-panel');
    await panel.getByLabel(/^Amount \(suggested/).fill('500');
    await panel.getByLabel('Method').selectOption('cash');
    await expect(panel.getByText('Minimum partial payment is ₹1,000')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Confirm & print receipt/ })).toBeDisabled();
    // The server refuses it too.
    const rohan = await findOne(page, ROHAN);
    const base = test.info().project.use.baseURL!;
    const refused = await page.request.post(`${base}/api/finance/payments`, {
      data: { enrollmentId: rohan.enrollmentId, tenders: [{ method: 'cash', amount: 500_00 }], counterName: 'Counter 1', idempotencyKey: `e2e-${Date.now()}` },
      headers: { Origin: base },
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.message).toContain('Minimum partial payment is ₹1,000');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Scan or search')).toBeVisible();

    const [splitAcc, chequeAcc] = await lockedTvmAccounts(page);
    expect(splitAcc && chequeAcc, 'two locked Trivandrum accounts in the seed').toBeTruthy();

    // Split tender: UPI + cash in one payment, one receipt.
    await openOnDesk(page, splitAcc!.admissionNo!);
    const a = await api<Account>(page, 'GET', `/api/finance/accounts/${splitAcc!.enrollmentId}`);
    const due = a.suggestedAmount;
    await panel.getByLabel(/^Amount \(suggested/).fill(String((due - 1_000_00) / 100));
    await panel.getByLabel('Method').selectOption('upi');
    await panel.getByLabel('Reference', { exact: true }).fill('UPI-E2E-SPLIT');
    await page.keyboard.press('F3');
    await expect(panel.getByLabel('Second tender')).toBeVisible();
    await panel.getByLabel('Second tender').selectOption('cash');
    await panel.getByLabel('Amount', { exact: true }).fill('1000');
    await expect(page.getByTestId('total-received')).toHaveText(rupees(due));
    await panel.getByRole('button', { name: /Confirm & print receipt/ }).click();
    const card = page.getByTestId('receipt-card');
    await expect(card).toContainText(`UPI ${rupees(due - 1_000_00)} + Cash ₹1,000`);
    // Double submit is safe: the same attempt replays the same receipt.
    const after = await api<Account>(page, 'GET', `/api/finance/accounts/${splitAcc!.enrollmentId}`);
    expect(after.outstanding).toBe(a.outstanding - due);

    // Cheque: receipt issued, money pending clearance, notes stay locked.
    await page.getByRole('button', { name: 'Next student' }).click();
    const search = page.getByLabel('Scan or search');
    await search.fill(chequeAcc!.admissionNo!);
    await search.press('Enter');
    const c0 = await api<Account>(page, 'GET', `/api/finance/accounts/${chequeAcc!.enrollmentId}`);
    await expect(panel.getByLabel(/^Amount \(suggested/)).toHaveValue(String(c0.suggestedAmount / 100));
    await panel.getByLabel('Method').selectOption('cheque');
    await panel.getByLabel('Reference', { exact: true }).fill('CHQ-482913');
    await expect(panel.getByText(/Cheque stays pending clearance/)).toBeVisible();
    await panel.getByRole('button', { name: /Confirm & print receipt/ }).click();
    await expect(page.getByTestId('receipt-card')).toContainText('cheque pending clearance');
    const c1 = await api<Account>(page, 'GET', `/api/finance/accounts/${chequeAcc!.enrollmentId}`);
    expect(c1.clearance.cleared).toBe(false);
    expect(c1.pendingClearance).toBe(c0.suggestedAmount);
    await expect(page.getByTestId('clearance-tag')).toHaveText(/Locked/);
  });

  test('fee verification queue: Finance verifies an admission (step 2)', async ({ page }) => {
    await loginAs(page, 'finance');
    await page.goto('/finance');
    await expect(page.getByText('Fee verification queue · step 2 of admission')).toBeVisible();
    const row = page.getByRole('row', { name: /Neha George/ });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Verify fee terms' }).click();
    await expect(page.getByText(/Fee terms verified · Neha George/)).toBeVisible();
    await expect(page.getByRole('row', { name: /Neha George/ })).toHaveCount(0);
    // Return to Sales asks for a note.
    const kiran = page.getByRole('row', { name: /Kiran Thomas/ });
    await kiran.getByRole('button', { name: 'Return to Sales' }).click();
    const dlg = page.getByRole('dialog', { name: /Return Kiran Thomas to Sales/ });
    await expect(dlg.getByRole('button', { name: 'Return to Sales' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('admissions chain: Divya Pillai approved by Branch Admin → instalments + invoice 1', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    const q = await api<{ items: { id: string; studentName: string; status: string }[] }>(page, 'GET', '/api/admissions?status=queue');
    const divya = q.items.find((x) => x.studentName === 'Divya Pillai');
    expect(divya, 'Divya Pillai ready for Branch Admin').toBeTruthy();
    const approved = await api<{ admissionNo: string; status: string }>(page, 'POST', `/api/admissions/${divya!.id}/approve`);
    expect(approved.status).toBe('approved');

    await loginAs(page, 'finance');
    const m = await findOne(page, approved.admissionNo);
    const acc = await api<Account>(page, 'GET', `/api/finance/accounts/${m.enrollmentId}`);
    expect(acc.instalments.length).toBeGreaterThanOrEqual(1);
    expect(acc.instalments[0]!.invoiceNumber).toMatch(/^TVM\/INV\/\d{4}-\d{2}\/\d{6}$/);
    await page.goto(`/finance/accounts/${m.enrollmentId}`);
    await expect(page.getByRole('heading', { name: 'Divya Pillai · fee account' })).toBeVisible();
    await expect(page.getByText(`Invoice · ${acc.instalments[0]!.seq}`, { exact: false }).first()).toBeVisible();
    const inv = await page.request.get(`${test.info().project.use.baseURL}/api/documents/invoices/${(await api<{ items: { id: string; number: string }[] }>(page, 'GET', `/api/finance/invoices?q=${encodeURIComponent(acc.instalments[0]!.invoiceNumber!)}`)).items[0]!.id}.pdf`);
    expect(inv.status()).toBe(200);
    expect(inv.headers()['content-type']).toContain('application/pdf');
  });

  test('online: parent pays Rohan via the sandbox → paid + fee cleared; replaying the webhook does not double-record', async ({ page }) => {
    await loginAs(page, 'finance');
    const rohan = await findOne(page, ROHAN);
    const r0 = await api<Account>(page, 'GET', `/api/finance/accounts/${rohan.enrollmentId}`);
    expect(r0.clearance.cleared).toBe(false);

    await loginAs(page, 'parent');
    const order = await api<{ orderId: string; amount: number; gateway: string; sandboxUrl: string; externalOrderId: string }>(page, 'POST', '/api/portal/payments/orders', { studentId: rohan.studentId, purpose: 'next_due' });
    expect(order.gateway).toBe('sandbox');
    expect(order.amount).toBe(r0.suggestedAmount);
    // A client-supplied amount is never trusted for next_due; custom below the minimum is refused.
    const base = test.info().project.use.baseURL!;
    const bad = await page.request.post(`${base}/api/portal/payments/orders`, { data: { studentId: rohan.studentId, purpose: 'custom', amount: 500_00 }, headers: { Origin: base } });
    expect(bad.status()).toBe(422);

    await page.goto(order.sandboxUrl);
    await expect(page.getByTestId('sandbox-checkout')).toContainText('Rohan Menon');
    await page.getByRole('radio', { name: 'Card' }).click();
    await page.getByRole('button', { name: `Pay ${rupees(order.amount)}` }).click();
    await expect(page.getByTestId('checkout-success')).toContainText('Fee cleared · notes unlocked');

    const st = await api<{ status: string; feeCleared: boolean; receiptNumber: string }>(page, 'GET', `/api/portal/payments/orders/${order.orderId}`);
    expect(st.status).toBe('paid');
    expect(st.feeCleared).toBe(true);
    expect(st.receiptNumber).toMatch(/^TVM\/RCPT\//);

    // Replay the same signed webhook (same event + payment id), then a different event for the same payment.
    const suffix = order.externalOrderId.replace(/^sbx_order_/, '');
    const send = async (eventId: string) => {
      const body = JSON.stringify({ entity: 'event', event: 'payment.captured', contains: ['payment'], created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: `sbx_pay_${suffix}`, order_id: order.externalOrderId, amount: order.amount, currency: 'INR', method: 'card', status: 'captured' } } } });
      const sig = crypto.createHmac('sha256', SANDBOX_SECRET).update(body).digest('hex');
      const res = await page.request.post(`${base}/api/payments/webhooks/sandbox`, { data: body, headers: { 'Content-Type': 'application/json', 'x-sandbox-signature': sig, 'x-sandbox-event-id': eventId } });
      expect(res.ok(), `webhook replay ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as { duplicate: boolean };
    };
    expect((await send(`sbx_evt_${suffix}_success`)).duplicate).toBe(true);
    expect((await send(`sbx_evt_${suffix}_retry`)).duplicate).toBe(true);
    // A forged signature is rejected.
    const forged = await page.request.post(`${base}/api/payments/webhooks/sandbox`, { data: '{"event":"payment.captured"}', headers: { 'Content-Type': 'application/json', 'x-sandbox-signature': 'deadbeef', 'x-sandbox-event-id': 'forged' } });
    expect(forged.status()).toBe(403);

    await loginAs(page, 'finance');
    const recs = await api<{ items: ReceiptRow[] }>(page, 'GET', `/api/finance/receipts?q=${encodeURIComponent('Rohan Menon')}`);
    expect(recs.items.filter((r) => r.channel === 'online' && r.amount === order.amount && r.number === st.receiptNumber)).toHaveLength(1);
    const r1 = await api<Account>(page, 'GET', `/api/finance/accounts/${rohan.enrollmentId}`);
    expect(r1.clearance.cleared).toBe(true);
    expect(r1.outstanding).toBe(r0.outstanding - order.amount);
  });

  test('invoices: cancel issues a credit note; reprint is watermarked and logged', async ({ page }) => {
    await loginAs(page, 'finance');
    const list = await api<{ items: { id: string; number: string; cancelBlockedReason: string | null; status: string }[] }>(page, 'GET', `/api/finance/invoices?status=issued&limit=20&q=${encodeURIComponent('TVM/INV')}`);
    const target = list.items.find((i) => !i.cancelBlockedReason && i.number.startsWith('TVM'));
    expect(target, 'an unpaid Trivandrum invoice').toBeTruthy();
    await page.goto('/finance/invoices');
    await page.getByLabel('Month').selectOption('');
    await page.getByLabel('Search documents').fill(target!.number);
    const row = page.locator(`tr[data-number="${target!.number}"]`);
    await expect(row).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((u: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(u);
        return null;
      }) as typeof window.open;
    });
    await row.getByRole('button', { name: 'Reprint' }).click();
    await expect(page.getByText('Duplicate #1 · watermarked and logged')).toBeVisible();
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened[0]).toContain('copy=duplicate');
    const dup = await page.request.get(`${test.info().project.use.baseURL}${opened[0]}`);
    expect(dup.status()).toBe(200);
    expect(dup.headers()['content-type']).toContain('application/pdf');

    await row.getByRole('button', { name: 'Cancel' }).click();
    const dlg = page.getByRole('dialog', { name: /Cancel invoice/ });
    await dlg.getByLabel('Reason (required)').fill('Issued twice by mistake');
    await dlg.getByRole('button', { name: 'Cancel invoice · issue credit note' }).click();
    await expect(page.getByText(/Invoice cancelled · credit note TVM\/CN\//)).toBeVisible();
    await expect(row.getByText('Cancelled')).toBeVisible();
    await page.getByRole('radio', { name: 'Credit notes' }).click();
    await page.getByLabel('Search documents').fill('');
    await expect(page.getByText(`Invoice ${target!.number}`)).toBeVisible();
  });

  test('dues: one-click remind flips to Reminded and is logged', async ({ page }) => {
    await loginAs(page, 'finance');
    await page.goto('/finance/dues');
    await expect(page.getByRole('heading', { name: 'Dues & follow-up' })).toBeVisible();
    const row = page.locator('tbody tr').filter({ has: page.getByRole('button', { name: 'Remind', exact: true }) }).first();
    const name = await row.getAttribute('data-student');
    await row.getByRole('button', { name: 'Remind', exact: true }).click();
    await expect(page.getByText('Reminder sent · WhatsApp + invoice PDF')).toBeVisible();
    await expect(page.locator(`tr[data-student="${name}"]`).first().getByRole('button', { name: 'Reminded' })).toBeDisabled();
  });

  test('reconciliation: auto-match, then record an unmatched settlement item as an advance', async ({ page }) => {
    await loginAs(page, 'finance');
    await page.goto('/finance/reconciliation');
    await page.getByRole('button', { name: 'Auto-match' }).click();
    await expect(page.getByText(/Auto-match · \d+ matched/)).toBeVisible();
    const row = page.locator('tbody tr').filter({ hasText: '₹12,000' }).filter({ hasText: 'Unmatched' });
    await row.getByRole('button', { name: 'Record as advance' }).click();
    const dlg = page.getByRole('dialog', { name: 'Record as advance' });
    await dlg.getByLabel('Find student').fill('Anjali Menon');
    await dlg.getByRole('option', { name: /Anjali Menon/ }).click();
    await dlg.getByRole('button', { name: 'Record on account' }).click();
    await expect(page.getByText(/Recorded on Anjali Menon's account · receipt TVM\/RCPT\//)).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: '₹12,000' }).getByText('Resolved')).toBeVisible();
  });

  test('settings: validation and save (UPI VPA enables the desk QR)', async ({ page }) => {
    await loginAs(page, 'finance');
    await page.goto('/finance/settings');
    const inv = page.getByLabel('Invoice', { exact: true });
    const original = await inv.inputValue();
    await inv.fill('{BRANCH}/INV/{FY}');
    await expect(page.getByText('Pattern must contain {SEQ} or {SEQ:n}')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await inv.fill(original);
    await page.getByLabel('UPI VPA (desk QR)').fill('exatech@icici');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Finance settings saved')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('UPI VPA (desk QR)')).toHaveValue('exatech@icici');
    const anjali = await findOne(page, ANJALI);
    const qr = await page.request.get(`${test.info().project.use.baseURL}/api/finance/desk/upi-qr.png?enrollmentId=${anjali.enrollmentId}&amount=100000`);
    expect(qr.status()).toBe(200);
    expect(qr.headers()['content-type']).toContain('image/png');
  });

  test('day book: closing the day locks further desk entries for that branch-day', async ({ page }) => {
    await loginAs(page, 'finance');
    await page.goto('/finance/day-book');
    await expect(page.getByRole('heading', { name: 'Day book & cash closing' })).toBeVisible();
    await page.getByRole('radio', { name: 'Trivandrum' }).click();
    await expect(page.getByRole('cell', { name: /Counter 1 · Joseph Mathew/ })).toBeVisible();
    // A count that differs needs an explanation before the day can lock.
    await page.getByLabel('₹500 ×').fill('10');
    await expect(page.getByText(/explain the .* difference/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close day · lock entries' })).toBeDisabled();
    await page.getByLabel('Explanation (required if difference ≠ 0)').fill('Balance moved to the safe — slip 0042');
    await page.getByRole('button', { name: 'Close day · lock entries' }).click();
    await expect(page.getByText(/Day closed · Trivandrum/).first()).toBeVisible();

    // The desk now refuses entries for Trivandrum today.
    const rohan = await findOne(page, ROHAN);
    const base = test.info().project.use.baseURL!;
    const refused = await page.request.post(`${base}/api/finance/payments`, {
      data: { enrollmentId: rohan.enrollmentId, tenders: [{ method: 'cash', amount: 2_000_00 }], counterName: 'Counter 1', idempotencyKey: `e2e-closed-${Date.now()}` },
      headers: { Origin: base },
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.message).toMatch(/day book .* was closed/);
    await openOnDesk(page, ROHAN);
    await expect(page.getByText(/day book is closed for today/)).toBeVisible();
  });
});
