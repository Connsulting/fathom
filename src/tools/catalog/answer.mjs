import { recordFact } from '../../actions/index.mjs';
import { replanAction } from '../../actions/receipts.mjs';
import { expectedTransaction } from '../../actions/expected-transaction.mjs';
export const operations = [{
  tool: 'answer', name: 'fact', scope: 'write:facts',
  summary: 'Record a typed household fact using exact owner words or stored data; include evidence.',
  route: 'Record or correct a household fact', routes: [],
  params: { key: { type: 'string', minLength: 1 }, value: {}, evidence: { type: 'string', minLength: 1, maxLength: 4000 }, conversationKey: { type: 'string' } },
  required: ['key', 'value', 'evidence'],
  async handler(args, ctx) {
    const out = recordFact(args, ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx);
    return { ...out, planningPending: await replanAction(ctx, out.receipt) };
  },
}, {
  tool: 'answer', name: 'expected_transaction', scope: 'write:imports',
  summary: 'Record an expected payment with cited date and optional amount; never an actual posting.',
  route: 'Record an expected payment', routes: [],
  params: { subject: { type: 'string', minLength: 1, maxLength: 200 }, direction: { enum: ['inflow', 'outflow'] },
    dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, datePrecision: { enum: ['day', 'month', 'year'] },
    amount: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }, accountId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    evidence: { type: 'string', minLength: 1, maxLength: 4000 }, relativeDate: { type: 'string', maxLength: 30 }, conversationKey: { type: 'string' } },
  required: ['subject', 'direction', 'dueDate', 'datePrecision', 'amount', 'evidence'],
  handler: (args, ctx) => expectedTransaction(args, ctx.channel === 'mcp' ? { ...ctx, conversationKey: args.conversationKey } : ctx),
}];
export const rules = [
  'When a request needs a missing household fact, name it and offer answer.fact in chat using the owner\'s exact words. Read household.fact_shapes for accepted keys and shapes.',
];
