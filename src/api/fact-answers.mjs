import { answerFacts, FactAnswerError } from '../facts/answers.mjs';
import { parseJson } from '../store/db.mjs';
import { clockNow } from '../scenario/build.mjs';
import { scenarioOf } from './handlers.mjs';
import { HttpError } from './http.mjs';

export async function recAnswers(ctx) {
  const row = ctx.db.prepare('SELECT * FROM recs WHERE id = ?').get(ctx.params.id);
  if (!row || row.status === 'hidden') throw new HttpError(404, 'no such recommendation');
  const question = parseJson(row.def, {}).question;
  if (!question?.keys?.length) throw new HttpError(409, 'this recommendation has no open questions');
  const answers = ctx.body.answers;
  if (!Array.isArray(answers) || answers.length !== question.keys.length
    || answers.some(a => !question.keys.includes(a?.key))) throw new HttpError(400, 'answer each question on this recommendation');
  if (!ctx.scheduler) throw new HttpError(503, 'planning unavailable');
  try {
    await answerFacts(ctx.db, answers, {
      now: clockNow(ctx.db, ctx.config?.clock), recId: row.id,
      replan: async () => {
        const run = await ctx.scheduler.runNow('plan');
        if (run?.status !== 'ok') throw new Error('planning unavailable');
      },
    });
  } catch (err) {
    if (err instanceof FactAnswerError) throw new HttpError(400, err.message);
    throw err;
  }
  return { scenario: scenarioOf(ctx) };
}
