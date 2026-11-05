// Demo seed: loads the synthetic scenario (demo/scenario.mjs) into a store at the November state,
// plus a deterministic synthetic ledger (demo/ledger.mjs). Every row it writes carries
// file_id 'demo-seed', parser 'demo-seed' and a locator into the scenario or the ledger.
//
// CLI: `npm run seed:demo` creates or rebuilds $FATHOM_DATA/fathom.sqlite as a demo store. It
// refuses a real store (settings.mode not 'demo', including a store with no mode) and exits 1
// without changing it.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import scenario from './scenario.mjs';
import { buildLedger, isoFromLabel } from './ledger.mjs';
import { openMigrated, getSetting, setSetting, listTables, readStoreMode, createStoreFile, tx, cents, DB_FILE } from '../src/store/db.mjs';
import { addDays, defaultPicks, BUILTIN_SOURCES, DEFAULT_CAP_USD } from '../src/scenario/build.mjs';
import { loadConfig } from '../src/config.mjs';

export const SEED_ID = 'demo-seed';

// Calendar-driven opening dates for upcoming decisions. Decisions not listed open on a
// dependency (opens_on null) and stay upcoming until their rec or the owner moves them.
export const OPENS_ON = Object.freeze({ salary27: '2027-01-01' });

// Content rows: narrative sections with no data table yet.
const CONTENT_KEYS = ['names', 'law', 'pct', 'series', 'verdict', 'domains', 'curve', 'wargame', 'ask', 'advisor', 'yearend', 'connect', 'onboarding', 'email'];

// Synthetic household facts consistent with the demo scenario (frozen fact keys).
const FACTS = {
  'household.state': 'VA',
  'household.filingStatus': 'mfj',
  'household.dependents': 1,
  'household.expectingChild': true,
  'household.dependentAges': [2],
  'income.w2': true,
  'income.sCorp': true,
  'income.selfEmployed': true,
  'income.partnership': true,
  'benefits.hsa': true,
  'benefits.employer401k': true,
  'retirement.solo401k': true,
  'retirement.ira': true,
  'retirement.backdoorRothCandidate': true,
  'accounts.has529': true,
  'giving.charitable': false,
};

// Children before parents so foreign keys hold while clearing.
const CLEAR_ORDER = [
  'messages', 'conversations', 'rec_events', 'job_runs', 'jobs', 'superseded_rows', 'confirm_items', 'held_facts',
  'column_mappings', 'entity_aliases', 'transactions', 'balances', 'positions',
  'pnl_lines', 'tax_payments', 'documents', 'figures', 'accounts', 'facts', 'sources', 'recs', 'goals',
  'deadlines', 'events', 'packs_state', 'decisions', 'api_keys', 'spend_ledger', 'content', 'settings', 'files',
];

const LIVE_REC_FIELDS = ['status', 'statusByDemo', 'window', 'waitingOn'];

function clearStore(db) {
  const tables = listTables(db).filter(t => t !== 'schema_migrations');
  const rest = tables.filter(t => !CLEAR_ORDER.includes(t));
  for (const t of [...rest, ...CLEAR_ORDER.filter(t => tables.includes(t))]) db.prepare(`DELETE FROM "${t}"`).run();
}

// Rebuild the demo content in a migrated store that is empty or already a demo store. A store
// with no mode setting but any rows is treated as real, so this refuses it and changes nothing.
function isEmptyStore(db) {
  return listTables(db).filter(t => t !== 'schema_migrations')
    .every(t => db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get() === undefined);
}

export function seedDemo(db) {
  const mode = getSetting(db, 'mode', null);
  if (mode !== 'demo' && !(mode === null && isEmptyStore(db))) throw new Error('refusing to seed a store that is not empty or a demo store');
  const S = scenario;
  const now = new Date().toISOString();
  const clock = S.meta.clock;
  const through = isoFromLabel(S.meta.dataThrough) || clock;
  const json = JSON.stringify(S);
  const sha = createHash('sha256').update(json).digest('hex');
  const prov = locator => [SEED_ID, SEED_ID, locator];

  tx(db, () => {
    clearStore(db);

    db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
                VALUES (?, 'demo scenario', 'application/json', ?, ?, 'other', ?, NULL, 'parsed', 'Synthetic demo scenario and ledger')`)
      .run(SEED_ID, Buffer.byteLength(json), sha, now);

    const content = db.prepare('INSERT INTO content (key, value, src, updated_at) VALUES (?, ?, ?, ?)');
    content.run('meta', JSON.stringify({ product: S.meta.product, household: S.meta.household, dataThrough: S.meta.dataThrough }), SEED_ID, now);
    for (const k of CONTENT_KEYS) if (S[k] !== undefined) content.run(k, JSON.stringify(S[k]), SEED_ID, now);
    content.run('engine.chat', JSON.stringify(S.engine.chat), SEED_ID, now);

    const source = db.prepare('INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, s] of Object.entries(S.src)) source.run(id, s.label, s.asOf || '', 'demo', now, '');
    const builtin = (id, asOf) => { if (!S.src[id]) source.run(id, BUILTIN_SOURCES[id].label, asOf, BUILTIN_SOURCES[id].kind, now, ''); };
    builtin('wargame-model', (S.src.model && S.src.model.asOf) || '');
    builtin('job-estimates', '');

    const figure = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [key, f] of Object.entries(S.fig)) figure.run(key, cents(f.v), f.src, f.kind, f.label || '', ...prov(`fig.${key}`), now);

    const fact = db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                             VALUES (?, ?, 'you', ?, 1, ?, ?, ?, ?)`);
    for (const [key, value] of Object.entries(FACTS)) fact.run(key, JSON.stringify(value), clock, ...prov(`facts:${key}`), now);

    const ledger = buildLedger({
      accounts: S.accounts,
      fig: S.fig,
      entities: [S.names.biz, S.names.spouseBiz].filter(Boolean),
      year: clock.slice(0, 4),
      through,
    });

    const account = db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator, sort)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    S.accounts.forEach((a, i) => account.run(a.id, a.inst, ledger.masks[a.id], a.name, a.owner, a.kind, a.mirror, a.note || '', a.fig || null, ...prov(`accounts[${i}]`), i));

    const txn = db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator)
                            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`);
    for (const t of ledger.transactions) txn.run(t.accountId, t.date, t.amount, t.description, t.category, t.dedupeKey, ...prov(t.locator));
    const bal = db.prepare('INSERT INTO balances (account_id, date, amount, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?)');
    for (const b of ledger.balances) bal.run(b.accountId, b.date, b.amount, ...prov(b.locator));
    const pos = db.prepare(`INSERT INTO positions (account_id, as_of, symbol, name, quantity, price, value, cost_basis, file_id, parser, locator)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of ledger.positions) pos.run(p.accountId, p.asOf, p.symbol, p.name, p.quantity, p.price, p.value, p.costBasis, ...prov(p.locator));
    const pnl = db.prepare('INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const p of ledger.pnl) pnl.run(p.entity, p.period, p.category, p.amount, ...prov(p.locator));
    const taxp = db.prepare('INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of ledger.taxPayments) taxp.run(p.jurisdiction, p.taxYear, p.date, p.amount, p.kind, ...prov(p.locator));

    const rec = db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const conv = db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)');
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'fathom', ?, '[]', 0, ?)");
    const opened = `${clock}T08:00:00.000Z`;
    S.recs.forEach((r, i) => {
      const def = { ...r, tasks: (r.tasks || []).map(({ done, ...t }) => t) };
      for (const k of LIVE_REC_FIELDS) delete def[k];
      const status = (r.statusByDemo && r.statusByDemo.november) || r.status;
      const days = r.window && typeof r.window.days === 'number' ? r.window.days : null;
      const pack = S.packs.find(p => (p.recIds || []).includes(r.id));
      rec.run(r.id, JSON.stringify(def), status, r.waitingOn || null, r.wake || null,
        JSON.stringify((r.tasks || []).map(t => !!t.done)), days == null ? null : addDays(clock, days),
        r.window ? r.window.label : null, pack ? pack.id : null, i, now, ...prov(`recs[${i}]`));
      conv.run(r.id, opened);
      msg.run(r.id, `<p>${r.summary}</p>`, opened);
    });

    const goal = db.prepare('INSERT INTO goals (id, def, sort) VALUES (?, ?, ?)');
    S.goals.forEach((g, i) => goal.run(g.id, JSON.stringify(g), i));
    const deadline = db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, ?, ?)');
    for (const d of S.deadlines) deadline.run(d.date, d.label, d.title, d.recId || null, d.hard ? 1 : 0);
    const event = db.prepare('INSERT INTO events (date, kind, title, body, sort) VALUES (?, ?, ?, ?, ?)');
    S.events.forEach((e, i) => event.run(e.date, e.kind, e.title, e.body, i));
    const packState = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                                  VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
    S.packs.forEach((p, i) => packState.run(p.id, JSON.stringify(p), i, now));
    const decision = db.prepare(`INSERT INTO decisions (id, title, status, wargame, rec_id, opens_on, when_label, note, decided_line, sort)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
    S.decisions.forEach((d, i) => decision.run(d.id, d.title, d.status, d.wargame || null, d.recId || null, OPENS_ON[d.id] || null, d.when || '', d.note || '', i));

    const job = db.prepare('INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
    S.engine.jobs.forEach((j, i) => job.run(j.id, j.name, j.cadence, j.does, j.cost, j.next, j.last, i));

    // Month-to-date spend that sums to the scenario's engine.budget.used: one run of each job,
    // the rest as chat.
    const month = clock.slice(0, 7);
    const spend = db.prepare("INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, 'demo', '{}')");
    let jobTotal = 0;
    S.engine.jobs.forEach((j, i) => {
      if (typeof j.cost !== 'number') return;
      jobTotal = cents(jobTotal + j.cost);
      spend.run(`${month}-01T0${6 + (i % 4)}:00:00.000Z`, month, 'job', j.cost);
    });
    const chat = cents(S.engine.budget.used - jobTotal);
    if (chat > 0) spend.run(`${clock}T07:30:00.000Z`, month, 'chat', chat);

    setSetting(db, 'mode', 'demo');
    setSetting(db, 'clock', clock);
    setSetting(db, 'onboarding', { done: true, step: 6 });
    setSetting(db, 'engine', { on: true });
    setSetting(db, 'cap', { usd: typeof S.engine.budget.monthly === 'number' ? S.engine.budget.monthly : DEFAULT_CAP_USD });
    setSetting(db, 'wargame.picks', defaultPicks(S.wargame));
    setSetting(db, 'seeded', { at: now, scenario_sha: sha });
  });
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`seed:demo: ${e.message}`);
    process.exit(1);
  }
  const file = join(config.dataDir, DB_FILE);
  const mode = readStoreMode(file);
  if (mode === 'real') {
    console.error(`seed:demo: refusing to touch ${file}: it is a real store (settings.mode is not 'demo'). Point FATHOM_DATA at another directory for the demo.`);
    process.exit(1);
  }
  mkdirSync(config.dataDir, { recursive: true });
  const db = mode === null ? createStoreFile(file, seedDemo) : openMigrated(file);
  try {
    if (mode !== null) seedDemo(db);
  } finally {
    db.close();
  }
  console.log(`seed:demo: demo store ${mode ? 'rebuilt' : 'created'} at ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
