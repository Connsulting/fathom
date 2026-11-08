// Business P&L: per entity income, expenses and net by month. A month with at least one workbook
// line for the entity uses the workbook; any other month uses the entity's categorized
// business-account transactions. The two are never added for one month.
//
// pnlEntities({db, clock}) -> [{key, label, kind, accounts, workbook, transactions}]
// businessPnl({db, entity, from, to, clock}) -> see docs/architecture.md "P&L and household spending"
// businessPnlRows({db, entity, from, to, section, category, month, clock}) -> {items, total, sum, figures, sources, note}
//   sum: a figure over every matching row (not just the capped items), equal to the cell it opens from.
//   Each item: amount (raw signed), value (counted: income as is, expenses negated) and fig (at value).

import { ledgerDisplayName, ledgerKind, businessEntry, summaryPerson } from './ledgers.mjs';
import { normalizeName } from '../ingest/confirm.mjs';
import { businessAccount } from '../categories/resolve.mjs';
import {
  PnlError, ITEM_LIMIT, boundedRows, accountLabels, addMonths, byDateDesc, checkDb, checkMonth, checkRange, classified, clockOf, enc,
  figureRegistry, fileNames, lineRow, monthSums, ownerFact, rowItem, runsLabel, spanLabel, sumOf, txnRow,
} from './shared.mjs';

const SECTIONS = ['income', 'expenses'];
const UNCATEGORIZED = 'Uncategorized';
const LEFT_OUT = [
  ['transfer', 'Transfers'],
  ['tax', 'Taxes'],
  ['saving', 'Saving or investing'],
  ['excluded', 'Excluded'],
  ['personal', 'Personal spending'],
];
const LEFT_LABEL = Object.fromEntries(LEFT_OUT);

// ---------------------------------------------------------------- entities

function loadBusiness(db, clock) {
  const clockMonth = clock.slice(0, 7);
  const base = classified(db, clock);
  const labels = accountLabels(db);
  const lines = db.prepare('SELECT * FROM pnl_lines WHERE period <= ? ORDER BY period, id').all(clockMonth);
  const alias = new Map(db.prepare('SELECT alias, entity FROM entity_aliases').all().map((r) => [normalizeName(r.alias), r.entity]));
  const canon = (name) => {
    const target = alias.get(normalizeName(name));
    return typeof target === 'string' && normalizeName(target)
      ? { norm: normalizeName(target), label: target.trim() }
      : { norm: normalizeName(name), label: String(name).trim() };
  };

  const names = new Map();
  const addName = (n) => {
    if (typeof n !== 'string' || !normalizeName(n)) return;
    const c = canon(n);
    if (!names.has(c.norm)) names.set(c.norm, c.label);
  };
  const listed = ownerFact(db, 'business.entities');
  if (Array.isArray(listed)) for (const e of listed) addName(e && e.name);
  for (const l of lines) addName(l.entity);
  const statedFact = ownerFact(db, 'accounts.businessEntity');
  const stated = statedFact && typeof statedFact === 'object' && !Array.isArray(statedFact) ? statedFact : {};
  for (const v of Object.values(stated)) addName(v);

  const ledgerFacts = { 'pnl.ledgers': ownerFact(db, 'pnl.ledgers'), 'business.entities': listed,
    'household.names': ownerFact(db, 'household.names'), 'pnl.people': ownerFact(db, 'pnl.people') };
  const businessNames = [...names.keys()].filter(n => !['spending', 'inactive', 'income_history'].includes(ledgerKind(ledgerFacts, names.get(n), lines.filter(l => canon(l.entity).norm === n))));
  const only = businessNames.length === 1 ? businessNames[0] : null;
  const owner = new Map();
  for (const a of base.accounts.filter(businessAccount)) {
    const entityName = stated[a.id] || a.entity || (Array.isArray(listed) ? listed.find(e => e?.accountIds?.includes(a.id))?.name : null);
    const named = typeof entityName === 'string' && entityName.trim() ? canon(entityName).norm : null;
    owner.set(a.id, named && !businessNames.includes(named) ? null : named ?? only);
  }
  const txnsOf = new Map();
  for (const t of base.transactions) {
    if (!owner.has(t.account_id)) continue;
    if (!txnsOf.has(t.account_id)) txnsOf.set(t.account_id, []);
    txnsOf.get(t.account_id).push(t);
  }
  const accountRef = (id) => ({ id, label: labels.get(id)?.label ?? id });

  const build = (key, label, kind, accountIds, entityLines) => {
    const txns = accountIds.flatMap((id) => txnsOf.get(id) ?? []).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    if (!entityLines.length && !txns.length) return null;
    // A workbook category is income when all the entity's lines in it sum positive, else expense.
    const totals = new Map();
    for (const l of entityLines) totals.set(l.category, (totals.get(l.category) ?? 0) + l.amount);
    const lineSection = new Map([...totals].map(([c, s]) => [c, s > 0 ? 'income' : 'expenses']));
    const byMonth = (rows, monthOf) => {
      const m = new Map();
      for (const r of rows) { const k = monthOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    return {
      key, label, kind, accounts: accountIds.map(accountRef), lines: entityLines, txns, lineSection,
      ...(['spending', 'income_history'].includes(kind) ? { person: summaryPerson({ name: entityLines[0]?.entity || label, displayName: label }, ledgerFacts)?.person ?? (kind === 'income_history' ? 'owner' : null) } : {}),
      linesByMonth: byMonth(entityLines, (l) => l.period), txnsByMonth: byMonth(txns, (t) => t.date.slice(0, 7)),
    };
  };

  const entities = [];
  for (const [norm, label] of names) {
    const ids = [...owner].filter(([, n]) => n === norm).map(([id]) => id);
    const entityLines = lines.filter(l => canon(l.entity).norm === norm);
    const displayName = entityLines.length ? ledgerDisplayName(entityLines[0]) : label;
    const classification = ledgerKind(ledgerFacts, label, entityLines);
    const kind = ['spending', 'inactive', 'income_history'].includes(classification) ? classification : 'entity';
    const e = build(`entity:${norm}`, displayName, kind, ['spending', 'inactive', 'income_history'].includes(kind) ? [] : ids, entityLines);
    if (e) entities.push(e);
  }
  entities.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  for (const [id, n] of owner) {
    if (n !== null) continue;
    const e = build(`account:${id}`, labels.get(id)?.label ?? id, 'account', [id], []);
    if (e) entities.push(e);
  }
  return { entities, canon, resolved: base.resolved, labels, files: fileNames(db) };
}

const publicEntity = (e) => ({
  key: e.key, label: e.label, kind: e.kind, accounts: e.accounts,
  ...(['spending', 'income_history'].includes(e.kind) ? { person: e.person, ...(e.kind === 'income_history' ? { inactive: true } : {}) } : {}),
  workbook: e.lines.length ? { from: e.lines[0].period, to: e.lines.at(-1).period, lines: e.lines.length } : null,
  transactions: e.txns.length ? { from: e.txns[0].date.slice(0, 7), to: e.txns.at(-1).date.slice(0, 7), rows: e.txns.length } : null,
});

export function pnlEntities({ db, clock } = {}) {
  checkDb(db);
  return loadBusiness(db, clockOf(db, clock)).entities.filter(e => e.kind !== 'inactive').map(publicEntity);
}

function findEntity(model, entity) {
  if (typeof entity !== 'string' || !entity.trim()) throw new PnlError('bad_input', 'entity is required');
  const byKey = model.entities.find((e) => e.key === entity);
  if (byKey) return byKey;
  const n = normalizeName(entity) && model.canon(entity).norm;
  const hit = n && model.entities.find((e) => e.kind !== 'account' && e.key === `entity:${n}`);
  if (!hit) throw new PnlError('unknown_entity', 'no P&L for that entity');
  return hit;
}

function rangeOf(entity, from, to) {
  checkMonth(from, 'from');
  checkMonth(to, 'to');
  const latest = [entity.lines.at(-1)?.period, entity.txns.at(-1)?.date.slice(0, 7)].filter(Boolean).sort().at(-1);
  const end = to ?? latest;
  const start = from ?? `${end.slice(0, 4)}-01`;
  return { from: start, to: end, months: checkRange(start, end) };
}

// ---------------------------------------------------------------- the per-month analysis

// Rows behind each cell for a list of months. Row values: income as is, expenses negated, left out
// as the net outflow.
function analyze(entity, months, resolved) {
  const perMonth = months.map((month) => {
    const lines = entity.linesByMonth.get(month) ?? [];
    const txns = entity.txnsByMonth.get(month) ?? [];
    return { month, source: lines.length ? 'workbook' : txns.length ? 'transactions' : 'none', lines, txns };
  });
  const cells = { income: new Map(), expenses: new Map() };
  const left = new Map();
  const uncategorized = [];
  const put = (section, category, month, row) => {
    const byCat = cells[section];
    if (!byCat.has(category)) byCat.set(category, new Map());
    const byMonth = byCat.get(category);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  };
  for (const pm of perMonth) {
    if (pm.source === 'workbook') {
      for (const l of pm.lines) {
        const section = entity.lineSection.get(l.category);
        put(section, l.category, pm.month, { ...lineRow(l), value: section === 'income' ? l.amount : -l.amount, section });
      }
    } else if (pm.source === 'transactions') {
      for (const t of pm.txns) {
        const c = resolved.get(t.id);
        const row = txnRow(t);
        const entry = businessEntry(t, c);
        if (entry) {
          const r = { ...row, ...entry, value: entry.section === 'income' ? t.amount : -t.amount };
          put(entry.section, entry.category, pm.month, r);
          if (c.layer === 'uncategorized' && entry.section === 'expenses') uncategorized.push(r);
        } else {
          const key = c.bucket === 'household' ? 'personal' : c.bucket;
          if (!left.has(key)) left.set(key, []);
          left.get(key).push({ ...row, value: -t.amount, category: c.category });
        }
      }
    }
  }
  return { perMonth, cells, left, uncategorized };
}

const all = (byMonth) => [...byMonth.values()].flat();
const merge = (maps) => {
  const out = new Map();
  for (const m of maps) for (const [k, rows] of m) out.set(k, [...(out.get(k) ?? []), ...rows]);
  return out;
};
const order = (list) => list.sort((a, b) => (a.category === UNCATEGORIZED) - (b.category === UNCATEGORIZED) || b.value - a.value || a.category.localeCompare(b.category));
const WORD = { income: 'Income', expenses: 'Expenses' };
const NOTE = {
  income: [],
  expenses: ['Expenses are positive; a refund or credit lowers its category.'],
};

// Figures for one analyzed range. `base` is the key prefix; `prior` builds the comparison shape.
function figuresFor(reg, base, a, months, span, sourceOf) {
  const sums = (byMonth) => monthSums(byMonth, months, sourceOf);
  const out = { income: null, expenses: null, sectionRows: {}, sectionMonth: {} };
  for (const s of SECTIONS) {
    const categories = [];
    for (const [category, byMonth] of a.cells[s]) {
      const rows = all(byMonth);
      const ck = `${base}.${s}.cat.${enc(category)}`;
      const cellMonths = {};
      for (const m of months) {
        const r = byMonth.get(m);
        cellMonths[m] = r && r.length
          ? reg.add(`${ck}.m.${m}`, { v: sumOf(r), label: `${category}, ${spanLabel(m, m)}`, rows: r, counted: true, notes: NOTE[s] })
          : null;
      }
      const total = reg.add(`${ck}.total`, { v: sumOf(rows), label: `${category}, ${span}`, rows, counted: true, notes: NOTE[s], sums: sums(byMonth) });
      categories.push({ category, total, months: cellMonths, value: sumOf(rows) });
    }
    order(categories);
    const byMonth = merge([...a.cells[s].values()]);
    const rows = all(byMonth);
    const sectionMonths = {};
    for (const m of months) {
      const r = byMonth.get(m);
      sectionMonths[m] = r && r.length
        ? reg.add(`${base}.${s}.m.${m}`, { v: sumOf(r), label: `${WORD[s]}, ${spanLabel(m, m)}`, rows: r, counted: true, notes: NOTE[s] })
        : null;
    }
    const total = rows.length
      ? reg.add(`${base}.${s}.total`, { v: sumOf(rows), label: `${WORD[s]}, ${span}`, rows, counted: true, notes: NOTE[s], sums: sums(byMonth) })
      : null;
    out[s] = { total, months: sectionMonths, categories: categories.map(({ value, ...c }) => c) };
    out.sectionRows[s] = rows;
    out.sectionMonth[s] = byMonth;
  }
  // Net: income minus expenses (expense row values are already negated amounts).
  const netByMonth = new Map();
  for (const s of SECTIONS) {
    for (const [m, rows] of out.sectionMonth[s]) {
      const signed = rows.map((r) => ({ ...r, value: s === 'income' ? r.value : -r.value }));
      netByMonth.set(m, [...(netByMonth.get(m) ?? []), ...signed]);
    }
  }
  const netNote = ['Net is income minus expenses.'];
  const netMonths = {};
  for (const m of months) {
    const r = netByMonth.get(m);
    netMonths[m] = r && r.length ? reg.add(`${base}.net.m.${m}`, { v: sumOf(r), label: `Net, ${spanLabel(m, m)}`, rows: r, counted: true, notes: netNote }) : null;
  }
  const netRows = all(netByMonth);
  out.net = {
    total: netRows.length ? reg.add(`${base}.net.total`, { v: sumOf(netRows), label: `Net, ${span}`, rows: netRows, counted: true, notes: netNote, sums: sums(netByMonth) }) : null,
    months: netMonths,
  };
  return out;
}

function monthSourcesFor(reg, base, a) {
  return a.perMonth.map((pm) => {
    const covered = pm.source === 'workbook' ? pm.txns.map((t) => ({ ...txnRow(t), value: t.amount })) : [];
    return {
      month: pm.month, source: pm.source, workbookLines: pm.lines.length, transactionRows: pm.txns.length,
      covered: {
        rows: covered.length,
        amount: covered.length ? reg.add(`${base}.covered.${pm.month}`, {
          v: sumOf(covered), label: `Transactions not counted, ${spanLabel(pm.month, pm.month)}`, rows: covered,
          notes: ['This month uses the imported workbook, so these transactions are not counted.'],
        }) : null,
      },
    };
  });
}

function compute(model, entity, from, to) {
  const r = rangeOf(entity, from, to);
  const reg = figureRegistry({ kind: 'pnl', labels: model.labels, files: model.files });
  const base = `pnl.${enc(entity.key)}.${r.from}.${r.to}`;
  const a = analyze(entity, r.months, model.resolved);
  return { r, reg, base, a };
}

export function businessPnl({ db, entity, from, to, clock } = {}) {
  checkDb(db);
  const c = clockOf(db, clock);
  const model = loadBusiness(db, c);
  const e = findEntity(model, entity);
  const { r, reg, base, a } = compute(model, e, from, to);
  const span = spanLabel(r.from, r.to);
  const sourceOf = (m) => a.perMonth.find((p) => p.month === m).source;
  const f = figuresFor(reg, base, a, r.months, span, sourceOf);
  const monthSources = monthSourcesFor(reg, base, a);

  // The same months one year earlier, computed the same way.
  let prior = null;
  const pFrom = addMonths(r.from, -12);
  const pTo = addMonths(r.to, -12);
  const pa = analyze(e, r.months.map((m) => addMonths(m, -12)), model.resolved);
  if (pa.perMonth.some((p) => p.source !== 'none')) {
    const pSpan = spanLabel(pFrom, pTo);
    const pBase = `${base}.prior`;
    const sectionRows = Object.fromEntries(SECTIONS.map((s) => [s, [...pa.cells[s].values()].flatMap(all)]));
    const totalOf = (s) => {
      const rows = sectionRows[s];
      return rows.length ? reg.add(`${pBase}.${s}`, { v: sumOf(rows), label: `${WORD[s]} last year, ${pSpan}`, rows, counted: false, notes: NOTE[s] }) : null;
    };
    const netRows = SECTIONS.flatMap((s) => sectionRows[s].map((x) => ({ ...x, value: s === 'income' ? x.value : -x.value })));
    const categories = {};
    for (const s of SECTIONS) {
      categories[s] = {};
      for (const [category, byMonth] of pa.cells[s]) {
        const rows = all(byMonth);
        categories[s][category] = reg.add(`${pBase}.cat.${s}.${enc(category)}`, { v: sumOf(rows), label: `${category} last year, ${pSpan}`, rows, counted: false, notes: NOTE[s] });
      }
    }
    prior = {
      from: pFrom, to: pTo, monthSources: monthSourcesFor(reg, pBase, pa),
      income: totalOf('income'), expenses: totalOf('expenses'),
      net: netRows.length ? reg.add(`${pBase}.net`, { v: sumOf(netRows), label: `Net last year, ${pSpan}`, rows: netRows, counted: false, notes: ['Net is income minus expenses.'] }) : null,
      categories,
    };
  }

  const leftOut = LEFT_OUT.filter(([k]) => a.left.has(k)).map(([key, label]) => {
    const rows = a.left.get(key);
    return {
      key, label, rows: rows.length,
      amount: reg.add(`${base}.left.${key}`, {
        v: sumOf(rows), label: `${label} left out, ${span}`, rows,
        notes: ['These business-account transactions are not income or business expenses, so the P&L leaves them out.'],
      }),
    };
  });

  const expenseTotal = sumOf(f.sectionRows.expenses);
  const uncAmount = sumOf(a.uncategorized);
  const uncategorized = {
    rows: a.uncategorized.length,
    amount: a.uncategorized.length ? reg.add(`${base}.uncategorized`, {
      v: uncAmount, label: `Uncategorized expenses, ${span}`, rows: a.uncategorized, counted: true,
      notes: ['Outflows with no category count as expenses under Uncategorized until they are categorized.'],
    }) : null,
    share: expenseTotal > 0 ? Math.min(1, Math.max(0, uncAmount / expenseTotal)) : 0,
  };

  const wbMonths = a.perMonth.filter((p) => p.source === 'workbook').map((p) => p.month);
  const txMonths = a.perMonth.filter((p) => p.source === 'transactions').map((p) => p.month);
  const coveredRows = monthSources.reduce((s, m) => s + m.covered.rows, 0);
  const notes = [];
  const use = (list) => (list.length === 1 ? 'uses' : 'use');
  if (wbMonths.length) notes.push(coveredRows
    ? `${runsLabel(wbMonths)} ${use(wbMonths)} the imported workbook; transactions in ${wbMonths.length === 1 ? 'that month are' : 'those months are'} not counted.`
    : `${runsLabel(wbMonths)} ${use(wbMonths)} the imported workbook.`);
  if (txMonths.length) notes.push(`${runsLabel(txMonths)} ${use(txMonths)} categorized business transactions.`);
  if (!wbMonths.length && !txMonths.length) notes.push(`There is no business data for ${span}.`);
  if (leftOut.length) notes.push(`${leftOut.map((l) => l.label).join(', ')} on the business accounts are left out.`);
  if (uncategorized.rows) notes.push('Uncategorized outflows count as expenses until they are categorized.');

  return {
    entity: publicEntity(e),
    from: r.from, to: r.to, months: r.months, monthSources,
    income: f.income, expenses: f.expenses, net: f.net, prior, leftOut, uncategorized, notes,
    ...reg.done(),
  };
}

export function businessPnlRows({ db, entity, from, to, section, category, month, clock } = {}) {
  checkDb(db);
  const c = clockOf(db, clock);
  if (!SECTIONS.includes(section)) throw new PnlError('bad_option', 'section must be income or expenses');
  if (typeof category !== 'string' || !category) throw new PnlError('bad_input', 'category is required');
  checkMonth(month, 'month');
  const model = loadBusiness(db, c);
  const e = findEntity(model, entity);
  const { r, reg, base, a } = compute(model, e, from, to);
  if (month != null && !r.months.includes(month)) throw new PnlError('bad_range', 'month is outside the range');
  const byMonth = a.cells[section].get(category);
  const rows = (byMonth ? (month ? byMonth.get(month) ?? [] : all(byMonth)) : []).sort(byDateDesc);
  const fileName = (id) => (id && model.files.get(id)) || 'Imported workbook';
  const items = rows.slice(0, ITEM_LIMIT).map((row) => rowItem(reg, `${base}.row.${row.table === 'pnl_lines' ? 'w' : 't'}.${row.id}`, row, {
    account: row.table === 'pnl_lines' ? fileName(row.fileId) : (model.labels.get(row.accountId)?.label ?? row.accountId),
    category,
    label: row.table === 'pnl_lines' ? `Workbook line, ${spanLabel(row.month, row.month)}` : `Transaction on ${row.date}`,
  }));
  const where = month ? spanLabel(month, month) : spanLabel(r.from, r.to);
  const sum = reg.add(`${base}.rows.${section}.${enc(category)}.${month ?? 'total'}`, { v: sumOf(rows), label: `${category}, ${where}`, rows, counted: true, notes: NOTE[section] });
  const covered = a.perMonth.some((p) => p.source === 'workbook' && p.txns.length && (!month || p.month === month));
  const note = `Rows behind ${category} ${section === 'income' ? 'income' : 'expenses'}, ${where}.`
    + (covered ? ' Transactions in months that use the imported workbook are not counted and not listed.' : '');
  return boundedRows({ items, total: rows.length, sum, ...reg.done(), note });
}
