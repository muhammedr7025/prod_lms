import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, loginAs, test } from './fixtures';
import { reseed } from './fixtures';

// Every spec starts from the known demo seed (specs mutate shared data).
test.beforeAll(() => reseed());

/**
 * Institution (Super Admin): overview KPIs & approvals, branches (drawer, Work
 * in this branch, holidays, rooms), staff lifecycle (invite → sign-in →
 * memberships → assignment → deactivation), roles & permissions, settings.
 * Mutates data — reseed before a run: `pnpm --filter @exatech/db seed`.
 */
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

const STAMP = Date.now().toString(36).slice(-5);
/** Mutations await their refetches before the toast; dev-mode servers on a busy machine can be slow. */
const SLOW = { timeout: 30_000 };
const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const MONTH = new Date(`${todayIST()}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

/** Shared across the serial tests: the invited teacher and their signed-in browser context. */
const invited = { name: `E2E Teacher ${STAMP}`, email: `e2e.teacher.${STAMP}@exatech.test`, phone: `98${String(Date.now()).slice(-8)}`, userId: '' };
let teacherCtx: BrowserContext | null = null;

/** A second signed-in browser (another person); fails the test on its page errors too. */
async function signedIn(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base });
  const res = await ctx.request.post('/api/auth/exa/demo-login', { data: { email }, headers: { Origin: base } });
  expect(res.ok(), `demo login for ${email}`).toBeTruthy();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_ABORTED|net::|EventSource|404 \(Not Found\)/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page, errors };
}

async function openPerson(page: Page, name: string) {
  await page.goto('/staff');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20_000 });
}

// Serial: later steps use the people, roles and settings created earlier. First opens compile drawers in dev.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('institution · super admin', () => {
  test.afterAll(async () => {
    await teacherCtx?.close();
  });

  test('overview KPIs for All branches, then Kochi', async ({ page }) => {
    const all = sql(`select count(distinct student_id) from enrollment where status = 'active'`);
    const kochi = sql(`select count(distinct e.student_id) from enrollment e join branch b on b.id = e.branch_id where e.status = 'active' and b.code = 'EKM'`);
    await loginAs(page, 'superadmin');
    await page.goto('/overview');
    await expect(page.getByText('Institution · All branches')).toBeVisible();
    const kpis = page.getByTestId('overview-kpis');
    for (const k of [`Revenue · ${MONTH}`, 'Collected', 'Dues outstanding', `Admissions · ${MONTH}`, 'Active students']) await expect(kpis.getByText(k, { exact: true })).toBeVisible();
    await expect(kpis).toContainText(all);
    await expect(kpis).toContainText(/% of target/);
    await expect(kpis).toContainText(/over 60 days/);
    await expect(page.getByTestId('branch-row')).toHaveCount(3);
    await expect(page.getByText(/Materialised · refreshed/)).toBeVisible();

    await page.getByLabel('Branch', { exact: true }).selectOption({ label: 'Kochi' });
    await expect(page.getByText('Institution · Kochi')).toBeVisible();
    await expect(kpis).toContainText(kochi);
    await expect(kpis).not.toContainText(all);
    await expect(page.getByTestId('branch-row')).toHaveCount(1);
    await expect(page.getByTestId('branch-row')).toContainText('Kochi');

    // Export is watermarked and audited.
    const csv = await page.request.get('/api/institution/overview/export');
    expect(csv.ok()).toBeTruthy();
    expect(await csv.text()).toContain('Exported by Deepu S Nath');
    expect(Number(sql(`select count(*) from audit_log where entity_label = 'institution-overview' and action_kind = 'export'`))).toBeGreaterThan(0);
  });

  test('approve the 22% discount; return the refund with a note', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/overview');
    const card = page.getByTestId('approvals-card');
    const discount = card.getByTestId('approval-row').filter({ hasText: 'Discount 22%' });
    await expect(discount).toContainText('Aiswarya Suresh');
    await discount.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(/Approved · Discount 22%/)).toBeVisible(SLOW);
    await expect(card.getByTestId('approval-row').filter({ hasText: 'Discount 22%' })).toHaveCount(0);
    const queue = await (await page.request.get('/api/admissions?status=queue')).json();
    const aiswarya = queue.items.find((a: { studentName: string }) => a.studentName === 'Aiswarya Suresh');
    expect(aiswarya.superAdminApproved).toBe(true);
    expect(aiswarya.stepLabel).not.toBe('Awaiting Super Admin');

    const refund = card.getByTestId('approval-row').filter({ hasText: 'Refund' });
    await refund.getByRole('button', { name: 'Return' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('button', { name: 'Return with note' })).toBeDisabled();
    await dlg.getByLabel('Note for the requester').fill('E2E · attach the signed drop-out form');
    await dlg.getByRole('button', { name: 'Return with note' }).click();
    await expect(page.getByText(/Returned to Joseph Mathew/)).toBeVisible(SLOW);
    await expect(card.getByTestId('approval-row').filter({ hasText: 'Refund' })).toHaveCount(0);
    expect(sql(`select status || ' · ' || decision_note from approval_request where kind = 'refund' order by decided_at desc nulls last limit 1`)).toBe('returned · E2E · attach the signed drop-out form');
  });

  test('branch panel: Work in this branch scopes the app', async ({ page }) => {
    const kochiId = sql(`select id from branch where code = 'EKM'`);
    await loginAs(page, 'superadmin');
    await page.goto('/branches');
    await expect(page.getByTestId('branch-card')).toHaveCount(3);
    await page.getByTestId('branch-card').filter({ hasText: 'Kochi' }).click();
    await expect(page.getByRole('heading', { name: 'Kochi' })).toBeVisible({ timeout: 20_000 });
    for (const k of ['Students', `Admissions · ${MONTH.slice(0, 3)}`, 'Dues']) await expect(page.getByText(k, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DM-K1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Work in this branch' }).click();
    await expect(page).toHaveURL(/\/branch$/);
    await expect(page.getByLabel('Branch', { exact: true })).toHaveValue(kochiId);
    const me = await (await page.request.get('/api/me')).json();
    expect(me.branch.selectedId).toBe(kochiId);
  });

  test('add a holiday → that day’s sessions are suppressed', async ({ page }) => {
    const date = sql(`select cs.date from class_session cs join branch b on b.id = cs.branch_id
      where b.code = 'TVM' and cs.status = 'scheduled' and cs.date > (now() at time zone 'Asia/Kolkata')::date
        and not exists (select 1 from holiday h where h.date = cs.date) group by cs.date order by cs.date limit 1`);
    const before = Number(sql(`select count(*) from class_session cs join branch b on b.id = cs.branch_id where b.code = 'TVM' and cs.date = '${date}' and cs.status = 'scheduled'`));
    expect(before).toBeGreaterThan(0);
    await loginAs(page, 'superadmin');
    await page.goto('/branches');
    await page.getByTestId('holiday-card').getByRole('button').click();
    const dlg = page.getByRole('dialog', { name: 'Holidays' });
    await expect(dlg.getByTestId('holiday-row').first()).toBeVisible();
    await dlg.getByLabel('Date', { exact: true }).fill(date);
    await dlg.getByLabel('Holiday', { exact: true }).fill(`E2E Founders Day ${STAMP}`);
    await dlg.getByLabel('Applies to').selectOption({ label: 'Trivandrum' });
    await dlg.getByRole('button', { name: 'Add holiday' }).click();
    await expect(page.getByText(`E2E Founders Day ${STAMP} added · ${before} session${before === 1 ? '' : 's'} suppressed`)).toBeVisible(SLOW);
    await expect(dlg.getByTestId('holiday-row').filter({ hasText: `E2E Founders Day ${STAMP}` })).toContainText('Trivandrum');
    expect(sql(`select count(*) from class_session cs join branch b on b.id = cs.branch_id where b.code = 'TVM' and cs.date = '${date}' and cs.status = 'scheduled'`)).toBe('0');
    expect(Number(sql(`select count(*) from class_session cs join branch b on b.id = cs.branch_id where b.code = 'TVM' and cs.date = '${date}' and cs.status = 'suppressed'`))).toBe(before);
    expect(sql(`select count(*) from audit_log where action = 'Holiday added' and summary like 'E2E Founders Day ${STAMP}%'`)).toBe('1');
  });

  test('rooms & capacity: add a room', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/branches');
    await page.getByTestId('branch-card').filter({ hasText: 'Calicut' }).click();
    await page.getByRole('button', { name: 'Rooms & capacity' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rooms & capacity' });
    await expect(dlg.getByTestId('room-row').first()).toBeVisible();
    await dlg.getByLabel('Name', { exact: true }).fill(`E2E Studio ${STAMP}`);
    await dlg.getByLabel('Capacity', { exact: true }).fill('0');
    await dlg.getByRole('button', { name: 'Add room' }).click();
    await expect(dlg.getByText('Capacity must be at least 1')).toBeVisible();
    await dlg.getByLabel('Capacity', { exact: true }).fill('18');
    await dlg.getByRole('button', { name: 'Add room' }).click();
    await expect(dlg.getByTestId('room-row').filter({ hasText: `E2E Studio ${STAMP}` })).toContainText('18', SLOW);
    expect(sql(`select r.capacity from room r join branch b on b.id = r.branch_id where b.code = 'CLT' and r.name = 'E2E Studio ${STAMP}'`)).toBe('18');
  });

  test('add branch: the API’s field messages show inline and nothing is created', async ({ page }) => {
    const before = sql(`select count(*) from branch`);
    await loginAs(page, 'superadmin');
    await page.goto('/branches');
    await page.getByRole('button', { name: 'Add branch' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add branch' });
    await dlg.getByLabel('Code').fill('TST');
    await dlg.getByLabel('Monthly collection target ₹').fill('500000');
    await dlg.getByRole('button', { name: 'Add branch' }).click();
    await expect(dlg.getByText('Enter the branch name')).toBeVisible();
    await expect(dlg.getByText('Enter the address')).toBeVisible();
    await expect(dlg.getByText('Enter the city')).toBeVisible();
    expect(sql(`select count(*) from branch`)).toBe(before);
  });

  test('invite a teacher → email in Mailpit → they sign in and land on /teacher', async ({ page, browser }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/staff?invite=1');
    const dlg = page.getByRole('dialog', { name: 'Invite staff' });
    await dlg.getByLabel('Full name').fill(invited.name);
    await dlg.getByLabel('Title').fill('Trainer · Digital Marketing');
    await dlg.getByLabel('Email').fill(invited.email);
    await dlg.getByLabel('Mobile').fill(invited.phone);
    await dlg.getByLabel('Home branch').selectOption({ label: 'Trivandrum' });
    await dlg.getByLabel('Membership 1 role').selectOption({ label: 'Teacher' });
    await dlg.getByRole('group', { name: 'Membership 1 branches' }).getByText('Trivandrum (TVM)').click();
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText(`Invite sent to ${invited.name}`)).toBeVisible(SLOW);
    await expect(page.getByRole('heading', { name: invited.name, exact: true })).toBeVisible({ timeout: 20_000 });
    invited.userId = sql(`select id from "user" where email = '${invited.email}'`);
    expect(sql(`select status from "user" where id = '${invited.userId}'`)).toBe('invited');

    // The invite email arrives in Mailpit with the sign-in link.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${MAILPIT}/api/v1/messages?limit=200`);
          const body = (await res.json()) as { messages: { To: { Address: string }[]; Subject: string }[] };
          return body.messages.find((m) => m.To.some((t) => t.Address === invited.email))?.Subject ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe('Deepu S Nath invited you to Exatech');
    expect(sql(`select count(*) from outbound_message where to_user_id = '${invited.userId}' and channel = 'whatsapp'`)).toBe('1');

    // Same email again is rejected with a clear message.
    await page.keyboard.press('Escape');
    await page.goto('/staff?invite=1');
    await dlg.getByLabel('Full name').fill('Someone Else');
    await dlg.getByLabel('Email').fill(invited.email);
    await dlg.getByLabel('Mobile').fill('9812300001');
    await dlg.getByLabel('Home branch').selectOption({ label: 'Trivandrum' });
    await dlg.getByLabel('Membership 1 role').selectOption({ label: 'Teacher' });
    await dlg.getByRole('group', { name: 'Membership 1 branches' }).getByText('Trivandrum (TVM)').click();
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(dlg.getByText('Already in use')).toBeVisible();

    // The invited teacher signs in (status flips to active) and lands on Today.
    const t = await signedIn(browser, invited.email);
    teacherCtx = t.ctx;
    await t.page.goto('/');
    await expect(t.page).toHaveURL(/\/teacher$/);
    expect(sql(`select status from "user" where id = '${invited.userId}'`)).toBe('active');
    expect(t.errors).toEqual([]);
  });

  test('edit memberships: add a Sales membership (their sessions are revoked — PRD §9.1)', async ({ page, browser }) => {
    await loginAs(page, 'superadmin');
    await openPerson(page, invited.name);
    await page.getByRole('button', { name: 'Edit memberships' }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit memberships' });
    await dlg.getByRole('button', { name: '+ Add membership' }).click();
    await dlg.getByLabel('Membership 2 role').selectOption({ label: 'Salesperson' });
    await dlg.getByRole('group', { name: 'Membership 2 branches' }).getByText('Trivandrum (TVM)').click();
    await dlg.getByRole('button', { name: 'Save memberships' }).click();
    await expect(page.getByText(`Memberships updated · ${invited.name}`)).toBeVisible(SLOW);
    await expect(page.getByTestId('membership-tags')).toContainText('Sales TVM');
    await expect(page.getByTestId('membership-tags')).toContainText('Teacher TVM');
    expect(sql(`select count(*) from membership where user_id = '${invited.userId}' and status = 'active'`)).toBe('2');
    // A role change signs the person out everywhere; they sign in again to pick up the new access.
    expect((await teacherCtx!.request.get('/api/me')).status()).toBe(401);
    await teacherCtx!.close();
    const t = await signedIn(browser, invited.email);
    teacherCtx = t.ctx;
    expect((await teacherCtx.request.get('/api/me')).status()).toBe(200);
  });

  test('assign to batch: one subject per batch', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await openPerson(page, invited.name);
    await page.getByRole('button', { name: 'Assign to batch' }).click();
    const dlg = page.getByRole('dialog', { name: 'Assign to batch' });
    const batch = dlg.getByLabel('Batch', { exact: true });
    const dma = await batch.locator('option', { hasText: 'DM-A · Digital Marketing' }).getAttribute('value');
    await batch.selectOption(dma!);
    // Search is taught by Nithin — offered but disabled.
    await expect(dlg.locator('option', { hasText: 'Search · SEO & analytics · taught by Nithin Raj' })).toBeDisabled();
    await dlg.getByLabel('Subject (from the course syllabus)').selectOption('Content strategy');
    await dlg.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(page.getByText(`${invited.name} → DM-A · Content strategy`)).toBeVisible(SLOW);
    await expect(page.getByTestId('teaching-table')).toContainText('Content strategy');
    await expect(page.getByTestId('membership-tags')).toContainText('Teacher DM-A');
    expect(sql(`select ta.subject_name from teacher_assignment ta join batch b on b.id = ta.batch_id where ta.teacher_user_id = '${invited.userId}' and b.code = 'DM-A' and ta.active`)).toBe('Content strategy');
  });

  test('deactivate signs them out everywhere', async ({ page }) => {
    expect(teacherCtx, 'invited teacher is signed in').not.toBeNull();
    expect((await teacherCtx!.request.get('/api/me')).status()).toBe(200);
    await loginAs(page, 'superadmin');
    await openPerson(page, invited.name);
    await expect(page.getByTestId('devices-card')).toContainText('Demo sign-in');
    await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Deactivate account' });
    await dlg.getByLabel('Reason (written to the audit log)').fill('E2E · left the institution');
    await dlg.getByRole('button', { name: 'Deactivate & sign out' }).click();
    await expect(page.getByText(new RegExp(`${invited.name} deactivated · signed out of [1-9]`))).toBeVisible(SLOW);
    expect((await teacherCtx!.request.get('/api/me')).status()).toBe(401);
    expect(sql(`select count(*) from session where user_id = '${invited.userId}'`)).toBe('0');
    await page.goto('/staff');
    await expect(page.getByTestId('staff-row').filter({ hasText: invited.name })).toContainText('Deactivated');
  });

  test('roles: create “Front desk” with Students read only; a member sees only Students', async ({ page, browser }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    const create = page.getByRole('dialog', { name: 'New role' });
    await create.getByLabel('Name').fill('Front desk');
    await expect(create.getByLabel('Key')).toHaveValue('front_desk');
    await create.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByText('Front desk created · starts with no permissions')).toBeVisible(SLOW);
    const panel = page.getByRole('dialog', { name: 'Front desk · permissions' });
    await panel.locator('label').filter({ hasText: 'View students' }).click();
    await panel.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Save matrix · 1' }).click();
    await expect(page.getByText(/Matrix saved · 1 role updated/)).toBeVisible(SLOW);
    const row = (resource: string) => page.getByTestId('matrix-row').filter({ hasText: resource });
    await expect(row('Courses, batches, timetable').locator('td[data-role="front_desk"]')).toHaveText('R');
    await expect(row('Leads').locator('td[data-role="front_desk"]')).toHaveText('—');
    expect(sql(`select array_to_string(permissions, ',') from role where key = 'front_desk'`)).toBe('academics:students.read');

    // Give someone that membership; they see only the Students screen.
    const roleId = sql(`select id from role where key = 'front_desk'`);
    const tvm = sql(`select id from branch where code = 'TVM'`);
    const email = `e2e.frontdesk.${STAMP}@exatech.test`;
    const res = await page.request.post('/api/institution/staff', {
      data: { name: `E2E Front Desk ${STAMP}`, email, phone: `97${String(Date.now()).slice(-8)}`, homeBranchId: tvm, title: 'Front office', memberships: [{ roleId, branchIds: [tvm] }] },
    });
    expect(res.ok()).toBeTruthy();
    const fd = await signedIn(browser, email);
    await fd.page.goto('/');
    await expect(fd.page).toHaveURL(/\/students$/);
    await expect(fd.page.getByRole('heading', { name: 'Students' })).toBeVisible();
    await expect(fd.page.locator('aside a')).toHaveCount(1);
    await expect(fd.page.locator('aside a')).toHaveText('Students');
    await fd.page.goto('/overview');
    await expect(fd.page.getByText('Overview is not part of your Front desk membership')).toBeVisible();
    expect(fd.errors).toEqual([]);
    await fd.ctx.close();
  });

  test('Super Admin cannot remove its own roles.manage', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/roles');
    await page.getByRole('button', { name: 'Edit Super Admin permissions' }).click();
    const panel = page.getByRole('dialog', { name: 'Super Admin · permissions' });
    await panel.locator('label').filter({ hasText: 'Edit roles & permissions' }).click();
    await expect(panel.getByText(/Super Admin must keep “Edit roles & permissions”/)).toBeVisible();
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('matrix-issue')).toContainText('Super Admin must keep');
    await expect(page.getByRole('button', { name: /Save matrix/ })).toBeDisabled();
    // The server refuses it as well, with the reason.
    const roles = await (await page.request.get('/api/institution/roles')).json();
    const sa = roles.roles.find((r: { key: string }) => r.key === 'superadmin');
    const res = await page.request.put('/api/institution/roles', { data: { changes: [{ roleId: sa.id, permissions: sa.permissions.filter((p: string) => p !== 'institution:roles.manage') }] } });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.message).toContain('Super Admin must keep');
  });

  test('settings: pattern validated inline; valid save is audited and re-themes the shell', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/settings');
    const format = page.getByLabel('Format');
    await format.fill('{BRANCH}-{COURSE}-{YEAR}');
    await expect(page.getByTestId('admission-preview')).toContainText('Pattern must contain {SEQ}');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Pattern must contain {SEQ} or {SEQ:n}' })).toBeVisible();
    await format.fill('{BRANCH}-{COURSE}-{YEAR}-{SEQ:5}');
    await expect(page.getByTestId('admission-preview')).toContainText(/Preview · TVM-DM-\d{4}-\d{5}/);
    await page.getByRole('radio', { name: 'Harbour blue' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved · applied across the app')).toBeVisible(SLOW);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).toBe('#2f6f9f');
    expect(sql(`select summary from audit_log where action = 'Settings changed' order by at desc limit 1`)).toContain('brand colour #4f9d68 → #2f6f9f');
    // Back to the default brand (also a valid, audited save).
    await page.getByRole('radio', { name: 'Exatech green (default)' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved · applied across the app').first()).toBeVisible(SLOW);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim().toLowerCase())).not.toBe('#2f6f9f');
  });

  test('Branch Admin sees staff of their branch only (read)', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/staff');
    await expect(page.getByText(/^Trivandrum · \d+ people · one person, many memberships$/)).toBeVisible();
    await expect(page.getByTestId('staff-row').filter({ hasText: 'Nithin Raj' })).toHaveCount(1);
    await expect(page.getByTestId('staff-row').filter({ hasText: 'Anu George' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite staff' })).toHaveCount(0);
    expect((await page.request.post('/api/institution/staff', { data: {} })).status()).toBe(403);
  });
});
