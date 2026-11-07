// P&L under Money: a business P&L per entity (workbook or categorized business transactions) and
// household spending with housing and taxes toggles, reached from the Money sub-nav and the quick
// switcher. Every expected value is read from the API inside the test; nothing is hard-coded from
// the demo, because other specs mutate the shared demo store.
// Tags: @pl-ac3 rows and provenance, @pl-ac5 phone layout, @pl-ac6 navigation and values;
// @mobile runs the test at 390px too.

import { scratch, buildRealStore } from '../test/helpers/real-store.mjs';
import { serveAppFixture } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { answerItem } from '../src/ingest/confirm.mjs';
import { loadConfig } from '../src/config.mjs';
import { test, expect, resetDemo, gotoRoute, expectH1, expectPopoverSource, bareDollarNodes } from './helpers.mjs';

const view = (page, key) => page.locator(`[data-pl-views] [data-pl-view="${key}"]`);
const tile = (page, k) => page.locator(`[data-pl-total="${k}"] .fx-fig`).first();
const rowsPanel = (page) => page.locator('[data-pl-rows]');
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
    // The month strip has one button per month, through the latest.
    const strip = page.locator('[data-pl-months] button[data-pl-month]');
    await expect(strip).toHaveCount(api.pnl.months.length);
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
    await expect(page.locator('[data-pl-table] button[data-pl-cat][data-pl-bucket="tax"]').first()).toBeVisible();
  });

  test('@pl-ac3 @mobile a category opens the rows behind it; figures show their source and detail; no bare dollars', async ({ page, request }) => {
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
    await page.locator(`[data-pl-table] button[data-pl-cat="${attr(category)}"][data-pl-section="${section}"]`).click();
    await expectRows(page, request, '/api/pnl/rows', { entity: p.entity.key, from: p.from, to: p.to, section, category }, p.to, category);
    await rowsPanel(page).locator('li.h-ad-txn .fx-fig').first().click();
    await expect(page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await bareDollarNodes(page), 'business rows open').toEqual([]);
    await page.locator('[data-pl-rows-close]').click();
    await expect(rowsPanel(page)).toBeHidden();

    // Household category rows.
    await view(page, 'household').click();
    await expect(page.locator('[data-pl-household]')).toBeVisible();
    const sp = (await getJson(request, '/api/spending')).spending;
    const bucket = sp.buckets.find((b) => b.categories.length);
    const hcat = bucket.categories[0].category;
    await page.locator(`[data-pl-table] button[data-pl-cat="${attr(hcat)}"][data-pl-bucket="${bucket.bucket}"]`).click();
    await expectRows(page, request, '/api/spending/rows', { from: sp.from, to: sp.to, bucket: bucket.bucket, category: hcat }, sp.to, hcat);
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
    await page.locator(`[data-pl-table] button[data-pl-cat="${attr(p[section].categories[0].category)}"][data-pl-section="${section}"]`).click();
    await expect(rowsPanel(page)).toBeVisible();
    await noOverflow(page, 'business rows open');

    await view(page, 'household').click();
    await expect(page.locator('[data-pl-household]')).toBeVisible();
    await expect(page.locator('[data-pl-table]')).toBeVisible();
    await noOverflow(page, 'household view');
    await page.screenshot({ path: test.info().outputPath(`pnl-household-${width}.png`), fullPage: true });
    await page.locator('[data-pl-table] button[data-pl-cat]').first().click();
    await expect(rowsPanel(page)).toBeVisible();
    await noOverflow(page, 'household rows open');
    await page.screenshot({ path: test.info().outputPath(`pnl-household-rows-${width}.png`), fullPage: true });
  });
});

// The rows panel lists the rows behind the clicked category: for the range or for the selected
// month (the latest by default). The count line and the list match the rows API for one of them.
async function expectRows(page, request, path, query, month, category) {
  const panel = rowsPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(category);
  await expect(panel.locator('li.h-ad-txn').first()).toBeVisible();
  const range = await getJson(request, `${path}?${qs(query)}`);
  const single = await getJson(request, `${path}?${qs({ ...query, month })}`);
  const count = (await panel.locator('[data-pl-rows-count]').innerText()).replace(/,/g, '');
  const hit = [range, single].find((r) => new RegExp(`\\b${r.total}\\b`).test(count));
  expect(hit, `count "${count}" is the range total ${range.total} or the month total ${single.total}`).toBeTruthy();
  await expect(panel.locator('li.h-ad-txn')).toHaveCount(hit.items.length);
  await expect(panel.locator('li.h-ad-txn .fx-fig')).toHaveCount(hit.items.length);
}


test('PN1 @mobile confirmed spending ledgers appear apart from businesses with their original display names', async ({ page }) => {
  const state = scratch('fathom-ledger-view-');
  let app;
  try {
    const dir = state.dir();
    const db = state.track(await buildRealStore(dir));
    db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, locator) VALUES ('Asters', '2026-10', 'Groceries', -120, ?)")
      .run(JSON.stringify({ sheet: "Aster's - (Actual Expenses)", cells: ['D2'] }));
    await planRun(db);
    const q = db.prepare("SELECT id FROM confirm_items WHERE context LIKE '%pnl.ledgers%' AND status = 'pending'").get();
    answerItem(db, q.id, 'yes');
    await planRun(db);
    app = await serveAppFixture({ db, authenticated: true, config: loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: '2026-11-05' }) });
    await page.context().addCookies([{ name: '__Host-fathom-session', value: app.session.token, url: app.baseUrl, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(`${app.baseUrl}/#/pnl`);
    await expectH1(page, 'P&L');
    const ledgers = page.getByRole('group', { name: 'Spending ledgers', exact: true });
    const businesses = page.getByRole('group', { name: 'Businesses', exact: true });
    await expect(ledgers).toBeVisible();
    await expect(businesses).toBeVisible();
    await expect(ledgers.getByRole('button')).toContainText("Aster's");
    await expect(businesses).not.toContainText("Aster's");
    await ledgers.getByRole('button').click();
    await expect(page.locator('[data-pl-business]')).toBeVisible();
    const payload = (await app.request({ path: '/api/pnl?entity=entity:asters' })).json;
    await expectTileValue(page, 'expenses', payload, payload.pnl.expenses.total);
    await noOverflow(page, 'spending ledger');
  } finally {
    if (app) await app.close();
    state.cleanup();
  }
});
