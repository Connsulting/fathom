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
import { REASON_TEXT } from '../src/ingest/guess.mjs';
import { ask, canonicalJson, OWNER_OPTIONS, KIND_OPTIONS, FACT_CHECK_OPTIONS, taxYearOptions } from '../src/ingest/confirm.mjs';

export const SEED_ID = 'demo-seed';

// Calendar-driven opening dates for upcoming decisions. Decisions not listed open on a
// dependency (opens_on null) and stay upcoming until their rec or the owner moves them.
export const OPENS_ON = Object.freeze({ salary27: '2027-01-01' });

// Demo pack row id to the repo pack manifest it stands for (stored as def.manifest). The other
// demo packs (contractor, abroad, rental) have no manifest. A tagged row also keeps its demo name
// as a label, so the pack refresh rewrites it in place under its demo id. Keep in step with
// migrations 005 (manifest) and 006 (label).
export const PACK_MANIFEST = Object.freeze({
  scorp: 's-corp-owner',
  selfemp: 'self-employed-partnership',
  w2: 'w2-benefits',
  virginia: 'virginia-resident',
  kids: 'kids-dependents',
  retire: 'advanced-retirement',
  giving: 'charitable-giving',
});

// Content rows: narrative sections with no data table yet.
const CONTENT_KEYS = ['names', 'law', 'pct', 'series', 'verdict', 'domains', 'curve', 'wargame', 'ask', 'advisor', 'connect', 'onboarding', 'email'];

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
  'income.agiEstimate': 380000,
};

// Children before parents so foreign keys hold while clearing.
const CLEAR_ORDER = [
  'advisor_reviews', 'advisor_checkin', 'advisor_packets', 'messages', 'conversations', 'rec_events', 'job_runs', 'jobs', 'superseded_rows', 'confirm_undo', 'confirm_guesses', 'confirm_items',
  'ingest_epoch', 'held_facts',
  'column_mappings', 'entity_aliases', 'transactions', 'balances', 'positions',
  'pnl_lines', 'tax_payments', 'documents', 'figures', 'accounts', 'facts', 'sources', 'recs', 'goals',
  'deadlines', 'events', 'packs_state', 'decisions', 'api_keys', 'spend_ledger', 'content', 'settings', 'files',
];

// Synthetic pending confirm questions so the demo shows the confirm deck: one per kind below, on
// demo rows, from the seed file. The fact key is one FACTS does not hold; the tax year has no
// workbook rows, so answering it changes no payment. One stored guess, on the owner question.
const CONFIRM_FACT = { key: 'retirement.planOffersRoth', value: true };
const CONFIRM_TAX_YEAR = 2025;
const CONFIRM_GUESS = { option: 'owner', reason: REASON_TEXT.institution };

function seedConfirm(db, { clock, now }) {
  const base = { fileId: SEED_ID, now };
  const owner = ask(db, { ...base, kind: 'account_owner', subject: 'a_tod', question: 'Whose account is the Individual brokerage account?', options: OWNER_OPTIONS, context: {} });
  ask(db, { ...base, kind: 'account_kind', subject: 'a_jdirect', question: 'What kind of account is the Direct-index account?', options: KIND_OPTIONS, context: {} });
  const { key, value } = CONFIRM_FACT;
  const json = canonicalJson(value);
  ask(db, {
    ...base, kind: 'fact_check', subject: `${SEED_ID}|${key}|${json}`, question: `An import says ${key} is ${json}. Is that right?`, options: FACT_CHECK_OPTIONS,
    context: { key, value, src: SEED_ID, asOf: clock, fileId: SEED_ID, parser: SEED_ID, locator: `confirm:${key}`, confidence: 0.5 },
  });
  const year = CONFIRM_TAX_YEAR;
  ask(db, {
    ...base, kind: 'tax_year', subject: `tax:${year}`, question: `Does the ${year} sheet list payments for tax year ${year}, or payments made during ${year}?`,
    options: taxYearOptions(year), context: { sheetYear: year },
  });
  db.prepare("INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts) VALUES (?, ?, ?, 'demo', ?)")
    .run(owner.id, CONFIRM_GUESS.option, CONFIRM_GUESS.reason, now);
}

// Synthetic year-end documents for the demo tax year, stored through the documents table like an
// import. Paystubs name the employers (so W-2s are expected); the 1098 matches the mortgage the
// ledger pays; the property tax receipt matches nothing expected. Demo files have no stored bytes:
// the packet renders each as a short synthetic text file.
function seedYearendDocs(db, S, { year, now }) {
  const file = db.prepare(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note, parser)
                           VALUES (?, ?, 'application/pdf', 0, NULL, 'tax_doc', ?, NULL, 'parsed', 'Synthetic demo document', ?)`);
  const doc = db.prepare('INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?)');
  const docs = [
    { type: 'paystub', fields: { employerName: S.names.w2, payDate: `${year}-10-31` }, file: SEED_ID },
    { type: 'paystub', fields: { employerName: S.names.biz, payDate: `${year}-10-31` }, file: SEED_ID },
    { type: '1098', fields: { issuer: S.names.bank, note: 'Mortgage paid off this year' }, file: 'demo-doc-1098', name: `1098-${year}-mortgage-payoff.pdf`, at: `${year}-10-14T12:00:00.000Z` },
    { type: 'other', fields: { issuer: 'County treasurer', note: 'Property tax receipt' }, file: 'demo-doc-proptax', name: `property-tax-receipt-${year}.pdf`, at: `${year}-10-02T12:00:00.000Z` },
  ];
  docs.forEach((d, i) => {
    if (d.file !== SEED_ID) file.run(d.file, d.name, d.at, SEED_ID);
    doc.run(d.type, year, JSON.stringify(d.fields), d.file, SEED_ID, `yearendDocs[${i}]`);
  });
}

// The advisor workflow tables from the scenario: each rec's advisor field (pending, confirmed or
// vetoed), the reviewed items outside the plan, and the next check-in. Dates are synthetic and
// relative to the demo clock.
export const DEMO_CHECKIN = Object.freeze({ date: '2026-12-10', time: '14:00', lengthMin: 30 });

function seedAdvisor(db, S, clock) {
  const ins = db.prepare(`INSERT INTO advisor_reviews (rec_id, title, sent_at, verdict, note, reviewed_on, recorded_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let i = 0;
  for (const r of S.recs) {
    const a = r.advisor;
    if (!a || !a.verdict) continue;
    i += 1;
    const sent = `${addDays(clock, -(14 + 3 * i))}T09:00:00.000Z`;
    if (a.verdict === 'pending') {
      ins.run(r.id, r.title, sent, null, '', null, null);
    } else {
      const on = addDays(clock, -(7 + i));
      ins.run(r.id, r.title, sent, a.verdict, a.note || '', on, `${on}T17:00:00.000Z`);
    }
  }
  for (const v of S.advisor.reviewed || []) {
    if (v.recId) continue;
    i += 1;
    const on = addDays(clock, -(7 + i));
    ins.run(null, v.title, `${addDays(clock, -(14 + 3 * i))}T09:00:00.000Z`, v.verdict, v.note || '', on, `${on}T17:00:00.000Z`);
  }
  db.prepare('INSERT INTO advisor_checkin (id, date, time, length_min, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run(DEMO_CHECKIN.date, DEMO_CHECKIN.time, DEMO_CHECKIN.lengthMin, `${clock}T08:00:00.000Z`);
}

// Fields held in recs columns, not in the def (owner and goalKinds are recs.owner and recs.goal_kinds).
const LIVE_REC_FIELDS = ['status', 'statusByDemo', 'window', 'waitingOn', 'owner', 'goalKinds'];

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
    for (const k of CONTENT_KEYS) {
      if (S[k] === undefined) continue;
      // The advisor's review state lives in the advisor tables (seedAdvisor); content keeps the narrative.
      const v = k === 'advisor' ? (({ next, reviewed, pending, ...rest }) => rest)(S[k]) : S[k];
      content.run(k, JSON.stringify(v), SEED_ID, now);
    }
    content.run('engine.chat', JSON.stringify(S.engine.chat), SEED_ID, now);

    const source = db.prepare('INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, s] of Object.entries(S.src)) source.run(id, s.label, s.asOf || '', 'demo', now, '');
    const builtin = (id, asOf) => { if (!S.src[id]) source.run(id, BUILTIN_SOURCES[id].label, asOf, BUILTIN_SOURCES[id].kind, now, ''); };
    builtin('wargame-model', (S.src.model && S.src.model.asOf) || '');
    builtin('job-estimates', '');

    const figure = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [key, f] of Object.entries(S.fig)) {
      const locator = f.asOf ? JSON.stringify({ path: `fig.${key}`, asOf: f.asOf, cadenceKind: f.cadenceKind }) : `fig.${key}`;
      figure.run(key, cents(f.v), f.src, f.kind, f.label || '', ...prov(locator), now);
    }

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

    const rec = db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator,
                              owner, goal_kinds)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    S.recs.forEach((r, i) => {
      const def = { ...r, tasks: (r.tasks || []).map(({ done, ...t }) => t) };
      for (const k of LIVE_REC_FIELDS) delete def[k];
      delete def.advisor;
      const status = (r.statusByDemo && r.statusByDemo.november) || r.status;
      const days = r.window && typeof r.window.days === 'number' ? r.window.days : null;
      const pack = S.packs.find(p => (p.recIds || []).includes(r.id));
      rec.run(r.id, JSON.stringify(def), status, r.waitingOn || null, r.wake || null,
        JSON.stringify((r.tasks || []).map(t => !!t.done)), days == null ? null : addDays(clock, days),
        r.window ? r.window.label : null, pack ? pack.id : null, i, now, ...prov(`recs[${i}]`), r.owner, JSON.stringify(r.goalKinds));
    });

    const goal = db.prepare('INSERT INTO goals (id, def, sort) VALUES (?, ?, ?)');
    S.goals.forEach((g, i) => goal.run(g.id, JSON.stringify(g), i));
    const deadline = db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, ?, ?)');
    for (const d of S.deadlines) deadline.run(d.date, d.label, d.title, d.recId || null, d.hard ? 1 : 0);
    const event = db.prepare('INSERT INTO events (date, kind, title, body, sort) VALUES (?, ?, ?, ?, ?)');
    S.events.forEach((e, i) => event.run(e.date, e.kind, e.title, e.body, i));
    const packState = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                                  VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
    S.packs.forEach((p, i) => {
      const def = Object.hasOwn(PACK_MANIFEST, p.id) ? { ...p, manifest: PACK_MANIFEST[p.id], label: p.name } : p;
      packState.run(p.id, JSON.stringify(def), i, now);
    });
    const decision = db.prepare(`INSERT INTO decisions (id, title, status, wargame, rec_id, opens_on, when_label, note, decided_line, sort)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
    S.decisions.forEach((d, i) => decision.run(d.id, d.title, d.status, d.wargame || null, d.recId || null, OPENS_ON[d.id] || null, d.when || '', d.note || '', i));

    const job = db.prepare('INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
    S.engine.jobs.forEach((j, i) => job.run(j.id, j.name, j.cadence, j.does, j.cost, j.next, j.last, i));

    seedConfirm(db, { clock, now });
    seedYearendDocs(db, S, { year: Number(clock.slice(0, 4)), now });
    seedAdvisor(db, S, clock);

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
