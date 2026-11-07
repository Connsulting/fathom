import { parseJson as parse } from '../store/db.mjs';
import { answerFacts } from '../facts/answers.mjs';
import { createGoal, updateGoal } from '../goals/write.mjs';
import { writeRec } from '../store/recs.mjs';
import { requireActor, saveReceipt, replanAction } from './receipts.mjs';
import { requireEvidence } from './evidence.mjs';
import { answerShape } from '../jobs/triggers/common.mjs';

const select = (row, keys) => row ? Object.fromEntries(keys.map(k => [k, row[k]])) : null;
const FACT_FIELDS = ['key', 'value', 'src', 'as_of', 'confirmed', 'file_id', 'parser', 'locator'];
const GOAL_FIELDS = ['id', 'def', 'sort', 'origin', 'created_at', 'archived_at'];
const goalValue = row => {
  if (!row) return null;
  const { title, note, horizon, target, targetDate, track } = parse(row.def, {});
  return { title, note, horizon, target, targetDate, track };
};

export async function recordFact(args, ctx) {
  const actorId = requireActor(ctx);
  const shape = answerShape(args.key);
  const prior = ctx.db.prepare('SELECT value FROM facts WHERE key = ?').get(args.key);
  requireEvidence(ctx, args.value, { evidence: args.evidence, shape, stored: prior ? [parse(prior.value, null)] : [] });
  let receipt = null;
  await answerFacts(ctx.db, [{ key: args.key, value: args.value }], { now: new Date(ctx.now ?? Date.now()).toISOString(),
    channel: ctx.channel === 'mcp' ? 'mcp' : 'ask', actorId,
    replan: async () => {}, onWrite(before, after) {
      receipt = saveReceipt(ctx, { scope: 'write:facts', kind: 'fact', id: args.key, label: shape.label,
        before: select(before, FACT_FIELDS), after: select(after, FACT_FIELDS),
        from: before ? parse(before.value, null) : null, to: parse(after.value, null) });
    } });
  ctx.onReceipt?.(receipt);
  const planningPending = await replanAction(ctx, receipt);
  return { key: args.key, value: parse(ctx.db.prepare('SELECT value FROM facts WHERE key = ?').get(args.key).value, null), receipt, planningPending };
}

export function changeRec(args, ctx, kind) {
  const actor = requireActor(ctx);
  let receipt = null;
  const fields = { step: ['tasks_done'], status: ['status', 'wake'], owner: ['owner', 'owner_override'] }[kind];
  const values = row => kind === 'step' ? !!parse(row.tasks_done, [])[args.index]
    : kind === 'owner' ? row.owner : { status: row.status, wake: row.wake };
  const row = writeRec(ctx.db, args.id, kind, kind === 'owner' ? args.owner : args, {
    now: new Date(ctx.now ?? Date.now()).toISOString(), actor,
    onWrite(before, after) {
      if (JSON.stringify(values(before)) === JSON.stringify(values(after)) && kind !== 'owner') return;
      receipt = saveReceipt(ctx, { scope: kind === 'step' ? 'write:steps' : 'write:recs', kind, id: args.id,
        label: kind === 'step' ? `Recommendation step ${args.index + 1}` : `Recommendation ${kind}`,
        before: select(before, fields), after: select(after, fields), from: values(before), to: values(after) });
    },
  });
  ctx.onReceipt?.(receipt);
  return { row, receipt };
}

export function changeGoal(args, ctx, editing = false) {
  requireActor(ctx);
  const { id, ...fields } = args;
  const current = editing ? ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) : null;
  const old = current ? parse(current.def, {}) : {};
  for (const k of ['target', 'targetDate']) if (Object.hasOwn(fields, k)) {
    const stored = Object.hasOwn(old, k) ? [old[k]] : [];
    requireEvidence(ctx, fields[k], { stored, argument: k, household: true });
  }
  let receipt = null;
  const opts = { now: new Date(ctx.now ?? Date.now()).toISOString(), onWrite(before, after) {
    receipt = saveReceipt(ctx, { scope: 'write:goals', kind: 'goal', id: after.id, label: 'Goal',
      before: select(before, GOAL_FIELDS), after: select(after, GOAL_FIELDS), from: goalValue(before), to: goalValue(after) });
  } };
  const row = editing ? updateGoal(ctx.db, id, fields, opts) : createGoal(ctx.db, fields, opts);
  ctx.onReceipt?.(receipt);
  return { goal: parse(row.def, {}), receipt };
}
