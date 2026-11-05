// AC7: every ingest source has a cadence, a freshness state at the scenario clock and generic
// export instructions; stale sources add a note to their domain; accounts carry their last data
// date and freshness. The fixtures are dated 2032, so the clock decides fresh or stale.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src, tempDb } from '../helpers/server.mjs';
import { fixture, aggregatorFile, realStore, offEngine, fakeEngine, one, NOW } from '../helpers/ingest.mjs';

let FR;
let H;
let P;
let B;
let C;
before(async () => {
  FR = await src('src/ingest/freshness.mjs');
  H = await src('src/ingest/howto.mjs');
  P = await src('src/ingest/pipeline.mjs');
  B = await src('src/scenario/build.mjs');
  C = await src('src/ingest/confirm.mjs');
});

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

// aggregator.csv (last data 2032-03-01) and positions.csv (as of 2032-03-05) in a real store.
async function seeded(s) {
  const off = await offEngine();
  await P.ingestFile(s.db, fixture('aggregator.csv', 'text/csv'), s.opts(off));
  await P.ingestFile(s.db, fixture('positions.csv', 'text/csv'), s.opts(off));
  const cash = one(s.db, "SELECT * FROM accounts WHERE mask = '7766'");
  const invest = one(s.db, "SELECT * FROM accounts WHERE mask = '5544'");
  return { cash, invest };
}

describe('cadence and domains', () => {
  test('CADENCE by source kind', () => {
    const monthly = { label: 'monthly', staleAfterDays: 45 };
    for (const k of ['bank_csv', 'card_csv', 'aggregator_csv', 'balances', 'brokerage_positions', 'statement', 'pnl_workbook']) {
      assert.deepEqual(FR.CADENCE[k], monthly, k);
    }
    assert.deepEqual(FR.CADENCE.paystub, { label: 'per pay period', staleAfterDays: 35 });
    assert.deepEqual(FR.CADENCE.tax_payments, { label: 'quarterly', staleAfterDays: 100 });
    assert.deepEqual(FR.CADENCE.tax_doc, { label: 'annual', staleAfterDays: 400 });
    assert.equal(FR.CADENCE.notes, null);
    assert.equal(FR.CADENCE.other, null);
  });

  test('DOMAIN_OF by source kind', () => {
    for (const k of ['bank_csv', 'card_csv', 'aggregator_csv', 'balances']) assert.equal(FR.DOMAIN_OF[k], 'cash', k);
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
  test('keeps the latest as_of and always updates last_ingest_at', () => withStore(async (s) => {
    const id = 'ing:test-source:all';
    FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-03-01', now: '2032-03-02T00:00:00.000Z' });
    let row = one(s.db, 'SELECT * FROM sources WHERE id = ?', id);
    assert.deepEqual([row.as_of, row.kind, row.label, row.last_ingest_at], ['2032-03-01', 'bank_csv', 'Synthetic source', '2032-03-02T00:00:00.000Z']);
    FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-02-01', now: '2032-03-05T00:00:00.000Z' });
    row = one(s.db, 'SELECT * FROM sources WHERE id = ?', id);
    assert.equal(row.as_of, '2032-03-01', 'an older export does not move as_of back');
    assert.equal(row.last_ingest_at, '2032-03-05T00:00:00.000Z');
    FR.recordSource(s.db, { id, label: 'Synthetic source', kind: 'bank_csv', asOf: '2032-04-01', now: '2032-04-02T00:00:00.000Z' });
    assert.equal(one(s.db, 'SELECT as_of FROM sources WHERE id = ?', id).as_of, '2032-04-01');
  }));
});

describe('ingest state and scenario', () => {
  test('ingestState lists ingest sources with cadence, state, how-to and per-account freshness', () => withStore(async (s) => {
    const { cash, invest } = await seeded(s);
    const st = FR.ingestState(s.db, { clock: '2032-03-10' });
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
    assert.equal(st.pending, C.pendingItems(s.db).length);
    assert.equal(st.items.length, st.pending);
    assert.equal(st.pending, 3, 'two owner questions and one kind question');
    assert.equal(st.files.length, 2);
    assert.equal(st.formats.length, 7);
  }));

  test('buildScenario at a fresh clock: live.ingest, account asOf/fresh/sourceId, no domain notes', () => withStore(async (s) => {
    const { cash } = await seeded(s);
    const sc = B.buildScenario(s.db, { clock: '2032-03-10' });
    assert.ok(sc.live.ingest, 'live.ingest present');
    assert.ok(sc.live.ingest.sources.every((x) => x.state === 'fresh'));
    const a = sc.accounts.find((x) => x.id === cash.id);
    assert.equal(a.asOf, '2032-03-01');
    assert.equal(a.fresh, 'fresh');
    assert.equal(a.sourceId, `ing:aggregator:${cash.id}`);
    assert.equal(a.mirror, 'manual');
    assert.deepEqual(sc.domains, [], 'a real store with no domains gains none while sources are fresh');
  }));

  test('buildScenario at a stale clock: stale sources and accounts, cash and invest domains created with notes', () => withStore(async (s) => {
    const { cash, invest } = await seeded(s);
    const sc = B.buildScenario(s.db, { clock: '2032-06-30' });
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
      seedDemo(store.db);
      const sc = B.buildScenario(store.db);
      assert.ok(sc.accounts.length > 0);
      for (const a of sc.accounts) {
        assert.equal(a.asOf, '');
        assert.equal(a.fresh, 'unknown');
        assert.equal(a.sourceId, null);
      }
      assert.deepEqual(sc.live.ingest.sources, []);
      assert.equal(sc.live.ingest.pending, 0);
      assert.deepEqual(sc.domains, B.loadContent(store.db).domains, 'demo domains unchanged');
    } finally {
      store.close();
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
  const pdf = (tag) => ({ name: `statement-${tag}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% synthetic statement ${tag}\n%%EOF\n`), mime: 'application/pdf' });
  const engineFor = (periodEnd, bal) => fakeEngine([[{ docType: 'statement', confidence: 0.9 }], [statement(periodEnd, bal)]]);
  const STALE_NOTE = /Export a fresh copy\./;

  test('a stale statement source becomes fresh after a newer statement import', () => withStore(async (s) => {
    const first = await P.ingestFile(s.db, pdf('march'), s.opts(await engineFor('2032-03-31', 1500.25)));
    assert.equal(first.status, 'imported');
    const acct = one(s.db, "SELECT * FROM accounts WHERE mask = '4321'");

    let sc = B.buildScenario(s.db, { clock: '2032-06-30' });
    let src = sc.live.ingest.sources.filter((x) => x.kind === 'statement');
    assert.equal(src.length, 1);
    assert.equal(src[0].asOf, '2032-03-31');
    assert.equal(src[0].state, 'stale');
    assert.equal(src[0].ageDays, 91);
    assert.equal(sc.accounts.find((a) => a.id === acct.id).fresh, 'stale');
    const invest = sc.domains.find((d) => d.id === 'invest');
    assert.ok(invest, 'stale statement adds the invest domain');
    assert.match(invest.note, / data is 91 days old\. Export a fresh copy\./);

    const second = await P.ingestFile(s.db, pdf('june'), s.opts(await engineFor('2032-06-15', 1600.5)));
    assert.equal(second.status, 'imported');
    sc = B.buildScenario(s.db, { clock: '2032-06-30' });
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
  const seedCashDomain = (db) => db.prepare('INSERT INTO content (key, value, src, updated_at) VALUES (?, ?, ?, ?)')
    .run('domains', JSON.stringify([{ id: 'cash', name: 'Cash and reserves', status: 'covered', watching: '', note: 'Base note.' }]), 'test', NOW);
  const accountA = { account: 'Synthetic reserve', number: '5550003333' };
  const accountB = { account: 'Synthetic daily', number: '5550004444' };

  test('A (last row in January) is stale, B (June) is fresh, and the cash note names A', () => withStore(async (s) => {
    seedCashDomain(s.db);
    const r = await P.ingestFile(s.db, aggregatorFile('household-export.csv', [
      { ...accountA, date: '2032-01-05', amount: '15.00', description: 'Synthetic reserve fee' },
      { ...accountA, date: '2032-01-20', amount: '25.00', description: 'Synthetic reserve transfer' },
      { ...accountB, date: '2032-06-02', amount: '35.00', description: 'Synthetic grocery' },
      { ...accountB, date: '2032-06-10', amount: '45.00', description: 'Synthetic utility' },
    ]), s.opts(await offEngine()));
    assert.equal(r.status, 'imported');
    const sc = B.buildScenario(s.db, { clock: '2032-06-30' });
    const a = sc.accounts.find((x) => x.name === accountA.account);
    const b = sc.accounts.find((x) => x.name === accountB.account);
    assert.deepEqual([a.asOf, a.fresh], ['2032-01-20', 'stale']);
    assert.deepEqual([b.asOf, b.fresh], ['2032-06-10', 'fresh']);
    const cash = sc.domains.find((d) => d.id === 'cash');
    assert.equal(cash.status, 'waiting');
    assert.ok(cash.note.startsWith('Base note.'));
    assert.ok(cash.note.includes(accountA.account), `note names the stale account: ${cash.note}`);
    assert.match(cash.note, /162 days old/);
    assert.ok(!cash.note.includes(accountB.account), 'the fresh account is not called stale');
  }));

  test('counter-case: when every account in the export is fresh, no note is added', () => withStore(async (s) => {
    seedCashDomain(s.db);
    await P.ingestFile(s.db, aggregatorFile('household-export-june.csv', [
      { ...accountA, date: '2032-06-05', amount: '15.00', description: 'Synthetic reserve fee' },
      { ...accountB, date: '2032-06-10', amount: '45.00', description: 'Synthetic utility' },
    ]), s.opts(await offEngine()));
    const sc = B.buildScenario(s.db, { clock: '2032-06-30' });
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
  test('an old needs_mapping file stays in waiting after 50+ newer files; retryFile still works', () => withStore(async (s) => {
    const off = await offEngine();
    const odd = await P.ingestFile(s.db, { name: 'odd.csv', bytes: new TextEncoder().encode('Zeta,Omega,Sigma\nq,w,e\nr,t,y\n'), mime: 'text/csv' }, s.opts(off));
    assert.equal(odd.status, 'needs_mapping');
    for (let i = 0; i < 55; i++) {
      const csv = `month,account_alias,ending_balance\n2032-02,acct${i},${1000 + i}.25\n`;
      const r = await P.ingestFile(s.db, { name: `bal-${i}.csv`, bytes: new TextEncoder().encode(csv), mime: 'text/csv' }, s.opts(off));
      assert.equal(r.status, 'imported', `file ${i}`);
    }
    const st = FR.ingestState(s.db, { clock: '2032-03-10' });
    assert.ok(!st.files.some((f) => f.id === odd.fileId), 'older than the files limit');
    assert.ok(Array.isArray(st.waiting), 'waiting array present');
    const w = st.waiting.find((f) => f.id === odd.fileId);
    assert.ok(w, 'the waiting file is listed');
    assert.deepEqual(Object.keys(w).sort(), ['counts', 'id', 'name', 'parser', 'sourceKind', 'status', 'uploadedAt']);
    assert.equal(w.name, 'odd.csv');
    assert.equal(w.status, 'needs_mapping');
    assert.ok(st.waiting.every((f) => ['needs_mapping', 'needs_extraction'].includes(f.status)));
    const sc = B.buildScenario(s.db, { clock: '2032-03-10' });
    assert.ok(sc.live.ingest.waiting.some((f) => f.id === odd.fileId), 'scenario carries the waiting file');
    const again = await P.retryFile(s.db, odd.fileId, s.opts(off));
    assert.equal(again.status, 'needs_mapping');
    assert.ok(FR.ingestState(s.db, { clock: '2032-03-10' }).waiting.some((f) => f.id === odd.fileId));
  }));
});
