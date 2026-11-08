import { parseJson as parse } from '../store/db.mjs';
import { recordFactAnswers } from '../facts/answers.mjs';
import { createGoal, updateGoal } from '../goals/write.mjs';
import { writeRec } from '../store/recs.mjs';
import { requireActor, requireScope, saveReceipt } from './receipts.mjs';
import { requireEvidence, requireEntityEvidence } from './evidence.mjs';
import { answerShape } from '../jobs/triggers/common.mjs';
import { goalStatusOf } from '../shared/goals.mjs';

const select = (row, keys) => row ? Object.fromEntries(keys.map(k => [k, row[k]])) : null;
const FACT_FIELDS = ['key', 'value', 'src', 'as_of', 'confirmed', 'file_id', 'parser', 'locator'];
const GOAL_FIELDS = ['id', 'def', 'sort', 'origin', 'created_at', 'archived_at', 'done_at'];
// A goal as a receipt shows it: the def without its id and captured path, plus the derived status.
const goalValue = row => {
  if (!row) return null;
  const { id, pace, ...def } = parse(row.def, {});
  return { ...def, status: goalStatusOf(row) };
};

// Every amount and date in a goal body that needs the owner's words or a stored value, as
// [path, value, money]. owner, priority, kind and status need none.
function goalEvidence(fields) {
  const out = [];
  for (const k of ['target', 'targetLow', 'targetHigh', 'floor']) if (Object.hasOwn(fields, k)) out.push([[k], fields[k], true]);
  for (const k of ['targetDate', 'taxYear']) if (Object.hasOwn(fields, k)) out.push([[k], fields[k], false]);
  if (Array.isArray(fields.split)) fields.split.forEach((p, i) => out.push([['split', i, 'amount'], p?.amount, true]));
  const e = fields.entered;
  if (e && typeof e === 'object') {
    if (Object.hasOwn(e, 'asOf')) out.push([['entered', 'asOf'], e.asOf, false]);
    if (Object.hasOwn(e, 'total')) out.push([['entered', 'total'], e.total, true]);
    if (Array.isArray(e.people)) e.people.forEach((p, i) => out.push([['entered', 'people', i, 'amount'], p?.amount, true]));
  }
  return out.filter(([, v]) => v !== undefined);
}
const at = (obj, path) => path.reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), obj);

export async function recordFact(args, ctx) {
  requireScope(ctx, 'write:facts');
  const actorId = await requireActor(ctx);
  const shape = answerShape(args.key);
  const prior = await ctx.db.prepare('SELECT value FROM facts WHERE key = ?').get(args.key);
  if (args.key === 'business.entities') await requireEntityEvidence(ctx, args.value, { evidence: args.evidence, shape });
  else await requireEvidence(ctx, args.value, { evidence: args.evidence, shape, stored: prior ? [parse(prior.value, null)] : [] });
  let receipt = null;
  await recordFactAnswers(ctx.db, [{ key: args.key, value: args.value }], { now: new Date(ctx.now ?? Date.now()).toISOString(),
    channel: ctx.channel === 'mcp' ? 'mcp' : 'ask', actorId, sourceEvidence: ctx.sourceEvidence,
    async onWrite(before, after) {
      receipt = await saveReceipt(ctx, { scope: 'write:facts', kind: 'fact', id: args.key, label: shape.label ?? args.key,
        before: select(before, FACT_FIELDS), after: select(after, FACT_FIELDS),
        from: before ? parse(before.value, null) : null, to: parse(after.value, null) });
    } });
  ctx.onReceipt?.(receipt);
  return { key: args.key, value: parse((await ctx.db.prepare('SELECT value FROM facts WHERE key = ?').get(args.key)).value, null), receipt };
}

export async function changeRec(args, ctx, kind) {
  requireScope(ctx, kind === 'step' ? 'write:steps' : 'write:recs');
  const actor = await requireActor(ctx);
  let receipt = null;
  const fields = { step: ['tasks_done', 'def'], status: ['status', 'wake'], owner: ['owner', 'owner_override'] }[kind];
  const values = row => kind === 'step' ? !!parse(row.tasks_done, [])[args.index]
    : kind === 'owner' ? row.owner : { status: row.status, wake: row.wake };
  const row = await writeRec(ctx.db, args.id, kind, kind === 'owner' ? args.owner : args, {
    now: new Date(ctx.now ?? Date.now()).toISOString(), actor,
    async onWrite(before, after) {
      if (JSON.stringify(values(before)) === JSON.stringify(values(after)) && kind !== 'owner') return;
      receipt = await saveReceipt(ctx, { scope: kind === 'step' ? 'write:steps' : 'write:recs', kind, id: args.id,
        label: kind === 'step' ? `Recommendation step ${args.index + 1}` : `Recommendation ${kind}`,
        before: select(before, fields), after: select(after, fields), from: values(before), to: values(after) });
    },
  });
  ctx.onReceipt?.(receipt);
  return { row, receipt };
}

export async function changeGoal(args, ctx, editing = false) {
  requireScope(ctx, 'write:goals');
  await requireActor(ctx);
  const { id, ...fields } = args;
  const current = editing ? await ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) : null;
  const old = current ? parse(current.def, {}) : {};
  for (const [path, value] of goalEvidence(fields)) {
    const prior = at(old, path);
    const stored = prior !== undefined ? [prior] : [];
    await requireEvidence(ctx, value, { stored, argument: path.join('.'), household: true });
  }
  let receipt = null;
  // createGoal and updateGoal set Fathom's target before onWrite, so the receipt's after state has it.
  const opts = { now: new Date(ctx.now ?? Date.now()).toISOString(), clock: ctx.config?.clock, async onWrite(before, after) {
    receipt = await saveReceipt(ctx, { scope: 'write:goals', kind: 'goal', id: after.id, label: 'Goal',
      before: select(before, GOAL_FIELDS), after: select(after, GOAL_FIELDS), from: goalValue(before), to: goalValue(after) });
  } };
  const row = editing ? await updateGoal(ctx.db, id, fields, opts) : await createGoal(ctx.db, fields, opts);
  ctx.onReceipt?.(receipt);
  return { goal: { ...parse(row.def, {}), status: goalStatusOf(row) }, receipt };
}
