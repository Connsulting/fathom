import { test, expect, resetDemo } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';

const OLD = 'replacement-feedback-source';
const SCOPE = 'synthetic-owner:synthetic-household';
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
  await setScope(page);
  await page.locator('.h-yp [data-yp-build]').click();
  await expect(page.locator('.h-yp .h-pack-gap')).toContainText('could not be read');
  return page.locator('.h-yp .h-pack-gap');
}

async function setScope(page, scope = SCOPE) {
  await page.waitForFunction(() => !!window.Fathom?.api?.s);
  await page.evaluate(scope => { window.Fathom.api.storageScope = () => scope; window.Fathom.api.go('packs'); }, scope);
}

async function reload(page) {
  await page.reload();
  await setScope(page);
}

async function replace(page, gap, copy = { name: 'replacement-plan.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT) }) {
  const chooser = page.waitForEvent('filechooser');
  await gap.getByRole('button', { name: 'Replace document', exact: true }).click();
  await (await chooser).setFiles(copy);
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
    await reload(page);
    await expect(gap.locator('[data-yp-replace-feedback]')).toContainText(cause);
    await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
    if (mode === 'unsupported') await gap.screenshot({ path: info.outputPath('replacement-feedback.png') });
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
  await reload(page);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('old document could not be removed');
  await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
  await gap.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
  expect(uploads).toBe(1);
});

test('a failed removal retry keeps its cause visible and Replace usable', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => { window.Fathom.api.removeFile = async () => { throw new Error('Synthetic removal exception'); }; });
  await replace(page, gap);
  await gap.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await expect(gap.getByRole('button', { name: 'Retry removal', exact: true })).toHaveCount(0);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('new copy was saved');
  await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
  await reload(page);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('old document could not be removed');
  await expect(gap.getByRole('button', { name: 'Retry removal', exact: true })).toHaveCount(0);
  await replace(page, gap);
  await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
});

test('incomplete and briefly empty coverage renders preserve the saved cause', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => { window.Fathom.api.upload = async () => null; });
  await replace(page, gap);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('upload failed');
  for (const missing of [true, false]) {
    await page.evaluate(missing => {
      const api = window.Fathom.api;
      window.__savedPlans = api.s.live.yourPlans;
      if (missing) delete api.s.live.yourPlans;
      else api.s.live.yourPlans = { ...window.__savedPlans, coverage: [] };
      api.go('packs');
    }, missing);
    await page.evaluate(() => {
      const api = window.Fathom.api;
      api.s.live.yourPlans = window.__savedPlans;
      api.go('packs');
    });
    await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('upload failed');
  }
});

test('an empty browser scope does not persist replacement feedback', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await setScope(page, '');
  await page.evaluate(() => { window.Fathom.api.upload = async () => null; });
  await replace(page, gap);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('upload failed');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fathom.planReplacement')))).toEqual([]);
});

test('a second replacement removes the earlier saved copy before rebuilding', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => {
    const api = window.Fathom.api, remove = api.removeFile;
    api.removeFile = async () => { api.removeFile = remove; return null; };
  });
  await replace(page, gap);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('new copy was saved');
  await replace(page, gap, { name: 'later-plan.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT.replace('routine', 'preventive')) });
  await expect(page.locator('.h-pack-gap')).toHaveCount(0, { timeout: 30_000 });
  await withLocalHousehold(new Date().toISOString(), async ({ db }) => {
    expect(db.prepare("SELECT removed_at FROM files WHERE name = 'replacement-plan.txt'").get().removed_at).toBeTruthy();
    expect(db.prepare("SELECT removed_at FROM files WHERE name = 'later-plan.txt'").get().removed_at).toBeNull();
  }, { dataDir: info.config.metadata.ypDataDir });
});

test('a real unsupported upload reports its cause beside the gap', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  const uploaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'POST');
  await replace(page, gap, { name: 'unsupported-plan.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3]) });
  const response = await uploaded;
  expect(response.status()).toBe(200);
  expect((await response.json()).files[0].status).toBe('unsupported');
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('file type');
  await expect(gap.getByRole('button', { name: 'Replace document', exact: true })).toBeEnabled();
  await reload(page);
  await expect(gap.locator('[data-yp-replace-feedback]')).toContainText('file type');
});

test('an upload that finishes after a scope change cannot remove files in the new scope', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => {
    const api = window.Fathom.api;
    window.__removals = 0;
    api.upload = () => new Promise(resolve => { window.__uploaded = resolve; });
    api.removeFile = async () => { window.__removals++; return null; };
  });
  await replace(page, gap);
  await page.waitForFunction(() => typeof window.__uploaded === 'function');
  await page.evaluate(() => {
    window.Fathom.api.storageScope = () => 'synthetic-owner:other-household';
    window.__uploaded({ files: [{ fileId: 'saved-in-original-scope', status: 'needs_clarification' }] });
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fathom.planReplacement:synthetic-owner:synthetic-household') || '{}')['replacement-feedback-source']?.savedId)).toBe('saved-in-original-scope');
  expect(await page.evaluate(() => window.__removals)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('fathom.planReplacement:synthetic-owner:other-household'))).toBeNull();
});

test('a removal retry that finishes after a scope change cannot rebuild the new scope', async ({ page, request }, info) => {
  const gap = await openGap(page, request, info);
  await page.evaluate(() => {
    const api = window.Fathom.api, remove = api.removeFile;
    api.removeFile = async () => { api.removeFile = remove; return null; };
  });
  await replace(page, gap);
  await expect(gap.getByRole('button', { name: 'Retry removal', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const api = window.Fathom.api, remove = api.removeFile;
    window.__builds = 0;
    api.buildYourPlans = async () => { window.__builds++; return null; };
    api.removeFile = async id => {
      const result = await remove(id);
      return new Promise(resolve => { window.__removed = () => resolve(result); });
    };
  });
  await gap.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await page.waitForFunction(() => typeof window.__removed === 'function');
  await page.evaluate(() => {
    window.Fathom.api.storageScope = () => 'synthetic-owner:other-household';
    window.__removed();
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fathom.planReplacement:synthetic-owner:synthetic-household') || '{}')['replacement-feedback-source'])).toBeUndefined();
  expect(await page.evaluate(() => window.__builds)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('fathom.planReplacement:synthetic-owner:other-household'))).toBeNull();
});
