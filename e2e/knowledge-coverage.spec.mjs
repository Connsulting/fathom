import { test, expect, resetDemo } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { householdRootDir } from './local-store.mjs';
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
    await db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
      VALUES (?,?,'text/plain',?,'upload',?,?,'parsed','')`).run(ID, NAME, BAD.length, new Date().toISOString(), stored);
    await db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(ID);
  }, { dataDir });
  await page.goto(new URL('/#/packs', base).href);
  await page.locator('.h-yp [data-yp-build]').click();
  await expect(page.locator('.h-yp-result')).toContainText('1 entry', { timeout: 30_000 });
  await page.reload();
  const gap = page.locator('.h-yp .h-pack-gap');
  await expect(gap).toContainText(NAME);
  await expect(gap).toContainText('Tier 9 vision coverage');
  await expect(gap).toContainText('did not match');
  await page.screenshot({ path: testInfo.outputPath('knowledge-gap.png'), fullPage: true });
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

for (const stage of ['source-read', 'extraction', 'pack-load']) {
  test(`${stage}: the saved explanation leads to repair`, async ({ page, request }, testInfo) => {
    const { ypBaseURL: base, ypDataDir: dataDir } = testInfo.config.metadata;
    test.skip(!base || !dataDir, 'requires the local Your plans demo server');
    await resetDemo(request, base);
    await withLocalHousehold(new Date().toISOString(), async ({ db, household }) => {
      const text = stage === 'extraction' ? '' : GOOD;
      const stored = await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(text), purpose: 'upload' });
      await db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
        VALUES (?,?,'text/plain',?,'upload',?,?,'parsed','')`).run(ID, NAME, text.length, new Date().toISOString(), stored);
      await db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(ID);
      if (stage === 'source-read') rmSync(join(household.root, stored));
    }, { dataDir });
    await page.goto(new URL('/#/packs', base).href);
    await page.locator('.h-yp [data-yp-build]').click();
    await expect(page.locator('.h-yp-result')).toBeVisible({ timeout: 30_000 });
    if (stage === 'pack-load') writeFileSync(join(await householdRootDir(dataDir), 'packs', 'your-plans', 'manifest.json'), '{invalid');
    await page.reload();
    const gap = page.locator('.h-yp .h-pack-gap');
    await expect(gap).toContainText(NAME);
    await expect(gap).toContainText(stage === 'source-read' ? 'could not be read' : stage === 'extraction' ? 'No readable plan sections' : 'missing or unreadable');
    if (stage === 'source-read') {
      const chooser = page.waitForEvent('filechooser');
      await gap.getByRole('button', { name: 'Replace document' }).click();
      await (await chooser).setFiles({ name: 'replacement-benefits.txt', mimeType: 'text/plain', buffer: Buffer.from(GOOD) });
    } else {
      await withLocalHousehold(new Date().toISOString(), async ({ household }) => {
        await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(GOOD), purpose: 'upload' });
      }, { dataDir });
      await page.locator('.h-yp [data-yp-rebuild]').click();
    }
    await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
    if (stage === 'source-read') {
      await expect(page.locator('.h-yp')).toContainText('replacement-benefits.txt');
      await withLocalHousehold(new Date().toISOString(), async ({ db }) => {
        expect((await db.prepare('SELECT removed_at FROM files WHERE id = ?').get(ID)).removed_at).toBeTruthy();
        expect((await db.prepare('SELECT count(*) AS n FROM documents WHERE file_id = ?').get(ID)).n).toBe(0);
      }, { dataDir });
    }
    await page.reload();
    await expect(page.locator('.h-pack-gap')).toHaveCount(0);
  });
}

test('an unreadable text-only document has a working Remove from pack control', async ({ page, request }, testInfo) => {
  const { ypBaseURL: base, ypDataDir: dataDir } = testInfo.config.metadata;
  test.skip(!base || !dataDir, 'requires the local Your plans demo server');
  await resetDemo(request, base);
  await withLocalHousehold(new Date().toISOString(), async ({ db }) => {
    await db.prepare("INSERT INTO documents (doc_type,fields) VALUES ('plan',?)").run(JSON.stringify({ text: '' }));
  }, { dataDir });
  await page.goto(new URL('/#/packs', base).href);
  await page.locator('.h-yp [data-yp-build]').click();
  const gap = page.locator('.h-yp .h-pack-gap');
  await expect(gap).toContainText('no readable text');
  await gap.getByRole('button', { name: 'Remove from pack' }).click();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0);
});
