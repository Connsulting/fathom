import { plainDeep } from './figures.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
function where(conds) { const used = conds.filter(c => c[1] !== undefined); return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) }; }

export const operations = [
{
    tool: 'accounts', name: 'list',
    summary: 'Mirrored accounts with latest balance and date; masks only.', route: 'Account balances and owners', routes: [],
    params: {},
    required: [],
    scope: 'read',
    handler(args, ctx) {
      const scope = tokenScope(ctx.db);
      const latest = ctx.db.prepare('SELECT date, amount FROM balances WHERE account_id = ? ORDER BY date DESC LIMIT 1');
      const naming = accountNaming(ctx.db);
      return ctx.db.prepare('SELECT * FROM accounts ORDER BY sort, id').all().map(a => {
        const b = latest.get(a.id);
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
    tool: 'accounts', name: 'holdings',
    summary: 'Investment positions by account.', route: 'Investment holdings', routes: [],
    params: {"id":{"type":"string"}},
    required: [],
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([['account_id = ?', args.id]]);
      return ctx.db.prepare('SELECT * FROM positions' + clause + ' ORDER BY account_id, id').all(...params).map(p => ({
        accountId: p.account_id, symbol: p.symbol, name: p.name, quantity: p.quantity, price: p.price, value: p.value,
        costBasis: p.cost_basis, asOf: p.as_of,
      }));
    },
  },
];
