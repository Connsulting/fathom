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

// D9: names that come from uploads render as plain text wherever they show: the onboarding and
// Accounts result lists and the Confirm card that names the file. No markup and no token expansion.
// The server keeps only the base name, so the expected literal is the name it reports back.
const HOSTILE = ['<b>x</b>{f:nope}.csv', '<b>x<b>{f:nope}.csv'];
const hostileCsv = (number) => {
  const header = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags';
  return Buffer.from(`${header}\n2032-02-29,,Checking,Synthetic hostile ${number},${number},Example Bank,Example Shop,,42.35,Synthetic purchase,Shopping,,,,\n`);
};
const hostileFiles = (seed) => HOSTILE.map((name, i) => ({ name, mimeType: 'text/csv', buffer: hostileCsv(`555000${seed}${i}${seed}${i}`) }));

// The demo store has finished onboarding; serve every scenario as a fresh one on step 1.
async function forceOnboarding(page) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: 1 });
    return route.fulfill({ response: res, json: body });
  });
}

async function uploadHostile(page, seed) {
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await page.locator('input[type=file][data-upload]').setInputFiles(hostileFiles(seed));
  const res = await uploaded;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.files.map((f) => f.status)).toEqual(['imported', 'imported']);
  const names = body.files.map((f) => f.name);
  for (const n of names) expect(n).toContain('{f:nope}');
  return names;
}

async function expectLiteral(scope, names) {
  for (const n of names) await expect(scope.getByText(n, { exact: true }).first()).toBeVisible();
}

test('upload file names render literally on onboarding, Accounts and Confirm', async ({ page }) => {
  await forceOnboarding(page);
  await page.goto('/#/onboarding/1');
  await expect(page.getByRole('heading', { level: 1, name: 'Dump everything in' })).toBeVisible();
  const onboardingNames = await uploadHostile(page, 1);
  const onboardingList = page.locator('.h-ing-files');
  await expectLiteral(onboardingList, onboardingNames);
  await expect(page.locator('.h-ing-files b, .h-files b')).toHaveCount(0);

  // Back to the real (finished onboarding) scenario: reload to drop the forced one, then route.
  await page.unroute('**/api/**');
  await page.reload();
  await gotoRoute(page, 'accounts');
  const accountNames = await uploadHostile(page, 2);
  await expectLiteral(page.locator('.h-ing-files').first(), accountNames);
  await expect(page.locator('.h-ing-files b')).toHaveCount(0);

  await gotoRoute(page, 'confirm');
  const cards = page.locator('.h-cfs');
  await expectLiteral(cards, [...new Set([...onboardingNames, ...accountNames])]);
  await expect(page.locator('.h-cfs b, .h-ing-files b')).toHaveCount(0);
});

// D1: a file past the parse limits shows as "Too large to read" in the Accounts results.
test('a file past the parse limits is labeled Too large to read', async ({ page }) => {
  await gotoRoute(page, 'accounts');
  const cols = Array.from({ length: 600 }, (_, i) => `c${i}`);
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await page.locator('input[type=file][data-upload]').setInputFiles({ name: 'wide-header.csv', mimeType: 'text/csv', buffer: Buffer.from(`${cols.join(',')}\n${cols.map(() => 'x').join(',')}\n`) });
  const res = await uploaded;
  expect(res.status()).toBe(200);
  expect((await res.json()).files.map((f) => f.status)).toEqual(['too_large']);
  const row = page.locator('.h-ing-files li').filter({ hasText: 'wide-header.csv' });
  await expect(row).toContainText('Too large to read');
});
