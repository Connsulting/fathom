import { isDeepStrictEqual } from 'node:util';
import { registerReceiptKind, requireScope } from '../actions/receipts.mjs';
import { ToolError } from '../tools/errors.mjs';

const TABLES = ['files', 'sources', 'accounts', 'account_holders', 'transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'facts', 'figures',
  'held_facts', 'confirm_items', 'superseded_rows', 'transaction_category_imports', 'transaction_category_corrections', 'transaction_category_guesses', 'column_mappings', 'import_proposals'];
const keys = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
const identity = (row, pk) => JSON.stringify(pk.map(k => row[k]));
export function importSnapshot(db) {
  return Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
}
export function importChanges(db, before, after) {
  return TABLES.flatMap(table => {
    const pk = keys(db, table), prior = new Map(before[table].map(row => [identity(row, pk), row])), next = new Map(after[table].map(row => [identity(row, pk), row]));
    return [...new Set([...prior.keys(), ...next.keys()])].filter(id => !isDeepStrictEqual(prior.get(id), next.get(id)))
      .map(id => ({ table, pk, before: prior.get(id) ?? null, after: next.get(id) ?? null }));
  });
}
registerReceiptKind('model_import', { restore(ctx, { before, after, receipt, checkOnly }) {
  for (const scope of after.scopes) requireScope(ctx, scope);
  const conflict = () => { throw new ToolError('conflict', 'This import changed or a later change depends on it.'); };
  const group = ctx.db.prepare("SELECT id,after_state FROM action_receipts WHERE kind='receipt_group' AND undone_at IS NULL").all().find(r => JSON.parse(r.after_state).childIds.includes(receipt.id));
  const batch = ctx.db.prepare('SELECT * FROM import_batches WHERE receipt_id=?').get(group?.id ?? receipt.id);
  if (!batch || batch.status !== 'committed') conflict();
  for (const change of after.changes) {
    if (!TABLES.includes(change.table) || !isDeepStrictEqual(keys(ctx.db, change.table), change.pk)) conflict();
    const row = change.after ?? change.before;
    const current = ctx.db.prepare(`SELECT * FROM ${change.table} WHERE ${change.pk.map(k => `${k}=?`).join(' AND ')}`).get(...change.pk.map(k => row[k]));
    if (!isDeepStrictEqual(current ? { ...current } : null, change.after)) conflict();
    if (change.table === 'transactions' && change.after && !change.before) {
      for (const table of ['transaction_category_corrections', 'transaction_category_guesses', 'transaction_category_imports']) {
        const dependencies = ctx.db.prepare(`SELECT * FROM ${table} WHERE transaction_id=?`).all(row.id);
        if (dependencies.some(dep => !after.changes.some(c => c.table === table && isDeepStrictEqual(c.after, { ...dep })))) conflict();
      }
    }
  }
  if (checkOnly) return;
  for (const change of after.changes.toReversed()) {
    const row = change.after ?? change.before;
    const where = change.pk.map(k => `${k}=?`).join(' AND ');
    if (change.before && change.after) {
      const cols = Object.keys(change.before).filter(k => !change.pk.includes(k));
      ctx.db.prepare(`UPDATE ${change.table} SET ${cols.map(k => `${k}=?`).join(',')} WHERE ${where}`).run(...cols.map(k => change.before[k]), ...change.pk.map(k => row[k]));
    } else if (!change.before) ctx.db.prepare(`DELETE FROM ${change.table} WHERE ${where}`).run(...change.pk.map(k => row[k]));
    else {
      const cols = Object.keys(change.before);
      ctx.db.prepare(`INSERT INTO ${change.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(k => change.before[k]));
    }
  }
  if (after.mapping && !before.mappingApproved) ctx.db.prepare("UPDATE column_mappings SET approval_status='invalidated' WHERE signature=? AND mapping_version=?")
    .run(after.mapping.id, after.mapping.version);
  ctx.db.prepare("UPDATE import_batches SET status='undone',undone_at=? WHERE id=?").run(new Date(ctx.now ?? Date.now()).toISOString(), batch.id);
} });
