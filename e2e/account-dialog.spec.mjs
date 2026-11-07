// Account dialog: click an account row (Money, Accounts, the quick switcher) to open it in the
// same dialog style as a recommendation. Rename in place, sources and freshness, balance, and a
// read-only transaction list with a text filter and a date range. #/account/<id> survives reload.

import { resolve } from 'node:path';
import { test, expect, resetDemo, gotoRoute, recDialog, closeDialogWithX, REMOTE } from './helpers.mjs';
import { openDb, setSetting, DB_FILE } from '../src/store/db.mjs';
import { dataKeyFor } from '../src/ingest/simplefin.mjs';
import { seedDuplicate as seedDuplicateRows } from '../test/helpers/account-merge.mjs';
import { refreshMergedAccounts } from '../src/ingest/account-merge.mjs';

const ID = 'a_biz';
// The demo's business checking account is connected with a synthetic four digit mask. Its label is
// its name; the mask is its own field in the dialog.
const BIZ_LABEL = 'Business checking';

// Every transaction of the account, newest first, read through the paged API.
async function firstTransactions(request) {
  const items = [];
  let cursor = '';
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const res = await request.get(`/api/accounts/${ID}/transactions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.ok()).toBeTruthy();
    const page = await res.json();
    items.push(...page.items);
    total = page.total;
    cursor = page.next;
    if (!cursor) break;
  }
  return { items, total };
}

async function openFromAccounts(page) {
  await gotoRoute(page, 'accounts');
  await page.locator(`[data-account="${ID}"] .h-acc-m`).click();
  await expect(recDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/account/${ID}$`));
}

test.describe('account dialog', { tag: '@ad-acN' }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('opens from Accounts and Money, with the header facts, sources and balance', { tag: '@acctnames-ac3' }, async ({ page }) => {
    await openFromAccounts(page);
    const dlg = recDialog(page);
    await expect(dlg).toHaveAttribute('aria-modal', 'true');
    await expect(dlg.locator('#h-dlg-t')).toHaveText(BIZ_LABEL);
    await expect(dlg.locator('.h-ad-last4')).toHaveText(/^Last 4 \d{4}$/);
    await expect(dlg.locator('.h-ad-facts')).toContainText('Mirrored');
    await expect(dlg.locator('.h-ad-sources')).toBeVisible();
    await expect(dlg.locator('.h-ad-sources li').first()).toBeVisible();
    await expect(dlg.locator('.h-ad-balance .fx-fig').first()).toBeVisible();
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/accounts$/);

    await gotoRoute(page, 'money');
    await page.locator(`[data-account="${ID}"] .h-acc-m`).click();
    await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(BIZ_LABEL);
    await expect(page).toHaveURL(new RegExp(`#/account/${ID}$`));
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/money$/);
  });

  test('rename in the dialog, Escape cancels the edit first, and the page keeps the new name', async ({ page }) => {
    await openFromAccounts(page);
    const dlg = recDialog(page);
    await dlg.locator('[data-dlg-rename]').first().click();
    const input = dlg.locator('[data-dlg-name]');
    await expect(input).toBeFocused();
    await input.fill('Studio operating');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#h-dlg-t')).toHaveText(BIZ_LABEL);
    await dlg.locator('[data-dlg-rename]').first().click();
    await dlg.locator('[data-dlg-name]').fill('Studio operating');
    await page.keyboard.press('Enter');
    await expect(dlg.locator('#h-dlg-t')).toHaveText('Studio operating');
    await closeDialogWithX(page);
    await expect(page.locator(`[data-account="${ID}"] .h-acc-name`)).toHaveText('Studio operating');
  });

  test('transactions: newest first, filter by text and by date range, amounts carry a source', async ({ page, request }) => {
    const all = await firstTransactions(request);
    expect(all.items.length).toBeGreaterThan(20);
    await openFromAccounts(page);
    const dlg = recDialog(page);
    const rows = dlg.locator('.h-ad-txn');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator('.h-ad-txn-d')).toHaveText(all.items[0].date);
    const shown = await rows.count();
    expect(shown).toBeLessThanOrEqual(50);

    const word = all.items.map((t) => t.description.split(/\s+/).find((w) => /^[A-Za-z]{4,}$/.test(w))).find(Boolean);
    expect(word, 'a searchable word in the demo ledger').toBeTruthy();
    const expected = all.items.filter((t) => (t.description + ' ' + t.category).toLowerCase().includes(word.toLowerCase())).length;
    await dlg.locator('[data-ad="q"]').fill(word);
    await expect(dlg.locator('.h-ad-count')).toContainText(String(expected));
    await expect(dlg.locator('[data-ad="q"]')).toBeFocused();
    for (const t of await rows.locator('.h-ad-txn-t').allTextContents()) expect(t.toLowerCase()).toContain(word.toLowerCase());
    await dlg.locator('[data-ad="q"]').fill('');

    const mid = all.items[Math.floor(all.items.length / 2)].date;
    const inRange = all.items.filter((t) => t.date >= mid).length;
    await dlg.locator('[data-ad="from"]').fill(mid);
    await expect(dlg.locator('.h-ad-count')).toContainText(String(inRange));
    await dlg.locator('[data-ad="clear"]').click();

    const fig = rows.first().locator('.fx-fig');
    await fig.click();
    await expect(page.locator('.fx-pop')).toContainText('Source');
    await expect(recDialog(page)).toBeVisible();
  });

  test('Load more pages through the ledger', async ({ page, request }) => {
    const all = await firstTransactions(request);
    test.skip(all.total <= 50, 'demo ledger fits one page');
    await openFromAccounts(page);
    const dlg = recDialog(page);
    const before = await dlg.locator('.h-ad-txn').count();
    await dlg.locator('[data-ad="more"]').click();
    await expect.poll(() => dlg.locator('.h-ad-txn').count()).toBeGreaterThan(before);
  });

  test('deep link survives a reload, Escape closes, and Back does not reopen it', async ({ page }) => {
    await gotoRoute(page, 'accounts');
    await page.goto(`/#/account/${ID}`);
    await page.reload();
    const dlg = recDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#h-dlg-t')).toHaveText(BIZ_LABEL);
    await page.keyboard.press('Escape');
    await expect(recDialog(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/#\/account\//);
    await page.goBack();
    await expect(recDialog(page)).toHaveCount(0);
  });

  test('Tab stays inside the dialog', async ({ page }) => {
    await openFromAccounts(page);
    const dlg = recDialog(page);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.h-dlg-host'));
      expect(inside).toBe(true);
    }
    expect(await dlg.count()).toBe(1);
  });

  test('the quick switcher opens an account', async ({ page }) => {
    await gotoRoute(page, 'home');
    await page.keyboard.press('Control+k');
    await page.locator('.h-qs input, input.h-qs-in').first().fill('Business checking');
    await page.locator('.h-qs-t', { hasText: 'Business checking' }).first().click();
    await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(BIZ_LABEL);
    await expect(page).toHaveURL(new RegExp(`#/account/${ID}$`));
  });

  test('desktop shows two columns', async ({ page }) => {
    await openFromAccounts(page);
    const main = await recDialog(page).locator('.h-dmain').boundingBox();
    const side = await recDialog(page).locator('.h-dside').boundingBox();
    expect(side.x).toBeGreaterThan(main.x + main.width - 2);
  });
});

// A connected account that looks like one already imported from a file, as the merge change seeds it.
async function seedDuplicate(request) {
  await resetDemo(request);
  const dataDir = resolve(process.env.E2E_DATA || '.e2e-data');
  const db = openDb(resolve(dataDir, DB_FILE));
  try {
    setSetting(db, 'clock', '2032-03-10');
    const key = await dataKeyFor(db, { dataDir });
    const s = { db, config: { dataDir }, key, opts: (engine, extra = {}) => ({ config: { dataDir }, key, engine, now: '2032-03-10T12:00:00.000Z', ...extra }) };
    const pair = await seedDuplicateRows(s, { sure: true });
    refreshMergedAccounts(db, { now: '2032-03-10T12:00:00.000Z' });
    return pair;
  } finally { db.close(); }
}

test.describe('account dialog and duplicates', { tag: '@ad-acN' }, () => {
  test.skip(REMOTE, 'requires a local synthetic store');

  test('a connected account lists SimpleFIN with its sync time and Sync now works from the dialog', async ({ page, request }) => {
    await resetDemo(request);
    const before = await (await request.get('/api/scenario')).json();
    const connect = await request.post('/api/simplefin/connect', { data: { token: before.live.simplefin.demoToken } });
    expect(connect.ok()).toBeTruthy();
    const after = await (await request.get('/api/scenario')).json();
    let mapped = null;
    for (const a of after.accounts) {
      const d = await (await request.get(`/api/accounts/${encodeURIComponent(a.id)}`)).json();
      if (d.feeds.some((f) => f.kind === 'simplefin')) { mapped = a; break; }
    }
    expect(mapped, 'the demo bridge maps at least one account').toBeTruthy();
    await page.goto(`/#/account/${mapped.id}`);
    await page.reload();
    const dlg = recDialog(page);
    const feed = dlg.locator('.h-ad-sources li[data-feed="simplefin"]');
    await expect(feed).toContainText('SimpleFIN Bridge');
    await expect(feed).toContainText(/Last sync \w{3} \d+, \d+:\d{2} (AM|PM)/);
    const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs/simplefin-sync/run');
    await feed.getByRole('button', { name: 'Sync now' }).click();
    expect((await done).status()).toBe(200);
    await expect(feed.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    await expect(feed).toContainText('Last sync');
  });

  test('a likely duplicate asks Same account? in the dialog and Keep both answers it', async ({ page, request }) => {
    const pair = await seedDuplicate(request);
    await page.goto(`/#/account/${pair.keep}`);
    await page.reload();
    const dlg = recDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText('Same account?').first()).toBeVisible();
    await expect(dlg.getByRole('button', { name: /Merge$/ })).toBeVisible();
    await dlg.getByRole('button', { name: /Keep both/ }).click();
    await expect(dlg.getByRole('button', { name: /Keep both/ })).toHaveCount(0);
    await expect(dlg.locator('#h-dlg-t')).toBeVisible();
  });

  test('Merge from the dialog goes through the merge path and leaves one account', async ({ page, request }) => {
    const pair = await seedDuplicate(request);
    await page.goto(`/#/account/${pair.keep}`);
    await page.reload();
    const dlg = recDialog(page);
    const item = (await (await request.get('/api/scenario')).json()).live.ingest.items.find((i) => i.context?.repair);
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/confirm/${item.id}/answer`));
    await dlg.getByRole('button', { name: /Merge$/ }).click();
    expect((await answered).status()).toBe(200);
    const sc = await (await request.get('/api/scenario')).json();
    expect(sc.accounts.filter((a) => [pair.keep, pair.own].includes(a.id))).toHaveLength(1);
    await expect(dlg.getByText('Same account?')).toHaveCount(0);
  });
});

test.describe('account dialog on a phone', { tag: ['@mobile', '@mobile-only', '@ad-acN'] }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('opens from Accounts as one column, filters, and closes', async ({ page }) => {
    await openFromAccounts(page);
    const dlg = recDialog(page);
    const main = await dlg.locator('.h-dmain').boundingBox();
    const side = await dlg.locator('.h-dside').boundingBox();
    // One column: the two blocks share a left edge and never sit side by side.
    expect(Math.abs(side.x - main.x)).toBeLessThan(2);
    expect(side.y + side.height <= main.y + 2 || main.y + main.height <= side.y + 2).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dlg.locator('[data-ad="q"]').fill('zzzz-no-such-text');
    await expect(dlg.locator('.h-ad-count')).toContainText('0');
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/accounts$/);
  });
});
