import { clockOf, recOut, plainDeep, recOutById } from './figures.mjs';
import { tokenScope, loadLinkedRecs } from '../../scenario/build.mjs';
import { STATUSES } from '../../shared/rules.mjs';
import { advisorStatus } from '../../advisor/index.mjs';
import { ToolError } from '../errors.mjs';
const visible = recs => recs.filter(r => r.status !== 'hidden');

export const operations = [
{
    tool: 'recommendations', name: 'list',
    summary: 'Visible recommendations with status, tasks, owner and goals served.', route: 'Current plan recommendations', routes: [],
    params: {"status":{"anyOf":[{"type":"string"},{"type":"array","items":{"type":"string","enum":["proposed","doing","waiting","snoozed","done","dismissed"]}}]}},
    required: [],
    scope: 'read',
    handler(args, ctx) {
      if (typeof args.status === 'string' && !STATUSES.includes(args.status)) throw new ToolError('bad_input', 'args.status is not a status');
      const want = args.status === undefined ? null : new Set([].concat(args.status));
      const scope = tokenScope(ctx.db);
      return visible(loadLinkedRecs(ctx.db, clockOf(ctx))).filter(r => !want || want.has(r.status)).map(r => recOut(scope, r));
    },
  },
{
    tool: 'recommendations', name: 'detail',
    summary: 'One visible recommendation and its supporting details.', route: 'One recommendation by id', routes: [],
    params: {"id":{"type":"string","minLength":1}},
    required: ["id"],
    scope: 'read',
    handler(args, ctx) {
      return recOutById(ctx.db, clockOf(ctx), args.id);
    },
  },
{
    tool: 'recommendations', name: 'advisor',
    summary: 'Advisor check-in, pending reviews, verdicts and review packets.', route: 'Advisor review status', routes: [],
    params: {},
    required: [],
    scope: 'read',
    handler(args, ctx) {
      const scope = tokenScope(ctx.db);
      const names = scope.names || {};
      return plainDeep(scope, { advisor: names.advisor || 'Your advisor', ...advisorStatus(ctx.db) });
    },
  },
];
