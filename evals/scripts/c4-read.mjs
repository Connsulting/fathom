import { callTool } from '../../src/tools/index.mjs';

export async function script({ turn, db, clock }) {
  const calls = turn.required.map((r) => {
    const args = { operation: r.operation };
    for (const p of r.predicates) {
      let out = args;
      const parts = p.path.split('.'),
        key = parts.pop();
      for (const part of parts) out = out[part] ??= {};
      if (p.op === 'includes' || p.op === 'includes_or_absent') (out[key] ??= []).push(p.value);
      else if (p.op !== 'exists') out[key] = p.value;
    }
    if (r.name === 'spending' && args.annualize) {
      const meta = JSON.parse(db.prepare("SELECT value FROM content WHERE key='meta'").get().value);
      const through = new Date(meta.dataThrough),
        year = through.getUTCFullYear(),
        month = through.getUTCMonth();
      const complete = through.getUTCDate() === new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      args.window = 'custom';
      args.from = `${year}-01`;
      args.to = new Date(Date.UTC(year, month + (complete ? 1 : 0), 0)).toISOString().slice(0, 7);
    }
    if (args.operation === 'compare') {
      args.a ??= { from: '2025-01', to: '2025-08' };
      args.b ??= { from: '2026-01', to: '2026-08' };
    }
    if (args.window === 'custom' && !args.from) {
      args.from = '2026-07';
      args.to = '2026-09';
    }
    if (args.operation === 'recurring') args.since ??= '2026-06-01';
    return { name: r.name, args };
  });
  const results = [];
  for (const call of calls) results.push(await callTool(call.name, call.args, { db, clock }));
  const figures = [];
  const collect = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Object.hasOwn(v, 'value') && v.unit && v.value !== null) {
      figures.push(v);
      return;
    }
    for (const c of Object.values(v)) collect(c);
  };
  for (const result of results) collect(result);
  const primary = results[0]?.total ?? results[0]?.totals?.household?.net ?? results[0]?.totals?.profit ?? figures[0];
  return [
    { toolCalls: calls, costUsd: 0 },
    {
      text: primary
        ? `${primary.direction === 'out' && calls[0].args.operation === 'cash_flow' ? 'The net cash outflow is' : 'The returned result is'} ${primary.quote ?? primary.value}.`
        : 'No matching figures are available in this selection.',
      costUsd: 0,
    },
  ];
}
