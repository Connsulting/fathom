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

import { createGoal, updateGoal, archiveGoal, deleteGoal } from '../goals/write.mjs';
import { ToolError } from '../tools/errors.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { clockNow } from '../scenario/build.mjs';
import { buildSuggestions } from '../suggest/build.mjs';
import { setGoalSuggestion } from '../suggest/write.mjs';
import { setCurvePositions } from '../goals/curve.mjs';

const stamp = ctx => clockNow(ctx.db, ctx.config && ctx.config.clock);
const toolHttp = e => new HttpError(e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, e.message);

function write(fn) {
  try { return fn(); }
  catch (err) { if (err instanceof ToolError) throw new HttpError(err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400, err.message); throw err; }
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
  write(() => archiveGoal(ctx.db, ctx.params.id, { archived: ctx.body.archived, now: stamp(ctx), clock: ctx.config?.clock }));
  const scenario = scenarioOf(ctx);
  return { scenario, goal: goalOut(scenario, ctx.params.id) };
}

export function goalDelete(ctx) {
  write(() => deleteGoal(ctx.db, ctx.params.id));
  return { scenario: scenarioOf(ctx) };
}

export const getPace = ctx => scenarioOf(ctx).pace;

// A position is a number from 0 to 1 for a known axis (the curve's axes, which the onboarding
// priorities share by id).
export function curveSet(ctx) {
  if (ctx.body.positions === undefined && typeof ctx.body.id !== 'string') throw new HttpError(400, 'unknown curve axis');
  write(() => setCurvePositions(ctx.db, ctx.body.positions !== undefined ? ctx.body.positions : { [ctx.body.id]: ctx.body.value }, { now: stamp(ctx), actorId: ctx.identity?.id || 'ui' }));
  return { scenario: scenarioOf(ctx) };
}

// Suggested targets (src/suggest/build.mjs): the same records the scenario carries.
export function goalSuggestions(ctx) {
  const { clock, suggestions } = buildSuggestions(ctx.db, { clock: ctx.config?.clock });
  return { clock, suggestions };
}

export function goalSuggestion(ctx) {
  write(() => setGoalSuggestion(ctx.db, ctx.params.id, ctx.body, { now: stamp(ctx) }));
  return { scenario: scenarioOf(ctx) };
}
