// Rec modal: layout, closing, and history (Horizon port item 1). One history entry per modal
// session; Back after closing never shows a modal, from in-app entry or from a deep link.

import { test, expect, S, resetDemo, needsYouIds, rec, plain, crossRefPair, gotoRoute, expectH1, mainNav, recDialog, openRecFromPage, closeDialogWithX, expectPopoverSource } from './helpers.mjs';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

// Home first, then Plan through the menu, so Back from Plan has somewhere in the app to go.
async function homeThenPlan(page) {
  await gotoRoute(page, 'home');
  await mainNav(page).getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
}

// Home first, then a real deep link: the page boots on #/rec/<id>.
async function homeThenDeepLink(page, id) {
  await gotoRoute(page, 'home');
  await page.goto(`/#/rec/${id}`);
  await page.reload();
  await expect(recDialog(page)).toBeVisible();
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(plain(rec(id).title));
}

async function backLandsOnHomeWithoutModal(page) {
  await page.goBack();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(recDialog(page)).toHaveCount(0);
  await expect(page.locator('h1.h-home-h')).toBeVisible();
}

// Ask rec A's thread a question whose answer refers to rec B, then follow that ref link.
async function followRefToB(page, pair) {
  const dlg = recDialog(page);
  const input = dlg.locator('form.h-compose input[name="q"]');
  await input.fill(pair.q);
  await input.press('Enter');
  const link = dlg.locator(`.h-thread .h-refs a[data-go="rec"][data-id="${pair.b}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#/rec/${pair.b}$`));
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(plain(rec(pair.b).title));
}

test('from Plan: dialog opens with the chat composer first, X lands on Plan, Back does not reopen', async ({ page }) => {
  await homeThenPlan(page);
  const id = needsYouIds()[0];
  await openRecFromPage(page, id);
  const dlg = recDialog(page);
  await expect(dlg).toHaveAttribute('aria-modal', 'true');

  const first = dlg.locator('.h-dlg-body section').first();
  await expect(first).toHaveClass(/\bh-conv\b/);
  await expect(first.getByRole('heading', { level: 2, name: 'Ask about this', exact: true })).toBeVisible();
  await expect(first.locator('form.h-compose')).toBeVisible();
  await expect(first.getByPlaceholder('Ask about this')).toBeVisible();

  await closeDialogWithX(page);
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
  await backLandsOnHomeWithoutModal(page);
});

test('deep link: X lands on Plan, Back does not reopen', async ({ page }) => {
  const id = needsYouIds()[0];
  await homeThenDeepLink(page, id);
  await closeDialogWithX(page);
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
  await backLandsOnHomeWithoutModal(page);
});

test('Escape closes like X: lands on Plan, Back does not reopen', async ({ page }) => {
  await homeThenPlan(page);
  await openRecFromPage(page, needsYouIds()[0]);
  await page.keyboard.press('Escape');
  await expect(recDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/plan$/);
  await backLandsOnHomeWithoutModal(page);
});

test('in-app: rec A to rec B through a ref link, Close lands on Plan, Back does not reopen', async ({ page }) => {
  const pair = crossRefPair();
  await homeThenPlan(page);
  await openRecFromPage(page, pair.a);
  await followRefToB(page, pair);
  await closeDialogWithX(page);
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
  await backLandsOnHomeWithoutModal(page);
});

test('deep link: rec A to rec B through a ref link, Close lands on Plan, Back does not reopen', async ({ page }) => {
  const pair = crossRefPair();
  await homeThenDeepLink(page, pair.a);
  await followRefToB(page, pair);
  await closeDialogWithX(page);
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
  await backLandsOnHomeWithoutModal(page);
});

test('a figure in the dialog opens the provenance popover with its Source', async ({ page }) => {
  const r = S.recs.find((x) => needsYouIds().includes(x.id) && (x.mine || []).length) || S.recs.find((x) => (x.mine || []).length);
  await homeThenPlan(page);
  await openRecFromPage(page, r.id);
  const fig = recDialog(page).locator('.h-mine .fx-fig').first();
  const key = await fig.getAttribute('data-fig');
  const f = S.fig[key];
  expect(f, `figure ${key} in demo/scenario.mjs`).toBeTruthy();
  await fig.click();
  await expectPopoverSource(page, plain(S.src[f.src].label));
  // The popover does not close the dialog.
  await expect(recDialog(page)).toBeVisible();
});
