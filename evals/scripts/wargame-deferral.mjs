import { fakeAnswerScript } from '../../src/api/fake-answers.mjs';
export async function setup({ db }) {
  await db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE wargame = ?").run('deferral');
}
export function script() {
  return fakeAnswerScript({ questionId: 'wargame-deferral' }).map(round => ({ ...round, costUsd: 0 }));
}
