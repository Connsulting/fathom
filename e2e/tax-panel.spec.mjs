// TX2: Tax this year. From Home one tap opens #/tax, which shows projected, paid so far and left to
// pay per jurisdiction as stored figures with provenance, and the gaps that would sharpen the
// estimate with their fixes. The pace board's tax meter with no reserve says paid against projected
// in words with one control. The demo never runs the planner, so the spec plants synthetic stored
// tax figures (round amounts) in the served store first, in the planner's shape.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, resetDemo, gotoRoute } from './helpers.mjs';
import { mainDataDir } from './data-dir.mjs';
import { servedStore } from '../test/helpers/server.mjs';
import { taxGap, estimateGap } from '../src/shared/tax-gaps.mjs';

const YTD = taxGap('paystub_ytd_missing', { employer: 'Cedar Labs' });
const PRIOR = estimateGap('prior_year_missing');
const gapLoc = (gaps) => ({ completeness: `estimate with ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`, partial: true, rough: gaps.some((g) => g.rough), gaps, notes: gaps.map((g) => g.message) });
const FIGURES = [
  ['tax.fed.proj', 30000, 'm', 'Projected federal tax for the year (rough partial estimate)', gapLoc([YTD])],
  ['tax.fed.paid', 8000, 'a', 'Federal estimated payments logged this year', { rows: { table: 'tax_payments', ids: [], count: 0 } }],
  ['tax.fed.withheld', 4000, 'a', 'Federal tax withheld from wages', { rows: { table: 'tax_payments', ids: [], count: 0 } }],
  ['tax.fed.paidToDate', 12000, 'a', 'Federal tax paid so far this year', { calc: 'taxPaidToDate', completeness: 'complete', partial: false, rough: false, gaps: [] }],
  ['tax.fed.remaining', 18000, 'e', 'Federal tax left to pay this year (rough partial estimate)', { calc: 'taxRemaining', ...gapLoc([YTD, PRIOR]) }],
  ['tax.va.proj', 6000, 'm', 'Projected Virginia tax for the year (rough partial estimate)', gapLoc([YTD])],
  ['tax.va.paid', 2000, 'a', 'Virginia estimated payments logged this year', { rows: { table: 'tax_payments', ids: [], count: 0 } }],
  ['tax.va.withheld', 1000, 'a', 'Virginia tax withheld from wages', { rows: { table: 'tax_payments', ids: [], count: 0 } }],
  ['tax.va.paidToDate', 3000, 'a', 'Virginia tax paid so far this year', { calc: 'taxPaidToDate', completeness: 'complete', partial: false, rough: false, gaps: [] }],
  ['tax.va.remaining', 3000, 'e', 'Virginia tax left to pay this year (rough partial estimate)', { calc: 'taxRemaining', ...gapLoc([YTD]) }],
];

function plantTax() {
  const db = new DatabaseSync(servedStore(mainDataDir()).file);
  try {
    db.prepare("INSERT OR IGNORE INTO sources (id, label, as_of, kind) VALUES ('calc:tax', 'Tax calculators, 2026 parameters', 'Nov 5', 'calculator')").run();
    const put = db.prepare("INSERT OR REPLACE INTO figures (key, v, src, kind, label, parser, locator, updated_at) VALUES (?, ?, 'calc:tax', ?, ?, 'planner', ?, '2026-11-05')");
    for (const [key, v, kind, label, loc] of FIGURES) put.run(key, v, kind, label, JSON.stringify({ ...loc, computedOn: '2026-11-05' }));
  } finally { db.close(); }
}

const noSideScroll = async (page) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, 'the page never scrolls sideways').toBeLessThanOrEqual(cw);
};

test('Tax this year opens from Home and shows sourced figures with gaps and fixes', async ({ page, request }) => {
  await resetDemo(request);
  plantTax();
  await page.setViewportSize({ width: 390, height: 900 });
  await gotoRoute(page, 'home');
  const homeCard = page.locator('a.h-taxh[data-go="tax"]');
  await expect(homeCard).toBeVisible();
  await expect(homeCard.locator('.fx-fig')).toHaveCount(2);
  await expect(homeCard).toContainText('$18,000');
  if (process.env.TX2_SHOTS) {
    mkdirSync(resolve(process.env.TX2_SHOTS), { recursive: true });
    await homeCard.screenshot({ path: resolve(process.env.TX2_SHOTS, 'home-tax-card-390.png') });
  }
  await homeCard.click();
  await expect(page).toHaveURL(/#\/tax$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tax this year', exact: true })).toBeVisible();

  const fed = page.locator('[data-tax-row="fed"]');
  const state = page.locator('[data-tax-row="state"]');
  for (const [where, key, text] of [[fed, 'tax.fed.proj', '$30,000'], [fed, 'tax.fed.paidToDate', '$12,000'], [fed, 'tax.fed.withheld', '$4,000'],
    [fed, 'tax.fed.paid', '$8,000'], [fed, 'tax.fed.remaining', '$18,000'], [state, 'tax.va.proj', '$6,000'], [state, 'tax.va.remaining', '$3,000']]) {
    await expect(where.locator(`[data-tax-key="${key}"] .fx-fig[data-fig="${key}"]`)).toHaveText(text);
  }
  await expect(fed.locator('[data-tax-key="tax.fed.remaining"] dt')).toHaveText('Left to pay');
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('{f:');

  // The figure's provenance popover names its calculator source and its gaps.
  await fed.locator('.fx-fig[data-fig="tax.fed.remaining"]').click();
  const pop = page.locator('.fx-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Tax calculators');
  await expect(pop).toContainText(PRIOR.message);
  await page.keyboard.press('Escape');

  // What would sharpen this: each gap once, with its fix control.
  const gaps = page.locator('.h-tax-gaps li');
  await expect(gaps).toHaveCount(2);
  const ytd = page.locator('li[data-tax-gap="paystub_ytd_missing"]');
  await expect(ytd).toContainText(YTD.message);
  await expect(ytd.locator('button[data-tax-gap-fix]')).toHaveText(YTD.action.label);
  const prior = page.locator('li[data-tax-gap="prior_year_missing"]');
  await expect(prior.locator('button[data-tax-gap-fix]')).toHaveText(PRIOR.action.label);
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await noSideScroll(page);

  if (process.env.TX2_SHOTS) {
    const dir = resolve(process.env.TX2_SHOTS);
    mkdirSync(dir, { recursive: true });
    await page.evaluate(() => document.activeElement?.blur());
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator('.h-tax-cards')).toBeVisible();
      await page.screenshot({ path: resolve(dir, `tax-${width === 390 ? 'phone' : 'desktop'}-${width}x900.png`), fullPage: true });
    }
  }

  // The prior-year fix opens the upload for tax forms.
  await prior.locator('button[data-tax-gap-fix]').click();
  await expect(page).toHaveURL(/#\/add/);
});

test('the pace board tax meter says paid against projected with one control when no reserve is recorded', async ({ page, request }) => {
  await resetDemo(request);
  plantTax();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, 'pace');
    const meter = page.locator('[data-meter="tax"]');
    await expect(meter).toBeVisible();
    await expect(meter.locator('.h-tax-meter')).toHaveText('Reserve not recorded. Paid $12,000 of $30,000 projected federal tax. Paid $3,000 of $6,000 projected state tax.');
    await expect(meter).not.toContainText('The figures this needs are not stored yet');
    await expect(meter.locator('a[data-go="tax"]')).toHaveText('See Tax this year');
    await expect(meter.locator('button[data-tax-gap-fix]')).toHaveCount(1);
    await expect(meter.locator('button[data-tax-gap-fix]')).toHaveText('Say where tax money is set aside');
    await noSideScroll(page);
  }
  await page.locator('[data-meter="tax"] a[data-go="tax"]').click();
  await expect(page).toHaveURL(/#\/tax$/);
});
