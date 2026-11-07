// AC5: the rec dialog shows who owns the action and which goal it serves. On the demo build, at
// desktop and 390px: the va529 dialog's "Action owner" select shows Both and its serves line reads
// "Serves: ..."; changing the owner with the keyboard keeps focus on the select and the new value
// across a reopen and a reload; a rec that serves no goal (umbrella) reads Housekeeping. Every test
// starts and ends on a fresh demo, since the demo server is shared across specs.

import { test, expect, resetDemo, gotoRoute, openRecFromPage, closeDialogWithX, recDialog, plain, S } from './helpers.mjs';

const TAGS = { tag: ['@mobile'] };

const ownerSelect = (page) => recDialog(page).getByRole('combobox', { name: 'Action owner' });
const ownerSaved = (page, id) => page.waitForResponse((r) => new URL(r.url()).pathname === `/api/recs/${id}/action`
  && r.request().method() === 'POST' && r.status() === 200);

async function ownerOf(request, id) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  const r = (await res.json()).recs.find((x) => x.id === id);
  return { owner: r?.owner, ownerOverride: r?.ownerOverride };
}

async function noHorizontalScroll(page) {
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
  expect(widths.doc, 'documentElement.scrollWidth').toBeLessThanOrEqual(widths.inner);
  expect(widths.body, 'body.scrollWidth').toBeLessThanOrEqual(widths.inner);
}

test.describe('rec owner and goal links', TAGS, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });
  test.afterEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('the owner select shows Both, changes to Spouse by keyboard and keeps it across reopen and reload', async ({ page, request }, info) => {
    expect(await ownerOf(request, 'va529')).toEqual({ owner: 'both', ownerOverride: false });
    const kids = S.goals.find((g) => g.id === 'kids');
    await gotoRoute(page, 'plan');
    await openRecFromPage(page, 'va529');
    const select = ownerSelect(page);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('both');
    await expect(select.locator('option:checked')).toHaveText('Both');
    expect(await select.locator('option').allTextContents()).toEqual(['You', 'Spouse', 'Both', 'Advisor', 'Automatic']);
    await expect(recDialog(page).locator('.h-rec-head .h-serves')).toHaveText(`Serves: ${plain(kids.title)}`);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath('rec-owner-both.png') });

    await select.focus();
    const saved = ownerSaved(page, 'va529');
    await page.keyboard.press('s'); // type-ahead: Spouse is the only option starting with S
    await saved;
    await expect(ownerSelect(page)).toHaveValue('spouse');
    await expect(ownerSelect(page)).toBeFocused();
    await expect(ownerSelect(page).locator('option:checked')).toHaveText('Spouse');
    expect(await ownerOf(request, 'va529')).toEqual({ owner: 'spouse', ownerOverride: true });

    await closeDialogWithX(page);
    await openRecFromPage(page, 'va529');
    await expect(ownerSelect(page)).toHaveValue('spouse');

    await page.reload();
    await gotoRoute(page, 'plan');
    await openRecFromPage(page, 'va529');
    await expect(ownerSelect(page)).toHaveValue('spouse');
    await expect(ownerSelect(page).locator('option:checked')).toHaveText('Spouse');
    await noHorizontalScroll(page);
  });

  test('a rec that serves no goal reads Housekeeping in its dialog', async ({ page }, info) => {
    await gotoRoute(page, 'plan');
    await openRecFromPage(page, 'umbrella');
    const serves = recDialog(page).locator('.h-rec-head .h-serves');
    await expect(serves).toHaveText('Housekeeping');
    await expect(serves).toHaveClass(/\bh-hk\b/);
    await expect(ownerSelect(page)).toHaveValue('both');
    await expect(ownerSelect(page)).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath('rec-owner-housekeeping.png') });
  });
});
