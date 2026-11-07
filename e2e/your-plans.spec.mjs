// Your plans (item 6, R13): on the Your plans demo server, whose data directory sits outside the
// checkout, a plan document on file builds a private pack from the Packs screen, and its entries
// cite the source file and page as plain text, never as a link.
// The plan documents are synthetic and generic: headings, a page marker, no amounts. The second
// test (review finding CR1) checks that model-written titles render as text: no markup, no
// scenario token resolved into a figure.

import { createHash } from 'node:crypto';
import { test, expect, S, resetDemo } from './helpers.mjs';
import { openDb } from '../src/store/db.mjs';
import { openVault, storeFile } from '../src/ingest/vault.mjs';
import { householdStoreFile, withLocalHousehold } from './local-store.mjs';

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

// Puts the synthetic plan on file the way an upload stores it: sealed by the household vault at
// <household root>/files/<id>.bin, its files row, and (unless `document` is false) a documents row
// with doc_type plan.
async function addPlanDocument(dataDir, name = FILE_NAME, text = PLAN_TEXT, { document = true } = {}) {
  await withLocalHousehold(new Date().toISOString(), async ({ db, household }) => {
    const vault = await openVault(household);
    const storedPath = await storeFile({ vault, id: FILE_ID, bytes: Buffer.from(text, 'utf8'), purpose: 'upload' });
    db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
                VALUES (?, ?, 'text/plain', ?, ?, 'upload', ?, ?, 'parsed', 'Synthetic e2e plan document')`)
      .run(FILE_ID, name, Buffer.byteLength(text), createHash('sha256').update(text).digest('hex'), new Date().toISOString(), storedPath);
    if (document) {
      db.prepare(`INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES ('plan', ?, '{}', ?, NULL, NULL)`)
        .run(Number(S.meta.clock.slice(0, 4)), FILE_ID);
    }
  }, { dataDir });
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
  await addPlanDocument(dataDir);

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
// B5: every number in a title must appear in the section text it was drawn from, so the heading
// uses the same alert(2) markup as the body (the number check runs on the neutralized title).
const HOSTILE_HEADING = `<img src=x onerror=alert(2)> Plan {f:${HOSTILE_KEY}}`;
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
  await addPlanDocument(dataDir, HOSTILE_NAME, HOSTILE_TEXT);

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

// Review advisory: a plan document stored as text only (no file, `fields.text`) is a build source
// on the server, so the Packs card must offer Build when it is the only input.
const TEXT_ONLY = [
  '# Dependent care account rules',
  '',
  'The employer plan offers a dependent care account that is elected once a year during open enrollment.',
  'Unused balances follow the plan rules described in the benefits summary.',
  ''
].join('\n');

test('a text-only plan document is enough to build the Your plans pack', async ({ page }, testInfo) => {
  const { base, dataDir } = yp(testInfo);
  const db = openDb(householdStoreFile(dataDir));
  try {
    db.prepare(`INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES ('plan', ?, ?, NULL, NULL, NULL)`)
      .run(Number(S.meta.clock.slice(0, 4)), JSON.stringify({ text: TEXT_ONLY }));
  } finally {
    db.close();
  }

  await gotoYp(page, base, 'packs');
  const card = page.locator('.h-yp');
  await expect(card).toBeVisible();
  const build = card.locator('button[data-yp-build]');
  await expect(build).toBeEnabled();
  await build.click();
  await expect(page.locator('.h-yp-result')).toContainText(/\b[1-9]\d* entr(y|ies)\b/, { timeout: 30_000 });
  await expect(page.locator('.fx-err')).toHaveCount(0);
});

// CR6: with no plan or benefits documents, an optional uploaded file is the only input. Ticking it
// must enable Build, unticking must disable it again, and the build must use it.
test('an optional uploaded file alone enables Build and builds the Your plans pack', async ({ page }, testInfo) => {
  const { base, dataDir } = yp(testInfo);
  await addPlanDocument(dataDir, FILE_NAME, PLAN_TEXT, { document: false });

  await gotoYp(page, base, 'packs');
  const card = page.locator('.h-yp');
  await expect(card).toBeVisible();
  const box = card.locator(`input[data-yp-file="${FILE_ID}"]`);
  const build = card.locator('button[data-yp-build]');
  await expect(box).not.toBeChecked();
  await expect(build).toBeDisabled();

  await box.check();
  await expect(build).toBeEnabled();
  await box.uncheck();
  await expect(build).toBeDisabled();
  await box.check();
  await expect(build).toBeEnabled();

  await build.click();
  await expect(page.locator('.h-yp-result')).toContainText(/\b[1-9]\d* entr(y|ies)\b/, { timeout: 30_000 });
  await expect(page.locator('.fx-err')).toHaveCount(0);
});

// B5: sections whose title carries a number the section text does not are dropped, and the build
// result line says how many. The fake engine draws each title from the heading and the excerpt
// from the section text, so these two headings are a scripted mismatch.
const MISMATCH_NAME = 'mismatch-plan-notes.txt';
const MISMATCH_TEXT = [
  '# Dental coverage',
  '',
  'The employer dental plan covers routine cleanings and exams.',
  '',
  '# Tier 3 vision coverage',
  '',
  'The employer vision plan covers frames and lenses.',
  '',
  '# Option 4 hearing coverage',
  '',
  'The employer hearing plan covers hearing exams.',
  ''
].join('\n');

test('B5: the build result line reports the sections dropped because they did not match the document', async ({ page }, testInfo) => {
  const { base, dataDir } = yp(testInfo);
  await addPlanDocument(dataDir, MISMATCH_NAME, MISMATCH_TEXT);

  await gotoYp(page, base, 'packs');
  await page.locator(`.h-yp input[data-yp-file="${FILE_ID}"]`).check();
  await page.locator('.h-yp button[data-yp-build]').click();
  const result = page.locator('.h-yp-result');
  await expect(result).toContainText(/\b1 entry\b/, { timeout: 30_000 });
  await expect(result).toContainText('2 sections were dropped because they did not match the document.');
  await expect(result).not.toContainText('Tier 3');
  await expect(page.locator('.fx-err')).toHaveCount(0);

  await gotoYp(page, base, 'packs/your-plans');
  const entries = page.locator('.h-entries button.h-entry[data-pack="your-plans"]');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveText('Dental coverage');
});
