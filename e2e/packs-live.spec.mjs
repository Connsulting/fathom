// Live knowledge packs (item 6): demo pack rows are backed by the repository manifests, so the
// pack page shows version, tax year and reviewed date, opens real entries with their citations,
// runs What if as a conversation with Sources, and notes when a toggle takes effect.
// Expected values come from the repository manifests and demo/scenario.mjs, never literals.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, S, resetDemo, plain, gotoRoute, expectH1, bareDollarNodes } from './helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOGGLE_NOTE = 'Recommendations update on the next planning run.';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Demo pack row id to repository manifest directory (plan D7).
const MANIFEST_OF = { scorp: 's-corp-owner', giving: 'charitable-giving' };

function manifest(rowId) {
  const dir = MANIFEST_OF[rowId];
  return { dir, m: JSON.parse(readFileSync(join(REPO, 'packs', dir, 'manifest.json'), 'utf8')) };
}

function entryId(e) {
  return e.file.replace(/^.*\//, '').replace(/\.md$/, '');
}

function entryText(dir, e) {
  return readFileSync(join(REPO, 'packs', dir, e.file), 'utf8');
}

// A plain prefix of the first prose paragraph (no markdown, no amounts) to find in the body.
function prosePrefix(text) {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|Tax year:|Reviewed:|Sources:)/.test(p));
  return para.split(/[$[*_`(]/)[0].trim().slice(0, 40).trim();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The reviewed date as the ISO date or a month name form (Nov 5, 2026 or November 5, 2026).
function reviewedPattern(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const forms = [iso, `${MON[mo - 1]} ${d}, ${y}`, `${MONTH[mo - 1]} ${d}, ${y}`].map(esc);
  return new RegExp(`Reviewed\\s+(${forms.join('|')})`);
}

function demoPack(id) {
  const p = S.packs.find((x) => x.id === id);
  if (!p) throw new Error(`no pack ${id} in demo/scenario.mjs`);
  return p;
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

for (const id of Object.keys(MANIFEST_OF)) {
  test(`#/packs/${id} shows the manifest version, tax year and reviewed date`, async ({ page }) => {
    const { m } = manifest(id);
    await gotoRoute(page, `packs/${id}`);
    await expectH1(page, plain(demoPack(id).name));
    const meta = page.locator('.h-pack-meta');
    await expect(meta).toBeVisible();
    await expect(meta).toContainText(`Version ${m.version}`);
    await expect(meta).toContainText(`Tax year ${m.taxYear}`);
    await expect(meta).toContainText(reviewedPattern(m.reviewed));

    const buttons = page.locator(`.h-entries button.h-entry[data-pack="${id}"]`);
    await expect(buttons).toHaveCount(m.entries.length);
    await expect(buttons.first()).toHaveAttribute('data-entry', entryId(m.entries[0]));
    await expect(buttons.first()).toHaveText(m.entries[0].title);
  });
}

test('opening a pack entry shows its body and citations', async ({ page }) => {
  const id = 'giving';
  const { dir, m } = manifest(id);
  // An entry with a dollar amount, so the body also proves amounts render as law figures.
  const e = m.entries.find((x) => /\$[0-9]/.test(entryText(dir, x))) || m.entries[0];

  await gotoRoute(page, `packs/${id}`);
  await expectH1(page, plain(demoPack(id).name));
  await page.locator(`button.h-entry[data-pack="${id}"][data-entry="${entryId(e)}"]`).click();

  const body = page.locator('.h-entry-body');
  await expect(body).toBeVisible();
  const prefix = prosePrefix(entryText(dir, e));
  expect(prefix.length, 'a prose prefix to look for').toBeGreaterThan(10);
  await expect(body).toContainText(prefix);
  await expect(body.locator('script')).toHaveCount(0);

  const cites = page.locator('.h-entry-cites li');
  await expect(cites).toHaveCount(e.cites.length);
  for (const [i, c] of e.cites.entries()) {
    await expect(cites.nth(i)).toContainText(c.label);
    await expect(cites.nth(i).locator(`a[href="${c.url}"]`)).toHaveCount(1);
  }

  expect(await bareDollarNodes(page)).toEqual([]);
});

test('What if on giving runs a conversation with Sources, and the pack composer adds a follow-up', async ({ page }) => {
  const id = 'giving';
  const p = demoPack(id);
  expect(p.status, 'giving is not on in the demo, so What if is offered').not.toBe('active');

  await gotoRoute(page, `packs/${id}`);
  await expectH1(page, plain(p.name));
  await page.getByRole('button', { name: 'What if', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/packs/${id}$`));

  const answers = page.locator('.h-thread .h-msg.fathom');
  await expect(answers).toHaveCount(1);
  const first = answers.last();
  await expect(first).not.toHaveClass(/\bnotice\b/);
  const src = first.locator('details.h-src');
  await expect(src).toHaveCount(1);
  await src.locator('summary').click();
  await expect(src).toHaveAttribute('open', '');
  await expect(src.locator('li.h-src-tool').first()).toBeVisible();

  const form = page.locator(`form.h-compose[data-free="pack:${id}"]`);
  await expect(form).toBeVisible();
  const text = 'Would bunching our gifts change anything for us';
  await form.locator('input[name="q"]').fill(text);
  await form.locator('input[name="q"]').press('Enter');
  await expect(answers).toHaveCount(2);
  await expect(page.locator('.h-thread .h-msg.me').last()).toContainText(text);
  await expect(answers.last().locator('details.h-src')).toHaveCount(1);

  // The conversation is stored under the pack key.
  await page.reload();
  await expect(answers).toHaveCount(2);
});

test('Turn this pack on shows the planning run note, and it stays after reload', async ({ page }) => {
  const id = 'giving';
  await gotoRoute(page, `packs/${id}`);
  await expectH1(page, plain(demoPack(id).name));
  await expect(page.locator('.h-pack-note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn this pack on', exact: true }).first().click();

  const note = page.locator('.h-pack-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(TOGGLE_NOTE);
  await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator('.h-pack-note')).toContainText(TOGGLE_NOTE);
});
