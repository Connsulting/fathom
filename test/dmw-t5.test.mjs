// DMW-T5: use what the owner already said. Saved memories (the preferences table) and uploaded
// note files become quoted source rows for the resolver. A yes/no answer cited from a memory is
// applied with evidence quoting it and Undo; a number stated in a note becomes one "Use it?"
// Confirm card (kind stated_value) behind the evidence guard; a paid-off mortgage memory overrides
// loan data; and every question form carries a free-text box that hands the owner's words to Ask.
// Every name, amount, account and sentence here is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { scratch, createRealStore, closeRealStore, householdOf } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { setSetting } from '../src/store/db.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { ask, getItem, autoInfo, reopenItem, answerItem } from '../src/ingest/confirm.mjs';
import { questionFor } from '../src/jobs/triggers/common.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { resolvePending } from '../src/resolve/index.mjs';
import { writePreference } from '../src/actions/preferences.mjs';
import { inferMortgage } from '../src/calc/mortgage-inference.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate } from '../src/api/handlers.mjs';
import { ingestState } from '../src/ingest/freshness.mjs';
import { ingestScreens } from '../web/horizon/screens/ingest.js';
import * as answersView from '../web/horizon/screens/rec-answers.js';

const NOW = '2032-03-10T12:00:00.000Z';
const OWN_WORDS = 'Or tell Fathom in your own words';
const SALARY_NOTE = 'Met with the advisor on Tuesday. My salary range from the advisor is 90k to 120k.';
const SALARY_SENTENCE = 'My salary range from the advisor is 90k to 120k';
const NOTE = { fileId: 7, name: 'advisor-notes.md', text: SALARY_NOTE };

async function store(fn) {
  const t = await tempDb();
  setSetting(t.db, 'mode', 'real');
  try { await fn(t.db); } finally { t.db.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
}

// The scripted resolver model from test/resolve.test.mjs, extended: the script returns either an
// answers array or {answers, proposals}. Every payload the model saw is kept in `payloads`.
function model(db, script) {
  const runtime = createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => new Date(NOW) });
  const calls = [], payloads = [];
  return { mode: 'fake', isOn: () => runtime.isOn(), status: () => runtime.status(), calls, payloads,
    async call(req) {
      calls.push(req);
      const payload = JSON.parse(req.messages[0].content);
      payloads.push(payload);
      const out = typeof script === 'function' ? script(payload) : script;
      const body = Array.isArray(out) ? { answers: out } : { answers: [], ...out };
      return runtime.call({ ...req, fake: [{ text: JSON.stringify(body), costUsd: 0.001 }] });
    } };
}
const options = { now: NOW, packDirs: [], allowed: () => true, funded: () => true };
const ownerRows = payload => (Array.isArray(payload?.rows) ? payload.rows : []).filter(r => typeof r?.ref === 'string'
  && (r.ref.startsWith('preferences:') || r.ref.startsWith('notes:')));

function rec(db, def, status = 'proposed') {
  db.prepare('INSERT INTO recs (id,def,status,updated_at,sort) VALUES (?,?,?,?,0)')
    .run(def.id, JSON.stringify(def), status, '2032-03-10');
}
const cashBasisRec = db => rec(db, { id: 'synthetic-books', question: questionFor(['business.cashBasis']) });
const salaryRec = db => rec(db, { id: 'synthetic-salary', advisorQuestions: ['business.salaryRange'] }, 'waiting');
const remember = (db, text) => writePreference({ db, actorId: 'synthetic-owner', now: NOW }, { text }).preference.id;
const statedItems = db => db.prepare("SELECT id FROM confirm_items WHERE kind='stated_value'").all();

/* ---------------------------------------------------------------- AC1 */

test('AC1: ownerSaidRows quotes each memory and each note sentence with its own ref', () => store(async db => {
  const { ownerSaidRows } = await import('../src/resolve/owner-said.mjs');
  const id = remember(db, 'Our business keeps its books on a cash basis.');
  const rows = ownerSaidRows(db, { notes: [NOTE] });
  const memory = rows.filter(r => r.source === 'memory');
  assert.deepEqual(memory.map(r => [r.ref, r.quote]), [[`preferences:${id}`, 'Our business keeps its books on a cash basis.']]);
  const notes = rows.filter(r => r.source === 'note');
  assert.equal(notes.length, 2, 'one row per note sentence');
  assert.deepEqual(notes.map(r => r.ref), ['notes:7:0', 'notes:7:1'], 'note refs are notes:<fileId>:<0-based sentence index>');
  assert.ok(notes[1].quote.includes(SALARY_SENTENCE), notes[1].quote);
  assert.ok(!notes[1].quote.includes('Tuesday'), 'a note row holds one sentence');
  assert.ok(notes.every(r => r.name === 'advisor-notes.md'));
  assert.deepEqual(ownerSaidRows(db, {}).filter(r => r.source === 'note'), [], 'notes default to none');
}));

test('AC1: a yes/no question is answered from a memory with quoted evidence, and Undo declines it for good', () => store(async db => {
  cashBasisRec(db);
  const text = 'Our business keeps its books on a cash basis.';
  const id = remember(db, text);
  const ref = `preferences:${id}`;
  const engine = model(db, payload => payload.items.filter(i => i.kind === 'resolver_fact').map(i => ({
    item: i.id, option: 'true', basis: 'owner_said', refs: ownerRows(payload).filter(r => r.ref === ref).map(r => r.ref),
  })));
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  const seen = ownerRows(engine.payloads[0]).find(r => r.ref === ref);
  assert.ok(seen, `the model saw the memory row: ${JSON.stringify(engine.payloads[0].rows.map(r => r.ref))}`);
  assert.equal(seen.quote, text);
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact' AND subject='business.cashBasis'").get();
  assert.ok(item, 'the rec question is queued');
  assert.equal(getItem(db, item.id).status, 'answered');
  assert.equal(getFacts(db)['business.cashBasis'], true);
  const info = autoInfo(db, item.id);
  assert.equal(info.rule, 'resolver');
  assert.ok(info.evidence.text.includes(`Your memory says "${text}`), info.evidence.text);
  assert.ok(info.evidence.refs.includes(ref));

  reopenItem(db, item.id, { now: NOW });
  assert.equal(getItem(db, item.id).status, 'pending');
  assert.ok(db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id));
  assert.equal(getFacts(db)['business.cashBasis'], undefined);
  await resolvePending(db, engine, options);
  assert.equal(getItem(db, item.id).status, 'pending', 'a declined answer is never re-answered');
  assert.equal(getFacts(db)['business.cashBasis'], undefined);
}));

/* ---------------------------------------------------------------- AC2 */

const salaryProposal = (value, quote = null) => payload => {
  const row = ownerRows(payload).find(r => r.quote?.includes(SALARY_SENTENCE));
  return row ? { answers: [], proposals: [{ key: 'business.salaryRange', value, quote: quote ?? row.quote, refs: [row.ref] }] } : [];
};

test('AC2: a salary range stated in a note becomes one Use it card; Use it records the fact and Undo removes it', () => store(async db => {
  salaryRec(db);
  const engine = model(db, salaryProposal({ min: 90000, max: 120000 }));
  await resolvePending(db, engine, { ...options, notes: [NOTE] });
  assert.equal(engine.calls.length, 1, 'an open number question with an owner note reaches the model');
  const row = ownerRows(engine.payloads[0]).find(r => r.quote?.includes(SALARY_SENTENCE));
  assert.ok(row, `the model saw the note sentence: ${JSON.stringify(engine.payloads[0].rows.map(r => r.ref))}`);
  assert.equal(row.ref, 'notes:7:1');
  assert.equal(getFacts(db)['business.salaryRange'], undefined, 'a proposal never writes the fact by itself');

  const items = statedItems(db);
  assert.equal(items.length, 1, 'one Confirm card');
  const item = getItem(db, items[0].id);
  assert.equal(item.status, 'pending');
  assert.match(item.question, new RegExp(`"${SALARY_SENTENCE}\\.?"`));
  assert.match(item.question, /Use it\?$/);
  assert.deepEqual(item.options.map(o => o.id), ['use', 'not_this']);
  assert.equal(item.context.key, 'business.salaryRange');
  assert.deepEqual(item.context.value, { min: 90000, max: 120000 });
  assert.ok(item.context.quote.includes(SALARY_SENTENCE));
  assert.equal(item.context.ref, 'notes:7:1');
  assert.equal(typeof item.context.description, 'string');
  assert.ok(item.context.description.trim().length > 0);
  for (const text of [item.question, item.context.description]) assert.ok(!text.includes('business.salaryRange'), `no internal key: ${text}`);

  await resolvePending(db, engine, { ...options, notes: [NOTE] });
  assert.equal(statedItems(db).length, 1, 'a later run does not queue the same proposal twice');

  answerItem(db, item.id, 'use', { now: NOW });
  assert.deepEqual(getFacts(db)['business.salaryRange'], { min: 90000, max: 120000 });
  reopenItem(db, item.id, { now: NOW });
  assert.equal(getFacts(db)['business.salaryRange'], undefined, 'Undo removes the fact');
}));

test('AC2: the evidence guard refuses a value the quote does not state, and a quote the cited row does not hold', async () => {
  await store(async db => {
    salaryRec(db);
    const engine = model(db, salaryProposal({ min: 95000, max: 120000 }));
    await resolvePending(db, engine, { ...options, notes: [NOTE] });
    assert.equal(engine.calls.length, 1, 'the proposal reached the guard (liveness)');
    assert.equal(statedItems(db).length, 0, 'a value not stated in its quote creates nothing');
    assert.equal(getFacts(db)['business.salaryRange'], undefined);
  });
  await store(async db => {
    salaryRec(db);
    const engine = model(db, salaryProposal({ min: 90000, max: 130000 }, 'My salary range from the advisor is 90k to 130k.'));
    await resolvePending(db, engine, { ...options, notes: [NOTE] });
    assert.equal(engine.calls.length, 1, 'the proposal reached the guard (liveness)');
    assert.equal(statedItems(db).length, 0, 'a quote the cited row does not hold creates nothing');
    assert.equal(getFacts(db)['business.salaryRange'], undefined);
  });
});

const PLAIN_NOTE = { fileId: 8, name: 'plain-notes.md', text: 'My salary range from the advisor is 90000 to 120000.' };
// Like a real model, this script can only copy the masked quote it was sent.
const maskedSalaryProposal = value => payload => {
  const row = ownerRows(payload).find(r => r.quote?.includes('salary range'));
  return row ? { answers: [], proposals: [{ key: 'business.salaryRange', value, quote: row.quote, refs: [row.ref] }] } : [];
};

test('AC2: a salary range written as plain numbers survives masking and becomes a Use it card', async () => {
  await store(async db => {
    salaryRec(db);
    const engine = model(db, maskedSalaryProposal({ min: 90000, max: 120000 }));
    await resolvePending(db, engine, { ...options, notes: [PLAIN_NOTE] });
    assert.equal(engine.calls.length, 1);
    const row = ownerRows(engine.payloads[0]).find(r => r.quote?.includes('salary range'));
    assert.ok(row, 'the model saw the note sentence');
    assert.ok(row.quote.includes('X0000'), `the payload quote is masked: ${row.quote}`);
    assert.ok(!row.quote.includes('90000'), 'the model never saw the raw run');
    const items = statedItems(db);
    assert.equal(items.length, 1, 'one Confirm card');
    const item = getItem(db, items[0].id);
    assert.deepEqual(item.context.value, { min: 90000, max: 120000 });
    for (const text of [item.question, item.context.quote]) {
      assert.ok(text.includes('90000 to 120000'), `the owner's real words: ${text}`);
      assert.ok(!text.includes('X0000'), `no masked run: ${text}`);
    }
  });
  await store(async db => {
    salaryRec(db);
    const engine = model(db, maskedSalaryProposal({ min: 80000, max: 120000 }));
    await resolvePending(db, engine, { ...options, notes: [PLAIN_NOTE] });
    assert.equal(engine.calls.length, 1, 'the proposal reached the guard (liveness)');
    assert.equal(statedItems(db).length, 0, 'a value the real words do not state creates nothing');
  });
});

test('AC1: an advisor yes/no question listed only under advisorQuestions is answered from a memory', () => store(async db => {
  const key = 'retirement.planTermsConfirmed';
  rec(db, { id: 'synthetic-advisor', advisorQuestions: [key] }, 'waiting');
  const text = 'Our advisor confirmed the retirement plan terms and our eligibility.';
  const ref = `preferences:${remember(db, text)}`;
  const engine = model(db, payload => payload.items.filter(i => i.kind === 'resolver_fact' && (i.context?.key === key || i.subject === key))
    .map(i => ({ item: i.id, option: 'true', basis: 'owner_said', refs: [ref] })));
  await resolvePending(db, engine, options);
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact' AND subject=?").get(key);
  assert.ok(item, 'the advisor question is queued as a resolver_fact item');
  assert.equal(getItem(db, item.id).status, 'answered');
  assert.equal(getFacts(db)[key], true);
  assert.ok(autoInfo(db, item.id).evidence.text.includes('Your memory says "Our advisor confirmed'), autoInfo(db, item.id).evidence.text);
}));

/* ---------------------------------------------------------------- AC3 */

const CLOCK = '2026-11-05';
// The positive-balance mortgage loan with matched payments from test/inference.test.mjs.
function loan(db) {
  const now = `${CLOCK}T12:00:00Z`;
  const account = db.prepare("INSERT INTO accounts(id,inst,name,kind) VALUES (?, 'Example lender', ?, ?)");
  account.run('cash', 'Checking', 'checking');
  account.run('loan', 'Example home mortgage', 'loan');
  account.run('card', 'Credit card', 'card');
  let balance = 20000;
  const rate = 0.048, payment = 900;
  const snapshot = db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)');
  const tx = db.prepare('INSERT INTO transactions(account_id,date,amount,category,description) VALUES (?,?,?,?,?)');
  const classify = id => db.prepare("INSERT INTO transaction_category_corrections(transaction_id,category,bucket,updated_at) VALUES (?,'Mortgage','household',?)").run(id, now);
  snapshot.run('loan', '2025-10-31', -balance);
  for (let m = 0; m < 12; m++) {
    const end = new Date(Date.UTC(2025, 11 + m, 0)).toISOString().slice(0, 10);
    balance = Math.round((balance * (1 + rate / 12) - payment) * 100) / 100;
    snapshot.run('loan', end, -balance);
    const date = `${end.slice(0, 7)}-15`;
    classify(tx.run('cash', date, -payment, 'Mortgage', 'Example home mortgage payment').lastInsertRowid);
    tx.run('loan', date, payment, 'Internal Transfers', 'Loan payment');
    classify(tx.run('cash', date, -2100, 'Mortgage', 'Credit card payment').lastInsertRowid);
    tx.run('card', date, 2100, 'Credit Card Payment', 'Card payment');
  }
}
const asksMortgage = db => buildScenario(db).recs.some(r => r.question
  && ((r.question.keys || []).includes('obligations.mortgage') || (r.question.fields || []).some(f => f.key === 'obligations.mortgage')));

test('AC3: a paid-off mortgage memory overrides active loan data and the mortgage question goes away', async t => {
  const s = scratch('fathom-dmw-t5-');
  const db = await createRealStore(s.dir());
  t.after(() => { closeRealStore(db); s.cleanup(); });
  loan(db);
  assert.equal(inferMortgage(db, CLOCK).status, 'active', 'loan data alone infers an active mortgage');
  await planRun(db);
  assert.ok(asksMortgage(db), 'before the memory a rec asks for mortgage terms');

  const text = 'We paid off the mortgage in March';
  const id = writePreference({ db, clock: CLOCK, now: `${CLOCK}T12:00:00Z`, actorId: 'synthetic-owner' }, { text }).preference.id;
  const out = inferMortgage(db, CLOCK);
  assert.equal(out.status, 'paid_off');
  assert.ok(out.overridden, 'the result says the memory overrode the loan data');
  assert.equal(out.overridden.by, `preferences:${id}`);
  assert.ok(out.sources.some(src => src.table === 'preferences'), JSON.stringify(out.sources));
  await planRun(db);
  assert.ok(!asksMortgage(db), 'after the memory and a plan run no rec asks for mortgage terms');
});

/* ---------------------------------------------------------------- AC4 */

test('AC4: a question with no stated answer stays pending', () => store(async db => {
  cashBasisRec(db);
  remember(db, 'We prefer the window seat on long flights.');
  const engine = model(db, { answers: [], proposals: [] });
  await resolvePending(db, engine, options);
  assert.equal(engine.calls.length, 1);
  assert.ok(ownerRows(engine.payloads[0]).some(r => r.quote === 'We prefer the window seat on long flights.'), 'the model saw the unrelated memory');
  const item = db.prepare("SELECT id FROM confirm_items WHERE kind='resolver_fact' AND subject='business.cashBasis'").get();
  assert.equal(getItem(db, item.id).status, 'pending');
  assert.equal(getFacts(db)['business.cashBasis'], undefined);
  assert.equal(statedItems(db).length, 0);
}));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('AC4: the rec question form carries the own-words box', () => {
  answersView.bind({ esc, snoozeLabel: () => 'Later' });
  answersView.reset();
  const r = { id: 'synthetic-books', status: 'proposed', question: { ...questionFor(['business.cashBasis']), primary: true } };
  const html = answersView.html(r, 'plan');
  assert.ok(html.includes(OWN_WORDS), html);
  assert.ok(html.includes('data-own-words="rec:synthetic-books"'), html);
});

// A pending Confirm deck card. resolver_fact items are not deck cards (they are answered on the rec
// form, src/ingest/freshness.mjs pendingWithGuesses), so the deck card is an import fact check.
const factCheck = (db, now) => ask(db, { kind: 'fact_check', subject: 'business.cashBasis',
  question: 'An import says business.cashBasis is true. Is that right?', options: [{ id: 'yes', label: 'Yes, that is right' }, { id: 'no', label: 'No, ignore it' }],
  context: { key: 'business.cashBasis', value: true }, now }).id;

test('AC4: each Confirm card carries the own-words box', () => store(async db => {
  setSetting(db, 'clock', '2032-03-10');
  const id = factCheck(db, NOW);
  const state = ingestState(db, { clock: '2032-03-10' });
  assert.ok(state.items.some(i => i.id === id), 'the item is pending in the deck');
  const h = {
    api: { s: {}, route: { name: 'confirm' }, demo: () => false, go() {},
      ingest: () => ({ pending: state.items.length, items: state.items, decided: [], files: [], waiting: [], sources: [], accounts: {}, staleNotes: [], formats: [] }),
      answer: () => Promise.resolve({}), reviseAnswer: () => Promise.resolve({}), reopenAnswer: () => Promise.resolve({}) },
    esc, draw() {}, getUi: () => ({}), addBtn: () => '', icon: () => '', shell: inner => inner,
    section: (title, body) => `<section class="h-sec"><h2>${title}</h2>${body}</section>`,
    pageHead: (k, t, s = '') => `<div class="h-ph"><div>${k}</div><h1>${t}</h1><p>${s}</p></div>`,
    btn: (label, attrs, cls = '') => `<button type="button" class="h-btn ${cls}" ${attrs}>${label}</button>`,
  };
  const html = ingestScreens(h).confirmPage(true);
  const card = html.match(new RegExp(`<article[^>]*data-item="${id}"[\\s\\S]*?</article>`))?.[0];
  assert.ok(card, 'the card renders');
  assert.ok(card.includes(OWN_WORDS), card);
  assert.ok(card.includes(`data-own-words="confirm:${id}"`), card);
}));

test('AC4: a typed answer sent to Ask from a Confirm card is recorded with one receipt, and Undo removes it', async t => {
  const s = scratch('fathom-dmw-t5-ask-');
  const db = await createRealStore(s.dir());
  t.after(() => { closeRealStore(db); s.cleanup(); });
  const id = factCheck(db, `${CLOCK}T12:00:00Z`);
  const text = 'Yes, our business keeps its books on a cash basis.';
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Books basis', toolResults: [] })
    : transport.call({ ...request, fake: [{ toolCalls: [{ name: 'answer', args: {
      operation: 'fact', key: 'business.cashBasis', value: true, evidence: text,
    } }] }, { text: 'Saved: your business keeps its books on a cash basis.' }] }) };
  const root = householdOf(db).root;
  const answerer = createLiveAnswerer({ engine, root, services: { ...householdOf(db).services, engine, config: { dataDir: root } } });
  const out = await threadCreate({ db, config: {}, identity: { id: 'synthetic-owner' }, scheduler: { runNow: () => planRun(db) }, answerer,
    body: { text, context: [{ kind: 'confirm', id: String(id) }] } });
  assert.equal(getFacts(db)['business.cashBasis'], true, 'Ask recorded the typed answer');
  const receipts = buildScenario(db).live.conversations[out.thread.key].flatMap(m => m.provenance?.actions || []);
  assert.equal(receipts.length, 1, 'one receipt for the answer');
  await callTool('undo', { operation: 'undo', id: receipts[0].id }, { db, clock: CLOCK, now: `${CLOCK}T12:00:00Z`, actorId: 'synthetic-owner', channel: 'mcp', scopes: ['write:facts'] });
  assert.equal(getFacts(db)['business.cashBasis'], undefined, 'Undo removed the answer');
});
