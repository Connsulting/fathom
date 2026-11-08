import { deleteDefinition } from '../spending/definitions.mjs';
import { randomUUID } from 'node:crypto';
import { tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, saveReceipt } from './receipts.mjs';
import { requireEvidence } from './evidence.mjs';
import { txWith } from '../store/db.mjs';

export const listPreferences = async db => await db.prepare('SELECT id, text, actor_id AS actorId, definition_id AS definitionId FROM preferences ORDER BY created_at, id').all();

// Every remembered preference, newest first, with where it came from. origin is 'ask', 'you',
// or null for a row written before migration 028.
export const listMemories = async db => await db.prepare(`SELECT id, text, actor_id AS actorId, definition_id AS definitionId, origin, conversation_key AS conversationKey,
  created_at AS createdAt, updated_at AS updatedAt FROM preferences ORDER BY created_at DESC, id`).all();

export function validatePreference(text) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 300 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ToolError('bad_input', 'A preference must be one line of text, from 1 to 300 characters.');
  }
  return text.trim();
}

export async function writePreference(ctx, { id, text, evidence }, { fromAsk = false, remove = false } = {}) {
  const actorId = await requireActor(ctx);
  const linked = id ? (await ctx.db.prepare('SELECT definition_id FROM preferences WHERE id = ?').get(id))?.definition_id : null;
  if (linked) {
    if (!remove) throw new ToolError('bad_input', 'Change the definition instead');
    return { preference: null, ...await deleteDefinition(ctx, linked) };
  }
  const clean = remove ? null : validatePreference(text);
  if (fromAsk) await requireEvidence(ctx, clean, { evidence });
  let receipt;
  const preference = await txWith(ctx, async (ctx) => {
    const before = id ? await ctx.db.prepare('SELECT * FROM preferences WHERE id = ?').get(id) : null;
    if (id && !before) throw new ToolError('not_found', 'no such preference');
    if (before && !remove && before.text === clean) { receipt = null; return { id, text: clean }; }
    const now = new Date(ctx.now ?? Date.now()).toISOString();
    const key = id || randomUUID();
    if (remove) await ctx.db.prepare('DELETE FROM preferences WHERE id = ?').run(key);
    else if (before) await ctx.db.prepare('UPDATE preferences SET text = ?, actor_id = ?, updated_at = ? WHERE id = ?').run(clean, actorId, now, key);
    else {
      if ((await ctx.db.prepare('SELECT count(*) n FROM preferences').get()).n >= 100) throw new ToolError('bad_input', 'Keep at most 100 preferences. Edit or delete one on the Memories page.');
      const conversationKey = typeof ctx.conversationKey === 'string' && /^ask:[a-f0-9]{12}$/.test(ctx.conversationKey) ? ctx.conversationKey : null;
      await ctx.db.prepare(`INSERT INTO preferences (id, text, actor_id, origin, conversation_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key, clean, actorId, fromAsk ? 'ask' : 'you', conversationKey, now, now);
    }
    const after = remove ? null : await ctx.db.prepare('SELECT * FROM preferences WHERE id = ?').get(key);
    receipt = await saveReceipt(ctx, { scope: 'write:preferences', kind: 'preference', id: key, label: 'Household preference',
      before: before || null, after, from: before?.text || null, to: after?.text || null });
    return after ? { id: key, text: clean } : null;
  });
  ctx.onReceipt?.(receipt);
  return { preference, receipt };
}
