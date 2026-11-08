// Onboarding, "Here is what we heard" and "what we understood" (docs/architecture.md, Onboarding).
// Both are read from the store and never invent a value: deriveHeard lists stored facts, entities
// and accounts with their provenance and an edit target; understoodOf lists what one saved notes
// file added. Pure reads. Text that came from an uploaded file (file names, entity and account
// names) is returned as plain strings; callers render it escaped, never as tokens or markup.

import { parseJson as parse } from '../store/db.mjs';
import { pendingItems } from '../ingest/confirm.mjs';

const FILING = {
  mfj: 'Married filing jointly', mfs: 'Married filing separately', single: 'Single', hoh: 'Head of household', qss: 'Qualifying surviving spouse',
};

const usd = n => {
  const v = Math.round(Math.abs(Number(n)) * 100) / 100;
  const [w, f] = (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)).split('.');
  return (Number(n) < 0 ? '-$' : '$') + w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
};
const yesNo = v => (v ? 'Yes' : 'No');

// Frozen fact key -> { section, label, text(value) }. A value of the wrong type is skipped, not shown.
const FACTS = [
  ['household.filingStatus', 'household', 'Filing status', v => (typeof v === 'string' && FILING[v] ? FILING[v] : null)],
  ['household.state', 'household', 'State', v => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null)],
  ['household.dependents', 'household', 'Dependents', v => (Number.isInteger(v) && v >= 0 ? String(v) : null)],
  ['household.dependentAges', 'household', 'Dependent ages', v => (Array.isArray(v) && v.every(Number.isInteger) && v.length ? v.join(', ') : null)],
  ['household.birthYears', 'household', 'Birth years', v => (v && typeof v === 'object' && Number.isInteger(v.owner) ? [`you ${v.owner}`, ...(Number.isInteger(v.spouse) ? [`spouse ${v.spouse}`] : [])].join(', ') : null)],
  ['household.expectingChild', 'household', 'Expecting a child', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['income.w2', 'income', 'W-2 income', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['income.sCorp', 'income', 'S corporation income', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['income.selfEmployed', 'income', 'Self-employment income', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['income.partnership', 'income', 'Partnership income', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['income.agiEstimate', 'income', 'Estimated adjusted gross income', v => (Number.isFinite(v) ? usd(v) : null)],
  ['benefits.hsa', 'savings', 'HSA', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['benefits.employer401k', 'savings', 'Employer retirement plan', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['retirement.solo401k', 'savings', 'Solo 401(k)', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['retirement.ira', 'savings', 'IRA', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['retirement.backdoorRothCandidate', 'savings', 'Backdoor Roth candidate', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['accounts.has529', 'savings', '529 plan', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['giving.charitable', 'savings', 'Charitable giving', v => (typeof v === 'boolean' ? yesNo(v) : null)],
  ['giving.annualEstimate', 'savings', 'Yearly giving estimate', v => (Number.isFinite(v) ? usd(v) : null)],
];
const FACT_BY_KEY = new Map(FACTS.map(f => [f[0], f]));

const SECTIONS = [
  ['household', 'Household'],
  ['income', 'Income and entities'],
  ['savings', 'Savings and giving'],
  ['accounts', 'Accounts'],
];

const ACCOUNT_KIND = {
  checking: 'Checking', cash: 'Savings or cash', card: 'Credit card', taxable: 'Taxable brokerage', retirement: 'Retirement',
  roth: 'Roth', hsa: 'HSA', '529': '529 plan', business: 'Business', loan: 'Loan',
};

const EDIT_NOTES = { route: 'onboarding', step: 3, label: 'Correct in notes' };
const EDIT_CONFIRM = { route: 'confirm', label: 'Review in Confirm' };
// The account list lives on the Money overview (#/accounts lands there too).
const EDIT_ACCOUNTS = { route: 'money', label: 'Edit in Accounts' };

function fileNames(db, ids) {
  const out = [];
  for (const id of ids) {
    if (id == null) continue;
    const row = db.prepare('SELECT name FROM files WHERE id = ?').get(id);
    if (row && row.name && !out.includes(row.name)) out.push(row.name);
  }
  return out;
}

const fromText = names => (names.length ? `From ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}` : '');

// Where a stored fact came from, in words: its file, the planner, or the owner's own answer.
function factProv(db, row) {
  const names = fileNames(db, [row.file_id]);
  let text = fromText(names);
  if (!text && row.parser === 'planner') text = 'Worked out by the planner';
  if (!text && row.src) {
    const s = db.prepare('SELECT label FROM sources WHERE id = ?').get(row.src);
    text = s && s.label ? `From ${s.label}` : row.src === 'you' ? 'Entered by you' : '';
  }
  if (!text) text = 'Stored fact';
  return row.confirmed ? `${text}, confirmed by you` : text;
}

// The household as stored. `deriveHeard(db, {clock})` returns
// { sections: [{id, title, items: [{id, label, value, prov, edit}]}], deadlines, pending, empty }.
// edit is { route, step?, label }: the Confirm deck when a question about that item is open, the
// Accounts page for accounts, else the Tell us step (onboarding step 3), where a corrected note
// supersedes it.
export function deriveHeard(db, { clock } = {}) {
  const pending = pendingItems(db);
  const askedKeys = new Set(pending.filter(i => i.kind === 'fact_check').map(i => i.context && i.context.key).filter(Boolean));
  const factRows = new Map(db.prepare('SELECT key, value, src, as_of, confirmed, file_id, parser FROM facts').all().map(r => [r.key, r]));

  const by = new Map(SECTIONS.map(([id, title]) => [id, { id, title, items: [] }]));
  for (const [key, section, label, text] of FACTS) {
    const row = factRows.get(key);
    if (!row) continue;
    const value = text(parse(row.value, undefined));
    if (value == null) continue;
    by.get(section).items.push({
      id: `fact:${key}`, key, label, value, prov: factProv(db, row), confirmed: !!row.confirmed, asked: askedKeys.has(key),
      edit: askedKeys.has(key) ? EDIT_CONFIRM : EDIT_NOTES,
    });
  }

  // Entities: the P&L entities, each with the files they came from.
  const entities = new Map();
  const noteEntity = (name, fileId) => {
    const n = String(name == null ? '' : name).trim();
    if (!n) return;
    if (!entities.has(n)) entities.set(n, new Set());
    entities.get(n).add(fileId);
  };
  for (const r of db.prepare('SELECT entity, file_id FROM pnl_lines GROUP BY entity, file_id ORDER BY entity').all()) noteEntity(r.entity, r.file_id);
  const aliasAsked = pending.some(i => i.kind === 'entity_alias');
  for (const [name, ids] of entities) {
    by.get('income').items.push({
      id: `entity:${name}`, label: 'Entity', value: name, prov: fromText(fileNames(db, [...ids])) || 'Stored entity', confirmed: false, asked: aliasAsked,
      edit: aliasAsked ? EDIT_CONFIRM : EDIT_ACCOUNTS,
    });
  }

  // Accounts by kind, with the files that created them.
  const kinds = new Map();
  for (const a of db.prepare('SELECT kind, file_id FROM accounts ORDER BY sort, id').all()) {
    const k = a.kind || 'other';
    if (!kinds.has(k)) kinds.set(k, { count: 0, files: new Set() });
    const g = kinds.get(k);
    g.count += 1;
    g.files.add(a.file_id);
  }
  const kindAsked = pending.some(i => i.kind === 'account_kind' || i.kind === 'account_owner');
  for (const [k, g] of kinds) {
    by.get('accounts').items.push({
      id: `accounts:${k}`, label: ACCOUNT_KIND[k] || 'Other accounts', value: String(g.count), prov: fromText(fileNames(db, [...g.files])) || 'Stored accounts',
      confirmed: false, asked: kindAsked, edit: kindAsked ? EDIT_CONFIRM : EDIT_ACCOUNTS,
    });
  }

  const from = clock || new Date().toISOString().slice(0, 10);
  const to = new Date(Date.parse(from + 'T00:00:00Z') + 365 * 86400000).toISOString().slice(0, 10);
  const deadlines = db.prepare('SELECT count(*) AS n FROM deadlines WHERE date >= ? AND date <= ?').get(from, to).n;

  const sections = [...by.values()].filter(s => s.items.length);
  return { sections, deadlines, pending: pending.length, empty: sections.length === 0 };
}

// What one saved notes file added. `file` is the ingest result for it ({fileId, status, counts}).
// The facts are the stored rows that file wrote; goals are the goal documents it wrote; `asked`
// counts the open Confirm questions it raised. With the engine off nothing is read from the note
// (the file waits with status waiting_for_engine), and understood says so rather than listing nothing.
export function understoodOf(db, file, { engineOn = true } = {}) {
  const fileId = file && file.fileId;
  const facts = [];
  for (const r of db.prepare('SELECT key, value, confirmed FROM facts WHERE file_id = ? ORDER BY key').all(fileId)) {
    const f = FACT_BY_KEY.get(r.key);
    if (!f) continue;
    const value = f[3](parse(r.value, undefined));
    if (value == null) continue;
    facts.push({ key: r.key, label: f[2], value, confirmed: !!r.confirmed });
  }
  const goals = [];
  for (const r of db.prepare("SELECT fields FROM documents WHERE file_id = ? AND doc_type = 'goal' ORDER BY id").all(fileId)) {
    const g = parse(r.fields, {});
    const title = typeof g.title === 'string' ? g.title.trim() : '';
    if (title) goals.push({ title, when: typeof g.when === 'string' ? g.when.trim() : '' });
  }
  const asked = db.prepare("SELECT count(*) AS n FROM confirm_items WHERE file_id = ? AND status = 'pending'").get(fileId).n;
  const status = file && file.status ? file.status : 'unknown';
  return { fileId, status, engineOn: !!engineOn, waiting: ['waiting_for_engine', 'budget_exhausted', 'needs_confirmation', 'needs_clarification', 'needs_source_text'].includes(status), facts, goals, asked };
}
