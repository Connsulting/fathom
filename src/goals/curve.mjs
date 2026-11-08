import { getSetting, setSetting, tx } from '../store/db.mjs';
import { loadContent, loadCurve } from '../scenario/build.mjs';
import { ToolError } from '../tools/errors.mjs';

export function setCurvePositions(db, positions, { onWrite } = {}) {
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw new ToolError('bad_input', 'positions must be an object');
  const changes = Object.entries(positions);
  if (!changes.length || changes.length > 20) throw new ToolError('bad_input', 'send one to twenty curve positions');
  const content = loadContent(db);
  const ids = new Set([...loadCurve(db, content).map(a => a.id),
    ...(Array.isArray(content.onboarding?.priorities) ? content.onboarding.priorities.map(p => p.id) : [])]);
  for (const [id, value] of changes) {
    if (!ids.has(id)) throw new ToolError('bad_input', 'unknown curve axis');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ToolError('bad_input', 'value must be a number from 0 to 1');
  }
  return tx(db, () => {
    const before = db.prepare("SELECT * FROM settings WHERE key = 'curve.positions'").get() ?? null;
    const next = { ...(getSetting(db, 'curve.positions', null) || {}) };
    for (const [id, value] of changes) next[id] = Math.round(value * 100) / 100;
    setSetting(db, 'curve.positions', next);
    const after = db.prepare("SELECT * FROM settings WHERE key = 'curve.positions'").get();
    onWrite?.(before, after);
    return next;
  });
}
