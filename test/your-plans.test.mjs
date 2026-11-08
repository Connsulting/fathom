// AC5: the private "Your plans" pack. buildYourPlans extracts rows from the owner's plan and
// benefits documents through the engine (fake here), writes a valid pack under
// <household root>/packs/your-plans/, refuses any target inside the repository (D11, R8), writes nothing
// for zero rows, and bumps packs.generation so a running server picks it up (R12). Also the API
// action, the npm script against a running server, and the Dockerfile copying packs and scripts
// (R1). Every data dir lives under the OS temp dir; plan text is synthetic. Plan files are stored
// through the household vault of a temp instance (createInstance layout), as ingest stores uploads.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildYourPlans, fakeExtractRows } from '../src/packs/your-plans.mjs';
import { loadPacks, activePacks } from '../src/packs/index.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDb, getSetting, setSetting } from '../src/store/db.mjs';
import { openPlatform } from '../src/platform/db.mjs';
import { yourPlansDir, createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { storeFile } from '../src/ingest/vault.mjs';
import {
  ROOT, SERVER_TIMEOUT, withServer, request, postJson, getScenario, runCommand, tempInstance, householdContext, instanceSecretsOf,
} from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const T2 = { timeout: SERVER_TIMEOUT * 2 };
const CLOCK = '2026-11-05';
const FILE_ID = 'file-synthetic-plan';
const FILE_NAME = 'synthetic-benefits-guide.md';
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
const REFUSAL = /inside the repository/;

function scratch(t, prefix = 'fathom-yp-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The household of a temp instance (createInstance layout, its store at
// households/<id>/fathom.sqlite under a data dir in the OS temp dir) with the store clock set.
// Returns { db, household, dataDir }; builds write under household.root.
async function store(t, { mode = 'real', init = () => {} } = {}) {
  const inst = await tempInstance({ mode, init: db => { init(db); setSetting(db, 'clock', CLOCK); } });
  t.after(() => { inst.close(); rmSync(inst.dataDir, { recursive: true, force: true }); });
  return { db: inst.db, household: await inst.household(), dataDir: inst.dataDir };
}

// The household context with another root: a storage root the build guard must refuse before
// the vault opens or the engine is called.
const rootedAt = (household, root) => ({ ...household, root });

const engineFor = (db, household, env = {}) => createRuntimeEngine({ db, config: loadConfig({ FATHOM_DATA: household.config.dataDir, FATHOM_ENGINE: 'fake', ...env }) });

// Store a plan file the way ingest stores uploads (encrypted at rest by the household vault, at
// files/<id>.bin under its root) and register it as a files row plus a documents row. `bytes`
// replaces the text (a PDF); `storedPath` registers a path without storing anything (escaping
// paths). Server tests store through the served household's own vault.
async function addPlanFile(db, household, { id = FILE_ID, name = FILE_NAME, text = PLAN_TEXT, bytes, docType = 'plan', storedPath, mime = 'text/markdown' } = {}) {
  const data = bytes ? Buffer.from(bytes) : Buffer.from(text, 'utf8');
  const rel = storedPath ?? await storeFile({ vault: await household.vault(), id, bytes: data, purpose: 'upload' });
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
              VALUES (?, ?, ?, ?, NULL, 'other', '2026-11-01T09:00:00Z', ?, 'parsed', '')`).run(id, name, mime, data.length, rel);
  if (docType) {
    db.prepare("INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES (?, 2026, '{}', ?, 'synthetic', 'file')")
      .run(docType, id);
  }
}

// ---------------------------------------------------------------- unit

test('fakeExtractRows splits a document on headings and page markers', () => {
  const byHeading = fakeExtractRows(PLAN_TEXT, { fileName: FILE_NAME });
  assert.deepEqual(byHeading.map(r => r.title), ['Health plan tiers', 'Dependent care account']);
  assert.ok(byHeading[0].body.includes('standard tier'));
  assert.ok(byHeading.every(r => Number.isInteger(r.page) && r.page >= 1));
  const byPage = fakeExtractRows('Page 1\nSynthetic first page text.\nPage 2\nSynthetic second page text.\n', { fileName: 'paged.txt' });
  assert.deepEqual(byPage.map(r => r.page), [1, 2]);
  assert.ok(byPage[1].body.includes('second page'));
  assert.ok(byPage.every(r => typeof r.title === 'string' && r.title.length > 0));
  assert.deepEqual(fakeExtractRows('', { fileName: 'empty.txt' }), []);
});

test('a synthetic plan document builds a valid, always-active pack citing its file and page', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household);
  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dir, yourPlansDir(household.root));
  assert.equal(result.entries, 2);
  assert.deepEqual(result.sources, [{ fileId: FILE_ID, name: FILE_NAME }]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dropped, 0, 'B5: every fake row matches its document');

  const [pack] = loadPacks([result.dir]);
  assert.equal(pack.id, 'your-plans');
  assert.equal(pack.name, 'Your plans');
  assert.equal(pack.version, '1.0.0');
  assert.equal(pack.taxYear, 2026);
  assert.equal(pack.reviewed, CLOCK);
  assert.equal(pack.curator, 'Built from your documents');
  assert.deepEqual(pack.appliesWhen, { all: [] });
  assert.deepEqual([...pack.covers].sort(), ['Dependent care account', 'Health plan tiers']);
  assert.equal(pack.whatIf.prompt, 'What do our own plan and benefits documents say about the choices in front of us?');
  assert.equal(activePacks([pack], {})[0].status, 'active', 'applies with no facts at all');
  assert.equal(pack.entries.length, 2);
  for (const entry of pack.entries) {
    assert.match(entry.file, /^\d{2}-[a-z0-9-]+\.md$/);
    assert.equal(entry.cites.length, 1);
    assert.equal(entry.cites[0].label, `${FILE_NAME}, page 1`);
    assert.equal(entry.cites[0].url, `https://your-plans.invalid/${encodeURIComponent(FILE_ID)}?page=1`);
  }
  const health = pack.entries.find(e => e.title === 'Health plan tiers');
  assert.ok(health.file.includes('health-plan-tiers'));
  assert.ok(health.body.startsWith('# Health plan tiers'));
  assert.ok(health.body.includes('standard tier'));
  assert.ok(health.body.includes(`Source: ${FILE_NAME}, page 1`));
  assert.ok(health.body.includes('Tax year: 2026'));
  assert.ok(health.body.includes(`Reviewed: ${CLOCK}`));

  const built = getSetting(db, 'yourPlans', null);
  assert.equal(built.entries, 2);
  assert.equal(built.dropped, 0, 'B5: settings.yourPlans records the dropped count');
  assert.deepEqual(built.sources, [FILE_NAME]);
  assert.equal(typeof built.builtAt, 'string');
  assert.equal(getSetting(db, 'packs.generation', 0), 1);
  const extract = db.prepare("SELECT count(*) AS n FROM spend_ledger WHERE purpose = 'extract'").get().n;
  assert.ok(extract >= 1, 'extraction spend is recorded');

  const again = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(again.entries, 2);
  assert.equal(getSetting(db, 'packs.generation', 0), 2, 'each build bumps the generation');
  assert.equal(readdirSync(result.dir).filter(f => f.endsWith('.md')).length, 2, 'the rebuild replaces, not appends');
});

test('extra file ids, a text-only document row, unknown ids and escaping paths are handled', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household);
  await addPlanFile(db, household, { id: 'file-synthetic-notes', name: 'synthetic-notes.txt', mime: 'text/plain', docType: null,
    text: '# Commuter notes\n\nThe synthetic notes describe a commuter benefit.\n' });
  // A real file just outside the household root, which the escaping stored path names.
  writeFileSync(join(dirname(household.root), 'outside.md'), '# Outside entry\n\nSYNTHETIC-OUTSIDE-TEXT must never be read.\n');
  await addPlanFile(db, household, { id: 'file-escaping', name: 'escaping.md', storedPath: '../outside.md' });
  const doc = db.prepare("INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES ('benefits', 2026, ?, NULL, 'synthetic', 'note')")
    .run(JSON.stringify({ text: '# Wellness stipend\n\nThe synthetic benefits note describes a wellness stipend.\n' }));
  const docName = `document-${Number(doc.lastInsertRowid)}`;

  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK,
    fileIds: ['file-synthetic-notes', 'no-such-file'] });
  assert.equal(result.written, true);
  const names = result.sources.map(x => x.name);
  for (const name of [FILE_NAME, 'synthetic-notes.txt', docName]) assert.ok(names.includes(name), `${name} is a source`);
  assert.ok(!names.includes('escaping.md'), 'a stored_path outside the data dir is skipped');
  assert.ok(result.warnings.some(w => w.includes('no-such-file')), 'an unknown file id warns');
  assert.ok(result.warnings.length >= 2, 'the escaping path warns too');
  const titles = loadPacks([result.dir])[0].entries.map(e => e.title).sort();
  assert.deepEqual(titles, ['Commuter notes', 'Dependent care account', 'Health plan tiers', 'Wellness stipend']);
  const bodies = loadPacks([result.dir])[0].entries.map(e => e.body).join('\n');
  assert.ok(!bodies.includes('SYNTHETIC-OUTSIDE-TEXT'));
  assert.ok(result.warnings.every(w => !w.includes('SYNTHETIC-OUTSIDE-TEXT')));
});

test('zero extracted rows write nothing', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household, { text: '' });
  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(result.written, false);
  assert.equal(result.entries, 0);
  assert.equal(existsSync(yourPlansDir(household.root)), false);
  assert.equal(getSetting(db, 'yourPlans', null), null);
  assert.equal(getSetting(db, 'packs.generation', 0), 0);
});

test('a target inside the repository is refused: root, nested dirs and symlinks into it', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household);
  const engine = engineFor(db, household);
  const nested = join(ROOT, `.yp-guard-${process.pid}`, 'deeper');
  const link = join(scratch(t), 'link-to-repo');
  symlinkSync(ROOT, link);
  const linkNested = join(scratch(t), 'link-to-test');
  symlinkSync(join(ROOT, 'test'), linkNested);
  const repoPlans = join(ROOT, 'packs', 'your-plans');
  const repoPlansExisted = existsSync(repoPlans);
  try {
    for (const root of [ROOT, join(ROOT, 'test', 'fixtures'), nested, link, linkNested]) {
      await assert.rejects(buildYourPlans({ db, engine, household: rootedAt(household, root), clock: CLOCK }), REFUSAL, `refused ${root === ROOT ? 'the repo root' : root}`);
    }
    assert.equal(existsSync(join(ROOT, `.yp-guard-${process.pid}`)), false, 'nothing was created inside the repository');
    assert.equal(existsSync(join(ROOT, 'test', 'fixtures', 'packs')), false);
    assert.equal(existsSync(join(ROOT, 'test', 'packs')), false);
    assert.equal(existsSync(repoPlans), repoPlansExisted);
    assert.equal(getSetting(db, 'packs.generation', 0), 0);
  } finally {
    rmSync(join(ROOT, `.yp-guard-${process.pid}`), { recursive: true, force: true });
    if (!repoPlansExisted) rmSync(repoPlans, { recursive: true, force: true });
  }
  const allowed = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(allowed.written, true, 'a household root outside the checkout is allowed');
});

// The runtime with extract() counted, every other member passed through.
function countingEngine(runtime) {
  const counter = { extracts: 0 };
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'extract') return async request => { counter.extracts++; return target.extract(request); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, counter };
}

const listTree = dir => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

test('a model title with markup or token syntax is neutralized in the manifest covers and entry titles', async t => {
  const { db, household } = await store(t);
  const heading = '<img src=x onerror=alert(1)> Plan {f:true_reserve}';
  // B5: every number in a title must appear in the excerpt (for the fake path, the section text),
  // so the section quotes the same markup. The number check runs on the neutralized title and body,
  // where the brace syntax is no longer a token.
  await addPlanFile(db, household, { text: `# ${heading}\n\nThe synthetic plan section quotes <img src=x onerror=alert(1)> for the owner.\n` });
  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(result.written, true);
  const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
  const titles = [...manifest.covers, ...manifest.entries.map(e => e.title)];
  assert.equal(titles.length, 2);
  for (const title of titles) {
    assert.ok(!/[<>{}]/.test(title), `title is neutral: ${title}`);
    assert.match(title, /Plan/);
    assert.match(title, /true_reserve/);
  }
  const [pack] = loadPacks([result.dir]);
  for (const entry of pack.entries) {
    const first = entry.body.split('\n')[0];
    assert.ok(!/[<>{}]/.test(first), `entry heading is neutral: ${first}`);
  }
});

test('a data dir inside the repository whose your-plans dir links outside is refused before any extraction', async t => {
  const repoData = join(ROOT, `.yp-link-guard-${process.pid}`);
  const outside = scratch(t, 'fathom-yp-outside-');
  const { db, household } = await store(t);
  const { engine, counter } = countingEngine(engineFor(db, household));
  try {
    mkdirSync(join(repoData, 'packs'), { recursive: true });
    await addPlanFile(db, household);
    const link = yourPlansDir(repoData);
    symlinkSync(outside, link);
    const before = listTree(repoData);
    await assert.rejects(buildYourPlans({ db, engine, household: rootedAt(household, repoData), clock: CLOCK }), REFUSAL);
    assert.equal(counter.extracts, 0, 'no engine call');
    assert.deepEqual(readdirSync(outside), [], 'nothing written outside');
    assert.deepEqual(listTree(repoData), before, 'nothing written inside the repository');
    assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink is untouched');
    assert.equal(readlinkSync(link), outside);
    assert.equal(getSetting(db, 'packs.generation', 0), 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM spend_ledger WHERE purpose = 'extract'").get().n, 0);
  } finally {
    rmSync(repoData, { recursive: true, force: true });
  }
  assert.equal(existsSync(repoData), false);

  const liveness = await store(t);
  await addPlanFile(liveness.db, liveness.household);
  const ok = countingEngine(engineFor(liveness.db, liveness.household));
  const built = await buildYourPlans({ db: liveness.db, engine: ok.engine, household: liveness.household, clock: CLOCK });
  assert.equal(built.written, true, 'a household root outside the repository still builds');
  assert.ok(ok.counter.extracts >= 1);
});

test('the Dockerfile copies packs and scripts into the image', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY packs \.\/packs\s*$/m);
  assert.match(dockerfile, /^COPY scripts \.\/scripts\s*$/m);
});

// ---------------------------------------------------------------- B5: entries must match the document

// The runtime with extract() scripted: each call takes the next rows list as its fake response
// (text and PDF sources alike); once the list is used up, calls pass through unchanged.
function extractScripted(runtime, rowsPerCall) {
  const queue = [...rowsPerCall];
  return new Proxy(runtime, {
    get(target, key) {
      if (key === 'extract') {
        return async request => {
          const rows = queue.shift();
          return target.extract(rows ? { ...request, fake: [{ text: JSON.stringify({ rows }) }] } : request);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const DENTAL = 'The synthetic dental plan covers routine cleanings and exams.';
const VISION = 'The synthetic vision plan covers frames and lenses.';
const TWO_SECTIONS = `# Dental plan\n\n${DENTAL}\n\n# Vision plan\n\n${VISION}\n`;
const row = (title, body, excerpt, page = 1) => ({ title, body, excerpt, page });
const builtBodies = dir => loadPacks([dir])[0].entries.map(e => e.body).join('\n');
const DROP_WARNING = /did not match the document/;

test('fakeExtractRows emits an excerpt equal to the section text it read', () => {
  const rows = fakeExtractRows(PLAN_TEXT, { fileName: FILE_NAME });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(typeof r.excerpt, 'string');
    assert.equal(r.excerpt, r.body);
    assert.ok(PLAN_TEXT.includes(r.excerpt));
  }
});

test('B5: a row inventing an amount or a title number absent from its excerpt is dropped and counted', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household, { text: TWO_SECTIONS });
  const engine = extractScripted(engineFor(db, household), [[
    row('Dental plan', DENTAL, DENTAL),
    row('Vision plan', 'The synthetic vision plan pays $4,250 toward frames and lenses.', VISION),
    row('Tier 3 vision', VISION, VISION),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.entries, 1);
  assert.equal(result.dropped, 2);
  const [pack] = loadPacks([result.dir]);
  assert.deepEqual(pack.entries.map(e => e.title), ['Dental plan']);
  assert.ok(!builtBodies(result.dir).includes('4,250'), 'no entry carries the invented amount');
  const warning = result.warnings.find(w => DROP_WARNING.test(w));
  assert.ok(warning, JSON.stringify(result.warnings));
  assert.match(warning, /\b2\b/, 'the warning counts the dropped sections');
  for (const w of result.warnings) {
    assert.ok(!w.includes('synthetic vision') && !w.includes('4,250') && !w.includes('Tier 3'), `no document text in: ${w}`);
  }
  assert.equal(getSetting(db, 'yourPlans', null).dropped, 2);
});

test('B5: a row whose excerpt is not in the document, or is empty, is dropped; whitespace differences still match', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household, { text: TWO_SECTIONS });
  const engine = extractScripted(engineFor(db, household), [[
    row('Acupuncture', 'The synthetic plan covers acupuncture.', 'The synthetic plan covers acupuncture.'),
    row('Blank excerpt', DENTAL, '   '),
    row('Dental plan', DENTAL, '  The synthetic dental plan   covers routine\ncleanings and exams.  '),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.entries, 1);
  assert.equal(result.dropped, 2);
  assert.deepEqual(loadPacks([result.dir])[0].entries.map(e => e.title), ['Dental plan']);
  assert.ok(!builtBodies(result.dir).includes('acupuncture'));
});

test('B5: a row is kept only when its page matches the Page markers before its excerpt', async t => {
  const { db, household } = await store(t);
  const paged = `Page 1\n\n# Dental plan\n\n${DENTAL}\n\nPage 2\n\n# Vision plan\n\n${VISION}\n`;
  await addPlanFile(db, household, { text: paged });
  await addPlanFile(db, household, { id: 'file-unpaged', name: 'synthetic-unpaged.md', text: TWO_SECTIONS });
  const engine = extractScripted(engineFor(db, household), [
    // The paged document comes first: sources follow the documents rows in insertion order.
    [row('Dental plan', DENTAL, DENTAL, 1), row('Vision plan', VISION, VISION, 2),
      row('Dental again', DENTAL, DENTAL, 2), row('Vision again', VISION, VISION, 1)],
    // A document with no markers is all page 1.
    [row('Unpaged dental', DENTAL, DENTAL, 1), row('Unpaged vision', VISION, VISION, 3)],
  ]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dropped, 3);
  assert.equal(result.entries, 3);
  const [pack] = loadPacks([result.dir]);
  const cite = title => pack.entries.find(e => e.title === title)?.cites[0].label;
  assert.deepEqual(pack.entries.map(e => e.title).sort(), ['Dental plan', 'Unpaged dental', 'Vision plan']);
  assert.equal(cite('Dental plan'), `${FILE_NAME}, page 1`);
  assert.equal(cite('Vision plan'), `${FILE_NAME}, page 2`);
  assert.equal(cite('Unpaged dental'), 'synthetic-unpaged.md, page 1');
});

// PDF sources (AC14) are covered in test/your-plans-vault.test.mjs: text-layer PDFs are checked
// against their extracted text and pages, image-only PDFs are skipped before any model call.

// A demo-seeded household (for the answerer) whose data dir is outside the repository.
const demoPlanStore = t => store(t, { mode: 'demo', init: seedDemo });

// The runtime with every chat call answered by `text` (first answer and corrective retry).
function sayingEngine(runtime, text) {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') return async request => target.call({ ...request, fake: [{ text }] });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function answerAfterBuild(db, household, text) {
  const packs = createLivePacks(db, { dataDir: household.root });
  packs.refresh();
  const engine = sayingEngine(engineFor(db, household), text);
  return createLiveAnswerer({ engine, packs, root: household.root, services: { ...household.services, engine: engine, config: { dataDir: household.root } } }).answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say' });
}

test('B5: a document with no numbers and a row inventing an amount gives no entry with it, and an answer stating it is ungrounded', async t => {
  const { db, household } = await demoPlanStore(t);
  await addPlanFile(db, household, { text: TWO_SECTIONS });
  const engine = extractScripted(engineFor(db, household), [[
    row('Dental plan', DENTAL, DENTAL),
    row('Vision plan', 'The synthetic vision plan pays $4,250 toward frames and lenses.', VISION),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.ok(!builtBodies(result.dir).includes('4,250'));
  const reply = await answerAfterBuild(db, household, 'Your vision plan pays $4,250 toward frames.');
  assert.ok(reply.provenance.packIds.includes('your-plans'));
  assert.ok(reply.provenance.grounding.unverified.includes('$4,250'), JSON.stringify(reply.provenance.grounding));
});

// A section that states a year, a date, a percent and an amount, for rows that must still be kept.
const ENROLLMENT = 'Open enrollment for plan year 2027 closes on 2026-12-15. The synthetic plan pays 80 percent after a $1,500 deductible.';

test('B5: a row inventing a year-shaped amount, a year-shaped title number or a date absent from its excerpt is dropped and counted', async t => {
  const { db, household } = await store(t);
  assert.ok(!/\d/.test(TWO_SECTIONS), 'the first source has no numbers at all');
  await addPlanFile(db, household, { text: TWO_SECTIONS });
  await addPlanFile(db, household, { id: 'file-enrollment', name: 'synthetic-enrollment.md', text: `# Enrollment window\n\n${ENROLLMENT}\n` });
  const engine = extractScripted(engineFor(db, household), [
    [
      row('Dental plan', DENTAL, DENTAL),
      row('Vision benefit', 'The benefit is 2099 dollars.', VISION),
      row('Dental plan 2087', DENTAL, DENTAL),
      row('Vision claims', `${VISION} Claims are due by 2031-04-15.`, VISION),
      row('Vision deadline', `${VISION} Claims close on April 15, 2031.`, VISION),
    ],
    [row('Enrollment window 2027',
      'For plan year 2027, enrollment closes on 2026-12-15, and the plan pays 80 percent after a $1,500 deductible.', ENROLLMENT)],
  ]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dropped, 4, `the four invented rows are dropped: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.entries, 2);
  assert.deepEqual(loadPacks([result.dir])[0].entries.map(e => e.title).sort(), ['Dental plan', 'Enrollment window 2027'],
    'a row whose numbers, dates and years all appear in its excerpt is kept');
  const bodies = builtBodies(result.dir);
  for (const invented of ['2099', '2087', '2031-04-15', 'April 15']) assert.ok(!bodies.includes(invented), `no entry carries ${invented}`);
  const warning = result.warnings.find(w => DROP_WARNING.test(w));
  assert.ok(warning && /\b4\b/.test(warning), JSON.stringify(result.warnings));
  assert.equal(getSetting(db, 'yourPlans', null).dropped, 4);
});

test('B5: after a build drops a row inventing a year-shaped amount, an answer stating it is ungrounded', async t => {
  const { db, household } = await demoPlanStore(t);
  await addPlanFile(db, household, { text: TWO_SECTIONS });
  const engine = extractScripted(engineFor(db, household), [[
    row('Dental plan', DENTAL, DENTAL),
    row('Vision benefit', 'The synthetic vision benefit is 2099 dollars.', VISION),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dropped, 1, 'the invented row is dropped');
  assert.ok(!builtBodies(result.dir).includes('2099'));
  const reply = await answerAfterBuild(db, household, 'Your vision benefit is $2,099.');
  assert.ok(reply.provenance.packIds.includes('your-plans'));
  assert.ok(reply.provenance.grounding.unverified.includes('$2,099'), JSON.stringify(reply.provenance.grounding));
});

const BENEFIT_USD = 'Benefit is one thousand dollars.';
const BENEFIT_PCT = 'Benefit is one thousand percent.';

test('B5: a number-word row whose body changes the unit from its excerpt is dropped and counted, and a matching unit is kept', async t => {
  const { db, household } = await store(t);
  await addPlanFile(db, household, { id: 'file-usd', name: 'synthetic-usd.md', text: `# Benefit\n\n${BENEFIT_USD}\n` });
  await addPlanFile(db, household, { id: 'file-pct', name: 'synthetic-pct.md', text: `# Benefit\n\n${BENEFIT_PCT}\n` });
  const engine = extractScripted(engineFor(db, household), [
    [row('Benefit', BENEFIT_PCT, BENEFIT_USD), row('Benefit kept', BENEFIT_USD, BENEFIT_USD)],
    [row('Benefit', BENEFIT_USD, BENEFIT_PCT), row('Benefit kept', BENEFIT_PCT, BENEFIT_PCT)],
  ]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dropped, 2, `both unit-changed rows are dropped: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.entries, 2);
  assert.deepEqual(loadPacks([result.dir])[0].entries.map(e => e.title), ['Benefit kept', 'Benefit kept']);
  const bodies = builtBodies(result.dir);
  assert.ok(bodies.includes(BENEFIT_USD) && bodies.includes(BENEFIT_PCT), 'the matching-unit rows are kept');
  assert.equal(getSetting(db, 'yourPlans', null).dropped, 2);
});

test('B5: after a build drops a number-word row with a changed unit, an answer stating it is ungrounded', async t => {
  const { db, household } = await demoPlanStore(t);
  await addPlanFile(db, household, { text: `# Dental plan\n\n${DENTAL}\n\n# Benefit\n\n${BENEFIT_USD}\n` });
  const engine = extractScripted(engineFor(db, household), [[
    row('Dental plan', DENTAL, DENTAL),
    row('Benefit', BENEFIT_PCT, BENEFIT_USD),
  ]]);
  const result = await buildYourPlans({ db, engine, household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.dropped, 1, 'the unit-changed row is dropped');
  assert.ok(!builtBodies(result.dir).includes('percent'));
  const reply = await answerAfterBuild(db, household, 'The benefit is 1000%.');
  assert.ok(reply.provenance.packIds.includes('your-plans'));
  assert.ok(reply.provenance.grounding.unverified.includes('1000%'), JSON.stringify(reply.provenance.grounding));
});

test('B3: a document file name with digits never grounds that number in an answer', async t => {
  const { db, household } = await demoPlanStore(t);
  const name = 'plan_4821.md';
  const text = `# Vision benefit\n\n${VISION}\n`;
  assert.ok(!text.includes('4821'), 'the document text has no 4821');
  await addPlanFile(db, household, { id: 'file-plan-digits', name, text });
  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.ok(builtBodies(result.dir).includes(`Source: ${name}, page 1`), 'the entry still cites the file');
  const reply = await answerAfterBuild(db, household, 'Your plan document number is 4821.');
  assert.ok(reply.provenance.packIds.includes('your-plans'));
  assert.ok(reply.provenance.grounding.unverified.includes('4821'), JSON.stringify(reply.provenance.grounding));
});

test('R5 F1: a document saying "8.7 million" builds an entry; "$8.70" is ungrounded and "$8.7 million" grounds', async t => {
  const { db, household } = await demoPlanStore(t);
  await addPlanFile(db, household, { text: '# Synthetic cap\n\nThe cap is 8.7 million.\n' });
  const result = await buildYourPlans({ db, engine: engineFor(db, household), household, clock: CLOCK });
  assert.equal(result.written, true);
  assert.equal(result.entries, 1, JSON.stringify(result.warnings));
  assert.ok(builtBodies(result.dir).includes('8.7 million'), 'the entry carries the excerpt');
  const bad = await answerAfterBuild(db, household, 'Your cap is $8.70.');
  assert.ok(bad.provenance.packIds.includes('your-plans'));
  assert.ok(bad.provenance.grounding.unverified.includes('$8.70'), JSON.stringify(bad.provenance.grounding));
  const good = await answerAfterBuild(db, household, 'Your cap is $8.7 million.');
  assert.equal(good.provenance.grounding.ok, true, JSON.stringify(good.provenance.grounding));
});

// ---------------------------------------------------------------- server

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

// The server's instance is a demo instance, so the plan is sealed by its demo household's vault
// (the demo platform key under platform-secrets/), opened here as a CLI opens a household.
async function registerPlan(s) {
  const platform = openPlatform(join(s.dataDir, 'platform.sqlite'));
  const db = openDb(s.dbFile);
  const { secrets } = await instanceSecretsOf(s.dataDir, 'demo');
  const household = await householdContext({ db, platform, householdId: s.householdId, mode: 'demo', config: { dataDir: s.dataDir }, secrets });
  try { await addPlanFile(db, household); } finally { await household.close(); platform.close(); }
}

const yourPlansPack = scenario => scenario.packs.find(p => p.id === 'your-plans');

test('POST /api/your-plans/build builds the pack, which is live for entries and the next ask', T2, () => withServer({ env: { FATHOM_ENGINE: 'fake' } }, async s => {
  await registerPlan(s);
  const before = await getScenario(s.baseUrl);
  assert.ok(before.live.yourPlans.sources.some(x => x.fileId === FILE_ID && x.name === FILE_NAME && x.docType === 'plan'));
  assert.ok(before.live.yourPlans.files.some(f => f.id === FILE_ID && f.name === FILE_NAME));
  assert.equal(before.live.yourPlans.built, null);

  const r = await ok(postJson(s.baseUrl, '/api/your-plans/build', {}));
  assert.equal(r.result.written, true);
  assert.equal(r.result.entries, 2);
  assert.deepEqual(r.result.sources, [{ fileId: FILE_ID, name: FILE_NAME }]);
  assert.ok(Array.isArray(r.result.warnings));
  assert.equal(r.result.dropped, 0, 'B5: the API passes the dropped count through');
  const pack = yourPlansPack(r.scenario);
  assert.ok(pack, 'the pack is in the response scenario');
  assert.equal(pack.status, 'active');
  assert.equal(pack.entryList.length, 2);
  assert.equal(r.scenario.live.yourPlans.built.entries, 2);

  const entryId = pack.entryList[0].id;
  const entry = await ok(request(s.baseUrl, { path: `/api/packs/your-plans/entries/${encodeURIComponent(entryId)}` }));
  assert.equal(entry.entry.id, entryId);
  assert.match(entry.entry.cites[0].url, /^https:\/\/your-plans\.invalid\//);

  const reply = await ok(postJson(s.baseUrl, '/api/threads', { text: 'What do our plan documents say' }));
  assert.ok(reply.message.provenance.packIds.includes('your-plans'), 'the next prompt carries the new pack');
}));

test('POST /api/your-plans/build validates its body and refuses while the engine is off or over the cap', T2, () => withServer({ env: { FATHOM_ENGINE: 'fake' } }, async s => {
  await registerPlan(s);
  for (const body of [{ fileIds: 'x' }, { fileIds: [1] }, { fileIds: Array.from({ length: 51 }, (_, i) => `f${i}`) }]) {
    const r = await postJson(s.baseUrl, '/api/your-plans/build', body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`);
  }
  await ok(postJson(s.baseUrl, '/api/engine', { on: false }));
  const off = await postJson(s.baseUrl, '/api/your-plans/build', {});
  assert.equal(off.status, 409);
  assert.equal(typeof off.json.error, 'string');
  await ok(postJson(s.baseUrl, '/api/engine', { on: true }));
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 0 }));
  const capped = await postJson(s.baseUrl, '/api/your-plans/build', {});
  assert.equal(capped.status, 409);
  assert.equal(yourPlansPack(await getScenario(s.baseUrl)), undefined, 'nothing was built');
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 200 }));
  const fine = await ok(postJson(s.baseUrl, '/api/your-plans/build', { fileIds: Array.from({ length: 50 }, (_, i) => `f${i}`) }));
  assert.equal(fine.result.written, true, '50 ids is within the limit');
}));

test('npm run build:your-plans against a running server is picked up on its next request', T2, () => withServer({ env: { FATHOM_ENGINE: 'fake' } }, async s => {
  await registerPlan(s);
  assert.equal(yourPlansPack(await getScenario(s.baseUrl)), undefined);
  const cli = await runCommand('npm', ['run', 'build:your-plans', '--', '--household', s.householdId], { env: { FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' } });
  assert.equal(cli.code, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /\b2\b/, 'reports the entry count');
  assert.match(cli.stdout, /\b0\b[^\n]*dropped|dropped[^\n]*\b0\b/i, 'B5: reports the dropped count');
  assert.ok(!cli.stdout.includes('standard tier') && !cli.stderr.includes('standard tier'), 'prints counts only, never document text');

  const pack = yourPlansPack(await getScenario(s.baseUrl));
  assert.ok(pack, 'the running server sees the CLI build');
  assert.equal(pack.status, 'active');
  const entryId = pack.entryList[0].id;
  assert.equal((await request(s.baseUrl, { path: `/api/packs/your-plans/entries/${encodeURIComponent(entryId)}` })).status, 200);
  const reply = await ok(postJson(s.baseUrl, '/api/threads', { text: 'What do our plan documents say' }));
  assert.ok(reply.message.provenance.packIds.includes('your-plans'));
}));

test('npm run build:your-plans refuses a data dir with no store and creates nothing', T, async t => {
  const dataDir = scratch(t);
  const cli = await runCommand('npm', ['run', 'build:your-plans', '--', '--household', 'hh-synthetic-absent'], { env: { FATHOM_DATA: dataDir, FATHOM_ENGINE: 'fake' } });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /household_unavailable/);
  for (const name of ['fathom.sqlite', 'platform.sqlite', 'households']) assert.equal(existsSync(join(dataDir, name)), false, `${name} is not created`);
  assert.equal(existsSync(yourPlansDir(dataDir)), false);
});
