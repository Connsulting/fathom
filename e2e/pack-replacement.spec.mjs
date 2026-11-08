import { test, expect, resetDemo } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';

const OLD = 'replacement-feedback-source';
const TEXT = '# Dental coverage\n\nThe plan covers routine dental care.\n';

async function openGap(page, request, info) {
  const { ypBaseURL: base, ypDataDir: dataDir } = info.config.metadata;
  test.skip(!base || !dataDir, 'requires the local Your plans demo server');
  await resetDemo(request, base);
  await withLocalHousehold(new Date().toISOString(), async ({ db }) => {
    db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
      VALUES (?,'broken-plan.txt','text/plain',1,'upload',?,'files/replacement-feedback-source.bin','parsed','')`).run(OLD, new Date().toISOString());
    db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(OLD);
  }, { dataDir });
  await page.goto(new URL('/#/packs', base).href);
  await page.locator('.h-yp [data-yp-build]').click();
  await expect(page.locator('.h-yp .h-pack-gap')).toContainText('could not be read');
  return page.locator('.h-yp .h-pack-gap');
}

async function replace(page, gap) {
  const chooser = page.waitForEvent('filechooser');
  await gap.getByRole('button', { name: 'Replace document', exact: true }).click();
  await (await chooser).setFiles({ name: 'replacement-plan.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT) });
}

for (const [mode, cause] of [
  ['failed', 'could not be read'], ['unsupported', 'file type'], ['too_large', 'too large'],
  ['missing', 'saved copy'], ['null', 'upload failed'], ['throw', 'could not finish'],
]) {
  test(`replacement ${mode}: the cause persists beside the gap and Replace remains usable`, async ({ page, request }, info) => {
    const gap = await openGap(page, request, info);
    // Inject an API-adapter failure; the changed screen and all recovery requests run normally.
    await page.evaluate(mode => {
      const api = window.Fathom.api, original = api.upload;
      api.upload = async () => {
        api.upload = original;
        if (mode === 'throw') throw new Error('Synthetic upload transport exception');
        if (mode === 'null') return null;
        return { files: [mode === 'missing' ? {} : { fileId: 'synthetic-rejected-copy', status: mode }] };
      };
    }, mode);
    await replace(page, gap);
    await expect(gap.locator('[data-yp-replace-feedback]')).toContainText(cause);
    await page.reload();
    await expect(gap.locator('[data-yp-replace-feedback]')).toContainText(cause);
    await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
    await replace(page, gap);
    await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
  });
}

test('removal failure keeps the saved copy and offers one removal retry across reload', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => {
    const api = window.Fathom.api, original = api.removeFile;
    api.removeFile = async () => { api.removeFile = original; return null; };
  });
  let uploads = 0;
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/files' && r.method() === 'POST') uploads++; });
  await replace(page, gap);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('new copy was saved');
  await page.reload();
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('old document could not be removed');
  await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
  await gap.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
  expect(uploads).toBe(1);
});
