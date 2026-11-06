// Store to scenario: assembles the CONTRACT.md scenario object from the store, with live state
// merged in, plus the `live` key (see docs/architecture.md). Pure reads; never writes.
//
// Derived at build time, never stored: window.days from the clock, meta.clock and clockLabel,
// Decide statuses and lines, war-game status and decided line, the engine budget, and the
// provenance figures for war-game, series and engine amounts (wg.*, series.*, engine.*).

import { getSetting, cents, parseJson as parse } from '../store/db.mjs';
import { resolveTokens } from '../shared/tokens.mjs';
import { ingestState, applyFreshness } from '../ingest/freshness.mjs';
import { MODEL_PURPOSES, modelFor } from '../engine/pricing.mjs';
import { factEventTitle } from '../shared/event-labels.mjs';
import { buildYearend } from '../yearend/expected.mjs';
import { CURVE_AXES, KNOWN_FIGURES, curvePosition, servesGoals } from '../shared/goals.mjs';
import { deriveHeard } from '../onboarding/heard.mjs';
import { withAdvisor, advisorSection } from '../advisor/index.mjs';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_CAP_USD = 200;

// Sources the builder relies on for derived figures. A sources row with the same id wins.
export const BUILTIN_SOURCES = Object.freeze({
  'wargame-model': { label: 'War-game model, from your plan', kind: 'model' },
  'job-estimates': { label: 'Per-run cost estimate', kind: 'estimate' },
  'spend-ledger': { label: 'Engine spend ledger, this month', kind: 'ledger' },
  settings: { label: 'Your engine settings', kind: 'settings' },
  balances: { label: 'Account balances you uploaded', kind: 'accounts' },
  plan: { label: 'Plan of record', kind: 'plan' },
  'goal-target': { label: 'You typed this', kind: 'owner' },
  'goal-track': { label: 'Sum of the accounts this goal tracks', kind: 'calc' },
});

// Narrative sections an empty store serves, so every CONTRACT key is present and valid.
const EMPTY = {
  meta: { product: 'Fathom', household: '', dataThrough: '' },
  names: {},
  law: {},
  pct: {},
  series: {},
  verdict: {
    clear: { headline: 'Nothing needs you right now.', sub: '' },
    attention: { headline: '{count} things need you.', sub: '' },
  },
  domains: [],
  curve: [],
  wargame: {},
  ask: { suggested: [], fallback: [] },
  advisor: { name: '', role: '', agenda: '', notAsking: [], shared: [], experts: [] },
  connect: { url: '', scopes: [], tools: [], transcript: [], config: '' },
  'engine.chat': { model: '', note: '' },
  onboarding: {
    welcome: { headline: 'Welcome to Fathom', sub: '' },
    dump: '',
    files: [],
    institutions: [],
    heard: { people: [], entities: [], income: [], lifeEvents: [], deadlines: 0, questions: [] }, // unused: the page reads live.heard, derived from stored facts
    priorities: [],
  },
  email: { subject: '', preheader: '', greeting: '', sections: [], footer: '' },
};

// ---------------------------------------------------------------- dates

export const isIsoDate = v => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
const dayNum = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY);
export const daysBetween = (fromIso, toIso) => dayNum(toIso) - dayNum(fromIso);
export function addDays(iso, n) {
  return new Date((dayNum(iso) + n) * DAY).toISOString().slice(0, 10);
}

export function clockLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// 'Nov 5, 9:04 AM' from an ISO timestamp; anything else is returned as is.
export function tsLabel(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(ts || ''));
  if (!m) return String(ts || '');
  const h24 = Number(m[4]);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${h}:${m[5]} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// "Today": the override, else settings.clock, else the current UTC date.
export function resolveClock(db, override) {
  const c = override || getSetting(db, 'clock', null) || todayUtc();
  if (!isIsoDate(c)) throw new Error(`clock must be an ISO date (YYYY-MM-DD), got ${c}`);
  return c;
}

// The current time on the scenario clock: the clock's date at the current UTC time of day.
export function clockNow(db, override) {
  return `${resolveClock(db, override)}T${new Date().toISOString().slice(11)}`;
}

// ---------------------------------------------------------------- small readers

const arr = v => (Array.isArray(v) ? v : []);

export function loadContent(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM content').all()) out[r.key] = parse(r.value, null);
  return out;
}

const section = (content, key) => (content[key] != null ? content[key] : structuredClone(EMPTY[key]));

export function loadSources(db, clock) {
  const src = {};
  for (const [id, s] of Object.entries(BUILTIN_SOURCES)) {
    src[id] = { label: s.label, asOf: id === 'spend-ledger' && clock ? clockLabel(clock) : '' };
  }
  for (const r of db.prepare('SELECT id, label, as_of FROM sources ORDER BY rowid').all()) {
    src[r.id] = { label: r.label, asOf: r.as_of || '' };
  }
  return src;
}

// Stored figures. A figure carries `notes` (readable assumptions from its locator, at most five,
// MGN1) when it has any, and `unavailable` (the reason, R2-9) when the planner kept it only for
// reference.
export function loadFigures(db) {
  const fig = {};
  for (const r of db.prepare('SELECT key, v, src, kind, label, locator, unavailable_reason FROM figures ORDER BY rowid').all()) {
    const f = { v: r.v, src: r.src, kind: r.kind, label: r.label };
    const loc = parse(r.locator, null);
    const notes = loc && Array.isArray(loc.notes) ? loc.notes.filter(n => typeof n === 'string' && n.trim()) : [];
    if (notes.length) f.notes = notes.slice(0, 5);
    if (typeof r.unavailable_reason === 'string' && r.unavailable_reason) f.unavailable = r.unavailable_reason;
    fig[r.key] = f;
  }
  return fig;
}

// Names, law, pct and stored figures: enough to resolve tokens outside a full build.
export function tokenScope(db) {
  const c = loadContent(db);
  return { names: c.names || {}, law: c.law || {}, pct: c.pct || {}, fig: loadFigures(db) };
}

export function recFromRow(row, clock) {
  const def = parse(row.def, {});
  const done = parse(row.tasks_done, []);
  const rec = {
    ...def,
    window: { label: row.window_label, days: row.window_close ? daysBetween(clock, row.window_close) : null },
    status: row.status,
    tasks: arr(def.tasks).map((t, i) => ({ ...t, done: !!done[i] })),
  };
  if (row.wake != null) rec.wake = row.wake; else delete rec.wake;
  if (row.waiting_on != null) rec.waitingOn = row.waiting_on; else delete rec.waitingOn;
  return rec;
}

// Every rec with live status (hidden ones included; callers filter).
// Each rec's `advisor` field comes from the advisor tables (src/advisor), never from its def.
export function loadRecs(db, clock) {
  return withAdvisor(db, db.prepare('SELECT * FROM recs ORDER BY sort, id').all().map(r => recFromRow(r, clock)));
}

export function messageOut(row) {
  return {
    id: 'm' + row.id,
    role: row.role,
    text: row.text,
    refs: parse(row.refs, []),
    ts: tsLabel(row.ts),
    notice: !!row.notice,
    provenance: parse(row.provenance, null),
  };
}

// Every conversation's messages by key: rec ids, 'pack:<id>' and Ask threads ('ask:<id>').
export function loadConversations(db) {
  const out = {};
  for (const c of db.prepare('SELECT key FROM conversations ORDER BY created_at, key').all()) out[c.key] = out[c.key] || [];
  for (const m of db.prepare('SELECT * FROM messages ORDER BY id').all()) {
    (out[m.conversation_key] || (out[m.conversation_key] = [])).push(messageOut(m));
  }
  return out;
}

// ---------------------------------------------------------------- Ask threads

// An Ask thread key: 'ask:' and 12 lowercase hex characters (the id the URLs carry).
export const THREAD_KEY = /^ask:[a-f0-9]{12}$/;

// Thread JSON (docs/architecture.md, Ask threads) from a conversations row with a `turns` count.
export function threadOut(row) {
  return {
    id: row.key.slice(4),
    key: row.key,
    title: row.title ?? null,
    titleSource: row.title_source ?? null,
    createdAt: row.created_at,
    lastAt: row.last_at ?? row.created_at,
    archivedAt: row.archived_at ?? null,
    trashedAt: row.trashed_at ?? null,
    turns: Number(row.turns) || 0,
  };
}

export const THREAD_SELECT = `SELECT c.key, c.created_at, c.title, c.title_source, c.archived_at, c.trashed_at, c.last_at,
  (SELECT count(*) FROM messages m WHERE m.conversation_key = c.key AND m.role = 'me') AS turns
  FROM conversations c`;

// Every Ask thread (archived and trashed included), newest lastAt first.
export function loadThreads(db) {
  return db.prepare(`${THREAD_SELECT} WHERE substr(c.key, 1, 4) = 'ask:' ORDER BY coalesce(c.last_at, c.created_at) DESC, c.rowid DESC`)
    .all().filter(r => THREAD_KEY.test(r.key)).map(threadOut);
}

// The fixed Ask starter questions, in their pinned order. No figures, no tokens.
export const ASK_STARTERS = Object.freeze([
  Object.freeze({ id: 'attention', q: 'What needs my attention right now?' }),
  Object.freeze({ id: 'taxes', q: 'How are our tax payments tracking this year?' }),
  Object.freeze({ id: 'scorp', q: 'How is the S corp doing this year?' }),
  Object.freeze({ id: 'yearend', q: 'What should we do before the year ends?' }),
]);

// The starters whose condition holds: attention (a visible rec proposed or doing), taxes
// (any tax payment), scorp (fact income.sCorp is true or any P&L line), yearend (always).
export function loadAskStarters(db, recs) {
  const exists = table => !!db.prepare(`SELECT EXISTS (SELECT 1 FROM ${table}) AS x`).get().x;
  const sCorp = parse(db.prepare("SELECT value FROM facts WHERE key = 'income.sCorp'").get()?.value, null) === true;
  const holds = {
    attention: recs.some(r => ['proposed', 'doing'].includes(r.status)),
    taxes: exists('tax_payments'),
    scorp: sCorp || exists('pnl_lines'),
    yearend: true,
  };
  return ASK_STARTERS.filter(st => holds[st.id]).map(st => ({ id: st.id, q: st.q }));
}

export function wargameLists(wargame) {
  const w = wargame || {};
  return { salary: arr(w.salary && w.salary.points), deferral: arr(w.deferral && w.deferral.options) };
}

// The current or recommended entry of each war game, else the first.
export function defaultPicks(wargame) {
  const pick = list => Math.max(0, list.findIndex(x => x && (x.current || x.recommended)));
  const { salary, deferral } = wargameLists(wargame);
  return { salary: pick(salary), deferral: pick(deferral) };
}

// livePacks (optional, src/packs/live.mjs) adds each manifest-backed row's manifest fields.
export function loadPacks(db, livePacks = null) {
  return db.prepare('SELECT * FROM packs_state ORDER BY sort, id').all().map(r => ({
    id: r.id,
    def: livePacks ? livePacks.view(r.id, parse(r.def, {})) : parse(r.def, {}),
    live: {
      active: r.active == null ? null : !!r.active,
      exploring: !!r.exploring,
      whatIfAsked: !!r.what_if_asked,
      whatIfDone: !!r.what_if_done,
      unhid: parse(r.unhid, []),
    },
  }));
}

// The latest spend rows for the Engine screen: no tokens, no prompt fields.
export const LEDGER_ROWS = 8;
export function loadLedger(db) {
  return db.prepare('SELECT id, ts, purpose, model, cost_usd FROM spend_ledger ORDER BY id DESC LIMIT ?').all(LEDGER_ROWS)
    .map(r => ({ id: r.id, ts: tsLabel(r.ts), purpose: r.purpose, model: r.model, cost: cents(r.cost_usd) }));
}

// Your plans inputs: plan and benefits documents, the files a build can read (text or PDF), and
// the last build (settings.yourPlans) or null.
const READABLE = "(mime LIKE 'text/%' OR mime = 'application/pdf' OR lower(name) LIKE '%.md' OR lower(name) LIKE '%.txt' OR lower(name) LIKE '%.pdf')";
export function loadYourPlans(db) {
  const sources = db.prepare(`SELECT d.id, d.doc_type, d.fields, d.file_id, f.name FROM documents d LEFT JOIN files f ON f.id = d.file_id
                              WHERE d.doc_type IN ('plan', 'benefits') ORDER BY d.id`).all()
    .filter(r => r.file_id ? r.name != null : typeof parse(r.fields, {})?.text === 'string')
    .map(r => ({ fileId: r.file_id || null, name: r.file_id ? r.name : `document-${r.id}`, docType: r.doc_type }));
  const files = db.prepare(`SELECT id, name FROM files WHERE ${READABLE} ORDER BY uploaded_at, id`).all()
    .map(r => ({ id: r.id, name: r.name }));
  return { sources, files, built: getSetting(db, 'yourPlans', null) };
}

// ---------------------------------------------------------------- Decide

// Per decision: the derived status and its explanation line (see docs/architecture.md, Decide).
export function deriveDecisions(rows, recsById, clock, wargame) {
  const wg = wargame || {};
  return rows.map(d => {
    const rec = d.rec_id ? recsById.get(d.rec_id) : null;
    let status = d.status;
    let line = '';
    if (d.status === 'decided') {
      const g = d.wargame ? wg[d.wargame] : null;
      line = d.decided_line || (g && g.decided) || [d.when_label, d.note].filter(Boolean).join('. ');
    } else if (d.unavailable_reason) {
      // D3, R3-7: kept as history, not a current choice; only a stored decided row wins over it.
      status = 'unavailable';
    } else if (rec && (rec.status === 'done' || rec.status === 'dismissed')) {
      status = 'decided';
      line = rec.status === 'done' ? 'Marked done on your plan.' : 'Set aside on your plan.';
    } else if (d.status === 'upcoming' && d.opens_on && d.opens_on <= clock) {
      status = 'open';
    }
    const out = { id: d.id, title: d.title, status };
    if (d.wargame) out.wargame = d.wargame;
    if (d.rec_id) out.recId = d.rec_id;
    out.when = d.when_label || '';
    out.note = d.note || '';
    out.line = line;
    // A decision decided through the decide action carries its stored line and can be reopened.
    if (d.status === 'decided' && d.wargame && d.decided_line) out.revisitable = true;
    if (status === 'unavailable') out.unavailable = d.unavailable_reason;
    return out;
  });
}

// War-game status follows the decisions naming it: open, else decided, else upcoming. A game the
// planner kept only for reference is unavailable unless a stored decision on it is decided.
function deriveWargame(wargame, decisions, rows) {
  const out = structuredClone(wargame || {});
  for (const [name, g] of Object.entries(out)) {
    if (!g || typeof g !== 'object') continue;
    const storedDecided = rows.some(r => r.wargame === name && r.status === 'decided');
    if (typeof g.unavailable === 'string' && !storedDecided) {
      g.status = 'unavailable';
      continue;
    }
    const named = decisions.filter(d => d.wargame === name);
    if (!named.length) continue;
    g.status = named.some(d => d.status === 'open') ? 'open' : named.some(d => d.status === 'decided') ? 'decided' : 'upcoming';
    const firstDecided = named.find(d => d.status === 'decided');
    // A line the decide action stored wins over the game's own decided text.
    const storedLine = rows.find(r => r.wargame === name && r.status === 'decided' && r.decided_line);
    if (storedLine) g.decided = storedLine.decided_line;
    else if (!(g.decided && storedDecided) && firstDecided) g.decided = firstDecided.line;
  }
  return out;
}

// ---------------------------------------------------------------- derived figures

function deriveFigures(fig, { wargame, series, engine }, scope) {
  const plain = s => resolveTokens(scope, s, false);
  // A stored war-game figure (the planner writes them with calculator locators) wins.
  const setWg = (key, value) => { if (!fig[key]) fig[key] = value; };
  const salary = wargame.salary;
  if (salary) {
    for (const p of arr(salary.points)) {
      setWg(`wg.salary.${p.id}.x`, { v: p.x, src: 'wargame-model', kind: 'm', label: `${plain(p.label)}: ${plain(salary.xLabel || 'x')}` });
      setWg(`wg.salary.${p.id}.y`, { v: p.y, src: 'wargame-model', kind: 'm', label: `${plain(p.label)}: ${plain(salary.yLabel || 'y')}` });
    }
  }
  const deferral = wargame.deferral;
  if (deferral) {
    const fields = {
      amount: 'amount moved to January', tax2026: '2026 tax change', tax2027: '2027 tax change', net: 'net tax change',
      decCash: 'December business cash', need: 'December payroll need', gap: 'December payroll need less cash',
    };
    for (const o of arr(deferral.options)) {
      const vals = { amount: o.amount, tax2026: o.tax2026, tax2027: o.tax2027, net: o.net, decCash: o.decCash, need: o.need, gap: cents(o.need - o.decCash) };
      for (const [field, label] of Object.entries(fields)) {
        if (typeof vals[field] !== 'number' || Number.isNaN(vals[field])) continue;
        setWg(`wg.deferral.${o.id}.${field}`, { v: vals[field], src: 'wargame-model', kind: 'm', label: `${plain(o.label)}: ${label}` });
      }
    }
  }
  for (const [key, s] of Object.entries(series || {})) {
    arr(s && s.points).forEach((p, i) => {
      fig[`series.${key}.${i}`] = {
        v: p.v, src: s.src || 'plan', kind: ['a', 'p', 'e', 'm'].includes(p.kind) ? p.kind : 'e', label: `${plain(s.label)}, ${p.x}`,
      };
    });
  }
  for (const r of engine.ledger) {
    fig[`engine.ledger.${r.id}.cost`] = { v: r.cost, src: 'spend-ledger', kind: 'a', label: `${r.purpose}, ${r.ts}` };
  }
  fig['engine.budget.used'] = { v: engine.budget.used, src: 'spend-ledger', kind: 'a', label: 'Engine spend this month' };
  fig['engine.budget.monthly'] = { v: engine.budget.monthly, src: 'settings', kind: 'p', label: 'Monthly engine cap' };
  fig['engine.budget.left'] = {
    v: Math.max(0, cents(engine.budget.monthly - engine.budget.used)), src: 'spend-ledger', kind: 'e', label: 'Left this month',
  };
  for (const j of engine.jobs) {
    if (typeof j.cost === 'number') fig[`engine.job.${j.id}.cost`] = { v: j.cost, src: 'job-estimates', kind: 'e', label: `${j.name}, per run` };
  }
}

const RAW_EVENT_TITLE = /^([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+) changed$/;
function plainEventTitle(e) {
  const m = RAW_EVENT_TITLE.exec(String(e.title));
  return m ? factEventTitle(m[1], { removed: /^No longer/.test(String(e.body)), kind: e.kind }) : e.title;
}

// ---------------------------------------------------------------- goals and the curve

// Every goal row (archived included) as {...def, id, origin, archived, progress?}. Owner goals get
// derived figures in `fig`: goal.<id>.target (the typed target, src 'goal-target', kind 't') and
// goal.<id>.current (the tracked value: one account's or known figure's own figure, or the sum of
// several tracked accounts, src 'goal-track'), and progress {cur, target} when both exist. A
// tracked account with no stored balance, or a figure kept only for reference (unavailable), leaves
// the goal with no current value, never a partial or stale sum.
const currentFig = f => !!f && typeof f.v === 'number' && !f.unavailable;
export function loadGoals(db, { fig = {}, accounts = [] } = {}) {
  const rows = db.prepare('SELECT * FROM goals ORDER BY sort, created_at, id').all();
  return rows.map(r => {
    const def = parse(r.def, {});
    const origin = r.origin === 'owner' ? 'owner' : 'seed';
    const g = { ...def, id: r.id, origin, archived: !!r.archived_at };
    if (origin !== 'owner') return g;
    delete g.progress;
    const tKey = `goal.${r.id}.target`;
    const cKey = `goal.${r.id}.current`;
    if (typeof def.target === 'number' && Number.isFinite(def.target)) {
      fig[tKey] = { v: def.target, src: 'goal-target', kind: 't', label: 'Goal target' };
    }
    const tr = def.track;
    let cur = null;
    if (tr && typeof tr.figure === 'string' && currentFig(fig[tr.figure])) {
      cur = tr.figure;
      const known = KNOWN_FIGURES.find(k => k.key === tr.figure);
      g.trackLabel = known ? known.label : tr.figure;
    } else if (tr && Array.isArray(tr.accounts) && tr.accounts.length) {
      const accts = tr.accounts.map(id => accounts.find(a => a.id === id)).filter(Boolean);
      g.trackLabel = accts.map(a => a.name).join(', ');
      const figs = accts.map(a => (a.fig_key && currentFig(fig[a.fig_key]) ? fig[a.fig_key] : null));
      if (accts.length && accts.length === tr.accounts.length && figs.every(Boolean)) {
        if (accts.length === 1) cur = accts[0].fig_key;
        else {
          fig[cKey] = {
            v: cents(figs.reduce((s, f) => s + f.v, 0)), src: 'goal-track',
            kind: figs.every(f => f.kind === 'a') ? 'a' : 'e', label: 'Goal progress: tracked accounts',
          };
          cur = cKey;
        }
      } else g.trackWaiting = true;
    }
    if (cur) g.current = cur;
    if (cur && fig[tKey] && fig[tKey].v > 0) g.progress = { cur, target: tKey };
    return g;
  });
}

// The tradeoff curve: the content axes (the demo) or the default axes (a real store), each with
// its position from settings 'curve.positions'.
export function loadCurve(db, content) {
  const positions = getSetting(db, 'curve.positions', null) || {};
  const axes = Array.isArray(content.curve) && content.curve.length ? content.curve : CURVE_AXES;
  return axes.map(a => ({ ...a, value: curvePosition(positions, a) }));
}

// Onboarding priorities: the content's (the demo) or one per curve axis, at the stored positions.
function onboardingWithPriorities(onboarding, curve, positions) {
  const ob = structuredClone(onboarding);
  const list = Array.isArray(ob.priorities) && ob.priorities.length ? ob.priorities
    : curve.map(c => ({ id: c.id, label: `${c.left} vs ${c.right}`, value: c.value }));
  ob.priorities = list.map(p => ({ ...p, value: curvePosition(positions, p) }));
  return ob;
}

// ---------------------------------------------------------------- build

export function buildScenario(db, { clock, engineMode = null, packs: livePacks = null } = {}) {
  const clk = resolveClock(db, clock);
  const content = loadContent(db);
  const metaC = section(content, 'meta');
  const names = section(content, 'names');
  const law = section(content, 'law');
  const pct = section(content, 'pct');
  const series = section(content, 'series');
  const wargameC = section(content, 'wargame');

  const src = loadSources(db, clk);
  const fig = loadFigures(db);

  const recs = loadRecs(db, clk);
  const recsById = new Map(recs.map(r => [r.id, r]));

  const decisionRows = db.prepare('SELECT * FROM decisions ORDER BY sort, id').all();
  const decisions = deriveDecisions(decisionRows, recsById, clk, wargameC);
  const wargame = deriveWargame(wargameC, decisions, decisionRows);

  const month = clk.slice(0, 7);
  const used = cents(db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?').get(month).s);
  const cap = getSetting(db, 'cap', { usd: DEFAULT_CAP_USD });
  const monthly = cap && typeof cap.usd === 'number' ? cap.usd : DEFAULT_CAP_USD;
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY sort, id').all().map(j => ({
    id: j.id, name: j.name, cadence: j.cadence || '', last: j.last_label || '', next: j.next_label || '', does: j.does || '', cost: j.cost,
  }));
  // The models the engine runs per purpose, read from the engine's own configuration (not content).
  const models = MODEL_PURPOSES.map(purpose => ({ purpose, model: modelFor(purpose) }));
  const engine = { mode: engineMode, budget: { monthly, used }, chat: section(content, 'engine.chat'), models, jobs, ledger: loadLedger(db) };

  deriveFigures(fig, { wargame, series, engine }, { names, law, pct, fig });

  const packs = loadPacks(db, livePacks);
  const onboarding = getSetting(db, 'onboarding', { done: false, step: 0 }) || { done: false, step: 0 };
  const mode = getSetting(db, 'mode', null) === 'demo' ? 'demo' : 'real';
  // A real store that already holds data (an imported file or an account) is a returning owner:
  // it builds as november so the owner lands in the app, not first-run onboarding.
  const hasData = !!db.prepare('SELECT EXISTS (SELECT 1 FROM files) OR EXISTS (SELECT 1 FROM accounts) AS x').get().x;
  const picks = { ...defaultPicks(wargame), ...(getSetting(db, 'wargame.picks', null) || {}) };
  const engineOn = getSetting(db, 'engine', { on: true });
  const ingest = ingestState(db, { clock: clk });
  const ingestAccounts = ingest.accounts || {};
  const accountRows = db.prepare('SELECT * FROM accounts ORDER BY sort, id').all();
  const goals = loadGoals(db, { fig, accounts: accountRows });
  const curve = loadCurve(db, content);
  const positions = getSetting(db, 'curve.positions', null) || {};
  for (const r of recs) {
    const serves = servesGoals(r, goals, accountRows);
    if (serves.length) r.serves = serves;
  }

  return {
    meta: {
      product: metaC.product || 'Fathom',
      clock: clk,
      clockLabel: clockLabel(clk),
      dataThrough: metaC.dataThrough || '',
      household: metaC.household || '',
    },
    names,
    law,
    pct,
    src,
    fig,
    series,
    verdict: section(content, 'verdict'),
    domains: applyFreshness(section(content, 'domains'), ingest),
    // A store written before titles were plain language may still hold "<fact key> changed".
    events: db.prepare('SELECT date, kind, title, body FROM events ORDER BY sort, id').all().map(e => ({ ...e, title: plainEventTitle(e) })),
    deadlines: db.prepare('SELECT date, label, title, rec_id, hard FROM deadlines ORDER BY date, id').all().map(d => {
      const out = { date: d.date, label: d.label, title: d.title };
      if (d.rec_id) out.recId = d.rec_id;
      out.hard = !!d.hard;
      return out;
    }),
    recs,
    goals,
    curve,
    wargame,
    decisions,
    ask: section(content, 'ask'),
    accounts: accountRows.map(a => {
      const f = Object.hasOwn(ingestAccounts, a.id) ? ingestAccounts[a.id] : {};
      return {
        id: a.id, inst: a.inst, name: a.name, owner: a.owner, kind: a.kind, fig: a.fig_key, mirror: a.mirror, note: a.note || '', mask: a.mask,
        asOf: f.asOf || '', fresh: f.fresh || 'unknown', sourceId: f.sourceId || null,
        // Text that came from an uploaded file: render as plain text, never as tokens or markup.
        imported: a.parser !== 'demo-seed',
      };
    }),
    advisor: advisorSection(db, section(content, 'advisor'), recs),
    yearend: buildYearend(db, { clock: clk, recs, decisions, plain: s => resolveTokens({ names, law, pct, fig }, s, false) }),
    connect: section(content, 'connect'),
    engine,
    onboarding: onboardingWithPriorities(section(content, 'onboarding'), curve, positions),
    email: section(content, 'email'),
    packs: packs.map(p => p.def),
    live: {
      mode,
      demo: onboarding.done || (mode === 'real' && hasData) ? 'november' : 'fresh',
      engine: !(engineOn && engineOn.on === false),
      onboardStep: Number.isInteger(onboarding.step) ? onboarding.step : 0,
      picks,
      conversations: loadConversations(db),
      threads: loadThreads(db),
      askStarters: loadAskStarters(db, recs),
      packs: Object.fromEntries(packs.map(p => [p.def.id, { active: p.live.active, exploring: p.live.exploring, whatIfDone: p.live.whatIfDone }])),
      yourPlans: loadYourPlans(db),
      clock: clk,
      ingest,
      simplefin: loadSimplefin(db, mode),
      heard: deriveHeard(db, { clock: clk }),
    },
  };
}

// The SimpleFIN connection as the UI may see it: never the access URL (src/ingest/simplefin.mjs
// owns the connection; this reads its status columns only).
export function loadSimplefin(db, mode) {
  const row = db.prepare('SELECT connected_at, last_sync_at, status, error_code, messages, accounts FROM simplefin_connection WHERE id = 1').get();
  const pendingMatches = db.prepare("SELECT count(*) AS n FROM simplefin_accounts WHERE status = 'pending_match'").get().n;
  // The demo store talks to a synthetic fake bridge; its setup token is synthetic and reusable.
  const demoToken = mode === 'demo' ? Buffer.from('https://bridge.simplefin.org/simplefin/claim/demo-fathom', 'utf8').toString('base64') : null;
  const base = { demo: mode === 'demo', demoToken, pendingMatches };
  if (!row) return { ...base, connected: false };
  const messages = parse(row.messages, []);
  return {
    ...base, connected: true, accounts: row.accounts, connectedAt: row.connected_at, lastSyncAt: row.last_sync_at,
    status: row.status, errorCode: row.error_code, reconnect: row.status === 'reconnect', messages: Array.isArray(messages) ? messages : [],
  };
}
