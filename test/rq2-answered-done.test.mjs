// RQ2: an answered question rec is done. A rec whose primary question has been answered moves to
// Done with "Answered" and the answer, never to waiting on a hold it does not read, and Undo through
// the answer's own receipts reopens it with its question. The household-wide hold here is the one the
// real planner produces for married filing separately (src/jobs/planner/figures.mjs: mfs_unsupported
// is the only income code kept in info.blocked); the unrelated payroll gap is a spouse paystub from
// an outside employer with no year-to-date pay (paystub_ytd_missing). Every household, employer and
// amount here is synthetic.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, recRow, recEvents, factRow, figureRow, addFact, paystubDoc } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { saveRecAnswers } from '../src/api/fact-answers.mjs';
import { actionUndo } from '../src/api/handlers.mjs';
import { callTool } from '../src/tools/index.mjs';
import { taxGap } from '../src/shared/tax-gaps.mjs';
import * as recAnswers from '../web/horizon/screens/rec-answers.js';
import * as recBlocker from '../web/horizon/screens/rec-blocker.js';

const NOW = '2026-11-05';
const STAMP = '2026-11-05T12:00:00.000Z';
const OWNER = 'owner-synthetic';
const S = scratch('fathom-rq2-answered-');
after(async () => await S.cleanup());

const CEDAR = paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 });
const kit = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), snoozeLabel: () => 'Nov 19', recById: () => null, draw() {}, api: {} };
const replanOf = db => async () => planRun(db, { now: NOW });
const scenarioRec = async (db, id) => (await buildScenario(db, { clock: NOW })).recs.find(r => r.id === id);
const answerEvents = async db => (await recEvents(db, 'va529')).filter(e => e.action === 'answer');
const lastStatusEvent = async db => (await recEvents(db, 'va529')).filter(e => e.from_status !== e.to_status).at(-1);
const receiptRows = async db => await db.prepare("SELECT * FROM action_receipts WHERE entity_id = 'household.birthYears' ORDER BY rowid").all();

// A Virginia household with a Virginia 529 plan and no birth years, filing separately (the real
// household-wide hold), with an unrelated payroll gap on file.
async function heldQuestion(facts = {}) {
  const db = await S.store({ variant: { facts: { 'household.birthYears': undefined, 'household.filingStatus': 'mfs', ...facts }, payroll: [CEDAR] } });
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'proposed');
  assert.equal(row.def.question?.primary, true, 'va529 is a primary question rec');
  assert.deepEqual(row.def.question.keys, ['household.birthYears']);
  assert.equal(row.def.title, 'What year were you born?');
  assert.equal(await figureRow(db, 'tax.fed.proj'), null, 'the household-wide hold withholds household tax');
  assert.match(JSON.stringify((await recRow(db, 'missing-data')).def), /income\.payrollYtd/, 'the unrelated payroll gap is listed');
  return db;
}

function assertAnsweredHtml(rec, year) {
  recAnswers.reset();
  recAnswers.bind(kit);
  for (const surface of ['plan', 'dialog']) {
    const html = recAnswers.html(rec, surface);
    const at = html.indexOf('data-rec-answered="va529"');
    assert.ok(at >= 0, `${surface}: the answered state renders`);
    const answered = html.slice(at);
    assert.match(answered, /Answered/);
    assert.match(answered, /What year were you born\?/);
    assert.match(answered, new RegExp(`\\b${year}\\b`));
    assert.match(answered, /Edit answers/);
    assert.match(answered, /<button[^>]*>Undo<\/button>/, `${surface}: Undo through the answer receipt`);
    assert.doesNotMatch(html, /Waiting/);
    assert.doesNotMatch(html, /<input|<select|type="submit"/);
  }
}

test('AC1: an answered birth-year question is Done with its answer beside a household hold and an unrelated payroll gap; Undo reopens it', async () => {
  const db = await heldQuestion();
  const replan = replanOf(db);
  const ctx = { db, config: { clock: NOW }, identity: { id: OWNER } };
  await saveRecAnswers(ctx, { recId: 'va529', answers: [{ key: 'household.birthYears', value: { owner: 1981 } }] }, { now: STAMP, replan });
  assert.deepEqual((await factRow(db, 'household.birthYears')).value, { owner: 1981 });

  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'done', 'an answered question rec is done, not waiting');
  assert.equal(row.waiting_on, null);
  assert.equal(row.wake, null);
  const answer = (await answerEvents(db)).at(-1);
  assert.equal(answer.to_status, 'done');
  const ids = JSON.parse(answer.arg);
  assert.equal(ids.length, 1, 'one fact written, one receipt');
  const receipt = await db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(ids[0]);
  assert.equal(receipt.scope, 'write:facts');
  assert.equal(receipt.kind, 'fact');
  assert.equal(receipt.entity_id, 'household.birthYears');
  assert.equal(receipt.actor_id, OWNER);
  assert.equal(receipt.undone_at, null);
  assert.ok(!(await recEvents(db, 'va529')).some(e => e.id > answer.id && e.to_status === 'waiting'), 'the replan never parks it');

  const rec = await scenarioRec(db, 'va529');
  assert.equal(rec.status, 'done');
  assert.equal(rec.blocker, undefined);
  assert.ok(!rec.gaps?.length, 'no other item gap rides on the answered question');
  assert.equal(rec.question?.answered, true);
  assert.deepEqual(rec.answerReceipts, ids);
  recBlocker.bind(kit);
  assert.equal(recBlocker.html(rec, 'plan'), '');
  assert.equal(recBlocker.html(rec, 'dialog'), '');
  assertAnsweredHtml(rec, 1981);
  assert.match(JSON.stringify((await recRow(db, 'missing-data')).def), /income\.payrollYtd/, 'the payroll gap stays listed where it applies');

  // Undo, as the button does: api.actionUndo over the answer receipts in reverse order.
  for (const id of [...rec.answerReceipts].reverse()) {
    await actionUndo({ db, config: { clock: NOW }, identity: { id: OWNER }, params: { id }, scheduler: { runNow: replan, soon() {} } });
  }
  assert.equal(await factRow(db, 'household.birthYears'), null, 'the birth year is restored to unanswered');
  assert.ok((await db.prepare('SELECT undone_at FROM action_receipts WHERE id = ?').get(ids[0])).undone_at);
  assert.equal((await recRow(db, 'va529')).status, 'proposed', 'the replan reopens the rec with its question');
  const back = await scenarioRec(db, 'va529');
  assert.equal(back.status, 'proposed');
  assert.equal(back.question?.answered, false);
  assert.ok(back.question.keys.includes('household.birthYears'));
  assert.ok(!back.answerReceipts?.length);
  recAnswers.reset();
  const html = recAnswers.html(back, 'plan');
  assert.match(html, /<input/);
  assert.doesNotMatch(html, /data-rec-answered/);
});

test('a rec already parked as waiting by the planner block, whose question is answered, is done on the next run', async () => {
  const db = await heldQuestion();
  // The production shape before this fix: the answer landed, the rec went back to proposed, and
  // the replan parked it on the household-wide hold.
  await addFact(db, 'household.birthYears', { owner: 1981 });
  await db.prepare("UPDATE recs SET status = 'waiting', waiting_on = 'data' WHERE id = 'va529'").run();
  await db.prepare("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES ('va529', ?, 'block', 'mfs_unsupported', 'proposed', 'waiting', 'planner')").run(STAMP);
  await db.prepare("UPDATE planner_recs SET held_from = 'proposed' WHERE rec_id = 'va529'").run();
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'done');
  assert.equal(row.waiting_on, null);
  const ev = await lastStatusEvent(db);
  assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['answered', 'planner', 'waiting', 'done']);
  const rec = await scenarioRec(db, 'va529');
  assert.equal(rec.status, 'done');
  assert.equal(rec.blocker, undefined);
  assert.equal(rec.question?.answered, true);
});

test('a question rec answered while its trigger stops applying is done, not dismissed', async () => {
  const db = await heldQuestion();
  // Born 1950: the owner deducts in full, so nothing is left to size and the trigger stops.
  await addFact(db, 'household.birthYears', { owner: 1950 });
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'done');
  const ev = await lastStatusEvent(db);
  assert.deepEqual([ev.action, ev.actor, ev.to_status], ['answered', 'planner', 'done']);
});

test('an answer that unlocks new work reopens the rec as the figured action, and an answer with no actor writes no receipt', async () => {
  const db = await S.store({ variant: { facts: { 'household.birthYears': undefined } } });
  await planRun(db, { now: NOW });
  const before = await recRow(db, 'va529');
  assert.equal(before.def.question?.primary, true);
  // A real store with no signed-in person: the answer is recorded, with no receipt to undo.
  await saveRecAnswers({ db, config: { clock: NOW } }, { recId: 'va529', answers: [{ key: 'household.birthYears', value: { owner: 1981, spouse: 1983 } }] }, { now: STAMP, replan: replanOf(db) });
  assert.equal((await receiptRows(db)).length, 0);
  const answer = (await answerEvents(db)).at(-1);
  assert.equal(answer.to_status, 'done');
  assert.equal(answer.arg, null);
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'proposed', 'new work from the trigger is never hidden under Done');
  assert.equal(row.def.question, undefined);
  assert.match(row.def.title, /Use the rest/);
  const ev = await lastStatusEvent(db);
  assert.deepEqual([ev.actor, ev.from_status, ev.to_status], ['planner', 'done', 'proposed']);
  assert.equal((await scenarioRec(db, 'va529')).answerReceipts, undefined);
});

test('the MCP rec_questions path completes the rec and its answer event carries its receipt ids', async () => {
  const db = await heldQuestion();
  const evidence = 'I was born in 1981';
  const ctx = { db, config: { clock: NOW }, now: STAMP, actorId: OWNER, channel: 'mcp', ownerText: evidence, replan: replanOf(db) };
  const r = await callTool('answer', { operation: 'rec_questions', recId: 'va529', answers: [{ key: 'household.birthYears', value: { owner: 1981 } }], evidence }, ctx);
  assert.equal(r.receipts.length, 1);
  assert.equal((await receiptRows(db)).length, 1, 'one receipt per write, not one per path');
  assert.equal(r.rec.status, 'done');
  assert.equal((await recRow(db, 'va529')).status, 'done');
  const answer = (await answerEvents(db)).at(-1);
  assert.equal(answer.to_status, 'done');
  assert.deepEqual(JSON.parse(answer.arg), r.receipts.map(x => x.id));
  const rec = await scenarioRec(db, 'va529');
  assert.deepEqual(rec.answerReceipts, r.receipts.map(x => x.id));
  assert.equal(rec.blocker, undefined);
});

// ---------------------------------------------------------------- rows stored before RQ2

const setDefGaps = async (db, id, gaps) => {
  const def = (await recRow(db, id)).def;
  await db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify({ ...def, gaps }), id);
};
const cedarGap = () => taxGap('paystub_ytd_missing', { employer: 'Cedar Labs' });

test('a legacy question row carrying the household gap list, parked by the planner and answered, is done with no unrelated gap', async () => {
  const db = await heldQuestion();
  // The pre-RQ2 shape: every household gap stored on the question rec, parked on the hold.
  await setDefGaps(db, 'va529', [cedarGap(), taxGap('va529_answers_missing')]);
  await addFact(db, 'household.birthYears', { owner: 1981 });
  await db.prepare("UPDATE recs SET status = 'waiting', waiting_on = 'data' WHERE id = 'va529'").run();
  await db.prepare("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES ('va529', ?, 'block', 'mfs_unsupported', 'proposed', 'waiting', 'planner')").run(STAMP);
  await db.prepare("UPDATE planner_recs SET held_from = 'proposed' WHERE rec_id = 'va529'").run();
  // Even before the next run, a question rec shows no stored gap.
  recBlocker.bind(kit);
  assert.equal((await scenarioRec(db, 'va529')).gaps, undefined);
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'done');
  assert.equal(row.def.gaps, undefined, 'the completed def no longer stores the household gaps');
  assert.equal(row.def.question?.primary, true, 'the answered question stays on the def');
  const rec = await scenarioRec(db, 'va529');
  assert.equal(rec.status, 'done');
  assert.equal(rec.gaps, undefined);
  for (const surface of ['plan', 'dialog']) assert.equal(recBlocker.html(rec, surface), '');
  assertAnsweredHtml({ ...rec, answerReceipts: ['synthetic-receipt'] }, 1981);
});

test('a legacy action row carrying out-of-scope gaps shows only the gaps on its own inputs', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  assert.ok(await recRow(db, 'hsa-room'), 'hsa-room is on the plan');
  recBlocker.bind(kit);
  // HSA room reads HSA deferrals and ages: the box twelve gap applies, the wage gap does not.
  await setDefGaps(db, 'hsa-room', [cedarGap(), taxGap('w2_box12_unreadable', { employer: 'Juniper Studio' })]);
  const rec = await scenarioRec(db, 'hsa-room');
  assert.deepEqual(rec.gaps.map(g => g.code), ['w2_box12_unreadable']);
  const html = recBlocker.html(rec, 'plan');
  assert.match(html, /Juniper Studio/);
  assert.doesNotMatch(html, /Cedar Labs/);
  // Only out-of-scope gaps stored: the field is gone and nothing renders.
  await setDefGaps(db, 'hsa-room', [cedarGap()]);
  const bare = await scenarioRec(db, 'hsa-room');
  assert.equal(bare.gaps, undefined);
  assert.equal(recBlocker.html(bare, 'plan'), '');
});
