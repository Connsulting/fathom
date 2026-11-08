import { fakeAnswerScript } from '../../src/api/fake-answers.mjs';
export function setup({ db }) {
  db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE wargame = ?").run('deferral');
}
export function script() {
  return fakeAnswerScript({ questionId: 'wargame-deferral' }).map(round => ({ ...round, costUsd: 0 }));
}
