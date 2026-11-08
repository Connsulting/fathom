// H1 AC3: a failed import recovers from Files. A synthetic aggregator CSV is ingested into the served
// demo household through the real ingestFile with an injected parser whose parse throws a plain
// Error (non-transient, so the background resume pass never touches it). Home shows the one Imports
// line linking to Files; Files after a reload shows the file, its cause and one Retry; Retry imports
// it. A second failed file is recovered by adding the identical bytes again, which imports it and
// never reads "Already imported". Every value is synthetic.

import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';
import { ingestFile } from '../src/ingest/pipeline.mjs';
import { aggregatorCsv } from '../test/helpers/ingest.mjs';

test.skip(REMOTE, 'requires a local synthetic store');

const NOW = '2032-03-10T12:00:00.000Z';
const FAILED_LABEL = 'Could not import';
const FAILED_CAUSE = 'File saved. Something went wrong while reading it. Retry reads the saved file again.';
const CONTROLS = '[data-retry], [data-replace], [data-upload-open], [data-proposal-approve], [data-proposal-correct], [data-proposal-engine]';

const pathOf = (r) => new URL(r.url()).pathname;
const row = (page, fileId) => page.locator(`[data-proposal-file="${fileId}"]`);
const scenarioOf = async (request) => (await request.get('/api/scenario')).json();

test.beforeEach(async ({ request }) => { await resetDemo(request); });
test.afterEach(async ({ request }) => { await resetDemo(request); });

// A failed file in the served household: stored bytes and a files row with status failed.
async function seedFailed(name, tag, number) {
  const bytes = Buffer.from(aggregatorCsv([
    { date: '2032-03-02', amount: '14.25', description: `Synthetic ${tag} purchase`, number },
    { date: '2032-03-03', amount: '3.75', description: `Synthetic ${tag} refund`, number },
  ]));
  const parser = { id: 'aggregator', label: 'Aggregator transactions', sourceKind: 'aggregator_csv', parse() { throw new Error('synthetic parse failure'); } };
  return withLocalHousehold(NOW, async (s) => {
    const out = await ingestFile(s.db, { name, bytes, mime: 'text/csv' }, { ...s.opts(null), actorId: 'demo', parser });
    return { fileId: out.fileId, status: out.status, name, bytes };
  });
}

test('a failed file puts one Imports line on Home and imports with Retry on Files', async ({ page, request }) => {
  const seeded = await seedFailed('synthetic-failed-retry.csv', 'retry', '5550004141');
  expect(seeded.status).toBe('failed');
  const sc = await scenarioOf(request);
  expect(sc.live.ingest.waiting.find((f) => f.id === seeded.fileId)?.status).toBe('failed');
  const imports = sc.live.services.imports;
  expect(imports.state).toBe('needs_you');
  expect(imports.files).toBe(1);
  const attention = sc.live.services.attention;
  expect(attention?.key).toBe('imports');
  expect(attention.go).toBe('add');

  await gotoRoute(page, 'home');
  const line = page.locator('[data-service-line]');
  await expect(line).toHaveCount(1);
  await expect(line.locator('a')).toHaveAttribute('data-go', 'add');
  await expect(line).toContainText('Imports');
  await expect(line).toHaveText(`${attention.label}: ${attention.cause}`);

  await gotoRoute(page, 'add');
  await page.reload();
  const r = row(page, seeded.fileId);
  await expect(r).toBeVisible();
  await expect(r.locator('[data-proposal-status]')).toHaveText(FAILED_LABEL);
  await expect(r.locator('[data-proposal-cause]')).toHaveText(FAILED_CAUSE);
  await expect(r.locator(CONTROLS)).toHaveCount(1);
  const retry = r.locator(`[data-retry="${seeded.fileId}"]`);
  await expect(retry).toHaveCount(1);

  const answered = page.waitForResponse((res) => pathOf(res) === `/api/files/${seeded.fileId}/retry` && res.request().method() === 'POST');
  await retry.click();
  const res = await answered;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.file.fileId).toBe(seeded.fileId);
  expect(body.file.status).toBe('imported');
  await expect(row(page, seeded.fileId)).toHaveCount(0);

  const after = await scenarioOf(request);
  expect(after.live.ingest.waiting.some((f) => f.id === seeded.fileId)).toBe(false);
  expect(after.live.ingest.files.find((f) => f.id === seeded.fileId)?.status).toBe(body.file.status);
});

test('adding the identical bytes of a failed file imports it and never reads "Already imported"', async ({ page }) => {
  const seeded = await seedFailed('synthetic-failed-readd.csv', 'readd', '5550004242');
  expect(seeded.status).toBe('failed');

  await gotoRoute(page, 'add');
  await page.reload();
  await expect(row(page, seeded.fileId)).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.h-ing-add [data-upload-open]').first().click()]);
  const uploaded = page.waitForResponse((r) => pathOf(r) === '/api/files' && r.request().method() === 'POST');
  await chooser.setFiles({ name: seeded.name, mimeType: 'text/csv', buffer: seeded.bytes });
  const res = await uploaded;
  expect(res.status()).toBe(200);
  const file = (await res.json()).files[0];
  expect(file.fileId).toBe(seeded.fileId);
  expect(file.status).not.toBe('duplicate');
  expect(file.status).toBe('imported');

  await expect(page.locator('.h-ing-add .h-ing-files')).toContainText(seeded.name);
  await expect(page.locator('.h-ing-add .h-ing-files')).toContainText('Imported');
  await expect(page.getByText('Already imported')).toHaveCount(0);
  await expect(row(page, seeded.fileId)).toHaveCount(0);
});
