// Rich Ask answers, B3 (docs/plans/rich-ask-answers.md sections 2 and 5): stored table and compare
// blocks drawn in an answer on the Ask page, in the docked panel (down to its 320px minimum, a
// 288px content box), in the phone sheet and in the rec dialog, in light and dark color schemes.
// The demo server's fake engine answers a real question; page.route rewrites the scenario so that
// answer carries the synthetic fixture blocks from test/fixtures/blocks. Expected labels, values
// and dates are read from those fixtures, never typed here.

import { readFileSync } from 'node:fs';
import { test, expect, resetDemo, gotoRoute, recDialog } from './helpers.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/blocks/${name}.json`, import.meta.url), 'utf8'));
const TABLE = fx('table');
const COMPARE = fx('compare');
const NOTES = fx('notes');
const REC_ID = 'dcfsa';
const STORE_KEY = 'fathom.askPanel';

test.use({ timezoneId: 'UTC' });

const panel = (page) => page.locator('aside#h-askp.h-askp');
const blk = (scope, block) => scope.locator(`figure.h-blk[data-blk$=":${block.id}"]`);

async function postThread(request, data) {
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data });
  expect(res.status(), 'POST /api/threads').toBe(200);
  return (await res.json()).thread;
}

// Every GET /api/scenario answers with the real scenario, the last Fathom message of each named
// thread carrying the fixture blocks and notes.
async function withBlocks(page, threads) {
  await page.route('**/api/scenario', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    const convs = body.live?.conversations || {};
    for (const th of threads) {
      const list = convs[th.key] || [];
      const last = [...list].reverse().find((m) => m.role === 'fathom');
      if (!last) continue;
      last.provenance = { ...(last.provenance || {}), blocks: [TABLE, COMPARE, ...NOTES.blocks], blockNotes: NOTES.blockNotes };
    }
    await route.fulfill({ response: res, json: body });
  });
}

async function noSidewaysScroll(page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, 'the page never scrolls sideways').toBeLessThanOrEqual(cw);
}

// Both blocks are drawn with their titles, labels and the notes; each fits inside its column.
async function expectBlocks(scope, page) {
  const t = blk(scope, TABLE);
  const c = blk(scope, COMPARE);
  await expect(t).toBeVisible();
  await expect(c).toBeVisible();
  await expect(t.locator('figcaption')).toHaveText(TABLE.snapshot.title);
  await expect(c.locator('figcaption')).toHaveText(COMPARE.snapshot.title);
  await expect(t.locator('th[scope="col"]')).toHaveText(TABLE.snapshot.columns.map((x) => x.label));
  await expect(c.locator('section[role="group"] h4')).toHaveText(COMPARE.snapshot.options.map((o) => o.label));
  for (const n of NOTES.blockNotes) await expect(scope.getByText(n.text, { exact: true }).first()).toBeVisible();
  const vw = page.viewportSize().width;
  for (const b of [t, c]) {
    const box = await b.boundingBox();
    expect(box.x, 'block starts on screen').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'block ends on screen').toBeLessThanOrEqual(vw + 0.5);
  }
}

test.describe('ask blocks', () => {
  let thread;
  let recThread;

  test.beforeEach(async ({ request, page }) => {
    await resetDemo(request);
    thread = await postThread(request, { text: 'Synthetic question about spending by category' });
    recThread = await postThread(request, { recId: REC_ID, text: 'Synthetic question about this recommendation' });
    await withBlocks(page, [thread, recThread]);
  });

  test('@mobile the Ask page draws the table and compare in light and dark with no sideways scroll', async ({ page }) => {
    if (page.viewportSize().width > 400) await page.setViewportSize({ width: 1280, height: 900 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await gotoRoute(page, `ask/${thread.id}`);
      const main = page.locator('.h-root .h-askx-main');
      await expectBlocks(main, page);
      await noSidewaysScroll(page);
    }
  });

  test('@mobile the panel draws the blocks at 1280px (docked) and 390px (sheet), light and dark', async ({ page }) => {
    await page.addInitScript(([k, id]) => {
      try { window.localStorage.setItem(k, JSON.stringify({ open: true, width: 400, threadId: id, chips: [], page: 'home/' })); } catch { /* storage blocked */ }
    }, [STORE_KEY, thread.id]);
    if (page.viewportSize().width > 400) await page.setViewportSize({ width: 1280, height: 900 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await gotoRoute(page, 'home');
      await expect(panel(page)).toBeVisible();
      await expectBlocks(panel(page), page);
      await noSidewaysScroll(page);
    }
  });

  test('the docked panel at its 320px minimum keeps every block inside the 288px content box', async ({ page }) => {
    await page.addInitScript(([k, id]) => {
      try { window.localStorage.setItem(k, JSON.stringify({ open: true, width: 320, threadId: id, chips: [], page: 'home/' })); } catch { /* storage blocked */ }
    }, [STORE_KEY, thread.id]);
    await page.setViewportSize({ width: 1040, height: 900 });
    await gotoRoute(page, 'home');
    await expect(panel(page)).toBeVisible();
    const pb = await panel(page).boundingBox();
    expect(Math.round(pb.width)).toBe(320);
    await expectBlocks(panel(page), page);
    for (const b of [blk(panel(page), TABLE), blk(panel(page), COMPARE)]) {
      const box = await b.boundingBox();
      expect(box.width, 'block fits the 288px content box').toBeLessThanOrEqual(288.5);
      expect(box.x).toBeGreaterThanOrEqual(pb.x);
      expect(box.x + box.width).toBeLessThanOrEqual(pb.x + pb.width);
    }
    // The table scrolls inside its own container, never the panel.
    const tw = blk(panel(page), TABLE).locator('.h-blk-tw');
    await expect(tw).toHaveAttribute('tabindex', '0');
    const [psw, pcw] = await panel(page).locator('.h-askp-body').evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(psw).toBeLessThanOrEqual(pcw);
    // Sorting works from the keyboard in the panel and keeps focus on the sort button.
    const sortBtn = blk(panel(page), TABLE).locator('th[scope="col"]').nth(1).locator('button');
    await sortBtn.focus();
    await page.keyboard.press('Enter');
    await expect(blk(panel(page), TABLE).locator('th[scope="col"]').nth(1)).toHaveAttribute('aria-sort', /ascending|descending/);
    const ctl = await blk(panel(page), TABLE).locator('th[scope="col"]').nth(1).locator('button').getAttribute('data-blk-ctl');
    await expect(page.locator(`[data-blk-ctl="${ctl}"]`)).toBeFocused();
  });

  test('sort buttons work by keyboard, reorder the rows and keep focus; the filter narrows the rows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoRoute(page, `ask/${thread.id}`);
    const t = blk(page.locator('.h-root'), TABLE);
    await expect(t).toBeVisible();
    const th = t.locator('th[scope="col"]').nth(1);
    await expect(th).toHaveAttribute('aria-sort', 'none');
    const ctl = await th.locator('button').getAttribute('data-blk-ctl');
    const names = TABLE.snapshot.rows.map((r) => r.cells[0].text);
    const spent = TABLE.snapshot.rows.map((r) => r.cells[1].fig.value);
    const order = (dir) => names.map((n, i) => [n, spent[i]])
      .sort((a, b) => (a[1] === null) - (b[1] === null) || (dir === 'asc' ? a[1] - b[1] : b[1] - a[1])).map((x) => x[0]);
    const firstCol = t.locator('tbody tr > :first-child');

    await th.locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(t.locator('th[scope="col"]').nth(1)).toHaveAttribute('aria-sort', 'ascending');
    await expect(firstCol).toHaveText(order('asc'));
    await expect(page.locator(`[data-blk-ctl="${ctl}"]`)).toBeFocused();

    await page.keyboard.press('Space');
    await expect(t.locator('th[scope="col"]').nth(1)).toHaveAttribute('aria-sort', 'descending');
    await expect(firstCol).toHaveText(order('desc'));
    await expect(page.locator(`[data-blk-ctl="${ctl}"]`)).toBeFocused();

    const filter = t.getByRole('searchbox');
    await expect(filter).toHaveAccessibleName(/filter/i);
    const target = names[0];
    await filter.click();
    await page.keyboard.type(target.slice(0, 4));
    await expect(firstCol).toHaveText(names.filter((n) => n.toLowerCase().includes(target.slice(0, 4).toLowerCase())));
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue(target.slice(0, 4));
  });

  test('the popover on a block figure shows its source, as-of date and a unit-formatted value', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoRoute(page, `ask/${thread.id}`);
    const t = blk(page.locator('.h-root'), TABLE);
    await expect(t).toBeVisible();
    const row = TABLE.snapshot.rows[0];
    const ratio = row.cells[2].fig;
    expect(ratio.unit).toBe('ratio');
    await t.locator('tbody tr').first().locator('td').nth(2).locator('.fx-fig').click();
    const pop = page.locator('.fx-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.fx-pop-label')).toHaveText(ratio.label);
    await expect(pop.locator('.fx-pop-val')).toHaveText(`${Number((ratio.value * 100).toPrecision(6))}%`);
    await expect(pop.locator('.fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v')).toHaveText(ratio.source);
    await expect(pop.locator('.fx-pop-row', { hasText: 'As of' }).locator('.fx-pop-v')).toHaveText(ratio.asOf);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    // An unavailable figure reads Unavailable with its gap message.
    const gi = TABLE.snapshot.rows.findIndex((r) => r.cells[1].t === 'none');
    const gap = TABLE.snapshot.rows[gi].cells[1].fig;
    const cell = t.locator('tbody tr').nth(gi).locator('td').nth(1).locator('.fx-fig');
    await expect(cell).toHaveText('Unavailable');
    await cell.focus();
    await page.keyboard.press('Enter');
    await expect(pop.locator('.fx-pop-val')).toHaveText('Unavailable');
    await expect(pop).toContainText(gap.gaps[0].message);
  });

  test('@mobile the rec dialog draws the same blocks', async ({ page }) => {
    await gotoRoute(page, `rec/${REC_ID}`);
    await expect(recDialog(page)).toBeVisible();
    await expectBlocks(recDialog(page), page);
    await noSidewaysScroll(page);
  });
});
