// Goals and the tradeoff curve: owner-editable household data. Every route sits behind the owner
// gate (the router gates all of /api on a real store) and answers with the fresh scenario.
//
// POST /api/goals              {title, note?, horizon?, target?, targetDate?, track?} -> {scenario, goal}
// POST /api/goals/:id          the same fields, any subset                          -> {scenario, goal}
// POST /api/goals/:id/archive  {archived?: boolean, default true}                   -> {scenario, goal}
// POST /api/goals/:id/delete   {}                                                   -> {scenario}
// POST /api/curve              {id, value} or {positions: {id: value}}              -> {scenario}
// GET  /api/goals/suggestions                                                     -> {clock, suggestions}
// POST /api/goals/:id/suggestion  {action: 'dismiss'|'restore'} or {withdrawalRate}  -> {scenario}
//
// Owner goal text is stored as typed (trimmed) and rendered escaped, never token-resolved. A seed
// goal (the demo's) can be archived or deleted, not edited: its text carries scenario tokens.

import { randomBytes } from 'node:crypto';
import { getSetting, setSetting, tx, parseJson as parse } from '../store/db.mjs';
import { validateGoal } from '../shared/goals.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { clockNow, loadContent, loadCurve, loadFigures } from '../scenario/build.mjs';
import { captureGoalPath, goalPathChanged } from '../pace/build.mjs';
import { buildSuggestions, SUGGEST_SETTING } from '../suggest/build.mjs';
import { TARGET_PARAMETERS } from '../calc/targets.mjs';

const MAX_GOALS = 200;

const stamp = ctx => clockNow(ctx.db, ctx.config && ctx.config.clock);

function goalRow(db, id) {
  const row = typeof id === 'string' ? db.prepare('SELECT * FROM goals WHERE id = ?').get(id) : null;
  if (!row) throw new HttpError(404, 'no such goal');
  return row;
}

// The validation context: the store's accounts and stored figures.
function storeRefs(db) {
  return { accounts: db.prepare('SELECT id, kind FROM accounts').all(), figures: loadFigures(db) };
}

function valid(db, body, partial) {
  const res = validateGoal(body, { ...storeRefs(db), partial });
  if (!res.ok) throw new HttpError(400, res.error);
  return res.value;
}

const goalOut = (scenario, id) => scenario.goals.find(g => g.id === id) || null;

// Creates an owner goal; used by the route and by a saved Ask proposal (the same body).
export function goalCreate(ctx) {
  const { db } = ctx;
  const value = valid(db, ctx.body, false);
  const n = db.prepare('SELECT count(*) AS n FROM goals').get().n;
  if (n >= MAX_GOALS) throw new HttpError(409, `at most ${MAX_GOALS} goals`);
  let id;
  do id = 'g' + randomBytes(6).toString('hex'); while (db.prepare('SELECT 1 FROM goals WHERE id = ?').get(id));
  const now = stamp(ctx);
  const def = { id, title: value.title, note: value.note || '', horizon: value.horizon, target: value.target,
    targetDate: value.targetDate, track: value.track };
  def.pace = captureGoalPath(db, def, now.slice(0, 10));
  tx(db, () => {
    const sort = db.prepare('SELECT coalesce(max(sort), -1) + 1 AS s FROM goals').get().s;
    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")
      .run(id, JSON.stringify(def), sort, now, now);
  });
  const scenario = scenarioOf(ctx);
  return { scenario, goal: goalOut(scenario, id) };
}

export function goalUpdate(ctx) {
  const { db } = ctx;
  const row = goalRow(db, ctx.params.id);
  if (row.origin !== 'owner') throw new HttpError(409, 'this goal came with the demo and cannot be edited; archive it or add your own');
  const value = valid(db, ctx.body, true);
  const previous = parse(row.def, {});
  const def = { ...previous, ...value, id: row.id };
  if (!previous.pace || goalPathChanged(previous, def)) def.pace = captureGoalPath(db, def, stamp(ctx).slice(0, 10));
  db.prepare('UPDATE goals SET def = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(def), stamp(ctx), row.id);
  const scenario = scenarioOf(ctx);
  return { scenario, goal: goalOut(scenario, row.id) };
}

export function goalArchive(ctx) {
  const { db } = ctx;
  const row = goalRow(db, ctx.params.id);
  const { archived = true } = ctx.body;
  if (typeof archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
  const now = stamp(ctx);
  db.prepare('UPDATE goals SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? row.archived_at || now : null, now, row.id);
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

// Dismiss or restore a goal's suggestion, or set its withdrawal rate. A dismissal stores the
// record's fingerprint, so a change to the goal text or the inputs brings the suggestion back.
export function goalSuggestion(ctx) {
  const { db } = ctx;
  const row = goalRow(db, ctx.params.id);
  if (row.origin !== 'owner') throw new HttpError(409, 'this goal came with the demo and has no suggested target');
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'send an action or a withdrawal rate');
  const hasAction = Object.hasOwn(body, 'action');
  const hasRate = Object.hasOwn(body, 'withdrawalRate');
  if (hasAction === hasRate) throw new HttpError(400, 'send either an action or a withdrawal rate');
  if (hasAction && !['dismiss', 'restore'].includes(body.action)) throw new HttpError(400, 'action must be dismiss or restore');
  const { withdrawalRateMin: min, withdrawalRateMax: max } = TARGET_PARAMETERS;
  if (hasRate && (typeof body.withdrawalRate !== 'number' || !Number.isFinite(body.withdrawalRate) || body.withdrawalRate < min || body.withdrawalRate > max)) {
    throw new HttpError(400, `withdrawalRate must be a number from ${min} to ${max}`);
  }
  const record = buildSuggestions(db, { clock: ctx.config && ctx.config.clock }).suggestions.find(s => s.goalId === row.id);
  if (!record) throw new HttpError(409, 'this goal has a target or is not active, so it has no suggestion');
  if (hasRate && record.kind !== 'independence') throw new HttpError(400, 'only a work-optional goal has a withdrawal rate');
  const stored = getSetting(db, SUGGEST_SETTING, null);
  const ids = new Set(db.prepare('SELECT id FROM goals').all().map(r => r.id));
  const next = Object.fromEntries(Object.entries(stored && typeof stored === 'object' ? stored : {}).filter(([id]) => ids.has(id)));
  const entry = { dismissed: null, ...(next[row.id] || {}) };
  if (body.action === 'dismiss') entry.dismissed = record.fingerprint;
  else if (body.action === 'restore') entry.dismissed = null;
  else entry.withdrawalRate = Math.round(body.withdrawalRate * 10000) / 10000;
  next[row.id] = entry;
  setSetting(db, SUGGEST_SETTING, next);
  return { scenario: scenarioOf(ctx) };
}
