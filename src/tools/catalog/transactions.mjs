import { loadCategoryInputs } from '../../categories/store.mjs';
import { resolveCategories, normalizeMerchant, BUCKETS } from '../../categories/resolve.mjs';
import { classOf } from '../../calc/classes.mjs';
import { CLASSES } from './spending.mjs';
import { ToolError } from '../errors.mjs';

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const operations = [
  {
    tool: 'transactions',
    name: 'search',
    summary: 'Search transaction examples by ids, account, dates, amount, category or text. Never sum rows.',
    route: 'Example transaction rows',
    routes: ['GET /api/accounts/:id/transactions', 'GET /api/spending/rows'],
    params: obj({
      ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50 },
      accountId: { type: 'string' },
      from: { type: 'string', pattern: DATE },
      to: { type: 'string', pattern: DATE },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      category: { type: 'string' },
      bucket: { type: 'string', enum: BUCKETS },
      class: { type: 'string', enum: CLASSES },
      merchant: { type: 'string', minLength: 1, maxLength: 200 },
      cursor: { type: 'string', maxLength: 500 },
      text: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }).properties,
    required: [],
    scope: 'read',
    handler(args, ctx) {
      const input = loadCategoryInputs(ctx.db),
        resolved = resolveCategories(input);
      let cursor;
      if (args.cursor) {
        try {
          cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
        } catch {
          throw new ToolError('bad_input', 'Invalid transaction cursor');
        }
        if (
          !cursor ||
          typeof cursor.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(cursor.date) ||
          !Number.isSafeInteger(cursor.id)
        )
          throw new ToolError('bad_input', 'Invalid transaction cursor');
      }
      const all = input.transactions
        .map((t) => {
          const c = resolved.get(t.id);
          return {
            id: t.id,
            accountId: t.account_id,
            date: t.date,
            amount: t.amount,
            description: t.description,
            category: c.category,
            bucket: c.bucket,
            class: classOf(c.category, c.bucket),
            layer: c.layer,
            merchant: normalizeMerchant(t.description),
          };
        })
        .filter(
          (t) =>
            (!args.ids || args.ids.includes(String(t.id))) &&
            (args.accountId === undefined || t.accountId === args.accountId) &&
            (args.from === undefined || t.date >= args.from) &&
            (args.to === undefined || t.date <= args.to) &&
            (args.minAmount === undefined || t.amount >= args.minAmount) &&
            (args.maxAmount === undefined || t.amount <= args.maxAmount) &&
            (args.category === undefined || t.category === args.category) &&
            (args.bucket === undefined || t.bucket === args.bucket) &&
            (args.class === undefined || t.class === args.class) &&
            (args.merchant === undefined || t.merchant === normalizeMerchant(args.merchant)) &&
            (args.text === undefined ||
              String(t.description ?? '')
                .toLowerCase()
                .includes(args.text.toLowerCase())),
        )
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      const remaining = all.filter(
        (t) => !cursor || t.date < cursor.date || (t.date === cursor.date && t.id < cursor.id),
      );
      const limit = args.ids ? Math.max(args.ids.length, args.limit ?? 0) : (args.limit ?? 50);
      const rows = remaining.slice(0, limit);
      const last = rows.at(-1),
        truncated = remaining.length > rows.length;
      return {
        rows,
        total: all.length,
        truncated,
        next:
          truncated && last
            ? Buffer.from(JSON.stringify({ date: last.date, id: last.id })).toString('base64url')
            : null,
      };
    },
  },
];

export const rules = ['A card payment from checking moves money to the card; it is not new spending.'];
