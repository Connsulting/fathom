// D8: the runtime engine reads the live credential once, when it starts (init() or ready), and
// never again. A failed read leaves every live call failing with ModelCallError('engine credential
// unavailable') even after the file appears. Fake and off modes never read the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { src, tempDb, tempDir, spawnServer, ROOT } from './helpers/server.mjs';

const require = createRequire(import.meta.url);

// Count every fs open or read of `target`, through the builtin modules' live ESM bindings.
// counter.write(text) creates the file without counting (writeFileSync opens through fs too).
function countReads(target) {
  const want = resolve(target);
  const fsp = require('node:fs/promises');
  const fs = require('node:fs');
  const patched = [[fsp, 'open'], [fsp, 'readFile'], [fs, 'openSync'], [fs, 'readFileSync'], [fs, 'open'], [fs, 'readFile']];
  const originals = patched.map(([mod, name]) => mod[name]);
  const counter = { n: 0 };
  patched.forEach(([mod, name], i) => {
    const original = originals[i];
    mod[name] = function counted(path, ...rest) {
      if (!counter.paused && typeof path === 'string' && resolve(path) === want) counter.n += 1;
      return original.call(this, path, ...rest);
    };
  });
  syncBuiltinESMExports();
  counter.write = (text) => {
    counter.paused = true;
    try { writeFileSync(target, text, { mode: 0o600 }); } finally { counter.paused = false; }
  };
  counter.restore = () => {
    patched.forEach(([mod, name], i) => { mod[name] = originals[i]; });
    syncBuiltinESMExports();
  };
  return counter;
}

const CALL = { purpose: 'chat', messages: [{ role: 'user', content: 'Hello' }], system: '', maxTokens: 32 };
const EXTRACT = { document: { type: 'text', text: 'Synthetic' }, schema: { type: 'object', properties: {}, additionalProperties: false }, system: '', maxTokens: 64 };

async function started(rt) {
  if (typeof rt.init === 'function') await rt.init();
  else if (rt.ready) await rt.ready;
}

async function withFixture(fn) {
  const store = await tempDb();
  const dir = await tempDir('fathom-cred-');
  const credFile = join(dir, 'credential');
  const reads = countReads(credFile);
  try {
    return await fn({ db: store.db, credFile, reads });
  } finally {
    reads.restore();
    store.close();
    rmSync(store.dataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

test('live mode reads a missing credential once at start; a file created later is never read and live calls fail', () => withFixture(async ({ db, credFile, reads }) => {
  const { createRuntimeEngine } = await src('src/engine/runtime.mjs');
  const { ModelCallError } = await src('src/engine/index.mjs');
  const rt = createRuntimeEngine({ db, config: { engine: 'live', claudeCredentialFile: credFile } });
  assert.ok(typeof rt.init === 'function' || (rt.ready && typeof rt.ready.then === 'function'), 'the runtime exposes init() or a ready promise');
  await started(rt);
  assert.equal(reads.n, 1, 'the credential file is read once, at start');
  assert.equal(rt.credentialState, 'failed');

  reads.write('synthetic-placeholder');
  const unavailable = (e) => e instanceof ModelCallError && e.message === 'engine credential unavailable';
  for (let i = 0; i < 2; i++) {
    await assert.rejects(rt.call(CALL), unavailable);
    await assert.rejects(rt.extract(EXTRACT), unavailable);
  }
  assert.equal(reads.n, 1, 'never read again, even after the file appears');
}));

test('fake and off modes never touch the credential file', () => withFixture(async ({ db, credFile, reads }) => {
  const { createRuntimeEngine } = await src('src/engine/runtime.mjs');
  reads.write('synthetic-placeholder');
  for (const mode of ['fake', 'off']) {
    const rt = createRuntimeEngine({ db, config: { engine: mode, claudeCredentialFile: credFile } });
    await started(rt);
    await assert.rejects(rt.extract(EXTRACT));
    await assert.rejects(rt.call(CALL));
  }
  assert.equal(reads.n, 0);
}));

// G9: the same through a real server started in live mode with a missing credential file. A preload
// counts every open of the file. Extraction calls fail (the files wait as needs_extraction), and a
// file created after startup is never opened. The late file is world-readable and holds two tokens,
// so it could never authenticate even if it were read.
test('G9: a live server opens a missing credential once at startup and never again, even after the file appears', { timeout: 60000 }, async () => {
  const dir = await tempDir('fathom-cred-');
  const credFile = join(dir, 'credential');
  const log = join(dir, 'opens.log');
  const opens = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const s = await spawnServer({
    env: {
      FATHOM_DEMO: '1', FATHOM_ENGINE: 'live', FATHOM_CLAUDE_CREDENTIAL_FILE: credFile,
      NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'test/helpers/count-opens.mjs')).href}`,
      TEST_COUNT_OPENS_TARGET: credFile, TEST_COUNT_OPENS_LOG: log,
    },
  });
  const extractOnce = async (tag) => {
    const fd = new FormData();
    fd.append('files', new Blob([`SYNTHETIC PAYSTUB ${tag}\nEmployer: Example Employer LLC\nPay date 2032-03-15\nGross pay 5000.00\n`], { type: 'text/plain' }), `paystub-${tag}.txt`);
    const res = await fetch(`${s.baseUrl}/api/files`, { method: 'POST', body: fd });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body.files[0].status, 'needs_extraction', 'the extraction call fails');
  };
  try {
    assert.equal(opens(), 1, 'opened once at startup');
    await extractOnce('first');
    writeFileSync(credFile, 'synthetic placeholder', { mode: 0o644 });
    await extractOnce('second');
    await extractOnce('third');
    assert.equal(opens(), 1, 'never opened again, even after the file appears');
  } finally {
    await s.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
