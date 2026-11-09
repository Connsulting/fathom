import { clockOf, goalsForModel, withEnvelopes } from './figures.mjs';
import { buildPace } from '../../pace/build.mjs';

export const operations = [
{
    tool: 'goals', name: 'list',
    summary: 'Non-archived goals, including done, with kind, owner, priority and typed amounts; pace gives progress.', route: 'Open household goals', routes: [],
    params: {},
    required: [],
    scope: 'read',
    async handler(args, ctx) {
      return await goalsForModel(ctx.db);
    },
  },
{
    tool: 'goals', name: 'pace',
    summary: 'Deterministic goal pace, household health and monthly deltas.', route: 'Goal pace', routes: ['GET /api/pace'],
    params: {},
    required: [],
    scope: 'read', referenceable: true,
    async handler(args, ctx) {
      return withEnvelopes(await buildPace(ctx.db, { clock: await clockOf(ctx) }));
    },
  },
];
