import { callTool } from '../../src/tools/index.mjs';
export async function setup({ db }) {
  await db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE wargame = 'deferral'").run();
}
export async function script({ turn, db, clock }) {
  const args = { operation: 'wargame', name: 'deferral' };
  const read = { name: 'recommendations', args };
  if (!turn.question.startsWith('Pick')) return [{ toolCalls: [read], costUsd: 0 }, { text: 'The stored invoice-deferral options are available.', costUsd: 0 }];
  const result = await callTool('recommendations', args, { db, clock });
  return [{ toolCalls: [read], costUsd: 0 },
    { toolCalls: [{ name: 'act_on_recommendation', args: { operation: 'pick_point', name: 'deferral', point: result.deferral.options[1].id } }], costUsd: 0 },
    { text: 'Your choice is picked. You can undo it below.', costUsd: 0 }];
}
