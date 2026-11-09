import { clockOf, plainDeep, goalsForModel, curveForModel } from './figures.mjs';
import { tokenScope, loadLinkedRecs, loadContent, housekeepingCount } from '../../scenario/build.mjs';
import { parseJson as parse } from '../../store/db.mjs';
import { needsYou, verdictLevel } from '../../shared/rules.mjs';
import { ANSWER_SHAPES, answerShape } from '../../jobs/triggers/common.mjs';
import { inferMortgage } from '../../calc/mortgage-inference.mjs';
const visible = recs => recs.filter(r => r.status !== 'hidden');
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
function where(conds) { const used = conds.filter(c => c[1] !== undefined); return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) }; }

export const operations = [
{ tool: 'household', name: 'fact_shapes', scope: 'read', summary: 'Accepted fact keys and typed answer shapes.', route: 'Accepted fact answer shapes', routes: [], params: {}, required: [], handler() { return Object.fromEntries(Object.keys(ANSWER_SHAPES).map(key => [key, answerShape(key)])); } },
{
    tool: 'household', name: 'summary',
    summary: 'Household overview, facts, goals, freshness and plan status.', route: 'Household overview', routes: ['GET /api/scenario'],
    params: {},
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      const clock = await clockOf(ctx);
      const recs = visible(await loadLinkedRecs(ctx.db, clock));
      const statusCounts = {};
      for (const r of recs) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      const facts = {};
      for (const f of await ctx.db.prepare('SELECT key, value FROM facts ORDER BY key').all()) facts[f.key] = parse(f.value, f.value);
      const meta = (await loadContent(ctx.db)).meta || {};
      const mortgage = await inferMortgage(ctx.db, clock, facts['obligations.mortgage']);
      if (mortgage.status === 'paid_off') facts['obligations.mortgage'] = mortgage.values;
      return {
        facts,
        mortgage: { status: mortgage.status, ...(mortgage.message ? { message: mortgage.message } : {}), provenance: { sources: mortgage.sources } },
        verdictLevel: verdictLevel(recs),
        needsYouCount: needsYou(recs).length,
        statusCounts,
        housekeepingCount: housekeepingCount(recs),
        dataThrough: meta.dataThrough || '',
        clock,
        goals: await goalsForModel(ctx.db),
        curve: await curveForModel(ctx.db),
      };
    },
  },
{
    tool: 'household', name: 'facts',
    summary: 'Stored facts with source, as-of date and confirmation.', route: 'Household facts', routes: [],
    params: { keys: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      const rows = await ctx.db.prepare('SELECT key, value, src, as_of, confirmed FROM facts ORDER BY key').all();
      const want = args.keys ? new Set(args.keys) : null;
      return rows.filter(r => !want || want.has(r.key))
        .map(r => ({ key: r.key, value: parse(r.value, r.value), src: r.src, asOf: r.as_of, confirmed: !!r.confirmed }));
    },
  },
{
    tool: 'household', name: 'deadlines',
    summary: 'Calendar deadlines in date order.', route: 'Upcoming deadlines', routes: [],
    params: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } },
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      const { clause, params } = where([['date >= ?', args.from], ['date <= ?', args.to]]);
      const scope = await tokenScope(ctx.db);
      return (await ctx.db.prepare('SELECT * FROM deadlines' + clause + ' ORDER BY date, id').all(...params))
        .map(d => plainDeep(scope, { date: d.date, label: d.label, title: d.title, recId: d.rec_id, hard: !!d.hard }));
    },
  },
];
