import { isDeepStrictEqual } from 'node:util';
import { validateBlock } from '../../blocks/validate.mjs';
import { buildSnapshot } from '../../blocks/snapshot.mjs';
import { sources } from '../../blocks/paths.mjs';

const path = { type: 'string', pattern: '^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)(?:\\.(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)){0,5}$' };
const ref = { type: 'object', additionalProperties: false, required: ['tool', 'args', 'path'], properties: {
  tool: { type: 'string' }, args: { type: 'object' }, path: { type: 'string' },
} };
const title = { type: 'string', minLength: 1, maxLength: 80 };
const fields = { type: 'array', minItems: 1, maxItems: 8, items: path };
const definitions = {
  chart: { required: ['kind', 'source', 'x', 'series'], params: {
    kind: { type: 'string', enum: ['line', 'bar', 'area', 'scatter'] }, source: ref, x: path,
    series: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['path'], properties: { path, source: ref } } },
    stacked: { type: 'boolean' }, title,
  } },
  table: { required: ['source', 'columns'], params: { source: ref, columns: fields,
    sort: { type: 'object', additionalProperties: false, required: ['column', 'dir'], properties: { column: path, dir: { type: 'string', enum: ['asc', 'desc'] } } }, title } },
  compare: { required: ['fields'], params: { source: ref, options: { type: 'array', minItems: 2, maxItems: 8,
    items: { type: 'object', additionalProperties: false, required: ['source'], properties: { source: ref } } }, fields, title } },
  timeline: { required: ['source', 'date'], params: { source: ref, date: path, value: path, title } },
};
export function droppedBlock(op, reason) {
  const name = { chart: 'chart', table: 'table', compare: 'comparison', timeline: 'timeline' }[op] || 'chart';
  return { op: Object.hasOwn(definitions, op) ? op : 'chart', reason, text: `A ${name} was left out because its data did not check out.` };
}
function dates(value) {
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.asOf === 'string' ? [value.asOf] : []), ...Object.values(value).flatMap(dates)];
}
// One block from validated reads: show and automatic blocks (src/blocks/auto.mjs) share this path.
// -> { ok: true, block } | { ok: false, reason }
export function makeBlock(op, spec, results, { id, now, origin }) {
  const validation = validateBlock(op, spec, results);
  if (!validation.ok) return validation;
  const snapshot = buildSnapshot(op, spec, results);
  const calls = sources(op, spec).map(({ tool, args }) => ({ tool, args }));
  const distinct = calls.filter((c, i) => !calls.slice(0, i).some(p => p.tool === c.tool && isDeepStrictEqual(p.args, c.args)));
  const block = { id, op, spec: structuredClone(spec), calls: structuredClone(distinct), snapshot,
    asOf: dates(snapshot).sort().at(-1) ?? null, builtAt: new Date(now).toISOString(), origin };
  return Buffer.byteLength(JSON.stringify(block), 'utf8') > 65_536 ? { ok: false, reason: 'too_large' } : { ok: true, block };
}
export const operations = Object.entries(definitions).map(([name, shape]) => ({
  tool: 'show', name, scope: 'read', summary: `Draw a ${name} from earlier tool results.`, route: 'Draw results in this answer', routes: [], ...shape,
  handler(spec, ctx) {
    const results = ctx.turnResults();
    const id = `b${results.filter(c => c.name === 'show' && !c.isError && c.result?.status === 'shown').length + 1}`;
    const made = makeBlock(name, spec, results, { id, now: ctx.now, origin: 'model' });
    if (!made.ok) {
      const note = droppedBlock(name, made.reason);
      return { status: 'dropped', reason: note.reason, note: note.text };
    }
    ctx.onBlock(made.block);
    return { block: id, status: 'shown', place: `{b:${id}}` };
  },
}));
export const askRules = [
  'For trends, breakdowns, rankings or comparisons, call show after reads with their exact tool and arguments as source. At most four blocks per answer.',
  'No numbers, numeric labels or markup in show; select existing result paths.',
  'Put {b:<id>} on its own line. In prose, quote only figures the answer turns on; do not repeat every block value.',
  'Omit dropped blocks.',
];
