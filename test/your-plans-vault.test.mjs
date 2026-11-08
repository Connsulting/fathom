// AC14 (merge-gate blocker 6): Your plans reads uploads through the ingest vault's authenticated
// decrypt, and PDFs through ingest's text-layer extraction.
// 1. A text upload stored by the ingest path (encrypted at rest) builds entries through
//    buildYourPlans and POST /api/your-plans/build; the engine sees the plaintext, never ciphertext.
// 2. A tampered stored file fails authentication: skipped with a warning naming it, never extracted.
// 3. A two-page text-layer PDF is sent as its extracted text; rows are checked against that text
//    and its page boundaries, and mismatches are dropped and counted.
// 4. An image-only PDF is skipped with the image-only warning before any model call.
// Builds receive the household context (its vault and root), the way ingest's pipeline takes
// opts.household. Every document is synthetic; every data dir lives under the OS temp dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildYourPlans } from '../src/packs/your-plans.mjs';
import { loadPacks } from '../src/packs/index.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { setSetting } from '../src/store/db.mjs';
import { storeFile } from '../src/ingest/vault.mjs';
import { ingestFiles } from '../src/ingest/pipeline.mjs';
import { multiPagePdf, imagePdf, textPdf } from './helpers/pdf.mjs';
import { realStore, offEngine } from './helpers/ingest.mjs';
import { SERVER_TIMEOUT, withServer, request, postJson, tempInstance } from './helpers/server.mjs';

const T2 = { timeout: SERVER_TIMEOUT * 2 };
const CLOCK = '2026-11-05';
const PLAN_NAME = 'synthetic-benefits-guide.md';
const PLAN_TEXT = [
  '# Health plan tiers',
  '',
  'The synthetic employer plan offers a standard tier and a high deductible tier. The owner compares them during open enrollment.',
  '',
  '# Dependent care account',
  '',
  'The synthetic benefits guide describes a dependent care account the owner can elect during open enrollment.',
  '',
].join('\n');
const PLAINTEXT_MARK = 'standard tier';
const DENTAL = 'The synthetic dental plan covers routine cleanings and exams.';
const VISION = 'The synthetic vision plan covers frames and lenses.';
const ABSENT = 'The synthetic hearing plan covers hearing aids.';
const DROP_WARNING = /did not match the document/;
const row = (title, body, excerpt, page = 1) => ({ title, body, excerpt, page });

const engineFor = async (db, household) => await createRuntimeEngine({ db, config: loadConfig({ FATHOM_DATA: household.config.dataDir, FATHOM_ENGINE: 'fake' }) });

// The runtime with every extract() request recorded; each call takes the next rows list as its
// fake response when one is scripted, otherwise it passes through unchanged.
function recording(runtime, rowsPerCall = []) {
  const queue = [...rowsPerCall];
  const requests = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'extract') {
        return async req => {
          requests.push(req);
          const rows = queue.shift();
          return target.extract(rows ? { ...req, fake: [{ text: JSON.stringify({ rows }) }] } : req);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, requests };
}

// What an extract request carries as document content, as one string, for "never ciphertext".
function sentContent(req) {
  const doc = req.document || {};
  if (typeof doc.text === 'string') return doc.text;
  if (doc.data) return Buffer.from(doc.data).toString('latin1');
  return '';
}

const spend = async db => (await db.prepare('SELECT id, purpose, cost_usd FROM spend_ledger ORDER BY id').all()).map(r => ({ ...r }));

// A store that went through main's real ingest upload path: real mode, the household vault (data
// key wrapped under the platform key), the file encrypted by the vault and recorded by ingestFiles
// (engine off, so it waits for extraction).
async function uploadedStore(t, files) {
  const s = await realStore();
  t.after(() => s.close());
  await setSetting(s.db, 'clock', CLOCK);
  const { results } = await ingestFiles(s.db, files, s.opts(await offEngine()));
  return { ...s, results };
}

const enc = text => new Uint8Array(Buffer.from(text, 'utf8'));
const storedRow = async (db, id) => await db.prepare('SELECT stored_path, name FROM files WHERE id = ?').get(id);

// ---------------------------------------------------------------- 1. encrypted text uploads

test('AC14.1: a text upload stored encrypted by ingest builds Your plans from its plaintext', async t => {
  const s = await uploadedStore(t, [{ name: PLAN_NAME, bytes: enc(PLAN_TEXT), mime: 'text/markdown' }]);
  const fileId = s.results[0].fileId;
  const stored = await storedRow(s.db, fileId);
  assert.equal(stored.stored_path, `files/${fileId}.bin`, 'ingest stored the upload in the vault');
  const onDisk = readFileSync(join(s.root, stored.stored_path));
  assert.ok(!onDisk.includes(Buffer.from(PLAINTEXT_MARK)), 'the stored file is ciphertext');
  assert.ok(!onDisk.toString('latin1').includes('Health plan tiers'));

  const { engine, requests } = recording(await engineFor(s.db, s.household));
  const result = await buildYourPlans({ db: s.db, engine, household: s.household, fileIds: [fileId], clock: CLOCK });
  assert.equal(requests.length, 1, 'one extract request for the one source');
  assert.equal(requests[0].document.type, 'text');
  assert.equal(requests[0].document.text, PLAN_TEXT, 'the engine receives the decrypted plaintext');
  assert.ok(!/FTHM\d/.test(sentContent(requests[0])), 'no vault blob reaches the engine');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.written, true);
  assert.equal(result.entries, 2);
  assert.deepEqual(result.sources, [{ fileId, name: PLAN_NAME }]);
  const [pack] = loadPacks([result.dir]);
  assert.deepEqual(pack.entries.map(e => e.title).sort(), ['Dependent care account', 'Health plan tiers']);
  assert.ok(pack.entries.some(e => e.body.includes(PLAINTEXT_MARK)));
});

test('AC14.1: POST /api/files then POST /api/your-plans/build builds entries from the encrypted upload', T2, async () => withServer({ env: { FATHOM_ENGINE: 'fake' } }, async s => {
  const fd = new FormData();
  fd.append('files', new Blob([PLAN_TEXT], { type: 'text/markdown' }), PLAN_NAME);
  const res = await fetch(`${s.baseUrl}/api/files`, { method: 'POST', body: fd });
  const up = await res.json();
  assert.equal(res.status, 200, JSON.stringify(up).slice(0, 300));
  const fileId = up.files[0].fileId;
  assert.equal(typeof fileId, 'string');
  const onDisk = readFileSync(join(s.root, 'files', `${fileId}.bin`));
  assert.ok(!onDisk.includes(Buffer.from(PLAINTEXT_MARK)), 'the upload is ciphertext on disk');

  const built = await postJson(s.baseUrl, '/api/your-plans/build', { fileIds: [fileId] });
  assert.equal(built.status, 200, built.text.slice(0, 300));
  const r = built.json.result;
  assert.equal(r.written, true, JSON.stringify(r.warnings));
  assert.ok(r.sources.some(x => x.fileId === fileId && x.name === PLAN_NAME));
  assert.ok(r.warnings.every(w => !w.includes(PLAN_NAME)), JSON.stringify(r.warnings));
  const pack = built.json.scenario.packs.find(p => p.id === 'your-plans');
  assert.ok(pack, 'the pack is live');
  const titles = pack.entryList.map(e => e.title);
  for (const title of ['Health plan tiers', 'Dependent care account']) assert.ok(titles.includes(title), `${title} in ${JSON.stringify(titles)}`);
  const health = pack.entryList.find(e => e.title === 'Health plan tiers');
  const entry = await request(s.baseUrl, { path: `/api/packs/your-plans/entries/${encodeURIComponent(health.id)}` });
  assert.equal(entry.status, 200);
  assert.ok(JSON.stringify(entry.json).includes(PLAINTEXT_MARK), 'the entry text is the decrypted plaintext');
}));

// ---------------------------------------------------------------- 2. tampered stored files

test('AC14.2: a tampered stored file fails authentication, is skipped with a warning naming it and never reaches the engine', async t => {
  const TAMPERED = 'synthetic-tampered-plan.md';
  const TAMPERED_TEXT = '# Wellness stipend\n\nThe synthetic tampered guide describes a wellness stipend.\n';
  const s = await uploadedStore(t, [
    { name: TAMPERED, bytes: enc(TAMPERED_TEXT), mime: 'text/markdown' },
    { name: PLAN_NAME, bytes: enc(PLAN_TEXT), mime: 'text/markdown' },
  ]);
  const [bad, good] = s.results.map(r => r.fileId);
  const path = join(s.root, (await storedRow(s.db, bad)).stored_path);
  const blob = readFileSync(path);
  blob[Math.floor(blob.length / 2)] ^= 0x01;
  writeFileSync(path, blob);

  const { engine, requests } = recording(await engineFor(s.db, s.household));
  const result = await buildYourPlans({ db: s.db, engine, household: s.household, fileIds: [bad, good], clock: CLOCK });
  assert.equal(requests.length, 1, 'only the authentic file is extracted');
  assert.equal(requests[0].document.text, PLAN_TEXT);
  for (const req of requests) assert.ok(!/FTHM\d/.test(sentContent(req)), 'no ciphertext reaches the engine');
  const named = result.warnings.filter(w => w.includes(TAMPERED));
  assert.equal(named.length, 1, `one warning names the tampered file: ${JSON.stringify(result.warnings)}`);
  assert.ok(!named[0].includes('wellness'), 'the warning carries no document text');
  assert.ok(!result.sources.some(x => x.fileId === bad), 'the tampered file is not a source');
  assert.equal(result.entries, 2);
  const titles = loadPacks([result.dir])[0].entries.map(e => e.title);
  assert.ok(!titles.includes('Wellness stipend'), 'nothing is extracted from the tampered file');
});

// ---------------------------------------------------------------- 3 and 4. PDFs

// A real household of a temp instance with a PDF stored through its vault and registered as a plan
// document.
async function pdfStore(t, { id, name, bytes }) {
  const inst = await tempInstance({ mode: 'real', init: async d => await setSetting(d, 'clock', CLOCK) });
  t.after(() => { inst.close(); rmSync(inst.dataDir, { recursive: true, force: true }); });
  const { db } = inst;
  const household = await inst.household();
  const storedPath = await storeFile({ vault: await household.vault(), id, bytes: Buffer.from(bytes), purpose: 'upload' });
  await db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES (?, ?, 'application/pdf', ?, NULL, 'other', '2026-11-01T09:00:00Z', ?, 'parsed', '')`).run(id, name, bytes.length, storedPath);
  await db.prepare("INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES ('plan', 2026, '{}', ?, 'synthetic', 'file')").run(id);
  return { db, household };
}

test('AC14.3: a two-page text-layer PDF is extracted as text and rows are checked against its text and page boundaries', async t => {
  const NAME = 'synthetic-plan.pdf';
  const pdf = multiPagePdf(2, n => (n === 1 ? DENTAL : VISION));
  const { db, household } = await pdfStore(t, { id: 'file-synthetic-pdf', name: NAME, bytes: pdf });
  const { engine, requests } = recording(await engineFor(db, household), [[
    row('Dental plan', DENTAL, DENTAL, 1),
    row('Vision plan', VISION, VISION, 2),
    row('Vision on the wrong page', VISION, VISION, 1),
    row('Hearing plan', ABSENT, ABSENT, 1),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });

  assert.equal(requests.length, 1);
  const doc = requests[0].document;
  assert.equal(doc.type, 'text', 'the PDF goes to the engine as its extracted text');
  assert.equal(doc.data, undefined, 'no PDF bytes are sent');
  assert.ok(doc.text.includes(DENTAL) && doc.text.includes(VISION), 'the text layer is what is sent');
  assert.ok(!doc.text.includes('%PDF') && !/FTHM\d/.test(doc.text), 'neither PDF bytes nor ciphertext are sent');

  assert.equal(result.written, true, JSON.stringify(result.warnings));
  assert.equal(result.entries, 2);
  assert.equal(result.dropped, 2, 'the wrong page and the absent excerpt are dropped and counted');
  assert.ok(result.warnings.some(w => DROP_WARNING.test(w) && w.includes(NAME)), JSON.stringify(result.warnings));
  assert.ok(result.warnings.every(w => !/text copy/i.test(w)), 'no blanket PDF warning');
  assert.ok(result.warnings.every(w => !w.includes('hearing') && !w.includes('dental plan covers')), 'warnings carry no document text');
  const [pack] = loadPacks([result.dir]);
  const cite = title => pack.entries.find(e => e.title === title)?.cites[0].label;
  assert.deepEqual(pack.entries.map(e => e.title).sort(), ['Dental plan', 'Vision plan']);
  assert.equal(cite('Dental plan'), `${NAME}, page 1`);
  assert.equal(cite('Vision plan'), `${NAME}, page 2`);
});

test('AC14.4: an image-only PDF is skipped with the image-only warning before any model call', async t => {
  const NAME = 'synthetic-scanned-plan.pdf';
  const { db, household } = await pdfStore(t, { id: 'file-synthetic-scan', name: NAME, bytes: imagePdf({ tag: 'synthetic scan' }) });
  const before = await spend(db);
  const { engine, requests } = recording(await engineFor(db, household), [[row('Dental plan', DENTAL, DENTAL, 1)]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(requests.length, 0, 'the engine received no extract call for the image-only PDF');
  assert.deepEqual(await spend(db), before, 'spend did not change');
  assert.equal(result.written, false);
  assert.equal(result.entries, 0);
  const named = result.warnings.filter(w => w.includes(NAME));
  assert.equal(named.length, 1, JSON.stringify(result.warnings));
  assert.match(named[0], /image/i, 'the warning says the PDF is image-only');
});

// ---------------------------------------------------------------- 5. generated page markers are not evidence

const PREMIUM_BODY = 'The premium is $1.';
// Asks the live answerer (the product's answer path, citation lines excluded from evidence) with
// every chat call answered by `text`; returns the amounts it could not ground.
async function unverifiedAfterBuild(db, household, text) {
  const packs = createLivePacks(db, { dataDir: household.root });
  packs.refresh();
  const runtime = await engineFor(db, household);
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') return async request => target.call({ ...request, fake: [{ text }] });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const reply = await createLiveAnswerer({ engine, packs, root: household.root, services: { ...household.services, engine: engine, config: { dataDir: household.root } } }).answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say' });
  assert.ok(reply.provenance.packIds.includes('your-plans'));
  return reply.provenance.grounding.unverified;
}

test('AC14.5: a generated Page N label never serves as a PDF excerpt or grounds a number', async t => {
  const NAME = 'synthetic-numberless-plan.pdf';
  const LINE = 'The synthetic plan lists a premium and a deductible.';
  const { db, household } = await pdfStore(t, { id: 'file-synthetic-numberless', name: NAME, bytes: textPdf([LINE]) });
  const { engine } = recording(await engineFor(db, household), [[
    row('Premium', PREMIUM_BODY, 'Page 1', 1),
    row('Plan summary', LINE, LINE, 1),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true, JSON.stringify(result.warnings));
  assert.equal(result.entries, 1, 'only the real excerpt is kept');
  assert.equal(result.dropped, 1, 'the marker excerpt is dropped and counted');
  const [pack] = loadPacks([result.dir]);
  assert.deepEqual(pack.entries.map(e => e.title), ['Plan summary']);
  assert.ok((await unverifiedAfterBuild(db, household, 'The premium is $1.')).includes('$1'), 'the marker digit grounds no amount');
});

test('AC14.5: a Page 2 marker excerpt, or one spanning a generated label, is dropped on a two-page PDF', async t => {
  const NAME = 'synthetic-two-page-plan.pdf';
  const ONE = 'The synthetic dental plan covers cleanings.';
  const TWO = 'The synthetic vision plan covers frames.';
  const { db, household } = await pdfStore(t, { id: 'file-synthetic-two-page', name: NAME, bytes: multiPagePdf(2, n => (n === 1 ? ONE : TWO)) });
  const { engine } = recording(await engineFor(db, household), [[
    row('Premium', 'The premium is $2.', 'Page 2', 2),
    row('Spanning', 'The plan spans two pages.', `${ONE} Page 2 ${TWO}`, 1),
    row('Dental plan', ONE, ONE, 1),
    row('Vision plan', TWO, TWO, 2),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true, JSON.stringify(result.warnings));
  assert.equal(result.dropped, 2, 'the marker row and the label-spanning row are dropped and counted');
  const [pack] = loadPacks([result.dir]);
  assert.deepEqual(pack.entries.map(e => e.title).sort(), ['Dental plan', 'Vision plan']);
  assert.ok((await unverifiedAfterBuild(db, household, 'The premium is $2.')).includes('$2'));
});

test('AC14.5: in a text upload a Page N marker line is not an excerpt or evidence, and real rows keep their page', async t => {
  const NAME = 'synthetic-paged-plan.md';
  const ONE = 'The synthetic dental plan covers cleanings.';
  const TWO = 'The synthetic vision plan covers frames.';
  const text = ['Page 1', ONE, 'Page 2', TWO, ''].join('\n');
  const s = await uploadedStore(t, [{ name: NAME, bytes: enc(text), mime: 'text/markdown' }]);
  const fileId = s.results[0].fileId;
  const { engine } = recording(await engineFor(s.db, s.household), [[
    row('Premium', 'The premium is $2.', 'Page 2', 2),
    row('Vision plan', TWO, TWO, 2),
  ]]);
  const result = await buildYourPlans({ db: s.db, engine, household: s.household, fileIds: [fileId], clock: CLOCK });
  assert.equal(result.written, true, JSON.stringify(result.warnings));
  assert.equal(result.dropped, 1, 'the marker-only excerpt is dropped and counted');
  const [pack] = loadPacks([result.dir]);
  assert.deepEqual(pack.entries.map(e => e.title), ['Vision plan']);
  assert.equal(pack.entries[0].cites[0].label, `${NAME}, page 2`);
  assert.ok((await unverifiedAfterBuild(s.db, s.household, 'The premium is $2.')).includes('$2'));
});
