import { DEFAULT_UNDO } from '../facts/derive.mjs';
import { answerFacts, FactAnswerError } from '../facts/answers.mjs';
import { parseJson } from '../store/db.mjs';
import { clockNow } from '../scenario/build.mjs';
import { scenarioOf } from './scenario.mjs';
import { HttpError } from './http.mjs';
import { INFERENCE_KEY } from '../shared/va529-plan.mjs';

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
  try {
    await answerFacts(ctx.db, answers, {
      ...options, now: options.now ?? clockNow(ctx.db, ctx.config?.clock), recId: row.id,
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
