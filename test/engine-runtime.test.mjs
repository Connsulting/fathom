// D8: the runtime engine reads the live credential once, when it starts (init() or ready), and
// never again. A failed read leaves every live call failing with ModelCallError('engine credential
// unavailable') even after the file appears. Fake and off modes never read the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { src, tempDb, tempDir } from './helpers/server.mjs';

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
