// The brief for a real store: content rows (names, meta, law, pct, verdict, domains, wargame),
// planner deadlines and decisions, and "what changed" events against the previous run's snapshot.
// Every write compares first, so an identical run changes nothing.
//
// writeBrief(db, ctx, {hits, changes}) -> {events: <count written or null>}

import { getSetting, setSetting, parseJson } from '../../store/db.mjs';
import { loadRecs } from '../../scenario/build.mjs';
import { needsYou } from '../../shared/rules.mjs';
import { listParsers } from '../../ingest/registry.mjs';
import { lawContent, pctContent } from './law.mjs';
import { dateLabel, dayLabel, monthEnd, addDays } from './data.mjs';
import { reasonText } from '../triggers/missing-data.mjs';
import { notBuiltReason } from './wargame.mjs';

export const SRC = 'planner';
export const NEUTRAL_NAMES = Object.freeze({
  me: 'You', spouse: 'Your spouse', kid: 'Your child', biz: 'Your business', spouseBiz: "Your spouse's business", household: 'Your household',
});
const DOMAINS = [
  ['tax', 'Tax'], ['retirement', 'Retirement'], ['business', 'Business'], ['cash', 'Cash'], ['family', 'Family'], ['giving', 'Giving'], ['data', 'Your data'],
];
const KIND_BY_TRIGGER = { calendar: 'calendar', income: 'income', life: 'life' };

export function namesOf(facts) {
  const given = facts['household.names'];
  const out = { ...NEUTRAL_NAMES };
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    for (const [k, v] of Object.entries(given)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function upsertContent(db, key, value, now) {
  const text = JSON.stringify(value);
  const row = db.prepare('SELECT value, src FROM content WHERE key = ?').get(key);
  if (row && row.value === text && row.src === SRC) return false;
  db.prepare(`INSERT INTO content (key, value, src, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, updated_at = excluded.updated_at`).run(key, text, SRC, now);
  return true;
}

// Replace this source's rows in a table only when the ordered content differs.
function replaceRows(db, table, cols, rows) {
  const current = db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE src = ? ORDER BY id`).all(SRC).map(r => JSON.stringify(cols.map(c => r[c])));
  const next = rows.map(r => JSON.stringify(cols.map(c => r[c] ?? null)));
  if (current.length === next.length && current.every((x, i) => x === next[i])) return false;
  db.prepare(`DELETE FROM ${table} WHERE src = ?`).run(SRC);
  const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}, src) VALUES (${cols.map(() => '?').join(', ')}, ?)`);
  for (const r of rows) insert.run(...cols.map(c => r[c] ?? null), SRC);
  return true;
}

export function dataThroughOf(freshness) {
  const latest = (freshness || []).map(s => s.latest).filter(Boolean).sort().at(-1);
  return latest ? dateLabel(latest) : '';
}

export function writeBrief(db, ctx, { hits }) {
  const { clock, now, facts, fig } = ctx;
  const names = namesOf(facts);
  upsertContent(db, 'names', names, now);
  upsertContent(db, 'meta', { product: 'Fathom', household: names.household, dataThrough: dataThroughOf(ctx.freshness) }, now);
  upsertContent(db, 'law', lawContent(), now);
  upsertContent(db, 'pct', pctContent(), now);

  // War games: replaced only when this run built a new model (S11). A stored game this run could
  // not rebuild because its inputs are invalid is kept as history and marked unavailable for current
  // decisions, whatever the season (D3, R3-7); a game absent only for the season is kept as is.
  const prev = parseJson((db.prepare('SELECT value FROM content WHERE key = ?').get('wargame') || {}).value, {}) || {};
  const invalid = (ctx.info && ctx.info.wargameInvalid) || {};
  const wargame = { ...prev };
  for (const name of ['salary', 'deferral']) {
    if (ctx.model[name]) wargame[name] = ctx.model[name];
    else if (prev[name] && invalid[name]) wargame[name] = { ...prev[name], unavailable: reasonText(ctx, invalid[name]) };
    else if (prev[name] && 'unavailable' in prev[name]) {
      const { unavailable, ...kept } = prev[name];
      void unavailable;
      wargame[name] = kept;
    }
  }
  // A game with no model and nothing kept records why it was not built, so Decide can say what
  // data would unlock it (recomputed every run).
  delete wargame.notBuilt;
  const notBuilt = {};
  for (const name of ['salary', 'deferral']) if (!wargame[name] && invalid[name]) notBuilt[name] = notBuiltReason(name, invalid[name]);
  if (Object.keys(notBuilt).length) wargame.notBuilt = notBuilt;
  upsertContent(db, 'wargame', wargame, now);

  writeDeadlines(db, ctx, hits);
  writeDecisions(db, ctx, hits, wargame);
  // Domains marked changed follow the current "what changed" events, so an identical rerun
  // (which keeps the events) keeps the same statuses.
  const what = whatChanged(db, ctx);
  const domainsTouched = new Set(what.domains);

  const recs = loadRecs(db, clock);
  const ny = needsYou(recs);
  const first = ny[0];
  upsertContent(db, 'verdict', {
    attention: {
      headline: '{count} things need you before their windows close.',
      sub: first ? `First up: ${first.title}${first.window && first.window.label ? `, ${first.window.label}` : ''}.` : '',
    },
    clear: { headline: 'Nothing needs you right now.', sub: 'Everything on your plan is watched. We will tell you when a window opens.' },
  }, now);

  const hitDomains = new Set(hits.map(h => h.rec.domain));
  const stale = (ctx.freshness || []).filter(s => s.state !== 'current');
  const relevant = {
    retirement: ['benefits.hsa', 'retirement.ira', 'retirement.solo401k', 'retirement.backdoorRothCandidate'].some(k => facts[k] === true),
    business: ['income.sCorp', 'income.selfEmployed', 'income.partnership'].some(k => facts[k] === true),
    family: facts['household.dependents'] > 0 || facts['household.expectingChild'] === true || facts['accounts.has529'] === true,
    giving: facts['giving.charitable'] === true,
  };
  const domains = [];
  for (const [id, name] of DOMAINS) {
    if (!['tax', 'cash', 'data'].includes(id) && !hitDomains.has(id) && !relevant[id]) continue;
    let status = 'covered';
    if (ny.some(r => r.domain === id)) status = 'needs';
    else if (id === 'data' && (stale.length || hits.some(h => h.trigger.id === 'missing-data'))) status = 'waiting';
    else if (domainsTouched.has(id)) status = 'changed';
    domains.push({ id, name, watching: WATCHING[id](ctx), status, note: NOTES[id](ctx, fig, stale) });
  }
  upsertContent(db, 'domains', domains, now);
  return what;
}

const has = (fig, ...keys) => keys.every(k => fig[k]);

const WATCHING = {
  tax: ctx => (ctx.facts['household.state'] === 'VA' ? 'Federal and Virginia estimates, safe harbor and withholding' : 'Federal estimates, safe harbor and withholding'),
  retirement: () => 'Retirement room, HSA and IRA windows',
  business: () => 'Profit, owner salary and invoice timing',
  cash: () => 'Personal and business cash against monthly spending',
  family: () => 'Children, college savings and care costs',
  giving: () => 'Charitable giving and the standard deduction',
  data: () => 'Freshness of every uploaded source',
};

const NOTES = {
  tax: (ctx, fig) => (has(fig, 'tax.fed.paid', 'tax.fed.withheld', 'sh.fed.required') ? 'Paid {f:tax.fed.paid} in estimates and had {f:tax.fed.withheld} withheld, toward {f:sh.fed.required} federal safe harbor.'
    : has(fig, 'tax.fed.paid', 'sh.fed.required') ? 'Paid {f:tax.fed.paid} in estimates toward {f:sh.fed.required} federal safe harbor.'
    : has(fig, 'tax.fed.proj') ? 'Projected federal tax is {f:tax.fed.proj}.' : 'We need your income data to project this year.'),
  retirement: (ctx, fig) => (has(fig, 'room.solo401k.employee') ? 'Employee deferral room left: {f:room.solo401k.employee}.'
    : has(fig, 'room.hsa') ? 'HSA room left: {f:room.hsa}.' : 'Nothing to size yet.'),
  business: (ctx, fig) => (has(fig, 'scorp.profitProj') ? 'Projected profit before salary: {f:scorp.profitProj}.' : 'Watching your business profit and loss.'),
  cash: (ctx, fig) => (has(fig, 'cash.personal') ? 'Personal cash on hand: {f:cash.personal}.' : 'No account balances yet.'),
  family: () => 'Watching child credits, care costs and college savings.',
  giving: (ctx, fig) => (has(fig, 'giving.trailing') ? 'Given {f:giving.trailing} over the last year.' : 'No gifts seen this year.'),
  data: (ctx, fig, stale) => (stale.length ? `Waiting on: ${stale.map(s => s.label.toLowerCase()).join(', ')}.`
    : `All sources are current through ${dataThroughOf(ctx.freshness) || 'today'}.`),
};

// ---------------------------------------------------------------- deadlines

function writeDeadlines(db, ctx, hits) {
  const { clock, facts } = ctx;
  const rows = hits.filter(h => h.window).map((h, i) => ({ date: h.window.close, label: h.window.label, title: h.rec.title, rec_id: h.rec.id, hard: h.window.hard ? 1 : 0, i }));
  const y = (ctx.year ?? Number(clock.slice(0, 4))) + 1;
  const business = ['income.sCorp', 'income.selfEmployed', 'income.partnership'].some(k => facts[k] === true);
  const scorp = facts['income.sCorp'] === true;
  const va = facts['household.state'] === 'VA';
  const hitIds = new Set(hits.map(h => h.rec.id));
  const statutory = [
    { date: `${y}-01-15`, label: 'Jan 15', title: 'Federal fourth-quarter estimate due', when: business, coveredBy: 'fed-q4-estimate' },
    { date: `${y}-01-15`, label: 'Jan 15', title: 'Virginia fourth-quarter estimate due', when: business && va, coveredBy: 'va-q4-estimate' },
    { date: `${y}-01-31`, label: 'Jan 31', title: 'W-2 and 1099 forms due', when: scorp },
    { date: `${y}-03-15`, label: 'Mar 15', title: 'S corp return due', when: scorp },
    { date: `${y}-04-15`, label: 'Apr 15', title: 'Federal return due', when: true },
    { date: `${y}-05-01`, label: 'May 1', title: 'Virginia return due', when: va },
  ];
  const horizon = addDays(clock, 400);
  for (const s of statutory) {
    if (!s.when || s.date <= clock || s.date > horizon) continue;
    if (s.coveredBy && hitIds.has(s.coveredBy)) continue;
    rows.push({ date: s.date, label: s.label, title: s.title, rec_id: null, hard: 1, i: 100 + rows.length });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  return replaceRows(db, 'deadlines', ['date', 'label', 'title', 'rec_id', 'hard'], rows);
}

// ---------------------------------------------------------------- decisions (R14)

function writeDecisions(db, ctx, hits, wargame) {
  const year = ctx.year;
  const want = [];
  if (year) {
    for (const h of hits) {
      const sc = h.rec.scenario;
      if (!sc || !wargame[sc]) continue;
      want.push({
        id: `${sc}-${year}`, title: wargame[sc].title, status: 'open', wargame: sc, rec_id: h.rec.id, opens_on: null,
        when_label: h.window ? `Decide by ${h.window.label}` : '', note: wargame[sc].question,
      });
    }
    if (ctx.facts['income.sCorp'] === true) {
      want.push({
        id: `salary-${year + 1}`, title: `What should you pay yourself in ${year + 1}?`, status: 'upcoming', wargame: 'salary', rec_id: null,
        opens_on: `${year + 1}-01-01`, when_label: 'Opens in January', note: 'Reopens with next year projections.',
      });
    }
  }
  const rows = new Map(db.prepare('SELECT * FROM decisions').all().map(r => [r.id, r]));
  const cols = ['title', 'status', 'wargame', 'rec_id', 'opens_on', 'when_label', 'note', 'sort'];
  want.forEach((d, sort) => {
    const row = rows.get(d.id);
    const next = { ...d, sort };
    if (row && row.src !== SRC) return;
    if (row && row.status === 'decided') next.status = 'decided';
    if (!row) {
      db.prepare(`INSERT INTO decisions (id, title, status, wargame, rec_id, opens_on, when_label, note, decided_line, sort, src)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(d.id, d.title, next.status, d.wargame, d.rec_id, d.opens_on, d.when_label, d.note, sort, SRC);
    } else if (cols.some(c => (row[c] ?? null) !== (next[c] ?? null))) {
      db.prepare('UPDATE decisions SET title = ?, status = ?, wargame = ?, rec_id = ?, opens_on = ?, when_label = ?, note = ?, sort = ? WHERE id = ?')
        .run(d.title, next.status, d.wargame, d.rec_id, d.opens_on, d.when_label, d.note, sort, d.id);
    }
  });
  const wanted = new Set(want.map(d => d.id));
  const recExists = db.prepare('SELECT 1 FROM recs WHERE id = ?');
  for (const row of rows.values()) {
    if (row.src !== SRC || wanted.has(row.id)) continue;
    const recGone = row.rec_id != null && !recExists.get(row.rec_id);
    if (recGone || (row.rec_id == null && row.status === 'upcoming')) db.prepare('DELETE FROM decisions WHERE id = ?').run(row.id);
  }
  // D3: a decision on a war game kept only for reference stays as history with the game's reason;
  // the reason clears once the game is rebuilt. An upcoming next-year decision is not affected.
  const setReason = db.prepare('UPDATE decisions SET unavailable_reason = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, status, wargame, unavailable_reason FROM decisions WHERE src = ?').all(SRC)) {
    const g = row.wargame ? wargame[row.wargame] : null;
    const reason = row.status !== 'upcoming' && g && typeof g.unavailable === 'string' ? g.unavailable : null;
    if ((row.unavailable_reason ?? null) !== reason) setReason.run(reason, row.id);
  }
}

// ---------------------------------------------------------------- what changed

function factDomain(key) {
  if (key.startsWith('household.') || key === 'accounts.has529') return 'family';
  if (key.startsWith('income.')) return 'tax';
  if (key.startsWith('giving.')) return 'giving';
  return 'retirement';
}

function factKind(key) {
  if (key.startsWith('household.')) return 'life';
  if (key.startsWith('income.')) return 'income';
  return 'account';
}

const parserLabels = () => Object.fromEntries(listParsers().map(p => [p.id, p.label]));

// One prepared statement per evidence table (fixed names), reused for every new file.
function fileSummaryStatements(db) {
  const tables = [['transactions', 'date'], ['balances', 'date'], ['positions', 'as_of'], ['tax_payments', 'date'], ['pnl_lines', 'period'], ['documents', null], ['accounts', null]];
  return tables.map(([table, col]) => ({ col, stmt: db.prepare(`SELECT parser${col ? `, max(${col}) AS d` : ''} FROM ${table} WHERE file_id = ?`) }));
}

function fileSummary(statements, fileId) {
  let parser = null;
  let latest = null;
  for (const { col, stmt } of statements) {
    const r = stmt.get(fileId);
    if (r && r.parser && !parser) parser = r.parser;
    if (r && r.d) {
      const d = col === 'period' ? monthEnd(r.d) : r.d;
      if (!latest || d > latest) latest = d;
    }
  }
  return { parser, latest };
}

function whatChanged(db, ctx) {
  const snap = getSetting(db, 'planner.snapshot', null);
  const files = db.prepare('SELECT id, source_kind FROM files ORDER BY uploaded_at, id').all();
  const facts = Object.fromEntries(db.prepare('SELECT key, value FROM facts WHERE src = ? ORDER BY key').all(SRC).map(r => [r.key, r.value]));
  const recStates = db.prepare('SELECT p.rec_id, p.retired_at, p.retired_reason, r.def FROM planner_recs p JOIN recs r ON r.id = p.rec_id ORDER BY p.rec_id').all();
  const recsNow = Object.fromEntries(recStates.map(r => [r.rec_id, r.retired_at ? 'retired' : 'active']));
  const next = { files: files.map(f => f.id), facts, recs: recsNow, domains: snap && Array.isArray(snap.domains) ? snap.domains : [] };

  const domains = new Set();
  const events = [];
  const date = dayLabel(ctx.clock);
  const labels = parserLabels();
  const seenFiles = new Set(snap && Array.isArray(snap.files) ? snap.files : []);
  const statements = files.some(f => !seenFiles.has(f.id)) ? fileSummaryStatements(db) : [];
  for (const f of files) {
    if (seenFiles.has(f.id)) continue;
    const s = fileSummary(statements, f.id);
    const what = (s.parser && labels[s.parser]) || f.source_kind || 'Uploaded file';
    events.push({ date, kind: 'account', title: `New data: ${what}`, body: s.latest ? `Data through ${dateLabel(s.latest)}.` : 'Uploaded and filed.' });
    domains.add('data');
  }
  const before = snap && snap.recs ? snap.recs : {};
  for (const r of recStates) {
    const def = parseJson(r.def, {});
    if (recsNow[r.rec_id] === 'active' && before[r.rec_id] !== 'active') {
      events.push({ date, kind: KIND_BY_TRIGGER[def.trigger] || 'milestone', title: `New on your plan: ${def.title}`, body: def.summary || '' });
      if (def.domain) domains.add(def.domain);
    } else if (recsNow[r.rec_id] === 'retired' && before[r.rec_id] === 'active') {
      events.push({ date, kind: 'milestone', title: `Retired: ${def.title}`, body: r.retired_reason || '' });
      if (def.domain) domains.add(def.domain);
    }
  }
  const oldFacts = snap && snap.facts ? snap.facts : {};
  for (const [key, value] of Object.entries(facts)) {
    if (oldFacts[key] === value) continue;
    events.push({ date, kind: factKind(key), title: `${key} changed`, body: 'Derived from your data.' });
    domains.add(factDomain(key));
  }
  for (const key of Object.keys(oldFacts).sort()) {
    if (key in facts) continue;
    events.push({ date, kind: factKind(key), title: `${key} changed`, body: 'No longer seen in your data.' });
    domains.add(factDomain(key));
  }
  let written = null;
  if (events.length) {
    replaceRows(db, 'events', ['date', 'kind', 'title', 'body', 'sort'], events.map((e, sort) => ({ ...e, sort })));
    written = events.length;
    next.domains = [...domains].sort();
  }
  if (JSON.stringify(snap) !== JSON.stringify(next)) setSetting(db, 'planner.snapshot', next);
  return { events: written, domains: new Set(next.domains) };
}
