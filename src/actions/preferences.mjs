import { randomUUID } from 'node:crypto';
import { tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, saveReceipt } from './receipts.mjs';
import { requireEvidence } from './evidence.mjs';

export const listPreferences = db => db.prepare('SELECT id, text, actor_id AS actorId FROM preferences ORDER BY created_at, id').all();

export function validatePreference(text) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 300 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ToolError('bad_input', 'A preference must be one line of text, from 1 to 300 characters.');
  }
  return text.trim();
}

export function writePreference(ctx, { id, text, evidence }, { fromAsk = false, remove = false } = {}) {
  const actorId = requireActor(ctx);
  const clean = remove ? null : validatePreference(text);
  if (fromAsk) requireEvidence(ctx, clean, { evidence });
  let receipt;
  const preference = tx(ctx.db, () => {
    const before = id ? ctx.db.prepare('SELECT id, text, actor_id, created_at, updated_at FROM preferences WHERE id = ?').get(id) : null;
    if (id && !before) throw new ToolError('not_found', 'no such preference');
    if (before && !remove && before.text === clean) { receipt = null; return { id, text: clean }; }
    const now = new Date(ctx.now ?? Date.now()).toISOString();
    const key = id || randomUUID();
    if (remove) ctx.db.prepare('DELETE FROM preferences WHERE id = ?').run(key);
    else if (before) ctx.db.prepare('UPDATE preferences SET text = ?, actor_id = ?, updated_at = ? WHERE id = ?').run(clean, actorId, now, key);
    else {
      if (ctx.db.prepare('SELECT count(*) n FROM preferences').get().n >= 100) throw new ToolError('bad_input', 'Keep at most 100 preferences. Edit or delete one in Settings.');
      ctx.db.prepare('INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(key, clean, actorId, now, now);
    }
    const after = remove ? null : ctx.db.prepare('SELECT id, text, actor_id, created_at, updated_at FROM preferences WHERE id = ?').get(key);
    receipt = saveReceipt(ctx, { scope: 'write:preferences', kind: 'preference', id: key, label: 'Household preference',
      before: before || null, after, from: before?.text || null, to: after?.text || null });
    return after ? { id: key, text: clean } : null;
  });
  ctx.onReceipt?.(receipt);
  return { preference, receipt };
}
