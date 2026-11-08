// Goals and the tradeoff curve: owner-editable household data. Every route sits behind the owner
// gate (the router gates all of /api on a real store) and answers with the fresh scenario.
//
// POST /api/goals              {title, note?, horizon?, kind?, owner?, priority?, status?,
//                               ...the kind fields (src/shared/goals.mjs KIND_FIELDS)}  -> {scenario, goal}
// POST /api/goals/:id          the same fields, any subset; status done marks a goal done,
//                               open reopens it, archived archives it                -> {scenario, goal}
// POST /api/goals/:id/archive  {archived?: boolean, default true}; restoring reopens -> {scenario, goal}
// POST /api/goals/:id/delete   {}                                                   -> {scenario}
// POST /api/curve              {id, value} or {positions: {id: value}}              -> {scenario}
// GET  /api/goals/suggestions                                                     -> {clock, suggestions}
// POST /api/goals/:id/suggestion  {action: 'undo'}: undo a target Fathom set, declining it  -> {scenario}
//
// Every goal write runs the adoption pass for that goal (src/goals/write.mjs): a goal with no
// target gets the calculator's, recorded as set by Fathom.
//
// Owner goal text is stored as typed (trimmed) and rendered escaped, never token-resolved. A seed
// goal (the demo's) can be archived or deleted, not edited: its text carries scenario tokens.

import { createGoal, updateGoal, adoptSuggestions, undoAdoption } from '../goals/write.mjs';
import { ToolError } from '../tools/errors.mjs';
import { getSetting, setSetting } from '../store/db.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { clockNow, loadContent, loadCurve } from '../scenario/build.mjs';
import { buildSuggestions } from '../suggest/build.mjs';

const stamp = ctx => clockNow(ctx.db, ctx.config && ctx.config.clock);
const adopt = ctx => adoptSuggestions(ctx.db, { now: stamp(ctx), clock: ctx.config && ctx.config.clock });
const toolHttp = e => new HttpError(e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, e.message);

function goalRow(db, id) {
  const row = typeof id === 'string' ? db.prepare('SELECT * FROM goals WHERE id = ?').get(id) : null;
  if (!row) throw new HttpError(404, 'no such goal');
  return row;
}

const goalOut = (scenario, id) => scenario.goals.find(g => g.id === id) || null;

export function goalCreate(ctx) {
  try {
    const row = createGoal(ctx.db, ctx.body, { now: stamp(ctx), clock: ctx.config && ctx.config.clock });
    const scenario = scenarioOf(ctx);
    return { scenario, goal: goalOut(scenario, row.id) };
  } catch (e) { if (e instanceof ToolError) throw toolHttp(e); throw e; }
}

export function goalUpdate(ctx) {
  try {
    const row = updateGoal(ctx.db, ctx.params.id, ctx.body, { now: stamp(ctx), clock: ctx.config && ctx.config.clock });
    const scenario = scenarioOf(ctx);
    return { scenario, goal: goalOut(scenario, row.id) };
  } catch (e) { if (e instanceof ToolError) throw toolHttp(e); throw e; }
}

export function goalArchive(ctx) {
  const { db } = ctx;
  const row = goalRow(db, ctx.params.id);
  const { archived = true } = ctx.body;
  if (typeof archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
  const now = stamp(ctx);
  // Restoring reopens: a done goal archived itself, so bringing it back clears done too.
  if (archived) db.prepare('UPDATE goals SET archived_at = ?, updated_at = ? WHERE id = ?').run(row.archived_at || now, now, row.id);
  else db.prepare('UPDATE goals SET archived_at = NULL, done_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id);
  if (!archived) adopt(ctx);
  const scenario = scenarioOf(ctx);
  return { scenario, goal: goalOut(scenario, row.id) };
}

export function goalDelete(ctx) {
  const row = goalRow(ctx.db, ctx.params.id);
  ctx.db.prepare('DELETE FROM goals WHERE id = ?').run(row.id);
  return { scenario: scenarioOf(ctx) };
}

export const getPace = ctx => scenarioOf(ctx).pace;

// A position is a number from 0 to 1 for a known axis (the curve's axes, which the onboarding
// priorities share by id).
export function curveSet(ctx) {
  const { db } = ctx;
  const body = ctx.body;
  let changes;
  if (body.positions !== undefined) {
    if (!body.positions || typeof body.positions !== 'object' || Array.isArray(body.positions)) throw new HttpError(400, 'positions must be an object');
    changes = Object.entries(body.positions);
  } else changes = [[body.id, body.value]];
  const content = loadContent(db);
  const ids = new Set([...loadCurve(db, content).map(a => a.id),
    ...((content.onboarding && Array.isArray(content.onboarding.priorities)) ? content.onboarding.priorities.map(p => p.id) : [])]);
  if (!changes.length) throw new HttpError(400, 'send id and value');
  for (const [id, v] of changes) {
    if (typeof id !== 'string' || !ids.has(id)) throw new HttpError(400, 'unknown curve axis');
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new HttpError(400, 'value must be a number from 0 to 1');
  }
  const cur = getSetting(db, 'curve.positions', null) || {};
  const next = { ...cur };
  for (const [id, v] of changes) next[id] = Math.round(v * 100) / 100;
  setSetting(db, 'curve.positions', next);
  return { scenario: scenarioOf(ctx) };
}

// Suggested targets (src/suggest/build.mjs): the same records the scenario carries.
export function goalSuggestions(ctx) {
  const { clock, suggestions } = buildSuggestions(ctx.db, { clock: ctx.config && ctx.config.clock });
  return { clock, suggestions };
}

// Undo a target Fathom set: the goal's earlier values come back and the suggestion is declined,
// so no later pass adopts it again.
export function goalSuggestion(ctx) {
  const row = goalRow(ctx.db, ctx.params.id);
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'undo' || Object.keys(body).length !== 1) {
    throw new HttpError(400, "send {action: 'undo'}");
  }
  try { undoAdoption(ctx.db, row.id, { now: stamp(ctx) }); } catch (e) { if (e instanceof ToolError) throw toolHttp(e); throw e; }
  return { scenario: scenarioOf(ctx) };
}
