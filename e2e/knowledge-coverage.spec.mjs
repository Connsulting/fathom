import { test, expect, resetDemo } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';
import { storeFile } from '../src/ingest/vault.mjs';

const ID = 'coverage-plan';
const NAME = 'synthetic-benefits.txt';
const BAD = '# Dental coverage\n\nThe plan covers routine dental care.\n\n# Tier 9 vision coverage\n\nThe plan covers frames and lenses.\n';
const GOOD = BAD.replace('Tier 9 vision coverage', 'Vision coverage');

test('knowledge gaps remain beside the pack after reload and rebuilding a replacement clears them', async ({ page, request }, testInfo) => {
  const { ypBaseURL: base, ypDataDir: dataDir } = testInfo.config.metadata;
  test.skip(!base || !dataDir, 'requires the local Your plans demo server');
  await resetDemo(request, base);
  await withLocalHousehold(new Date().toISOString(), async ({ db, household }) => {
    const stored = await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(BAD), purpose: 'upload' });
    db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
      VALUES (?,?,'text/plain',?,'upload',?,?,'parsed','')`).run(ID, NAME, BAD.length, new Date().toISOString(), stored);
    db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(ID);
  }, { dataDir });
  await page.goto(new URL('/#/packs', base).href);
  await page.locator('.h-yp [data-yp-build]').click();
  await expect(page.locator('.h-yp-result')).toContainText('1 entry', { timeout: 30_000 });
  await page.reload();
  const gap = page.locator('.h-yp .h-pack-gap');
  await expect(gap).toContainText(NAME);
  await expect(gap).toContainText('Tier 9 vision coverage');
  await expect(gap).toContainText('did not match');
  await page.goto(new URL('/#/packs/your-plans', base).href);
  await expect(page.locator('.h-pack-gap')).toContainText(NAME);
  await withLocalHousehold(new Date().toISOString(), async ({ household }) => {
    await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(GOOD), purpose: 'upload' });
  }, { dataDir });
  await page.getByRole('button', { name: 'Rebuild pack', exact: true }).click();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
  await page.reload();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0);
  await expect(page.locator('.h-entry')).toHaveCount(2);
});
