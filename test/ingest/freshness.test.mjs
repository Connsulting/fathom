import { seedHistoricalDocument } from '../helpers/historical-import.mjs';
// AC7: every ingest source has a cadence, a freshness state at the scenario clock and generic
// export instructions; stale sources add a note to their domain; accounts carry their last data
// date and freshness. The fixtures are dated 2032, so the clock decides fresh or stale.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src, tempDb } from '../helpers/server.mjs';
import { imagePdf } from '../helpers/pdf.mjs';
import { fixture, aggregatorFile, realStore, offEngine, fakeEngine, one, NOW } from '../helpers/ingest.mjs';

let FR;
let H;
let P;
let B;
let C;
let SF;
before(async () => {
  FR = await src('src/ingest/freshness.mjs');
  H = await src('src/ingest/howto.mjs');
  P = await src('src/ingest/pipeline.mjs');
  B = await src('src/scenario/build.mjs');
  C = await src('src/ingest/confirm.mjs');
  SF = await src('src/ingest/simplefin.mjs');
});

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}

// aggregator.csv (last data 2032-03-01) and positions.csv (as of 2032-03-05) in a real store.
async function seeded(s) {
  const off = await offEngine();
  await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
  await P.ingestFile(s.db, fixture('positions.csv', 'text/csv'), s.opts(off));
  const cash = await one(s.db, "SELECT * FROM accounts WHERE mask = '7766'");
  const invest = await one(s.db, "SELECT * FROM accounts WHERE mask = '5544'");
  return { cash, invest };
}

describe('cadence and domains', () => {
  test('CADENCE by source kind', () => {
    const monthly = { label: 'monthly', staleAfterDays: 45 };
    for (const k of ['bank_csv', 'card_csv', 'aggregator_csv', 'balances', 'brokerage_positions', 'statement', 'pnl_workbook', 'simplefin']) {
      assert.deepEqual(FR.CADENCE[k], monthly, k);
    }
    assert.deepEqual(FR.CADENCE.paystub, { label: 'per pay period', staleAfterDays: 35 });
    assert.deepEqual(FR.CADENCE.tax_payments, { label: 'quarterly', staleAfterDays: 100 });
    assert.deepEqual(FR.CADENCE.tax_doc, { label: 'annual', staleAfterDays: 400 });
    assert.equal(FR.CADENCE.notes, null);
    assert.equal(FR.CADENCE.other, null);
  });

  test('DOMAIN_OF by source kind', () => {
    for (const k of ['bank_csv', 'card_csv', 'aggregator_csv', 'balances', 'simplefin']) assert.equal(FR.DOMAIN_OF[k], 'cash', k);
    for (const k of ['brokerage_positions', 'statement']) assert.equal(FR.DOMAIN_OF[k], 'invest', k);
    assert.equal(FR.DOMAIN_OF.pnl_workbook, 'entities');
    assert.equal(FR.DOMAIN_OF.tax_payments, 'tax');
    assert.equal(FR.DOMAIN_OF.tax_doc, 'tax');
    assert.equal(FR.DOMAIN_OF.paystub, 'payroll');
  });
});

describe('freshnessOf', () => {
  test('fresh inside the cadence window, stale after it', () => {
    const fresh = FR.freshnessOf({ kind: 'bank_csv', asOf: '2032-03-01' }, '2032-03-10');
    assert.equal(fresh.state, 'fresh');
    assert.equal(fresh.ageDays, 9);
    assert.deepEqual(fresh.cadence, { label: 'monthly', staleAfterDays: 45 });
    const stale = FR.freshnessOf({ kind: 'bank_csv', asOf: '2032-03-01' }, '2032-06-30');
    assert.equal(stale.state, 'stale');
    assert.equal(stale.ageDays, 121);
    assert.equal(FR.freshnessOf({ kind: 'tax_payments', asOf: '2032-03-31' }, '2032-06-30').state, 'fresh', 'quarterly allows 100 days');
    assert.equal(FR.freshnessOf({ kind: 'paystub', asOf: '2032-03-15' }, '2032-04-30').state, 'stale', 'per pay period allows 35 days');
  });

  test('unknown without a cadence or an ISO date; a future date is fresh', () => {
    assert.equal(FR.freshnessOf({ kind: 'notes', asOf: '2032-03-01' }, '2033-03-01').state, 'unknown');
    assert.equal(FR.freshnessOf({ kind: 'bank_csv', asOf: '' }, '2032-03-10').state, 'unknown');
    assert.equal(FR.freshnessOf({ kind: 'bank_csv', asOf: 'March 2032' }, '2032-03-10').state, 'unknown');
    assert.equal(FR.freshnessOf({ kind: 'bank_csv', asOf: '2032-03-20' }, '2032-03-10').state, 'fresh');
  });
});

describe('recordSource', () => {
  test('keeps the latest as_of and always updates last_ingest_at', async () => withStore(async (s) => {
    const id = 'ing:test-source:all';
    await FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-03-01', now: '2032-03-02T00:00:00.000Z' });
    let row = await one(s.db, 'SELECT * FROM sources WHERE id = ?', id);
    assert.deepEqual([row.as_of, row.kind, row.label, row.last_ingest_at], ['2032-03-01', 'bank_csv', 'Synthetic source', '2032-03-02T00:00:00.000Z']);
    await FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-02-01', now: '2032-03-05T00:00:00.000Z' });
    row = await one(s.db, 'SELECT * FROM sources WHERE id = ?', id);
    assert.equal(row.as_of, '2032-03-01', 'an older export does not move as_of back');
    assert.equal(row.last_ingest_at, '2032-03-05T00:00:00.000Z');
    await FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-04-01', now: '2032-04-02T00:00:00.000Z' });
    assert.equal((await one(s.db, 'SELECT as_of FROM sources WHERE id = ?', id)).as_of, '2032-04-01');
  }));
});

describe('ingest state and scenario', () => {
  test('ingestState lists ingest sources with cadence, state, how-to and per-account freshness', async () => withStore(async (s) => {
    const { cash, invest } = await seeded(s);
    const st = (await FR.ingestState(s.db, { clock: '2032-03-10' }));
    assert.equal(st.sources.length, 2);
    const agg = st.sources.find((x) => x.kind === 'aggregator_csv');
    const pos = st.sources.find((x) => x.kind === 'brokerage_positions');
    assert.equal(agg.id, `ing:aggregator:${cash.id}`);
    assert.equal(agg.asOf, '2032-03-01');
    assert.equal(agg.lastIngestAt, NOW);
    assert.equal(agg.cadence, 'monthly');
    assert.equal(agg.state, 'fresh');
    assert.equal(agg.ageDays, 9);
    assert.equal(agg.howTo.title, H.howToFor('aggregator_csv').title);
    assert.equal(typeof agg.label, 'string');
    assert.ok(agg.label.length > 0);
    assert.equal(pos.asOf, '2032-03-05');
    assert.equal(pos.state, 'fresh');
    assert.equal(pos.howTo.title, H.howToFor('brokerage_positions').title);
    assert.deepEqual(st.accounts[cash.id], { asOf: '2032-03-01', fresh: 'fresh', sourceId: agg.id });
    assert.deepEqual(st.accounts[invest.id], { asOf: '2032-03-05', fresh: 'fresh', sourceId: pos.id });
    assert.deepEqual(st.staleNotes, []);
    assert.equal(st.pending, (await C.pendingItems(s.db)).length);
    assert.equal(st.items.length, st.pending);
    assert.equal(st.pending, 3, 'two owner questions and one kind question');
    assert.equal(st.files.length, 2);
    assert.equal(st.formats.length, 7);
  }));

  test('buildScenario at a fresh clock: live.ingest, account asOf/fresh/sourceId, no domain notes', async () => withStore(async (s) => {
    const { cash } = await seeded(s);
    const sc = (await B.buildScenario(s.db, { clock: '2032-03-10' }));
    assert.ok(sc.live.ingest, 'live.ingest present');
    assert.ok(sc.live.ingest.sources.every((x) => x.state === 'fresh'));
    const a = sc.accounts.find((x) => x.id === cash.id);
    assert.equal(a.asOf, '2032-03-01');
    assert.equal(a.fresh, 'fresh');
    assert.equal(a.sourceId, `ing:aggregator:${cash.id}`);
    assert.equal(a.mirror, 'manual');
    assert.deepEqual(sc.domains, [], 'a real store with no domains gains none while sources are fresh');
  }));

  test('buildScenario at a stale clock: stale sources and accounts, cash and invest domains created with notes', async () => withStore(async (s) => {
    const { cash, invest } = await seeded(s);
    const sc = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    const agg = sc.live.ingest.sources.find((x) => x.kind === 'aggregator_csv');
    assert.equal(agg.state, 'stale');
    assert.equal(agg.ageDays, 121);
    assert.equal(agg.cadence, 'monthly');
    assert.ok(Array.isArray(agg.howTo.steps) && agg.howTo.steps.length >= 3);
    assert.equal(sc.accounts.find((x) => x.id === cash.id).fresh, 'stale');
    assert.equal(sc.accounts.find((x) => x.id === invest.id).fresh, 'stale');
    const cashDomain = sc.domains.find((d) => d.id === 'cash');
    assert.ok(cashDomain, 'cash domain created');
    assert.equal(cashDomain.status, 'waiting');
    assert.equal(cashDomain.watching, '');
    assert.equal(typeof cashDomain.name, 'string');
    assert.ok(cashDomain.name.length > 0);
    assert.match(cashDomain.note, / data is 121 days old\. Export a fresh copy\./);
    const investDomain = sc.domains.find((d) => d.id === 'invest');
    assert.match(investDomain.note, / data is 117 days old\. Export a fresh copy\./);
    assert.ok(sc.live.ingest.staleNotes.some((n) => n.domain === 'cash'));
  }));

  test('demo accounts carry empty freshness and demo sources are not ingest sources', async () => {
    const { seedDemo } = await src('demo/seed.mjs');
    const store = await tempDb();
    try {
      await seedDemo(store.db);
      const sc = (await B.buildScenario(store.db));
      assert.ok(sc.accounts.length > 0);
      for (const a of sc.accounts) {
        assert.equal(a.asOf, '');
        assert.equal(a.fresh, 'unknown');
        assert.equal(a.sourceId, null);
      }
      assert.deepEqual(sc.live.ingest.sources, []);
      const seededPending = (await store.db.prepare("SELECT count(*) AS n FROM confirm_items WHERE status = 'pending'").get()).n;
      assert.equal(sc.live.ingest.pending, seededPending);
      assert.ok(seededPending > 0, 'the demo seeds pending confirm items');
      assert.deepEqual(sc.domains, (await B.loadContent(store.db)).domains, 'demo domains unchanged');
    } finally {
      await store.close();
    }
  });
});

// R8: an extracted statement is a 'statement' source dated by its periodEnd. A newer statement
// for the same account turns a stale source fresh and clears the domain note.
describe('stale to fresh', () => {
  const statement = (periodEnd, endingBalance) => ({
    institution: 'Example Bank', accountLast4: '4321', accountKind: 'brokerage', periodEnd, endingBalance,
    holdings: [{ symbol: 'EXMPL', name: 'Example Index Fund', quantity: 10, value: 1234.5 }], confidence: 0.9,
  });
  const pdf = (tag) => ({ name: `statement-${tag}.pdf`, bytes: imagePdf({ tag: `synthetic statement ${tag}` }), mime: 'application/pdf' });
  const engineFor = (periodEnd, bal) => fakeEngine([[{ docType: 'statement', confidence: 0.9 }], [statement(periodEnd, bal)]]);
  const STALE_NOTE = /Export a fresh copy\./;

  test('a stale statement source becomes fresh after a newer statement import', async () => withStore(async (s) => {
    const first = await seedHistoricalDocument(s,pdf('march'), (await engineFor('2032-03-31',1500.25)).responses);
    assert.equal(first.status, 'imported');
    const acct = await one(s.db, "SELECT * FROM accounts WHERE mask = '4321'");

    let sc = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    let src = sc.live.ingest.sources.filter((x) => x.kind === 'statement');
    assert.equal(src.length, 1);
    assert.equal(src[0].asOf, '2032-03-31');
    assert.equal(src[0].state, 'stale');
    assert.equal(src[0].ageDays, 91);
    assert.equal(sc.accounts.find((a) => a.id === acct.id).fresh, 'stale');
    const invest = sc.domains.find((d) => d.id === 'invest');
    assert.ok(invest, 'stale statement adds the invest domain');
    assert.match(invest.note, / data is 91 days old\. Export a fresh copy\./);

    const second = await seedHistoricalDocument(s,pdf('june'), (await engineFor('2032-06-15',1600.5)).responses);
    assert.equal(second.status, 'imported');
    sc = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    src = sc.live.ingest.sources.filter((x) => x.kind === 'statement');
    assert.equal(src.length, 1, 'one statement source for the account');
    assert.equal(src[0].asOf, '2032-06-15');
    assert.equal(src[0].state, 'fresh');
    const a = sc.accounts.find((x) => x.id === acct.id);
    assert.equal(a.fresh, 'fresh');
    assert.equal(a.asOf, '2032-06-15');
    assert.ok(!sc.domains.some((d) => STALE_NOTE.test(d.note || '')), 'the stale note is gone');
    assert.deepEqual(sc.live.ingest.staleNotes, []);
  }));
});

// Review finding F4: freshness is per account. One multi-account export whose newest row is
// fresh must still put a stale account in front of the owner.
describe('stale account inside a fresh multi-account export', () => {
  const seedCashDomain = async (db) => await db.prepare('INSERT INTO content (key, value, src, updated_at) VALUES (?, ?, ?, ?)')
    .run('domains', JSON.stringify([{ id: 'cash', name: 'Cash and reserves', status: 'covered', watching: '', note: 'Base note.' }]), 'test', NOW);
  const accountA = { account: 'Synthetic reserve', number: '5550003333' };
  const accountB = { account: 'Synthetic daily', number: '5550004444' };

  test('A (last row in January) is stale, B (June) is fresh, and the cash note names A', async () => withStore(async (s) => {
    await seedCashDomain(s.db);
    const r = await P.ingestFile(s.db, aggregatorFile('household-export.csv', [
      { ...accountA, date: '2032-01-05', amount: '15.00', description: 'Synthetic reserve fee' },
      { ...accountA, date: '2032-01-20', amount: '25.00', description: 'Synthetic reserve transfer' },
      { ...accountB, date: '2032-06-02', amount: '35.00', description: 'Synthetic grocery' },
      { ...accountB, date: '2032-06-10', amount: '45.00', description: 'Synthetic utility' },
    ]), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    const sc = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    const a = sc.accounts.find((x) => x.sourceName === accountA.account);
    const b = sc.accounts.find((x) => x.sourceName === accountB.account);
    assert.deepEqual([a.asOf, a.fresh], ['2032-01-20', 'stale']);
    assert.deepEqual([b.asOf, b.fresh], ['2032-06-10', 'fresh']);
    const cash = sc.domains.find((d) => d.id === 'cash');
    assert.equal(cash.status, 'waiting');
    assert.ok(cash.note.startsWith('Base note.'));
    assert.ok(cash.note.includes(accountA.account), `note names the stale account: ${cash.note}`);
    assert.match(cash.note, /162 days old/);
    assert.ok(!cash.note.includes(accountB.account), 'the fresh account is not called stale');
  }));

  test('counter-case: when every account in the export is fresh, no note is added', async () => withStore(async (s) => {
    await seedCashDomain(s.db);
    await P.ingestFile(s.db, aggregatorFile('household-export-june.csv', [
      { ...accountA, date: '2032-06-05', amount: '15.00', description: 'Synthetic reserve fee' },
      { ...accountB, date: '2032-06-10', amount: '45.00', description: 'Synthetic utility' },
    ]), s.opts(await offEngine()));
    const sc = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    assert.ok(sc.accounts.filter((x) => x.sourceId).every((x) => x.fresh === 'fresh'));
    const cash = sc.domains.find((d) => d.id === 'cash');
    assert.deepEqual([cash.status, cash.note], ['covered', 'Base note.']);
  }));
});

describe('applyFreshness', () => {
  const base = [
    { id: 'cash', name: 'Cash and reserves', status: 'covered', watching: 'Synthetic watch', note: 'Base note.' },
    { id: 'invest', name: 'Investments', status: 'needs', watching: '', note: 'Invest note.' },
  ];

  test('appends escaped notes, moves a covered domain to waiting, adds missing domains, does not mutate', () => {
    const before = structuredClone(base);
    const state = { staleNotes: [
      { domain: 'cash', text: 'Synthetic <bank> {data} is 50 days old. Export a fresh copy.' },
      { domain: 'invest', text: 'Brokerage data is 60 days old. Export a fresh copy.' },
      { domain: 'tax', text: 'Tax data is 120 days old. Export a fresh copy.' },
    ] };
    const out = FR.applyFreshness(base, state);
    assert.deepEqual(base, before, 'input not mutated');
    const cash = out.find((d) => d.id === 'cash');
    assert.equal(cash.status, 'waiting');
    assert.equal(cash.note, 'Base note. Synthetic &lt;bank&gt; &#123;data&#125; is 50 days old. Export a fresh copy.');
    const invest = out.find((d) => d.id === 'invest');
    assert.equal(invest.status, 'needs', 'only covered domains change status');
    assert.equal(invest.note, 'Invest note. Brokerage data is 60 days old. Export a fresh copy.');
    const tax = out.find((d) => d.id === 'tax');
    assert.equal(tax.status, 'waiting');
    assert.equal(tax.watching, '');
    assert.match(tax.note, /Tax data is 120 days old\. Export a fresh copy\./);
  });

  test('no stale notes leaves the domains as they were', () => {
    assert.deepEqual(FR.applyFreshness(base, { staleNotes: [] }), base);
  });
});

describe('how to export', () => {
  const INSTITUTIONS = ['chase', 'fidelity', 'schwab', 'vanguard', 'wells fargo', 'bank of america', 'citi', 'capital one', 'amex',
    'american express', 'monarch', 'mint', 'quicken', 'quickbooks', 'gusto', 'adp', 'paychex', 'etrade', 'e\\*trade', 'robinhood',
    'betterment', 'wealthfront', 'empower', 'turbotax', 'ally', 'discover', 'usaa', 'navy federal', 'td ameritrade', 'merrill'];

  test('one generic entry per format with 3 to 5 steps and a cadence', () => {
    const list = Array.isArray(H.HOWTO) ? H.HOWTO : Object.values(H.HOWTO);
    assert.deepEqual(list.map((h) => h.id).sort(), ['aggregator', 'bank', 'brokerage', 'estimates', 'paystub', 'pnl', 'taxforms']);
    const titles = Object.fromEntries(list.map((h) => [h.id, h.title]));
    assert.deepEqual(titles, {
      aggregator: 'Aggregator transactions export', bank: 'Bank activity CSV', brokerage: 'Brokerage positions CSV',
      pnl: 'Profit and loss workbook', estimates: 'Estimated tax workbook', paystub: 'Paystub PDF', taxforms: 'Tax forms',
    });
    const banned = new RegExp(`\\b(${INSTITUTIONS.join('|')})\\b`, 'i');
    for (const h of list) {
      assert.ok(h.steps.length >= 3 && h.steps.length <= 5, `${h.id} has 3 to 5 steps`);
      assert.ok(h.steps.every((x) => typeof x === 'string' && x.length > 0));
      assert.ok(['monthly', 'per pay period', 'quarterly', 'annual'].includes(h.cadence), `${h.id} cadence`);
      assert.ok(Array.isArray(h.sourceKinds) && h.sourceKinds.length > 0);
      assert.doesNotMatch(JSON.stringify(h), banned, `${h.id} names no institution`);
    }
  });

  test('howToFor maps source kinds to entries', () => {
    assert.equal(H.howToFor('aggregator_csv').id, 'aggregator');
    assert.equal(H.howToFor('bank_csv').id, 'bank');
    assert.equal(H.howToFor('brokerage_positions').id, 'brokerage');
    assert.equal(H.howToFor('pnl_workbook').id, 'pnl');
    assert.equal(H.howToFor('tax_payments').id, 'estimates');
    assert.equal(H.howToFor('paystub').id, 'paystub');
    assert.equal(H.howToFor('no_such_kind'), null);
  });
});

// Review finding F6: the files list is limited, so a waiting file must also be listed in `waiting`.
describe('waiting files', () => {
  test('an old needs_mapping file stays in waiting after 50+ newer files; retryFile still works', async () => withStore(async (s) => {
    const off = await offEngine();
    const odd = await P.ingestFile(s.db, { name: 'odd.csv', bytes: new TextEncoder().encode('Zeta,Omega,Sigma\nq,w,e\nr,t,y\n'), mime: 'text/csv' }, s.opts(off));
    assert.equal(odd.status, 'waiting_for_engine');
    for (let i = 0; i < 55; i++) {
      const r = await P.ingestFile(s.db, aggregatorFile(`export-${i}.csv`, [{ date: '2032-02-20', amount: 1000+i, description: `Synthetic row ${i}`, number: '44441111' }]), s.opts(off));
      assert.equal(r.status, 'imported', `file ${i}`);
    }
    const st = (await FR.ingestState(s.db, { clock: '2032-03-10' }));
    assert.ok(!st.files.some((f) => f.id === odd.fileId), 'older than the files limit');
    assert.ok(Array.isArray(st.waiting), 'waiting array present');
    const w = st.waiting.find((f) => f.id === odd.fileId);
    assert.ok(w, 'the waiting file is listed');
    assert.deepEqual(Object.keys(w).sort(), ['counts', 'id', 'name', 'parser', 'reasonCode', 'sourceKind', 'status', 'uploadedAt']);
    assert.equal(w.name, 'odd.csv');
    assert.equal(w.status, 'waiting_for_engine');
    assert.ok(st.waiting.every((f) => f.status === 'waiting_for_engine'));
    const sc = (await B.buildScenario(s.db, { clock: '2032-03-10' }));
    assert.ok(sc.live.ingest.waiting.some((f) => f.id === odd.fileId), 'scenario carries the waiting file');
    const again = await P.retryFile(s.db, odd.fileId, s.opts(off));
    assert.equal(again.status, 'waiting_for_engine');
    assert.ok((await FR.ingestState(s.db, { clock: '2032-03-10' })).waiting.some((f) => f.id === odd.fileId));
  }));
});

// Newest stored row wins over an older file source. refreshFreshness is the function a merge or
// undo calls when it does not itself rebuild the scenario.
describe('freshness after import, sync and merge', () => {
  test('an import sets data through from the imported rows', async () => withStore(async (s) => {
    await seeded(s);
    const fresh = (await FR.refreshFreshness(s.db, { clock: '2032-03-10' }));
    assert.equal(fresh.dataThrough, '2032-03-05');
    const sc = (await B.buildScenario(s.db, { clock: '2032-03-10' }));
    assert.equal(sc.meta.dataThrough, 'Mar 5, 2032');
    assert.equal(sc.pace.rollup.dataThrough, '2032-03-05');
  }));

  test('a newer balance on a file account stays fresh after the file source date is rolled back, and a sync moves data through', async () => withStore(async (s) => {
    const { cash } = await seeded(s);
    await s.db.prepare('UPDATE sources SET as_of = ? WHERE id = ?').run('2032-01-05', cash.source_id);
    await s.db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(cash.id, '2032-06-01', 10);
    const merged = (await FR.refreshFreshness(s.db, { clock: '2032-06-15' }));
    assert.equal(merged.accounts[cash.id].asOf, '2032-06-01');
    assert.equal(merged.accounts[cash.id].fresh, 'fresh');
    assert.equal(merged.dataThrough, '2032-06-01');

    const day = '2032-06-20';
    const fetch = SF.createFakeSimplefin({ today: () => day });
    const opt = { config: s.config, household: s.household, now: `${day}T12:00:00.000Z`, clock: day, fetch };
    await SF.connectSimplefin(s.db, SF.fakeToken(), opt);
    const sync = await SF.syncSimplefin(s.db, opt);
    assert.equal(sync.status, 'ok');
    const after = (await FR.refreshFreshness(s.db, { clock: day }));
    assert.equal(after.dataThrough, day);
    const connected = await s.db.prepare("SELECT id FROM accounts WHERE mirror = 'connected'").all();
    assert.ok(connected.length > 0);
    for (const a of connected) assert.equal(after.accounts[a.id].fresh, 'fresh', a.id);
    const sc = (await B.buildScenario(s.db, { clock: day }));
    assert.equal(sc.meta.dataThrough, 'Jun 20, 2032');
    assert.equal(sc.pace.rollup.dataThrough, day);
  }));

  test('a later tax payment or P&L month moves Home and Money together', async () => withStore(async (s) => {
    const { cash } = await seeded(s);
    await s.db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(cash.id, '2032-06-01', 10);
    await s.db.prepare(`INSERT INTO content (key, value, src, updated_at) VALUES ('meta', ?, 'test', ?)`)
      .run(JSON.stringify({ product: 'Fathom', household: '', dataThrough: 'Jun 20, 2032' }), NOW);
    await s.db.prepare(`INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind) VALUES ('US', 2032, '2032-06-20', 100, 'estimated')`).run();
    const tax = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    assert.equal(tax.meta.dataThrough, 'Jun 20, 2032');
    assert.equal(tax.pace.rollup.dataThrough, '2032-06-20');
    await s.db.prepare(`INSERT INTO pnl_lines (entity, period, category, amount) VALUES ('Synthetic Co', '2032-06', 'revenue', 50)`).run();
    const pnl = (await B.buildScenario(s.db, { clock: '2032-06-30' }));
    assert.equal(pnl.meta.dataThrough, 'Jun 30, 2032');
    assert.equal(pnl.pace.rollup.dataThrough, '2032-06-30');
  }));
});
