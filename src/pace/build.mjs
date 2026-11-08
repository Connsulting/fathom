import { getSetting, parseJson as parse } from '../store/db.mjs';
import { goalPace, paceRollup, monthlyPace, paceMeter, finite, isoDate, rangePace, rangeGoal, floorPace, contributionPace,
  qualifyingContributions, MOVE_DAYS } from '../calc/pace.mjs';
import { kindOf, isGoalOwner, PRIORITIES, PERSONS } from '../shared/goals.mjs';
import { ownerOf } from '../jobs/planner/data.mjs';
import { filterSeries, flatMapSeries, mapSeries } from '../shared/series.mjs';

const sum = values => Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
const endOfMonth = period => /^\d{4}-\d{2}$/.test(period ?? '')
  ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
const rows = (table, ids) => ({ table, ids, count: ids.length });
const sourceRows = (table, ids) => ({ rows: rows(table, ids) });
const earliest = dates => dates.length && dates.every(isoDate) ? dates.toSorted()[0] : null;

export async function paceClock(db, override) {
  const clock = override || await getSetting(db, 'clock', null) || new Date().toISOString().slice(0, 10);
  if (!isoDate(clock)) throw new TypeError('Pace requires an ISO clock date');
  return clock;
}

function actualValue(v, dependencies, sources, label = 'Tracked stored value') {
  return { v, src: 'calc:pace', kind: 'a', label, dataThrough: earliest(dependencies.map(d => d.asOf)), dependencies,
    locator: { sources } };
}

// One account's stored values up to the clock, oldest first: [{date, value}], value an actual figure
// (balances, or positions summed per as_of date) or null when a snapshot is incomplete.
export async function accountHistory(db, id, clock) {
  if (!await db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) return [];
  const snapshots = new Map();
  const positions = await db.prepare('SELECT id, as_of, value, quantity, price FROM positions WHERE account_id = ? AND as_of <= ? ORDER BY as_of, id').all(id, clock);
  for (const p of positions) {
    if (!isoDate(p.as_of)) continue;
    const snap = snapshots.get(p.as_of) || { values: [], ids: [] };
    snap.values.push(finite(p.value) ? p.value : finite(p.quantity) && finite(p.price) ? p.quantity * p.price : null);
    snap.ids.push(p.id);
    snapshots.set(p.as_of, snap);
  }
  const out = new Map([...snapshots].map(([date, s]) => [date,
    s.values.every(finite) ? actualValue(sum(s.values), [{ kind: 'brokerage_positions', asOf: date }], [sourceRows('positions', s.ids)]) : null]));
  for (const b of await db.prepare('SELECT id, date, amount FROM balances WHERE account_id = ? AND date <= ? ORDER BY date, id').all(id, clock)) {
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
  const history = async id => {
    if (!histories.has(id)) histories.set(id, await accountHistory(db, id, clock));
    return histories.get(id);
  };
  async function dependency(table, id, seen) {
    if (table === 'figures') return await figure(id, seen);
    const columns = {
      balances: ['id', 'date', 'balances'], positions: ['id', 'as_of', 'brokerage_positions'],
      transactions: ['id', 'date', 'bank_csv'], pnl_lines: ['id', 'period', 'pnl_workbook'],
      tax_payments: ['id', 'date', 'tax_payments'], facts: ['key', 'as_of', 'notes'],
      documents: ['id', null, null],
    };
    const spec = columns[table];
    if (!spec) return null;
    const [key, column, kind] = spec;
    const row = await db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id);
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
  async function figure(key, seen = new Set()) {
    if (seen.has(key)) return null;
    const next = new Set(seen).add(key);
    const f = await db.prepare('SELECT * FROM figures WHERE key = ?').get(key);
    if (!f || f.kind !== 'a' || f.unavailable_reason || !finite(f.v)) return null;
    const loc = parse(f.locator, null);
    let deps;
    if (loc?.rows && Array.isArray(loc.rows.ids) && loc.rows.ids.length && (loc.rows.count ?? loc.rows.ids.length) === loc.rows.ids.length) {
      deps = await mapSeries(loc.rows.ids, async id => await dependency(loc.rows.table, id, next));
    } else if (f.parser === 'demo-seed' && isoDate(loc?.asOf) && loc?.cadenceKind) {
      deps = [{ dependencies: [{ kind: loc.cadenceKind, asOf: loc.asOf }], locator: { sources: [sourceRows('figures', [key])] } }];
    } else return null;
    if (deps.some(d => !d)) return null;
    const value = actualValue(f.v, deps.flatMap(d => d.dependencies), [sourceRows('figures', [key]), ...deps.flatMap(d => d.locator.sources)], f.label);
    if (!value.dataThrough || value.dependencies.some(d => !isoDate(d.asOf) || d.asOf > clock)) return null;
    return value;
  }
  async function tracked(goal) {
    const tr = goal.track;
    if (tr?.figure) return await figure(tr.figure);
    if (!Array.isArray(tr?.accounts) || !tr.accounts.length) return null;
    return combine(await mapSeries([...new Set(tr.accounts)], async id => (await history(id)).at(-1)?.value));
  }
  async function observations(goal) {
    if (goal.track?.figure) {
      const value = await figure(goal.track.figure);
      if (!value) return [];
      const accountIds = new Set();
      let complete = true;
      for (const s of value.locator.sources.filter(s => s.rows?.table !== 'figures')) {
        if (!['balances', 'positions'].includes(s.rows?.table)) { complete = false; break; }
        for (const id of s.rows.ids) {
          const row = await db.prepare(`SELECT account_id FROM ${s.rows.table} WHERE id = ?`).get(id);
          if (row) accountIds.add(row.account_id); else complete = false;
        }
      }
      if (complete && accountIds.size) {
        const ids = [...accountIds];
        const latest = combine(await mapSeries(ids, async id => (await history(id)).filter(s => s.date <= value.dataThrough).at(-1)?.value));
        if (latest && latest.v === value.v) return [...await accountMonths(ids, value.dataThrough), value];
      }
      return [value];
    }
    const ids = [...new Set(goal.track?.accounts || [])];
    return await accountMonths(ids, clock);
  }
  async function accountMonths(ids, through) {
    if (!ids.length) return [];
    const before = async id => (await history(id)).filter(s => s.date <= through);
    const months = new Set(await flatMapSeries(ids, async id => (await before(id)).map(s => s.date.slice(0, 7))));
    return await flatMapSeries([...months].toSorted(), async month => {
      const value = combine(await mapSeries(ids, async id => (await before(id)).filter(s => s.date.slice(0, 7) === month).at(-1)?.value));
      return value ? [value] : [];
    });
  }
  // Progress toward a contribution goal: {actual, basis, people: [{person, actual}], reason}.
  // Transactions are the basis only when every destination account has a transaction in the tax
  // year up to the clock; otherwise the entered amount; otherwise no progress source, with
  // partial_contribution_coverage when some but not all accounts are covered.
  async function contributions(goal) {
    const year = goal.taxYear;
    const ids = Number.isInteger(year) && Array.isArray(goal.accounts)
      ? await filterSeries([...new Set(goal.accounts)], async id => typeof id === 'string' && await db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) : [];
    const start = `${year}-01-01`;
    const end = [`${year}-12-31`, clock].toSorted()[0];
    const latest = db.prepare('SELECT id, date FROM transactions WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1');
    const coverage = new Map(await flatMapSeries(ids, async id => {
      const row = await latest.get(id, start, end);
      return row ? [[id, row]] : [];
    }));
    if (ids.length && coverage.size === ids.length) {
      // Debits a few days either side of the year are read so a move across the year end still pairs.
      const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
      const rows = await db.prepare(`SELECT t.id, t.account_id, t.date, t.amount, t.description, coalesce(i.category, t.category) AS category
        FROM transactions t LEFT JOIN transaction_category_imports i ON i.transaction_id = t.id
        WHERE t.account_id IN (${ids.map(() => '?').join(', ')}) AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.id`)
        .all(...ids, shift(start, -MOVE_DAYS), [shift(end, MOVE_DAYS), clock].toSorted()[0]);
      const qualifying = qualifyingContributions(rows, ids, { taxYear: year, clock });
      const valueOf = accountIds => {
        const mine = qualifying.filter(r => accountIds.includes(r.account_id));
        const qualifyingIds = mine.map(r => r.id);
        const coverageIds = accountIds.map(id => coverage.get(id).id).filter(id => !qualifyingIds.includes(id));
        const sources = [qualifyingIds.length ? sourceRows('transactions', qualifyingIds) : null,
          coverageIds.length ? { ...sourceRows('transactions', coverageIds), field: 'coverage' } : null,
          sourceRows('accounts', accountIds)].filter(Boolean);
        return actualValue(sum(mine.map(r => r.amount)), accountIds.map(id => ({ kind: 'bank_csv', asOf: coverage.get(id).date })), sources,
          'Contributions recorded in the tax year');
      };
      const holders = new Map(await mapSeries(ids, async id => [id, ownerOf((await db.prepare('SELECT owner FROM accounts WHERE id = ?').get(id)).owner)]));
      const attributed = [...holders.values()].every(h => PERSONS.includes(h));
      const people = attributed ? PERSONS.flatMap(person => {
        const held = ids.filter(id => holders.get(id) === person);
        return held.length ? [{ person, actual: valueOf(held) }] : [];
      }) : [];
      return { actual: valueOf(ids), basis: 'transactions', people, reason: null };
    }
    const entered = goal.entered;
    const listed = Array.isArray(entered?.people) ? entered.people.filter(p => PERSONS.includes(p?.person) && finite(p.amount)) : [];
    const total = finite(entered?.total) ? entered.total : listed.length ? sum(listed.map(p => p.amount)) : null;
    if (isoDate(entered?.asOf) && finite(total)) {
      const dependencies = [{ kind: 'balances', asOf: entered.asOf }];
      const sources = [{ rows: rows('goals', [goal.id]), field: 'entered', src: 'you' }];
      const label = 'Contributed so far, as entered';
      return { actual: actualValue(total, dependencies, sources, label), basis: 'entered',
        people: listed.map(p => ({ person: p.person, actual: actualValue(p.amount, dependencies, sources, label) })), reason: null };
    }
    const partial = coverage.size > 0 && coverage.size < ids.length;
    return { actual: null, basis: null, people: [], reason: partial ? 'partial_contribution_coverage' : null };
  }
  return { tracked, observations, figure, contributions };
}

export async function captureGoalPath(db, goal, clock) {
  const a = await makeReader(db, clock).tracked(goal);
  if (!a || !finite(a.v) || !a.dataThrough) return null;
  return { startDate: a.dataThrough, startValue: a.v, sources: a.locator.sources };
}

export function goalPathChanged(previous, next) {
  const tracking = tr => tr?.accounts ? { accounts: [...new Set(tr.accounts)].toSorted() } : tr ?? null;
  return kindOf(previous) !== kindOf(next) || previous.target !== next.target || previous.targetLow !== next.targetLow
    || previous.targetDate !== next.targetDate
    || JSON.stringify(tracking(previous.track)) !== JSON.stringify(tracking(next.track));
}

async function factOf(db, key) {
  const r = await db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
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

async function metersOf(db, clock, reader) {
  const year = clock.slice(0, 4);
  const retirement = await factOf(db, `pace.retirement.${year}`);
  const tax = await factOf(db, `pace.tax.${year}`);
  const income = await factOf(db, `pace.income.${year}`);
  const incomeActual = await reader.figure('inc.ytd.total');
  const result = (used, limit) => ({ ...paceMeter({ used, limit, clock }), deadline: `${year}-12-31` });
  return {
    retirement: result(factFigure(retirement, 'used'), factFigure(retirement, 'limit', 't')),
    tax: result(factFigure(tax, 'reserved'), factFigure(tax, 'owed', 'e')),
    income: result(incomeActual?.dataThrough?.startsWith(year) ? incomeActual : null, factFigure(income, 'annualPlan', 't')),
  };
}

async function savingsSeries(db, clock) {
  const fact = await factOf(db, `pace.householdSavings.${clock.slice(0, 4)}`);
  if (!fact || !fact.value || !Array.isArray(fact.value.observations)) return { series: null, reason: 'missing_household_savings_plan', dataEnd: null };
  const value = fact.value;
  const goal = { id: 'householdSavings', target: value.target, targetDate: value.targetDate,
    pace: { startDate: value.startDate, startValue: value.startValue }, planSources: [fact.source] };
  const observations = value.observations.filter(o => isoDate(o?.date) && finite(o.value))
    .map(o => actualValue(o.value, [{ kind: 'balances', asOf: o.date }], [fact.source]));
  return monthlyPace({ goal, observations, clock });
}

export async function buildPace(db, { clock: override } = {}) {
  const clock = await paceClock(db, override);
  const reader = makeReader(db, clock);
  // Done goals (done_at set, or a seed def whose status is done) are not paced.
  const defs = (await db.prepare('SELECT id, def FROM goals WHERE archived_at IS NULL AND done_at IS NULL ORDER BY sort, created_at, id').all())
    .map(r => ({ ...parse(r.def, {}), id: r.id })).filter(g => g.status !== 'done');
  const paceOf = async goal => {
    const kind = kindOf(goal);
    const result = kind === 'range' ? rangePace({ goal, actual: await reader.tracked(goal), clock })
      : kind === 'floor' ? floorPace({ goal, actual: await reader.tracked(goal), clock })
        : kind === 'contribution' ? contributionPace({ goal, ...await reader.contributions(goal), clock })
          : goalPace({ goal, actual: await reader.tracked(goal), clock });
    // owner here is whose goal, not origin 'owner' (typed by the owner).
    return { ...result, kind, owner: isGoalOwner(goal.owner) ? goal.owner : null, priority: PRIORITIES.includes(goal.priority) ? goal.priority : null };
  };
  const seriesOf = async goal => {
    const kind = kindOf(goal);
    if (kind === 'floor' || kind === 'contribution') return { series: null, reason: 'kind_not_charted', dataEnd: null };
    return monthlyPace({ goal: kind === 'range' ? rangeGoal(goal) : goal, observations: await reader.observations(goal), clock });
  };
  const goals = defs.map(paceOf);
  return { clock, rollup: paceRollup(goals, clock), goals,
    series: { goals: Object.fromEntries(await mapSeries(defs, async goal => [goal.id, await seriesOf(goal)])),
      householdSavings: await savingsSeries(db, clock) }, meters: await metersOf(db, clock, reader) };
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
