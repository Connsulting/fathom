import { cents } from '../../store/db.mjs';

const MONTH = '^\\d{4}-\\d{2}$';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function where(conds) {
  const used = conds.filter(c => c[1] !== undefined);
  return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) };
}

export const operations = [
  {
    tool: 'business', name: 'pnl',
    summary: 'Business profit and loss by month and category.', route: 'Business income, expenses and profit', routes: [],
    params: obj({ entity: { type: 'string' }, from: { type: 'string', pattern: MONTH }, to: { type: 'string', pattern: MONTH } }).properties,
    required: [], scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([['entity = ?', args.entity], ['period >= ?', args.from], ['period <= ?', args.to]]);
      const rows = ctx.db.prepare('SELECT period, category, sum(amount) AS amount FROM pnl_lines' + clause +
        ' GROUP BY period, category ORDER BY period, category').all(...params)
        .map(r => ({ period: r.period, category: r.category, amount: cents(r.amount) }));
      const totals = {};
      for (const r of rows) totals[r.period] = cents((totals[r.period] || 0) + r.amount);
      return { rows, totals };
    },
  },
];
