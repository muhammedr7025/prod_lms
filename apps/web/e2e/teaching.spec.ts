import { execFileSync } from 'node:child_process';
import type { APIRequestContext } from '@playwright/test';
import { expect, loginAs, PERSONAS, test, type Persona } from './fixtures';
import { reseed } from './fixtures';

// Every spec starts from the known demo seed (specs mutate shared data).
test.beforeAll(() => reseed());

/**
 * Teaching (teacher's mobile app). Mutates data — reseed before a run:
 * `pnpm --filter @exatech/db seed`. Student submissions are created by the
 * Portal module in the product, so the grading test inserts them with SQL.
 */
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

const suffix = Date.now().toString(36).slice(-4).toUpperCase();

/** A separate signed-in API client (second persona alongside the teacher's browser session). */
async function apiAs(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, persona: Persona) {
  const base = test.info().project.use.baseURL ?? 'http://localhost:3300';
  const ctx = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
  const res = await ctx.post('/api/auth/exa/demo-login', { data: { email: PERSONAS[persona] } });
  expect(res.ok(), `demo login for ${persona}`).toBeTruthy();
  return ctx;
}

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('teaching (teacher mobile app)', () => {
  test('today shows my sessions, tiles and leave', async ({ page }) => {
    await loginAs(page, 'teacher');
    await page.goto('/teacher');
    await expect(page.getByText(/Good (morning|afternoon|evening), Nithin/)).toBeVisible();
    const dma = page.getByTestId('teacher-session').filter({ hasText: 'DM-A' });
    await expect(dma).toContainText('28 / 28 marked');
    await expect(dma.getByRole('button', { name: 'Edit attendance' })).toBeVisible();
    const dmb = page.getByTestId('teacher-session').filter({ hasText: 'DM-B' });
    await expect(dmb.getByRole('button', { name: 'Mark attendance' })).toBeVisible();
    await expect(dmb).toContainText('11 students');
    await expect(page.getByText('To grade', { exact: true })).toBeVisible();
    await expect(page.getByText('in Module 2 · Search')).toBeVisible();
    await expect(page.getByText("Taking a class that isn't on your timetable?")).toBeVisible();
  });

  test('mark DM-B attendance: tap cycles, offline queue, mark all present, submit → parent alert + attendance %, edit within 48 h', async ({ page, context }) => {
    const pctBefore = Number(sql(`select e.attendance_pct from enrollment e join student s on s.id = e.student_id join batch b on b.id = e.batch_id where s.name = 'Rohit Raj' and b.code = 'DM-B'`));
    await loginAs(page, 'teacher');
    await page.goto('/teacher');
    await page.getByTestId('teacher-session').filter({ hasText: 'DM-B' }).getByRole('button', { name: 'Mark attendance' }).click();
    await expect(page).toHaveURL(/\/teacher\/attendance\?session=/);
    await expect(page.getByText(/^DM-B · .* · 16:30$/)).toBeVisible();

    const row = (name: string) => page.getByTestId('att-row').filter({ hasText: name });
    const chip = (name: string) => row(name).getByTestId('att-chip');
    await row('Abhinav Nair').click();
    await expect(chip('Abhinav Nair')).toHaveText('P');
    await row('Abhinav Nair').click();
    await expect(chip('Abhinav Nair')).toHaveText('A');
    await expect(page.getByTestId('att-counters')).toContainText('1Absent');
    await expect(page.getByTestId('att-status')).toHaveText(/Saved \d\d:\d\d/);

    // Offline: taps queue locally and sync when back online.
    await context.setOffline(true);
    await row('Abhinav Nair').click();
    await expect(chip('Abhinav Nair')).toHaveText('L');
    await expect(page.getByTestId('att-status')).toHaveText('Offline · 1 change will sync');
    await context.setOffline(false);
    await expect(page.getByTestId('att-status')).toHaveText(/Saved \d\d:\d\d/);

    await page.getByRole('button', { name: 'Mark all present' }).click();
    await expect(page.getByTestId('att-chip').filter({ hasText: 'P' })).toHaveCount(11);
    await row('Rohit Raj').click(); // P → A
    await expect(chip('Rohit Raj')).toHaveText('A');
    await expect(page.getByTestId('att-status')).toHaveText(/Saved \d\d:\d\d/);
    await page.getByRole('button', { name: 'Submit attendance · 10 present · 1 absent' }).click();
    await expect(page.getByText('Attendance submitted · 10 present · 1 absent · 1 parent alert sent')).toBeVisible();
    await expect(page.getByTestId('att-status')).toHaveText(/Submitted \d\d:\d\d/);
    await expect(row('Rohit Raj')).toContainText('Absent · parent alerted');

    // Absence alert queued on WhatsApp for the parent.
    const outbox = (await (await page.request.get('/api/dev/outbox')).json()) as { channel: string; body: string }[];
    expect(outbox.some((m) => m.channel === 'whatsapp' && m.body.includes('Rohit Raj was marked absent today'))).toBeTruthy();
    // Cached attendance % recomputed.
    const pctAfter = Number(sql(`select e.attendance_pct from enrollment e join student s on s.id = e.student_id join batch b on b.id = e.batch_id where s.name = 'Rohit Raj' and b.code = 'DM-B'`));
    expect(pctAfter).toBeLessThan(pctBefore);

    // Edit within the 48 h window: A → L autosaves, is audited and survives a reload.
    await row('Rohit Raj').click();
    await expect(chip('Rohit Raj')).toHaveText('L');
    await expect(page.getByTestId('att-status')).toHaveText(/Submitted/);
    await expect.poll(() => sql(`select count(*) from audit_log where action = 'Attendance edited' and summary like 'Rohit Raj: absent → late%'`)).toBe('1');
    await page.reload();
    await expect(chip('Rohit Raj')).toHaveText('L');
    expect(Number(sql(`select e.attendance_pct from enrollment e join student s on s.id = e.student_id join batch b on b.id = e.batch_id where s.name = 'Rohit Raj' and b.code = 'DM-B'`))).toBe(pctBefore);
  });

  test('older submitted sessions are read-only after 48 h', async ({ page }) => {
    const old = sql(`select cs.id from class_session cs join batch b on b.id = cs.batch_id where b.code = 'DM-A' and cs.kind = 'timetabled' and cs.attendance_submitted_at < now() - interval '3 days' order by cs.date desc limit 1`);
    await loginAs(page, 'teacher');
    await page.goto(`/teacher/attendance?session=${old}`);
    await expect(page.getByText(/Changes now need a Branch Admin override with a reason/)).toBeVisible();
    await expect(page.getByTestId('att-row').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Mark all present' })).toHaveCount(0);
  });

  test('cover another class creates an ad-hoc session the Branch Admin sees', async ({ page, playwright }) => {
    await loginAs(page, 'teacher');
    await page.goto('/teacher');
    await page.getByText("Taking a class that isn't on your timetable?").click();
    const dlg = page.getByRole('dialog', { name: 'Cover another class' });
    await dlg.getByLabel('Batch (your branch)').selectOption({ label: 'FS-B' });
    await dlg.getByLabel('Session type').selectOption({ label: 'Substitute' });
    await dlg.getByLabel('Reason (required · logged)').fill(`E2E covering React ${suffix}`);
    await dlg.getByRole('button', { name: 'Load roster' }).click();
    await expect(page).toHaveURL(/\/teacher\/attendance\?session=/);
    await expect(page.getByText(/^FS-B · .* · ad-hoc substitute$/)).toBeVisible();
    await expect(page.getByText(/counts toward attendance once the Branch Admin acknowledges it/)).toBeVisible();
    await expect(page.getByTestId('att-row').first()).toBeVisible();
    await page.getByLabel('Subject taught').selectOption('Revision');
    await expect(page.getByText('Tagged Revision · syllabus log updated')).toBeVisible();
    await expect.poll(() => sql(`select subject_taught from class_session where adhoc_reason = 'E2E covering React ${suffix}'`)).toBe('Revision');

    const priya = await apiAs(playwright, 'branchadmin');
    const overview = (await (await priya.get('/api/academics/overview')).json()) as { sessions: { batchCode: string; status: string; adhocNote: string | null }[] };
    const adhoc = overview.sessions.find((x) => x.adhocNote?.includes(`E2E covering React ${suffix}`));
    expect(adhoc?.batchCode).toBe('FS-B');
    expect(adhoc?.status).toBe('adhoc_pending');
    await priya.dispose();
  });

  test('QR self check-in: student checks in with the teacher’s rotating code → marked P', async ({ page, playwright }) => {
    await loginAs(page, 'teacher');
    await page.goto('/teacher/attendance');
    await page.getByLabel('Batch · session').selectOption('__other');
    const dlg = page.getByRole('dialog', { name: 'Cover another class' });
    await dlg.getByLabel('Batch (your branch)').selectOption({ label: 'DM-A' });
    await dlg.getByLabel('Session type').selectOption({ label: 'Extra class' });
    await dlg.getByLabel('Reason (required · logged)').fill(`E2E QR extra ${suffix}`);
    await dlg.getByRole('button', { name: 'Load roster' }).click();
    await expect(page.getByText(/^DM-A · .* · ad-hoc extra class$/)).toBeVisible();

    await page.getByRole('button', { name: 'QR self check-in' }).click();
    const qr = page.getByRole('dialog', { name: 'Show this to the class' });
    await expect(qr.getByText(/Self check-in · expires in \d:\d\d/)).toBeVisible();
    await expect(qr.getByRole('img', { name: /QR code EXA-/ })).toBeVisible();
    const code = (await qr.getByTestId('qr-code').textContent())!.trim();
    expect(code).toMatch(/^EXA-[A-Z0-9]{4}-[A-Z0-9]{2}$/);
    await expect(qr).toContainText('0 present so far');

    const anjali = await apiAs(playwright, 'student');
    const res = await anjali.post('/api/portal/checkin', { data: { code } });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: 'P', alreadyMarked: false });
    const again = await anjali.post('/api/portal/checkin', { data: { code } });
    expect(await again.json()).toMatchObject({ alreadyMarked: true });
    const bad = await anjali.post('/api/portal/checkin', { data: { code: 'EXA-0000-00' } });
    expect(bad.status()).toBe(422);
    await anjali.dispose();

    await expect(qr).toContainText('1 present so far', { timeout: 15_000 });
    await qr.getByRole('button', { name: 'Done' }).click();
    const anjaliRow = page.getByTestId('att-row').filter({ hasText: 'Anjali Menon' });
    await expect(anjaliRow.getByTestId('att-chip')).toHaveText('P');
    await expect(anjaliRow).toContainText('Present · QR');
  });

  test('marks: over-max blocked, fill empty with 0, submit, recall', async ({ page }) => {
    await loginAs(page, 'teacher');
    await page.goto('/teacher/marks');
    await expect(page.getByLabel('Exam · batch')).toHaveValue(/.+/);
    await page.getByLabel('Exam · batch').selectOption({ label: 'Module 2 · Search · DM-A · draft' });
    await expect(page.getByText(/^DM-A · .* · 28 students$/)).toBeVisible();
    await expect(page.getByTestId('marks-hint')).toContainText('2 rows incomplete');

    const theory = page.getByLabel('Anjali Menon Theory');
    await theory.fill('75');
    await expect(theory).toHaveAttribute('aria-invalid', 'true');
    const anjaliRow = page.getByTestId('marks-row').filter({ hasText: 'Anjali Menon' });
    await expect(anjaliRow.getByTestId('marks-total')).toHaveText('!');
    await expect(page.getByTestId('marks-hint')).toContainText('1 over max');
    const submit = page.getByRole('button', { name: /Submit for publishing/ });
    await expect(submit).toBeDisabled();

    await theory.fill('52');
    await expect(theory).not.toHaveAttribute('aria-invalid', 'true');
    await expect(anjaliRow.getByTestId('marks-total')).toHaveText('…');
    await page.getByRole('button', { name: 'Fill empty with 0' }).click();
    await expect(page.getByText(/Filled 3 empty cells with 0/)).toBeVisible();
    await expect(anjaliRow.getByTestId('marks-total')).toHaveText('52');
    await expect(page.getByTestId('marks-hint')).toContainText('All 28 rows complete');
    expect(sql(`select m.value from mark m join exam_component c on c.id = m.exam_component_id join enrollment e on e.id = m.enrollment_id join student s on s.id = e.student_id where s.name = 'Anjali Menon' and c.name = 'Theory' and m.exam_id = (select id from exam where name = 'Module 2 · Search')`)).toBe('52');

    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId('exam-status')).toHaveText('Submitted · awaiting publish');
    await expect(page.getByLabel('Anjali Menon Theory')).toBeDisabled();
    expect(sql(`select status from exam where name = 'Module 2 · Search'`)).toBe('submitted');
    await page.getByRole('button', { name: 'Recall to draft' }).click();
    await expect(page.getByTestId('exam-status')).toHaveText('Draft');
    await expect(page.getByLabel('Anjali Menon Theory')).toBeEnabled();
  });

  test('create an exam with two components (duplicate name rejected)', async ({ page }) => {
    await loginAs(page, 'teacher');
    await page.goto('/teacher/marks');
    await page.getByRole('button', { name: 'New exam' }).click();
    const dlg = page.getByRole('dialog', { name: 'Create exam' });
    await dlg.getByLabel('Batch', { exact: true }).selectOption({ label: 'DM-B' });
    await dlg.getByLabel('Date', { exact: true }).fill(new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10));
    await dlg.getByLabel('Exam name').fill('Module 1 · Paid media');
    await expect(dlg.getByText('“Module 1 · Paid media” already exists for DM-B — pick another name')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Create exam' })).toBeDisabled();

    const name = `E2E quiz ${suffix}`;
    await dlg.getByLabel('Exam name').fill(name);
    await dlg.getByLabel('Component 1 name').fill('Quiz');
    await dlg.getByLabel('Component 1 max').fill('20');
    await dlg.getByLabel('Component 2 name').fill('Campaign brief');
    await dlg.getByLabel('Component 2 max').fill('80');
    await expect(dlg.getByText('Components · total 100')).toBeVisible();
    await expect(dlg.getByText(/Roster loads for the batch/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Create exam' }).click();
    await expect(page.getByLabel('Exam · batch')).toHaveValue(/.+/);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByTestId('marks-row')).toHaveCount(11);
    await expect(page.getByLabel('Abhinav Nair Campaign brief')).toBeVisible();
    expect(sql(`select count(*) from class_session where kind = 'exam' and topic = 'Exam · ${name}'`)).toBe('1');

    // The server re-checks duplicates.
    const batchId = sql(`select id from batch where code = 'DM-B'`);
    const dup = await page.request.post('/api/teaching/exams', { data: { batchId, date: '2030-01-01', name, components: [{ name: 'Total', max: 100 }] } });
    expect(dup.status()).toBe(409);
  });

  test('new assignment, then grade & release with the late penalty applied', async ({ page }) => {
    const title = `E2E brief ${suffix}`;
    await loginAs(page, 'teacher');
    await page.goto('/teacher/assignments');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'New assignment' });
    await dlg.getByLabel('Title').fill(title);
    await dlg.getByLabel(/^Batch \(/).selectOption({ label: 'DM-B' });
    await expect(dlg.getByText('Batch (11 students)')).toBeVisible();
    await dlg.getByLabel('Max marks').fill('40');
    await dlg.getByLabel('Late policy').selectOption({ label: '−10% per day' });
    await dlg.getByRole('button', { name: 'Publish to batch' }).click();
    await expect(page.getByText('Published to batch · students notified')).toBeVisible();
    const card = page.getByTestId('assignment-card').filter({ hasText: title });
    await expect(card).toContainText('0 / 11 submitted · 0 graded · −10% per day late');

    // Two submissions arrive (Portal module): one on time, one a day late.
    const asg = sql(`select id from assignment where title = '${title}'`);
    sql(`update assignment set due_at = now() - interval '2 days' where id = '${asg}'`);
    sql(`insert into submission (id, assignment_id, enrollment_id, submitted_at, text)
      select gen_random_uuid(), '${asg}', e.id, now() - interval '3 days', 'On time work' from enrollment e join student s on s.id = e.student_id join batch b on b.id = e.batch_id where b.code = 'DM-B' and s.name = 'Anoop Das'`);
    sql(`insert into submission (id, assignment_id, enrollment_id, submitted_at, text)
      select gen_random_uuid(), '${asg}', e.id, now() - interval '1 day', 'Late work' from enrollment e join student s on s.id = e.student_id join batch b on b.id = e.batch_id where b.code = 'DM-B' and s.name = 'Midhun Antony'`);
    await page.reload();
    await card.getByRole('button', { name: 'Grade 2' }).click();
    const grade = page.getByRole('dialog', { name: `Grade · ${title}` });
    await expect(grade.getByTestId('grade-row').filter({ hasText: 'Anoop Das' })).toContainText('on time');
    await expect(grade.getByTestId('grade-row').filter({ hasText: 'Midhun Antony' })).toContainText('late 1 day');
    await grade.getByLabel('Marks for Anoop Das').fill('45');
    await expect(grade.getByLabel('Marks for Anoop Das')).toHaveAttribute('aria-invalid', 'true');
    await expect(grade.getByRole('button', { name: 'Save & release 1' })).toBeDisabled();
    await grade.getByLabel('Marks for Anoop Das').fill('36');
    await grade.getByLabel('Marks for Midhun Antony').fill('30');
    await grade.getByLabel('Feedback for Midhun Antony').fill('Good, but late');
    await grade.getByRole('button', { name: 'Save & release 2' }).click();
    await expect(page.getByText('Released 2 grades · late penalty on 1')).toBeVisible();
    expect(sql(`select final_marks || '/' || released from submission sb join enrollment e on e.id = sb.enrollment_id join student s on s.id = e.student_id where sb.assignment_id = '${asg}' and s.name = 'Midhun Antony'`)).toBe('26/true');
    expect(sql(`select final_marks from submission sb join enrollment e on e.id = sb.enrollment_id join student s on s.id = e.student_id where sb.assignment_id = '${asg}' and s.name = 'Anoop Das'`)).toBe('36');
    await expect(card).toContainText('2 / 11 submitted · 2 graded');
    await expect(card.getByRole('button', { name: /^Grade/ })).toHaveCount(0);
  });

  test('upload a PDF, cycle visibility, remove and undo', async ({ page }) => {
    const title = `E2E handout ${suffix}`;
    await loginAs(page, 'teacher');
    await page.goto('/teacher/notes');
    await expect(page.getByText(/^DM-A · \d+ items · by syllabus module$/)).toBeVisible();
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Upload material' });
    await dlg.getByTestId('material-file').setInputFiles({ name: 'e2e-handout.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n') });
    await expect(dlg.getByText('Uploaded · tap to replace')).toBeVisible();
    await dlg.getByLabel('Module / topic').fill('Module 9 · E2E');
    await dlg.getByLabel('Title', { exact: true }).fill(title);
    await dlg.getByLabel('Visibility').selectOption({ label: 'Fee-gated' });
    await dlg.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByText('Uploaded · students notified')).toBeVisible();

    const row = page.getByTestId('material-row').filter({ hasText: title });
    await expect(row).toContainText('PDF');
    await expect(row.getByRole('button', { name: /Visibility Fee-gated/ })).toBeVisible();
    await row.getByRole('button', { name: /Visibility Fee-gated/ }).click();
    const sched = page.getByRole('dialog', { name: `Release · ${title}` });
    await sched.getByRole('button', { name: 'Schedule' }).click();
    await expect(row.getByRole('button', { name: /Visibility Scheduled · / })).toBeVisible();
    await row.getByRole('button', { name: /Visibility Scheduled/ }).click();
    await expect(row.getByRole('button', { name: /Visibility Always visible/ })).toBeVisible();
    await expect.poll(() => sql(`select visibility from material where title = '${title}'`)).toBe('always');
    expect(sql(`select count(*) from audit_log where action = 'Material visibility changed' and entity_label like '%${title}'`)).toBe('2');

    await row.getByRole('button', { name: `Remove ${title}` }).click();
    await expect(page.getByTestId('material-row').filter({ hasText: title })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText(`Restored · ${title}`)).toBeVisible();
    await expect(page.getByTestId('material-row').filter({ hasText: title })).toHaveCount(1);
    expect(sql(`select removed_at is null from material where title = '${title}'`)).toBe('t');
  });

  test('request leave shows the session that will need a substitute', async ({ page }) => {
    sql(`delete from leave where reason = 'E2E teaching leave'`);
    const date = sql(`select cs.date from class_session cs join "user" u on u.id = cs.teacher_user_id join batch b on b.id = cs.batch_id
      where u.email = 'nithin@exatech.test' and b.code = 'DM-A' and cs.kind = 'timetabled' and cs.status = 'scheduled'
        and cs.date > (now() at time zone 'Asia/Kolkata')::date
        and not exists (select 1 from leave l where l.user_id = u.id and l.date = cs.date and l.status in ('pending', 'approved'))
      order by cs.date limit 1`);
    await loginAs(page, 'teacher');
    await page.goto('/teacher');
    await page.getByRole('button', { name: 'Request leave' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request leave' });
    await dlg.getByLabel('Date').fill(date);
    await expect(dlg.getByTestId('leave-affected')).toContainText('DM-A 09:00 will need a substitute. On approval the substitute flow starts automatically.');
    await dlg.getByLabel('Type').selectOption({ label: 'Sick' });
    await dlg.getByLabel('Reason').fill('E2E teaching leave');
    await dlg.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Leave requested · pending Branch Admin approval')).toBeVisible();
    const leave = page.getByTestId('leave-row').filter({ hasText: 'E2E teaching leave' });
    await expect(leave).toContainText('Sick');
    await expect(leave).toContainText('DM-A 09:00 will need a substitute');
    await expect(leave).toContainText('Pending');
    expect(sql(`select count(*) from notification n join "user" u on u.id = n.user_id where u.email = 'priya@exatech.test' and n.category = 'leave' and n.title = 'Leave request · Nithin Raj'`)).not.toBe('0');
  });
});
