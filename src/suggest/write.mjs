import { getSetting, setSetting, tx } from '../store/db.mjs';
import { buildSuggestions, SUGGEST_SETTING, withdrawalRateOf } from './build.mjs';
import { TARGET_PARAMETERS } from '../calc/targets.mjs';
import { ToolError } from '../tools/errors.mjs';

export function setGoalSuggestion(db, id, body, { clock, onWrite } = {}) {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!row) throw new ToolError('not_found', 'no such goal');
  if (row.origin !== 'owner') throw new ToolError('conflict', 'this goal came with the demo and has no suggested target');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ToolError('bad_input', 'send an action or a withdrawal rate');
  const hasAction = Object.hasOwn(body, 'action'), hasRate = Object.hasOwn(body, 'withdrawalRate');
  if (hasAction === hasRate) throw new ToolError('bad_input', 'send either an action or a withdrawal rate');
  if (hasAction && !['dismiss', 'restore'].includes(body.action)) throw new ToolError('bad_input', 'action must be dismiss or restore');
  const { withdrawalRateMin: min, withdrawalRateMax: max } = TARGET_PARAMETERS;
  if (hasRate && (typeof body.withdrawalRate !== 'number' || !Number.isFinite(body.withdrawalRate) || body.withdrawalRate < min || body.withdrawalRate > max)) {
    throw new ToolError('bad_input', `withdrawalRate must be a number from ${min} to ${max}`);
  }
  const record = buildSuggestions(db, { clock }).suggestions.find(s => s.goalId === id);
  if (!record) throw new ToolError('conflict', 'this goal has a target or is not active, so it has no suggestion');
  if (hasRate && record.kind !== 'independence') throw new ToolError('bad_input', 'only a work-optional goal has a withdrawal rate');
  return tx(db, () => {
    const before = db.prepare('SELECT * FROM settings WHERE key = ?').get(SUGGEST_SETTING) ?? null;
    const stored = getSetting(db, SUGGEST_SETTING, null);
    const ids = new Set(db.prepare('SELECT id FROM goals').all().map(r => r.id));
    const next = Object.fromEntries(Object.entries(stored && typeof stored === 'object' ? stored : {}).filter(([key]) => ids.has(key)));
    const entry = { dismissed: null, ...(next[id] || {}) };
    if (body.action === 'dismiss') entry.dismissed = record.fingerprint;
    else if (body.action === 'restore') entry.dismissed = null;
    else entry.withdrawalRate = Math.round(body.withdrawalRate * 10000) / 10000;
    next[id] = entry;
    setSetting(db, SUGGEST_SETTING, next);
    const after = db.prepare('SELECT * FROM settings WHERE key = ?').get(SUGGEST_SETTING);
    onWrite?.(before, after);
    return { goalId: id, dismissed: entry.dismissed === record.fingerprint, withdrawalRate: withdrawalRateOf(entry) };
  });
}
