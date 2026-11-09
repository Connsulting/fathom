// PG-2 storage boundary: only the SQLite adapter touches the driver, no module outside the adapters
// runs raw transaction SQL, and every call that reaches the asynchronous storage port (directly or
// through any function that does, including authorization and admission) is consumed as a Promise.
// Run directly: node test/storage/architecture.test.mjs (prints the caller inventory with --inventory).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, consumption } from './async-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADAPTER = 'src/storage/';
// Adapter conformance tests may inspect their own driver.
const DRIVER_TESTS = new Set(['test/storage/port.test.mjs']);
const rel = file => relative(ROOT, file);

function moduleFiles() {
  return execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
    .filter(f => !/^(web|mock-v2)\//.test(f) && !f.startsWith('playwright.'));
}

// Consumption forms that keep a Promise's rejection on the caller's path.
const CONSUMED = new Set(['await', 'return', 'void', 'chain', 'all', 'value']);
// Authorization and admission entry points: these must be awaited (or returned) outright, never held
// in a variable, so a pending or rejected decision can never be read as an allow.
const GUARDS = /^(isOn|monthSpendUsd|creatorActive|require\w*|authorize\w*|authenticate\w*|admit\w*|reserve\w*|checkAccess|currentSession|session|identity\w*|resolveSession|verify\w*|assert\w*Access|canAct|ownerOf|membership|lastAdmin\w*|removeMember|revoke\w*|guard\w*|outboundGuard|allowed\w*|ensureFunded|instanceFunded|funded\w*|admission\w*|begin\w*Round|engineAllowed)$/;

function problems(files) {
  const g = analyze(files.map(f => join(ROOT, f)), {
    root: ROOT,
    driver: file => rel(file).startsWith(`${ADAPTER}sqlite/`) || DRIVER_TESTS.has(rel(file)),
    roots: fn => fn.wasAsync && rel(fn.mod.file).startsWith(ADAPTER),
  });
  const out = [];
  for (const fn of g.fns) {
    if (!fn.reaches || fn.async) continue;
    out.push(`${rel(fn.mod.file)}:${line(fn.mod, fn.node.start)} ${fn.names[0] || fn.method || 'function'} reaches storage but is not async`);
  }
  for (const c of g.calls) {
    if (!c.reaches) continue;
    const how = consumption(c);
    const names = c.targets.map(t => t.names[0] || t.method).filter(Boolean);
    const guarded = names.some(n => GUARDS.test(n));
    if (!CONSUMED.has(how) || (guarded && !['await', 'return'].includes(how))) {
      out.push(`${rel(c.mod.file)}:${line(c.mod, c.node.start)} ${how} ${c.mod.src.slice(c.node.start, Math.min(c.node.end, c.node.start + 60)).replace(/\s+/g, ' ')}`);
    }
  }
  // A guard reached through an option or callback the graph cannot resolve is still a guard: a call
  // named like one must be awaited or returned unless every resolved definition is synchronous.
  const byName = new Map();
  for (const fn of g.fns) for (const n of new Set([...fn.names, fn.method].filter(Boolean))) byName.set(n, [...(byName.get(n) ?? []), fn]);
  for (const c of g.calls) {
    if (c.reaches) continue;
    const callee = g.unwrap(c.node.callee);
    const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? g.propName(callee.property) : null;
    if (!name || name === 'require' || !GUARDS.test(name)) continue;
    const defs = c.targets.length ? c.targets : byName.get(name) ?? [];
    if (defs.length && defs.every(t => !t.async)) continue;
    const how = consumption(c);
    if (!['await', 'return'].includes(how)) out.push(`${rel(c.mod.file)}:${line(c.mod, c.node.start)} ${how} guard ${name}()`);
  }
  return { g, out };
}

const lines = new Map();
function line(mod, pos) {
  if (!lines.has(mod)) lines.set(mod, [...mod.src.matchAll(/\n/g)].map(m => m.index));
  const breaks = lines.get(mod);
  let lo = 0, hi = breaks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < pos) lo = mid + 1; else hi = mid; }
  return lo + 1;
}

test('only the SQLite adapter imports node:sqlite or names DatabaseSync', () => {
  const offenders = moduleFiles().filter(f => !f.startsWith(`${ADAPTER}sqlite/`) && !DRIVER_TESTS.has(f) && f !== 'test/storage/architecture.test.mjs')
    .filter(f => /node:sqlite|\bDatabaseSync\b/.test(readFileSync(join(ROOT, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  assert.deepEqual(offenders, []);
});

test('no module outside the adapters runs raw transaction or PRAGMA SQL', () => {
  const RAW = /['"`]\s*(BEGIN(\s+(IMMEDIATE|EXCLUSIVE|DEFERRED))?|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/;
  const offenders = [];
  for (const f of moduleFiles()) {
    if (f.startsWith(ADAPTER) || DRIVER_TESTS.has(f) || f === 'test/storage/architecture.test.mjs') continue;
    const text = readFileSync(join(ROOT, f), 'utf8').split('\n');
    text.forEach((l, i) => { if (!/^\s*\/\//.test(l) && RAW.test(l)) offenders.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

test('scopes and handles expose no driver escape hatch', async () => {
  const { openScope } = await import('../../src/storage/index.mjs');
  const scope = await openScope({ path: ':memory:' });
  try {
    for (const name of ['exec', 'isTransaction', 'function', 'aggregate', 'loadExtension', 'createSession', 'location']) {
      assert.equal(name in scope, false, `scope.${name}`);
    }
    await scope.transaction(async tx => {
      for (const name of ['exec', 'transaction', 'applySchema', 'migrate', 'backupTo', 'close']) assert.equal(name in tx, false, `tx.${name}`);
    });
    assert.equal((await scope.prepare('SELECT 1 AS n').run()).lastInsertRowid, undefined);
  } finally {
    await scope.close();
  }
});

test('every storage-reaching function is async and every call of one is consumed as a Promise', () => {
  const { out } = problems(moduleFiles());
  assert.deepEqual(out, []);
});

test('the check rejects an un-awaited authorization and admission call, including one passed as an option', () => {
  const dir = mkdtempSync(join(ROOT, 'test', 'storage', '.arch-'));
  try {
    const store = join(dir, 'store.mjs');
    const guard = join(dir, 'guard.mjs');
    writeFileSync(store, `export async function requireMember(db, id) {
  const row = await db.prepare('SELECT 1 AS ok FROM memberships WHERE id = ?').get(id);
  if (!row) throw new Error('forbidden');
  return row;
}
export async function admitRound(db, budget) {
  return db.prepare('SELECT ? AS max').get(budget.maxCostUsd);
}
`);
    writeFileSync(guard, `import { requireMember, admitRound } from './store.mjs';
export async function handler(db, id) {
  requireMember(db, id);
  if (admitRound(db, { maxCostUsd: 1 })) return 'allowed';
  const pending = requireMember(db, id);
  return pending;
}
export async function fine(db, id) {
  await requireMember(db, id);
  return admitRound(db, { maxCostUsd: 1 });
}
export async function viaOption({ admit }) {
  return admit() ? 'allowed' : 'refused';
}
`);
    const { out } = problems([rel(store), rel(guard)]);
    const at = out.map(o => o.replace(/^.*guard\.mjs:/, '').split(' ').slice(0, 2).join(' '));
    assert.deepEqual(at, ['3 floating', '4 condition', '5 value', '13 condition']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (process.argv.includes('--inventory')) {
  const { g } = problems(moduleFiles());
  const byFile = new Map();
  for (const fn of g.fns) {
    if (!fn.reaches) continue;
    const f = rel(fn.mod.file);
    if (!byFile.has(f)) byFile.set(f, 0);
    byFile.set(f, byFile.get(f) + 1);
  }
  const rows = [...byFile].sort((a, b) => a[0].localeCompare(b[0]));
  const dirs = new Map();
  for (const [f, n] of rows) { const d = f.split('/').slice(0, 2).join('/'); dirs.set(d, (dirs.get(d) || 0) + n); }
  console.log(`storage-reaching async functions: ${rows.reduce((a, [, n]) => a + n, 0)} in ${rows.length} modules`);
  for (const [d, n] of [...dirs].sort()) console.log(`${d}\t${n}`);
}
