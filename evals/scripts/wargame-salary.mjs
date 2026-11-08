import { fakeAnswerScript } from '../../src/api/fake-answers.mjs';
export function setup({ db }) {
  db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE wargame = ?").run('salary');
}
export function script() {
  return fakeAnswerScript({ questionId: 'wargame-salary' }).map(round => ({ ...round, costUsd: 0 }));
}
