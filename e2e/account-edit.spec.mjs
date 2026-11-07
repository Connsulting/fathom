// Account dialog edits: Owner and Kind selects, Add last 4, and Merge with... with a confirmation
// panel, each with Undo. Two synthetic manual accounts with no mask are written into the served
// store after the demo reset, the same way account-dialog.spec.mjs seeds its duplicate pair.

import { resolve } from 'node:path';
import { test, expect, resetDemo, gotoRoute, recDialog, REMOTE } from './helpers.mjs';
import { openDb, DB_FILE } from '../src/store/db.mjs';

const A = 'e2e_reserve';
const B = 'e2e_spare';
const A_NAME = 'Reserve savings';
const B_NAME = 'Spare cash';

async function seed(request) {
  await resetDemo(request);
  const db = openDb(resolve(process.env.E2E_DATA || '.e2e-data', DB_FILE));
  try {
    const acct = db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, sort)
      VALUES (?, 'Sample Bank', NULL, ?, 'You', 'cash', 'manual', '', ?)`);
    acct.run(A, A_NAME, 900);
    acct.run(B, B_NAME, 901);
    const txn = db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)');
    txn.run(A, '2026-10-03', -42.5, 'Synthetic grocery');
    txn.run(A, '2026-10-12', 300, 'Synthetic transfer in');
    txn.run(B, '2026-10-05', -18, 'Synthetic coffee');
    txn.run(B, '2026-10-20', -64.25, 'Synthetic utility');
    const bal = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)');
    bal.run(A, '2026-10-31', 2500);
    bal.run(B, '2026-10-31', 700);
  } finally { db.close(); }
}

const accountRow = (page, id) => page.locator(`.h-acc[data-account="${id}"]`);
const scenarioAccount = async (request, id) => (await (await request.get('/api/scenario')).json()).accounts.find((a) => a.id === id);
const posted = (page, path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST');

async function openFromAccounts(page, id) {
  await gotoRoute(page, 'accounts');
  await accountRow(page, id).locator('.h-acc-m').click();
  await expect(recDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/account/${id}$`));
}

async function noSideScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function changeOwner(page, request) {
  await seed(request);
  await openFromAccounts(page, A);
  const dlg = recDialog(page);
  const owner = dlg.locator('.h-ad-facts select[data-ad-owner]');
  await expect(owner).toHaveValue('owner');
  const saved = posted(page, `/api/accounts/${A}/owner`);
  await owner.selectOption('spouse');
  expect((await saved).status()).toBe(200);
  await expect(owner).toHaveValue('spouse');
  await expect(accountRow(page, A).locator('.h-acc-n span')).toContainText('Your spouse');
  expect((await scenarioAccount(request, A)).owner).toBe('Your spouse');

  const undo = dlg.locator('.h-ad-undo [data-ad="undo"]');
  await expect(undo).toBeVisible();
  const undone = posted(page, `/api/accounts/${A}/owner`);
  await undo.click();
  expect((await undone).status()).toBe(200);
  await expect(owner).toHaveValue('owner');
  await expect(accountRow(page, A).locator('.h-acc-n span')).toHaveText('Sample Bank, You');
  expect((await scenarioAccount(request, A)).owner).toBe('You');
}

async function changeKind(page, request) {
  await seed(request);
  await openFromAccounts(page, A);
  const dlg = recDialog(page);
  const kind = dlg.locator('.h-ad-facts select[data-ad-kind]');
  await expect(kind).toHaveValue('cash');
  const saved = posted(page, `/api/accounts/${A}/kind`);
  await kind.selectOption('retirement');
  expect((await saved).status()).toBe(200);
  await expect(kind).toHaveValue('retirement');
  expect((await scenarioAccount(request, A)).kind).toBe('retirement');
  await expect(accountRow(page, A)).toHaveCount(1);

  const undone = posted(page, `/api/accounts/${A}/kind`);
  await dlg.locator('.h-ad-undo [data-ad="undo"]').click();
  expect((await undone).status()).toBe(200);
  await expect(kind).toHaveValue('cash');
  expect((await scenarioAccount(request, A)).kind).toBe('cash');
}

async function addLastFour(page, request) {
  await seed(request);
  await openFromAccounts(page, A);
  const dlg = recDialog(page);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(A_NAME);
  await dlg.locator('[data-ad="mask-open"]').click();
  const input = dlg.locator('input[data-ad-mask]');
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('inputmode', 'numeric');
  await expect(input).toHaveAttribute('maxlength', '4');
  await input.fill('12a4');
  await dlg.locator('[data-ad="mask-save"]').click();
  await expect(dlg.locator('.h-ad-err')).toBeVisible();
  expect((await scenarioAccount(request, A)).mask).toBeNull();
  await noSideScroll(page);

  await input.fill('1234');
  const saved = posted(page, `/api/accounts/${A}/mask`);
  await dlg.locator('[data-ad="mask-save"]').click();
  expect((await saved).status()).toBe(200);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(`${A_NAME} ending 1234`);
  await expect(dlg.locator('[data-ad="mask-open"]')).toHaveCount(0);
  await expect(accountRow(page, A).locator('.h-acc-name')).toHaveText(`${A_NAME} ending 1234`);
  await gotoRoute(page, 'accounts');
  await expect(accountRow(page, A).locator('.h-acc-name')).toHaveText(`${A_NAME} ending 1234`);
}

async function mergeWith(page, request) {
  await seed(request);
  await openFromAccounts(page, A);
  const dlg = recDialog(page);

  // Cancel first: nothing changes.
  await dlg.locator('[data-ad="merge-open"]').click();
  await dlg.locator(`[data-merge-with="${B}"]`).click();
  const panel = dlg.locator('.h-ad-merge-confirm');
  await expect(panel).toBeVisible();
  await noSideScroll(page);
  await dlg.locator('[data-ad="merge-cancel"]').click();
  await expect(panel).toHaveCount(0);
  expect(await scenarioAccount(request, B)).toBeTruthy();

  await dlg.locator('[data-ad="merge-open"]').click();
  await expect(dlg.locator(`[data-merge-with="${A}"]`)).toHaveCount(0);
  await dlg.locator(`[data-merge-with="${B}"]`).click();
  await expect(panel).toContainText(A_NAME);
  await expect(panel).toContainText(B_NAME);
  await expect(panel).toContainText(/transaction/i);
  const merged = posted(page, `/api/accounts/${A}/merge`);
  await dlg.locator('[data-ad="merge-confirm"]').click();
  const res = await merged;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.survivorId).toBe(A);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(A_NAME);
  await expect(page).toHaveURL(new RegExp(`#/account/${A}$`));
  await expect(accountRow(page, B)).toHaveCount(0);
  expect(await scenarioAccount(request, B)).toBeFalsy();

  const undone = posted(page, `/api/confirm/${body.itemId}/reopen`);
  await dlg.locator('.h-ad-undo [data-ad="undo"]').click();
  expect((await undone).status()).toBe(200);
  await expect(accountRow(page, B)).toHaveCount(1);
  await expect(accountRow(page, A)).toHaveCount(1);
  expect(await scenarioAccount(request, B)).toBeTruthy();
  expect(await scenarioAccount(request, A)).toBeTruthy();
}

test.describe('account dialog edits', { tag: '@ade-ac' }, () => {
  test.skip(REMOTE, 'requires a local synthetic store');

  test('change Owner, see the meta line and the Accounts row update, then Undo', async ({ page, request }) => {
    await changeOwner(page, request);
  });

  test('change Kind, then Undo', async ({ page, request }) => {
    await changeKind(page, request);
  });

  test('Add last 4 refuses bad input and the label and row say ending 1234', async ({ page, request }) => {
    await addLastFour(page, request);
  });

  test('Merge with... names the survivor and what moves, merges, and Undo brings both back', async ({ page, request }) => {
    await mergeWith(page, request);
  });
});

test.describe('account dialog edits on a phone', { tag: ['@mobile', '@mobile-only', '@ade-ac'] }, () => {
  test.skip(REMOTE, 'requires a local synthetic store');

  test('change Owner at phone width, then Undo', async ({ page, request }) => {
    await changeOwner(page, request);
    await noSideScroll(page);
  });

  test('change Kind at phone width, then Undo', async ({ page, request }) => {
    await changeKind(page, request);
    await noSideScroll(page);
  });

  test('Add last 4 at phone width', async ({ page, request }) => {
    await addLastFour(page, request);
    await noSideScroll(page);
  });

  test('Merge with... at phone width, then Undo', async ({ page, request }) => {
    await mergeWith(page, request);
    await noSideScroll(page);
  });
});
