// Email screen (#/email): transport status with the masked recipient, the sandboxed brief preview,
// Send test email and Send brief now (history rows and a dev outbox file), and the jobs table
// with Run now. Expected copy comes from the API and demo/scenario.mjs; no amounts are hard-coded.
//
// Selectors and names this spec relies on (the Email screen must provide them):
//   [data-email-status]                 transport status block: transport name and masked recipient
//   iframe[title="Brief preview"]       preview iframe, sandbox="" and srcdoc; its body shows the
//                                       brief subject and the verdict headline
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
import { fileURLToPath } from 'node:url';
import { test, expect, resetDemo, gotoRoute, attentionHeadline, REMOTE } from './helpers.mjs';

// The main e2e server's data directory (playwright.config.mjs runs it on .e2e-data at the repo root).
const OUTBOX = join(fileURLToPath(new URL('..', import.meta.url)), '.e2e-data', 'outbox');
const MASKED = 'o***@e***.invalid';

const outboxFiles = () => (existsSync(OUTBOX) ? readdirSync(OUTBOX).filter((f) => f.endsWith('.json')) : []);
const outboxSubject = (f) => JSON.parse(readFileSync(join(OUTBOX, f), 'utf8')).subject;
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

test('the preview iframe shows the brief subject and verdict', async ({ page, request }) => {
  const api = await (await request.get('/api/email')).json();
  await gotoRoute(page, 'email');
  const frameEl = page.locator('iframe[title="Brief preview"]');
  await expect(frameEl).toBeVisible();
  await expect(frameEl).toHaveAttribute('sandbox', '');
  const body = page.frameLocator('iframe[title="Brief preview"]').locator('body');
  await expect(body).toContainText(api.preview.subject);
  await expect(body).toContainText(attentionHeadline());
});

test('Send test email adds a Test history row and writes a dev outbox file with that subject', async ({ page }) => {
  test.skip(REMOTE, 'reads the local e2e data directory');
  const before = new Set(outboxFiles());
  await gotoRoute(page, 'email');
  await page.getByRole('button', { name: 'Send test email', exact: true }).click();
  const first = history(page).first();
  await expect(first).toContainText('Test');
  await expect(first).toContainText('Sent');
  await expect.poll(() => outboxFiles().filter((f) => !before.has(f)).length).toBeGreaterThan(0);
  const subjects = outboxFiles().filter((f) => !before.has(f)).map(outboxSubject);
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
