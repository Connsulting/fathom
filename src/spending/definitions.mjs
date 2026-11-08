import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BUILTIN_DEFINITIONS, CATEGORY_CLASSES } from '../calc/classes.mjs';
import { BUCKETS, normalizeMerchant } from '../categories/resolve.mjs';
import { tx, parseJson } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, saveReceipt, registerReceiptKind } from '../actions/receipts.mjs';
import { requireEvidence } from '../actions/evidence.mjs';

const fail = message => { throw new ToolError('bad_input', message); };
const classes = new Set([...Object.values(CATEGORY_CLASSES).map(c => c.class), 'essential_other', 'unclassified']);
const savedOut = row => ({ id: row.id, name: row.name, def: parseJson(row.def, {}), source: 'saved', preferenceId: row.preferenceId, updatedAt: row.updated_at });
const savedRows = db => db.prepare(`SELECT d.*, p.id AS preferenceId FROM spending_definitions d
  JOIN preferences p ON p.definition_id = d.id ORDER BY d.id`).all();
export const spendingDefinitions = db => [
  ...Object.values(BUILTIN_DEFINITIONS).map(d => structuredClone(d)), ...savedRows(db).map(savedOut),
];
export function resolveDefinition(db, id) {
  if (id === undefined) return null;
  if (Object.hasOwn(BUILTIN_DEFINITIONS, id)) return structuredClone(BUILTIN_DEFINITIONS[id]);
  const row = savedRows(db).find(d => d.id === id);
  if (!row) fail('Unknown spending definition');
  return savedOut(row);
}

function definitionId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{1,39}$/.test(id)) fail('definitionId must be a slug from 2 to 40 characters.');
  if (Object.hasOwn(BUILTIN_DEFINITIONS, id)) fail('Built-in definitions cannot be changed.');
  return id;
}
export function validateDefinition({ definitionId: id, name, def }) {
  definitionId(id);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(name)) fail('name must be one line from 1 to 60 characters.');
  if (!def || typeof def !== 'object' || Array.isArray(def) || Object.keys(def).some(k => !['include', 'exclude'].includes(k))) fail('def must contain include or exclude selectors.');
  const clean = {};
  for (const [key, selector] of Object.entries(def)) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) fail('A selector must be an object.');
    clean[key] = {};
    for (const [field, values] of Object.entries(selector)) {
      if (!['buckets', 'categories', 'classes', 'accounts', 'merchants'].includes(field)
        || !Array.isArray(values) || values.length > 50 || !values.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) fail('Invalid definition selector.');
      if (field === 'buckets' && values.some(v => !BUCKETS.includes(v))) fail('Invalid bucket selector.');
      if (field === 'classes' && values.some(v => !classes.has(v))) fail('Invalid class selector.');
      clean[key][field] = [...new Set(field === 'merchants' ? values.map(normalizeMerchant) : values)];
    }
  }
  return { id, name: name.trim(), def: clean };
}
const plain = row => row ? { ...row } : null;
const snapshot = (db, id) => ({
  definition: plain(db.prepare('SELECT * FROM spending_definitions WHERE id = ?').get(id)),
  preference: plain(db.prepare('SELECT * FROM preferences WHERE definition_id = ?').get(id)),
});
function restoreRows(db, id, state) {
  db.prepare('DELETE FROM preferences WHERE definition_id = ?').run(id);
  db.prepare('DELETE FROM spending_definitions WHERE id = ?').run(id);
  for (const [table, row] of [['spending_definitions', state.definition], ['preferences', state.preference]]) {
    if (!row) continue;
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
  }
}
registerReceiptKind('spending_definition', { restore(ctx, { id, before, after }) {
  if (!isDeepStrictEqual(snapshot(ctx.db, id), after)) throw new ToolError('conflict', 'This item changed since that action. Ask for a new change instead.');
  restoreRows(ctx.db, id, before);
} });

export function saveDefinition(ctx, args) {
  const actor = requireActor(ctx), clean = validateDefinition(args);
  requireEvidence(ctx.channel === 'mcp' ? { ...ctx, ownerText: args.evidence } : ctx, args.evidence, { evidence: args.evidence });
  let receipt;
  tx(ctx.db, () => {
    const before = snapshot(ctx.db, clean.id);
    if (!before.definition && ctx.db.prepare('SELECT count(*) n FROM spending_definitions').get().n >= 50) fail('Keep at most 50 saved definitions.');
    if (!before.preference && ctx.db.prepare('SELECT count(*) n FROM preferences').get().n >= 100) fail('Keep at most 100 preferences.');
    if (before.definition?.name === clean.name && isDeepStrictEqual(parseJson(before.definition.def, {}), clean.def)) return;
    const stamp = new Date(ctx.now ?? Date.now()).toISOString();
    const text = `When I say ${clean.name}, use my saved spending definition ${clean.id}.`;
    const conversation = /^ask:[a-f0-9]{12}$/.test(ctx.conversationKey ?? '') ? ctx.conversationKey : null;
    ctx.db.prepare(`INSERT INTO spending_definitions(id,name,def,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, def=excluded.def, updated_at=excluded.updated_at`)
      .run(clean.id, clean.name, JSON.stringify(clean.def), stamp);
    if (before.preference) ctx.db.prepare('UPDATE preferences SET text=?, actor_id=?, updated_at=? WHERE id=?').run(text, actor, stamp, before.preference.id);
    else ctx.db.prepare(`INSERT INTO preferences(id,text,actor_id,created_at,updated_at,origin,conversation_key,definition_id)
      VALUES (?,?,?,?,?,'ask',?,?)`).run(randomUUID(), text, actor, stamp, stamp, conversation, clean.id);
    receipt = saveReceipt(ctx, { scope: 'write:preferences', kind: 'spending_definition', id: clean.id,
      label: 'Saved spending definition', before, after: snapshot(ctx.db, clean.id), from: before.preference?.text ?? null, to: text });
  });
  ctx.onReceipt?.(receipt ?? null);
  return { definition: resolveDefinition(ctx.db, clean.id), receipt: receipt ?? null };
}
export function deleteDefinition(ctx, id) {
  requireActor(ctx);
  definitionId(id);
  let receipt;
  tx(ctx.db, () => {
    const before = snapshot(ctx.db, id);
    if (!before.definition) throw new ToolError('not_found', 'No such saved definition.');
    restoreRows(ctx.db, id, { definition: null, preference: null });
    receipt = saveReceipt(ctx, { scope: 'write:preferences', kind: 'spending_definition', id,
      label: 'Deleted spending definition', before, after: snapshot(ctx.db, id), from: before.preference?.text ?? before.definition.name, to: null });
  });
  ctx.onReceipt?.(receipt);
  return { deleted: true, receipt };
}
