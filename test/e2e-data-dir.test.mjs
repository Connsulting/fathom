// The e2e data directory names come from one module, and serve.mjs's guard accepts every one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DATA_ROOT, dataName, dataDir, mainDataName, mainDataDir } from '../e2e/data-dir.mjs';

test('named fixtures are top-level .e2e-data* directories', () => {
  assert.equal(dataName(), '.e2e-data');
  assert.equal(dataName('jan'), '.e2e-data-jan');
  assert.equal(dataDir('pubdemo'), resolve('.e2e-data-pubdemo'));
  for (const name of ['jan', 'qrecs', 'pubdemo', 'tourpub']) assert.ok(dataName(name).startsWith(DATA_ROOT));
});

test('the main directory follows E2E_DATA', () => {
  const was = process.env.E2E_DATA;
  try {
    delete process.env.E2E_DATA;
    assert.equal(mainDataName(), DATA_ROOT);
    process.env.E2E_DATA = '.e2e-data-mine';
    assert.equal(mainDataName(), '.e2e-data-mine');
    assert.equal(mainDataDir(), resolve('.e2e-data-mine'));
  } finally {
    if (was === undefined) delete process.env.E2E_DATA; else process.env.E2E_DATA = was;
  }
});
