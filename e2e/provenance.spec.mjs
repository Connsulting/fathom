// Every displayed amount carries provenance (Horizon port item 5, oracle note 2): on every route,
// no text node with a bare dollar amount sits outside .fx-fig, .fx-law, an axis tick or the popover.

import { test, expect, S, resetDemo, mainRoutes, visibleRecs, plain, gotoRoute, expectH1, recDialog, bareDollarNodes } from './helpers.mjs';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

for (const [route, heading] of mainRoutes()) {
  test(`#/${route} has no bare dollar amounts`, async ({ page }) => {
    await gotoRoute(page, route);
    await expectH1(page, heading);
    expect(await bareDollarNodes(page)).toEqual([]);
  });
}

test('every pack page has no bare dollar amounts', async ({ page }) => {
  const found = [];
  for (const p of S.packs) {
    await gotoRoute(page, `packs/${p.id}`);
    await expectH1(page, plain(p.name));
    for (const hit of await bareDollarNodes(page)) found.push(`#/packs/${p.id}: ${hit}`);
  }
  expect(found).toEqual([]);
});

test('every rec dialog has no bare dollar amounts', async ({ page }) => {
  test.setTimeout(120_000);
  const found = [];
  for (const r of visibleRecs()) {
    await gotoRoute(page, `rec/${r.id}`);
    await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(plain(r.title));
    for (const hit of await bareDollarNodes(page)) found.push(`#/rec/${r.id}: ${hit}`);
  }
  expect(found).toEqual([]);
});

test('Ask answers have no bare dollar amounts', async ({ page }) => {
  await gotoRoute(page, 'ask');
  const chips = page.locator('button.h-chip[data-ask]');
  const total = await chips.count();
  expect(total).toBeGreaterThan(0);
  for (let n = total; n > 0; n--) {
    await chips.first().click();
    await expect(chips).toHaveCount(n - 1);
  }
  await expect(page.locator('.h-thread .h-msg.fathom')).toHaveCount(total);
  expect(await bareDollarNodes(page)).toEqual([]);
});

test('rec follow-up answers have no bare dollar amounts', async ({ page }) => {
  test.setTimeout(120_000);
  const found = [];
  for (const r of visibleRecs().filter((x) => (x.qa || []).length)) {
    await gotoRoute(page, `rec/${r.id}`);
    const dlg = recDialog(page);
    await expect(dlg.locator('#h-dlg-t')).toHaveText(plain(r.title));
    const chips = dlg.locator('button.h-chip[data-askrec]');
    const total = await chips.count();
    for (let n = total; n > 0; n--) {
      await chips.first().click();
      await expect(chips).toHaveCount(n - 1);
    }
    for (const hit of await bareDollarNodes(page)) found.push(`#/rec/${r.id}: ${hit}`);
  }
  expect(found).toEqual([]);
});
