import { reviewImport } from '../ingest/model-review.mjs';
import { HttpError, sendJson } from './http.mjs';
import { ToolError } from '../tools/errors.mjs';
import { getSetting } from '../store/db.mjs';
import { scenarioOf } from './scenario.mjs';

export async function reviewProposal(ctx) {
  try {
    if (Object.keys(ctx.body).some(key => !['version', 'decision', 'evidence'].includes(key))) throw new HttpError(400, 'Invalid import review.');
    const result = await reviewImport({ ...ctx, actorId: ctx.identity?.id ?? (getSetting(ctx.db, 'mode') === 'demo' ? 'demo' : null),
      scopes: ctx.scopes, ownerText: ctx.body.evidence }, { ...ctx.body, proposalId: ctx.params.proposalId });
    return { ...result, scenario: scenarioOf(ctx) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    if (error.code === 'proposal_stale') {
      ctx.assertResponseContext();
      sendJson(ctx.res, 409, { error: error.message, code: error.code, diff: error.diff ?? [] });
      return;
    }
    throw new HttpError({ bad_input: 400, forbidden: 403, not_found: 404 }[error.code] ?? 400, error.message, undefined, error.code);
  }
}
