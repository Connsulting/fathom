import { isDeepStrictEqual } from 'node:util';
import { registerReceiptKind, requireScope } from '../actions/receipts.mjs';
import { ToolError } from '../tools/errors.mjs';
import { flatMapSeries, mapSeries, someSeries } from '../shared/series.mjs';

const TABLES = ['files', 'sources', 'accounts', 'account_holders', 'transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'facts', 'figures',
  'held_facts', 'confirm_items', 'superseded_rows', 'transaction_category_imports', 'transaction_category_corrections', 'transaction_category_guesses', 'column_mappings', 'import_proposals'];
const keys = async (db, table) => (await db.columns(table)).filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
const identity = (row, pk) => JSON.stringify(pk.map(k => row[k]));
export async function importSnapshot(db) {
  return Object.fromEntries(await mapSeries(TABLES, async table => [table, (await db.prepare(`SELECT * FROM ${table}`).all()).map(row => ({ ...row }))]));
}
export async function importChanges(db, before, after) {
  return await flatMapSeries(TABLES, async table => {
    const pk = keys(db, table), prior = new Map(before[table].map(row => [identity(row, pk), row])), next = new Map(after[table].map(row => [identity(row, pk), row]));
    return [...new Set([...prior.keys(), ...next.keys()])].filter(id => !isDeepStrictEqual(prior.get(id), next.get(id)))
      .map(id => ({ table, pk, before: prior.get(id) ?? null, after: next.get(id) ?? null }));
  });
}
export async function importCategoryState(db, changes) {
  return await mapSeries(changes.filter(c => c.table === 'transactions' && c.after), async c => ({ id: c.after.id,
    corrections: (await db.prepare('SELECT * FROM transaction_category_corrections WHERE transaction_id=?').all(c.after.id)).map(r => ({ ...r })),
    imports: (await db.prepare('SELECT * FROM transaction_category_imports WHERE transaction_id=?').all(c.after.id)).map(r => ({ ...r })),
  }));
}
async function automaticCategory(db, item, correction) {
  if (!correction || !await db.prepare("SELECT 1 FROM confirm_auto WHERE item_id=? AND rule='jev_category'").get(item.id)) return false;
  const log = JSON.parse((await db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(item.id))?.changes ?? '[]');
  return log.some(c => c.table === 'transaction_category_corrections' && c.after && isDeepStrictEqual(JSON.parse(c.after),correction));
}
registerReceiptKind('model_import', { async restore(ctx, { before, after, receipt, checkOnly }) {
  for (const scope of after.scopes) requireScope(ctx, scope);
  const conflict = () => { throw new ToolError('conflict', 'This import changed or a later change depends on it.'); };
  const group = (await ctx.db.prepare("SELECT id,after_state FROM action_receipts WHERE kind='receipt_group' AND undone_at IS NULL").all()).find(r => JSON.parse(r.after_state).childIds.includes(receipt.id));
  const batch = await ctx.db.prepare('SELECT * FROM import_batches WHERE receipt_id=?').get(group?.id ?? receipt.id);
  if (!batch || batch.status !== 'committed') conflict();
  const derived = [];
  for (const state of after.categories) {
    const corrections = (await ctx.db.prepare('SELECT * FROM transaction_category_corrections WHERE transaction_id=?').all(state.id)).map(r => ({ ...r }));
    const imports = (await ctx.db.prepare('SELECT * FROM transaction_category_imports WHERE transaction_id=?').all(state.id)).map(r => ({ ...r }));
    if (!isDeepStrictEqual(imports,state.imports)) conflict();
    const change = after.changes.find(c => c.table === 'transactions' && c.after?.id === state.id);
    if (change.before) {
      if (!isDeepStrictEqual(corrections,state.corrections)) conflict();
      continue;
    }
    const items = await ctx.db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_category' AND subject=?").all(String(state.id));
    const additional = items.filter(item => !after.changes.some(c => c.table === 'confirm_items' && c.after?.id === item.id));
    for (const item of additional) {
      if (await ctx.db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id)) conflict();
      if (item.status !== 'pending' && !await automaticCategory(ctx.db,item,corrections[0])) conflict();
    }
    if (!isDeepStrictEqual(corrections,state.corrections) && !(state.corrections.length === 0 && corrections.length === 1 && await someSeries(additional, async item => await automaticCategory(ctx.db,item,corrections[0])))) conflict();
    derived.push({ id:state.id, items:additional.map(item => item.id) });
  }
  for (const change of after.changes) {
    if (!TABLES.includes(change.table) || !isDeepStrictEqual(keys(ctx.db, change.table), change.pk)) conflict();
    const row = change.after ?? change.before;
    const current = await ctx.db.prepare(`SELECT * FROM ${change.table} WHERE ${change.pk.map(k => `${k}=?`).join(' AND ')}`).get(...change.pk.map(k => row[k]));
    if (!isDeepStrictEqual(current ? { ...current } : null, change.after)) conflict();
  }
  if (checkOnly) return;
  for (const row of derived) {
    await ctx.db.prepare('DELETE FROM transaction_category_guesses WHERE transaction_id=?').run(row.id);
    if (!after.categories.find(c => c.id === row.id).corrections.length) await ctx.db.prepare('DELETE FROM transaction_category_corrections WHERE transaction_id=?').run(row.id);
    for (const id of row.items) await ctx.db.prepare('DELETE FROM confirm_items WHERE id=?').run(id);
  }
  for (const change of after.changes.toReversed()) {
    const row = change.after ?? change.before;
    const where = change.pk.map(k => `${k}=?`).join(' AND ');
    if (change.before && change.after) {
      const cols = Object.keys(change.before).filter(k => !change.pk.includes(k));
      await ctx.db.prepare(`UPDATE ${change.table} SET ${cols.map(k => `${k}=?`).join(',')} WHERE ${where}`).run(...cols.map(k => change.before[k]), ...change.pk.map(k => row[k]));
    } else if (!change.before) await ctx.db.prepare(`DELETE FROM ${change.table} WHERE ${where}`).run(...change.pk.map(k => row[k]));
    else {
      const cols = Object.keys(change.before);
      await ctx.db.prepare(`INSERT INTO ${change.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(k => change.before[k]));
    }
  }
  if (after.mapping && !before.mappingApproved) await ctx.db.prepare("UPDATE column_mappings SET approval_status='invalidated' WHERE signature=? AND mapping_version=?")
    .run(after.mapping.id, after.mapping.version);
  await ctx.db.prepare("UPDATE import_batches SET status='undone',undone_at=? WHERE id=?").run(new Date(ctx.now ?? Date.now()).toISOString(), batch.id);
} });
