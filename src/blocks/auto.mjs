// Automatic Ask visuals: when an answer draws no block, Fathom picks drawable shapes from the turn's
// successful reads (series, then breakdown, war game and dated events; read order within a shape)
// and builds at most two blocks through the show tool's own validate and snapshot path (makeBlock).
// A spec only names a source read (its exact tool and args) and result paths, never a number.
//   autoSpecs(results) -> [{ op, spec, shape }]
//   autoBlocks(results, { now, ids }) -> blocks with origin 'auto', ids the lowest b<n> not in ids
import { isDeepStrictEqual } from 'node:util';
import { at, isFigure, resolve, sources, validPath } from './paths.mjs';
import { makeBlock } from '../tools/catalog/show.mjs';

const RANK = { series: 0, breakdown: 1, wargame: 2, events: 3 };
const BREAKDOWN = ['category', 'class', 'merchant', 'account', 'bucket'];
const WARGAME = {
  salary: ['salary.points', ['figures.salary', 'figures.tax', 'figures.room', 'figures.distributions']],
  deferral: ['deferral.options', ['figures.amount', 'figures.taxThisYear', 'figures.taxNextYear', 'figures.net', 'figures.decemberCash', 'figures.payrollNeed']],
};
const MAX = 2;

function candidates({ name, args, result }) {
  const out = [];
  const ref = path => ({ tool: name, args, path });
  const items = path => { const v = at(result, path); return Array.isArray(v) ? v : []; };
  const add = (shape, op, spec, path, min, max = Infinity) => {
    const n = items(path).length;
    if (n >= min && n <= max) out.push({ op, spec: { ...spec, source: ref(path) }, shape });
  };
  const series = (path, x, y, kind) => add('series', 'chart', { kind, x, series: [{ path: y }] }, path, 2);
  const breakdown = (path, columns, sort) => add('breakdown', 'table', { columns, sort: { column: sort, dir: 'desc' } }, path, 3, 12);
  const events = (path, date) => add('events', 'timeline', { date }, path, 2);
  const named = groups => groups.every(g => typeof g?.label === 'string' && g.label.trim() && !/\p{N}/u.test(g.label)) ? 'label' : 'key';
  switch (`${name}.${args.operation}`) {
    case 'spending.total':
      if (args.groupBy === 'month') series('groups', 'key', 'figure', 'bar');
      else if (BREAKDOWN.includes(args.groupBy)) breakdown('groups', [named(items('groups')), 'figure'], 'figure');
      break;
    case 'spending.projection': series('years', 'year', 'spending', 'line'); break;
    case 'accounts.net_worth':
      series('series', 'month', 'total', 'line');
      breakdown('groups', [named(items('groups')), 'figure'], 'figure');
      break;
    case 'goals.pace':
      for (const id of Object.keys(result?.series?.goals ?? {})) if (validPath(id)) series(`series.goals.${id}.series`, 'month', 'plan.envelope', 'line');
      break;
    case 'business.pnl':
      if (args.groupBy === 'category') items('entities').forEach((_, i) => breakdown(`entities.${i}.groups`, ['key', 'revenue', 'expenses', 'profit'], 'expenses'));
      break;
    case 'recommendations.wargame':
      if (Object.hasOwn(WARGAME, args.name)) add('wargame', 'compare', { fields: WARGAME[args.name][1] }, WARGAME[args.name][0], 2, 8);
      break;
    case 'household.deadlines': events('', 'date'); break;
    case 'spending.obligations': events('obligations', 'endDate'); break;
    case 'spending.recurring': events('charges', 'nextExpected'); break;
  }
  return out;
}

export function autoSpecs(results) {
  return results.filter(r => r && !r.isError && r.name !== 'show' && r.args && typeof r.args === 'object')
    .flatMap(candidates).sort((a, b) => RANK[a.shape] - RANK[b.shape]);
}

// Every selected figure is unavailable: the block would only show gaps.
function gapOnly(op, spec, results) {
  const paths = op === 'chart' ? spec.series.map(s => s.path) : op === 'timeline' ? [spec.date] : spec.columns ?? spec.fields;
  const figures = resolve(spec.source, results).flatMap(item => paths.map(p => at(item, p))).filter(isFigure);
  return figures.length > 0 && figures.every(f => f.value === null);
}

export function autoBlocks(results, { now, ids = [] } = {}) {
  const blocks = [], drawn = [], taken = new Set(ids);
  for (const { op, spec } of autoSpecs(results)) {
    if (blocks.length >= MAX) break;
    const [source] = sources(op, spec);
    if (drawn.some(s => s.tool === source.tool && isDeepStrictEqual(s.args, source.args))) continue;
    let n = 1;
    while (taken.has(`b${n}`)) n++;
    const made = makeBlock(op, spec, results, { id: `b${n}`, now, origin: 'auto' });
    if (!made.ok || gapOnly(op, spec, results)) continue;
    taken.add(made.block.id); drawn.push(source); blocks.push(made.block);
  }
  return blocks;
}
