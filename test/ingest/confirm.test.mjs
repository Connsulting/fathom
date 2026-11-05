// AC6 (with plan revisions R4, R5, R9): imports queue short confirm questions (owner, kind,
// entity alias, tax year, fact check, near duplicate; employer_relation is covered in
// extract.test.mjs); answers apply deterministically, are remembered so an equivalent re-import asks
// nothing new, and are reachable over HTTP.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { src, spawnServer, request, postJson, SERVER_TIMEOUT } from '../helpers/server.mjs';
import {
  fixture, fixturePath, textFile, aggregatorFile, activityFile, northwindFile, realStore, fakeEngine, offEngine, all, one, count, items, NOW,
} from '../helpers/ingest.mjs';

let P;
let C;
let D;
let F;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  D = await src('src/ingest/dedupe.mjs');
  F = await src('src/store/facts.mjs');
});

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

const confirmError = (code) => (err) => {
  assert.ok(err instanceof C.ConfirmError, `ConfirmError, got ${err && err.name}`);
  assert.equal(err.code, code);
  return true;
};
const pending = (db) => C.pendingItems(db);
const itemOf = (db, kind) => pending(db).find((i) => i.kind === kind);

describe('account questions', () => {
  test('a new account queues owner and kind questions with the frozen options', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(await offEngine()));
    const acct = one(s.db, 'SELECT * FROM accounts');
    const owner = itemOf(s.db, 'account_owner');
    assert.equal(owner.subject, acct.id);
    assert.equal(owner.status, 'pending');
    assert.equal(owner.fileId, r.fileId);
    assert.equal(typeof owner.question, 'string');
    assert.ok(owner.question.length > 0);
    assert.equal(typeof owner.createdAt, 'string');
    assert.deepEqual(owner.options, [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'joint', label: 'Joint' }, { id: 'business', label: 'Business' }]);
    const kind = itemOf(s.db, 'account_kind');
    assert.equal(kind.subject, acct.id);
    assert.deepEqual(kind.options.map((o) => o.id), ['checking', 'cash', 'card', 'taxable', 'retirement', 'roth', 'hsa', '529', 'business', 'loan']);
    assert.ok(!JSON.stringify(pending(s.db)).includes('EXAMPLE SHOP'), 'questions carry no transaction text');
  }));

  test('answers set the owner label and the kind; bad option, unknown id and a second answer are refused', () => withStore(async (s) => {
    await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(await offEngine()));
    const owner = itemOf(s.db, 'account_owner');
    const kind = itemOf(s.db, 'account_kind');
    assert.throws(() => C.answer(s.db, owner.id, 'nobody', { now: NOW }), confirmError('bad_option'));
    assert.throws(() => C.answer(s.db, 999999, 'owner', { now: NOW }), confirmError('not_found'));
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, null, 'refusals change nothing');

    const done = C.answer(s.db, owner.id, 'spouse', { now: NOW });
    assert.equal(done.status, 'answered');
    assert.equal(done.answer, 'spouse');
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, 'Your spouse');
    assert.throws(() => C.answer(s.db, owner.id, 'owner', { now: NOW }), confirmError('answered'));
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, 'Your spouse');

    C.answer(s.db, kind.id, 'checking', { now: NOW });
    assert.equal(one(s.db, 'SELECT kind FROM accounts').kind, 'checking');
    assert.equal(pending(s.db).length, 0);
    assert.equal(C.listItems(s.db, { status: 'answered' }).length, 2);
    assert.equal(one(s.db, 'SELECT answered_at FROM confirm_items WHERE id = ?', owner.id).answered_at, NOW);
  }));

  test('remembered: an overlapping export touching an answered account asks nothing new', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
    const owner = itemOf(s.db, 'account_owner');
    C.answer(s.db, owner.id, 'owner', { now: NOW });
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, 'You');
    const r = await P.ingestFile(s.db, fixture('Chase7766_Activity_20320305.csv', 'text/csv'), s.opts(off));
    assert.equal(r.status, 'imported');
    assert.equal(r.counts.queued, 0);
    assert.equal(items(s.db, 'account_owner').length, 1, 'no new owner item');
    assert.equal(pending(s.db).length, 0);
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, 'You');
  }));

  test('ask: existing pending, new subject queued, answered subject remembered and applied', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(await offEngine()));
    const acct = one(s.db, 'SELECT * FROM accounts');
    const owner = itemOf(s.db, 'account_owner');
    const options = owner.options;
    const q = { kind: 'account_owner', subject: acct.id, question: 'Whose account is this?', options, context: {}, fileId: r.fileId };
    assert.deepEqual(C.ask(s.db, q), { existing: true });
    C.answer(s.db, owner.id, 'joint', { now: NOW });
    s.db.prepare('UPDATE accounts SET owner = NULL').run();
    assert.deepEqual(C.ask(s.db, q), { remembered: true });
    assert.equal(one(s.db, 'SELECT owner FROM accounts').owner, 'Joint', 'the stored answer is applied again');
    const fresh = C.ask(s.db, { ...q, kind: 'account_kind', options: [{ id: 'checking', label: 'Checking' }] });
    assert.equal(fresh.queued, true);
    assert.equal(typeof fresh.id, 'number');
  }));
});

describe('entity alias', () => {
  test('an expense-only entity named differently from the income entity queues an alias question', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, northwindFile(), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    const alias = items(s.db, 'entity_alias');
    assert.equal(alias.length, 1);
    const opts = JSON.parse(alias[0].options);
    assert.ok(opts.some((o) => o.id === 'entity:Northwind Design' && o.label === 'Northwind Design'));
    assert.ok(opts.some((o) => o.id === 'separate' && o.label === 'A separate entity'));
    assert.ok(!opts.some((o) => o.id === 'entity:Northwind'), 'the alias is not offered as its own target');
  }));

  test('choosing the canonical entity merges alias rows (amounts summed, cells kept) and is remembered', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, northwindFile(), s.opts(off));
    const alias = itemOf(s.db, 'entity_alias');
    C.answer(s.db, alias.id, 'entity:Northwind Design', { now: NOW });

    assert.equal(count(s.db, 'pnl_lines', "entity = 'Northwind'"), 0);
    const lines = all(s.db, "SELECT * FROM pnl_lines WHERE entity = 'Northwind Design' ORDER BY category");
    assert.deepEqual(lines.map((l) => [l.category, l.amount]), [['Income', 1500], ['Software', -125], ['Travel', -200]]);
    const software = lines.find((l) => l.category === 'Software');
    assert.equal(JSON.parse(software.locator).cells.length, 3, 'locator cells of both rows are kept');
    const travel = lines.find((l) => l.category === 'Travel');
    assert.equal(travel.dedupe_key, D.dedupeKey({ kind: 'pnl_line', entity: 'Northwind Design', period: '2032-04', category: 'Travel' }), 'dedupe key recomputed for the canonical entity');
    assert.equal(travel.source_slot, software.source_slot);
    const merged = all(s.db, "SELECT * FROM superseded_rows WHERE reason = 'alias_merged'");
    assert.equal(merged.length, 1);
    assert.deepEqual(all(s.db, 'SELECT entity FROM entity_aliases').map((a) => a.entity), ['Northwind Design']);

    const again = await P.ingestFile(s.db, northwindFile({ travel: 250 }, 'northwind-pnl-v2.xlsx'), s.opts(off));
    assert.equal(again.status, 'imported');
    assert.equal(items(s.db, 'entity_alias').length, 1, 'no new alias question');
    assert.equal(pending(s.db).length, 0);
    assert.equal(again.counts.revised, 1);
    assert.equal(count(s.db, 'pnl_lines', "entity = 'Northwind'"), 0, 'new rows land under the canonical entity');
    assert.deepEqual(all(s.db, "SELECT category, amount FROM pnl_lines WHERE entity = 'Northwind Design' ORDER BY category").map((l) => [l.category, l.amount]),
      [['Income', 1500], ['Software', -125], ['Travel', -250]]);
  }));

  test('choosing a separate entity keeps the rows apart and records no alias', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, northwindFile(), s.opts(off));
    C.answer(s.db, itemOf(s.db, 'entity_alias').id, 'separate', { now: NOW });
    assert.equal(count(s.db, 'entity_aliases'), 0);
    assert.deepEqual(all(s.db, "SELECT category, amount FROM pnl_lines WHERE entity = 'Northwind' ORDER BY category").map((l) => [l.category, l.amount]), [['Software', -100], ['Travel', -200]]);
    await P.ingestFile(s.db, northwindFile({ travel: 250 }, 'northwind-pnl-v2.xlsx'), s.opts(off));
    assert.equal(items(s.db, 'entity_alias').length, 1, 'the separate answer is remembered');
    assert.equal(one(s.db, "SELECT amount FROM pnl_lines WHERE entity = 'Northwind' AND category = 'Travel'").amount, -250);
  }));
});

describe('tax year', () => {
  // R4 slots are per year, jurisdiction and payer; questions may be per slot, so the test groups
  // them by the sheet year in the subject.
  const yearOf = (q) => (/(?:^|:)(203[12])(?::|$)/.exec(q.subject) || [])[1];

  test('payment year shifts January to the prior tax year, tax year keeps it, and both are remembered', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, fixture('tax-payments.xlsx'), s.opts(off));
    const qs = items(s.db, 'tax_year');
    const q2032 = qs.filter((q) => yearOf(q) === '2032');
    const q2031 = qs.filter((q) => yearOf(q) === '2031');
    assert.ok(q2032.length >= 1 && q2031.length >= 1);
    assert.equal(q2032.length + q2031.length, qs.length);
    for (const q of q2032) {
      assert.deepEqual(JSON.parse(q.options), [{ id: 'tax_year', label: 'Tax year 2032' }, { id: 'payment_year', label: 'Paid during 2032; January counts toward 2031' }]);
    }

    for (const q of q2032) C.answer(s.db, q.id, 'payment_year', { now: NOW });
    const rows2032 = all(s.db, "SELECT * FROM tax_payments WHERE date LIKE '2032-%'");
    assert.equal(rows2032.length, 8);
    assert.ok(rows2032.every((t) => t.tax_year_basis === 'confirmed_payment_year'));
    assert.deepEqual(rows2032.filter((t) => t.date === '2032-01-31').map((t) => t.tax_year), [2031, 2031, 2031, 2031]);
    assert.ok(rows2032.filter((t) => t.date !== '2032-01-31').every((t) => t.tax_year === 2032));
    const rows2031 = all(s.db, "SELECT * FROM tax_payments WHERE date LIKE '2031-%'");
    assert.ok(rows2031.every((t) => t.tax_year_basis === 'sheet_label' && t.tax_year === 2031), 'the other year is untouched');

    for (const q of q2031) C.answer(s.db, q.id, 'tax_year', { now: NOW });
    assert.ok(all(s.db, "SELECT * FROM tax_payments WHERE date LIKE '2031-%'").every((t) => t.tax_year_basis === 'confirmed_tax_year' && t.tax_year === 2031));

    const revised = await P.ingestFile(s.db, fixture('tax-payments-revised.xlsx'), s.opts(off));
    assert.equal(revised.counts.revised, 1);
    assert.equal(items(s.db, 'tax_year').length, qs.length, 'no new tax-year questions');
    assert.equal(pending(s.db).length, 0);
    const after = all(s.db, "SELECT * FROM tax_payments WHERE date LIKE '2032-%'");
    assert.ok(after.every((t) => t.tax_year_basis === 'confirmed_payment_year'), 'the remembered answer applies to revised rows');
    assert.equal(after.find((t) => t.jurisdiction === 'federal' && t.payer === 'Owner' && t.date === '2032-02-29').amount, 250);
    assert.equal(after.filter((t) => t.tax_year === 2031).length, 4);
  }));
});

// R5: fact checks are keyed by assertion: <sourceId>|<key>|<canonical JSON value>.
describe('fact check', () => {
  const notes = (facts) => ({ facts, goals: [] });
  const NOTES_A = notes([
    { key: 'household.dependents', value: '2', confidence: 0.5 },
    { key: 'household.state', value: 'CO', confidence: 0.6 },
  ]);
  const NOTES_B = notes([
    { key: 'household.dependents', value: '2', confidence: 0.5 },
    { key: 'household.state', value: 'NM', confidence: 0.6 },
  ]);
  const laterNotes = () => textFile('notes-later.md', '# Household goals\n\nSynthetic follow-up note with the same content.\n', 'text/markdown');
  const sourceOf = (db, fileId) => one(db, 'SELECT source_id FROM files WHERE id = ?', fileId).source_id;
  const bySubject = (db, end) => C.listItems(db, { status: 'all' }).find((i) => i.kind === 'fact_check' && i.subject.endsWith(end));

  test('subjects name source, key and value; yes confirms the fact, no removes it', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('notes.md'), s.opts(await fakeEngine([[NOTES_A]])));
    const sid = sourceOf(s.db, r.fileId);
    assert.deepEqual(items(s.db, 'fact_check').map((c) => c.subject).sort(), [`${sid}|household.dependents|2`, `${sid}|household.state|"CO"`]);
    const dep = bySubject(s.db, '|household.dependents|2');
    const st = bySubject(s.db, '|household.state|"CO"');
    assert.deepEqual(dep.options, [{ id: 'yes', label: 'Yes, that is right' }, { id: 'no', label: 'No, ignore it' }]);

    C.answer(s.db, dep.id, 'yes', { now: NOW });
    assert.equal(one(s.db, "SELECT confirmed FROM facts WHERE key = 'household.dependents'").confirmed, 1);
    assert.equal(F.getFacts(s.db)['household.dependents'], 2);
    C.answer(s.db, st.id, 'no', { now: NOW });
    assert.equal(one(s.db, "SELECT * FROM facts WHERE key = 'household.state'"), undefined);
  }));

  test('answers are remembered: equivalent content in other bytes asks nothing and keeps a rejected fact out', () => withStore(async (s) => {
    const a = await P.ingestFile(s.db, fixture('notes.md'), s.opts(await fakeEngine([[NOTES_A]])));
    C.answer(s.db, bySubject(s.db, '|household.state|"CO"').id, 'no', { now: NOW });
    C.answer(s.db, bySubject(s.db, '|household.dependents|2').id, 'yes', { now: NOW });
    const b = await P.ingestFile(s.db, laterNotes(), s.opts(await fakeEngine([[NOTES_A]])));
    assert.equal(b.status, 'imported');
    assert.notEqual(b.fileId, a.fileId);
    assert.equal(sourceOf(s.db, b.fileId), sourceOf(s.db, a.fileId), 'same logical source');
    assert.equal(items(s.db, 'fact_check').length, 2, 'no new fact checks');
    assert.equal(pending(s.db).length, 0);
    assert.ok(!('household.state' in F.getFacts(s.db)), 'the rejected fact stays absent');
    assert.equal(one(s.db, "SELECT confirmed FROM facts WHERE key = 'household.dependents'").confirmed, 1);
  }));

  test('a newer import with another value closes the older question as superseded; answering it is stale', () => withStore(async (s) => {
    await P.ingestFile(s.db, fixture('notes.md'), s.opts(await fakeEngine([[NOTES_A]])));
    const older = bySubject(s.db, '|household.state|"CO"');
    await P.ingestFile(s.db, laterNotes(), s.opts(await fakeEngine([[NOTES_B]])));
    assert.equal(F.getFacts(s.db)['household.state'], 'NM');
    const closed = bySubject(s.db, '|household.state|"CO"');
    assert.equal(closed.answer, 'superseded');
    assert.ok(!pending(s.db).some((i) => i.id === older.id));
    assert.ok(pending(s.db).some((i) => i.subject.endsWith('|household.state|"NM"')), 'the newer value is asked about');
    assert.equal(items(s.db, 'fact_check').filter((i) => i.subject.includes('household.dependents')).length, 1, 'unchanged value asks nothing new');
    assert.throws(() => C.answer(s.db, older.id, 'yes', { now: NOW }), confirmError('stale'));
    assert.equal(F.getFacts(s.db)['household.state'], 'NM', 'the newer fact is kept');
  }));

  test('a pending question whose value differs from a confirmed fact is stale; a current one is answerable', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('notes.md'), s.opts(await fakeEngine([[NOTES_A]])));
    F.upsertFact(s.db, { key: 'household.state', value: 'NM', src: 'you', asOf: '2032-03-10', confirmed: true });
    const st = bySubject(s.db, '|household.state|"CO"');
    assert.equal(st.status, 'pending');
    assert.throws(() => C.answer(s.db, st.id, 'yes', { now: NOW }), confirmError('stale'));
    assert.equal(F.getFacts(s.db)['household.state'], 'NM');
    const dep = C.answer(s.db, bySubject(s.db, '|household.dependents|2').id, 'yes', { now: NOW });
    assert.equal(dep.status, 'answered');
    assert.ok(r.fileId);
  }));

  test('upsertFact never overwrites a confirmed fact; deleteFact removes only that file\'s unconfirmed fact', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(await offEngine()));
    assert.deepEqual(F.upsertFact(s.db, { key: 'household.state', value: 'CO', src: 'you', asOf: '2032-03-01', confirmed: true }), { written: true, changed: true });
    assert.deepEqual(F.upsertFact(s.db, { key: 'household.state', value: 'NM', src: 'extract', asOf: '2032-03-02', provenance: { fileId: r.fileId } }), { written: false, reason: 'confirmed' });
    assert.equal(F.getFacts(s.db)['household.state'], 'CO');
    assert.deepEqual(F.upsertFact(s.db, { key: 'household.dependents', value: 1, src: 'extract', asOf: '2032-03-02', provenance: { fileId: r.fileId } }), { written: true, changed: true });
    // MGI4 (plan R6-4): an identical write is a no-op.
    assert.deepEqual(F.upsertFact(s.db, { key: 'household.dependents', value: 1, src: 'extract', asOf: '2032-03-02', provenance: { fileId: r.fileId } }), { written: false, changed: false, reason: 'unchanged' });
    F.deleteFact(s.db, 'household.dependents', { fileId: 'f-ffffffffffffffffffffffff' });
    assert.equal(F.getFacts(s.db)['household.dependents'], 1, 'another file cannot delete it');
    F.deleteFact(s.db, 'household.state', { fileId: r.fileId });
    assert.equal(F.getFacts(s.db)['household.state'], 'CO', 'confirmed facts are never deleted this way');
    F.deleteFact(s.db, 'household.dependents', { fileId: r.fileId });
    assert.ok(!('household.dependents' in F.getFacts(s.db)));
  }));

  test('HTTP: a stale answer is 409 through the real router', () => withStore(async (s) => {
    await P.ingestFile(s.db, fixture('notes.md'), s.opts(await fakeEngine([[NOTES_A]])));
    F.upsertFact(s.db, { key: 'household.state', value: 'NM', src: 'you', asOf: '2032-03-10', confirmed: true });
    const st = bySubject(s.db, '|household.state|"CO"');
    const { createHandler } = await src('src/api/router.mjs');
    const server = http.createServer(createHandler({ db: s.db, config: s.config, engine: await offEngine() }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const stale = await postJson(base, `/api/confirm/${st.id}/answer`, { answer: 'yes' });
      assert.equal(stale.status, 409, stale.text.slice(0, 300));
      assert.equal(typeof stale.json.error, 'string');
      const ok = await postJson(base, `/api/confirm/${bySubject(s.db, '|household.dependents|2').id}/answer`, { answer: 'yes' });
      assert.equal(ok.status, 200, ok.text.slice(0, 300));
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
    assert.equal(F.getFacts(s.db)['household.state'], 'NM');
  }));
});

describe('near duplicate', () => {
  const near = { date: '2032-03-10', amount: '54.21', description: 'SYNTH GROCERY' };
  const nearLater = { date: '2032-03-12', amount: '54.21', description: 'SYNTH GROCERY STORE 0042' };

  test('same amount within 3 days from another file queues a question; same keeps one and skips it later', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, aggregatorFile('near-a.csv', [near]), s.opts(off));
    const b = await P.ingestFile(s.db, aggregatorFile('near-b.csv', [nearLater]), s.opts(off));
    assert.equal((b.counts.rows || {}).transaction, 1, 'inserted, then asked about');
    const tx = all(s.db, 'SELECT * FROM transactions ORDER BY id');
    assert.equal(tx.length, 2);
    const q = items(s.db, 'near_duplicate');
    assert.equal(q.length, 1);
    assert.equal(q[0].subject, tx.map((t) => t.dedupe_key).sort().join('|'));
    assert.deepEqual(JSON.parse(q[0].options), [{ id: 'same', label: 'Same transaction, keep one' }, { id: 'different', label: 'Different, keep both' }]);

    C.answer(s.db, q[0].id, 'same', { now: NOW });
    const left = all(s.db, 'SELECT * FROM transactions');
    assert.deepEqual(left.map((t) => t.date), ['2032-03-10'], 'the newer row is removed');
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE reason = 'duplicate_confirmed'");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].dedupe_key, tx[1].dedupe_key);

    const c = await P.ingestFile(s.db, aggregatorFile('near-c.csv', [nearLater, { date: '2032-03-20', amount: '9.99', description: 'SYNTH OTHER' }]), s.opts(off));
    assert.equal(c.counts.duplicates, 1, 'the confirmed duplicate is skipped and counted');
    assert.equal((c.counts.rows || {}).transaction, 1);
    assert.equal(count(s.db, 'transactions'), 2);
    assert.equal(items(s.db, 'near_duplicate').length, 1, 'no new near-duplicate question');
  }));

  test('different keeps both rows', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, aggregatorFile('near-a.csv', [near]), s.opts(off));
    await P.ingestFile(s.db, aggregatorFile('near-b.csv', [nearLater]), s.opts(off));
    C.answer(s.db, itemOf(s.db, 'near_duplicate').id, 'different', { now: NOW });
    assert.equal(count(s.db, 'transactions'), 2);
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));

  // D3: a same-day, same-amount row from another file of one bank format with a different
  // description is stored under an alt key and asked about; the answer and a re-import behave.
  const collide = (name, description, extra = []) => activityFile(name, [{ date: '03/09/2032', amount: '-54.21', balance: '', description }, ...extra]);
  const unrelated = { date: '03/20/2032', amount: '-9.99', balance: '', description: 'SYNTH OTHER' };

  test('a description collision answered same archives the newer row; a re-import of it asks nothing new', () => withStore(async (s) => {
    const off = await offEngine();
    const a = await P.ingestFile(s.db, collide('Chase4321_Activity_A.csv', 'SYNTH GROCERY NORTH'), s.opts(off));
    await P.ingestFile(s.db, collide('Chase4321_Activity_B.csv', 'SYNTH PHARMACY SOUTH'), s.opts(off));
    assert.equal(count(s.db, 'transactions'), 2);
    const q = itemOf(s.db, 'near_duplicate');
    assert.ok(q, 'the collision is asked about');
    C.answer(s.db, q.id, 'same', { now: NOW });
    const left = all(s.db, 'SELECT * FROM transactions');
    assert.deepEqual(left.map((t) => [t.description, t.file_id]), [['SYNTH GROCERY NORTH', a.fileId]], 'the newer row is archived');
    assert.equal(count(s.db, 'superseded_rows', "reason = 'duplicate_confirmed'"), 1);

    const again = await P.ingestFile(s.db, collide('Chase4321_Activity_C.csv', 'SYNTH PHARMACY SOUTH', [unrelated]), s.opts(off));
    assert.equal(again.counts.duplicates, 1);
    assert.equal((again.counts.rows || {}).transaction, 1, 'only the unrelated row lands');
    assert.equal(count(s.db, 'transactions'), 2);
    assert.equal(items(s.db, 'near_duplicate').length, 1, 'no new question');
  }));

  test('a description collision answered different keeps both; a re-import of it is a duplicate with no new question', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, collide('Chase4321_Activity_A.csv', 'SYNTH GROCERY NORTH'), s.opts(off));
    await P.ingestFile(s.db, collide('Chase4321_Activity_B.csv', 'SYNTH PHARMACY SOUTH'), s.opts(off));
    C.answer(s.db, itemOf(s.db, 'near_duplicate').id, 'different', { now: NOW });
    assert.equal(count(s.db, 'transactions'), 2);
    const again = await P.ingestFile(s.db, collide('Chase4321_Activity_C.csv', 'SYNTH PHARMACY SOUTH', [unrelated]), s.opts(off));
    assert.equal(again.counts.duplicates, 1);
    assert.equal(count(s.db, 'transactions'), 3);
    assert.equal(items(s.db, 'near_duplicate').length, 1, 'no new question');
    assert.equal(count(s.db, 'superseded_rows'), 0);
  }));

  test('rows more than 3 days apart or from the same file are not near duplicates', () => withStore(async (s) => {
    const off = await offEngine();
    await P.ingestFile(s.db, aggregatorFile('far-a.csv', [near, { ...nearLater, date: '2032-03-11' }]), s.opts(off));
    await P.ingestFile(s.db, aggregatorFile('far-b.csv', [{ ...near, date: '2032-03-20' }]), s.opts(off));
    assert.equal(items(s.db, 'near_duplicate').length, 0);
  }));
});

describe('confirm over HTTP', () => {
  const T = { timeout: SERVER_TIMEOUT };
  let s;
  let ownerItem;
  before(async () => {
    s = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake' } });
    const fd = new FormData();
    fd.append('files', new Blob([readFileSync(fixturePath('aggregator.csv'))], { type: 'text/csv' }), 'aggregator.csv');
    const res = await fetch(`${s.baseUrl}/api/files`, { method: 'POST', body: fd });
    assert.equal(res.status, 200, await res.clone().text());
  }, T);
  after(async () => {
    if (!s) return;
    await s.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
  });

  test('GET /api/confirm lists the pending owner question', async () => {
    const r = await request(s.baseUrl, { path: '/api/confirm' });
    assert.equal(r.status, 200);
    ownerItem = r.json.items.find((i) => i.kind === 'account_owner');
    assert.ok(ownerItem, 'an owner question is pending');
    assert.equal(ownerItem.status, 'pending');
    assert.deepEqual(ownerItem.options.map((o) => o.id), ['owner', 'spouse', 'joint', 'business']);
  });

  test('POST /api/confirm/list filters by status', async () => {
    const p = await postJson(s.baseUrl, '/api/confirm/list', { status: 'pending' });
    assert.equal(p.status, 200);
    assert.ok(p.json.items.some((i) => i.id === ownerItem.id));
    const a = await postJson(s.baseUrl, '/api/confirm/list', { status: 'answered' });
    assert.ok(!a.json.items.some((i) => i.id === ownerItem.id));
    const every = await postJson(s.baseUrl, '/api/confirm/list', { status: 'all' });
    assert.ok(every.json.items.some((i) => i.id === ownerItem.id));
  });

  test('POST /api/confirm/:id/answer: 400 bad option, 404 unknown, 403 cross-origin, 200 then 409', async () => {
    const path = `/api/confirm/${ownerItem.id}/answer`;
    const bad = await postJson(s.baseUrl, path, { answer: 'nobody' });
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.json.error, 'string');
    assert.equal((await postJson(s.baseUrl, '/api/confirm/999999/answer', { answer: 'owner' })).status, 404);
    assert.equal((await postJson(s.baseUrl, '/api/confirm/not-a-number/answer', { answer: 'owner' })).status, 404);
    assert.equal((await postJson(s.baseUrl, path, { answer: 'owner' }, { origin: 'http://evil.example' })).status, 403);

    const ok = await postJson(s.baseUrl, path, { answer: 'owner' });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.json.item.status, 'answered');
    assert.equal(ok.json.item.answer, 'owner');
    const acct = ok.json.scenario.accounts.find((a) => a.id === ownerItem.subject);
    assert.equal(acct.owner, 'You');
    assert.ok(!ok.json.scenario.live.ingest.items.some((i) => i.id === ownerItem.id), 'no longer pending');

    const twice = await postJson(s.baseUrl, path, { answer: 'owner' });
    assert.equal(twice.status, 409);
    const answered = await postJson(s.baseUrl, '/api/confirm/list', { status: 'answered' });
    assert.ok(answered.json.items.some((i) => i.id === ownerItem.id));
  });
});
