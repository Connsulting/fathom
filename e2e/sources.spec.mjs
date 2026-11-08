// SRC1 AC5: Money > Files lists each source by its real name (institution or file name) with a
// History badge on a source another file now covers, and archives an account in one click with
// an Undo that restores it. Expected names and states come from GET /api/sources, never literals.
// Uploads are the synthetic ingest fixtures: an aggregator export and a bank activity export of
// one account (the activity file holds newer rows, so the aggregator source is history), and a
// positions export. Tags: @src1-ac5 @mobile

import { fileURLToPath } from 'node:url';
import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';

test.skip(REMOTE, 'writes to the demo store');

const fixture = (name) => fileURLToPath(new URL(`../test/fixtures/ingest/${name}`, import.meta.url));
const listOf = (body) => (Array.isArray(body) ? body : body.sources);

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

async function sourcesFromApi(request) {
  const res = await request.get('/api/sources');
  expect(res.status()).toBe(200);
  return listOf(await res.json());
}

async function scenarioIds(request) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  return (await res.json()).accounts.map((a) => a.id);
}

async function upload(page, names) {
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await page.locator('input[type=file][data-upload]').setInputFiles(names.map(fixture));
  const res = await uploaded;
  expect(res.status()).toBe(200);
  expect((await res.json()).files.map((f) => f.status)).toEqual(names.map(() => 'imported'));
}

test('Sources shows real names, a History badge, and archives an account with Undo @src1-ac5 @mobile', async ({ page, request }) => {
  await gotoRoute(page, 'add');
  await upload(page, ['aggregator.csv', 'positions.csv']);
  await upload(page, ['Chase7766_Activity_20320305.csv']);
  await page.reload();
  await expect(page.locator('header.h-top')).toBeVisible();

  const list = await sourcesFromApi(request);
  expect(list.length).toBe(3);
  const section = page.locator('section.h-sec', { has: page.getByRole('heading', { name: 'Sources', exact: true }) });
  const rows = section.locator('.h-srcs > li');
  await expect(rows).toHaveCount(list.length);

  // Real names in API order; the parser label is never shown.
  for (const [i, source] of list.entries()) {
    expect(source.name).not.toBe(source.label);
    await expect(rows.nth(i)).toContainText(source.name);
    await expect(section).not.toContainText(source.label);
  }

  // The covered source carries a History badge, not Stale.
  const history = list.findIndex((x) => x.state === 'history');
  expect(history).toBeGreaterThanOrEqual(0);
  await expect(rows.nth(history).getByText('History', { exact: true })).toBeVisible();
  await expect(rows.nth(history).getByText('Stale', { exact: true })).toHaveCount(0);

  // Archive the positions account in one click, then Undo.
  const positions = list.find((x) => x.kind === 'brokerage_positions');
  const target = positions.accounts[0];
  expect(target.archived).toBe(false);
  expect(await scenarioIds(request)).toContain(target.id);
  const row = rows.filter({ hasText: positions.name });
  await expect(row).toHaveCount(1);
  await row.locator('summary', { hasText: 'Manage' }).click();
  const archived = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/accounts/${target.id}/archive` && r.request().method() === 'POST');
  await row.getByRole('button', { name: 'Archive', exact: true }).first().click();
  expect((await archived).status()).toBe(200);
  await expect(section.getByText(`${target.label} archived.`)).toBeVisible();
  expect(await scenarioIds(request)).not.toContain(target.id);
  expect((await sourcesFromApi(request)).flatMap((x) => x.accounts).find((a) => a.id === target.id).archived).toBe(true);

  const undo = section.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  const undone = page.waitForResponse((r) => /^\/api\/actions\/[^/]+\/undo$/.test(new URL(r.url()).pathname));
  await undo.click();
  expect((await undone).status()).toBe(200);
  expect(await scenarioIds(request)).toContain(target.id);
  expect((await sourcesFromApi(request)).flatMap((x) => x.accounts).find((a) => a.id === target.id).archived).toBe(false);

  // No horizontal scroll at this width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
