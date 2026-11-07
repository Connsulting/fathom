// P&L under Money: a business P&L per entity (workbook or categorized business transactions) and
// household spending with housing and taxes toggles, reached from the Money sub-nav and the quick
// switcher. Every expected value is read from the API inside the test; nothing is hard-coded from
// the demo, because other specs mutate the shared demo store.
// Tags: @pl-ac3 rows (in the rows dialog) and provenance, @pl-ac5 phone layout, @pl-ac6 navigation and values;
// @mobile runs the test at 390px too.

import { test, expect, resetDemo, gotoRoute, expectH1, expectPopoverSource, bareDollarNodes, recDialog } from './helpers.mjs';

const view = (page, key) => page.locator(`[data-pl-views] [data-pl-view="${key}"]`);
const tile = (page, k) => page.locator(`[data-pl-total="${k}"] .fx-fig`).first();
// The rows dialog a category name opens (#/pnlrows/<spec>).
const rowsDialog = (page) => recDialog(page);
const dlgRows = (page) => rowsDialog(page).locator('table[data-pl-dlg-rows] tr[data-pl-dlg-row]');
// A category name button in the table: business by section, household by bucket.
const catButton = (page, category, attrs) => page.locator(`[data-pl-table] tr[data-pl-row][data-pl-cat-row="${attr(category)}"]${attrs} th button.pl-cat[data-go="pnlrows"]`);
const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
const r2 = (x) => Math.round(x * 100) / 100;

async function getJson(request, path) {
  const res = await request.get(path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return res.json();
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// The value the page registered for the figure a selector shows.
async function shownValue(locator) {
  const key = await locator.getAttribute('data-fig');
  expect(key, 'the figure carries its key').toBeTruthy();
  return locator.page().evaluate((k) => {
    const f = window.Fathom.api.fig(k);
    return f && !f.missing ? Math.round(f.v * 100) / 100 : null;
  }, key);
}

async function expectTileValue(page, k, payload, key) {
  expect(key, `${k} has a figure`).toBeTruthy();
  const want = r2(payload.figures[key].v);
  await expect(tile(page, k)).toBeVisible();
  await expect.poll(() => shownValue(tile(page, k)), { message: `${k} tile` }).toBe(want);
}

async function openPnl(page) {
  await gotoRoute(page, 'pnl');
  await expectH1(page, 'P&L');
  await expect(page.locator('[data-pl-views]')).toBeVisible();
}

async function noOverflow(page, what) {
  const w = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
  expect(w.doc, `${what}: no horizontal page overflow`).toBeLessThanOrEqual(w.inner);
}

test.describe('P&L view', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('@pl-ac6 @mobile Money sub-nav reaches P&L, and the chooser lists every entity plus Household spending', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    expect(api.entities.length, 'the demo has business data').toBeGreaterThan(0);

    await gotoRoute(page, 'money');
    await page.locator('main.h-main nav.h-subnav[aria-label="Money views"]').getByRole('link', { name: 'P&L', exact: true }).click();
    await expect(page).toHaveURL(/#\/pnl$/);
    await expectH1(page, 'P&L');

    const buttons = page.locator('[data-pl-views] [data-pl-view]');
    await expect(buttons).toHaveCount(api.entities.length + 1);
    for (const [i, e] of api.entities.entries()) {
      await expect(buttons.nth(i)).toHaveAttribute('data-pl-view', e.key);
      await expect(buttons.nth(i)).toContainText(e.label);
    }
    await expect(view(page, 'household')).toHaveText(/Household spending/);
    // Default view: the first business entity.
    await expect(view(page, api.entities[0].key)).toHaveAttribute('aria-pressed', 'true');
    await expect(view(page, 'household')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-pl-business]')).toBeVisible();
    await expect(page.locator('[data-pl-sources]')).toBeVisible();
    await expect(page.locator('[data-pl-gaps]')).toBeVisible();
    await expect(page.locator('[data-pl-table]')).toBeVisible();
    // The month strip leads with All months (selected by default), then one button per month,
    // through the latest.
    const strip = page.locator('[data-pl-months] button[data-pl-month]');
    await expect(strip).toHaveCount(api.pnl.months.length + 1);
    await expect(strip.first()).toHaveAttribute('data-pl-month', '');
    await expect(strip.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(strip.last()).toHaveAttribute('data-pl-month', api.pnl.to);
  });

  test('@pl-ac6 @mobile switching entity shows that entity\'s totals from the API', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    expect(api.entities.length, 'the demo has more than one P&L').toBeGreaterThan(1);
    await openPnl(page);
    for (const e of [...api.entities.slice(1), api.entities[0]]) {
      await view(page, e.key).click();
      await expect(view(page, e.key)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-pl-business]')).toBeVisible();
      const one = await getJson(request, `/api/pnl?${qs({ entity: e.key })}`);
      expect(one.pnl.entity.key).toBe(e.key);
      let shown = 0;
      for (const k of ['income', 'expenses', 'net']) {
        const key = one.pnl[k].total;
        if (!key) continue;
        await expectTileValue(page, k, one, key);
        shown++;
      }
      expect(shown, `${e.key} has at least one total`).toBeGreaterThan(0);
      const prior = page.locator('[data-pl-business] [data-pl-prior]');
      if (one.pnl.prior) await expect(prior.first()).toBeVisible();
      else await expect(page.locator('[data-pl-business]')).toContainText('No data for the same months last year');
    }
  });

  test('@pl-ac6 @mobile household toggles: housing off then taxes on match the spending API', async ({ page, request }) => {
    await openPnl(page);
    await view(page, 'household').click();
    await expect(view(page, 'household')).toHaveAttribute('aria-pressed', 'true');
    const home = page.locator('[data-pl-household]');
    await expect(home).toBeVisible();
    await expect(page.locator('[data-pl-business]')).toBeHidden();
    const housing = page.locator('button[data-pl-toggle="housing"]');
    const tax = page.locator('button[data-pl-toggle="tax"]');
    await expect(housing).toHaveAttribute('aria-pressed', 'true');
    await expect(tax).toHaveAttribute('aria-pressed', 'false');
    await expect(home).toContainText(/elective/i);

    const base = await getJson(request, '/api/spending');
    await expectTileValue(page, 'total', base, base.spending.total);
    await expectTileValue(page, 'average', base, base.spending.monthlyAverage);

    await housing.click();
    await expect(housing).toHaveAttribute('aria-pressed', 'false');
    const noHousing = await getJson(request, `/api/spending?${qs({ exclude: 'housing' })}`);
    await expectTileValue(page, 'total', noHousing, noHousing.spending.total);

    await tax.click();
    await expect(tax).toHaveAttribute('aria-pressed', 'true');
    const elective = await getJson(request, `/api/spending?${qs({ include: 'tax', exclude: 'housing' })}`);
    await expectTileValue(page, 'total', elective, elective.spending.total);
    expect(r2(elective.figures[elective.spending.total].v)).not.toBe(r2(noHousing.figures[noHousing.spending.total].v));
    await expect(page.locator('[data-pl-table] tr[data-pl-row][data-pl-bucket="tax"] button.pl-cat').first()).toBeVisible();
  });

  test('@pl-ac3 @mobile a category opens the rows behind it in a dialog; figures show their source and detail; no bare dollars', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const p = api.pnl;
    await openPnl(page);
    expect(await bareDollarNodes(page), 'business view').toEqual([]);

    // Summary tile popover: Source and detail rows from the API figure.
    const key = p.income.total || p.expenses.total;
    const k = p.income.total ? 'income' : 'expenses';
    const f = api.figures[key];
    await tile(page, k).click();
    await expectPopoverSource(page, api.sources[f.src].label);
    const pop = page.locator('.fx-pop');
    expect(f.detail.length, 'the figure has detail rows').toBeGreaterThan(0);
    for (const d of f.detail) {
      await expect(pop.locator('.fx-pop-k', { hasText: new RegExp(`^${d.k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first()).toBeVisible();
      await expect(pop).toContainText(d.v);
    }
    await page.keyboard.press('Escape');

    // Business category rows.
    const section = p.expenses.categories.length ? 'expenses' : 'income';
    const category = p[section].categories[0].category;
    await catButton(page, category, `[data-pl-section="${section}"]`).click();
    await expectRows(page, request, '/api/pnl/rows', { entity: p.entity.key, from: p.from, to: p.to, section, category }, category);
    expect(await bareDollarNodes(page), 'business rows open').toEqual([]);
    await dlgRows(page).first().locator('td.pl-d-amt .fx-fig').click();
    await expect(page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' })).toBeVisible();
    await closeRows(page);

    // Household category rows.
    await view(page, 'household').click();
    await expect(page.locator('[data-pl-household]')).toBeVisible();
    const sp = (await getJson(request, '/api/spending')).spending;
    const bucket = sp.buckets.find((b) => b.categories.length);
    const hcat = bucket.categories[0].category;
    await catButton(page, hcat, `[data-pl-bucket="${attr(bucket.bucket)}"]`).click();
    await expectRows(page, request, '/api/spending/rows', { from: sp.from, to: sp.to, bucket: bucket.bucket, category: hcat }, hcat);
    expect(await bareDollarNodes(page), 'household rows open').toEqual([]);
    await closeRows(page);
    expect(await bareDollarNodes(page), 'household view').toEqual([]);
  });

  test('@pl-ac6 the quick switcher goes to P&L', async ({ page }) => {
    await gotoRoute(page, 'home');
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await page.keyboard.press('Control+k');
    const sw = page.getByRole('dialog', { name: 'Quick switcher' });
    await expect(sw).toBeVisible();
    await page.locator('.h-qs-host input.h-qs-in').fill('P&L');
    await expect(page.locator('#h-qs-list li.h-qs-o[role="option"]').first()).toHaveAttribute('data-qs-key', 'go:pnl');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/pnl$/);
    await expect(sw).toBeHidden();
    await expectH1(page, 'P&L');
  });

  test('@pl-ac5 @mobile no horizontal overflow on the business view, the household view and with rows open; screenshots of both views', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const width = page.viewportSize().width;
    await openPnl(page);
    await expect(page.locator('[data-pl-business]')).toBeVisible();
    await expect(page.locator('[data-pl-table]')).toBeVisible();
    await noOverflow(page, 'business view');
    await page.screenshot({ path: test.info().outputPath(`pnl-business-${width}.png`), fullPage: true });

    const p = api.pnl;
    const section = p.expenses.categories.length ? 'expenses' : 'income';
    await catButton(page, p[section].categories[0].category, `[data-pl-section="${section}"]`).click();
    await expect(rowsDialog(page)).toBeVisible();
    await expect(dlgRows(page).first()).toBeVisible();
    await noOverflow(page, 'business rows open');
    await closeRows(page);

    await view(page, 'household').click();
    await expect(page.locator('[data-pl-household]')).toBeVisible();
    await expect(page.locator('[data-pl-table]')).toBeVisible();
    await noOverflow(page, 'household view');
    await page.screenshot({ path: test.info().outputPath(`pnl-household-${width}.png`), fullPage: true });
    await page.locator('[data-pl-table] tr[data-pl-row] th button.pl-cat[data-go="pnlrows"]').first().click();
    await expect(rowsDialog(page)).toBeVisible();
    await expect(dlgRows(page).first()).toBeVisible();
    await noOverflow(page, 'household rows open');
    await page.screenshot({ path: test.info().outputPath(`pnl-household-rows-${width}.png`), fullPage: true });
  });
});

// The rows dialog lists the rows behind the clicked category for the range (no month is selected
// by default): its title is the category, its rows and their figures match the rows API, the count
// line names the API's row count, and its total is the API's sum figure.
async function expectRows(page, request, path, query, category) {
  const dlg = rowsDialog(page);
  await expect(dlg).toBeVisible();
  await expect(page).toHaveURL(/#\/pnlrows\//);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(category);
  await expect(dlgRows(page).first()).toBeVisible();
  const rows = await getJson(request, `${path}?${qs(query)}`);
  await expect(dlgRows(page)).toHaveCount(rows.items.length);
  await expect(dlgRows(page).locator('td.pl-d-amt .fx-fig')).toHaveCount(rows.items.length);
  const figs = await dlgRows(page).locator('td.pl-d-amt .fx-fig').evaluateAll((els) => els.map((e) => e.getAttribute('data-fig')));
  expect(figs, 'the rows behind the category, newest first').toEqual(rows.items.map((i) => i.fig));
  await expect(dlg.locator('[data-pl-dlg-count]')).toContainText(String(rows.total));
  await expect(dlg.locator('[data-pl-dlg-total] .fx-fig')).toHaveAttribute('data-fig', rows.sum);
}

// Close the rows dialog; a first Escape may only dismiss an open figure popover.
async function closeRows(page) {
  await page.keyboard.press('Escape');
  if (await rowsDialog(page).count()) {
    await expect(page.locator('.fx-pop')).toBeHidden();
    await rowsDialog(page).locator('[data-dlg="close"]').click();
  }
  await expect(rowsDialog(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/pnlrows\//);
}
