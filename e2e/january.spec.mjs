// January server (FATHOM_CLOCK=2027-01-05, its own data dir): calendar-driven decisions open on
// their date, and tax-year labels come from the model data, not the display clock.

import { test, expect, S, resetDemo, plain, money, recDialog } from './helpers.mjs';

function janBase(testInfo) {
  return testInfo.config.metadata?.janBaseURL || '';
}

test.beforeEach(async ({ request }, testInfo) => {
  const base = janBase(testInfo);
  test.skip(!base, 'no January server (BASE_URL set without JAN_BASE_URL)');
  await resetDemo(request, base);
});

async function gotoJan(page, testInfo, route) {
  await page.goto(new URL(`/#/${route}`, janBase(testInfo)).href);
  await expect(page.locator('header.h-top')).toBeVisible();
}

test('January Decide: the 2027 salary decision is open and its war game reads open', async ({ page }, testInfo) => {
  const d = S.decisions.find((x) => x.id === 'salary27');
  await gotoJan(page, testInfo, 'wargame');
  await expect(page.getByRole('heading', { level: 1, name: 'What is open, and what is coming', exact: true })).toBeVisible();
  await expect(page.locator('article.h-dec.open', { hasText: plain(d.title) })).toBeVisible();
  await expect(page.locator('article.h-dec.upcoming', { hasText: plain(d.title) })).toHaveCount(0);

  await gotoJan(page, testInfo, 'wargame/salary');
  await expect(page.locator('.h-ph .h-kicker')).toHaveText('Open decision');
  await expect(page.locator('.h-decided')).toHaveCount(0);
  await expect(recDialog(page)).toHaveCount(0);
});

test('January deferral war game: labels are 2026 and 2027 tax change with the option values', async ({ page }, testInfo) => {
  await gotoJan(page, testInfo, 'wargame/deferral');
  await expect(page.getByRole('heading', { level: 1, name: plain(S.wargame.deferral.title), exact: true })).toBeVisible();
  const selected = page.locator('.h-seg [role="radio"][aria-checked="true"]');
  await expect(selected).toHaveCount(1);
  const opt = S.wargame.deferral.options[Number(await selected.getAttribute('data-i'))];

  const stats = page.locator('.h-def-stats > div');
  await expect(stats.nth(0).locator('span').first()).toHaveText('2026 tax change');
  await expect(stats.nth(1).locator('span').first()).toHaveText('2027 tax change');
  const y26 = stats.nth(0).locator(`.fx-fig[data-fig="wg.deferral.${opt.id}.tax2026"]`);
  const y27 = stats.nth(1).locator(`.fx-fig[data-fig="wg.deferral.${opt.id}.tax2027"]`);
  await expect(y26).toHaveText(money(opt.tax2026, { sign: true }));
  await expect(y27).toHaveText(money(opt.tax2027, { sign: true }));
});
