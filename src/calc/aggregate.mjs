import {
  resolveCategories,
  businessAccount,
  spendingAccount,
  normalizeMerchant,
  matchTransfers,
} from '../categories/resolve.mjs';
import { resolveSpendingWindow, SPENDING_KINDS, isBusinessAccount, TARGET_PARAMETERS } from './targets.mjs';
import { classOf, CATEGORY_CLASSES } from './classes.mjs';
import { envelope, round } from './figure.mjs';
import { ToolError } from '../tools/errors.mjs';
import { selectPersonalSummaries, summarySources, SUMMARY_RULE } from '../spending/summaries.mjs';
import { ownerOf } from '../jobs/planner/data.mjs';
import { payrollIncomeCategory } from '../pnl/ledgers.mjs';

export const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
export const monthAt = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const fail = (message) => {
  throw new ToolError('bad_input', message);
};
const validMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
export const sumRows = (rows, value = (t) => t.amount) => rows.reduce((s, t) => s + value(t), 0);
const latest = (rows) =>
  rows
    .map((t) => t.date)
    .sort()
    .at(-1) ?? null;

export function selectSpendingRows({
  accounts,
  transactions,
  clock,
  parameters = TARGET_PARAMETERS,
  ...categoryInput
}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const isSpending = (a) => SPENDING_KINDS.includes(a.kind) && !isBusinessAccount(a);
  const rows = transactions
    .filter((t) => byId.has(t.account_id) && Number.isFinite(t.amount) && typeof t.date === 'string' && t.date <= clock)
    .toSorted((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const monthsOf = new Map();
  for (const t of rows.filter((t) => isSpending(byId.get(t.account_id)))) {
    const set = monthsOf.get(t.account_id) ?? new Set();
    set.add(monthIndex(t.date.slice(0, 7)));
    monthsOf.set(t.account_id, set);
  }
  const resolved = resolveSpendingWindow({ accounts: accounts.filter(isSpending), monthsOf, clock, parameters });
  const onSpending = resolved.window
    ? rows.filter((t) => {
        const range = resolved.ranges.get(t.account_id),
          m = monthIndex(t.date.slice(0, 7));
        return isSpending(byId.get(t.account_id)) && range && m >= range.from && m <= range.to;
      })
    : [];
  const categories = resolveCategories({
    accounts,
    transactions: rows,
    ...categoryInput,
    transferSourceIds: onSpending.map((t) => t.id),
    transferDays: parameters.transferDays,
  });
  return {
    resolved,
    rows,
    onSpending,
    categories,
    spend: onSpending.filter((t) => t.amount < 0 && categories.get(t.id).bucket === 'household'),
    income: onSpending.filter((t) => t.amount > 0 && categories.get(t.id).bucket === 'income'),
  };
}

export function periodOf(args, clock, spendingWindow, defaultWindow = 'spending_window') {
  const mode = args.window ?? (args.from !== undefined || args.to !== undefined ? 'custom' : defaultWindow);
  if (args.year !== undefined && mode !== 'calendar_year') fail('year requires calendar_year');
  if ((args.from !== undefined || args.to !== undefined) && mode !== 'custom') fail('from and to require custom');
  let from, to;
  const end = monthIndex(clock.slice(0, 7));
  if (mode === 'spending_window') return spendingWindow ?? null;
  if (mode === 'custom') {
    from = args.from;
    to = args.to;
  } else if (mode === 'calendar_year') {
    if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100) fail('calendar_year requires year');
    from = `${args.year}-01`;
    to = `${args.year}-12`;
  } else if (mode === 'ytd') {
    from = `${clock.slice(0, 4)}-01`;
    to = clock.slice(0, 7);
  } else if (mode === 'trailing_12') {
    from = monthAt(end - 12);
    to = monthAt(end - 1);
  } else fail('Unknown window');
  if (!validMonth(from) || !validMonth(to)) fail('from and to must be valid months');
  const months = monthIndex(to) - monthIndex(from) + 1;
  if (months < 1 || months > 120) fail('Period must contain one to one hundred twenty months');
  return { from, to, months };
}

export function figureFor(
  value,
  label,
  rows,
  {
    unit = 'usd',
    window,
    gaps = [],
    formula = 'sum of selected transaction amounts',
    calc = 'aggregate',
    sources,
    packRefs = [],
    inputs = [],
    unavailable,
    accounts = [],
  } = {},
) {
  return envelope(value, {
    unit,
    label,
    kind: 'a',
    asOf: latest(rows),
    window,
    gaps,
    unavailable,
    provenance: {
      calc,
      formula,
      inputs: inputs.map((f) => ({ value: f.value, unit: f.unit, label: f.label, ...(f.ref ? { ref: f.ref } : {}) })),
      accounts,
      sources: sources ?? [{ table: 'transactions', ids: rows.slice(0, 50).map((t) => t.id), count: rows.length }],
      packRefs,
    },
  });
}
export function bindFigures(result, tool, args) {
  const visit = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (Object.hasOwn(v, 'value') && v.unit && v.kind) {
      v.ref = { tool, args: structuredClone(args), path };
      return;
    }
    for (const [k, c] of Object.entries(v)) visit(c, path ? `${path}.${k}` : k);
  };
  visit(result, '');
  return result;
}
export const unionGaps = (lists) => [
  ...new Map(lists.flat().map((g) => [JSON.stringify([g.code, g.message]), g])).values(),
];
const fieldKey = {
  buckets: 'bucket',
  categories: 'category',
  classes: 'class',
  accounts: 'account_id',
  merchants: 'merchant',
};
const matches = (t, f, values) => (f === 'merchants' ? values.map(normalizeMerchant) : values).includes(t[fieldKey[f]]);
const scopeHas = (a, scope) => scope === 'all' || (scope === 'business' ? businessAccount(a) : spendingAccount(a));
export function coverageGaps(input, window, scope = 'household') {
  if (!window) return [{ code: 'incomplete_month', message: 'No complete spending window.' }];
  const accounts = input.accounts.filter((a) => (spendingAccount(a) || businessAccount(a)) && scopeHas(a, scope));
  const missingMonths = new Set();
  const silent = [];
  for (const account of accounts) {
    const months = new Set(
      input.transactions
        .filter((t) => t.account_id === account.id && t.date <= input.clock)
        .map((t) => t.date.slice(0, 7)),
    );
    if (!months.size) {
      silent.push(account.id);
      continue;
    }
    for (let i = monthIndex(window.from); i <= monthIndex(window.to); i++) {
      const month = monthAt(i);
      if (!months.has(month)) missingMonths.add(month);
    }
  }
  for (let i = monthIndex(window.from); i <= monthIndex(window.to); i++) {
    const month = monthAt(i);
    if (month >= input.clock.slice(0, 7)) missingMonths.add(month);
  }
  return [
    ...(silent.length
      ? [
          {
            code: 'account_no_history',
            message: 'Spending accounts have no transaction history.',
            count: silent.length,
          },
        ]
      : []),
    ...(missingMonths.size
      ? [
          {
            code: 'incomplete_month',
            message: 'The requested period has incomplete or unavailable months.',
            count: missingMonths.size,
          },
        ]
      : []),
  ];
}

export function aggregate(input, args = {}, definition = null) {
  const selected = selectSpendingRows(input),
    { rows, categories, resolved, onSpending } = selected;
  const summaryMonths = input.personalSummaries?.lines.map(l => l.period).filter(m => m < input.clock.slice(0, 7)).sort() || [];
  const summaryFrom = summaryMonths.length ? monthAt(Math.max(monthIndex(summaryMonths[0]), monthIndex(summaryMonths.at(-1)) - 11)) : null;
  const summaryWindow = summaryFrom ? { from: summaryFrom, to: summaryMonths.at(-1), months: monthIndex(summaryMonths.at(-1)) - monthIndex(summaryFrom) + 1 } : null;
  const window = periodOf(args, input.clock, resolved.window || summaryWindow);
  const scope = args.scope ?? 'household',
    measure = args.measure ?? 'spending';
  const enriched = rows.map((t) => {
    const c = categories.get(t.id);
    return { ...t, ...c, person: ownerOf(input.accounts.find(a => a.id === t.account_id)?.owner) || 'unassigned', class: classOf(c.category, c.bucket), merchant: normalizeMerchant(t.description) };
  });
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const defaultWindow = (args.window ?? (args.from || args.to ? 'custom' : 'spending_window')) === 'spending_window';
  const allowed = new Set(onSpending.map((t) => t.id));
  const inWindow = (t) => window && t.date.slice(0, 7) >= window.from && t.date.slice(0, 7) <= window.to;
  const summaryDerivedWindow = !resolved.window && !!summaryWindow;
  const bankRows = enriched.filter(
    (t) =>
      inWindow(t) &&
      scopeHas(byId.get(t.account_id), scope) &&
      (!defaultWindow || summaryDerivedWindow || !spendingAccount(byId.get(t.account_id)) || allowed.has(t.id)),
  );
  const bankIds = new Set(bankRows.map(t => t.id));
  const summaryInput = input.personalSummaries ? { ...input.personalSummaries, connected: input.personalSummaries.connected.filter(t => bankIds.has(t.id)) } : null;
  const summaries = selectPersonalSummaries(summaryInput, { window, payroll: measure === 'income' });
  const windowRows = bankRows.filter(t => !(measure === 'income' && t.bucket === 'income' && payrollIncomeCategory(t.category)
    && summaries.payrollRows.some(w => w.person === t.person && t.date.slice(0, 7) >= w.from && t.date.slice(0, 7) <= w.to)));
  if (scope !== 'business') windowRows.push(...[...summaries.rows, ...(measure === 'income' ? summaries.payrollRows : [])]
    .filter(t => t.date <= input.clock || t.sourceTable === 'documents')
    .map(t => ({ ...t, class: classOf(t.category, t.bucket), merchant: normalizeMerchant(t.description) })));
  const transfers = new Set([
    ...matchTransfers(
      rows.filter((t) => t.amount < 0),
      rows.filter((t) => t.amount > 0),
    ),
    ...matchTransfers(
      rows.filter((t) => t.amount > 0),
      rows.filter((t) => t.amount < 0),
    ),
  ]);
  const base = windowRows.filter((t) => {
    if (measure === 'spending')
      return t.amount < 0 && t.bucket === (businessAccount(byId.get(t.account_id)) ? 'business' : 'household');
    if (measure === 'income') return t.amount > 0 && t.bucket === 'income';
    return (
      !transfers.has(t.id) &&
      t.bucket !== 'transfer' &&
      (measure === 'net' || (measure === 'outflow' ? t.amount < 0 : t.amount > 0))
    );
  });
  const notes = [];
  const selectors = {};
  for (const side of ['include', 'exclude']) {
    selectors[side] = { ...definition?.def?.[side], ...args[side] };
    for (const [key, value] of Object.entries(args[side] ?? {})) {
      const prior = definition?.def?.[side]?.[key];
      if (prior && JSON.stringify(prior) !== JSON.stringify(value))
        notes.push(`Explicit ${side} ${key} overrides the definition.`);
    }
  }
  const included = base.filter((t) => Object.entries(selectors.include).every(([f, vs]) => matches(t, f, vs)));
  const removed = (t) => Object.entries(selectors.exclude).some(([f, vs]) => matches(t, f, vs));
  const counted = included.filter((t) => !removed(t) && (!input.transactionIds || input.transactionIds.has(t.id)));
  const value = (t) => (['spending', 'outflow'].includes(measure) ? -t.amount : t.amount);
  const raw = sumRows(counted, value),
    scale = args.annualize && window ? 12 / window.months : 1;
  const gaps = measure === 'income' && scope !== 'business' ? [...summaries.gaps] : [];
  for (const [layer, code] of [
    ['uncategorized', 'uncategorized_rows'],
    ['guess', 'guessed_rows'],
  ]) {
    const uncertain = counted.filter((t) => t.layer === layer);
    if (uncertain.length)
      gaps.push({
        code,
        message: `Selected rows use ${layer} categories.`,
        amount: round(sumRows(uncertain, (t) => Math.abs(t.amount))),
        count: uncertain.length,
      });
  }
  const coverage = coverageGaps(input, window, scope);
  const incomplete = (resolved.incomplete ?? []).filter(
    (a) => (spendingAccount(a) || businessAccount(a)) && scopeHas(a, scope),
  );
  const noHistory = coverage.find((g) => g.code === 'account_no_history');
  if (incomplete.length) {
    const ids = new Set(incomplete.map((a) => a.id));
    for (const a of input.accounts)
      if ((spendingAccount(a) || businessAccount(a)) && scopeHas(a, scope) && !rows.some((t) => t.account_id === a.id))
        ids.add(a.id);
    if (noHistory) noHistory.count = ids.size;
    else
      coverage.push({
        code: 'account_no_history',
        message: 'Spending accounts have no complete history.',
        count: ids.size,
      });
  }
  if (defaultWindow && window && window.months < 12 && !coverage.some((g) => g.code === 'incomplete_month'))
    coverage.push({
      code: 'incomplete_month',
      message: 'The complete spending window is shorter than requested.',
      count: 12 - window.months,
    });
  gaps.push(...coverage);
  if (counted.some((t) => t.bucket === 'household' && t.class === 'unclassified'))
    gaps.push({
      code: 'unclassified_category',
      message: 'Selected household categories have no spending class.',
      count: counted.filter((t) => t.bucket === 'household' && t.class === 'unclassified').length,
    });
  if (
    counted.some((t) => t.class === 'healthcare') &&
    ['income.w2', 'income.sCorp', 'income.selfEmployment', 'income.selfEmployed'].some((k) => input.facts?.[k] === true)
  )
    gaps.push({
      code: 'outside_household_ledger',
      message: 'Healthcare paid through payroll or a business may be outside household spending.',
    });
  const opts = { window, gaps };
  const f = (v, label, rs, extra = {}) =>
    figureFor(v, label, rs, {
      ...opts,
      accounts: [...new Set(rs.map((t) => t.account_id).filter(Boolean))].map((id) => ({ id, label: byId.get(id).name })),
      sources: summarySources(rs),
      ...(rs.some(t => t.sourceTable === 'pnl_lines') ? { formula: `sum of selected amounts; ${SUMMARY_RULE}` } : {}),
      packRefs: [
        ...new Map(
          rs
            .map((t) => CATEGORY_CLASSES[t.category]?.packRef)
            .filter(Boolean)
            .map((r) => [r.pack + ':' + r.entry, { packId: r.pack, entryId: r.entry }]),
        ).values(),
      ],
      ...extra,
    });
  const allDebt = selectors.include.classes?.length === 1 && selectors.include.classes[0] === 'debt_service';
  const total = f(window ? raw * scale : null, allDebt ? 'All debt payments' : 'Selected total', counted, {
    unit: args.annualize ? 'usd_per_year' : 'usd',
    unavailable: window ? undefined : 'incomplete_month',
  });
  const perMonth = f(window ? raw / window.months : null, allDebt ? 'All debt payments per month' : 'Monthly average', counted, {
    unit: 'usd_per_month',
    formula: 'selected total divided by calendar months',
    unavailable: window ? undefined : 'incomplete_month',
  });
  const groupBy = args.groupBy ?? 'none',
    map = new Map();
  if (groupBy !== 'none')
    for (const t of counted) {
      const key = groupBy === 'month' ? t.date.slice(0, 7) : groupBy === 'account' ? t.account_id : t[groupBy];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
  const allGroups = [...map]
    .map(([key, rs]) => ({
      key,
      label: groupBy === 'account' ? byId.get(key)?.name || 'Summary sheets and payroll' : groupBy === 'class' && key === 'debt_service' ? 'All debt payments' : key,
      figure: f(sumRows(rs, value) * scale, 'Selected group', rs, { unit: total.unit }),
    }))
    .sort((a, b) => Math.abs(b.figure.value) - Math.abs(a.figure.value) || String(a.key).localeCompare(String(b.key)));
  const limit = args.limit ?? 25,
    groups = allGroups.slice(0, limit);
  if (allGroups.length && allGroups.length <= limit) {
    const last = allGroups.at(-1);
    last.figure = f(
      round(total.value - sumRows(allGroups.slice(0, -1), (g) => g.figure.value)),
      'Selected group',
      map.get(last.key),
      { unit: total.unit },
    );
  }
  let other;
  if (allGroups.length > limit) {
    const keys = new Set(allGroups.slice(limit).map((g) => g.key));
    const rs = [...map].filter(([k]) => keys.has(k)).flatMap(([, rs]) => rs);
    other = f(raw * scale - sumRows(groups, (g) => g.figure.value), 'Other groups', rs, { unit: total.unit });
  }
  const excluded = Object.entries(selectors.exclude).flatMap(([field, values]) =>
    values.map((v) => {
      const rs = windowRows.filter((t) => t.amount < 0 && matches(t, field, [v]));
      const removedRows = included.filter((t) => matches(t, field, [v]));
      return {
        selector: { field, value: v },
        matched: f(-sumRows(rs) * scale, 'Matched outflows', rs, { unit: total.unit }),
        removed: f(sumRows(removedRows, value) * scale, 'Removed from total', removedRows, { unit: total.unit }),
      };
    }),
  );
  return {
    total,
    byPerson: [...Map.groupBy(counted, t => t.person)].map(([person, rs]) => ({ person,
      total: f(sumRows(rs, value) * scale, `${person} ${measure}`, rs, { unit: total.unit }),
    })),
    ...(scope !== 'business' && summaries.evidence.length ? { summaryEvidence: [...Map.groupBy(summaries.evidence, r => r.reason)]
      .map(([reason, rs]) => ({ reason, sources: summarySources(rs), rule: SUMMARY_RULE })) } : {}),
    perMonth,
    months: window?.months ?? 0,
    window,
    groups,
    ...(other ? { other } : {}),
    excluded,
    ...(definition ? { definition: { id: definition.id, name: definition.name, source: definition.source } } : {}),
    notes,
    gaps,
  };
}

export function compare(input, args, definition) {
  const { a, b, ...common } = args;
  const left = aggregate(input, { ...common, ...a, limit: Infinity }, definition),
    right = aggregate(input, { ...common, ...b, limit: Infinity }, definition);
  const gaps = unionGaps([left.gaps, right.gaps]);
  if (left.months !== right.months)
    gaps.push({ code: 'unequal_periods', message: 'The periods contain different month counts.' });
  const calc = (av, bv, label, ratio = false) => {
    const v = av.value === null || bv.value === null ? null : ratio ? bv.value / av.value : bv.value - av.value;
    const f = figureFor(v, label, [], {
      unit: ratio ? 'ratio' : av.unit,
      gaps,
      unavailable: v === null ? 'incomplete_month' : undefined,
      formula: ratio ? 'later total divided by earlier total' : 'later total minus earlier total',
      inputs: [av, bv],
      sources: [...(av.provenance.sources ?? []), ...(bv.provenance.sources ?? [])],
    });
    f.asOf = [av.asOf, bv.asOf].filter(Boolean).sort().at(-1) ?? null;
    return f;
  };
  const zero = figureFor(0, 'No matching group', []),
    lm = new Map(left.groups.map((g) => [g.key, g])),
    rm = new Map(right.groups.map((g) => [g.key, g]));
  let groups = [...new Set([...lm.keys(), ...rm.keys()])]
    .map((key) => {
      const av = lm.get(key)?.figure ?? { ...zero, unit: left.total.unit },
        bv = rm.get(key)?.figure ?? { ...zero, unit: right.total.unit };
      return {
        key,
        label: lm.get(key)?.label ?? rm.get(key).label,
        a: av,
        b: bv,
        difference: calc(av, bv, 'Group difference'),
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.difference.value) - Math.abs(a.difference.value) || String(a.key).localeCompare(String(b.key)),
    );
  const limit = args.limit ?? 25;
  if (groups.length > limit) {
    const rest = groups.slice(limit);
    const fold = (side, total) => {
      const figs = rest.map((g) => g[side]);
      const f = figureFor(
        sumRows(figs, (g) => g.value),
        'Other groups',
        [],
        { unit: total.unit, window: total.window, inputs: figs, sources: figs.flatMap((g) => g.provenance.sources) },
      );
      f.asOf =
        figs
          .map((g) => g.asOf)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
      return f;
    };
    const av = fold('a', left.total),
      bv = fold('b', right.total);
    groups = [
      ...groups.slice(0, limit),
      { key: 'other', label: 'Other', a: av, b: bv, difference: calc(av, bv, 'Other difference') },
    ];
  }
  return {
    a: { total: left.total, window: left.window },
    b: { total: right.total, window: right.window },
    difference: calc(left.total, right.total, 'Period difference'),
    ...(left.total.value !== 0 && left.total.value !== null
      ? { ratio: calc(left.total, right.total, 'Period ratio', true) }
      : {}),
    groups,
    gaps,
  };
}

export function cashFlow(input, args) {
  const { rows, resolved } = selectSpendingRows(input),
    byId = new Map(input.accounts.map((a) => [a.id, a]));
  const window = periodOf(args, input.clock, resolved.window, 'ytd');
  const matched = matchTransfers(
    rows.filter((t) => t.amount < 0),
    rows.filter((t) => t.amount > 0),
  );
  const reverse = matchTransfers(
    rows.filter((t) => t.amount > 0),
    rows.filter((t) => t.amount < 0),
  );
  const transferIds = new Set([...matched, ...reverse]);
  const businessOut = rows.filter((t) => businessAccount(byId.get(t.account_id)) && t.amount < 0);
  const householdIn = rows.filter((t) => spendingAccount(byId.get(t.account_id)) && t.amount > 0);
  const householdOut = rows.filter((t) => spendingAccount(byId.get(t.account_id)) && t.amount < 0);
  const businessIn = rows.filter((t) => businessAccount(byId.get(t.account_id)) && t.amount > 0);
  const bth = matchTransfers(businessOut, householdIn),
    htb = matchTransfers(householdOut, businessIn);
  const categories = resolveCategories({ ...input, transactions: rows });
  const inWindow = (t) => window && t.date.slice(0, 7) >= window.from && t.date.slice(0, 7) <= window.to;
  const summaries = selectPersonalSummaries(input.personalSummaries, { window, payroll: false });
  const windowRows = [...rows.filter(inWindow), ...summaries.rows.filter(t => t.date <= input.clock)];
  const make = (rs, w) => {
    const gaps = coverageGaps(input, w, args.scope ?? 'all');
    const f = (v, label, r) => figureFor(v, label, r, { window: w, gaps, sources: summarySources(r),
      ...(r.some(t => t.sourceTable === 'pnl_lines') ? { formula: `sum of selected amounts; ${SUMMARY_RULE}` } : {}),
    });
    const side = (scope) => {
      const r = rs.filter(
        (t) =>
          (t.sourceTable === 'pnl_lines' ? scope === 'household' : scopeHas(byId.get(t.account_id), scope)) &&
          ((args.scope ?? 'all') === 'all' || args.scope === scope) &&
          !transferIds.has(t.id) &&
          (t.bucket || categories.get(t.id).bucket) !== 'transfer',
      );
      const incoming = r.filter((t) => t.amount > 0),
        outgoing = r.filter((t) => t.amount < 0);
      return {
        inflow: f(sumRows(incoming), 'Money in', incoming),
        outflow: f(-sumRows(outgoing), 'Money out', outgoing),
        net: f(sumRows(r), 'Net cash flow', r),
      };
    };
    const outB = rs.filter((t) => bth.has(t.id)),
      outH = rs.filter((t) => htb.has(t.id));
    return {
      household: side('household'),
      business: side('business'),
      transfersBusinessToHousehold: f(-sumRows(outB), 'Business to household', outB),
      transfersHouseholdToBusiness: f(-sumRows(outH), 'Household to business', outH),
    };
  };
  const months = [];
  if (window)
    for (let i = monthIndex(window.from); i <= monthIndex(window.to); i++) {
      const month = monthAt(i);
      months.push({
        month,
        ...make(
          windowRows.filter((t) => t.date.startsWith(month)),
          { from: month, to: month, months: 1 },
        ),
      });
    }
  return {
    months,
    totals: make(windowRows, window),
    gaps: coverageGaps(input, window, args.scope ?? 'all'),
  };
}

export function boundResult(result) {
  const bytes = () => Buffer.byteLength(JSON.stringify(result));
  while (bytes() > 256 * 1024) {
    const lists = [];
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v) && v.length) lists.push(v);
      for (const [key, c] of Object.entries(v)) if (key !== 'ref') visit(c);
    };
    visit(result);
    lists.sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)));
    if (!lists.length) break;
    lists[0].splice(Math.floor(lists[0].length / 2));
    result.truncated = true;
  }
  return result;
}
