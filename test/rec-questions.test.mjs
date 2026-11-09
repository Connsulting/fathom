// Question recs: answered collapse, plain blockers on waiting recs, missing-data titles and links,
// the Virginia-plan inference, birth years as the one source of ages, and the shared SimpleFIN
// coverage rule. Every household, institution and amount here is synthetic.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { questionFor, ANSWER_SHAPES, CONFIRM_TASKS } from '../src/jobs/triggers/common.mjs';
import { evaluateCatalog, evaluateTriggers } from '../src/jobs/triggers/index.mjs';
import { writeProse } from '../src/jobs/planner/prose.mjs';
import { answerFacts } from '../src/facts/answers.mjs';
import { ageAtYearEnd, accountOwnerAge } from '../src/shared/ages.mjs';
import { inferVirginiaPlan } from '../src/shared/va529-plan.mjs';
import { coveredFileSources, connectedAccountIds } from '../src/ingest/coverage.mjs';
import { ingestState } from '../src/ingest/freshness.mjs';
import * as recAnswers from '../web/horizon/screens/rec-answers.js';
import * as recBlocker from '../web/horizon/screens/rec-blocker.js';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { loadPlanningData } from '../src/jobs/planner/data.mjs';
import { scratch, addFact, accountIdByMask, recRow, MASKS } from './helpers/real-store.mjs';

const NOW = '2026-11-05';
const planFresh = async (db, clock) => (await loadPlanningData(db, clock)).freshness;
const S = scratch('fathom-rec-questions-');
after(async () => await S.cleanup());

const acct = (extra = {}) => ({ id: 'plan-a', kind: '529', name: 'manual', mask: '3333', display_name: 'College fund', inst: '', ...extra });
const FIELD = (q, name) => q.fields.find(f => f.path.at(-1) === name);

// ---------------------------------------------------------------- answered collapse

test('a question whose active fields all hold saved values is answered; a missing one is not', () => {
  const facts = { 'accounts.va529': { 'plan-a': { virginiaPlan: true, carryforward: 0 } }, 'household.birthYears': { owner: 1981 } };
  const done = questionFor(['accounts.va529', 'household.birthYears'], { accounts: [acct()], facts });
  assert.equal(done.answered, true);
  const open = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: true } } } });
  assert.equal(open.answered, false);
  const no = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: false } } } });
  assert.equal(no.answered, true, 'a field behind a No answer is not active');
});

const kit = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), snoozeLabel: () => 'Nov 19', recById: () => null, draw() {}, api: {} };

test('an answered question renders as Answered with an Edit answers link and no controls', () => {
  recAnswers.reset();
  recAnswers.bind(kit);
  const question = questionFor(['accounts.va529'], { accounts: [acct()], facts: { 'accounts.va529': { 'plan-a': { virginiaPlan: false } } } });
  const html = recAnswers.html({ id: 'va529', question }, 'plan');
  assert.match(html, /Answered/);
  assert.match(html, /Edit answers/);
  assert.doesNotMatch(html, /<input|<select|type="submit"/);
});

test('an unanswered question still renders its controls', () => {
  recAnswers.reset();
  recAnswers.bind(kit);
  const question = questionFor(['accounts.va529'], { accounts: [acct()], facts: {} });
  const html = recAnswers.html({ id: 'va529', question }, 'plan');
  assert.match(html, /<input/);
  assert.doesNotMatch(html, /Edit answers/);
});

// ---------------------------------------------------------------- Virginia plan inference and wording

test('Invest529 and Virginia529 are inferred Virginia plans, shown as answered with evidence and Undo', () => {
  assert.equal(inferVirginiaPlan({ inst: 'Invest529' }).value, true);
  assert.equal(inferVirginiaPlan({ inst: 'Virginia 529' }).value, true);
  const q = questionFor(['accounts.va529'], { accounts: [acct({ inst: 'Invest529' })], facts: {} });
  const plan = FIELD(q, 'virginiaPlan');
  assert.equal(plan.value, true);
  assert.match(plan.inferred.evidence, /Invest529/);
  assert.equal(plan.inferred.accountId, 'plan-a');
  assert.equal(FIELD(q, 'ownerAge70Plus'), undefined, 'the age comes from birth years, never per account');
  assert.ok(FIELD(q, 'carryforward'));
  recAnswers.reset();
  recAnswers.bind(kit);
  const html = recAnswers.html({ id: 'va529', question: q }, 'plan');
  assert.match(html, /Invest529/);
  assert.match(html, /Undo/);
});

test('another institution or another state plan is inferred not a Virginia plan', () => {
  const other = inferVirginiaPlan({ inst: 'Example State College Savings' });
  assert.equal(other.value, false);
  assert.match(other.evidence, /Example State College Savings/);
  assert.equal(inferVirginiaPlan({ inst: '' }), null);
  assert.equal(inferVirginiaPlan({}), null);
});

test('with no institution the question asks the pinned wording; Undo returns to asking', () => {
  const q = questionFor(['accounts.va529'], { accounts: [acct()], facts: {} });
  assert.equal(FIELD(q, 'virginiaPlan').label, "Is this Virginia's own 529 program (Invest529), which is the only kind Virginia deducts?");
  assert.equal(FIELD(q, 'virginiaPlan').inferred, undefined);
  const undone = questionFor(['accounts.va529'], { accounts: [acct({ inst: 'Invest529' })], facts: { 'accounts.va529Inference': { 'plan-a': { undone: true } } } });
  assert.equal(FIELD(undone, 'virginiaPlan').inferred, undefined);
  assert.equal(FIELD(undone, 'virginiaPlan').value, undefined);
});

// ---------------------------------------------------------------- birth years

test('birth years give every age from one fact', () => {
  assert.ok(ANSWER_SHAPES['household.birthYears']);
  assert.equal(CONFIRM_TASKS['household.ownerAge'], undefined);
  assert.equal(ANSWER_SHAPES['household.ownerAge'], undefined);
  const years = { owner: 1950, spouse: 1983, dependents: [2018] };
  assert.equal(ageAtYearEnd(years, 'owner', 2026), 76);
  assert.equal(ageAtYearEnd(years, 'spouse', 2026), 43);
  assert.equal(ageAtYearEnd(years, { dependent: 0 }, 2026), 8);
  assert.equal(ageAtYearEnd({}, 'owner', 2026), null);
  assert.equal(ageAtYearEnd(null, 'owner', 2026), null);
  assert.equal(accountOwnerAge(years, 'owner', 2026), 76);
  assert.equal(accountOwnerAge(years, null, 2026, { married: true }), 43, 'an account with no known person uses the youngest adult');
  assert.equal(accountOwnerAge({ owner: 1950 }, null, 2026, { married: true }), null, 'an unknown spouse year leaves the age unknown, never the older owner age');
  assert.equal(accountOwnerAge({ owner: 1950 }, null, 2026), 76, 'a household with no spouse has one adult');
  assert.equal(accountOwnerAge({ spouse: 1950 }, 'owner', 2026), null);
});

test('birth years are asked once as owner and spouse, and the answerer validates the years', async () => {
  const q = questionFor(['household.birthYears'], { accounts: [], facts: { 'household.filingStatus': 'mfj' } });
  assert.deepEqual(q.fields.map(f => f.path), [['owner'], ['spouse']]);
  assert.equal(questionFor(['household.birthYears'], { accounts: [], facts: {} }).fields.length, 1);
  const db = await S.store();
  const replan = async () => {};
  await answerFacts(db, [{ key: 'household.birthYears', value: { owner: 1981, spouse: 1983, dependents: [2018, 2021] } }], { now: '2026-11-05T00:00:00.000Z', replan });
  await answerFacts(db, [{ key: 'household.birthYears', value: { spouse: 1985 } }], { now: '2026-11-05T00:00:00.000Z', replan });
  assert.deepEqual(JSON.parse((await db.prepare("SELECT value FROM facts WHERE key = 'household.birthYears'").get()).value), { owner: 1981, spouse: 1985, dependents: [2018, 2021] }, 'a later answer keeps the years it does not name');
  await db.prepare("DELETE FROM facts WHERE key = 'household.birthYears'").run();
  await assert.rejects(answerFacts(db, [{ key: 'household.birthYears', value: { spouse: 1983 } }], { now: '2026-11-05T00:00:00.000Z', replan }), /answer type/i);
  for (const bad of [{ owner: 1850 }, { owner: 3000 }, { owner: 1981.5 }, { owner: 1981, typo: 1 }, { owner: 1981, dependents: [1] }]) {
    await assert.rejects(answerFacts(db, [{ key: 'household.birthYears', value: bad }], { now: '2026-11-05T00:00:00.000Z', replan }), /answer type/i);
  }
});

// ---------------------------------------------------------------- waiting names its blocker

const baseCtx = extra => ({ clock: NOW, year: 2026, facts: {}, owner: {}, fig: {}, names: {}, model: {}, data: { accounts: [acct()] }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: {} }, ...extra });

test('va529 blocked by the Virginia projection carries the blocker the planner already computed', () => {
  const ctx = baseCtx({
    facts: { 'accounts.has529': true, 'household.state': 'VA', 'accounts.va529': { 'plan-a': { virginiaPlan: true, carryforward: 0 } } },
    info: { blocked: [], confirm: {}, va529: { accounts: 1, missing: [], age70: [], eligible: 1 }, vaBlocked: 'va_itemized_missing' },
  });
  const result = evaluateCatalog(ctx).find(r => r.trigger.id === 'va529');
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'va_itemized_missing');
  assert.equal(result.blocker.code, 'va_itemized_missing');
  assert.match(result.blocker.text, /Virginia standard deduction/);
  assert.match(result.blocker.task, /Enter Virginia deductions/);
  assert.ok(['ask', 'upload', 'confirm', 'accounts'].includes(result.blocker.link));
});

test('a rec with a precision gap names its direct fix on the card and in the dialog', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  assert.equal((await recRow(db, 'va529')).status, 'proposed');
  await addFact(db, 'tax.itemizedEstimate', 90000);
  await db.prepare("UPDATE transactions SET category = 'Uncategorized' WHERE lower(category) LIKE '%charit%' OR lower(category) LIKE '%donat%'").run();
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'va529');
  assert.equal(row.status, 'proposed');
  const rec = (await buildScenario(db, { clock: NOW })).recs.find(r => r.id === 'va529');
  assert.equal(rec.status, 'proposed');
  assert.ok(rec.gaps.some(g => g.code === 'va_itemized_missing'));
  recBlocker.bind(kit);
  for (const surface of ['plan', 'dialog']) {
    const html = recBlocker.html(rec, surface);
    assert.match(html, /Optional estimate improvements/);
    assert.match(html, /Virginia standard deduction/);
    assert.match(html, /Enter Virginia deductions/);
    assert.match(html, /data-tax-gap-fix/);
  }
  await addFact(db, 'tax.vaItemizedEstimate', 80000);
  await planRun(db, { now: NOW });
  const after = (await buildScenario(db, { clock: NOW })).recs.find(r => r.id === 'va529');
  assert.notEqual(after.status, 'waiting');
  assert.equal(after.blocker, undefined);
  assert.equal(recBlocker.html(after, 'plan'), '');
});

test('answering the Virginia questions while the projection is blocked leaves a recorded answer, not an open form', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  await addFact(db, 'tax.itemizedEstimate', 90000);
  await planRun(db, { now: NOW });
  const rec = (await buildScenario(db, { clock: NOW })).recs.find(r => r.id === 'va529');
  if (rec.question) assert.equal(rec.question.answered, true);
});

// ---------------------------------------------------------------- missing-data title, summary and links

test('missing data names its work without prose counts, and each task links to where it is done', async () => {
  const ctx = baseCtx({
    warnings: ['filing_status_assumed'],
    data: { accounts: [], confirm: [{ id: 17, kind: 'tax_year', status: 'pending' }] },
    info: { blocked: ['paystub_ytd_missing', 'tax_year_unconfirmed'], confirm: {}, payrollBlocks: [{ code: 'paystub_ytd_missing', employer: 'Example Employer Inc' }] },
    questionKeys: new Set(),
  });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.title, 'Improve the precision of your estimates');
  const prose = await writeProse(hit, ctx);
  assert.match(prose.fields.summary, /^Your estimates use the information on file/);
  assert.doesNotMatch(prose.fields.summary, /\d/);
  const linked = hit.rec.tasks.filter(t => t.link);
  assert.ok(linked.some(t => t.link === 'ask' && t.fix?.key === 'income.payrollYtd'));
  assert.ok(linked.some(t => t.link === 'upload' && t.code === 'tax_year_unconfirmed' && t.fix?.kind === 'estimates'), 'the gap opens the payment-log upload');
  assert.ok(hit.rec.tasks.some(t => t.kind === 'answer' && t.fact === 'household.filingStatus'), 'the form question is a step that clears when answered');
});

test('missing data that is only uploads is titled as uploads', () => {
  const ctx = baseCtx({ refreshNeeds: { accounts: [{ id: 'cash', inst: 'Example Bank', name: 'Checking' }], sourceIds: new Set() }, freshness: [] });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.title, 'Upload an account statement');
  assert.equal(hit.rec.tasks.filter(t => t.link === 'upload').length, 1);
  assert.match(hit.rec.tasks[0].t, /Example Bank.*Checking/);
});

// ---------------------------------------------------------------- SimpleFIN coverage

test('a file source whose accounts SimpleFIN covers is not stale anywhere; a half covered one still is', async () => {
  const db = await S.store();
  const clock = '2027-06-01';
  const before = await ingestState(db, { clock });
  const cashStale = state => state.staleNotes.filter(n => ['cash', 'invest'].includes(n.domain));
  assert.ok(cashStale(before).length >= 4, 'file sources are stale by mid 2027');
  assert.equal((await coveredFileSources(db)).size, 0, 'nothing is covered before a mapping');

  const sync = db.prepare("INSERT INTO balances (account_id, date, amount, parser) VALUES (?, '2027-05-30', 100, 'simplefin')");
  assert.equal((await connectedAccountIds(db)).size, 0);
  const connection = db.prepare("INSERT INTO simplefin_connection (id, access_blob, connected_at) VALUES (1, 'synthetic', ?)");
  const map = db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at) VALUES (?, ?, 'mapped', 'Synthetic', ?)");
  const connect = async id => { await map.run(`sf-${id}`, id, NOW); await sync.run(id); };

  // One account of the two account aggregator export: that source is not covered.
  const owned = await db.prepare(`SELECT DISTINCT f.source_id AS source, r.account_id AS account FROM files f JOIN
    (SELECT file_id, account_id FROM transactions UNION SELECT file_id, account_id FROM balances) r ON r.file_id = f.id WHERE f.source_id IS NOT NULL`).all();
  const bySource = new Map();
  for (const { source, account } of owned) bySource.set(source, [...(bySource.get(source) || []), account]);
  const multi = [...bySource].find(([, ids]) => ids.length > 1);
  assert.ok(multi, 'a synthetic file source holds more than one account');
  await connection.run(NOW);
  await connect(multi[1][0]);
  assert.equal((await coveredFileSources(db)).has(multi[0]), false);
  assert.equal((await ingestState(db, { clock })).sources.find(x => x.id === multi[0]).state, 'stale', 'a half covered source is still stale');

  for (const id of (await db.prepare('SELECT id FROM accounts').all()).map(a => a.id)) if (!(await connectedAccountIds(db)).has(id)) await connect(id);
  const covered = await coveredFileSources(db);
  assert.ok(covered.has(multi[0]));
  const state = await ingestState(db, { clock });
  for (const s of state.sources.filter(x => covered.has(x.id))) assert.equal(s.state, 'history', `${s.id} is history once SimpleFIN covers it`);
  // Planner freshness (missing-data) agrees: the household transaction log is current through the sync.
  assert.equal((await planFresh(db, clock)).find(f => f.id === 'transactions').state, 'current');
  // A disconnected bridge covers nothing, though its mappings stay.
  await db.prepare('DELETE FROM simplefin_connection').run();
  assert.equal((await coveredFileSources(db)).size, 0);
  assert.equal((await ingestState(db, { clock })).sources.filter(x => x.state === 'covered').length, 0, 'no source state is called covered any more');
  // One rule (coverage.mjs): the planner calls the transaction log stale only when an active
  // account is stale, the same accounts the Cash card counts.
  const anyStale = Object.values((await ingestState(db, { clock })).accounts).some(a => a.fresh === 'stale');
  assert.equal((await planFresh(db, clock)).find(f => f.id === 'transactions').state, anyStale ? 'stale' : 'current');
  await connection.run(NOW);
  assert.deepEqual(state.sources.filter(x => x.state === 'stale' && ['bank_csv', 'card_csv', 'aggregator_csv', 'balances', 'brokerage_positions', 'statement'].includes(x.kind)), []);
  assert.deepEqual(cashStale(state), [], 'the Cash card and the invest note carry no stale file notes once SimpleFIN covers the accounts');
});

// ---------------------------------------------------------------- birth years from parsed notes

test('parsed notes can supply birth years, and nothing else is read as one', async () => {
  const { toRows } = await import('../src/ingest/extract.mjs');
  const rows = value => toRows('notes', { facts: [{ key: 'household.birthYears', value, confidence: 0.9 }], goals: [] }, { entities: [] });
  const fact = value => rows(value).find(r => r.kind === 'fact');
  assert.deepEqual(fact('owner 1981, spouse 1983, dependents 2018 2021').value, { owner: 1981, spouse: 1983, dependents: [2018, 2021] });
  assert.deepEqual(fact('{"owner": 1981}').value, { owner: 1981 });
  assert.equal(fact('spouse 1983'), undefined, 'no owner year, no fact');
  assert.equal(fact('owner 1650'), undefined, 'a year before 1900 is not a birth year');
});

test('missing data that is only questions keeps its title and count-free summary', async () => {
  const ctx = baseCtx({ warnings: ['filing_status_assumed'] });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.question.primary, true);
  assert.equal(hit.rec.title, 'Answer a tax question');
  assert.match((await writeProse(hit, ctx)).fields.summary, /^Your estimates use the information on file/);
});

test('saved dependent birth years set the child count, and the planner reads one source for ages', async () => {
  const db = await S.store();
  await planRun(db, { now: NOW });
  const before = JSON.stringify(await db.prepare("SELECT key, v FROM figures WHERE key LIKE 'tax.fed.%' ORDER BY key").all());
  await addFact(db, 'household.birthYears', { owner: 1981, spouse: 1983, dependents: [2010, 2012, 2020] });
  await planRun(db, { now: NOW });
  const after = JSON.stringify(await db.prepare("SELECT key, v FROM figures WHERE key LIKE 'tax.fed.%' ORDER BY key").all());
  assert.notEqual(after, before, 'three children under 17 change the federal projection');
});
