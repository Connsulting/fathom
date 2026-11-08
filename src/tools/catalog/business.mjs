import { businessPnl, businessPnlRows, pnlEntities } from '../../pnl/index.mjs';
import { resolveClock } from '../../scenario/build.mjs';
import { bindFigures, periodOf, figureFor, boundResult } from '../../calc/aggregate.mjs';
import { ToolError } from '../errors.mjs';

const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const base = { entity: { type: 'string' }, from: month, to: month };
const clockOf = (ctx) => resolveClock(ctx.db, ctx.clock ?? ctx.household?.clock);
const pnlCall = (fn, args) => {
  try {
    return fn(args);
  } catch (e) {
    if (e.code) throw new ToolError(e.code === 'unknown_entity' ? 'not_found' : 'bad_input', e.message);
    throw e;
  }
};
function requireBusiness(entity) {
  if (entity.kind === 'spending') throw new ToolError('bad_input', 'A spending ledger is not a business entity.');
  if (['inactive', 'income_history'].includes(entity.kind)) throw new ToolError('bad_input', 'Historical income is not a current business entity.');
}
function pnl(args, ctx) {
  const clock = clockOf(ctx),
    window = periodOf(args, clock, null, 'ytd');
  let entities = pnlEntities({ db: ctx.db, clock }).filter(entity => !['spending', 'inactive', 'income_history'].includes(entity.kind));
  if (args.entity) {
    const single = pnlCall(businessPnl, { db: ctx.db, entity: args.entity, from: window.from, to: window.to, clock });
    requireBusiness(single.entity);
    entities = entities.filter((e) => e.key === single.entity.key);
  }
  const gaps = [];
  const result = entities.map((entity) => {
    const p = pnlCall(businessPnl, { db: ctx.db, entity: entity.key, from: window.from, to: window.to, clock });
    if (p.monthSources.at(-1)?.source === 'none')
      gaps.push({
        code: 'incomplete_month',
        message: `Business period has no lines in its last month for ${entity.label}.`,
      });
    const get = (key) => p.figures[key];
    const f = (key, label) => {
      const source = get(key);
      const sources = source?.provenance?.rows ?? [];
      const value = source?.v ?? 0;
      const fig = figureFor(value, label, [], {
        window,
        calc: 'businessPnl',
        formula: 'business profit and loss calculator',
        sources,
      });
      fig.provenance.accounts = source?.provenance?.accounts ?? [];
      fig.asOf = source?.provenance?.asOf ?? null;
      return fig;
    };
    const ratio = (numerator, denominator, label) => {
      if (denominator.value === 0) return undefined;
      const fig = figureFor(numerator.value / denominator.value, label, [], {
        unit: 'ratio',
        window,
        calc: 'businessPnl',
        formula: 'numerator divided by denominator',
        inputs: [numerator, denominator],
        sources: [...numerator.provenance.sources, ...denominator.provenance.sources],
      });
      fig.asOf = [numerator.asOf, denominator.asOf].filter(Boolean).sort().at(-1) ?? null;
      return fig;
    };
    const difference = (a, b, label) => {
      const fig = figureFor(b.value - a.value, label, [], {
        window,
        calc: 'businessPnl',
        formula: 'current minus prior',
        inputs: [a, b],
        sources: [...a.provenance.sources, ...b.provenance.sources],
      });
      fig.asOf = [a.asOf, b.asOf].filter(Boolean).sort().at(-1) ?? null;
      return fig;
    };
    const revenue = f(p.income.total, 'Business revenue'),
      expenses = f(p.expenses.total, 'Business expenses'),
      profit = f(p.net.total, 'Business profit');
    let groups = [];
    if ((args.groupBy ?? 'month') === 'month')
      groups = p.months.map((key) => ({
        key,
        revenue: f(p.income.months[key], 'Monthly revenue'),
        expenses: f(p.expenses.months[key], 'Monthly expenses'),
        profit: f(p.net.months[key], 'Monthly profit'),
      }));
    if (args.groupBy === 'category') {
      const cats = [...new Set([...p.income.categories, ...p.expenses.categories].map((c) => c.category))];
      groups = cats.map((key) => {
        const revenue = f(p.income.categories.find((c) => c.category === key)?.total, 'Category revenue'),
          expenses = f(p.expenses.categories.find((c) => c.category === key)?.total, 'Category expenses');
        return { key, revenue, expenses, profit: difference(expenses, revenue, 'Category profit') };
      });
    }
    let prior;
    if (args.compareToPriorYear && p.prior) {
      const revenuePrior = f(p.prior.income, 'Prior business revenue'),
        expensesPrior = f(p.prior.expenses, 'Prior business expenses'),
        profitPrior = f(p.prior.net, 'Prior business profit');
      for (const fig of [revenuePrior, expensesPrior, profitPrior])
        fig.window = { from: p.prior.from, to: p.prior.to, months: window.months };
      prior = {
        revenue: revenuePrior,
        expenses: expensesPrior,
        profit: profitPrior,
        margin: ratio(profitPrior, revenuePrior, 'Prior profit margin'),
        revenueDifference: difference(revenuePrior, revenue, 'Revenue difference'),
        revenueRatio: ratio(revenue, revenuePrior, 'Revenue ratio'),
        profitDifference: difference(profitPrior, profit, 'Profit difference'),
        profitRatio: ratio(profit, profitPrior, 'Profit ratio'),
      };
    }
    return {
      entity: p.entity,
      revenue,
      expenses,
      profit,
      margin: ratio(profit, revenue, 'Profit margin'),
      groups,
      ...(prior ? { prior } : {}),
    };
  });
  const totals = {};
  for (const key of ['revenue', 'expenses', 'profit']) {
    const inputs = result.map((e) => e[key]);
    totals[key] = figureFor(
      inputs.reduce((n, f) => n + f.value, 0),
      'Combined business ' + key,
      [],
      {
        window,
        calc: 'businessPnl',
        formula: 'sum across selected entities',
        inputs,
        sources: inputs.flatMap((f) => f.provenance.sources),
      },
    );
    totals[key].asOf =
      inputs
        .map((f) => f.asOf)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
  }
  const bind = (value) => bindFigures(value, 'business', { operation: 'pnl', ...args });
  return bind(boundResult(bind({ entities: result, totals, gaps })));
}
export const operations = [
  {
    tool: 'business',
    name: 'pnl',
    scope: 'read',
    referenceable: true,
    summary: 'Revenue, expenses, profit and margin by entity and period.',
    route: 'Business profit, revenue and margin',
    routes: ['GET /api/pnl'],
    required: [],
    params: {
      ...base,
      window: { type: 'string', enum: ['ytd', 'trailing_12', 'calendar_year', 'custom'] },
      year: { type: 'integer', minimum: 2000, maximum: 2100 },
      groupBy: { type: 'string', enum: ['none', 'month', 'category'] },
      compareToPriorYear: { type: 'boolean' },
    },
    handler: pnl,
  },
  {
    tool: 'business',
    name: 'rows',
    scope: 'read',
    summary: 'Lines behind a business figure.',
    route: 'The lines behind a business figure',
    routes: ['GET /api/pnl/rows'],
    required: ['section', 'category'],
    params: {
      ...base,
      section: { type: 'string', enum: ['income', 'expenses'] },
      category: { type: 'string', minLength: 1 },
      month,
    },
    handler(args, ctx) {
      const clock = clockOf(ctx);
      requireBusiness(pnlCall(businessPnl, { db: ctx.db, entity: args.entity, from: args.from, to: args.to, clock }).entity);
      return pnlCall(businessPnlRows, { db: ctx.db, ...args, clock });
    },
  },
];
export const capabilities = ['businessPeriods'];
