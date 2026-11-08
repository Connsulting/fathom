#!/usr/bin/env node
// Dry run of the ingest pipeline over a directory of exports: node scripts/ingest-check.mjs <dir>
//
// Builds a throwaway real household under the OS temp dir (households/<id> with its own store and
// a random in-memory data key, so uploads go through the household vault as on a server), imports
// every non-dot file in <dir> (recursively; .key and .json files are local keys and credentials,
// not exports, and are skipped), then imports the same files again to show re-import dedupe.
// The engine is off unless FATHOM_ENGINE=fake. Prints totals only (files by status, rows by kind,
// duplicates, revised, superseded, warnings by code, pending questions by kind), never file names
// or values. The temp dir is always deleted.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { createStoreFile, setSetting, DB_FILE } from '../src/store/db.mjs';
import { householdRoot, dataKeyHandle } from '../src/platform/household-vault.mjs';
import { ingestFiles } from '../src/ingest/pipeline.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';

const SKIP_EXT = new Set(['.key', '.json']);
const MIME = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};
const IDENT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const label = v => (typeof v === 'string' && IDENT.test(v) ? v : 'other');
const HOUSEHOLD = 'hh-ingest-check';

// The pipeline's view of a household: its store (in its root), in-flight set and vault.
async function throwawayHousehold(tmp) {
  const root = await householdRoot({ dataRoot: tmp, householdId: HOUSEHOLD, relativeRoot: `households/${HOUSEHOLD}`, create: true });
  const db = await createStoreFile(join(root.path, DB_FILE), async d => await setSetting(d, 'mode', 'real'));
  const key = randomBytes(32);
  const handle = dataKeyHandle({ householdId: HOUSEHOLD, version: 1, key });
  key.fill(0);
  const vault = Object.freeze({ root, handle });
  return Object.freeze({ householdId: HOUSEHOLD, db, root: root.path, inFlight: new Set(), vault: async () => vault });
}

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) listFiles(path, out);
    else if (st.isFile() && !SKIP_EXT.has(extname(name).toLowerCase())) out.push(path);
  }
  return out;
}

const readFiles = paths => paths.map(p => ({
  name: basename(p),
  bytes: new Uint8Array(readFileSync(p)),
  mime: MIME[extname(p).toLowerCase()] || 'application/octet-stream',
}));

const add = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + (Number.isFinite(n) ? n : 0); };
const line = obj => {
  const keys = Object.keys(obj).sort();
  return keys.length ? keys.map(k => `${k}=${obj[k]}`).join(' ') : 'none';
};

async function totals(results, db) {
  const t = { status: {}, rows: {}, duplicates: 0, revised: 0, superseded: 0, warnings: {}, queue: {} };
  for (const r of results) {
    add(t.status, label(r.status));
    const c = r.counts || {};
    for (const [kind, n] of Object.entries(c.rows || {})) add(t.rows, label(kind), n);
    for (const [code, n] of Object.entries(c.warningCodes || {})) add(t.warnings, label(code), n);
    for (const k of ['duplicates', 'revised', 'superseded']) if (Number.isFinite(c[k])) t[k] += c[k];
  }
  for (const q of await db.prepare("SELECT kind, count(*) AS n FROM confirm_items WHERE status = 'pending' GROUP BY kind").all()) {
    add(t.queue, label(q.kind), q.n);
  }
  return t;
}

function print(pass, t) {
  console.log(`pass ${pass}`);
  console.log(`  files: ${line(t.status)}`);
  console.log(`  rows: ${line(t.rows)}`);
  console.log(`  duplicates=${t.duplicates} revised=${t.revised} superseded=${t.superseded}`);
  console.log(`  warnings: ${line(t.warnings)}`);
  console.log(`  pending questions: ${line(t.queue)}`);
}

async function main(argv) {
  const dirArg = argv[0];
  if (!dirArg) {
    console.error('usage: node scripts/ingest-check.mjs <dir>');
    return 2;
  }
  const dir = resolve(dirArg);
  let paths;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    paths = listFiles(dir);
  } catch {
    console.error('ingest-check: the argument must be a readable directory');
    return 2;
  }
  console.log(`files found: ${paths.length}`);

  const tmp = mkdtempSync(join(tmpdir(), 'fathom-ingest-check-'));
  let db;
  try {
    const household = await throwawayHousehold(tmp);
    db = household.db;
    const engineMode = process.env.FATHOM_ENGINE === 'fake' ? 'fake' : 'off';
    const config = {
      dataDir: tmp, port: 0, host: '127.0.0.1', demo: false, engine: engineMode, clock: null,
      claudeCredentialFile: null, emailTransport: 'dev',
    };
    const engine = await createRuntimeEngine({ db, config });
    for (const pass of [1, 2]) {
      const { results } = await ingestFiles(db, readFiles(paths), { household, engine, config, now: new Date().toISOString() });
      print(pass, await totals(results, db));
    }
    return 0;
  } catch (err) {
    const code = [err && err.code, err && err.name].find(v => typeof v === 'string' && IDENT.test(v)) || 'unknown';
    console.error(`ingest-check failed: ${code}`);
    return 1;
  } finally {
    try { if (db) await db.close(); } catch { /* already closed */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
