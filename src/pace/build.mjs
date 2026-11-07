import { getSetting, parseJson as parse } from '../store/db.mjs';
import { goalPace, paceRollup, monthlyPace, paceMeter, finite, isoDate } from '../calc/pace.mjs';

const sum = values => Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
const endOfMonth = period => /^\d{4}-\d{2}$/.test(period ?? '')
  ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
const rows = (table, ids) => ({ table, ids, count: ids.length });
const sourceRows = (table, ids) => ({ rows: rows(table, ids) });
const earliest = dates => dates.length && dates.every(isoDate) ? dates.toSorted()[0] : null;

export function paceClock(db, override) {
  const clock = override || getSetting(db, 'clock', null) || new Date().toISOString().slice(0, 10);
  if (!isoDate(clock)) throw new TypeError('Pace requires an ISO clock date');
  return clock;
}

function actualValue(v, dependencies, sources, label = 'Tracked stored value') {
  return { v, src: 'calc:pace', kind: 'a', label, dataThrough: earliest(dependencies.map(d => d.asOf)), dependencies,
    locator: { sources } };
}

function accountHistory(db, id, clock) {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) return [];
  const snapshots = new Map();
  const positions = db.prepare('SELECT id, as_of, value, quantity, price FROM positions WHERE account_id = ? AND as_of <= ? ORDER BY as_of, id').all(id, clock);
  for (const p of positions) {
    if (!isoDate(p.as_of)) continue;
    const snap = snapshots.get(p.as_of) || { values: [], ids: [] };
    snap.values.push(finite(p.value) ? p.value : finite(p.quantity) && finite(p.price) ? p.quantity * p.price : null);
    snap.ids.push(p.id);
    snapshots.set(p.as_of, snap);
  }
  const out = new Map([...snapshots].map(([date, s]) => [date,
    s.values.every(finite) ? actualValue(sum(s.values), [{ kind: 'brokerage_positions', asOf: date }], [sourceRows('positions', s.ids)]) : null]));
  for (const b of db.prepare('SELECT id, date, amount FROM balances WHERE account_id = ? AND date <= ? ORDER BY date, id').all(id, clock)) {
    if (!isoDate(b.date)) continue;
    out.set(b.date, finite(b.amount) ? actualValue(b.amount, [{ kind: 'balances', asOf: b.date }], [sourceRows('balances', [b.id])]) : null);
  }
  return [...out].toSorted(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

function combine(values) {
  if (!values.length || values.some(v => !v || !finite(v.v))) return null;
  return actualValue(sum(values.map(v => v.v)), values.flatMap(v => v.dependencies), values.flatMap(v => v.locator.sources));
}

function makeReader(db, clock) {
  const histories = new Map();
  const history = id => {
    if (!histories.has(id)) histories.set(id, accountHistory(db, id, clock));
    return histories.get(id);
  };
  function dependency(table, id, seen) {
    if (table === 'figures') return figure(id, seen);
    const columns = {
      balances: ['id', 'date', 'balances'], positions: ['id', 'as_of', 'brokerage_positions'],
      transactions: ['id', 'date', 'bank_csv'], pnl_lines: ['id', 'period', 'pnl_workbook'],
      tax_payments: ['id', 'date', 'tax_payments'], facts: ['key', 'as_of', 'notes'],
      documents: ['id', null, null],
    };
    const spec = columns[table];
    if (!spec) return null;
    const [key, column, kind] = spec;
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id);
    if (!row) return null;
    let date = column ? row[column] : null;
    let cadenceKind = kind;
    if (table === 'pnl_lines') date = endOfMonth(date);
    if (table === 'facts') {
      const f = parse(row.value, {});
      date = f?.asOf || row.as_of;
      cadenceKind = 'balances';
    }
    if (table === 'documents') {
      const fields = parse(row.fields, {});
      date = fields.asOf || fields.payDate || fields.date;
      cadenceKind = row.doc_type === 'paystub' ? 'paystub' : 'tax_doc';
    }
    return { dependencies: [{ kind: cadenceKind, asOf: date }], locator: { sources: [sourceRows(table, [id])] } };
  }
  function figure(key, seen = new Set()) {
    if (seen.has(key)) return null;
    const next = new Set(seen).add(key);
    const f = db.prepare('SELECT * FROM figures WHERE key = ?').get(key);
    if (!f || f.kind !== 'a' || f.unavailable_reason || !finite(f.v)) return null;
    const loc = parse(f.locator, null);
    let deps;
    if (loc?.rows && Array.isArray(loc.rows.ids) && loc.rows.ids.length && (loc.rows.count ?? loc.rows.ids.length) === loc.rows.ids.length) {
      deps = loc.rows.ids.map(id => dependency(loc.rows.table, id, next));
    } else if (f.parser === 'demo-seed' && isoDate(loc?.asOf) && loc?.cadenceKind) {
      deps = [{ dependencies: [{ kind: loc.cadenceKind, asOf: loc.asOf }], locator: { sources: [sourceRows('figures', [key])] } }];
    } else return null;
    if (deps.some(d => !d)) return null;
    const value = actualValue(f.v, deps.flatMap(d => d.dependencies), [sourceRows('figures', [key]), ...deps.flatMap(d => d.locator.sources)], f.label);
    if (!value.dataThrough || value.dependencies.some(d => !isoDate(d.asOf) || d.asOf > clock)) return null;
    return value;
  }
  function tracked(goal) {
    const tr = goal.track;
    if (tr?.figure) return figure(tr.figure);
    if (!Array.isArray(tr?.accounts) || !tr.accounts.length) return null;
    return combine([...new Set(tr.accounts)].map(id => history(id).at(-1)?.value));
  }
  function observations(goal) {
    if (goal.track?.figure) {
      const value = figure(goal.track.figure);
      return value ? [value] : [];
    }
    const ids = [...new Set(goal.track?.accounts || [])];
    if (!ids.length) return [];
    const months = new Set(ids.flatMap(id => history(id).map(s => s.date.slice(0, 7))));
    return [...months].toSorted().flatMap(month => {
      const value = combine(ids.map(id => history(id).filter(s => s.date.slice(0, 7) === month).at(-1)?.value));
      return value ? [value] : [];
    });
  }
  return { tracked, observations, figure };
}

export function captureGoalPath(db, goal, clock) {
  const a = makeReader(db, clock).tracked(goal);
  if (!a || !finite(a.v) || !a.dataThrough) return null;
  return { startDate: a.dataThrough, startValue: a.v, sources: a.locator.sources };
}

export function goalPathChanged(previous, next) {
  const tracking = tr => tr?.accounts ? { accounts: [...new Set(tr.accounts)].toSorted() } : tr ?? null;
  return previous.target !== next.target || previous.targetDate !== next.targetDate
    || JSON.stringify(tracking(previous.track)) !== JSON.stringify(tracking(next.track));
}

function factOf(db, key) {
  const r = db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
  if (!r || !r.confirmed || r.src === 'planner') return null;
  return { row: r, value: parse(r.value, null), source: sourceRows('facts', [key]) };
}

function factFigure(fact, field, kind = 'a') {
  const v = fact?.value?.[field];
  if (!finite(v) || v < 0) return null;
  const date = fact.value.asOf || fact.row.as_of;
  const out = actualValue(v, [{ kind: 'balances', asOf: date }], [fact.source], field);
  out.kind = kind;
  return out;
}

function metersOf(db, clock, reader) {
  const year = clock.slice(0, 4);
  const retirement = factOf(db, `pace.retirement.${year}`);
  const tax = factOf(db, `pace.tax.${year}`);
  const income = factOf(db, `pace.income.${year}`);
  const incomeActual = reader.figure('inc.ytd.total');
  const result = (used, limit) => ({ ...paceMeter({ used, limit, clock }), deadline: `${year}-12-31` });
  return {
    retirement: result(factFigure(retirement, 'used'), factFigure(retirement, 'limit', 't')),
    tax: result(factFigure(tax, 'reserved'), factFigure(tax, 'owed', 'e')),
    income: result(incomeActual?.dataThrough?.startsWith(year) ? incomeActual : null, factFigure(income, 'annualPlan', 't')),
  };
}

function savingsSeries(db, clock) {
  const fact = factOf(db, `pace.householdSavings.${clock.slice(0, 4)}`);
  if (!fact || !fact.value || !Array.isArray(fact.value.observations)) return { series: null, reason: 'missing_household_savings_plan', dataEnd: null };
  const value = fact.value;
  const goal = { id: 'householdSavings', target: value.target, targetDate: value.targetDate,
    pace: { startDate: value.startDate, startValue: value.startValue }, planSources: [fact.source] };
  const observations = value.observations.filter(o => isoDate(o?.date) && finite(o.value))
    .map(o => actualValue(o.value, [{ kind: 'balances', asOf: o.date }], [fact.source]));
  return monthlyPace({ goal, observations, clock });
}

export function buildPace(db, { clock: override } = {}) {
  const clock = paceClock(db, override);
  const reader = makeReader(db, clock);
  const defs = db.prepare('SELECT id, def FROM goals WHERE archived_at IS NULL ORDER BY sort, created_at, id').all()
    .map(r => ({ ...parse(r.def, {}), id: r.id })).filter(g => g.status !== 'done');
  const goals = defs.map(goal => goalPace({ goal, actual: reader.tracked(goal), clock }));
  return { clock, rollup: paceRollup(goals, clock), goals,
    series: { goals: Object.fromEntries(defs.map(goal => [goal.id, monthlyPace({ goal, observations: reader.observations(goal), clock })])),
      householdSavings: savingsSeries(db, clock) }, meters: metersOf(db, clock, reader) };
}

export function indexPaceFigures(pace) {
  const figures = {};
  function visit(value, key) {
    if (!value || typeof value !== 'object') return;
    if (finite(value.v) && value.src && value.locator) { figures[key] = value; return; }
    for (const [k, v] of Object.entries(value)) visit(v, `${key}.${k}`);
  }
  visit(pace, 'pace');
  return figures;
}
