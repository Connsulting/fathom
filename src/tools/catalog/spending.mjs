import { loadCategoryInputs } from '../../categories/store.mjs';
import { resolveClock } from '../../scenario/build.mjs';
import { aggregate, compare, cashFlow, bindFigures, boundResult } from '../../calc/aggregate.mjs';
import { recurring } from '../../calc/recurring.mjs';
import { resolveDefinition, spendingDefinitions } from '../../spending/definitions.mjs';
import { BUCKETS } from '../../categories/resolve.mjs';
import { ToolError } from '../errors.mjs';
import { loadPlanningData } from '../../jobs/planner/data.mjs';
import { personalSummaryInput } from '../../spending/summaries.mjs';

const choice = (values) => ({ type: 'string', enum: values });
export const CLASSES = [
  'housing',
  'debt_service',
  'healthcare',
  'childcare',
  'essential_other',
  'discretionary',
  'unclassified',
  'savings',
  'taxes',
  'business',
  'income',
  'transfer',
  'excluded',
];
const strings = { type: 'array', items: { type: 'string' }, maxItems: 50 };
const selector = {
  type: 'object',
  properties: {
    buckets: { ...strings, items: choice(BUCKETS) },
    categories: strings,
    classes: { ...strings, items: choice(CLASSES) },
    accounts: strings,
    merchants: strings,
  },
  additionalProperties: false,
};
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
export const periodParams = {
  window: choice(['spending_window', 'trailing_12', 'ytd', 'calendar_year', 'custom']),
  year: { type: 'integer', minimum: 2000, maximum: 2100 },
  from: month,
  to: month,
};
const scope = choice(['household', 'business', 'all']);
const totalParams = {
  measure: choice(['spending', 'income', 'outflow', 'inflow', 'net']),
  groupBy: choice(['none', 'bucket', 'category', 'class', 'merchant', 'account', 'month']),
  include: selector,
  exclude: selector,
  definition: { type: 'string' },
  annualize: { type: 'boolean' },
  scope,
  limit: { type: 'integer', minimum: 1, maximum: 200 },
};
const period = { type: 'object', properties: periodParams, additionalProperties: false };
export function readInput(ctx) {
  const clock = resolveClock(ctx.db, ctx.clock ?? ctx.household?.clock);
  const facts = Object.fromEntries(
    ctx.db
      .prepare("SELECT key,value FROM facts WHERE src IS NULL OR src!='planner'")
      .all()
      .map((r) => {
        let v;
        try {
          v = JSON.parse(r.value);
        } catch {
          v = null;
        }
        return [r.key, v];
      }),
  );
  const input = loadCategoryInputs(ctx.db);
  const data = loadPlanningData(ctx.db, clock);
  return { ...input, clock, facts, personalSummaries: personalSummaryInput(data, facts, input) };
}
function op(name, params, summary, route, handler) {
  return {
    tool: 'spending',
    name,
    params,
    summary,
    route,
    routes: name === 'total' ? ['GET /api/spending'] : [],
    scope: 'read',
    required: name === 'compare' ? ['a', 'b'] : [],
    referenceable: name !== 'definitions',
    handler(args, ctx) {
      if (
        args.since &&
        (!Number.isFinite(Date.parse(`${args.since}T00:00:00Z`)) ||
          new Date(`${args.since}T00:00:00Z`).toISOString().slice(0, 10) !== args.since)
      )
        throw new ToolError('bad_input', 'since must be a calendar date');
      const bind = (value) => bindFigures(value, 'spending', { operation: name, ...args });
      let result = bind(handler(args, ctx));
      let limit = args.limit ?? 25;
      while (
        ['total', 'compare'].includes(name) &&
        Buffer.byteLength(JSON.stringify(result)) > 250 * 1024 &&
        limit > 1
      ) {
        limit = Math.max(1, Math.floor(limit / 2));
        result = bind(handler({ ...args, limit }, ctx));
        result.truncated = true;
      }
      return bind(boundResult(result));
    },
  };
}
export const operations = [
  op(
    'total',
    { ...totalParams, ...periodParams },
    'Total and groups with data gaps.',
    'A total, average or breakdown of spending or income',
    (args, ctx) => aggregate(readInput(ctx), args, resolveDefinition(ctx.db, args.definition)),
  ),
  op(
    'compare',
    { ...totalParams, a: period, b: period },
    'Compare two selections.',
    'This period against that one',
    (args, ctx) => compare(readInput(ctx), args, resolveDefinition(ctx.db, args.definition)),
  ),
  op('definitions', {}, 'Built-in and saved selections.', 'Named spending definitions', (args, ctx) => spendingDefinitions(ctx.db)),
  op(
    'cash_flow',
    { ...periodParams, scope },
    'Money in, out and business transfers.',
    'Money in and out by month, household against business',
    (args, ctx) => cashFlow(readInput(ctx), args),
  ),
  op(
    'recurring',
    {
      status: choice(['active', 'new', 'stopped', 'all']),
      since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      cadence: choice(['monthly', 'quarterly', 'annual']),
      scope,
      minOccurrences: { type: 'integer', minimum: 2, maximum: 12 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    'Repeating charges and annual cost.',
    'Subscriptions, repeating bills, what started or stopped',
    (args, ctx) => recurring(readInput(ctx), args),
  ),
];
export const rules = ['Use spending.total for spending totals and transactions.search for recent purchases; never sum transaction rows. debt_service is all debt payments, never the mortgage payment; use spending.obligations.'];
