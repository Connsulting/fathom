import { loadContent } from '../../src/scenario/build.mjs';
import { revisit } from '../../src/decisions/write.mjs';

export function script({ db, clock }) {
  const decision = db.prepare("SELECT * FROM decisions WHERE wargame = 'salary' AND status IN ('open', 'decided') ORDER BY sort LIMIT 1").get();
  if (!decision) throw new Error('The salary fixture needs a decision');
  if (decision.status === 'decided') revisit(db, decision.id, { now: clock + 'T00:00:00.000Z' });
  const points = loadContent(db).wargame.salary.points;
  const point = points[Math.floor((points.length - 1) / 2)].id;
  return [
    { toolCalls: [
      { name: 'recommendations', args: { operation: 'list' } },
      { name: 'act_on_recommendation', args: { operation: 'decide', decisionId: decision.id, point, propose: true } },
    ], costUsd: 0 },
    { text: 'I can record the middle salary option. Confirm this change.', costUsd: 0 },
  ];
}
