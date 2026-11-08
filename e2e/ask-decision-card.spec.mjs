// AB1: the invoice-deferral decision card (the deferral starter's compare block) shows formatted
// figures, never a stored figure token, and fits its column from a phone to a desktop width: no
// sideways scroll, nothing past the card's edges, and no field label overlapping its value. The demo
// never runs the planner, so the spec plants synthetic stored war-game figures in the served store
// first, which makes every option carry values the way a planned household's do.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, resetDemo, gotoRoute } from './helpers.mjs';
import { mainDataDir } from './data-dir.mjs';
import { servedStore } from '../test/helpers/server.mjs';
import { buildScenario } from '../src/scenario/build.mjs';

const FIELDS = ['amount', 'net', 'decCash', 'need', 'gap', 'tax2026', 'tax2027'];
// Labels in the planner's shape, "<option label>: <what it is>" (src/jobs/planner/wargame.mjs).
const LABELS = { amount: 'amount moved to January', net: 'net tax change', decCash: 'December business cash',
  need: 'December payroll need', gap: 'December need less cash', tax2026: 'this year tax change', tax2027: 'next year tax change' };
function plantDeferral() {
  const db = new DatabaseSync(servedStore(mainDataDir()).file);
  try {
    const { wargame } = buildScenario(db);
    const put = db.prepare(`INSERT OR REPLACE INTO figures (key, v, kind, label, parser, updated_at) VALUES (?, ?, 'm', ?, 'planner', '2026-11-05')`);
    wargame.deferral.options.forEach((o, i) => FIELDS.forEach((field, j) => put.run(`wg.deferral.${o.id}.${field}`, 1000 * (i + 1) + 10 * j, `${o.label}: ${LABELS[field]}`)));
    put.run('wg.deferral.base.income', 5000, 'income');
  } finally { db.close(); }
}

for (const width of [390, 1280]) test(`the deferral decision card shows figures and fits at ${width}px`, async ({ page, request }, testInfo) => {
  await resetDemo(request);
  plantDeferral();
  const res = await request.post('/api/threads', { data: { questionId: 'wargame-deferral' } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const [block] = body.message.provenance.blocks;
  expect(block.op).toBe('compare');
  const values = block.snapshot.options.flatMap(o => o.cells).map(c => c.fig?.value ?? null);
  expect(values.some(v => v !== null), 'the stored options carry values').toBe(true);
  expect(JSON.stringify(block.snapshot)).not.toContain('{f:');

  await page.setViewportSize({ width, height: 900 });
  await gotoRoute(page, `ask/${body.thread.id}`);
  const card = page.locator('figure.h-blk-compare').first();
  await expect(card).toBeVisible();

  expect(await page.evaluate(() => document.body.innerText)).not.toContain('{f:');
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, 'the page never scrolls sideways').toBeLessThanOrEqual(cw);

  const fit = await card.evaluate((fig) => {
    const box = fig.getBoundingClientRect();
    const outside = [];
    for (const el of fig.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right > box.right + 1 || r.left < box.left - 1) outside.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)} in ${Math.round(box.left)}..${Math.round(box.right)}`);
    }
    const overlaps = [];
    for (const row of fig.querySelectorAll('.h-blk-cf')) {
      const dt = row.querySelector('dt').getBoundingClientRect();
      const dd = row.querySelector('dd').getBoundingClientRect();
      if (!(dt.right <= dd.left + 1 || dd.top >= dt.bottom - 1)) overlaps.push(`${row.querySelector('dt').textContent} / ${row.querySelector('dd').textContent}`);
    }
    return { outside, overlaps, scroll: [fig.scrollWidth, fig.clientWidth] };
  });
  expect(fit.outside, 'nothing past the card edges').toEqual([]);
  expect(fit.overlaps, 'no label overlaps its value').toEqual([]);
  expect(fit.scroll[0], 'the card never scrolls sideways').toBeLessThanOrEqual(fit.scroll[1]);

  // Rows are labeled by what each figure is, never by the generic source name.
  await expect(card.locator('.h-blk-cf dt').filter({ hasText: /^your plan$/i })).toHaveCount(0);
  const sections = card.locator('section[role="group"]');
  await expect(sections).toHaveCount(block.snapshot.options.length);
  for (let i = 0; i < block.snapshot.options.length; i += 1) {
    await expect(sections.nth(i).locator('.h-blk-cf dd .fx-fig')).toHaveCount(block.snapshot.fields.length);
  }

  // A tall viewport keeps the sticky header and composer off the card in the screenshots.
  await page.setViewportSize({ width, height: 2400 });
  await page.waitForLoadState('networkidle');
  await expect(card).toBeVisible();
  const dir = resolve('test-results/ab1');
  mkdirSync(dir, { recursive: true });
  await card.screenshot({ path: testInfo.outputPath(`decision-card-${width}.png`) });
  await card.screenshot({ path: resolve(dir, `decision-card-${width}.png`) });
});
