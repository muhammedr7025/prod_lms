import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, loginAs, reseed, test } from './fixtures';

// Admin edits a student's details: personal data, parent / guardian, STED / BECIL registration.
// Mutates data → reseeds first. Rohan Menon (FS-B) shares his parent, Suresh Menon, with Anjali.
test.beforeAll(() => reseed());
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/exatech';
function sql(query: string): string {
  return execFileSync('psql', [DB, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim().split('\n')[0]!.trim();
}

async function api(page: Page, method: 'GET' | 'PUT', url: string, data?: unknown) {
  const base = test.info().project.use.baseURL!;
  return method === 'GET' ? page.request.get(`${base}${url}`) : page.request.put(`${base}${url}`, { data, headers: { Origin: base } });
}

async function openEditor(page: Page, who = 'Rohan Menon') {
  await page.goto('/students');
  await page.getByLabel('Search students').fill(who.split(' ')[0]!);
  await page.getByTestId('student-row').filter({ hasText: who }).getByRole('button', { name: who }).click();
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dlg = page.getByRole('dialog', { name: `Edit ${who}` });
  await expect(dlg).toBeVisible();
  return dlg;
}

const rohanId = () => sql(`select id from student where admission_no = 'TVM-FS-2027-00098'`); // by number: the name changes during the spec

test('Branch Admin edits a student: fields are prefilled, bad values are explained inline and nothing is saved', async ({ page }) => {
  await loginAs(page, 'branchadmin');
  const dlg = await openEditor(page);
  await expect(dlg.getByLabel('Full name')).toHaveValue('Rohan Menon');
  await expect(dlg.getByLabel('Parent / guardian name')).toHaveValue('Suresh Menon');
  await expect(dlg).toContainText('Shared with 1 other student');

  await dlg.getByLabel('Email', { exact: true }).fill('not-an-email');
  await dlg.getByLabel('Mobile', { exact: true }).fill('12345');
  await dlg.getByLabel('Parent email').fill('also bad');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(dlg.getByText('Enter a valid email address').first()).toBeVisible();
  // Server-side validation reports every problem at once; the dialog stays open and nothing is saved.
  await expect(dlg.getByText('Enter a valid 10-digit mobile number').first()).toBeVisible();
  await expect(dlg.getByText('Fix the highlighted fields — nothing was saved.')).toBeVisible();
  await expect(dlg).toBeVisible();
  expect(sql(`select coalesce(email, '') from student where id = '${rohanId()}'`)).toBe(''); // still empty: nothing was saved
  expect(sql(`select count(*) from audit_log where action = 'Student details edited'`)).toBe('0');

  await dlg.getByLabel('Email', { exact: true }).fill('rohan.menon@example.test');
  await dlg.getByLabel('Parent email').fill('suresh.menon@example.test');
  await dlg.getByLabel('Mobile', { exact: true }).fill('12345');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(dlg.getByText('Enter a valid 10-digit mobile number')).toBeVisible();
});

test('a valid edit saves personal data, the parent and the STED registration, and is audited', async ({ page }) => {
  await loginAs(page, 'branchadmin');
  const dlg = await openEditor(page);
  await dlg.getByLabel('Full name').fill('Rohan R Menon');
  await dlg.getByLabel('Date of birth').fill('2004-10-04');
  await dlg.getByLabel('Gender').selectOption('male');
  await dlg.getByLabel('Address').fill('TC 12/345, Pattom, Thiruvananthapuram');
  await dlg.getByLabel('Relationship').fill('Father');
  await dlg.getByLabel('Parent mobile').fill('9000000001');
  await dlg.getByLabel('Body', { exact: true }).selectOption('STED');
  await dlg.getByLabel('Registration no.').fill('41999 251392');
  await dlg.getByLabel('Body fee ₹').fill('1000');
  await dlg.getByLabel('Fee submitted on').fill('2026-10-20');
  await dlg.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('Student details saved')).toBeVisible();
  await expect(page.getByText(/also the parent of 1 other student/)).toBeVisible();
  await expect(dlg).toHaveCount(0);

  const id = rohanId();
  expect(sql(`select name || '|' || dob || '|' || gender || '|' || address from student where id = '${id}'`)).toBe('Rohan R Menon|2004-10-04|male|TC 12/345, Pattom, Thiruvananthapuram');
  expect(sql(`select u.name from student s join "user" u on u.id = s.user_id where s.id = '${id}'`)).toBe('Rohan R Menon'); // sign-in account follows the name
  expect(sql(`select awarding_body || '|' || body_reg_no || '|' || body_fee || '|' || body_fee_submitted_on from enrollment where student_id = '${id}' and status = 'active'`)).toBe('STED|41999 251392|100000|2026-10-20');
  // The parent's sign-in number moved with the contact number.
  expect(sql(`select g.phone || '|' || u.phone_number from student_guardian sg join guardian g on g.id = sg.guardian_id join "user" u on u.id = g.user_id where sg.student_id = '${id}'`)).toBe('+919000000001|+919000000001');
  const audit = sql(`select summary from audit_log where action = 'Student details edited' order by at desc limit 1`);
  expect(audit).toContain('Name: Rohan Menon → Rohan R Menon');
  expect(audit).toContain('Registration no.: — → 41999 251392');
  expect(audit).not.toContain('9000000001'); // phone numbers are masked in the log

  // The profile card shows the new values.
  await page.getByRole('button', { name: 'Edit details' }).waitFor();
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Rohan R Menon' }) });
  await expect(panel.getByText('41999 251392')).toBeVisible();
  await expect(panel.getByText('Certification')).toBeVisible();
});

test('a mobile number that already signs in someone else is kept as contact only, with a clear notice', async ({ page }) => {
  const anjaliPhone = sql(`select phone_number from "user" where email = 'anjali.menon@example.test'`);
  const before = sql(`select u.phone_number from student s join "user" u on u.id = s.user_id where s.name = 'Rohan R Menon'`);
  await loginAs(page, 'branchadmin');
  const dlg = await openEditor(page, 'Rohan R Menon');
  await dlg.getByLabel('Mobile', { exact: true }).fill(anjaliPhone.replace('+91', ''));
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Student details saved')).toBeVisible();
  await expect(page.getByText(/already signs in Anjali Menon/)).toBeVisible();
  expect(sql(`select phone from student where name = 'Rohan R Menon'`)).toBe(anjaliPhone); // contact saved
  expect(sql(`select u.phone_number from student s join "user" u on u.id = s.user_id where s.name = 'Rohan R Menon'`)).toBe(before); // sign-in untouched
});

test('admission numbers stay unique', async ({ page }) => {
  await loginAs(page, 'branchadmin');
  const res = await api(page, 'PUT', `/api/academics/students/${rohanId()}`, { name: 'Rohan R Menon', admissionNo: 'TVM-DM-2027-00142', phone: null, email: null, dob: null, gender: null, address: null });
  expect(res.status()).toBe(422);
  const body = (await res.json()) as { error: { fields: Record<string, string> } };
  expect(body.error.fields.admissionNo).toContain('already belongs to Anjali Menon');
});

test('only people who manage students can edit, and only inside their branch', async ({ page }) => {
  const kochi = sql(`select s.id from student s join branch b on b.id = s.branch_id where b.code = 'EKM' limit 1`);
  const payload = { name: 'Edited Elsewhere', admissionNo: null, phone: null, email: null, dob: null, gender: null, address: null };

  await loginAs(page, 'finance'); // can read students, cannot manage them
  expect((await api(page, 'PUT', `/api/academics/students/${rohanId()}`, payload)).status()).toBe(403);
  await loginAs(page, 'teacher');
  expect((await api(page, 'PUT', `/api/academics/students/${rohanId()}`, payload)).status()).toBe(403);

  await loginAs(page, 'branchadmin'); // Trivandrum only — a Kochi student is out of scope
  const res = await api(page, 'PUT', `/api/academics/students/${kochi}`, payload);
  expect([403, 404]).toContain(res.status());
  expect(sql(`select name from student where id = '${kochi}'`)).not.toBe('Edited Elsewhere');

  await loginAs(page, 'superadmin'); // the Super Admin edits across branches
  const ok = await api(page, 'PUT', `/api/academics/students/${kochi}`, { ...payload, name: 'Kochi Student Edited' });
  expect(ok.status()).toBe(200);
  expect(sql(`select name from student where id = '${kochi}'`)).toBe('Kochi Student Edited');
});
