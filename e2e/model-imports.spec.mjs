// Conversational import review on Files: a first-use layout proposal shows one sourced summary and
// imports on "Looks right", a repeat of the approved layout imports with the engine paused and no
// prompt, a changed layout asks only its delta, a plain correction waits for the engine, a scan
// asks for readable text, and the review row stays usable at phone width. Every value is synthetic;
// the only faked component is the engine's interpretation response.

import { createHash } from 'node:crypto';
import { test as plainTest } from '@playwright/test';
import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';
import { getSetting, setSetting } from '../src/store/db.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { indexSource } from '../src/ingest/model-source.mjs';
import { applyLayout } from '../src/ingest/model-layout.mjs';
import { ingestFile } from '../src/ingest/pipeline.mjs';
import { recipe } from '../test/helpers/model-import.mjs';

test.skip(REMOTE, 'requires a local synthetic store');

const NOW = '2032-03-10T12:00:00.000Z';
const HEADER = 'Account,Date,Amount USD,Description';
const firstCsv = (account) => `${HEADER}\n${account},2032-03-02,-12.25,Synthetic purchase\n${account},2032-03-03,2.25,Synthetic refund\nTotal,,-10.00,Control total\n`;
const repeatCsv = (account) => `${HEADER}\n${account},2032-03-05,-20.50,Synthetic repeat purchase\n${account},2032-03-06,5.50,Synthetic repeat refund\nTotal,,-15.00,Control total\n`;
// The first file's two detail rows plus one more, with an updated total: overlaps the first file.
const overlapCsv = (account) => `${HEADER}\n${account},2032-03-02,-12.25,Synthetic purchase\n${account},2032-03-03,2.25,Synthetic refund\n${account},2032-03-04,-3.00,Synthetic extra purchase\nTotal,,-13.00,Control total\n`;
const referenceCsv = (account) => `${HEADER},Reference\n${account},2032-03-07,-7.25,Synthetic delta purchase,Synthetic ref A\nTotal,,-7.25,Control total,\n`;

const pathOf = (r) => new URL(r.url()).pathname;
const row = (page, fileId) => page.locator(`[data-proposal-file="${fileId}"]`);

test.beforeEach(async ({ request }) => { await resetDemo(request); });
test.afterEach(async ({ request }) => { await resetDemo(request); });

// Stage a first-use layout proposal for a synthetic CSV on the first live demo account, through the
// real pipeline with a fake-mode engine whose single response is the layout's interpretation.
async function seed({ csv = firstCsv, name = 'synthetic-first.csv' } = {}) {
  return withLocalHousehold(NOW, async (s) => {
    const account = (await s.db.prepare('SELECT id FROM accounts WHERE archived_at IS NULL ORDER BY rowid LIMIT 1').get()).id;
    const previous = await getSetting(s.db, 'engine', null);
    await setSetting(s.db, 'engine', { on: true });
    try {
      const bytes = Buffer.from(csv(account));
      const fileId = 'f-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      const layout = recipe();
      const proposal = applyLayout(await indexSource({ fileId, bytes, name, format: 'csv' }), layout);
      const script = { text: JSON.stringify({ rows: proposal.rows, coverage: proposal.coverage, completeness: proposal.completeness, controls: proposal.controls, layout }),
        costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } };
      const engine = await createRuntimeEngine({ db: s.db, config: { engine: 'fake' }, allowed: () => true });
      const out = await ingestFile(s.db, { name, bytes, mime: 'text/csv' },
        { ...s.opts(null), household: { ...s.household, engine, funded: () => true }, actorId: 'demo', fake: [script] });
      return { account, fileId, proposalId: out.proposalId, version: out.version, status: out.status };
    } finally {
      if (previous == null) await s.db.prepare("DELETE FROM settings WHERE key = 'engine'").run();
      else await setSetting(s.db, 'engine', previous);
    }
  });
}

async function chooseFile(page, opener, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), opener.click()]);
  const uploaded = page.waitForResponse((r) => pathOf(r) === '/api/files' && r.request().method() === 'POST');
  await chooser.setFiles(file);
  const res = await uploaded;
  expect(res.status()).toBe(200);
  return (await res.json()).files[0];
}

const waitingOf = async (request, fileId) => (await (await request.get('/api/scenario')).json()).live.ingest.waiting.find((f) => f.id === fileId);

test('first approval imports, a repeat of the layout imports with the engine paused and no prompt, and Undo works', async ({ page, request }) => {
  const seeded = await seed();
  expect(seeded.status).toBe('needs_confirmation');
  const waiting = await waitingOf(request, seeded.fileId);
  expect(waiting.proposal.status).toBe('needs_confirmation');
  expect(waiting.proposal.summary.amount).toBe(-10);
  const rows = waiting.proposal.counts.rows.transaction;
  expect(rows).toBe(2);

  await gotoRoute(page, 'add');
  const r = row(page, seeded.fileId);
  await expect(r.locator('[data-proposal-status]')).toHaveText('Ready for review');
  await expect(r.locator('[data-proposal-cause]')).toHaveText('Nothing is imported until you approve.');
  const summary = r.locator('[data-proposal-summary]');
  await expect(summary).toContainText(`${rows} transactions`);
  await expect(summary).toContainText(`-$${Math.abs(waiting.proposal.summary.amount)} in total.`);
  await expect(summary).toContainText(`${waiting.proposal.summary.totalMessage}.`);

  await r.locator('[data-proposal-source] > summary').click();
  for (const c of waiting.proposal.columns) await expect(r.locator('[data-proposal-source]')).toContainText(`Column ${c.ordinal}, ${c.label}:`);
  await expect(r.locator('[data-proposal-source]')).toContainText('Every count and amount above comes from cells in this file.');

  const reviewed = page.waitForResponse((res) => pathOf(res) === `/api/import-proposals/${seeded.proposalId}/review`);
  await r.locator('[data-proposal-approve]').click();
  const done = await reviewed;
  expect(done.status()).toBe(200);
  expect((await done.json()).status).toBe('imported');
  const note = page.locator('[data-review-note]').first();
  await expect(note).toContainText(`Imported ${rows} transactions.`);
  await expect(note.locator('[data-review-undo]')).toBeVisible();
  await expect(row(page, seeded.fileId)).toHaveCount(0);

  expect((await request.post('/api/engine', { data: { on: false } })).status()).toBe(200);
  const repeat = await chooseFile(page, page.locator('.h-ing-add [data-upload-open]'),
    { name: 'synthetic-repeat.csv', mimeType: 'text/csv', buffer: Buffer.from(repeatCsv(seeded.account)) });
  expect(repeat.status).toBe('imported');
  expect(repeat.receipt?.id).toBeTruthy();
  await expect(row(page, repeat.fileId)).toHaveCount(0);
  await expect(page.getByText('Ready for review', { exact: true })).toHaveCount(0);
  const calls = await withLocalHousehold(NOW, async (s) => (await s.db.prepare('SELECT count(*) n FROM import_model_spend WHERE file_id=?').get(repeat.fileId)).n);
  expect(calls).toBe(0);

  const undo = page.locator(`.h-ing-add [data-review-undo="${repeat.receipt.id}"]`);
  await expect(undo).toBeVisible();
  const undone = page.waitForResponse((res) => pathOf(res) === `/api/actions/${repeat.receipt.id}/undo`);
  await undo.click();
  expect((await undone).status()).toBe(200);
  await expect(page.locator('[data-review-note]').first()).toContainText('Undone.');
});

test('a changed layout asks only the delta and a plain correction waits for the engine', async ({ page, request }) => {
  const seeded = await seed();
  const approved = await request.post(`/api/import-proposals/${seeded.proposalId}/review`,
    { data: { version: seeded.version, decision: 'approve', evidence: 'Looks right' } });
  expect(approved.status()).toBe(200);
  expect((await approved.json()).status).toBe('imported');
  expect((await request.post('/api/engine', { data: { on: false } })).status()).toBe(200);

  await gotoRoute(page, 'add');
  const changed = await chooseFile(page, page.locator('.h-ing-add [data-upload-open]'),
    { name: 'synthetic-reference.csv', mimeType: 'text/csv', buffer: Buffer.from(referenceCsv(seeded.account)) });
  expect(['needs_confirmation', 'needs_clarification']).toContain(changed.status);
  const r = row(page, changed.fileId);
  // Header labels are stored normalized (lower case), so the column name is matched without case.
  await expect(r.locator('[data-proposal-delta], [data-proposal-question]').first())
    .toHaveText(/^Only this changed since you approved this layout: a new column appeared: reference\.$/i);
  await expect(r.locator('input:not([type=file])')).toHaveCount(0);
  await expect(r.locator('select')).toHaveCount(0);

  await r.locator('textarea[data-proposal-text]').fill("Not quite: Reference is the bank's reference number");
  const reviewed = page.waitForResponse((res) => pathOf(res).startsWith('/api/import-proposals/') && pathOf(res).endsWith('/review'));
  await r.locator('[data-proposal-correct]').click();
  const done = await reviewed;
  expect(done.status()).toBe(200);
  expect((await done.json()).status).toBe('waiting_for_engine');
  await expect(r.locator('[data-proposal-status]')).toHaveText('Waiting for the engine');
  await expect(r.locator('[data-proposal-cause]')).toHaveText('Your correction is saved. Waiting for the engine to read the file again.');
  await expect(page.locator('[data-review-note]').first()).toContainText('Correction saved.');
  const engine = r.locator('[data-proposal-engine]');
  await expect(engine).toHaveText('Turn on the engine');
  await engine.click();
  await expect(page).toHaveURL(/#\/engine$/);
  await expect(page.locator('[data-fx-engine]').first()).toBeVisible();
});

test('a scan with no text asks for readable text with a working Add files control', async ({ page }) => {
  await gotoRoute(page, 'add');
  const scan = await chooseFile(page, page.locator('.h-ing-add [data-upload-open]'),
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF') });
  expect(scan.status).toBe('needs_source_text');
  const r = row(page, scan.fileId);
  await expect(r.locator('[data-proposal-status]')).toHaveText('Needs readable text');
  await expect(r.locator('[data-proposal-cause]')).toHaveText('File saved. It has no readable text; add a text export or a PDF with selectable text.');
  const add = r.locator('[data-upload-open]');
  await expect(add).toHaveText('Add files');
  await expect(r.locator('input[type=file][data-upload]')).toHaveCount(1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()]);
  expect(chooser.isMultiple()).toBe(true);
});

test('review row keeps summary, status, source and Undo visible @mobile', async ({ page }, testInfo) => {
  const seeded = await seed();
  await gotoRoute(page, 'add');
  const width = page.viewportSize().width;
  const inside = async (locator) => {
    await expect(locator).toBeVisible();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  };
  const r = row(page, seeded.fileId);
  await inside(r.locator('[data-proposal-status]'));
  await inside(r.locator('[data-proposal-summary]'));
  await inside(r.locator('[data-proposal-source] > summary'));
  await inside(r.locator('[data-proposal-approve]'));
  await inside(r.locator('textarea[data-proposal-text]'));
  await page.screenshot({ path: testInfo.outputPath(`review-before-${testInfo.project.name}.png`), fullPage: true });

  // Confirm's Waiting files shows the same pending row; compare it with the Confirm layout.
  await gotoRoute(page, 'confirm');
  const side = page.locator('.h-col-side').locator(`[data-proposal-file="${seeded.fileId}"]`);
  await expect(side.locator('[data-proposal-status]')).toHaveText('Ready for review');
  await expect(side.locator('[data-proposal-summary]')).toBeVisible();
  await expect(side.locator('[data-proposal-source] > summary')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`confirm-compare-${testInfo.project.name}.png`), fullPage: true });

  await gotoRoute(page, 'add');
  const reviewed = page.waitForResponse((res) => pathOf(res) === `/api/import-proposals/${seeded.proposalId}/review`);
  await r.locator('[data-proposal-approve]').click();
  expect((await reviewed).status()).toBe(200);
  await inside(page.locator('[data-review-note] [data-review-undo]').first());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`review-after-${testInfo.project.name}.png`), fullPage: true });
});

// The plain fixture: the browser logs the real 409 as a console error, which the shared fixture
// treats as a failure.
plainTest('a stale summary is restaged with its current counts and approves on the second try', async ({ page, request }) => {
  plainTest.skip(REMOTE, 'requires a local synthetic store');
  const first = await seed();
  const overlap = await seed({ csv: overlapCsv, name: 'synthetic-overlap.csv' });
  expect([first.status, overlap.status]).toEqual(['needs_confirmation', 'needs_confirmation']);
  const approved = await request.post(`/api/import-proposals/${first.proposalId}/review`,
    { data: { version: first.version, decision: 'approve', evidence: 'Looks right' } });
  expect(approved.status()).toBe(200);

  await gotoRoute(page, 'add');
  const r = row(page, overlap.fileId);
  const answers = [];
  page.on('response', (res) => {
    if ([`/api/import-proposals/${overlap.proposalId}/review`, `/api/files/${overlap.fileId}/retry`].includes(pathOf(res))) answers.push([pathOf(res), res.status()]);
  });
  const retried = page.waitForResponse((res) => pathOf(res) === `/api/files/${overlap.fileId}/retry`);
  await r.locator('[data-proposal-approve]').click();
  expect((await retried).status()).toBe(200);
  expect(answers).toEqual([[`/api/import-proposals/${overlap.proposalId}/review`, 409], [`/api/files/${overlap.fileId}/retry`, 200]]);
  await expect(page.locator('[data-review-note]').first()).toHaveText('This file changed since its summary was written. Here is the current one.');
  const current = await waitingOf(request, overlap.fileId);
  expect(current.proposal.version).toBeGreaterThan(overlap.version);
  expect(current.proposal.status).toBe('needs_confirmation');
  await expect(r.locator('[data-proposal-approve]')).toHaveAttribute('data-version', String(current.proposal.version));
  await expect(r.locator('[data-proposal-summary]')).toContainText('duplicate');

  const reviewed = page.waitForResponse((res) => pathOf(res) === `/api/import-proposals/${overlap.proposalId}/review`);
  await r.locator('[data-proposal-approve]').click();
  const done = await reviewed;
  expect(done.status()).toBe(200);
  expect((await done.json()).status).toBe('imported');
  await expect(page.locator('[data-review-note]').first()).toContainText('Imported');
  await expect(page.locator('.fx-err')).toHaveCount(0);
});
