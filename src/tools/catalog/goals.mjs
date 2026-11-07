import { clockOf, goalsForModel, withEnvelopes } from './figures.mjs';
import { buildPace } from '../../pace/build.mjs';

export const operations = [
{
    tool: 'goals', name: 'list',
    summary: 'Open goals, targets and tracked values.', route: 'Open household goals', routes: [],
    params: {},
    required: [],
    scope: 'read',
    handler(args, ctx) {
      return goalsForModel(ctx.db);
    },
  },
{
    tool: 'goals', name: 'pace',
    summary: 'Deterministic goal pace, household health and monthly deltas.', route: 'Goal pace', routes: ['GET /api/pace'],
    params: {},
    required: [],
    scope: 'read', referenceable: true,
    handler(args, ctx) {
      return withEnvelopes(buildPace(ctx.db, { clock: clockOf(ctx) }));
    },
  },
];
