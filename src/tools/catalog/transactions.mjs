const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function where(conds) {
  const used = conds.filter(c => c[1] !== undefined);
  return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) };
}

export const tools = [
  {
    name: 'query_transactions',
    description: 'Search transactions by account, date range (inclusive, YYYY-MM-DD), amount range, category or description text. ' +
      'Without accountId it covers every account, credit cards included. Each row has accountId, date, a signed amount (money out is negative, money in positive), description and category; ' +
      'credit card rows carry the budgeting app category, so group spending by it. Returns at most `limit` rows (default 50, max 200), newest first, with the total match count.',
    inputSchema: obj({
      accountId: { type: 'string' },
      from: { type: 'string', pattern: DATE },
      to: { type: 'string', pattern: DATE },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      category: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([
        ['account_id = ?', args.accountId],
        ['date >= ?', args.from],
        ['date <= ?', args.to],
        ['amount >= ?', args.minAmount],
        ['amount <= ?', args.maxAmount],
        ['category = ?', args.category],
        ["lower(description) LIKE ? ESCAPE '\\'",
          args.text === undefined ? undefined : '%' + args.text.toLowerCase().replace(/[\\%_]/g, c => '\\' + c) + '%'],
      ]);
      const limit = args.limit === undefined ? 50 : args.limit;
      const total = ctx.db.prepare('SELECT count(*) AS n FROM transactions' + clause).get(...params).n;
      const rows = ctx.db.prepare('SELECT id, account_id, date, amount, description, category FROM transactions' + clause +
        ' ORDER BY date DESC, id DESC LIMIT ?').all(...params, limit)
        .map(r => ({ id: r.id, accountId: r.account_id, date: r.date, amount: r.amount, description: r.description, category: r.category }));
      return { rows, truncated: total > rows.length, total };
    },
  },
];

export const parity = {};
