import { createGoal } from '../../src/goals/write.mjs';
import { goalsForModel } from '../../src/tools/catalog/figures.mjs';

export function script({ db, clock }) {
  let goal = goalsForModel(db).find(g => /kitchen remodel/i.test(g.title));
  if (!goal) goal = createGoal(db, { title: 'Kitchen remodel' }, { now: clock + 'T00:00:00.000Z' });
  return [
    { toolCalls: [
      { name: 'goals', args: { operation: 'list' } },
      { name: 'update_goal', args: { operation: 'archive', id: goal.id, propose: true } },
    ], costUsd: 0 },
    { text: 'I can archive the kitchen remodel goal. Confirm this change.', costUsd: 0 },
  ];
}
