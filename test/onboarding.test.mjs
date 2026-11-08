// Onboarding made real: the Tell us note is saved through the ingest pipeline (encrypted, notes
// parser, fact extraction, Confirm cards for what is ambiguous), and "what we heard" is derived
// from stored facts and accounts with provenance. Synthetic data only; nothing is invented.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { src, tempDb, householdContext } from './helpers/server.mjs';
import { realStore, recordingEngine, fakeEngine, offEngine, all, one, count, textFile } from './helpers/ingest.mjs';

let H;
let O;
let S;
let C;
let B;
before(async () => {
  H = await src('src/onboarding/heard.mjs');
  O = await src('src/api/onboarding-handlers.mjs');
  S = await src('src/store/facts.mjs');
  C = await src('src/ingest/confirm.mjs');
  B = await src('src/scenario/build.mjs');
});

const NOTE = 'We file jointly in Virginia. Two kids, a third on the way. I run a small S corporation.';
const NOTES_OUT = {
  facts: [
    { key: 'household.filingStatus', value: 'mfj', confidence: 0.95 },
    { key: 'household.state', value: 'VA', confidence: 0.95 },
    { key: 'household.dependents', value: '2', confidence: 0.6 },
  ],
  goals: [{ title: 'Build a cash reserve', when: '2033', confidence: 0.9 }],
};

const ctxOf = (s, engine, body, household = s.household) => ({ actorId: 'actor-synthetic', household, db: s.db, config: s.config, engine, scheduler: null, body });

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

describe('Tell us note save path', () => {
  test('a saved note retains encrypted bytes and waits for source-grounded approval before any facts', () => withStore(async s => {
    const engine = await recordingEngine([[NOTES_OUT]]);
    const out = await O.saveNotes(ctxOf(s, engine, { text: NOTE }));
    assert.equal(out.file.status, 'waiting_for_engine');
    assert.equal(out.file.parser, 'model-import');
    const row = one(s.db, 'SELECT * FROM files WHERE id=?', out.file.fileId);
    assert.match(row.name, /^Setup notes \d{4}-\d{2}-\d{2}\.md$/);
    assert.ok(!readFileSync(join(s.root,row.stored_path)).includes(Buffer.from('Virginia')));
    assert.equal(count(s.db,'documents'), 0);
    assert.equal(count(s.db,'facts'), 0);
    assert.equal(engine.extracts.length, 0);
    assert.equal(out.understood.waiting, true);
    assert.deepEqual(out.understood.facts, []);
    assert.equal(out.scenario.live.heard.empty, true);
  }));

  test('engine off: the parser stores the note and it waits; nothing is read and nothing is invented', () => withStore(async (s) => {
    const out = await O.saveNotes(ctxOf(s, await offEngine(), { text: NOTE }));
    assert.equal(out.file.status, 'waiting_for_engine');
    assert.equal(count(s.db, 'documents', "doc_type = 'notes'"), 0);
    assert.equal(count(s.db, 'facts'), 0);
    assert.deepEqual(out.understood, { fileId: out.file.fileId, status: 'waiting_for_engine', engineOn: false, waiting: true, facts: [], goals: [], asked: 0 });
    assert.equal(out.scenario.live.heard.empty, true);
  }));

  test('the same note twice is a duplicate, not a second import', () => withStore(async (s) => {
    const engine = await fakeEngine([[NOTES_OUT]]);
    const first = await O.saveNotes(ctxOf(s, engine, { text: NOTE }));
    const again = await O.saveNotes(ctxOf(s, engine, { text: `  ${NOTE}\r\n` }));
    // H1: a repeat of a note still waiting answers the stored status with duplicateOf, not 'duplicate'.
    assert.equal(first.file.status, 'waiting_for_engine');
    assert.equal(again.file.status, first.file.status);
    assert.equal(again.file.duplicateOf, first.file.fileId);
    assert.equal(again.file.fileId, first.file.fileId);
    assert.equal(again.understood.status, first.file.status);
    assert.equal(count(s.db, 'files'), 1);
  }));

  test('a second, different note adds to the first (Setup for a returning owner)', () => withStore(async (s) => {
    const engine = await fakeEngine([[NOTES_OUT], [{ facts: [{ key: 'income.sCorp', value: 'true', confidence: 0.95 }], goals: [] }]]);
    await O.saveNotes(ctxOf(s, engine, { text: NOTE }));
    const more = await O.saveNotes(ctxOf(s, engine, { text: 'I also take a salary from my S corporation.' }));
    assert.equal(count(s.db, 'files'), 2);
    assert.deepEqual(more.understood.facts, []);
    assert.equal(more.understood.waiting, true);
    assert.equal(count(s.db,'facts'), 0);
  }));

  test('bad input is refused with a fixed message and nothing is stored', () => withStore(async (s) => {
    const engine = await fakeEngine([]);
    for (const [body, code] of [[{}, 400], [{ text: 5 }, 400], [{ text: '   \n ' }, 400], [{ text: 'bad\u0000note' }, 400], [{ text: 'x'.repeat(O.NOTE_MAX_BYTES + 1) }, 413]]) {
      await assert.rejects(O.saveNotes(ctxOf(s, engine, body)), (err) => {
        assert.equal(err.status, code);
        assert.ok(!String(err.message).includes('bad'), 'the message never echoes the note');
        return true;
      });
    }
    assert.equal(count(s.db, 'files'), 0);
  }));

  // MT-03: the vault key is the instance platform key (FATHOM_PLATFORM_KEY_FILE), not a data key file.
  test('a real household without the platform key refuses before storing anything', async () => {
    const s = await realStore();
    try {
      const { createInstanceSecrets } = await src('src/platform/secrets.mjs');
      const config = { ...s.config, platformKeyFile: null };
      const household = await householdContext({
        db: s.db, platform: s.platform, householdId: s.householdId, config, secrets: createInstanceSecrets({ config, mode: 'real' }),
      });
      const ctx = ctxOf(s, await fakeEngine([]), { text: NOTE }, household);
      await assert.rejects(O.saveNotes(ctx), (err) => err.status === 409 && /FATHOM_PLATFORM_KEY_FILE/.test(err.message));
      assert.equal(count(s.db, 'files'), 0);
      assert.deepEqual(readdirSync(s.root).filter((n) => n === 'files'), []);
    } finally { s.close(); }
  });
});

describe('what we heard (deriveHeard)', () => {
  const NOW = '2026-11-05T12:00:00Z';
  const fact = (db, key, value, extra = {}) => S.upsertFact(db, { key, value, now: NOW, ...extra });
  const file = (db, id, name) => db.prepare("INSERT INTO files (id, name, mime, size, uploaded_at, status) VALUES (?, ?, 'text/plain', 1, ?, 'imported')").run(id, name, NOW);

  async function withDb(fn) {
    const t = await tempDb();
    try { return await fn(t.db); } finally { t.close(); }
  }

  test('an empty store hears nothing: no sections, no invented values', () => withDb((db) => {
    assert.deepEqual(H.deriveHeard(db, { clock: '2026-11-05' }), { sections: [], deadlines: 0, pending: 0, empty: true });
  }));

  test('facts, entities and accounts by kind come out with provenance and an edit target', () => withDb((db) => {
    file(db, 'f-note', 'Setup notes 2026-11-05.md');
    file(db, 'f-pnl', 'books.xlsx');
    fact(db, 'household.filingStatus', 'mfj', { confirmed: true, src: 'you' });
    fact(db, 'household.state', 'va', { provenance: { fileId: 'f-note', parser: 'extract-notes' } });
    fact(db, 'household.dependents', 2, { provenance: { fileId: 'f-note', parser: 'extract-notes' } });
    fact(db, 'household.dependentAges', [2, 5]);
    fact(db, 'income.sCorp', true, { provenance: { fileId: 'f-note', parser: 'extract-notes' } });
    fact(db, 'income.agiEstimate', 380000);
    fact(db, 'household.expectingChild', 'maybe', { provenance: { fileId: 'f-note' } }); // wrong type: skipped
    db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser) VALUES ('Northwind Advisory', '2026-01', 'Income', 100, 'f-pnl', 'pnl-workbook')").run();
    db.prepare("INSERT INTO accounts (id, inst, name, kind, mirror, parser, file_id) VALUES ('a1', 'Example Bank', 'Checking', 'checking', 'manual', 'aggregator', 'f-pnl')").run();
    db.prepare("INSERT INTO accounts (id, inst, name, kind, mirror, parser, file_id) VALUES ('a2', 'Example Bank', 'Reserve', 'checking', 'manual', 'aggregator', 'f-pnl')").run();
    db.prepare("INSERT INTO accounts (id, inst, name, kind, mirror, parser) VALUES ('a3', 'Example Broker', 'Brokerage', 'taxable', 'manual', 'aggregator')").run();
    db.prepare("INSERT INTO deadlines (date, label, title) VALUES ('2026-12-01', 'Dec 1', 'Soon'), ('2026-12-15', 'Dec 15', 'Later'), ('2028-01-01', 'Jan 1', 'Far')").run();

    const h = H.deriveHeard(db, { clock: '2026-11-05' });
    assert.equal(h.empty, false);
    assert.equal(h.deadlines, 2, 'only deadlines inside the next twelve months');
    assert.deepEqual(h.sections.map((sec) => sec.id), ['household', 'income', 'accounts']);
    const item = (sec, id) => h.sections.find((x) => x.id === sec).items.find((i) => i.id === id);

    const filing = item('household', 'fact:household.filingStatus');
    assert.equal(filing.value, 'Married filing jointly');
    assert.equal(filing.prov, 'Entered by you, confirmed by you');
    assert.deepEqual(filing.edit, { route: 'onboarding', step: 3, label: 'Correct in notes' });
    assert.equal(item('household', 'fact:household.state').value, 'VA');
    assert.equal(item('household', 'fact:household.state').prov, 'From Setup notes 2026-11-05.md');
    assert.equal(item('household', 'fact:household.dependentAges').value, '2, 5');
    assert.equal(item('household', 'fact:household.expectingChild'), undefined, 'a wrong-typed value is not shown');
    assert.equal(item('income', 'fact:income.sCorp').value, 'Yes');
    assert.equal(item('income', 'fact:income.agiEstimate').value, '$380,000');
    const entity = item('income', 'entity:Northwind Advisory');
    assert.equal(entity.prov, 'From books.xlsx');
    assert.equal(item('accounts', 'accounts:checking').value, '2');
    assert.equal(item('accounts', 'accounts:checking').prov, 'From books.xlsx');
    assert.deepEqual(item('accounts', 'accounts:checking').edit, { route: 'money', label: 'Edit in Accounts' });
    assert.equal(item('accounts', 'accounts:taxable').prov, 'Stored accounts');
  }));

  test('an open question about a fact makes its edit target the Confirm deck, and the open count is reported', () => withDb((db) => {
    file(db, 'f-note', 'Setup notes.md');
    fact(db, 'household.dependents', 2, { provenance: { fileId: 'f-note', parser: 'extract-notes' } });
    fact(db, 'household.state', 'VA', { provenance: { fileId: 'f-note', parser: 'extract-notes' } });
    C.ask(db, { kind: 'fact_check', subject: 'src|household.dependents|2', question: 'Is it 2?', options: C.FACT_CHECK_OPTIONS, context: { key: 'household.dependents', value: 2 }, fileId: 'f-note', now: NOW });
    const h = H.deriveHeard(db, { clock: '2026-11-05' });
    assert.equal(h.pending, 1);
    const items = h.sections[0].items;
    assert.deepEqual(items.find((i) => i.key === 'household.dependents').edit, { route: 'confirm', label: 'Review in Confirm' });
    assert.equal(items.find((i) => i.key === 'household.dependents').asked, true);
    assert.equal(items.find((i) => i.key === 'household.state').edit.route, 'onboarding');
  }));

  test('file-sourced names are returned as plain strings, never tokens or markup', () => withDb((db) => {
    file(db, 'f-x', '<img src=x onerror=1>{{fig.a}}.md');
    fact(db, 'household.state', 'VA', { provenance: { fileId: 'f-x' } });
    const item = H.deriveHeard(db, { clock: '2026-11-05' }).sections[0].items[0];
    assert.equal(item.prov, 'From <img src=x onerror=1>{{fig.a}}.md', 'escaping is the renderer\'s job; the value is verbatim');
  }));

  test('the scenario carries live.heard for real and demo stores', () => withDb((db) => {
    fact(db, 'household.state', 'VA');
    const sc = B.buildScenario(db);
    assert.equal(sc.live.heard.sections[0].items[0].value, 'VA');
  }));
});

describe('notes use proposals', () => {
  test('an .md file is outside the standard parser registry', async () => {
    const R = await src('src/ingest/registry.mjs');
    const f = textFile('Setup notes 2026-11-05.md', 'hello\n', 'text/markdown');
    assert.equal(R.pickParser(f), null);
  });
});
