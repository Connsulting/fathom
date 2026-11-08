// Rich Ask answers, B3 and B4 (docs/plans/rich-ask-answers.md sections 2 and 5): stored table,
// compare, chart and timeline blocks drawn in an answer on the Ask page, in the docked panel (down to its 320px minimum, a
// 288px content box), in the phone sheet and in the rec dialog, in light and dark color schemes.
// The demo server's fake engine answers a real question; page.route rewrites the scenario so that
// answer carries the synthetic fixture blocks from test/fixtures/blocks. Expected labels, values
// and dates are read from those fixtures, never typed here.

import { readFileSync } from 'node:fs';
import { test, expect, resetDemo, gotoRoute, recDialog } from './helpers.mjs';
import { openScope } from '../src/storage/index.mjs';
import { mainDataDir } from './data-dir.mjs';
import { servedStore } from '../test/helpers/server.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { DROP_REASONS, dropNoteText } from '../web/core/block-notes.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/blocks/${name}.json`, import.meta.url), 'utf8'));
const TABLE = fx('table');
const COMPARE = fx('compare');
const NOTES = fx('notes');
// A stored note with a known reason shows its plain cause; any other keeps its stored text.
const noteText = (n) => (DROP_REASONS.includes(n.reason) ? dropNoteText(n.op, n.reason, n.name) : n.text);
const LINE = fx('chart-line');
const SCATTER = fx('chart-scatter');
const TIMELINE = fx('timeline');
const DRAWN = [LINE, SCATTER, TIMELINE];
const REC_ID = 'dcfsa';
const STORE_KEY = 'fathom.askPanel';

test.use({ timezoneId: 'UTC' });

const panel = (page) => page.locator('aside#h-askp.h-askp');
const blk = (scope, block) => scope.locator(`figure.h-blk[data-blk$=":${block.id}"]`);

async function postThread(request, data) {
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data });
  expect(await res.status(), 'POST /api/threads').toBe(200);
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
      last.provenance = { ...(last.provenance || {}), blocks: [TABLE, COMPARE, ...DRAWN, ...NOTES.blocks], blockNotes: NOTES.blockNotes };
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
  for (const n of NOTES.blockNotes) await expect(scope.getByText(noteText(n), { exact: true }).first()).toBeVisible();
  for (const b of DRAWN) await expect(blk(scope, b).locator('figcaption')).toHaveText(b.snapshot.title);
  await expect(blk(scope, LINE).locator('svg[role="img"]')).toHaveAttribute('aria-label', /^Line chart of /);
  await expect(blk(scope, TIMELINE).locator('ol > li')).toHaveCount(TIMELINE.snapshot.events.length);
  const vw = page.viewportSize().width;
  for (const b of [t, c, ...DRAWN.map((x) => blk(scope, x))]) {
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
    for (const b of [TABLE, COMPARE, ...DRAWN].map((x) => blk(panel(page), x))) {
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

  test('a block figure keeps its provenance in the figure registry and the popover lists its assumptions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoRoute(page, `ask/${thread.id}`);
    const c = blk(page.locator('.h-root'), COMPARE);
    await expect(c).toBeVisible();
    const target = COMPARE.snapshot.options[0].cells[0].fig;
    const fig = c.locator('section[role="group"]').first().locator('.fx-fig').first();
    const key = await fig.getAttribute('data-fig');
    expect(key).toMatch(/^blk:/);
    const stored = await page.evaluate((k) => window.Fathom.api.fig(k), key);
    expect(stored.provenance).toEqual(target.provenance);
    await fig.click();
    const pop = page.locator('.fx-pop');
    await expect(pop).toBeVisible();
    for (const a of target.provenance.assumptions) {
      await expect(pop.locator('.fx-pop-row', { hasText: 'Assumes' }).locator('.fx-pop-v')).toContainText(a.stated);
    }
  });

  test('@mobile charts: arrow keys move the active point and the live region, Enter opens the popover, Escape returns focus', async ({ page }) => {
    if (page.viewportSize().width > 400) await page.setViewportSize({ width: 1280, height: 900 });
    const s = LINE.snapshot;
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await gotoRoute(page, `ask/${thread.id}`);
      const ch = blk(page.locator('.h-root'), LINE);
      await expect(ch).toBeVisible();
      const plot = ch.locator('.h-blk-plot');
      const read = ch.locator('.h-blk-read');
      await expect(read).toHaveAttribute('aria-live', 'polite');
      await plot.focus();
      // Focus can scroll the plot under a resting pointer, which makes a hovered point active;
      // Home and Up put the first point of the first series back.
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowUp');
      await expect(read).toContainText(s.series[0].label);
      await expect(read).toContainText(s.x[0].text);
      await page.keyboard.press('ArrowRight');
      await expect(read).toContainText(s.x[1].text);
      await page.keyboard.press('ArrowDown');
      await expect(read).toContainText(s.series[1].label);
      await expect(read).toContainText(s.x[1].text);
      await page.keyboard.press('ArrowLeft');
      await expect(read).toContainText(s.x[0].text);
      await page.keyboard.press('ArrowUp');
      await expect(read).toContainText(s.series[0].label);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await expect(read).toContainText(s.series[1].label);
      await expect(read).toContainText(s.x[1].text);
      await expect(plot).toBeFocused();

      const target = s.series[1].points[1];
      await page.keyboard.press('Enter');
      const pop = page.locator('.fx-pop');
      await expect(pop).toBeVisible();
      await expect(pop.locator('.fx-pop-label')).toHaveText(target.label);
      await expect(pop.locator('.fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v')).toHaveText(target.source);
      await expect(pop.locator('.fx-pop-row', { hasText: 'As of' }).locator('.fx-pop-v')).toHaveText(target.asOf);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await expect(plot).toBeFocused();

      // The scatter moves along its points in x order.
      const sc = blk(page.locator('.h-root'), SCATTER);
      await sc.locator('.h-blk-plot').focus();
      await page.keyboard.press('End');
      const last = [...SCATTER.snapshot.points].sort((a, b) => a.x.value - b.x.value).at(-1);
      await expect(sc.locator('.h-blk-read')).toContainText(last.label);

      // The Table toggle swaps in the same values as a table, and back.
      const tog = ch.locator('button.h-blk-tog');
      await expect(tog).toHaveText('Table');
      await expect(tog).toHaveAttribute('aria-pressed', 'false');
      const ctl = await tog.getAttribute('data-blk-ctl');
      await tog.focus();
      await page.keyboard.press('Enter');
      const on = page.locator(`[data-blk-ctl="${ctl}"]`);
      await expect(on).toHaveAttribute('aria-pressed', 'true');
      await expect(on).toBeFocused();
      await expect(ch.locator('table th[scope="col"]').nth(1)).toHaveText(s.series[0].label);
      await expect(ch.locator('tbody tr')).toHaveCount(s.x.length);
      await expect(ch.locator('svg')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(on).toHaveAttribute('aria-pressed', 'false');
      await expect(ch.locator('svg[role="img"]')).toBeVisible();
      await noSidewaysScroll(page);
    }
  });

  test('@mobile the rec dialog draws the same blocks', async ({ page }) => {
    await gotoRoute(page, `rec/${REC_ID}`);
    await expect(recDialog(page)).toBeVisible();
    await expectBlocks(recDialog(page), page);
    await noSidewaysScroll(page);
  });
});

test('real builder table persists and renders in the Ask panel without response rewrites', async ({ request, page }) => {
  await resetDemo(request);
  const response = await request.post('/api/threads', { data: { text: 'Show recent transactions in a table.' } });
  expect(await response.status()).toBe(200);
  const body = await response.json();
  const block = body.message.provenance.blocks[0];
  expect(block.op).toBe('table');
  expect(block.snapshot.rows.length).toBeGreaterThan(0);
  expect(body.message.text).not.toContain('{b:');
  await page.addInitScript(([k, id]) => {
    window.localStorage.setItem(k, JSON.stringify({ open: true, width: 400, threadId: id, chips: [], page: 'home/' }));
  }, [STORE_KEY, body.thread.id]);
  await gotoRoute(page, 'home');
  const table = blk(panel(page), block);
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(block.snapshot.rows.length);
  await expect(table.locator('th[scope="col"]')).toHaveText(block.snapshot.columns.map(c => c.label));
  const amount = table.locator('tbody tr').first().locator('.fx-fig');
  await expect(amount).toBeVisible();
  const key = await amount.getAttribute('data-fig');
  const stored = await page.evaluate(k => window.Fathom.api.fig(k), key);
  expect(stored.v).toBe(block.snapshot.rows[0].cells.at(-1).value);
  await amount.click();
  await expect(page.locator('.fx-pop')).toBeVisible();
  await expect(page.locator('.fx-pop')).toContainText(block.snapshot.rows[0].cells.at(-1).row.description);
  await page.reload();
  await expect(blk(panel(page), block)).toBeVisible();
});

test('@mobile drill rows keep keyboard focus and a reopened stale block can ask its question again', async ({ request, page }) => {
  await resetDemo(request);
  const question = 'Show recent transactions in a table.';
  const response = await request.post('/api/threads', { data: { text: question } });
  expect(await response.status()).toBe(200);
  const body = await response.json();
  const db = await openScope({ path: (await servedStore(mainDataDir())).file, journal: null, busyTimeout: 5000 });
  let block;
  try {
    const args = { operation: 'total', groupBy: 'category', from: '2026-01', to: '2026-10' };
    const result = await callTool('spending', args, { db, clock: '2026-11-05' });
    const spec = { source: { tool: 'spending', args, path: 'groups' }, columns: ['key', 'figure'] };
    block = { id: 'b1', op: 'table', spec, calls: [{ tool: 'spending', args }],
      snapshot: buildSnapshot('table', spec, [{ name: 'spending', args, result }]), asOf: result.total.asOf, builtAt: '2026-11-05T00:00:00Z', after: 1 };
    await db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify({ ...body.message.provenance, blocks: [block] }), body.message.id.slice(1));
  } finally { await db.close(); }
  let statusReads = 0;
  page.on('request', req => { if (req.url().endsWith(`/api/threads/${body.thread.id}/blocks`)) statusReads++; });
  await gotoRoute(page, `ask/${body.thread.id}`);
  const table = blk(page.locator('.h-root'), block);
  const button = table.getByRole('button', { name: 'Show rows', exact: true }).first();
  await expect(button).toBeVisible();
  await button.focus(); await page.keyboard.press('Enter');
  const heading = table.getByRole('heading', { name: 'Rows behind this figure' });
  await expect(heading).toBeFocused();
  const region = table.getByRole('region', { name: 'Rows behind this figure' });
  await expect(region).toContainText('Rows sum');
  await expect(region.locator('li')).not.toHaveCount(0);
  await expect(heading).toBeFocused();
  await region.locator('li .fx-fig').first().click();
  await expect(page.locator('.fx-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await heading.focus(); await page.keyboard.press('Escape');
  await expect(heading).toHaveCount(0); await expect(button).toBeFocused();
  expect(statusReads).toBe(1);
  await noSidewaysScroll(page);

  const changed = await openScope({ path: (await servedStore(mainDataDir())).file, journal: null, busyTimeout: 5000 });
  try {
    const source = block.snapshot.rows[0].cells[1].fig.provenance.sources[0].ids[0];
    const row = await changed.prepare('SELECT * FROM transactions WHERE id = ?').get(source);
    await changed.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)').run(row.account_id, '2026-10-15', row.amount, row.description);
  } finally { await changed.close(); }
  await page.reload();
  await expect(table).toContainText('Stale');
  await expect(table).toContainText('Your data changed after this answer.');
  const storedFigure = table.locator('tbody tr').first().locator('.fx-fig').first();
  const originalValue = await page.evaluate(k => window.Fathom.api.fig(k).v, await storedFigure.getAttribute('data-fig'));
  expect(originalValue).toBe(block.snapshot.rows[0].cells[1].fig.value);
  await storedFigure.click();
  await expect(page.locator('.fx-pop')).toContainText('Changed since this answer');
  await page.keyboard.press('Escape');
  const asked = page.waitForRequest(req => req.url().endsWith('/api/ask') && req.method() === 'POST');
  await table.getByRole('button', { name: 'Ask again', exact: true }).click();
  expect((await asked).postDataJSON()).toMatchObject({ key: body.thread.key, text: question });
  await expect.poll(async () => (await (await request.get(`/api/threads/${body.thread.id}`)).json()).messages.filter(m => m.role === 'me').length).toBe(2);
});
