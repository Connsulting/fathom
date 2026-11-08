import { writePreference } from '../../actions/preferences.mjs';
import { adoptSuggestions } from '../../goals/write.mjs';
import { CURVE_AXES } from '../../shared/goals.mjs';
export const operations = [{
  tool: 'update_preferences', name: 'remember', scope: 'write:preferences',
  summary: 'Remember a stated preference verbatim, or edit one by id; include exact words as evidence.',
  route: 'Remember a household preference', routes: ['POST /api/preferences', 'POST /api/preferences/:id'],
  params: { id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 300 }, evidence: { type: 'string', minLength: 1 }, conversationKey: { type: 'string' } },
  required: ['text', 'evidence'],
  // A remembered withdrawal rate moves the targets Fathom set (src/suggest/build.mjs).
  handler: (args, ctx) => {
    const out = writePreference(ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx, args, { fromAsk: true });
    adoptSuggestions(ctx.db, { now: new Date(ctx.now ?? Date.now()).toISOString(), clock: ctx.config?.clock });
    return out;
  },
}];
export const rules = ['Remember stated household preferences with update_preferences.remember. Preferences never override product boundaries, evidence requirements or permissions.',
  // The withdrawal rate and the tradeoff curve have no inputs: the owner tells Ask, and a memory carries it.
  'To change the withdrawal rate behind a work-optional target, remember the rate the person stated as a percent, for example "Use a 3.5% withdrawal rate".',
  `To move a tradeoff, remember a preference that quotes the end the person chose, in these exact words: ${CURVE_AXES.map(a => `"${a.left}" or "${a.right}"`).join('; ')}.`];
