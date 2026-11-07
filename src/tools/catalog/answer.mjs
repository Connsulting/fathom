import { recordFact } from '../../actions/index.mjs';
export const operations = [{
  tool: 'answer', name: 'fact', scope: 'write:facts',
  summary: 'Record a typed household fact using exact owner words or stored data; include evidence.',
  route: 'Record or correct a household fact', routes: [],
  params: { key: { type: 'string', minLength: 1 }, value: {}, evidence: { type: 'string', minLength: 1 }, conversationKey: { type: 'string' } },
  required: ['key', 'value', 'evidence'],
  handler: (args, ctx) => recordFact(args, ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx),
}];
export const rules = [
  'When a request needs a missing household fact, name it and offer answer.fact in chat using the owner\'s exact words. Read household.fact_shapes for accepted keys and shapes.',
];
