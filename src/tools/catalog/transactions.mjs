const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ' WHERE a AND b' and its params from [sql, value] pairs, skipping undefined values. An array
// value supplies one param per element (an IN list).
function where(conds) {
  const used = conds.filter(c => c[1] !== undefined);
  return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.flatMap(c => [].concat(c[1])) };
}

export const operations = [
  {
    tool: 'transactions', name: 'search',
    summary: 'Search transaction examples by ids, account, dates, amount, category or text. Never sum rows.', route: 'Example transaction rows', routes: ['GET /api/accounts/:id/transactions'],
    params: obj({
      ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50 },
      accountId: { type: 'string' },
      from: { type: 'string', pattern: DATE },
      to: { type: 'string', pattern: DATE },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      category: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }).properties,
    required: [], scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([
        [`id IN (${(args.ids || []).map(() => '?').join(', ')})`, args.ids],
        ['account_id = ?', args.accountId],
        ['date >= ?', args.from],
        ['date <= ?', args.to],
        ['amount >= ?', args.minAmount],
        ['amount <= ?', args.maxAmount],
        ['category = ?', args.category],
        ["lower(description) LIKE ? ESCAPE '\\'",
          args.text === undefined ? undefined : '%' + args.text.toLowerCase().replace(/[\\%_]/g, c => '\\' + c) + '%'],
      ]);
      // With ids, every matching id comes back: an old referenced row is never cut by the limit.
      const limit = args.ids ? Math.max(args.ids.length, args.limit ?? 0) : (args.limit === undefined ? 50 : args.limit);
      const total = ctx.db.prepare('SELECT count(*) AS n FROM transactions' + clause).get(...params).n;
      const rows = ctx.db.prepare('SELECT id, account_id, date, amount, description, category FROM transactions' + clause +
        ' ORDER BY date DESC, id DESC LIMIT ?').all(...params, limit)
        .map(r => ({ id: r.id, accountId: r.account_id, date: r.date, amount: r.amount, description: r.description, category: r.category }));
      return { rows, truncated: total > rows.length, total };
    },
  },
];

export const rules = ['A card payment from checking moves money to the card; it is not new spending.'];
