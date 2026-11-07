// Pace board (#/pace) on the demo build: the rollup headline and health chip, the reason sentence,
// one diverging monthly chart per goal series (household savings when that series exists) with
// projected months outlined and a data-ends marker, bar figures with provenance, the table view,
// the three meters with reason text instead of zeros, the freshness note and the way back Home.
// Expected values come from GET /api/scenario (its pace block) at test time.

import { test, expect, resetDemo, gotoRoute, fetchScenario, expectPopoverSource, bareDollarNodes } from './helpers.mjs';

const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const METERS = [
  ['retirement', 'Retirement room used, closes Dec 31'],
  ['tax', 'Tax reserved vs owed'],
  ['income', 'Income vs plan']
];

// The charts the board draws: household savings when its series exists, else each goal series.
function charts(pace) {
  const hs = pace.series.householdSavings;
  if (Array.isArray(hs?.series)) return [{ id: 'householdSavings', series: hs.series, dataEnd: hs.dataEnd, figBase: 'pace.series.householdSavings.series' }];
  return pace.goals
    .filter((g) => Array.isArray(pace.series.goals[g.id]?.series))
    .map((g) => ({ id: g.id, title: g.title, series: pace.series.goals[g.id].series, dataEnd: pace.series.goals[g.id].dataEnd, figBase: `pace.series.goals.${g.id}.series` }));
}

function healthLabel(pace) {
  const n = (k) => Number(pace.rollup.counts[k]?.v ?? 0);
  if (n('behind') > 0) return `${plural(n('behind'), 'goal')} behind`;
  if (n('unknown') > 0) return pace.goals.some((g) => g.status !== 'no target' && g.stale) ? 'Data stale' : 'Pace unknown';
  if (Number(pace.rollup.total?.v ?? 0) === 0) return 'No targets yet';
  return 'On pace';
}

const board = (page) => page.locator('main');
const why = (page) => page.locator('p.h-pace-why');

test.describe('pace board', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('the board is headed by the rollup headline, the health chip and the reason sentence', { tag: ['@ac3', '@mobile'] }, async ({ page, request }) => {
    const { pace } = await fetchScenario(request);
    await gotoRoute(page, 'pace');
    await expect(page.getByRole('heading', { level: 1, name: pace.rollup.headline, exact: true })).toBeVisible();
    await expect(board(page).locator('.h-hchip')).toContainText(healthLabel(pace));
    await expect(board(page).locator('a.h-hchip')).toHaveCount(0);

    const unknown = Number(pace.rollup.counts.unknown.v);
    const behind = Number(pace.rollup.counts.behind.v);
    const noTarget = pace.goals.filter((g) => g.status === 'no target').length;
    await expect(why(page)).toBeVisible();
    if (behind > 0) {
      const worst = pace.goals.filter((g) => g.status === 'behind').sort((a, b) => (a.gapDays?.v ?? 0) - (b.gapDays?.v ?? 0))[0];
      await expect(why(page)).toContainText(worst.title);
      if (worst.timeGap) await expect(why(page)).toContainText(worst.timeGap);
    } else if (unknown > 0) {
      expect(pace.rollup.dataThrough).toBeTruthy();
      const head = `Data through ${fmtDay(pace.rollup.dataThrough)} is past its update cadence, so pace is unknown for ${plural(unknown, 'goal')}; later months are projected.`;
      await expect(why(page)).toContainText(head);
      if (noTarget === 0) await expect(why(page)).toHaveText(head);
    } else {
      await expect(why(page)).toContainText(`All ${Number(pace.rollup.total.v)} goals with targets are within plan.`);
    }
    if (noTarget > 0) await expect(why(page)).toContainText(`${plural(noTarget, 'goal')} without a target`);
    expect(await why(page).textContent()).not.toMatch(/\$\d/);

    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(widths.doc, 'no horizontal page scroll on #/pace').toBeLessThanOrEqual(widths.inner);
  });

  test('one chart per goal series, projected months outlined, and a data-ends marker', { tag: ['@ac3'] }, async ({ page, request }) => {
    const { pace } = await fetchScenario(request);
    const want = charts(pace);
    expect(want.length, 'the demo has goal series to chart').toBeGreaterThan(0);
    await gotoRoute(page, 'pace');
    const figs = page.locator('figure.h-pchart[data-chart]');
    await expect(figs).toHaveCount(want.length);
    expect(await figs.evaluateAll((els) => els.map((e) => e.getAttribute('data-chart')))).toEqual(want.map((c) => c.id));
    await expect(page.locator('p.h-pchart-none')).toHaveCount(0);

    for (const c of want) {
      const fig = page.locator(`figure.h-pchart[data-chart="${c.id}"]`);
      if (c.title) await expect(fig).toContainText(c.title);
      await expect(fig).toContainText('Ahead or behind plan, by month');
      const withGap = c.series.map((m, i) => ({ ...m, i })).filter((m) => m.gap && Number.isFinite(m.gap.v));
      expect(withGap.length, `${c.id} has months with a gap`).toBeGreaterThan(0);
      await expect(fig.locator('rect.h-pbar-m[data-month]')).toHaveCount(withGap.length);
      for (const m of c.series.filter((x) => !x.gap)) {
        await expect(fig.locator(`rect.h-pbar-m[data-month="${m.month}"]`), `${c.id} ${m.month} draws no bar`).toHaveCount(0);
      }
      for (const m of withGap) {
        const bar = fig.locator(`rect.h-pbar-m[data-month="${m.month}"]`);
        await expect(bar).toHaveAttribute('data-fig', `${c.figBase}.${m.i}.gap`);
        if (m.projected) await expect(bar, `${c.id} ${m.month} projected`).toHaveClass(/\bproj\b/);
        else await expect(bar, `${c.id} ${m.month} observed`).not.toHaveClass(/\bproj\b/);
        expect((await bar.locator('title').textContent()) || '', `${c.id} ${m.month} hover title`).toMatch(/\S/);
      }
      if (c.dataEnd) await expect(fig.locator('svg')).toContainText(`data ends ${fmtDay(c.dataEnd)}`);
    }
    // Household savings has no plan in the demo, so no chart is drawn for it.
    if (!Array.isArray(pace.series.householdSavings.series)) await expect(page.locator('figure.h-pchart[data-chart="householdSavings"]')).toHaveCount(0);
  });

  test('a bar opens its provenance, the table lists the months, and every board figure is a pace figure', { tag: ['@ac3', '@ac6'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const c = charts(s.pace)[0];
    const observed = c.series.map((m, i) => ({ ...m, i })).find((m) => m.gap && !m.projected);
    expect(observed, 'an observed month with a gap').toBeTruthy();
    await gotoRoute(page, 'pace');
    expect(await bareDollarNodes(page)).toEqual([]);
    const keys = await board(page).locator('[data-fig]').evaluateAll((els) => els.map((e) => e.getAttribute('data-fig')));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, 'figure key').toMatch(/^pace\./);

    // The bar sits under the data-ends marker, so the click goes to the bar element itself.
    const fig = page.locator(`figure.h-pchart[data-chart="${c.id}"]`);
    await fig.locator(`rect.h-pbar-m[data-month="${observed.month}"]`).dispatchEvent('click');
    await expectPopoverSource(page, s.src['calc:pace'].label);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fx-pop')).toHaveCount(0);

    const table = fig.locator('details', { has: page.locator('summary', { hasText: 'As a table' }) });
    await expect(table).toHaveCount(1);
    await table.locator('summary').click();
    await expect(table).toHaveAttribute('open', '');
    for (const m of c.series.map((x, i) => ({ ...x, i })).filter((x) => x.gap)) {
      await expect(table.locator(`.fx-fig[data-fig="${c.figBase}.${m.i}.gap"]`), `${m.month} gap in the table`).toHaveCount(1);
    }
    await table.locator(`.fx-fig[data-fig="${c.figBase}.${observed.i}.gap"]`).click();
    await expectPopoverSource(page, s.src['calc:pace'].label);
  });

  test('the three meters show reason text, never a zero, when their inputs are missing', { tag: ['@ac3'] }, async ({ page, request }) => {
    const { pace } = await fetchScenario(request);
    await gotoRoute(page, 'pace');
    const meters = page.locator('div.h-meters div.h-meter[data-meter]');
    await expect(meters).toHaveCount(3);
    expect(await meters.evaluateAll((els) => els.map((e) => e.getAttribute('data-meter')))).toEqual(METERS.map(([k]) => k));
    for (const [k, label] of METERS) {
      const m = page.locator(`div.h-meter[data-meter="${k}"]`);
      await expect(m).toContainText(label);
      if (pace.meters[k].meter) continue;
      const none = m.locator('p.h-meter-none');
      await expect(none, `${k} reason`).toHaveCount(1);
      await expect(none).toHaveText(/\S/);
      const text = await m.innerText();
      expect(text, `${k} shows no zero`).not.toMatch(/(^|[^0-9.])0%|\$0(?![0-9.,])/);
      await expect(m.locator('.fx-fig'), `${k} shows no figure`).toHaveCount(0);
    }
    expect(Object.values(pace.meters).every((x) => x.meter == null), 'the demo meters have no inputs').toBe(true);
  });

  test('a meter with inputs shows used of limit as pace figures', { tag: ['@ac3', '@ac6'] }, async ({ page, request }) => {
    // Synthetic meter inputs derived from a demo goal's own figures, stubbed onto the scenario.
    const real = await fetchScenario(request);
    const g = real.pace.goals.find((x) => x.actual && x.target);
    const used = { v: g.actual.v, src: 'calc:pace', kind: 'a', label: 'Used or reserved' };
    const limit = { v: g.target.v, src: 'calc:pace', kind: 't', label: 'Limit or plan' };
    const ratio = { v: used.v / limit.v, src: 'calc:pace', kind: 'e', label: 'Share used or reserved' };
    await page.route('**/api/scenario', async (route) => {
      const res = await route.fetch();
      const s = await res.json();
      s.pace.meters.tax = { meter: { used, limit, ratio }, reason: null, dataThrough: g.dataThrough, stale: false, deadline: s.pace.meters.tax.deadline };
      s.fig['pace.meters.tax.meter.used'] = used;
      s.fig['pace.meters.tax.meter.limit'] = limit;
      s.fig['pace.meters.tax.meter.ratio'] = ratio;
      await route.fulfill({ response: res, json: s });
    });
    await gotoRoute(page, 'pace');
    const m = page.locator('div.h-meter[data-meter="tax"]');
    await expect(m.locator('p.h-meter-none')).toHaveCount(0);
    await expect(m.locator('.fx-fig[data-fig="pace.meters.tax.meter.used"]')).toHaveCount(1);
    await expect(m.locator('.fx-fig[data-fig="pace.meters.tax.meter.limit"]')).toHaveCount(1);
    await expect(page.locator('div.h-meter[data-meter="retirement"] p.h-meter-none')).toHaveCount(1);
  });

  test('without any series the board says why instead of drawing an empty chart', { tag: ['@ac3'] }, async ({ page }) => {
    await page.route('**/api/scenario', async (route) => {
      const res = await route.fetch();
      const s = await res.json();
      for (const k of Object.keys(s.pace.series.goals)) s.pace.series.goals[k] = { series: null, dataEnd: null, reason: 'missing_plan_start' };
      s.pace.series.householdSavings = { series: null, dataEnd: null, reason: 'missing_household_savings_plan' };
      await route.fulfill({ response: res, json: s });
    });
    await gotoRoute(page, 'pace');
    await expect(page.locator('figure.h-pchart')).toHaveCount(0);
    await expect(page.locator('p.h-pchart-none')).toHaveCount(1);
    await expect(page.locator('p.h-pchart-none')).toHaveText(/\S/);
  });

  test('the freshness note repeats the data date and says later months are projected', { tag: ['@ac3'] }, async ({ page, request }) => {
    const { pace } = await fetchScenario(request);
    const ends = charts(pace).map((c) => c.dataEnd).filter(Boolean);
    await gotoRoute(page, 'pace');
    if (pace.rollup.dataThrough) await expect(board(page)).toContainText(`Data through ${fmtDay(pace.rollup.dataThrough)}`);
    if (ends.some((d) => d.slice(0, 7) < pace.clock.slice(0, 7))) await expect(board(page)).toContainText('Later months are projected.');
  });

  test('the back link returns Home', { tag: ['@ac3', '@mobile'] }, async ({ page, request }) => {
    const { pace } = await fetchScenario(request);
    await gotoRoute(page, 'pace');
    const back = page.locator('a.h-back[data-go="home"]');
    await expect(back).toContainText('Home');
    await back.click();
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.locator('h1.h-home-h')).toHaveText(pace.rollup.headline);
  });
});
