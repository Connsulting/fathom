import { monthlyReadings, trendLabels } from '../../jobs/planner/series.mjs';
import { PARTS, GROUPS, groupOfKind, MAX_MONTHS } from '../../accounts/trend.mjs';
import { accountFreshness } from '../../ingest/freshness.mjs';
import { accountDetail } from '../../api/account-detail.mjs';
import { ACCOUNT_TREATMENT } from '../../calc/treatment.mjs';
import { envelope } from '../../calc/figure.mjs';
import { parseJson } from '../../store/db.mjs';
import { getFacts } from '../../store/facts.mjs';
import { clockOf, plainDeep } from './figures.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { ToolError } from '../errors.mjs';
import { mapSeries } from '../../shared/series.mjs';

export const accountIds = { type: 'array', items: { type: 'string' }, maxItems: 50 };
export const uniqueGaps = gaps => [...new Map(gaps.map(g => [`${g.code}:${g.message}`, g])).values()];
export async function selectedAccounts(db, ids) {
  const rows = await db.prepare('SELECT * FROM accounts ORDER BY sort, id').all();
  // Archived accounts are history: out of the default (current) set, still readable by id.
  if (ids === undefined) return rows.filter(a => !a.archived_at);
  for (const id of ids) if (!rows.some(a => a.id === id)) throw new ToolError('not_found', 'No such account');
  return rows.filter(a => ids.includes(a.id));
}
export function makeFigure(tool, args, path, value, unit, label, asOf, provenance, gaps = [], kind = 'a') {
  return envelope(value, { unit, label, asOf, kind, provenance, gaps,
    ref: { tool, args, path }, ...(value === null ? { unavailable: gaps[0]?.code || 'missing_fact' } : {}) });
}

const packRef = ref => ({ packId: ref.pack, entryId: ref.entry });
const partOf = new Map(GROUPS);
const treatmentLabels = { cash: 'Cash', taxable: 'Taxable investments', pretax: 'Pre tax retirement', roth: 'Roth retirement', roth_ira: 'Roth IRA', roth_401k: 'Roth workplace plan', hsa: 'Health savings', '529': 'Education savings', business: 'Business', liability: 'Liabilities', loan: 'Loans', 'needs plan type': 'Unspecified retirement treatment', unknown: 'Unknown treatment' };

export function bounded(result) {
  while (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) {
    let longest = null;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value) && value.length && (!longest || value.length > longest.length)) longest = value;
      for (const [key,child] of Object.entries(value)) if (key !== 'ref') visit(child);
    };
    visit(result);
    if (!longest) throw new ToolError('bad_input', 'Tool result cannot fit the result size limit');
    longest.splice(Math.floor(longest.length / 2));
    result.truncated = true;
  }
  return result;
}

async function netWorth(args, ctx) {
  const clock = await clockOf(ctx), labels = await trendLabels(ctx.db), scope = await tokenScope(ctx.db);
  const plain = value => plainDeep(scope, value);
  const plans = (await getFacts(ctx.db))['accounts.planType'] || {};
  const groupBy = args.groupBy || 'part';
  const rows = (await selectedAccounts(ctx.db, args.accounts)).filter(a => args.includeBusiness !== false || groupOfKind(a.kind) !== 'Business');
  const missing = [];
  const stored = (await mapSeries(rows, async a => {
    const group = groupOfKind(a.kind), label = a.parser === 'demo-seed' ? plain(labels.get(a.id)) : labels.get(a.id);
    const plan = Object.hasOwn(ACCOUNT_TREATMENT.byPlanType,plans[a.id]) ? ACCOUNT_TREATMENT.byPlanType[plans[a.id]] : null;
    const treatment = plan || (Object.hasOwn(ACCOUNT_TREATMENT.byKind,a.kind) ? ACCOUNT_TREATMENT.byKind[a.kind] : null);
    const key = groupBy === 'part' ? partOf.get(group) : groupBy === 'group' ? group : treatment?.id || 'unknown';
    const gaps = groupBy === 'treatment' && (!treatment || treatment.id === 'needs plan type')
      ? [{ code: 'missing_fact', message: `${label} needs its plan type to identify tax treatment.`, fact: 'accounts.planType' }] : [];
    const readings = await monthlyReadings(ctx.db, a.id, clock), months = [...readings.keys()].sort();
    if (!months.length) missing.push({ code: 'missing_fact', message: `${label} has no balance or positions on file.` });
    return { id: a.id, label, group, key, gaps, treatment, readings, months, last: readings.get(months.at(-1))?.date,
      fresh: (await accountFreshness(ctx.db, a.id, { clock })).fresh };
  })).filter(a => a.months.length);
  const refArgs = { operation: 'net_worth', ...args };
  const gaps = [...missing];
  const build = async (month, prefix, end) => {
    const values = await mapSeries(stored.filter(a => a.months[0] <= month), async a => {
      const reading = a.readings.get(a.months.filter(m => m <= month).at(-1));
      const carried = a.months.at(-1) < month || (month === end && a.fresh === 'stale');
      const rowGaps = [...a.gaps, ...(carried ? [{ code: 'carried_balance', message: `${a.label} carries its balance from ${a.last}.` }] : [])];
      const balanceRows = await ctx.db.prepare('SELECT id FROM balances WHERE account_id=? AND date=?').all(a.id,reading.date);
      const sources = balanceRows.length ? [{ table: 'balances', ids: balanceRows.map(r => r.id) }]
        : [{ table: 'positions', ids: (await ctx.db.prepare('SELECT id FROM positions WHERE account_id=? AND as_of=?').all(a.id,reading.date)).map(r => r.id) }];
      return { ...a, sources, value: a.group === 'Debt' ? -Math.abs(reading.v) : reading.v, date: reading.date, carried, rowGaps };
    });
    const fig = (subset, path, label) => {
      const fgaps = uniqueGaps(subset.flatMap(a => a.rowGaps));
      return makeFigure('accounts', refArgs, path, subset.reduce((sum,a) => sum + a.value, 0), 'usd', label,
        subset.map(a => a.date).sort().at(-1) || null, {
          calc: 'netWorth', formula: 'sum of latest monthly readings; debt is negative',
          inputs: subset.map(a => ({ value: a.value, unit: 'usd', label: a.label })),
          sources: ['balances','positions'].map(table => {
            const ids = subset.flatMap(a => a.sources.filter(s => s.table === table).flatMap(s => s.ids));
            return { table, ids: ids.slice(0,50), count: ids.length };
          }).filter(s => s.count),
          accounts: subset.map(a => ({ id: a.id, label: a.label })),
          packRefs: [...new Map(subset.filter(a => a.treatment && groupBy === 'treatment').map(a => [JSON.stringify(a.treatment.packRef), packRef(a.treatment.packRef)])).values()],
        }, fgaps);
    };
    let keys = [...new Set(stored.map(a => a.key))];
    if (groupBy === 'part') keys = PARTS.map(p => p[0]).filter(k => keys.includes(k));
    if (groupBy === 'group') keys = GROUPS.map(g => g[0]).filter(k => keys.includes(k));
    const groups = keys.map((key,i) => {
      const label = groupBy === 'part' ? PARTS.find(p => p[0] === key)[1] : groupBy === 'treatment' ? treatmentLabels[key] : key;
      const subset = values.filter(a => a.key === key);
      return { key, label, figure: fig(subset, `${prefix}groups.${i}.figure`, label), accounts: subset.map(a => ({ id: a.id, label: a.label })) };
    });
    return { total: fig(values, `${prefix}total`, 'Net worth'), groups, values };
  };
  if (!stored.length) {
    if (!gaps.length) gaps.push({ code: 'missing_fact', message: 'No account balances on file.' });
    return { total: makeFigure('accounts', refArgs, 'total', null, 'usd', 'Net worth', null, { calc: 'netWorth' }, gaps), groups: [], ...(args.series ? { series: [] } : {}), carried: [], gaps };
  }
  const end = stored.map(a => a.months.at(-1)).sort().at(-1);
  const start = stored.map(a => a.months[0]).sort()[0];
  const months = [];
  for (let month = end; month >= start && months.length < (args.months || 12);) {
    months.unshift(month);
    const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); month = d.toISOString().slice(0, 7);
  }
  const latest = await build(end, '', end);
  const series = args.series ? await mapSeries(months, async (month,i) => {
    const point = await build(month, `series.${i}.`, end);
    return { month, total: point.total, groups: point.groups };
  }) : undefined;
  const allGaps = [...gaps, ...latest.total.gaps, ...(series || []).flatMap(p => p.total.gaps)];
  return { total: { ...latest.total, gaps: uniqueGaps([...latest.total.gaps, ...gaps]) }, groups: latest.groups,
    ...(series ? { series } : {}), carried: latest.values.filter(a => a.carried).map(a => ({ id: a.id, label: a.label, lastDate: a.last })), gaps: uniqueGaps(allGaps) };
}

async function detail(args, ctx) {
  await selectedAccounts(ctx.db, [args.id]);
  const clock = await clockOf(ctx);
  const result = await accountDetail({ ...ctx, params: { id: args.id }, config: { ...ctx.config, clock } });
  const { db } = ctx;
  const row = await db.prepare('SELECT a.fig_key, g.v, g.locator, f.period_to, g.unavailable_reason FROM accounts a LEFT JOIN figures g ON g.key=a.fig_key LEFT JOIN files f ON f.id=g.file_id WHERE a.id=?').get(args.id);
  const balance = await db.prepare('SELECT id,amount FROM balances WHERE account_id=? ORDER BY date DESC LIMIT 1').get(args.id);
  const date = result.balance.asOf;
  const positions = date ? await db.prepare('SELECT id,value, quantity, price FROM positions WHERE account_id=? AND as_of=?').all(args.id,date) : [];
  const emptyHoldings = row?.v === 0 && parseJson(row.locator, {})?.field === 'holdings' && row.period_to === date;
  const positionValues = positions.map(p => Number.isFinite(p.value) ? p.value : Number.isFinite(p.quantity) && Number.isFinite(p.price) ? p.quantity*p.price : null);
  const amount = balance ? balance.amount : emptyHoldings ? 0 : positions.length && positionValues.every(v => v !== null) ? positionValues.reduce((sum,v) => sum+v,0) : null;
  const gaps = amount === null || row?.unavailable_reason ? [{ code: 'missing_fact', message: 'No available account balance on file.' }] : [];
  result.balance = makeFigure('accounts', { operation: 'detail', ...args }, 'balance', gaps.length ? null : amount, 'usd', 'Account balance', date,
    { calc: 'accountBalance', sources: [{ table: balance ? 'balances' : 'positions', ids: balance ? [balance.id] : positions.map(p => p.id).slice(0,50), count: balance ? 1 : positions.length }], accounts: [{ id: args.id, label: result.account.label }] }, gaps);
  return (await ctx.db.prepare('SELECT parser FROM accounts WHERE id=?').get(args.id)).parser === 'demo-seed' ? plainDeep(await tokenScope(db), result) : result;
}

export const operations = [
  { tool: 'accounts', name: 'net_worth', scope: 'read', summary: 'Balances by part or tax treatment, with carried balances and optional monthly history.',
    route: 'Net worth, balances by part, retirement against taxable', routes: [], referenceable: true,
    params: { accounts: accountIds, includeBusiness: { type: 'boolean' }, groupBy: { type: 'string', enum: ['part','group','treatment'] }, series: { type: 'boolean' }, months: { type: 'integer', minimum: 1, maximum: MAX_MONTHS } }, required: [], handler: async (args,ctx) => bounded(await netWorth(args,ctx)) },
  { tool: 'accounts', name: 'detail', scope: 'read', summary: 'One account, its balance figure, history coverage, feeds and freshness.', route: 'One account balance history and freshness', routes: ['GET /api/accounts/:id'], referenceable: true,
    params: { id: { type: 'string' } }, required: ['id'], handler: async (args,ctx) => bounded(await detail(args,ctx)) },
];
