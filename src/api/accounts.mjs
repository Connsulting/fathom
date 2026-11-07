// POST /api/accounts/:id/name  {displayName?: string|null} -> {scenario, account}
// Stores the owner's display name. Empty clears it, and the screens fall back to the default label.
// The imported name, source_id and mirror are left alone.

import { tx } from '../store/db.mjs';
import { validateDisplayName, accountLabel } from '../shared/account-label.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';

export function accountRename(ctx) {
  const id = ctx.params?.id;
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'missing account');
  const row = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'no such account');
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  if (!Object.hasOwn(body, 'displayName')) throw new HttpError(400, 'display name is required');
  const res = validateDisplayName(body.displayName);
  if (!res.ok) throw new HttpError(400, res.error);
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(res.value, id);
  });
  const scenario = scenarioOf(ctx);
  const account = scenario.accounts.find((a) => a.id === id) || null;
  return { scenario, account, label: accountLabel({ ...row, display_name: res.value }) };
}
