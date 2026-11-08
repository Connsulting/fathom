import { randomUUID } from 'node:crypto';
import { tx } from '../store/db.mjs';
import { loadContent, loadCurve } from '../scenario/build.mjs';
import { ToolError } from '../tools/errors.mjs';

export function setCurvePositions(db, positions, { now = new Date().toISOString(), actorId = 'ui', conversationKey = null, origin = 'you', onWrite } = {}) {
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw new ToolError('bad_input', 'positions must be an object');
  const changes = Object.entries(positions);
  if (!changes.length || changes.length > 20) throw new ToolError('bad_input', 'send one to twenty curve positions');
  const axes = loadCurve(db, loadContent(db));
  for (const [id, value] of changes) {
    if (!axes.some(a => a.id === id)) throw new ToolError('bad_input', 'unknown curve axis');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ToolError('bad_input', 'value must be a number from 0 to 1');
  }
  return tx(db, () => {
    if (db.prepare('SELECT count(*) n FROM preferences').get().n + changes.length > 100) throw new ToolError('bad_input', 'Keep at most 100 preferences. Edit or delete one on the Memories page.');
    const rows = [];
    for (const [id, value] of changes) {
      const axis = axes.find(a => a.id === id);
      const text = `Tradeoff toward ${JSON.stringify(axis.right)}: ${Math.round(value * 100) / 100}.`;
      const key = randomUUID();
      db.prepare(`INSERT INTO preferences (id, text, actor_id, origin, conversation_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key, text, actorId, origin, conversationKey, now, now);
      rows.push(db.prepare('SELECT * FROM preferences WHERE id = ?').get(key));
    }
    onWrite?.([], rows);
    return Object.fromEntries(loadCurve(db, loadContent(db)).map(a => [a.id, a.value]));
  });
}
