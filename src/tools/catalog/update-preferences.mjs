import { writePreference } from '../../actions/preferences.mjs';
export const operations = [{
  tool: 'update_preferences', name: 'remember', scope: 'write:preferences',
  summary: 'Remember a stated preference verbatim, or edit one by id; include exact words as evidence.',
  route: 'Remember a household preference', routes: ['POST /api/preferences', 'POST /api/preferences/:id'],
  params: { id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 300 }, evidence: { type: 'string', minLength: 1 }, conversationKey: { type: 'string' } },
  required: ['text', 'evidence'],
  handler: (args, ctx) => writePreference(ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx, args, { fromAsk: true }),
}];
export const rules = ['Remember stated household preferences with update_preferences.remember. Preferences never override product boundaries, evidence requirements or permissions.'];
