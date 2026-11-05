// AC11 and AC9: repository rules over tracked files, the package manifest, and the CI workflow.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/server.mjs';

// Built from parts so this file does not match its own checks.
const EM_DASH = String.fromCharCode(0x2014);
const HOME_PATH = ['', 'home', ''].join('/');
const TAILNET = '.ts' + '.net';
const EMOJI = /\p{Extended_Pictographic}/u;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean)
    .filter(f => !f.startsWith('mock-v2/') && f !== 'package-lock.json')
    .filter(f => existsSync(join(ROOT, f)));
}

function textOf(f) {
  const buf = readFileSync(join(ROOT, f));
  return buf.includes(0) ? null : buf.toString('utf8');
}

function scan(check) {
  const hits = [];
  for (const f of trackedFiles()) {
    const text = textOf(f);
    if (text == null) continue;
    text.split('\n').forEach((line, i) => { if (check(line)) hits.push(`${f}:${i + 1}`); });
  }
  return hits;
}

test('git ls-files sees the tracked tree', () => {
  const files = trackedFiles();
  assert.ok(files.includes('AGENTS.md'));
});

test('no tracked file contains an em dash', () => {
  assert.deepEqual(scan(l => l.includes(EM_DASH)), []);
});

test('no tracked file contains an emoji', () => {
  assert.deepEqual(scan(l => EMOJI.test(l)), []);
});

test('no tracked file names a home path or a tailnet host', () => {
  assert.deepEqual(scan(l => l.includes(HOME_PATH) || l.includes(TAILNET)), []);
});

test('package.json keeps the frozen scripts and has no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'fathom');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.scripts.start, 'node src/server.mjs');
  assert.match(pkg.scripts.test, /^node --test\b/);
  assert.equal(pkg.scripts['seed:demo'], 'node demo/seed.mjs');
  assert.equal(pkg.scripts.e2e, 'playwright test');
  assert.equal(pkg.scripts['e2e:smoke'], 'playwright test --grep @smoke');
  assert.ok(pkg.devDependencies['@playwright/test']);
  assert.deepEqual(pkg.dependencies || {}, {});
});

test('CI runs unit tests and the Playwright suite on pull requests and pushes to main', () => {
  const file = join(ROOT, '.github/workflows/ci.yml');
  assert.ok(existsSync(file), '.github/workflows/ci.yml exists');
  const yml = readFileSync(file, 'utf8');
  const on = /^(?:on|"on"|'on'):\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(yml);
  assert.ok(on, 'workflow has an on: block');
  const triggers = on[1];
  assert.match(triggers, /^\s+pull_request:?/m, 'triggers on pull_request');
  assert.match(triggers, /^\s+push:\s*\n\s+branches:\s*(?:\[[^\]]*\bmain\b[^\]]*\]|\n\s+-\s*['"]?main['"]?)/m, 'triggers on push to main');
  assert.match(yml, /\bnpm test\b/);
  assert.match(yml, /\bnpm run e2e\b/);
  assert.match(yml, /node-version:\s*['"]?24/);
});
