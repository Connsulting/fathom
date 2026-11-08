#!/usr/bin/env node
// Push exports: node scripts/dump.mjs --household <id> <baseUrl> <files or dirs...>
// FATHOM_SESSION_FILE names a private JSON file with cookie, householdId and contextVersion.
// Each batch verifies the session household and carries its context assertions and Origin.
//
// Walks the arguments (directories recursively, dotfiles skipped), uploads the files to
// <baseUrl>/api/files in multipart batches under the 200 MB request cap, skips and reports files
// over the 50 MB file cap, and prints one line per file: status, row counts by kind, duplicates,
// warnings and the file's base name. Never prints row values. Exits 1 when any request fails.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { householdArg } from '../src/platform/cli.mjs';

const FILE_LIMIT = 50 * 1024 * 1024;
const REQUEST_LIMIT = 200 * 1024 * 1024;
const PART_OVERHEAD = 1024;
const BATCH_BUDGET = REQUEST_LIMIT - 1024 * 1024;

const hidden = p => basename(p).startsWith('.');

function walk(path, out, top) {
  let st;
  try {
    st = statSync(path);
  } catch {
    console.error(`missing ${basename(path)}`);
    out.missing += 1;
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name.startsWith('.')) continue;
      walk(join(path, name), out, false);
    }
  } else if (st.isFile()) {
    if (!top || !hidden(path)) out.files.push({ path, size: st.size });
  }
}

// Batches whose summed size stays under the request cap; files over the file cap are skipped.
function batches(files) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const f of files) {
    if (f.size > FILE_LIMIT) {
      console.log(`skipped over 50 MB ${basename(f.path)}`);
      continue;
    }
    const cost = f.size + PART_OVERHEAD;
    if (cur.length && size + cost > BATCH_BUDGET) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

function summary(result) {
  const counts = result.counts || {};
  const rows = Object.entries(counts.rows || {}).filter(([, n]) => Number.isFinite(n)).map(([k, n]) => `${k}=${n}`);
  const dup = Number.isFinite(counts.duplicates) ? counts.duplicates : 0;
  const warn = Number.isFinite(counts.warnings) ? counts.warnings : 0;
  return `${result.status} ${rows.length ? rows.join(' ') : 'rows=0'} dup=${dup} warn=${warn}`;
}

async function send(baseUrl, batch, session) {
  const headers = {
    cookie: session.cookie, origin: new URL(baseUrl).origin,
    'X-Fathom-Household': session.householdId,
    'X-Fathom-Context-Version': String(session.contextVersion),
  };
  let identity;
  try {
    const res = await fetch(`${baseUrl}/api/identity`, { headers, redirect: 'error' });
    identity = res.ok ? (await res.json()).identity : null;
  } catch { return { ok: false, reason: 'session_unavailable' }; }
  if (identity?.householdId !== session.householdId || !identity?.role) return { ok: false, reason: 'household_context_mismatch' };
  const fd = new FormData();
  for (const f of batch) fd.append('files', new Blob([readFileSync(f.path)]), basename(f.path));
  let res;
  try {
    res = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers, body: fd, redirect: 'error' });
  } catch (err) {
    return { ok: false, reason: `request failed (${(err && err.cause && err.cause.code) || 'network error'})` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status !== 200 || !json || !Array.isArray(json.files)) {
    const reason = json && typeof json.error === 'string' ? json.error : 'unexpected response';
    return { ok: false, reason: `HTTP ${res.status}: ${reason}` };
  }
  return { ok: true, results: json.files };
}

async function main(argv) {
  let selected;
  try { selected = householdArg(argv); } catch (e) { console.error(`dump: ${e.code}`); return 1; }
  const [rawBase, ...paths] = selected.rest;
  if (!rawBase || !paths.length) {
    console.error('usage: node scripts/dump.mjs --household <id> <baseUrl> <files or dirs...>');
    return 2;
  }
  let baseUrl;
  let session;
  try {
    const url = new URL(rawBase);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    baseUrl = rawBase.replace(/\/+$/, '');
    if (!process.env.FATHOM_SESSION_FILE) throw new Error();
    session = JSON.parse(readFileSync(process.env.FATHOM_SESSION_FILE, 'utf8'));
    if (session.householdId !== selected.householdId || !Number.isSafeInteger(session.contextVersion) || session.contextVersion < 1
      || typeof session.cookie !== 'string' || !/^__Host-fathom-session=[A-Za-z0-9_-]+$/.test(session.cookie)) throw new Error();
  } catch { console.error('dump: session_required'); return 1; }
  const found = { files: [], missing: 0 };
  for (const p of paths) walk(p, found, true);
  if (!found.files.length) {
    console.log('no files to upload');
    return found.missing ? 1 : 0;
  }
  let failed = false;
  for (const batch of batches(found.files)) {
    const r = await send(baseUrl, batch, session);
    if (!r.ok) {
      failed = true;
      console.error(`${r.reason}; not uploaded: ${batch.length} file(s)`);
      for (const f of batch) console.log(`failed ${basename(f.path)}`);
      continue;
    }
    batch.forEach((f, i) => {
      const result = r.results[i];
      console.log(result ? `${summary(result)} ${basename(f.path)}` : `failed ${basename(f.path)}`);
      if (!result) failed = true;
    });
  }
  return failed || found.missing ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
