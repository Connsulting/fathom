import { DEFAULT_UNDO } from '../facts/derive.mjs';
import { answerFacts, FactAnswerError } from '../facts/answers.mjs';
import { parseJson, getSetting } from '../store/db.mjs';
import { saveReceipt } from '../actions/receipts.mjs';
import { clockNow } from '../scenario/build.mjs';
import { scenarioOf } from './scenario.mjs';
import { HttpError } from './http.mjs';
import { INFERENCE_KEY } from '../shared/va529-plan.mjs';

const FACT_FIELDS = ['key', 'value', 'src', 'as_of', 'confirmed', 'file_id', 'parser', 'locator'];
const factState = row => (row ? Object.fromEntries(FACT_FIELDS.map(k => [k, row[k]])) : null);

// The undoable receipt for one fact a recommendation answer wrote (the Ask, MCP and UI paths share
// it). receiptCtx carries db, now and actorId. -> receipt or null when nothing changed.
export function saveAnswerReceipt(receiptCtx, before, after) {
  return saveReceipt(receiptCtx, { scope: 'write:facts', kind: 'fact', id: after.key, label: 'Recommendation answer',
    before: factState(before), after: factState(after), from: parseJson(before?.value, null), to: parseJson(after.value, null) });
}

export async function saveRecAnswers(ctx, { recId, answers }, options = {}) {
  const row = ctx.db.prepare('SELECT * FROM recs WHERE id = ?').get(recId);
  if (!row || row.status === 'hidden') throw new HttpError(404, 'no such recommendation');
  const def = parseJson(row.def, {});
  const question = def.question;
  const defaultAnswer = answers?.[0];
  const undoDefault = Array.isArray(answers) && answers.length === 1
    && Object.hasOwn(DEFAULT_UNDO, defaultAnswer?.key || '')
    && (def.assumptions || []).some(a => a.undoKey === defaultAnswer.key
      && (a.path.length ? defaultAnswer.value?.[a.path[0]]?.undone === true && Object.keys(defaultAnswer.value).length === 1 : defaultAnswer.value === true));
  if (!question?.keys?.length && !undoDefault) throw new HttpError(409, 'this recommendation has no open questions');
  // Undo of an inferred Virginia plan answer is the one answer that does not fill the form.
  const undo = Array.isArray(answers) && answers.length === 1 && answers[0]?.key === INFERENCE_KEY && question?.keys.includes('accounts.va529');
  if (!undoDefault && !undo && (!Array.isArray(answers) || answers.length !== question.keys.length
    || answers.some(a => !question.keys.includes(a?.key)))) throw new HttpError(400, 'answer each question on this recommendation');
  if (!options.replan && !ctx.scheduler) throw new HttpError(503, 'planning unavailable');
  const now = options.now ?? clockNow(ctx.db, ctx.config?.clock);
  // The UI path writes the same fact receipts Ask and MCP write, so an answer can be undone. The
  // actor is resolved as Undo resolves it; with no actor there is nothing to undo as.
  const actorId = options.onWrite ? null : ctx.identity?.id || (getSetting(ctx.db, 'mode', null) === 'demo' ? 'demo' : null);
  const onWrite = options.onWrite ?? (actorId ? (before, after) => saveAnswerReceipt({ db: ctx.db, now, actorId }, before, after) : undefined);
  try {
    await answerFacts(ctx.db, answers, {
      ...options, now, recId: row.id, onWrite,
      replan: options.replan ?? (async () => {
        const run = await ctx.scheduler.runNow('plan');
        if (run?.status !== 'ok') throw new Error('planning unavailable');
      }),
    });
  } catch (err) {
    if (err instanceof FactAnswerError) throw new HttpError(400, err.message);
    throw err;
  }
  return { scenario: scenarioOf(ctx) };
}

export async function recAnswers(ctx) {
  return saveRecAnswers(ctx, { recId: ctx.params.id, answers: ctx.body.answers });
}
