// H1 AC1: every file status, driven through the stored files row, a reload (a fresh ingestState),
// Home (the Imports service and its one line), Files (the rendered screen: plain label, plain cause
// and exactly one control) and that control's server path, plus an identical re-upload. Also: parse
// warnings name their rows, low-confidence facts ask in plain words, and the Home data line leaves
// failed files to the Imports service line. Every value is synthetic.
//
// Each state is produced through the real pipeline where a path exists: a parser injected through
// the `parser` option whose parse throws (failed), the same with error code store_locked (transient
// failure), an empty file and an unknown binary (unsupported), a file past the parse limits
// (too_large), the stored bytes plus 'pending' row an interrupted ingestFile leaves (pending), and the
// fake-mode engine of test/helpers/model-cutover.mjs for the model waiting states. needs_mapping and
// needs_extraction have no current producer: they are set with an UPDATE on a stored file row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NOW, aggregatorFile, textFile } from '../helpers/ingest.mjs';
import { setup, upload, approve } from '../helpers/model-cutover.mjs';
import { recipe } from '../helpers/model-import.mjs';
import * as P from '../../src/ingest/pipeline.mjs';
import { ingestState } from '../../src/ingest/freshness.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { reviewImport } from '../../src/ingest/model-review.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';
import { recordFact } from '../../src/ingest/confirm.mjs';
import { removeFile } from '../../src/accounts/sources.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { serviceStatus } from '../../src/jobs/service-status.mjs';
import * as Web from '../../web/horizon/screens/ingest.js';
import * as view from '../../web/horizon/screens/service-status.js';
import { healthLine } from '../../web/horizon/screens/home-model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DAY = 86400000;
view.bind({ esc });

const fileRowOf = (db, id) => { const r = db.prepare('SELECT * FROM files WHERE id = ?').get(id); return r ? { ...r } : r; };
const EMPTY = Object.freeze({ pending: 0, items: [], decided: [], files: [], waiting: [], sources: [], accounts: {}, staleNotes: [], formats: [] });

// The Files screen as design.js builds it, with the helper shapes design.js passes in and a stub API
// that records what the screen sends.
function harness(state, { engineOn = false, uploadResult = null } = {}) {
  const calls = [];
  const api = {
    s: {}, route: { name: 'add' }, go() {}, engineOn: () => engineOn,
    ingest: () => state,
    reviewImport: (...args) => { calls.push(['reviewImport', ...args]); return Promise.resolve({ status: 'queued' }); },
    retryFile: (id) => { calls.push(['retryFile', id]); return Promise.resolve({}); },
    removeFile: (id) => { calls.push(['removeFile', id]); return Promise.resolve({ id, receipt: { id: 'r-remove-synthetic' } }); },
    actionUndo: (id) => { calls.push(['actionUndo', id]); return Promise.resolve({ ok: true }); },
    upload: (files) => { calls.push(['upload', files.length]); return Promise.resolve(uploadResult); },
  };
  const h = {
    api, esc, draw() {}, getUi: () => ({}), addBtn: () => '', icon: () => '',
    shell: (inner) => inner,
    section: (title, body) => `<section><h2>${title}</h2>${body}</section>`,
    pageHead: (k, t) => `<h1>${t}</h1>`,
    btn: (label, attrs, cls = '') => `<button type="button" class="h-btn ${cls}" ${attrs}>${label}</button>`,
  };
  return { screens: Web.ingestScreens(h), calls };
}

// One waiting row of the rendered Files screen (it may hold nested lists), or null.
function rowOf(html, id) {
  const at = html.indexOf(`data-proposal-file="${id}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<li', at);
  const next = html.indexOf('data-proposal-file="', at + 1);
  const stop = next < 0 ? html.indexOf('</section>', at) : html.lastIndexOf('<li', next);
  return html.slice(start, stop < 0 ? undefined : stop);
}
const tagsOf = (html) => [...String(html).matchAll(/<(?:button|a|input)\b[^>]*>/g)].map((m) => m[0]);
// The controls a row offers, one entry per control element. The approve review block carries a
// correction button beside Looks right; it is part of the one approve control.
function controlsOf(row) {
  const approve = /data-proposal-approve="/.test(row);
  const kinds = [];
  for (const tag of tagsOf(row)) {
    if (!/^<(button|a)\b/.test(tag)) continue;
    if (/data-retry="/.test(tag)) kinds.push('retry');
    else if (/data-replace="/.test(tag)) kinds.push('replace');
    else if (/data-upload-open="/.test(tag)) kinds.push('upload');
    else if (/data-proposal-approve="/.test(tag)) kinds.push('approve');
    else if (/data-proposal-correct="/.test(tag)) { if (!approve) kinds.push('answer'); }
    else if (/data-proposal-engine/.test(tag)) kinds.push('engine');
  }
  return kinds;
}
const labelOf = (row) => text(/<em data-proposal-status[^>]*>([\s\S]*?)<\/em>/.exec(row)?.[1]);
const causeOf = (row) => text(/<p data-proposal-cause[^>]*>([\s\S]*?)<\/p>/.exec(row)?.[1]);

// A DOM-like element for a rendered tag: tagName, dataset (data-* in camelCase) and matches(selector)
// for the simple tag[attr][attr=value] selectors the screen uses.
function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/\s([a-zA-Z][\w-]*)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? '';
  return out;
}
function element(tag) {
  const name = /^<([a-z]+)/.exec(tag)[1];
  const attrs = attrsOf(tag);
  const dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
    .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  const one = (sel) => {
    const m = /^([a-z]+)?((?:\[[^\]]+\])*)$/.exec(sel.trim());
    if (!m || (m[1] && m[1] !== name)) return false;
    for (const a of m[2].matchAll(/\[([a-zA-Z][\w-]*)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (!(a[1] in attrs)) return false;
      if (a[2] !== undefined && attrs[a[1]] !== a[2]) return false;
    }
    return true;
  };
  return { tagName: name.toUpperCase(), dataset, getAttribute: (k) => attrs[k] ?? null, matches: (sel) => sel.split(',').some(one) };
}

// The upload results list (Add files section) after the screen receives `result` from an upload.
async function uploadResultHtml(result) {
  const { screens } = harness(EMPTY, { uploadResult: { files: [result], pending: 0 } });
  const input = { matches: (sel) => sel === 'input[type=file][data-upload]', files: [{ name: result.name ?? 'synthetic.csv' }], value: 'x', dataset: {} };
  assert.equal(screens.handleChange({ type: 'change', target: input }), true);
  await settle();
  const html = screens.addFiles('add');
  const cut = html.indexOf('Waiting files');
  return cut < 0 ? html : html.slice(0, cut);
}

// The background caller's options (S1.4): the scheduler's resume pass passes actorId 'fathom'.
const bg = (x) => ({ ...x.opts, actorId: 'fathom' });
const throwing = (error) => ({ id: 'aggregator', label: 'Aggregator transactions', sourceKind: 'aggregator_csv', parse() { throw error; } });
const plainError = () => new Error('synthetic parse failure naming Synthetic Private Payee');
const lockedError = () => Object.assign(new Error('synthetic lock naming Synthetic Private Payee'), { code: 'store_locked' });
const csvOf = (tag, amount = '12.25') => aggregatorFile(`${tag}-synthetic.csv`, [
  { date: '2032-03-02', amount, description: `Synthetic ${tag} purchase`, number: '5550007171' },
  { date: '2032-03-03', amount: '2.50', description: `Synthetic ${tag} refund`, number: '5550007171' },
]);
const WIDE = Array.from({ length: 600 }, (_, i) => `c${i}`).join(',') + '\n' + Array.from({ length: 600 }, () => '1').join(',') + '\n';
const SCAN = () => ({ name: 'scan-synthetic.pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF'), mime: 'application/pdf' });
const MODEL_CSV = (tag) => `Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic ${tag} purchase\naccount-synthetic,2032-03-03,2.25,Synthetic ${tag} refund\nTotal,,-10.00,Control total\n`;
const modelFile = (csv) => ({ name: 'synthetic.csv', bytes: Buffer.from(csv) });

// The stored bytes and 'pending' row an interrupted ingestFile leaves: exactly what ingestFile writes
// before routing, with no routing after it.
async function leavePending(x, file) {
  const bytes = new Uint8Array(file.bytes);
  const hash = sha256(bytes);
  const fileId = 'f-' + hash.slice(0, 24);
  const vault = await openVault(x.household);
  const storedPath = await storeFile({ vault, id: fileId, bytes, purpose: 'upload' });
  x.db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(fileId, file.name, file.mime ?? null, bytes.length, hash, NOW, storedPath);
  return fileId;
}

// The fake-mode engine response that interprets a model CSV with the recipe layout.
async function fakeFor(csv) {
  const bytes = Buffer.from(csv);
  const fileId = 'f-' + sha256(bytes).slice(0, 24);
  const source = await indexSource({ fileId, bytes, name: 'synthetic.csv', format: 'csv' });
  const layout = recipe();
  const p = applyLayout(source, layout);
  return [{ text: JSON.stringify({ rows: p.rows, coverage: p.coverage, completeness: p.completeness, controls: p.controls, layout }), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } }];
}

// Replace: upload a good file, then remove the replaced one (the client calls POST /api/files/:id/remove).
async function replaceWithGood(x, made) {
  const { results: [good] } = await P.ingestFiles(x.db, [csvOf(`replacement ${made.fileId}`, '7.75')], x.opts);
  assert.equal(good.status, 'imported');
  const removed = removeFile({ db: x.db, now: NOW, actorId: 'actor-synthetic' }, made.fileId);
  assert.equal(removed.id, made.fileId);
  return { leaves: true };
}
async function retried(x, made) {
  const out = await P.retryFile(x.db, made.fileId, x.opts);
  assert.equal(out.status, 'imported');
  assert.equal(fileRowOf(x.db, made.fileId).status, 'imported');
  return { leaves: true };
}

const CAUSE = {
  pending: 'File saved. Fathom finishes importing it automatically.',
  failedTransient: 'File saved. Something went wrong while reading it; Fathom tries once more automatically.',
  failed: 'File saved. Something went wrong while reading it. Retry reads the saved file again.',
  empty: 'The file is empty. Export it again and add the new copy.',
  unsupported: 'Fathom cannot read this kind of file. Add a CSV, Excel workbook, PDF or text export instead.',
  tooLarge: 'This file is too large to read at once. Add a smaller export, such as one year at a time.',
  mapping: "Fathom has not matched this file's columns yet. Retry reads it again.",
  pdfUnreadable: 'Fathom could not read the text in this PDF. Add a text export or a PDF with selectable text.',
  extraction: 'Fathom has not read this document yet. Retry reads it again.',
  // IMP-6 entries keep their text (H1 does not change them).
  waitingForEngine: 'File saved. Waiting for the engine to interpret it.',
  fileLimit: 'File saved. This file needs more interpretation than one file is allowed; add a smaller file or split it.',
  needsConfirmation: 'Nothing is imported until you approve.',
  needsClarification: 'Fathom needs one answer before it can import this.',
  needsSourceText: 'File saved. It has no readable text; add a text export or a PDF with selectable text.',
  correction: 'Your correction is saved. Waiting for the engine to read the file again.',
};

// One row per status. stored: the files row status after `make`; note: the stored note, or a list of
// accepted notes where the plan does not pin one; home: the Imports service state; control: the one
// control Files shows; dup: what an identical re-upload answers ('reroute' = routed again and
// imported, 'duplicate', or 'status' = its own stored status with duplicateOf).
const ROWS = [
  {
    name: 'pending (interrupted upload)', stored: 'pending', note: null, home: 'retrying', label: 'Finishing import', cause: CAUSE.pending, control: 'retry', dup: 'reroute',
    async make(x) { const file = csvOf('interrupted'); return { file, fileId: await leavePending(x, file) }; },
    async recover(x, made) {
      const out = await P.resumeImports(x.db, bg(x));
      assert.deepEqual(out.resumed, [{ fileId: made.fileId, status: 'imported' }]);
      assert.equal(fileRowOf(x.db, made.fileId).status, 'imported');
      return { leaves: true };
    },
  },
  {
    name: 'failed', stored: 'failed', note: 'Error', home: 'needs_you', label: 'Could not import', cause: CAUSE.failed, control: 'retry', dup: 'reroute',
    async make(x) {
      const file = csvOf('failed');
      const result = await P.ingestFile(x.db, file, { ...x.opts, parser: throwing(plainError()) });
      assert.equal(result.status, 'failed');
      assert.equal(result.reasonCode, 'Error');
      return { file, fileId: result.fileId, result };
    },
    async recover(x, made) {
      // Liveness of the automatic pass: a non-transient failure is not retried by itself.
      const auto = await P.resumeImports(x.db, bg(x));
      assert.deepEqual(auto.resumed, []);
      assert.deepEqual([fileRowOf(x.db, made.fileId).status, fileRowOf(x.db, made.fileId).note], ['failed', 'Error']);
      return retried(x, made);
    },
  },
  {
    name: 'failed, transient (retry:store_locked)', stored: 'failed', note: 'retry:store_locked', home: 'retrying', label: 'Could not import', cause: CAUSE.failedTransient, control: 'retry', dup: 'reroute',
    async make(x) {
      const file = csvOf('transient');
      const result = await P.ingestFile(x.db, file, { ...x.opts, parser: throwing(lockedError()) });
      assert.equal(result.status, 'failed');
      assert.equal(result.reasonCode, 'retry:store_locked');
      return { file, fileId: result.fileId, result };
    },
    async recover(x, made) {
      const out = await P.resumeImports(x.db, bg(x));
      assert.deepEqual(out.resumed, [{ fileId: made.fileId, status: 'imported' }]);
      return { leaves: true };
    },
  },
  {
    name: 'unsupported (empty file)', stored: 'unsupported', note: [null, 'empty_file'], home: 'needs_you', label: 'Not a file Fathom reads', cause: CAUSE.empty, control: 'replace', dup: 'status',
    async make(x) { const file = textFile('empty-synthetic.csv', '', 'text/csv'); const result = await P.ingestFile(x.db, file, x.opts); return { file, fileId: result.fileId, result }; },
    recover: replaceWithGood,
  },
  {
    name: 'unsupported (unknown binary)', stored: 'unsupported', note: [null, 'unsupported_format'], home: 'needs_you', label: 'Not a file Fathom reads', cause: CAUSE.unsupported, control: 'replace', dup: 'status',
    async make(x) {
      const file = { name: 'blob-synthetic.bin', bytes: new Uint8Array([0, 1, 2, 3, 250, 251, 252, 0, 0, 7]) };
      const result = await P.ingestFile(x.db, file, x.opts);
      return { file, fileId: result.fileId, result };
    },
    recover: replaceWithGood,
  },
  {
    name: 'too_large', stored: 'too_large', note: 'limit_exceeded', home: 'needs_you', label: 'Too large to read', cause: CAUSE.tooLarge, control: 'replace', dup: 'status',
    async make(x) { const file = textFile('wide-synthetic.csv', WIDE, 'text/csv'); const result = await P.ingestFile(x.db, file, x.opts); return { file, fileId: result.fileId, result }; },
    recover: replaceWithGood,
  },
  {
    // Legacy: no current path writes needs_mapping; a stored row is set with an UPDATE.
    name: 'needs_mapping (legacy)', stored: 'needs_mapping', note: null, home: 'needs_you', label: 'Columns not matched yet', cause: CAUSE.mapping, control: 'retry', dup: 'status',
    async make(x) {
      const file = csvOf('mapping');
      const r = await P.ingestFile(x.db, file, x.opts);
      assert.equal(r.status, 'imported');
      x.db.prepare("UPDATE files SET status = 'needs_mapping', note = NULL WHERE id = ?").run(r.fileId);
      return { file, fileId: r.fileId };
    },
    recover: retried,
  },
  {
    // Legacy: a PDF pdfjs could not read, set with an UPDATE on a stored file row.
    name: 'needs_extraction (pdf_unreadable, legacy)', stored: 'needs_extraction', note: 'pdf_unreadable', home: 'needs_you', label: 'Not read yet', cause: CAUSE.pdfUnreadable, control: 'replace', dup: 'status',
    async make(x) {
      const file = SCAN();
      const r = await P.ingestFile(x.db, file, x.opts);
      x.db.prepare("UPDATE files SET status = 'needs_extraction', note = 'pdf_unreadable' WHERE id = ?").run(r.fileId);
      return { file, fileId: r.fileId };
    },
    recover: replaceWithGood,
  },
  {
    // Legacy: no current path writes needs_extraction; a stored row is set with an UPDATE.
    name: 'needs_extraction (legacy, other)', stored: 'needs_extraction', note: null, home: 'needs_you', label: 'Not read yet', cause: CAUSE.extraction, control: 'retry', dup: 'status',
    async make(x) {
      const file = csvOf('extraction');
      const r = await P.ingestFile(x.db, file, x.opts);
      assert.equal(r.status, 'imported');
      x.db.prepare("UPDATE files SET status = 'needs_extraction', note = NULL WHERE id = ?").run(r.fileId);
      return { file, fileId: r.fileId };
    },
    recover: retried,
  },
  {
    name: 'waiting_for_engine', stored: 'waiting_for_engine', note: 'engine_unavailable', home: 'needs_you', label: 'Waiting for the engine', cause: CAUSE.waitingForEngine, control: 'engine', engineOn: false, dup: 'status',
    async make(x) {
      setSetting(x.db, 'engine', { on: false });
      const csv = MODEL_CSV('engine off');
      const r = await upload(x, csv);
      return { file: modelFile(csv), fileId: r.fileId, csv };
    },
    // The engine control turns the engine on; then Retry interprets the saved file and approval imports it.
    async recover(x, made) {
      setSetting(x.db, 'engine', { on: true });
      const staged = await P.retryFile(x.db, made.fileId, { ...x.opts, fake: await fakeFor(made.csv) });
      assert.equal(staged.status, 'needs_confirmation');
      assert.equal((await approve(x, staged)).status, 'imported');
      return { leaves: true };
    },
  },
  {
    name: 'budget_exhausted', stored: 'budget_exhausted', note: 'request_does_not_fit', home: 'needs_you', label: 'Interpretation budget reached', cause: CAUSE.fileLimit, control: 'upload', engineOn: true, dup: 'status',
    async make(x) {
      setSetting(x.db, 'cap', { usd: 0 });
      const csv = MODEL_CSV('capped');
      const r = await upload(x, csv);
      return { file: modelFile(csv), fileId: r.fileId, csv };
    },
    // Once the budget allows, Retry interprets the saved file and approval imports it.
    async recover(x, made) {
      x.db.prepare("DELETE FROM settings WHERE key = 'cap'").run();
      const staged = await P.retryFile(x.db, made.fileId, { ...x.opts, fake: await fakeFor(made.csv) });
      assert.equal(staged.status, 'needs_confirmation');
      assert.equal((await approve(x, staged)).status, 'imported');
      return { leaves: true };
    },
  },
  {
    name: 'needs_confirmation', stored: 'needs_confirmation', note: [null], home: 'needs_you', label: 'Ready for review', cause: CAUSE.needsConfirmation, control: 'approve', engineOn: true, dup: 'status',
    async make(x) { const csv = MODEL_CSV('review'); const r = await upload(x, csv); return { file: modelFile(csv), fileId: r.fileId, staged: r }; },
    async recover(x, made) { assert.equal((await approve(x, made.staged)).status, 'imported'); return { leaves: true }; },
  },
  {
    name: 'needs_clarification', stored: 'needs_clarification', note: 'unmapped_amount', home: 'needs_you', label: 'Needs clarification', cause: CAUSE.needsClarification, control: 'answer', engineOn: true, dup: 'status',
    async make(x) {
      const first = await upload(x, MODEL_CSV('approved layout'));
      assert.equal((await approve(x, first)).status, 'imported');
      const csv = 'Account,Date,Amount USD,Description,Credit\naccount-synthetic,2032-03-05,-8.00,Synthetic changed row,1.00\n';
      const r = await upload(x, csv);
      return { file: modelFile(csv), fileId: r.fileId };
    },
    // The documented next state of an answer: the correction is saved and the file waits for the engine.
    async recover(x, made) {
      const w = ingestState(x.db).waiting.find((f) => f.id === made.fileId);
      const evidence = 'Column 5 is a synthetic credit amount.';
      const out = await reviewImport({ ...x.ctx, ownerText: evidence }, { proposalId: w.proposal.id, version: w.proposal.version, decision: 'correct', evidence });
      assert.ok(out.version > w.proposal.version);
      const after = ingestState(x.db).waiting.find((f) => f.id === made.fileId);
      assert.equal(Web.proposalStatus(after), 'waiting_for_engine');
      const row = rowOf(harness(ingestState(x.db), { engineOn: true }).screens.addFiles('add'), made.fileId);
      assert.equal(causeOf(row), CAUSE.correction);
      return { leaves: false };
    },
  },
  {
    name: 'needs_source_text', stored: 'needs_source_text', note: [null, 'no_safe_source_text'], home: 'needs_you', label: 'Needs readable text', cause: CAUSE.needsSourceText, control: 'upload', engineOn: true, dup: 'status',
    async make(x) { const file = SCAN(); const r = await P.ingestFile(x.db, file, x.opts); return { file, fileId: r.fileId, result: r }; },
    // Add files with a readable export, then remove the scan from Sources.
    recover: replaceWithGood,
  },
  {
    name: 'imported', stored: 'imported', note: null, home: 'healthy', dup: 'duplicate',
    async make(x) { const file = csvOf('imported'); const r = await P.ingestFile(x.db, file, x.opts); assert.equal(r.status, 'imported'); return { file, fileId: r.fileId, result: r }; },
  },
  {
    name: 'duplicate', stored: 'imported', note: null, home: 'healthy', dup: 'duplicate',
    async make(x) {
      const file = csvOf('duplicate');
      const first = await P.ingestFile(x.db, file, x.opts);
      const r = await P.ingestFile(x.db, file, x.opts);
      assert.equal(r.status, 'duplicate');
      assert.equal(r.duplicateOf, first.fileId);
      return { file, fileId: first.fileId, result: r };
    },
  },
];

const RESOLVED = ['imported', 'duplicate'];
const isUnresolved = (row) => row.home !== 'healthy';
const noteOk = (expected, actual) => (Array.isArray(expected) ? expected.includes(actual) : actual === expected);

test('the table covers every unresolved status from src/ingest/file-status.mjs and both resolved ones', async () => {
  const FS = await import('../../src/ingest/file-status.mjs');
  assert.ok(Object.isFrozen(FS.UNRESOLVED));
  assert.deepEqual([...FS.UNRESOLVED].sort(), ['budget_exhausted', 'failed', 'needs_clarification', 'needs_confirmation', 'needs_extraction', 'needs_mapping',
    'needs_source_text', 'pending', 'too_large', 'unsupported', 'waiting_for_engine']);
  assert.deepEqual([...FS.RESOLVED].sort(), [...RESOLVED].sort());
  const covered = new Set(ROWS.filter(isUnresolved).map((r) => r.stored));
  assert.deepEqual([...covered].sort(), [...FS.UNRESOLVED].sort());
});

for (const row of ROWS) {
  test(`${row.name}: stored, reloaded, on Home and Files, and recovered`, async () => {
    const x = await setup();
    try {
      const made = await row.make(x);
      const id = made.fileId;
      const where = row.name;

      // (a) Persisted: the files row.
      const stored = fileRowOf(x.db, id);
      assert.equal(stored.status, row.stored, where);
      assert.ok(noteOk(row.note, stored.note), `${where}: note ${stored.note}`);
      assert.ok(!String(stored.note ?? '').includes('Synthetic Private Payee'), 'no error message text is stored');

      // (b) Reload: a fresh ingestState lists the file in `waiting` exactly when it is unresolved.
      const state = ingestState(x.db);
      const waiting = state.waiting.find((f) => f.id === id);
      if (isUnresolved(row)) {
        assert.ok(waiting, `${where}: listed after a reload`);
        assert.equal(waiting.status, row.stored, where);
      } else assert.equal(waiting, undefined, `${where}: a resolved file is not waiting`);

      // (c) Home: the Imports service and the one attention line.
      const services = serviceStatus({ db: x.db, now: new Date(NOW) });
      const imports = services.imports;
      assert.ok(imports, `${where}: an imports service`);
      assert.equal(imports.key, 'imports');
      assert.equal(imports.label, 'Imports');
      assert.equal(imports.go, 'add');
      assert.equal(imports.control, null);
      assert.equal(imports.nextAttemptAt, null);
      assert.equal(imports.state, row.home, where);
      assert.equal(imports.files, isUnresolved(row) ? 1 : 0, where);
      if (row.home === 'needs_you') {
        assert.equal(imports.cause, '1 file needs you on Files.', where);
        assert.equal(imports.since, new Date(NOW).toISOString(), where);
        assert.equal(services.attention?.key, 'imports', where);
        const html = view.homeServiceHtml(services);
        assert.equal((html.match(/data-service-line/g) || []).length, 1, where);
        assert.match(html, /data-go="add"/, where);
        assert.equal(text(html), 'Imports: 1 file needs you on Files.', where);
      } else if (row.home === 'retrying') {
        assert.equal(imports.cause, '1 file resumes automatically.', where);
        assert.equal(services.attention, null, `${where}: retrying is not on Home until a day passes`);
        assert.equal(view.homeServiceHtml(services), '', where);
        const later = serviceStatus({ db: x.db, now: new Date(Date.parse(NOW) + 2 * DAY) });
        assert.equal(later.attention?.key, 'imports', where);
        assert.equal(text(view.homeServiceHtml(later)), 'Imports: 1 file resumes automatically.', where);
      } else {
        assert.equal(imports.cause, null, where);
        assert.equal(imports.lastSuccessAt, new Date(NOW).toISOString(), where);
        assert.equal(services.attention, null, where);
        assert.equal(view.homeServiceHtml(services), '', where);
      }

      // (d) Files: plain label, plain cause and exactly one control of the expected kind.
      const html = harness(state, { engineOn: row.engineOn ?? false }).screens.addFiles('add');
      const fileRow = rowOf(html, id);
      if (isUnresolved(row)) {
        assert.ok(fileRow, `${where}: shown on Files`);
        assert.equal(labelOf(fileRow), row.label, where);
        assert.equal(causeOf(fileRow), row.cause, where);
        assert.deepEqual(controlsOf(fileRow), [row.control], where);
        if (row.control === 'retry') assert.match(fileRow, new RegExp(`data-retry="${id}"`), where);
        if (row.control === 'replace') assert.match(fileRow, new RegExp(`<button[^>]*data-replace="${id}"`), where);
        assert.doesNotMatch(text(fileRow), /needs_mapping|needs_extraction|too_large|retry:|store_locked|limit_exceeded|empty_file|unsupported_format|pdf_unreadable/, `${where}: no codes on Files`);
      } else assert.equal(fileRow, null, where);

      // The upload result of a failed, unsupported or too large file shows the same cause as Files.
      if (made.result && ['failed', 'unsupported', 'too_large'].includes(made.result.status)) {
        const added = await uploadResultHtml(made.result);
        assert.ok(text(added).includes(row.cause), `${where}: upload result cause`);
        assert.ok(text(added).includes(row.label), `${where}: upload result label`);
      }

      // (e) Recovery through the control's server path.
      if (row.recover) {
        const end = await row.recover(x, made);
        const after = ingestState(x.db);
        const still = after.waiting.find((f) => f.id === id);
        if (end.leaves) {
          assert.equal(still, undefined, `${where}: leaves waiting after recovery`);
          const svc = serviceStatus({ db: x.db, now: new Date(NOW) });
          assert.equal(svc.imports.state, 'healthy', where);
          assert.equal(svc.imports.files, 0, where);
          assert.equal(svc.attention, null, where);
          assert.equal(rowOf(harness(after).screens.addFiles('add'), id), null, `${where}: gone from Files`);
        } else assert.ok(still, `${where}: the documented next state is still listed`);
      }
    } finally { x.close(); }
  });

  test(`${row.name}: an identical re-upload`, async () => {
    const x = await setup();
    try {
      const made = await row.make(x);
      const id = made.fileId;
      const before = fileRowOf(x.db, id);
      const files = x.db.prepare('SELECT count(*) n FROM files').get().n;
      const again = await P.ingestFile(x.db, made.file, x.opts);
      assert.equal(again.fileId, id, row.name);
      assert.equal(x.db.prepare('SELECT count(*) n FROM files').get().n, files, 'no second files row');
      if (row.dup === 'reroute') {
        assert.notEqual(again.status, 'duplicate', `${row.name}: never answered as a duplicate`);
        assert.equal(again.status, 'imported', row.name);
        assert.equal(fileRowOf(x.db, id).status, 'imported', row.name);
        assert.equal(ingestState(x.db).waiting.find((f) => f.id === id), undefined, row.name);
        assert.ok(!text(await uploadResultHtml(again)).includes('Already imported'), row.name);
      } else if (row.dup === 'duplicate') {
        assert.equal(again.status, 'duplicate', row.name);
        assert.equal(again.duplicateOf, id, row.name);
        assert.ok(text(await uploadResultHtml(again)).includes('Already imported'), row.name);
      } else {
        assert.equal(again.status, before.status, `${row.name}: answers its own stored status`);
        assert.equal(again.duplicateOf, id, row.name);
        assert.deepEqual(fileRowOf(x.db, id), before, `${row.name}: the stored row is unchanged`);
        assert.ok(ingestState(x.db).waiting.some((f) => f.id === id), row.name);
        assert.ok(!text(await uploadResultHtml(again)).includes('Already imported'), `${row.name}: not shown as already imported`);
      }
    } finally { x.close(); }
  });
}

test('a busy or locked store is a transient failure: retried once, then left for the owner', async () => {
  const x = await setup();
  try {
    // A store fault at the storage boundary: SQLite reports a lock with the message 'database is
    // locked'. A TEMP trigger on this connection raises it on every transaction insert; nothing in
    // src/ is replaced.
    const fault = () => x.db.exec("CREATE TEMP TRIGGER IF NOT EXISTS h1_store_fault BEFORE INSERT ON main.transactions BEGIN SELECT RAISE(ABORT, 'database is locked'); END;");
    const heal = () => x.db.exec('DROP TRIGGER IF EXISTS temp.h1_store_fault');
    fault();
    const r = await P.ingestFile(x.db, csvOf('locked'), x.opts);
    assert.equal(r.status, 'failed');
    assert.equal(r.reasonCode, 'retry:store_locked');
    assert.equal(fileRowOf(x.db, r.fileId).note, 'retry:store_locked');

    // The one automatic retry fails the same way: the file stays failed with the bare class.
    const first = await P.resumeImports(x.db, bg(x));
    assert.deepEqual(first.resumed, [{ fileId: r.fileId, status: 'failed' }]);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['failed', 'store_locked']);
    const svc = serviceStatus({ db: x.db, now: new Date(NOW) });
    assert.equal(svc.imports.state, 'needs_you');
    const row = rowOf(harness(ingestState(x.db)).screens.addFiles('add'), r.fileId);
    assert.equal(causeOf(row), CAUSE.failed);
    heal();

    // No further automatic retry, while a pending file in the same pass is resumed (liveness).
    const pendingId = await leavePending(x, csvOf('pending beside locked', '3.25'));
    const second = await P.resumeImports(x.db, bg(x));
    assert.deepEqual(second.resumed, [{ fileId: pendingId, status: 'imported' }]);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['failed', 'store_locked']);

    // The owner's Retry still imports it.
    assert.equal((await P.retryFile(x.db, r.fileId, x.opts)).status, 'imported');
  } finally { x.close(); }
});

test('resumeImports skips a file this household is already routing, then resumes it', async () => {
  const x = await setup();
  try {
    const id = await leavePending(x, csvOf('in flight'));
    x.household.inFlight.add(id);
    try {
      assert.deepEqual((await P.resumeImports(x.db, bg(x))).resumed, []);
      assert.equal(fileRowOf(x.db, id).status, 'pending');
    } finally { x.household.inFlight.delete(id); }
    assert.deepEqual((await P.resumeImports(x.db, bg(x))).resumed, [{ fileId: id, status: 'imported' }]);
  } finally { x.close(); }
});

test('a manual Retry of a failed file is accepted; an imported file is still refused', async () => {
  const x = await setup();
  try {
    const failed = await P.ingestFile(x.db, csvOf('manual'), { ...x.opts, parser: throwing(plainError()) });
    assert.equal((await P.retryFile(x.db, failed.fileId, x.opts)).status, 'imported');
    await assert.rejects(P.retryFile(x.db, failed.fileId, x.opts), (e) => e.status === 409 && e.code === 'not_waiting');
  } finally { x.close(); }
});

test('the Imports service counts every unresolved file once and needs the owner over retrying', async () => {
  const x = await setup();
  try {
    const pendingId = await leavePending(x, csvOf('count pending'));
    await P.ingestFile(x.db, csvOf('count transient', '4.50'), { ...x.opts, parser: throwing(lockedError()) });
    let s = serviceStatus({ db: x.db, now: new Date(NOW) }).imports;
    assert.deepEqual([s.state, s.files, s.cause], ['retrying', 2, '2 files resume automatically.']);
    await P.ingestFile(x.db, textFile('count-empty-synthetic.csv', '', 'text/csv'), x.opts);
    await P.ingestFile(x.db, { name: 'count-blob-synthetic.bin', bytes: new Uint8Array([9, 0, 9, 0, 255]) }, x.opts);
    s = serviceStatus({ db: x.db, now: new Date(NOW) }).imports;
    assert.equal(s.state, 'needs_you');
    assert.equal(s.files, 4);
    assert.match(s.cause, /^\d+ files need you on Files\.$/);
    // A removed file is not counted.
    removeFile({ db: x.db, now: NOW, actorId: 'actor-synthetic' }, pendingId);
    assert.equal(serviceStatus({ db: x.db, now: new Date(NOW) }).imports.files, 3);
  } finally { x.close(); }
});

test('Replace uploads the new file and removes the replaced one only when the new file was read', async () => {
  const OLD = 'f-old-synthetic';
  for (const [returned, removes] of [['imported', true], ['failed', false], ['unsupported', false], ['too_large', false]]) {
    const waiting = [{ id: OLD, name: 'old-synthetic.bin', status: 'unsupported', reasonCode: null, sourceKind: null, parser: null, uploadedAt: NOW,
      counts: { rows: {}, warnings: 1, warningCodes: { unsupported_format: 1 } } }];
    const result = { fileId: 'f-new-synthetic', name: 'new-synthetic.csv', status: returned, counts: { rows: returned === 'imported' ? { transaction: 1 } : {} } };
    const { screens, calls } = harness({ ...EMPTY, waiting }, { uploadResult: { files: [result], pending: 0 } });
    const html = screens.addFiles('add');
    const row = rowOf(html, OLD);
    const button = tagsOf(row).find((t) => /^<button/.test(t) && t.includes(`data-replace="${OLD}"`));
    assert.ok(button, 'a replace button carries the replaced file id');
    const inputTag = tagsOf(row).find((t) => /^<input/.test(t) && /type="file"/.test(t)) ?? tagsOf(html).find((t) => /^<input/.test(t) && /type="file"/.test(t));
    let opened = 0;
    const input = { ...element(inputTag), files: [{ name: 'new-synthetic.csv' }], value: 'x', click() { opened += 1; } };
    const el = { ...element(button), parentElement: { querySelector: (sel) => (/input/.test(sel) ? input : null) } };
    assert.equal(screens.handleClick({ target: { closest: () => el }, preventDefault() {} }), true);
    assert.equal(opened, 1, 'the click opens the file chooser');
    assert.equal(screens.handleChange({ type: 'change', target: input }), true);
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(calls.filter((c) => c[0] === 'upload'), [['upload', 1]], returned);
    assert.equal(calls.some((c) => c[0] === 'removeFile' && c[1] === OLD), removes, `${returned}: remove the replaced file`);
    assert.ok(!calls.some((c) => c[0] === 'removeFile' && c[1] !== OLD), 'only the replaced file is removed');
  }
});

// Review fix 3: a replacement upload whose returned file is the replaced file itself (identical
// bytes answer the same file id) keeps it. Drives the Replace control as the test above does and
// returns the calls the screen made.
async function replaceWith(waiting, returned) {
  const { screens, calls } = harness({ ...EMPTY, waiting: [waiting] }, { uploadResult: { files: returned, pending: 0 } });
  const row = rowOf(screens.addFiles('add'), waiting.id);
  const button = tagsOf(row).find((t) => /^<button/.test(t) && t.includes(`data-replace="${waiting.id}"`));
  assert.ok(button, 'a replace button carries the replaced file id');
  const inputTag = tagsOf(row).find((t) => /^<input/.test(t) && /type="file"/.test(t));
  assert.ok(inputTag && inputTag.includes(`data-replace-for="${waiting.id}"`), 'the replace input names the replaced file');
  const input = { ...element(inputTag), files: returned.map((f) => ({ name: f.name })), value: 'x', click() {} };
  const el = { ...element(button), parentElement: { querySelector: (sel) => (/input/.test(sel) ? input : null) } };
  assert.equal(screens.handleClick({ target: { closest: () => el }, preventDefault() {} }), true);
  assert.equal(screens.handleChange({ type: 'change', target: input }), true);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(calls.filter((c) => c[0] === 'upload'), [['upload', returned.length]]);
  return calls.filter((c) => c[0] === 'removeFile');
}

test('Replace with the identical bytes keeps the file; a different file that was read still removes it once', async () => {
  const OLD = 'f-scan-old-synthetic';
  // A PDF Fathom could not read: its control is Replace, and an identical re-upload answers its own
  // stored status (not an unread one) under the same file id.
  const waiting = { id: OLD, name: 'scan-synthetic.pdf', status: 'needs_extraction', reasonCode: 'pdf_unreadable', sourceKind: null, parser: null, uploadedAt: NOW,
    counts: { rows: {}, warnings: 0, warningCodes: {} } };
  const same = { fileId: OLD, name: 'scan-synthetic.pdf', status: 'needs_extraction', reasonCode: 'pdf_unreadable', duplicateOf: OLD, counts: { rows: {} } };
  const fresh = { fileId: 'f-scan-new-synthetic', name: 'export-synthetic.csv', status: 'imported', counts: { rows: { transaction: 2 } } };

  assert.deepEqual(await replaceWith(waiting, [same]), [], 'identical bytes: the replaced file is kept');
  assert.deepEqual(await replaceWith(waiting, [same, fresh]), [], 'the identical file among others: still kept');
  // Liveness: a different file that was read replaces it.
  assert.deepEqual(await replaceWith(waiting, [fresh]), [['removeFile', OLD]]);
});

// Review fix 2: a transient engine failure on a model import. The household's fake-mode runtime
// engine is wrapped at its call: each listed error is thrown by one call, after the request was
// dispatched (its beforeDispatch reservation ran), and once the list is spent calls go to the real
// fake engine. `calls` counts every call.
function failEngine(x, errors) {
  const engine = x.household.engine;
  const real = engine.call;
  const calls = [];
  engine.call = async (req) => {
    calls.push(req.purpose);
    const error = errors.shift();
    if (!error) return real(req);
    await req.beforeDispatch?.({});
    throw error;
  };
  return { calls, restore() { engine.call = real; } };
}
// A transient failure whose call reported its usage: the file's allowance is charged what was used.
const USED = Object.freeze({ costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } });
const timeoutError = (accounting = USED) => Object.assign(new Error('synthetic engine timeout naming Synthetic Private Payee'), { name: 'TimeoutError', ...(accounting ? { accounting } : {}) });
const connectionTimeout = () => Object.assign(new Error('synthetic connection timeout naming Synthetic Private Payee'), { code: 'ETIMEDOUT', accounting: USED });

test('a transient model failure waits for the engine, shows that Fathom tries again, and is retried once automatically', async () => {
  const x = await setup();
  const eng = failEngine(x, [timeoutError()]);
  try {
    const csv = MODEL_CSV('model transient');
    const r = await P.ingestFile(x.db, modelFile(csv), x.opts);
    assert.equal(r.status, 'waiting_for_engine');
    assert.equal(r.reasonCode, 'model_transient');
    const stored = fileRowOf(x.db, r.fileId);
    assert.deepEqual([stored.status, stored.note], ['waiting_for_engine', 'model_transient']);
    assert.ok(!String(stored.note).includes('Synthetic Private Payee'));
    assert.equal(eng.calls.length, 1);

    // Reload, Home and Files.
    const state = ingestState(x.db);
    const w = state.waiting.find((f) => f.id === r.fileId);
    assert.equal(w?.status, 'waiting_for_engine');
    assert.equal(w?.reasonCode, 'model_transient');
    const svc = serviceStatus({ db: x.db, now: new Date(NOW) });
    assert.deepEqual([svc.imports.state, svc.imports.files, svc.imports.cause], ['retrying', 1, '1 file resumes automatically.']);
    assert.equal(svc.attention, null, 'retrying is not on Home until a day passes');
    for (const engineOn of [true, false]) {
      const row = rowOf(harness(state, { engineOn }).screens.addFiles('add'), r.fileId);
      assert.ok(row, 'shown on Files');
      assert.match(causeOf(row), /Fathom tries once more automatically/, `engineOn ${engineOn}`);
      assert.doesNotMatch(text(row), /model_transient|TimeoutError/, 'no codes on Files');
    }

    // The one automatic retry interprets the saved file and stages it for review.
    const first = await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) });
    assert.deepEqual(first.resumed, [{ fileId: r.fileId, status: 'needs_confirmation' }]);
    assert.equal(fileRowOf(x.db, r.fileId).status, 'needs_confirmation');
    assert.equal(eng.calls.length, 2);
    // Nothing is left for a further pass.
    assert.deepEqual((await P.resumeImports(x.db, bg(x))).resumed, []);
    assert.equal(eng.calls.length, 2);
  } finally { eng.restore(); x.close(); }
});

test('a transient model failure that fails again on its automatic retry asks the owner and is not retried again', async () => {
  const x = await setup();
  const eng = failEngine(x, [timeoutError(), connectionTimeout()]);
  try {
    const csv = MODEL_CSV('model transient twice');
    const r = await P.ingestFile(x.db, modelFile(csv), x.opts);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['waiting_for_engine', 'model_transient']);

    const first = await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) });
    assert.deepEqual(first.resumed, [{ fileId: r.fileId, status: 'needs_clarification' }]);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['needs_clarification', 'model_failed']);
    assert.equal(eng.calls.length, 2);
    const svc = serviceStatus({ db: x.db, now: new Date(NOW) });
    assert.equal(svc.imports.state, 'needs_you');
    assert.equal(svc.imports.cause, '1 file needs you on Files.');

    // No further automatic retry, even with a working engine response on offer.
    const second = await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) });
    assert.deepEqual(second.resumed, []);
    assert.equal(eng.calls.length, 2);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['needs_clarification', 'model_failed']);
  } finally { eng.restore(); x.close(); }
});

// The pinned budget rule (test/ingest/model-budget.test.mjs, unknown failed call): a failure with no
// usage keeps its conservative reservation, retry or not. The one automatic retry stays inside that
// budget: when the reservation leaves no room it ends at the budget state without dispatching, and is
// not retried again.
test('a transient model failure with unknown usage gets its automatic retry only inside the file budget', async () => {
  const x = await setup();
  const eng = failEngine(x, [timeoutError(null)]);
  try {
    const csv = MODEL_CSV('model transient unknown usage');
    const r = await P.ingestFile(x.db, modelFile(csv), x.opts);
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['waiting_for_engine', 'model_transient']);
    const first = await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) });
    assert.deepEqual(first.resumed, [{ fileId: r.fileId, status: 'budget_exhausted' }]);
    assert.equal(eng.calls.length, 1, 'a retry that does not fit never dispatches');
    assert.deepEqual((await P.resumeImports(x.db, bg(x))).resumed, []);
    assert.equal(serviceStatus({ db: x.db, now: new Date(NOW) }).imports.state, 'needs_you');
  } finally { eng.restore(); x.close(); }
});

test('a non-transient model failure asks the owner on the first attempt and is never retried automatically', async () => {
  const x = await setup();
  // An authentication refusal from the model port is not transient.
  const eng = failEngine(x, [Object.assign(new Error('synthetic auth refusal'), { name: 'ModelCallError', code: 'authentication', accounting: USED })]);
  try {
    const csv = MODEL_CSV('model refused');
    const r = await P.ingestFile(x.db, modelFile(csv), x.opts);
    assert.equal(r.status, 'needs_clarification');
    assert.equal(r.reasonCode, 'model_failed');
    assert.deepEqual([fileRowOf(x.db, r.fileId).status, fileRowOf(x.db, r.fileId).note], ['needs_clarification', 'model_failed']);
    assert.equal(eng.calls.length, 1);
    assert.equal(serviceStatus({ db: x.db, now: new Date(NOW) }).imports.state, 'needs_you');
    assert.deepEqual((await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) })).resumed, []);
    assert.equal(eng.calls.length, 1);
  } finally { eng.restore(); x.close(); }
});

// Review round 2: the model port reports a 429 as rate_limit and a 5xx or lost connection as
// unavailable (src/models/port.mjs); both are transient and wait for the one automatic retry.
test('a rate limit or an unavailable provider is a transient model failure', async () => {
  for (const providerCode of ['rate_limit', 'unavailable']) {
    const x = await setup();
    const eng = failEngine(x, [Object.assign(new Error('synthetic provider refusal'), { name: 'ModelCallError', code: providerCode, accounting: USED })]);
    try {
      const csv = MODEL_CSV(`model ${providerCode}`);
      const r = await P.ingestFile(x.db, modelFile(csv), x.opts);
      assert.deepEqual([r.status, r.reasonCode], ['waiting_for_engine', 'model_transient'], providerCode);
      const first = await P.resumeImports(x.db, { ...bg(x), fake: await fakeFor(csv) });
      assert.deepEqual(first.resumed, [{ fileId: r.fileId, status: 'needs_confirmation' }], providerCode);
    } finally { eng.restore(); x.close(); }
  }
});

// Review round 2: an identical upload while the same failed file is being routed (the resume pass
// or a Retry) answers the file's stored status, never duplicate, and does not route it twice.
test('an identical upload during an in-flight retry answers the unresolved status, not duplicate', async () => {
  const x = await setup();
  try {
    const file = csvOf('in flight overlap');
    const failed = await P.ingestFile(x.db, file, { ...x.opts, parser: throwing(new Error('synthetic parse failure')) });
    assert.equal(failed.status, 'failed');
    x.opts.household.inFlight.add(failed.fileId);
    const again = await P.ingestFile(x.db, file, x.opts);
    assert.equal(again.status, 'failed');
    assert.equal(again.duplicateOf, failed.fileId);
    assert.equal(fileRowOf(x.db, failed.fileId).status, 'failed', 'not routed a second time');
    x.opts.household.inFlight.delete(failed.fileId);
    assert.equal((await P.ingestFile(x.db, file, x.opts)).status, 'imported', 'liveness: once free it is routed again');
  } finally { x.close(); }
});

// Review round 2: the Add files control of a file that needs readable text (or a smaller file)
// replaces it: a different file that was read removes the scan, identical bytes keep it.
test('Add files on a needs_source_text row replaces the scan once a different file was read', async () => {
  const OLD = 'f-scan-text-synthetic';
  const waiting = { id: OLD, name: 'scan-synthetic.pdf', status: 'needs_source_text', reasonCode: 'no_safe_source_text', sourceKind: null, parser: null, uploadedAt: NOW,
    counts: { rows: {}, warnings: 0, warningCodes: {} } };
  const run = async (returned) => {
    const { screens, calls } = harness({ ...EMPTY, waiting: [waiting] }, { uploadResult: { files: returned, pending: 0 } });
    const row = rowOf(screens.addFiles('add'), OLD);
    const button = tagsOf(row).find((t) => /^<button/.test(t) && t.includes('data-upload-open="1"'));
    assert.ok(button, 'the row has its Add files control');
    const inputTag = tagsOf(row).find((t) => /^<input/.test(t) && /type="file"/.test(t));
    assert.ok(inputTag && inputTag.includes(`data-replace-for="${OLD}"`), 'its input names the file it replaces');
    const input = { ...element(inputTag), files: returned.map((f) => ({ name: f.name })), value: 'x', click() {} };
    const el = { ...element(button), parentElement: { querySelector: (sel) => (/input/.test(sel) ? input : null) } };
    assert.equal(screens.handleClick({ target: { closest: () => el }, preventDefault() {} }), true);
    assert.equal(screens.handleChange({ type: 'change', target: input }), true);
    for (let i = 0; i < 5; i++) await settle();
    return calls.filter((c) => c[0] === 'removeFile');
  };
  const fresh = { fileId: 'f-text-export-synthetic', name: 'statement-synthetic.txt', status: 'imported', counts: { rows: { balance: 1 } } };
  const same = { fileId: OLD, name: 'scan-synthetic.pdf', status: 'needs_source_text', duplicateOf: OLD, counts: { rows: {} } };
  assert.deepEqual(await run([fresh]), [['removeFile', OLD]]);
  assert.deepEqual(await run([same]), []);
});

test('persistImport records warning rows per code, at most five, and warningText names them in plain words', async () => {
  const x = await setup();
  try {
    // The header is row 1, so the first data row is row 2: the seven unreadable rows are 3 to 9 and
    // the row without an account number is row 10.
    const rows = [{ date: '2032-03-01', amount: '5.00', description: 'Synthetic readable row', number: '5550006161' }];
    for (let i = 0; i < 7; i++) rows.push({ date: 'not a date', amount: '1.00', description: `Synthetic unreadable row ${i}`, number: '5550006161' });
    rows.push({ date: '2032-03-02', amount: '6.00', description: 'Synthetic unmasked row', number: '' });
    const r = await P.ingestFile(x.db, aggregatorFile('warnings-synthetic.csv', rows), x.opts);
    assert.equal(r.status, 'imported');
    const counts = JSON.parse(fileRowOf(x.db, r.fileId).counts);
    assert.deepEqual(counts.warningCodes, { invalid_transaction: 7, missing_account_mask: 1 });
    assert.deepEqual(counts.warningRows.invalid_transaction, [3, 4, 5, 6, 7]);
    assert.deepEqual(counts.warningRows.missing_account_mask, [10]);
    assert.deepEqual(counts.warningMore, { invalid_transaction: 2 }, 'warningMore omits a code with nothing more');
    for (const code of Object.keys(counts.warningRows)) assert.ok(code in counts.warningCodes, code);
    assert.deepEqual(r.counts.warningRows, counts.warningRows, 'the result carries the same counts');

    const lines = toLines(Web.warningText(counts));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('Rows 3, 4, 5, 6'), lines[0]);
    assert.ok(lines[0].includes('7'), lines[0]);
    assert.ok(lines[0].includes('had no readable date or amount and were skipped'), lines[0]);
    assert.ok(lines[0].includes(', and 2 more'), lines[0]);
    assert.ok(lines[0].endsWith('.'), lines[0]);
    assert.equal(lines[1], 'Row 10 has no account number.');

    // The upload result row keeps its count and adds the plain lines.
    const added = await uploadResultHtml(r);
    assert.match(added, /data-warning/);
    assert.ok(text(added).includes('8 warnings'), 'countsText keeps the count');
    assert.ok(text(added).includes('Row 10 has no account number.'));

    // A code without rows adds nothing to warningRows.
    const empty = await P.ingestFile(x.db, textFile('warn-empty-synthetic.csv', '', 'text/csv'), x.opts);
    const emptyCounts = JSON.parse(fileRowOf(x.db, empty.fileId).counts);
    assert.equal(emptyCounts.warningCodes.empty_file, 1);
    assert.equal(emptyCounts.warningRows?.empty_file, undefined);
    assert.equal(emptyCounts.warningMore?.empty_file, undefined);
  } finally { x.close(); }
});

// warningText may return an array of sentences or one string of sentences; both read as lines.
const toLines = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean));

test('warningText: one plain sentence per code, rows named, file-level codes in words', () => {
  const two = (code, a = 2, b = 5) => toLines(Web.warningText({ warnings: 2, warningCodes: { [code]: 2 }, warningRows: { [code]: [a, b] } }));
  assert.deepEqual(two('invalid_transaction', 4, 7), ['Rows 4 and 7 had no readable date or amount and were skipped.']);
  assert.deepEqual(two('missing_account_mask'), ['Rows 2 and 5 have no account number.']);
  assert.deepEqual(two('invalid_balance'), ['Rows 2 and 5 have a balance Fathom could not read.']);
  assert.deepEqual(two('invalid_position'), ['Rows 2 and 5 have a holding Fathom could not read.']);
  assert.deepEqual(two('truncated_position'), ['Rows 2 and 5 were cut off.']);
  assert.deepEqual(two('pending_activity'), ['Rows 2 and 5 are pending activity and were skipped.']);
  assert.deepEqual(two('invalid_cost_basis'), ['Rows 2 and 5 have a cost basis Fathom could not read.']);
  assert.deepEqual(two('synthetic_unknown_code'), ['Rows 2 and 5 could not be read.']);
  assert.deepEqual(toLines(Web.warningText({ warnings: 1, warningCodes: { missing_account_mask: 1 }, warningRows: { missing_account_mask: [3] } })), ['Row 3 has no account number.']);
  assert.deepEqual(toLines(Web.warningText({ warnings: 1, warningCodes: { synthetic_unknown_code: 1 }, warningRows: { synthetic_unknown_code: [6] } })), ['Row 6 could not be read.']);
  const tail = toLines(Web.warningText({ warnings: 9, warningCodes: { invalid_balance: 9 }, warningRows: { invalid_balance: [2, 3, 4, 5, 6] }, warningMore: { invalid_balance: 4 } }));
  assert.equal(tail.length, 1);
  assert.ok(tail[0].includes(', and 4 more'), tail[0]);
  assert.ok(tail[0].includes('have a balance Fathom could not read'), tail[0]);

  const fileLevel = (code) => toLines(Web.warningText({ warnings: 1, warningCodes: { [code]: 1 } }));
  assert.deepEqual(fileLevel('missing_headers'), ['The file has no header row Fathom recognizes.']);
  assert.deepEqual(fileLevel('missing_as_of'), ['The file has no as-of date.']);
  assert.deepEqual(fileLevel('malformed_csv'), ['The file is not a well-formed CSV.']);
  for (const code of ['limit_exceeded', 'empty_file', 'unsupported_format']) {
    const lines = fileLevel(code);
    assert.equal(lines.length, 1, code);
    assert.match(lines[0], /^The file .+\.$/, code);
  }
  const all = toLines(Web.warningText({ warnings: 3, warningCodes: { invalid_transaction: 2, missing_headers: 1 }, warningRows: { invalid_transaction: [4, 7] } }));
  assert.equal(all.length, 2);
  for (const line of all) assert.doesNotMatch(line, /_/, 'no raw codes');
  assert.deepEqual(toLines(Web.warningText({ warnings: 0, warningCodes: {} })), []);
  assert.deepEqual(toLines(Web.warningText(undefined)), []);
});

test('a waiting row with warnings shows the plain lines under its cause', async () => {
  const x = await setup();
  try {
    const rows = [{ date: '2032-03-01', amount: '5.00', description: 'Synthetic kept row', number: '5550005151' }, { date: 'bad', amount: '1.00', description: 'Synthetic bad row', number: '5550005151' }];
    const r = await P.ingestFile(x.db, aggregatorFile('waiting-warnings-synthetic.csv', rows), x.opts);
    x.db.prepare("UPDATE files SET status = 'needs_mapping', note = NULL WHERE id = ?").run(r.fileId);
    const row = rowOf(harness(ingestState(x.db)).screens.addFiles('add'), r.fileId);
    assert.match(row, /data-warning/);
    assert.ok(text(row).includes('Row 3 had no readable date or amount and was skipped.') || text(row).includes('Row 3 had no readable date or amount and were skipped.'), text(row));
  } finally { x.close(); }
});

test('a low-confidence fact asks in plain words and never shows the raw key', async () => {
  const x = await setup();
  try {
    const cases = [
      // Main's plainQuestion (src/ingest/confirm.mjs) owns the wording: the value, then the fact in plain words.
      ['household.dependents', 2, /says 2 for "[^"]*dependents[^"]*"\. Is that right\?$/i],
      ['income.selfEmploymentNet', 1200, /says 1200 for "[^"]*self employment net[^"]*"\. Is that right\?$/i],
    ];
    for (const [key, value, expected] of cases) {
      const r = recordFact(x.db, { key, value, confidence: 0.5, sourceId: 'ing:synthetic:all', fileId: null, parser: 'synthetic', locator: null, asOf: '2032-03-01', now: NOW });
      assert.equal(r.queued, true, key);
      const item = x.db.prepare("SELECT question, subject, context FROM confirm_items WHERE kind = 'fact_check' AND subject = ?").get(`ing:synthetic:all|${key}|${JSON.stringify(value)}`);
      assert.ok(item, key);
      assert.ok(!item.question.includes(key), `${key}: no raw dotted key in "${item.question}"`);
      assert.match(item.question, /^The import says /, key);
      assert.match(item.question, expected, key);
      const context = JSON.parse(item.context);
      assert.equal(context.key, key, 'the context keeps the key');
      assert.deepEqual(context.value, value, 'the context keeps the value');
    }
    const dependents = x.db.prepare("SELECT question FROM confirm_items WHERE kind = 'fact_check' AND subject LIKE '%household.dependents%'").get().question;
    assert.match(dependents, /dependents/);
  } finally { x.close(); }
});

test('healthLine leaves failed files to the Imports service line', () => {
  const ingest = { pending: 0, items: [], waiting: [], files: [{ id: 'f-a', name: 'a-synthetic.csv', status: 'failed' }, { id: 'f-b', name: 'b-synthetic.csv', status: 'failed' }] };
  const h = healthLine({ pace: null, ingest, accounts: [], metaDataThrough: null });
  assert.equal('failed' in h, false, 'no failed field');
  assert.ok(!h.owner.some((o) => o.key === 'files' || o.go === 'add'), 'no files owner item');
  assert.ok(!h.parts.some((p) => /failed/.test(p)), 'no file failed row');
  assert.equal(h.needs, 0);
  assert.equal(h.needsLabel, null);
  // Liveness: questions still make an owner item.
  const asked = healthLine({ pace: null, ingest: { ...ingest, pending: 2 }, accounts: [], metaDataThrough: null });
  assert.deepEqual(asked.owner, [{ key: 'confirm', text: '2 questions to confirm', go: 'confirm' }]);
});
