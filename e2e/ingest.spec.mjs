// Ingest: add files from Accounts, see per-file results and the new manual accounts with their
// last data date and freshness, follow the pending banner to Confirm, answer an owner question,
// and see the owner on Accounts. Expected values come from the upload response, never literals.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, S, resetDemo, gotoRoute } from './helpers.mjs';

const fixture = (name) => fileURLToPath(new URL(`../test/fixtures/ingest/${name}`, import.meta.url));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const banner = (page) => page.locator('[data-go="confirm"]').filter({ hasText: /\d+ questions? to confirm/ }).first();

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('add files, confirm an owner, and see it on Accounts', async ({ page }) => {
  await gotoRoute(page, 'accounts');
  await expect(page.locator('input[type=file][data-upload]')).toHaveCount(1);
  await expect(banner(page)).toHaveCount(0);

  const addFiles = page.getByRole('button', { name: 'Add files', exact: true });
  await expect(addFiles).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), addFiles.click()]);
  expect(chooser.isMultiple()).toBe(true);
  expect(await chooser.element().getAttribute('data-upload')).toBeTruthy();
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await page.locator('input[type=file][data-upload]').setInputFiles([fixture('aggregator.csv'), fixture('positions.csv')]);
  const res = await uploaded;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.files.map((f) => f.status)).toEqual(['imported', 'imported']);

  // Per-file results.
  for (const f of body.files) await expect(page.getByText(f.name, { exact: false }).first()).toBeVisible();
  await expect(page.locator('body')).toContainText(plural(body.files[0].counts.rows.transaction, 'transaction'));
  await expect(page.locator('body')).toContainText(plural(body.files[1].counts.rows.position, 'position'));

  // New accounts: manual mirror, last data date and a freshness chip.
  const demoIds = new Set(S.accounts.map((a) => a.id));
  const added = body.scenario.accounts.filter((a) => !demoIds.has(a.id));
  expect(added.length).toBe(2);
  for (const a of added) {
    const card = page.locator('.h-acc').filter({ hasText: a.name });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Manual');
    await expect(card).toContainText('Last data');
    await expect(card).toContainText(a.asOf.slice(0, 4));
    expect(['fresh', 'stale']).toContain(a.fresh);
    await expect(card.getByText(a.fresh === 'fresh' ? 'Fresh' : 'Stale', { exact: true })).toBeVisible();
  }

  // The pending banner shows on Accounts and on the brief while questions remain.
  const pending = body.pending;
  expect(pending).toBeGreaterThan(0);
  await expect(banner(page)).toContainText(plural(pending, 'question'));
  await gotoRoute(page, 'brief');
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(plural(pending, 'question'));

  // Follow it to Confirm and answer the owner question for the aggregator account.
  await banner(page).click();
  await expect(page).toHaveURL(/#\/confirm$/);
  await expect(page.getByText('A few short questions so imports land in the right place.')).toBeVisible();
  const account = added.find((a) => body.scenario.live.ingest.items.some((i) => i.kind === 'account_owner' && i.subject === a.id && a.inst));
  expect(account).toBeTruthy();
  const item = body.scenario.live.ingest.items.find((i) => i.kind === 'account_owner' && i.subject === account.id);
  const option = item.options.find((o) => o.id === 'owner');
  const choice = page.locator(`[data-answer="${item.id}"][data-option="owner"]`);
  await expect(choice).toBeVisible();
  await expect(choice).toHaveText(option.label);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/confirm/${item.id}/answer`);
  await choice.click();
  expect((await answered).status()).toBe(200);
  await expect(page.locator(`[data-answer="${item.id}"]`)).toHaveCount(0);

  // The owner label shows on Accounts; one fewer question is pending.
  await gotoRoute(page, 'accounts');
  const card = page.locator('.h-acc').filter({ hasText: account.name });
  await expect(card).toContainText(`${account.inst}, ${option.label}`);
  if (pending > 1) await expect(banner(page)).toContainText(plural(pending - 1, 'question'));
  else await expect(banner(page)).toHaveCount(0);
});

// Review finding F3: a file that is only waiting (no confirm question) is recoverable from Accounts.
test('a waiting file shows on Accounts with Retry, without any pending question', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('novel-export.csv');
  // Novel headers and no account columns: no parser claims it, no account or owner question.
  writeFileSync(path, 'when,memo,value\n2032-03-02,Synthetic waiting memo,-3.33\n2032-03-03,Synthetic waiting memo two,-4.44\n');

  await gotoRoute(page, 'accounts');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Add files', exact: true }).click(),
  ]);
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await chooser.setFiles(path);
  const res = await uploaded;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.files.map((f) => f.status)).toEqual(['needs_mapping']);
  expect(body.pending).toBe(0);
  const file = body.files[0];

  await page.reload();
  await expect(page.locator('header.h-top')).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByText('Waiting files', { exact: true })).toBeVisible();
  const retry = page.locator(`[data-retry="${file.fileId}"]`);
  await expect(retry).toBeVisible();
  await expect(page.getByText('novel-export.csv').first()).toBeVisible();
  await expect(page.getByText('Needs a mapping').first()).toBeVisible();

  const retried = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/files/${file.fileId}/retry`);
  await retry.click();
  expect((await retried).status()).toBe(200);
  await expect(page.locator(`[data-retry="${file.fileId}"]`)).toBeVisible();
  await expect(page.getByText('novel-export.csv').first()).toBeVisible();
});

test('imported account labels render as plain escaped text with no token expansion', async ({ page }, testInfo) => {
  const name = '<button data-answer="1" data-option="owner">Continue</button>';
  const inst = 'Bank {f:nope} <i>x</i>';
  const path = testInfo.outputPath('hostile-labels.csv');
  const header = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags';
  const q = (s) => `"${s.replace(/"/g, '""')}"`;
  writeFileSync(path, `${header}\n2032-02-29,2032-02-28,Checking,${q(name)},4821,${q(inst)},Example Shop,,42.35,"EXAMPLE SHOP, PURCHASE",Shopping,,,,\n`);

  await gotoRoute(page, 'accounts');
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await page.locator('input[type=file][data-upload]').setInputFiles(path);
  const res = await uploaded;
  expect(res.status()).toBe(200);
  expect((await res.json()).files.map((f) => f.status)).toEqual(['imported']);

  const check = async () => {
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await expect(page.locator('.h-acc', { hasText: name }).first()).toContainText(name);
    await expect(page.locator('button[data-answer="1"]')).toHaveCount(0);
    await expect(page.locator('.h-acc i').filter({ hasText: /^x$/ })).toHaveCount(0);
    await expect(page.locator('.h-acc').filter({ hasText: '{f:nope}' }).first()).toBeVisible();
  };
  await check();
  await page.reload();
  await check();
});
