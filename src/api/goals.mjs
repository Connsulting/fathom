import { currentHandle } from '../storage/index.mjs';
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

const stamp = async ctx => await clockNow(currentHandle(ctx.db), ctx.config && ctx.config.clock);
const toolHttp = e => new HttpError(e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, e.message);

async function write(fn) {
  try { return await fn(); }
  catch (err) { if (err instanceof ToolError) throw new HttpError(err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400, err.message); throw err; }
}

const goalOut = (scenario, id) => scenario.goals.find(g => g.id === id) || null;

export async function goalCreate(ctx) {
  try {
    const row = await createGoal(ctx.db, ctx.body, { now: await stamp(ctx), clock: ctx.config && ctx.config.clock });
    const scenario = await scenarioOf(ctx);
    return { scenario, goal: goalOut(scenario, row.id) };
  } catch (e) { if (e instanceof ToolError) throw toolHttp(e); throw e; }
}

export async function goalUpdate(ctx) {
  try {
    const row = await updateGoal(ctx.db, ctx.params.id, ctx.body, { now: await stamp(ctx), clock: ctx.config && ctx.config.clock });
    const scenario = await scenarioOf(ctx);
    return { scenario, goal: goalOut(scenario, row.id) };
  } catch (e) { if (e instanceof ToolError) throw toolHttp(e); throw e; }
}

export async function goalArchive(ctx) {
  await write(async () => await archiveGoal(ctx.db, ctx.params.id, { archived: ctx.body.archived, now: await stamp(ctx), clock: ctx.config?.clock }));
  const scenario = await scenarioOf(ctx);
  return { scenario, goal: goalOut(scenario, ctx.params.id) };
}

export async function goalDelete(ctx) {
  await write(async () => await deleteGoal(ctx.db, ctx.params.id));
  return { scenario: await scenarioOf(ctx) };
}

export const getPace = async ctx => (await scenarioOf(ctx)).pace;

// A position is a number from 0 to 1 for a known axis (the curve's axes, which the onboarding
// priorities share by id).
export async function curveSet(ctx) {
  if (ctx.body.positions === undefined && typeof ctx.body.id !== 'string') throw new HttpError(400, 'unknown curve axis');
  await write(async () => await setCurvePositions(ctx.db, ctx.body.positions !== undefined ? ctx.body.positions : { [ctx.body.id]: ctx.body.value }, { now: await stamp(ctx), actorId: ctx.identity?.id || 'ui' }));
  return { scenario: await scenarioOf(ctx) };
}

// Suggested targets (src/suggest/build.mjs): the same records the scenario carries.
export async function goalSuggestions(ctx) {
  const { clock, suggestions } = await buildSuggestions(ctx.db, { clock: ctx.config?.clock });
  return { clock, suggestions };
}

export async function goalSuggestion(ctx) {
  await write(async () => await setGoalSuggestion(ctx.db, ctx.params.id, ctx.body, { now: await stamp(ctx) }));
  return { scenario: await scenarioOf(ctx) };
}
