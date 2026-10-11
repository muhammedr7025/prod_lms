import { execFileSync } from 'node:child_process';
import { expect, loginAs, test } from './fixtures';

/**
 * Academics + Communications (Branch Administrator). Mutates data — reseed
 * before a run: `pnpm --filter @exatech/db seed`. SQL setup (ad-hoc session,
 * leave, a room clash) goes straight to the database because those rows are
 * created by other modules (Teaching) in the product.
 */
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

const DAY = 86_400_000;
const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
function mondayOf(d: string) {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}
const weeksBetween = (a: string, b: string) => Math.round((Date.parse(`${mondayOf(b)}T00:00:00Z`) - Date.parse(`${mondayOf(a)}T00:00:00Z`)) / (7 * DAY));

/** Next scheduled DM-A session of Nithin (the leave / substitute target). */
function nextNithinSessionDate() {
  return sql(`select cs.date from class_session cs join "user" u on u.id = cs.teacher_user_id join batch b on b.id = cs.batch_id
    where u.email = 'nithin@exatech.test' and b.code = 'DM-A' and cs.kind = 'timetabled' and cs.status = 'scheduled'
      and cs.date > (now() at time zone 'Asia/Kolkata')::date order by cs.date, cs.start_time limit 1`);
}

// Serial: tests build on the seeded data. Generous timeouts: first opens compile code-split drawers in dev.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('academics & communications', () => {
  test('branch operations: KPIs, acknowledge an ad-hoc session, approve leave', async ({ page }) => {
    sql(`delete from leave where reason = 'E2E fever'`);
    sql(`insert into class_session (id, branch_id, batch_id, teacher_user_id, subject_name, date, start_time, end_time, mode, kind, adhoc_type, adhoc_reason, status, topic, attendance_submitted_at, attendance_submitted_by)
      select gen_random_uuid(), b.branch_id, b.id, u.id, 'Paid media · Google Ads', (now() at time zone 'Asia/Kolkata')::date, '07:00', '08:00', 'offline', 'adhoc', 'extra', 'E2E doubt clearing', 'held', 'E2E extra class', now(), u.id
      from batch b, "user" u where b.code = 'DM-B' and u.email = 'nithin@exatech.test'`);
    const leaveDate = nextNithinSessionDate();
    sql(`insert into leave (id, user_id, branch_id, date, type, reason, status)
      select gen_random_uuid(), u.id, b.id, '${leaveDate}', 'sick', 'E2E fever', 'pending' from "user" u, branch b where u.email = 'nithin@exatech.test' and b.code = 'TVM'`);

    await loginAs(page, 'branchadmin');
    await page.goto('/branch');
    await expect(page.getByRole('heading', { name: 'Branch operations' })).toBeVisible();
    for (const k of ['Sessions today', 'Running batches', 'Admissions pending', 'Marks to publish', 'At-risk students']) await expect(page.getByText(k, { exact: true })).toBeVisible();
    await expect(page.getByText('Rohan Menon')).toBeVisible();

    const adhoc = page.getByTestId('today-session').filter({ hasText: 'E2E extra class' });
    await expect(adhoc.getByText('Ad-hoc · acknowledge')).toBeVisible();
    await adhoc.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('Ad-hoc session acknowledged')).toBeVisible();
    await expect(adhoc.getByText('Marked')).toBeVisible();

    const leave = page.getByTestId('leave-row').filter({ hasText: 'Nithin Raj' });
    await expect(leave).toContainText('session');
    await leave.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(/Leave approved/)).toBeVisible();
    await expect(page.getByTestId('leave-row').filter({ hasText: 'Nithin Raj' })).toHaveCount(0);
    expect(sql(`select count(*) from class_session cs join "user" u on u.id = cs.teacher_user_id where u.email = 'nithin@exatech.test' and cs.date = '${leaveDate}' and cs.flag = 'leave · substitute?'`)).not.toBe('0');
  });

  test('courses & batches: create a batch with a weekly schedule', async ({ page }) => {
    const code = `E2E-${Date.now().toString(36).slice(-5).toUpperCase()}`;
    await loginAs(page, 'branchadmin');
    await page.goto('/batches?new=1');
    const dlg = page.getByRole('dialog', { name: 'New batch' });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Course', { exact: true }).selectOption({ label: 'DM · Digital Marketing' });
    await dlg.getByLabel('Batch code', { exact: true }).fill(code);
    await dlg.getByLabel('Room', { exact: true }).selectOption({ label: 'Room 3 · 24 seats' });
    await dlg.getByLabel('Teacher', { exact: true }).selectOption({ label: 'Rahul Nair' });
    await dlg.getByLabel('Slot 1 day').selectOption('1');
    await dlg.getByLabel('Slot 1 start').selectOption('16:30');
    await dlg.getByRole('button', { name: 'Add slot' }).click();
    await dlg.getByLabel('Slot 2 day').selectOption('3');
    await dlg.getByLabel('Slot 2 start').selectOption('14:00');
    await expect(dlg.getByText(/sessions from .* no room or teacher clash/)).toBeVisible({ timeout: 15_000 });
    await dlg.getByRole('button', { name: 'Create batch' }).click();
    await expect(page.getByText(`${code} created · sessions generated`)).toBeVisible();
    const row = page.locator(`#batch-${code}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Wed 14:00');
    await expect(row).toContainText('Mon 16:30');
    await expect(row).toContainText('Planned');
    expect(Number(sql(`select count(*) from class_session cs join batch b on b.id = cs.batch_id where b.code = '${code}'`))).toBeGreaterThan(20);
  });

  test('timetable: room clash blocks, free room saves, one-click fix, substitute', async ({ page }) => {
    const today = todayIST();
    // A room clash next week: DA-C's Wednesday 14:00 session moved into Room 2, where UX-A meets.
    const clashDate = sql(`with s as (select cs.id from class_session cs join batch b on b.id = cs.batch_id
        where b.code = 'DA-C' and cs.start_time = '14:00' and cs.status = 'scheduled' and cs.date >= '${addDays(mondayOf(today), 7)}' order by cs.date limit 1)
      update class_session set room_id = (select r.id from room r join branch br on br.id = r.branch_id where r.name = 'Room 2' and br.code = 'TVM')
      where id in (select id from s) returning date`);
    // Make sure Nithin has approved leave for his next DM-A session (approved in the first test, or here when run alone).
    const leaveDate = nextNithinSessionDate();
    sql(`insert into leave (id, user_id, branch_id, date, type, reason, status, decided_at)
      select gen_random_uuid(), u.id, b.id, '${leaveDate}', 'sick', 'E2E fever', 'approved', now() from "user" u, branch b
      where u.email = 'nithin@exatech.test' and b.code = 'TVM'
        and not exists (select 1 from leave l where l.user_id = u.id and l.date = '${leaveDate}' and l.status = 'approved')`);

    await loginAs(page, 'branchadmin');
    await page.goto('/timetable');
    await expect(page.getByRole('heading', { name: 'Timetable' })).toBeVisible();

    // Substitute: Nithin is on leave → assign a free teacher.
    const subCard = page.getByTestId('substitute-card');
    await expect(subCard).toContainText('Nithin Raj on leave');
    const select = subCard.getByLabel('Assign substitute').first();
    const value = await select.locator('option', { hasText: 'Priya Varghese · free' }).first().getAttribute('value');
    await select.selectOption(value!);
    await expect(page.getByText('Substitute assigned · students and both teachers notified')).toBeVisible();
    await expect(subCard).toContainText('covered by');
    await expect(subCard).toContainText('Priya Varghese');

    // Navigate to next week: add a session — Lab 2 clashes with FS-B, Room 1 is free.
    await page.getByRole('button', { name: 'Next week' }).click();
    const nextMonday = addDays(mondayOf(today), 7);
    await expect(page.getByTestId(`cell-${nextMonday}-09:00`)).toBeVisible();
    await page.getByRole('button', { name: 'Add session' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add session' });
    await dlg.getByLabel('Batch', { exact: true }).selectOption({ label: 'DM-B' });
    await dlg.getByLabel('Day', { exact: true }).selectOption(nextMonday);
    await dlg.getByLabel('Start (2 h slot)').selectOption('09:00');
    await dlg.getByLabel('Room', { exact: true }).selectOption({ label: 'Lab 2 · 24' });
    await expect(dlg.getByTestId('session-issues')).toContainText('Lab 2 is taken by FS-B');
    await expect(dlg.getByRole('button', { name: 'Save session' })).toBeDisabled();
    await dlg.getByLabel('Room', { exact: true }).selectOption({ label: 'Room 1 · 30' });
    await expect(dlg.getByTestId('session-issues')).toContainText('No room or teacher clash');
    await dlg.getByRole('button', { name: 'Save session' }).click();
    await expect(page.getByText('Session added · students and teacher notified')).toBeVisible();
    const chip = page.getByTestId(`cell-${nextMonday}-09:00`).getByTestId('session-chip').filter({ hasText: 'DM-B' });
    await expect(chip).toBeVisible();

    // Remove it, then undo.
    await chip.click();
    const edit = page.getByRole('dialog', { name: /Edit session · DM-B/ });
    await edit.getByRole('button', { name: 'Remove session' }).click();
    await expect(page.getByText('Session removed · the batch was notified')).toBeVisible();
    await expect(chip).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Session restored')).toBeVisible();
    await expect(chip).toBeVisible();

    // One-click fix for the Room 2 double booking (in the week that has it).
    const weeks = weeksBetween(nextMonday, clashDate);
    for (let i = 0; i < weeks; i++) await page.getByRole('button', { name: 'Next week' }).click();
    const conflicts = page.getByTestId('conflicts-card');
    await expect(conflicts).toContainText('Room 2 double-booked 14:00');
    await conflicts.getByRole('button', { name: /^Move (UX-A|DA-C) to / }).click();
    await expect(page.getByText('Conflict fixed · the batch was notified')).toBeVisible();
    await expect(conflicts).not.toContainText('Room 2 double-booked');
  });

  test('students: search, profile panel, ID card PDFs, transfer batch', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/students');
    await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();

    // A scanned admission number (barcode) + Enter opens the profile directly.
    const search = page.getByLabel('Search students');
    await search.fill('TVM-DM-2027-00142');
    await search.press('Enter');
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Anjali Menon' })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');

    await search.fill('Rohan');
    const row = page.getByTestId('student-row').filter({ hasText: 'Rohan Menon' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('₹15,000 overdue');
    await row.getByRole('button', { name: 'Rohan Menon' }).click();
    const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Rohan Menon' }) });
    await expect(panel.getByText('Fee account')).toBeVisible();
    await expect(panel.getByText('Attendance · recent')).toBeVisible();
    await expect(panel.getByText('Timeline')).toBeVisible();

    // ID card PDFs (single card + batch sheet).
    const href = await panel.getByRole('link', { name: 'Print ID card' }).getAttribute('href');
    const card = await page.request.get(href!);
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toContain('application/pdf');
    const batches = await (await page.request.get('/api/academics/batches')).json();
    const fsb = batches.batches.find((b: { code: string }) => b.code === 'FS-B');
    const sheet = await page.request.get(`/api/documents/id-cards.pdf?batchId=${fsb.id}`);
    expect(sheet.status()).toBe(200);
    expect(sheet.headers()['content-type']).toContain('application/pdf');

    // Transfer FS-B → FS-C with a logged reason and the pro-rated adjustment preview.
    await panel.getByRole('button', { name: 'Transfer batch' }).click();
    const xfer = page.getByRole('dialog', { name: /Transfer Rohan Menon · from FS-B/ });
    const opt = await xfer.getByLabel('To batch', { exact: true }).locator('option', { hasText: 'FS-C' }).getAttribute('value');
    await xfer.getByLabel('To batch', { exact: true }).selectOption(opt!);
    await expect(xfer.getByText(/pro-rated adjustment/)).toBeVisible();
    await expect(xfer.getByRole('button', { name: 'Transfer' })).toBeDisabled();
    await xfer.getByLabel('Reason (logged)').fill('Schedule clash with college hours');
    await xfer.getByRole('button', { name: 'Transfer' }).click();
    await expect(page.getByText(/Transferred · adjustment/)).toBeVisible();
    await expect(panel.getByText(/FS-C · Full Stack Development/).first()).toBeVisible();
    await expect(panel.getByText(/Transferred FS-B → FS-C/)).toBeVisible();
  });

  test('marks publishing: review, publish and return', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/marks-publishing');
    const sprint = page.getByTestId('exam-row').filter({ hasText: 'Sprint 2 · React' });
    await expect(sprint).toContainText('Submitted');
    await sprint.getByRole('button', { name: 'Review grid' }).click();
    const drawer = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Sprint 2 · React' }) });
    await expect(drawer.getByText('Missing rows')).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText('Total / 100')).toBeVisible();
    await page.keyboard.press('Escape');
    await sprint.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Sprint 2 · React published · students & parents notified')).toBeVisible();
    await expect(sprint).toContainText('Visible to students & parents');

    const sql2 = page.getByTestId('exam-row').filter({ hasText: 'SQL practical' });
    await sql2.getByRole('button', { name: 'Return' }).click();
    const dlg = page.getByRole('dialog', { name: /Return · SQL practical/ });
    await dlg.getByLabel('Note for the teacher (required)').fill('Row 4 practical looks swapped — please recheck');
    await dlg.getByRole('button', { name: 'Return to teacher' }).click();
    await expect(page.getByText('Returned to the teacher with your note')).toBeVisible();
    await expect(sql2).toContainText('Returned');
    await expect(sql2).toContainText('Teacher still entering');
  });

  test('notes & material: change visibility', async ({ page }) => {
    await loginAs(page, 'branchadmin');
    await page.goto('/notes');
    for (const k of ['Items', 'Fee-gated', 'Students locked out', 'Downloads today']) await expect(page.getByText(k, { exact: true }).first()).toBeVisible();
    const row = page.getByTestId('material-row').filter({ hasText: 'Hooks cheat-sheet' });
    await expect(row).toContainText('Fee-gated');
    await row.getByRole('button', { name: 'Change visibility' }).click();
    const dlg = page.getByRole('dialog', { name: /Change visibility · Hooks cheat-sheet/ });
    await dlg.getByText('Always visible', { exact: true }).click();
    await dlg.getByRole('button', { name: 'Save visibility' }).click();
    await expect(page.getByText(/Visibility changed/)).toBeVisible();
    await expect(row).toContainText('Always visible');
  });

  test('announcement to a batch with acknowledgement appears in the student feed', async ({ page }) => {
    const title = `E2E notice ${Date.now().toString(36)}`;
    await loginAs(page, 'branchadmin');
    await page.goto('/announcements');
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByLabel('Message', { exact: true }).fill('Bring your laptop on Monday for the Google Ads lab.');
    await page.getByRole('button', { name: '+ Batch' }).click();
    await page.getByRole('option', { name: 'DM-A', exact: true }).click();
    await expect(page.getByText(/recipients · \d+ students/)).toBeVisible();
    await page.getByText('Acknowledgement required', { exact: true }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText(/Published to \d+ people/)).toBeVisible();
    const card = page.getByTestId('announcement-card').filter({ hasText: title });
    await expect(card).toContainText(/Ack 0 \/ \d+/);

    await loginAs(page, 'student');
    const feed = await (await page.request.get('/api/comms/announcements/feed')).json();
    const item = feed.items.find((i: { title: string }) => i.title === title);
    expect(item).toBeTruthy();
    expect(item.ackRequired).toBe(true);
    const ack = await page.request.post(`/api/comms/announcements/${item.id}/ack`, { headers: { Origin: test.info().project.use.baseURL ?? '' } });
    expect(ack.ok()).toBeTruthy();

    await loginAs(page, 'branchadmin');
    await page.goto('/announcements');
    await expect(page.getByTestId('announcement-card').filter({ hasText: title })).toContainText(/Ack 1 \/ \d+/);
  });
});
