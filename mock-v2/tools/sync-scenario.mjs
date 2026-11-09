#!/usr/bin/env node
// Copies the demo scenario into the design mock.
//   node mock-v2/tools/sync-scenario.mjs          rewrite mock-v2/scenario/example.js
//   node mock-v2/tools/sync-scenario.mjs --check  exit 1 if the mock copy is out of date
//
// The demo scenario (demo/scenario.mjs) is authored directly with invented values and is the
// single source. The mock keeps its own engine.jobs list (the design shows the original mock
// jobs; the demo seeds the scheduler's real jobs), so that one key is carried over unchanged.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..');
const demoPath = path.join(root, 'demo', 'scenario.mjs');
const mockPath = path.join(root, 'mock-v2', 'scenario', 'example.js');

const HEADER = '// Synthetic scenario for the Fathom design mock. Invented demo data, copied from the demo\n' +
  '// scenario by tools/sync-scenario.mjs. Do not edit by hand; edit demo/scenario.mjs and re-run it.\n';
const FOOTER = "window.FATHOM_SCENARIO_SOURCE = 'synthetic';\n";

function readMock() {
  if (!fs.existsSync(mockPath)) return null;
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(mockPath, 'utf8'), sandbox, { filename: 'example.js', timeout: 5000 });
  return sandbox.window.FATHOM_SCENARIO || null;
}

export function render(demo, mockJobs) {
  const sc = JSON.parse(JSON.stringify(demo));
  if (Array.isArray(mockJobs)) sc.engine = { ...sc.engine, jobs: mockJobs };
  return HEADER + 'window.FATHOM_SCENARIO = ' + JSON.stringify(sc, null, 2) + ';\n' + FOOTER;
}

const demo = (await import(pathToFileURL(demoPath).href)).default;
const current = readMock();
const jobs = current && current.engine && Array.isArray(current.engine.jobs) ? current.engine.jobs : null;
const next = render(demo, jobs);

if (process.argv.includes('--check')) {
  const same = fs.existsSync(mockPath) && fs.readFileSync(mockPath, 'utf8') === next;
  if (!same) {
    console.error('sync-scenario: mock-v2/scenario/example.js is out of date; run node mock-v2/tools/sync-scenario.mjs');
    process.exit(1);
  }
  console.log('sync-scenario: mock copy matches the demo scenario');
} else {
  fs.writeFileSync(mockPath, next);
  console.log('sync-scenario: wrote mock-v2/scenario/example.js');
}
