// AC7: the planner on a real-mode store, end to end through the UI. beforeAll builds the synthetic
// household in an owned temporary store, runs the plan job through the scheduler with no engine and
// starts a real-mode server in process; every page is reached by full URL on that server. Skipped
// when BASE_URL targets a remote server (nothing local is created then).

import { test, expect, S as DEMO } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

let DIR;
const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

const PLANNER_SOURCES = /^(acct:|pnl$|tax-payments$|transactions$|docs$|calc:|plan-projection$|wargame-model$)/;
const DEMO_NAMES = [...Object.values(DEMO.names), DEMO.meta.household].filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const demoNameRe = new RegExp(`\\b(?:${DEMO_NAMES.map(escapeRe).join('|')})\\b`);

let app = null;
let base = '';
let scenario = null;
let plain = (s) => String(s ?? '');
let needs = [];

async function fetchScenario() {
  const res = await fetch(`${base}/api/scenario`, { headers: app.headers });
  expect(res.status).toBe(200);
  return res.json();
}

async function go(page, route) {
  await page.goto(`${base}/#/${route}`);
  await expect(page.locator('header.h-top')).toBeVisible();
}

test.describe('AC7: planner on a real store', () => {
  test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ context }) => {
    await app.authenticate(context);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test.beforeAll(async () => {
    const { buildRealStore } = await import('../test/helpers/real-store.mjs');
    const { planRun } = await import('../test/helpers/plan.mjs');
    const { needsYou } = await import('../src/shared/rules.mjs');
    const { resolveTokens } = await import('../src/shared/tokens.mjs');

    DIR = createLocalData('planner-real');
    const db = await buildRealStore(DIR, { clock: CLOCK });
    try {
      const result = await planRun(db, { now: CLOCK, dataDir: DIR });
      expect(result.status).toBe('ok');
    } finally {
      db.close();
    }
    app = await startEnrolledServer({ dataDir: DIR, clock: CLOCK });
    base = app.url;
    scenario = await fetchScenario();
    plain = (s) => resolveTokens(scenario, s, false);
    needs = needsYou(scenario.recs);
  });

  test.afterAll(async () => {
    if (app) await app.close();
    app = null;
    removeLocalData(DIR);
  });

  test('AC7: the brief shows the planner verdict and the needs-you recs', async ({ page }) => {
    expect(scenario.live.mode).toBe('real');
    expect(needs.length).toBeGreaterThan(0);
    await go(page, 'brief');
    const headline = plain(scenario.verdict.attention.headline).replace(/\{count\}/g, String(needs.length));
    await expect(page.locator('h1.h-verdict')).toHaveText(headline);
    // Main's brief adds a second hero lede linking to Add more files; the verdict sub is the other one.
    await expect(page.locator('.h-hero .h-lede').filter({ hasNotText: 'Add more files' })).toHaveText(plain(scenario.verdict.attention.sub));
    for (const r of needs) {
      const link = page.locator(`.h-ny-list a[data-go="rec"][data-id="${r.id}"]`);
      await expect(link).toBeVisible();
      await expect(link).toHaveText(plain(r.title));
    }
  });

  test('AC7: the plan lists every visible planner rec', async ({ page }) => {
    await go(page, 'plan');
    await expect(page.getByRole('heading', { level: 1, name: 'Everything on the calendar', exact: true })).toBeVisible();
    const visible = scenario.recs.filter((r) => r.status !== 'hidden');
    expect(visible.map((r) => r.id)).toEqual(expect.arrayContaining(['fed-q4-estimate', 'scorp-salary', 'invoice-deferral', 'hsa-room']));
    for (const r of visible) {
      await expect(page.locator(`.h-rows a[data-go="rec"][data-id="${r.id}"]`).first()).toBeAttached();
    }
  });

  test('AC7: Decide shows the open 2026 salary decision and the upcoming 2027 one', async ({ page }) => {
    const open = scenario.decisions.find((d) => d.id === 'salary-2026');
    const upcoming = scenario.decisions.find((d) => d.id === 'salary-2027');
    expect(open && open.status).toBe('open');
    expect(upcoming && upcoming.status).toBe('upcoming');
    await go(page, 'wargame');
    await expect(page.getByRole('heading', { level: 1, name: 'What is open, and what is coming', exact: true })).toBeVisible();
    await expect(page.locator('article.h-dec.open', { hasText: plain(open.title) })).toBeVisible();
    await expect(page.locator('article.h-dec.upcoming', { hasText: plain(upcoming.title) })).toBeVisible();
  });

  test('AC7: the salary war game renders its points and a picked point cites the war-game model', async ({ page }) => {
    const points = scenario.wargame.salary.points;
    expect(points.length).toBeGreaterThan(2);
    await go(page, 'wargame/salary');
    await expect(page.getByRole('heading', { level: 1, name: plain(scenario.wargame.salary.title), exact: true })).toBeVisible();
    const pts = page.locator('g.h-sc-pt');
    await expect(pts).toHaveCount(points.length);
    const target = await page.locator('g.h-sc-pt:not(.on)').first().getAttribute('data-i');
    await page.locator(`g.h-sc-pt[data-i="${target}"]`).dispatchEvent('click');
    await expect(page.locator(`g.h-sc-pt.on[data-i="${target}"]`)).toHaveCount(1);
    const pt = points[Number(target)];
    const figs = page.locator('.h-wg-note .h-kvs .fx-fig');
    await expect(figs).toHaveCount(2);
    await expect(figs.nth(0)).toHaveAttribute('data-fig', `wg.salary.${pt.id}.x`);
    expect(scenario.fig[`wg.salary.${pt.id}.x`].src).toBe('wargame-model');
    await figs.nth(0).click();
    const pop = page.locator('.fx-pop');
    await expect(pop).toBeVisible();
    const source = pop.locator('.fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v');
    await expect(source).toHaveText(scenario.src['wargame-model'].label);
    await expect(source).toHaveText(/war-game model/i);
  });

  test('AC7: a rec detail shows grounded figures with a provenance kind and a planner source', async ({ page }) => {
    for (const id of ['fed-q4-estimate', 'hsa-room']) {
      const rec = scenario.recs.find((r) => r.id === id);
      expect(rec, id).toBeTruthy();
      await go(page, `rec/${id}`);
      const dlg = page.locator('.h-dlg[role="dialog"]');
      await expect(dlg.locator('#h-dlg-t')).toHaveText(plain(rec.title));
      const figs = dlg.locator('.h-mine .fx-fig');
      await expect(figs).toHaveCount(rec.mine.length);
      expect(rec.mine.length).toBeGreaterThan(0);
      for (let i = 0; i < rec.mine.length; i++) {
        await expect(figs.nth(i)).toHaveAttribute('data-kind', /^[apem]$/);
      }
      const key = await figs.first().getAttribute('data-fig');
      const f = scenario.fig[key];
      expect(f.src).toMatch(PLANNER_SOURCES);
      await figs.first().click();
      const pop = page.locator('.fx-pop');
      await expect(pop).toBeVisible();
      await expect(pop.locator('.fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v')).toHaveText(scenario.src[f.src].label);
      await page.keyboard.press('Escape');
    }
  });

  test('AC7: no page shows a name from the demo scenario', async ({ page }) => {
    const found = [];
    for (const route of ['brief', 'plan', 'wargame', 'wargame/salary', 'wargame/deferral', 'rec/fed-q4-estimate', 'accounts', 'packs']) {
      await go(page, route);
      await page.waitForLoadState('networkidle');
      const text = await page.locator('body').innerText();
      const hit = text.match(demoNameRe);
      if (hit) found.push(`#/${route}: ${hit[0]}`);
    }
    expect(found).toEqual([]);
    expect(JSON.stringify(scenario)).not.toMatch(demoNameRe);
  });
});
