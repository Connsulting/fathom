// Your plans (item 6, R13): on the Your plans demo server, whose data directory sits outside the
// checkout, a plan document on file builds a private pack from the Packs screen, and its entries
// cite the source file and page as plain text, never as a link.
// The plan documents are synthetic and generic: headings, a page marker, no amounts. The second
// test (review finding CR1) checks that model-written titles render as text: no markup, no
// scenario token resolved into a figure.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, S, resetDemo } from './helpers.mjs';
import { openDb, DB_FILE } from '../src/store/db.mjs';

const FILE_ID = 'e2e-yp-plan';
const FILE_NAME = 'benefits-plan-notes.txt';
const PAGE_ONE_TITLE = 'Health plan choices';
const PAGE_TWO_TITLE = 'Retirement plan features';

const PLAN_TEXT = [
  `# ${PAGE_ONE_TITLE}`,
  '',
  'The employer offers a choice between a lower premium plan with a higher deductible and a higher premium plan with a lower deductible.',
  'Enrollment changes are allowed during the annual open enrollment window or after a qualifying life event.',
  '',
  'Page 2',
  '',
  `# ${PAGE_TWO_TITLE}`,
  '',
  'The workplace retirement plan accepts both pre-tax and Roth contributions.',
  'Employer matching contributions vest on a graded schedule described in the plan summary.',
  ''
].join('\n');

function yp(testInfo) {
  const md = testInfo.config.metadata || {};
  return { base: md.ypBaseURL || '', dataDir: md.ypDataDir || '' };
}

// Puts the synthetic plan on file the way an upload would: the file in <dataDir>/files/, its
// files row, and a documents row with doc_type plan.
function addPlanDocument(dataDir, name = FILE_NAME, text = PLAN_TEXT) {
  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, name), text);
  const db = openDb(join(dataDir, DB_FILE));
  try {
    db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
                VALUES (?, ?, 'text/plain', ?, ?, 'upload', ?, ?, 'parsed', 'Synthetic e2e plan document')`)
      .run(FILE_ID, name, Buffer.byteLength(text), createHash('sha256').update(text).digest('hex'), new Date().toISOString(), `files/${name}`);
    db.prepare(`INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES ('plan', ?, '{}', ?, NULL, NULL)`)
      .run(Number(S.meta.clock.slice(0, 4)), FILE_ID);
  } finally {
    db.close();
  }
}

async function gotoYp(page, base, route) {
  await page.goto(new URL(`/#/${route}`, base).href);
  await expect(page.locator('header.h-top')).toBeVisible();
}

test.beforeEach(async ({ request }, testInfo) => {
  const { base, dataDir } = yp(testInfo);
  test.skip(!base || !dataDir, 'no Your plans server (BASE_URL set)');
  await resetDemo(request, base);
});

test('a plan document builds the Your plans pack, and entries cite file and page as plain text', async ({ page }, testInfo) => {
  const { base, dataDir } = yp(testInfo);
  addPlanDocument(dataDir);

  await gotoYp(page, base, 'packs');
  await expect(page.getByRole('heading', { level: 1, name: 'What Fathom knows', exact: true })).toBeVisible();
  const card = page.locator('.h-yp');
  await expect(card).toBeVisible();
  const box = card.locator(`input[data-yp-file="${FILE_ID}"]`);
  await expect(box).toHaveAttribute('type', 'checkbox');
  await box.check();
  await expect(box).toBeChecked();
  const build = card.locator('button[data-yp-build]');
  await expect(build).toHaveText('Build Your plans pack');
  await build.click();

  const result = page.locator('.h-yp-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText(/\b[1-9]\d* entr(y|ies)\b/);
  await expect(page.locator('.fx-err')).toHaveCount(0);

  await gotoYp(page, base, 'packs/your-plans');
  await expect(page.getByRole('heading', { level: 1, name: 'Your plans', exact: true })).toBeVisible();
  const entries = page.locator('.h-entries button.h-entry[data-pack="your-plans"]');
  await expect(entries.first()).toBeVisible();

  for (const [title, n] of [[PAGE_ONE_TITLE, 1], [PAGE_TWO_TITLE, 2]]) {
    await entries.filter({ hasText: title }).first().click();
    await expect(page.locator('.h-entry-body')).toBeVisible();
    const cites = page.locator('.h-entry-cites li');
    await expect(cites.filter({ hasText: `${FILE_NAME}, page ${n}` })).toHaveCount(1);
    // Private citations are never links: their URL host is reserved and resolves nowhere.
    await expect(page.locator('.h-entry-cites a')).toHaveCount(0);
    await expect(page.locator('.h-entry-cites')).not.toContainText('your-plans.invalid');
  }
});

// CR1: a heading carrying markup and a real figure token (true_reserve is in demo/scenario.mjs).
const HOSTILE_KEY = 'true_reserve';
const HOSTILE_NAME = 'hostile-plan-notes.txt';
const HOSTILE_HEADING = `<img src=x onerror=alert(1)> Plan {f:${HOSTILE_KEY}}`;
const HOSTILE_TEXT = [
  `# ${HOSTILE_HEADING}`,
  '',
  `The plan summary mentions {f:${HOSTILE_KEY}} and <img src=x onerror=alert(2)> in its overview.`,
  ''
].join('\n');

test('model-written Your plans titles render as text, with no markup and no resolved figures', async ({ page }, testInfo) => {
  expect(S.fig[HOSTILE_KEY], `figure ${HOSTILE_KEY} in demo/scenario.mjs`).toBeTruthy();
  const { base, dataDir } = yp(testInfo);
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  addPlanDocument(dataDir, HOSTILE_NAME, HOSTILE_TEXT);

  await gotoYp(page, base, 'packs');
  await page.locator(`.h-yp input[data-yp-file="${FILE_ID}"]`).check();
  await page.locator('.h-yp button[data-yp-build]').click();
  await expect(page.locator('.h-yp-result')).toContainText(/\b[1-9]\d* entr(y|ies)\b/, { timeout: 30_000 });

  // Packs screen: the Your plans card (name, why, covers) carries no markup and no figure.
  await gotoYp(page, base, 'packs');
  const card = page.locator('article.h-pack').filter({ has: page.locator('a[data-id="your-plans"]') });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Plan');
  await expect(card.locator('img')).toHaveCount(0);
  await expect(card.locator('.fx-fig')).toHaveCount(0);

  // Pack page: covers, entry titles and the opened entry body carry no markup and no figure.
  await gotoYp(page, base, 'packs/your-plans');
  await expect(page.getByRole('heading', { level: 1, name: 'Your plans', exact: true })).toBeVisible();
  const main = page.locator('main');
  await expect(main.locator('img')).toHaveCount(0);
  const covers = page.locator('.h-cross');
  await expect(covers.first()).toContainText('Plan');
  await expect(covers.locator('img')).toHaveCount(0);
  await expect(covers.locator('.fx-fig')).toHaveCount(0);
  const entries = page.locator('.h-entries button.h-entry[data-pack="your-plans"]');
  await expect(entries.first()).toContainText('Plan');
  await expect(page.locator('.h-entries img')).toHaveCount(0);
  await expect(page.locator('.h-entries .fx-fig')).toHaveCount(0);

  await entries.first().click();
  const body = page.locator('.h-entry-body');
  await expect(body).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  await expect(body.locator('.fx-fig')).toHaveCount(0);
  await expect(main.locator('img')).toHaveCount(0);

  expect(dialogs, 'script dialogs opened by rendered markup').toEqual([]);
});
