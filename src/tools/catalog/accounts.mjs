import { plainDeep } from './figures.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { sourcesView } from '../../ingest/freshness.mjs';
import { mapSeries } from '../../shared/series.mjs';
function where(conds) { const used = conds.filter(c => c[1] !== undefined); return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) }; }

export const operations = [
{
    tool: 'accounts', name: 'list',
    summary: 'Current (not archived) accounts with latest balance and date; masks only.', route: 'Account balances and owners', routes: [],
    params: {},
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      const scope = await tokenScope(ctx.db);
      const latest = ctx.db.prepare('SELECT date, amount FROM balances WHERE account_id = ? ORDER BY date DESC LIMIT 1');
      const naming = await accountNaming(ctx.db);
      return await mapSeries((await ctx.db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY sort, id').all()), async a => {
        const b = await latest.get(a.id);
        const out = {
          id: a.id, inst: a.inst, mask: a.mask,
          name: accountLabel(naming.byId.get(a.id) || a),
          importedName: a.name, owner: a.owner, kind: a.kind, mirror: a.mirror,
          note: a.note || '', balance: b ? b.amount : null, asOf: b ? b.date : null,
        };
        // Imported accounts carry text from uploaded files: verbatim, never token-resolved.
        return a.parser === 'demo-seed' ? plainDeep(scope, out) : out;
      });
    },
  },
{
    tool: 'accounts', name: 'sources',
    summary: 'Data sources by real name with date range, history or stale state, accounts and files.', route: 'Data sources and their files', routes: ['GET /api/sources'],
    params: {},
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      return { sources: await sourcesView(ctx.db) };
    },
  },
{
    tool: 'accounts', name: 'holdings',
    summary: 'Investment positions by account.', route: 'Investment holdings', routes: [],
    params: {"id":{"type":"string"}},
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      // An archived account's holdings are history, not current investments.
      const { clause, params } = where([['account_id = ?', args.id]]);
      const live = (clause ? ' AND' : ' WHERE') + ' account_id NOT IN (SELECT id FROM accounts WHERE archived_at IS NOT NULL)';
      return (await ctx.db.prepare('SELECT * FROM positions' + clause + live + ' ORDER BY account_id, id').all(...params)).map(p => ({
        accountId: p.account_id, symbol: p.symbol, name: p.name, quantity: p.quantity, price: p.price, value: p.value,
        costBasis: p.cost_basis, asOf: p.as_of,
      }));
    },
  },
];
