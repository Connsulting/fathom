// Email screen (#/email): transport status with the masked recipient, the sandboxed brief preview,
// Send test email and Send brief now (history rows and a dev outbox file), and the jobs table
// with Run now. Expected copy comes from the API and demo/scenario.mjs; no amounts are hard-coded.
//
// Selectors and names this spec relies on (the Email screen must provide them):
//   [data-email-status]                 transport status block: transport name and masked recipient
//   [data-email-subject]                the brief subject, outside the preview frame
//   iframe[title="Brief preview"]       preview iframe, sandbox="" and srcdoc; its body shows the
//                                       verdict headline
//   button "Send test email"            sends a test email
//   button "Send brief now"             sends the brief
//   [data-email-history] tbody tr       send history rows, newest first; each row shows the kind
//                                       ("Test", "Brief" or "Alert"), the subject and the status ("Sent"
//                                       or "Failed")
//   [data-job="<job id>"]               one jobs table row per job, e.g. [data-job="freshness"]; it
//                                       carries data-last-run="<last job_runs id>" ("" before any run)
//   [data-job-last]                     the last run cell inside a job row
//   button "Run now"                    inside each job row

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test, expect, resetDemo, gotoRoute, attentionHeadline, plain, S, REMOTE } from './helpers.mjs';
import { householdRootDir, localDataDir } from './local-store.mjs';

const JOB_IDS = ['plan', 'brief-email', 'deadline-alerts', 'freshness', 'trash-purge', 'confirm-guess', 'simplefin-sync'];

// The dev outbox of the main e2e server's household (its root under the E2E_DATA directory).
const OUTBOX = async () => join(await householdRootDir(localDataDir()), 'outbox');
const MASKED = 'o***@e***.invalid';

const outboxFiles = async () => (existsSync(await OUTBOX()) ? readdirSync(await OUTBOX()).filter((f) => f.endsWith('.json')) : []);
const outboxSubject = async (f) => JSON.parse(readFileSync(join(await OUTBOX(), f), 'utf8')).subject;
const history = (page) => page.locator('[data-email-history] tbody tr');

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('the Email screen shows the transport status and the masked recipient', async ({ page, request }) => {
  const api = await (await request.get('/api/email')).json();
  await gotoRoute(page, 'email');
  const status = page.locator('[data-email-status]');
  await expect(status).toBeVisible();
  await expect(status).toContainText(api.status.transport);
  await expect(status).toContainText(MASKED);
  await expect(page.locator('body')).not.toContainText('owner@example.invalid');
});

test('the preview shows the brief subject outside the frame and the verdict inside it', async ({ page, request }) => {
  const api = await (await request.get('/api/email')).json();
  await gotoRoute(page, 'email');
  const frameEl = page.locator('iframe[title="Brief preview"]');
  await expect(frameEl).toBeVisible();
  await expect(frameEl).toHaveAttribute('sandbox', '');
  await expect(page.locator('[data-email-subject]')).toContainText(api.preview.subject);
  const body = page.frameLocator('iframe[title="Brief preview"]').locator('body');
  await expect(body).toContainText(attentionHeadline());
});

test('the demo shows one jobs list', async ({ page }) => {
  const jobs = S.engine.jobs;
  assert.deepEqual(jobs.map((j) => j.id), JOB_IDS);
  await gotoRoute(page, 'engine');
  const rows = page.locator('.h-jt .h-jt-r');
  await expect(rows).toHaveCount(JOB_IDS.length);
  for (let i = 0; i < jobs.length; i++) {
    await expect(rows.nth(i).locator('.h-jt-n b')).toHaveText(plain(jobs[i].name));
  }
  const table = page.locator('.h-jt');
  for (const old of ['Account mirror sync', 'Deadline sweep', 'Life event and income triggers', 'Advisor packet']) {
    await expect(table).not.toContainText(old);
  }

  await gotoRoute(page, 'email');
  const emailRows = page.locator('[data-job]');
  await expect(emailRows.first()).toBeVisible();
  const ids = await emailRows.evaluateAll((els) => els.map((el) => el.getAttribute('data-job')));
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(JOB_IDS).toContain(id);
    const job = jobs.find((j) => j.id === id);
    await expect(page.locator(`[data-job="${id}"]`)).toContainText(plain(job.name));
  }
});

test('Send test email adds a Test history row and writes a dev outbox file with that subject', async ({ page }) => {
  test.skip(REMOTE, 'reads the local e2e data directory');
  const before = new Set(await outboxFiles());
  await gotoRoute(page, 'email');
  await page.getByRole('button', { name: 'Send test email', exact: true }).click();
  const first = history(page).first();
  await expect(first).toContainText('Test');
  await expect(first).toContainText('Sent');
  await expect.poll(async () => (await outboxFiles()).filter((f) => !before.has(f)).length).toBeGreaterThan(0);
  const subjects = (await outboxFiles()).filter((f) => !before.has(f)).map(outboxSubject);
  const rowText = await first.innerText();
  expect(subjects.some((s) => s && rowText.includes(s)), `a new outbox file's subject is in the row: ${subjects.join(' | ')}`).toBe(true);
});

test('Send brief now adds a Brief history row', async ({ page }) => {
  await gotoRoute(page, 'email');
  await page.getByRole('button', { name: 'Send brief now', exact: true }).click();
  const first = history(page).first();
  await expect(first).toContainText('Brief');
  await expect(first).toContainText('Sent');
});

test('the jobs table lists the freshness job; Run now updates its last run', async ({ page }) => {
  await gotoRoute(page, 'email');
  const row = page.locator('[data-job="freshness"]');
  await expect(row).toBeVisible();
  const runNow = row.getByRole('button', { name: 'Run now', exact: true });
  await expect(runNow).toBeVisible();
  const before = (await row.getAttribute('data-last-run')) ?? '';
  await runNow.click();
  await expect.poll(async () => (await page.locator('[data-job="freshness"]').getAttribute('data-last-run')) ?? '').not.toBe(before);
  expect(await page.locator('[data-job="freshness"]').getAttribute('data-last-run')).not.toBe('');
  await expect(page.locator('[data-job="freshness"] [data-job-last]')).not.toBeEmpty();
});
