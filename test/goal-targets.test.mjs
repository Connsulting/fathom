// Suggested goal targets (plan feat-suggested-goal-targets, Interface contract): the pure kind
// matcher in src/calc/targets.mjs and the store reader buildSuggestions in src/suggest/build.mjs,
// over temp stores seeded with synthetic rows through SQL inserts. Every name and amount is
// invented; nothing here reads demo data.
//
// The synthetic household (household() below), clock 2026-11-05:
//   Joint checking (checking): an inflow of 4,005 on the 10th and an outflow of 3,005 on the 15th
//     of every month January to August, so the complete-month window is Feb to Jul (six months),
//     monthly spending 3,005, annual 36,060, monthly savings 1,000. Balance 2,000 on Oct 31.
//   High yield savings (savings): balance 5,000 on Oct 31, no transactions.
//   Wallet cash (cash): no rows at all.
//   Business checking (business): balance 40,000 (never a household cash account).
//   Taxable brokerage (taxable): two positions of 150,000 on Oct 31.
//   Rollover IRA (retirement): balance 200,000 on Oct 31.
//   Roth IRA (roth): no stored value.
//   Family HSA (hsa): balance 10,000 (never an investment account here).
// So: cushion target 6 * 3,005 = 18,030 -> 18,100; cash 7,000; independence target
// 36,060 / 0.04 = 901,500 -> 902,000; invested 500,000.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { goalKind, spendingFigures, spendingInputs, TARGET_PARAMETERS } from '../src/calc/targets.mjs';
import { accountLabel } from '../src/shared/account-label.mjs';
import { buildSuggestions, SUGGEST_SETTING } from '../src/suggest/build.mjs';
import { forEachSeries } from '../src/shared/series.mjs';

const CLOCK = '2026-11-05';
const ASK = 'What amount would make this real?';
const pad = n => String(n).padStart(2, '0');
// Labels carry no digits except the identifiers the grounding guard masks (data.mjs cleanLabel).
const digitFree = s => !/\d/.test(String(s).replace(/401\s*\(\s*k\s*\)|401k|529/gi, ''));

async function store(t, clock = CLOCK) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  await setSetting(s.db, 'clock', clock);
  await setSetting(s.db, 'mode', 'real');
  return s.db;
}

const account = async (db, id, kind, name) =>
  await db.prepare("INSERT INTO accounts (id, inst, name, kind) VALUES (?, 'Example Bank', ?, ?)").run(id, name, kind);
const balance = async (db, id, date, amount) =>
  await db.prepare("INSERT INTO balances (account_id, date, amount, parser, locator) VALUES (?, ?, ?, 'fixture', 'balance')").run(id, date, amount);
const position = async (db, id, date, symbol, value) =>
  await db.prepare("INSERT INTO positions (account_id, as_of, symbol, value, parser, locator) VALUES (?, ?, ?, ?, 'fixture', 'row')").run(id, date, symbol, value);
const txn = async (db, id, date, amount, description = 'Synthetic entry') =>
  await db.prepare("INSERT INTO transactions (account_id, date, amount, description, parser, locator) VALUES (?, ?, ?, ?, 'fixture', 'row')").run(id, date, amount, description);

async function putGoal(db, id, { origin = 'owner', archived = false, ...fields } = {}) {
  const def = { id, title: 'A goal', note: '', horizon: 'now', target: null, targetDate: null, track: null, ...fields };
  await db.prepare('INSERT INTO goals (id, def, sort, origin, created_at, updated_at, archived_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run(id, JSON.stringify(def), origin, CLOCK, CLOCK, archived ? CLOCK : null);
  return def;
}
async function editGoal(db, id, patch) {
  const def = { ...JSON.parse((await db.prepare('SELECT def FROM goals WHERE id = ?').get(id)).def), ...patch };
  await db.prepare('UPDATE goals SET def = ? WHERE id = ?').run(JSON.stringify(def), id);
}

async function household(db, {
  months = [1, 2, 3, 4, 5, 6, 7, 8], skip = [], income = 4005, spend = 3005,
  cash = { chk: 2000, sav: 5000 }, brokerage = [150000, 150000], retirement = 200000,
} = {}) {
  await account(db, 'chk', 'checking', 'Joint checking');
  await account(db, 'sav', 'savings', 'High yield savings');
  await account(db, 'wal', 'cash', 'Wallet cash');
  await account(db, 'biz', 'business', 'Business checking');
  await account(db, 'brk', 'taxable', 'Taxable brokerage');
  await account(db, 'ret', 'retirement', 'Rollover IRA');
  await account(db, 'rth', 'roth', 'Roth IRA');
  await account(db, 'hsa', 'hsa', 'Family HSA');
  for (const m of months) {
    if (skip.includes(m)) continue;
    await txn(db, 'chk', `2026-${pad(m)}-10`, income, 'Paycheck');
    await txn(db, 'chk', `2026-${pad(m)}-15`, -spend, 'Rent');
  }
  for (const [id, v] of Object.entries(cash)) await balance(db, id, '2026-10-31', v);
  await balance(db, 'biz', '2026-10-31', 40000);
  await forEachSeries(brokerage, async (v, i) => await position(db, 'brk', '2026-10-31', `FUND${'AB'[i] || i}`, v));
  if (retirement != null) await balance(db, 'ret', '2026-10-31', retirement);
  await balance(db, 'hsa', '2026-10-31', 10000);
}

const build = async (db, clock = CLOCK) => await buildSuggestions(db, { clock });
const recOf = (r, id) => r.suggestions.find(s => s.goalId === id);
const figOf = (r, rec, name) => r.figures[rec.figures[name]];

// ---------------------------------------------------------------- goalKind

test('goalKind maps the starter goals and free text to a kind, first by specific words', () => {
  assert.equal(TARGET_PARAMETERS.cushionMonths, 6);
  assert.equal(TARGET_PARAMETERS.withdrawalRate, 0.04);
  assert.ok(Object.isFrozen(TARGET_PARAMETERS));
  const kind = (title, note = '') => goalKind({ title, note });
  assert.deepEqual(kind('A cash cushion'), { kind: 'cushion', reason: null });
  assert.deepEqual(kind('Work less, on our terms'), { kind: 'independence', reason: null });
  assert.deepEqual(kind('work becomes optional because investments cover household spending'), { kind: 'independence', reason: null });
  assert.deepEqual(kind('Pay less tax, without stress'), { kind: 'tax', reason: null });
  assert.deepEqual(kind('Pay less tax by maximizing retirement contributions'), { kind: 'tax', reason: null });
  assert.deepEqual(kind('Retire early and cut taxes'), { kind: null, reason: 'ambiguous_goal' });
  assert.deepEqual(kind('Kids and family'), { kind: null, reason: 'unsupported_goal' });
  assert.deepEqual(kind('Peace of mind', 'Six months of expenses in the bank'), { kind: 'cushion', reason: null }, 'the note counts');
});

test('goalKind ignores scenario tokens in the title and note', () => {
  assert.deepEqual(goalKind({ title: '{n:me} wants a cash cushion' }), { kind: 'cushion', reason: null });
  // Without stripping, the token key "tax.fed.proj" would add the tax kind and make it ambiguous.
  assert.deepEqual(goalKind({ title: 'Emergency fund before {f:tax.fed.proj} is due' }), { kind: 'cushion', reason: null });
  assert.deepEqual(goalKind({ title: 'Kids and family', note: '{f:tax.total} and {n:spouse}' }), { kind: null, reason: 'unsupported_goal' });
});

// ---------------------------------------------------------------- spending window

test('the spending window drops the partial first and last months: January to August gives Feb to Jul', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  const r = await build(db);
  assert.equal(r.clock, CLOCK);
  const rec = recOf(r, 'cushion');
  assert.equal(rec.state, 'suggested');
  assert.deepEqual(rec.window, { from: '2026-02', to: '2026-07', months: 6 });
  assert.equal(figOf(r, rec, 'monthlySpend').v, 3005);
  assert.equal(figOf(r, rec, 'monthlySavings').v, 1000);
  // annualSpend is the independence input (the cushion record may omit it).
  const free = recOf(r, 'free');
  assert.deepEqual(free.window, rec.window);
  assert.equal(figOf(r, free, 'annualSpend').v, 36060);
});

test('a matched transfer to another household account is not spending; an unmatched one is', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  // Checking to brokerage, same cents, three days apart: a transfer, left out of spending.
  await txn(db, 'chk', '2026-03-20', -500, 'Transfer out');
  await txn(db, 'brk', '2026-03-23', 500, 'Transfer in');
  let r = await build(db);
  assert.equal(figOf(r, recOf(r, 'cushion'), 'monthlySpend').v, 3005);
  // The same inflow eight days later is outside the five-day rule: the outflow is spending.
  await db.prepare("UPDATE transactions SET date = '2026-03-28' WHERE account_id = 'brk'").run();
  r = await build(db);
  const spend = figOf(r, recOf(r, 'cushion'), 'monthlySpend').v;
  assert.ok(Math.abs(spend - 3088.33) < 0.01, `monthly spending ${spend} counts the unmatched outflow`);
});

test('a month with no transaction on a participating account splits the window; the latest run is kept', async t => {
  const db = await store(t);
  await household(db, { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], skip: [3] });
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  const rec = recOf(await build(db), 'cushion');
  assert.equal(rec.state, 'suggested');
  assert.deepEqual(rec.window, { from: '2026-04', to: '2026-09', months: 6 });
});

test('a card that opens inside the window does not shorten it', async t => {
  const db = await store(t);
  await household(db);
  await account(db, 'crd', 'card', 'Rewards card');
  for (const m of [6, 7, 8]) await txn(db, 'crd', `2026-0${m}-15`, -100, 'Groceries');
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  // Checking still sets Feb to Jul. The card's only complete month is July, so its 100 counts there.
  assert.equal(rec.state, 'suggested');
  assert.deepEqual(rec.window, { from: '2026-02', to: '2026-07', months: 6 });
  assert.equal(figOf(r, rec, 'monthlySpend').v, 3021.67);
});

const ymIndex = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
function spanTx(id, from, to, amount = -100) {
  const rows = [];
  for (let i = ymIndex(from); i <= ymIndex(to); i++) {
    const ym = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    rows.push({ id: `${id}-${ym}`, account_id: id, date: `${ym}-02`, amount });
  }
  return rows;
}
const labeled = (id, display_name, kind = 'card') => ({ id, kind, name: display_name, inst: 'Example Bank', display_name });

test('closed cards, a mid-window card, stale feeds, live feeds and a partial month', () => {
  assert.equal(TARGET_PARAMETERS.closedAfterMonths, 6);
  const accounts = [
    labeled('c1', 'Closed card one'),
    labeled('c2', 'Closed card two'),
    labeled('new', 'New card'),
    labeled('s1', 'Stale one', 'checking'),
    labeled('s2', 'Stale two', 'checking'),
    labeled('s3', 'Stale three', 'savings'),
    labeled('l1', 'Live one', 'checking'),
    labeled('l2', 'Live two', 'cash'),
    labeled('part', 'Partial card'),
  ];
  const transactions = [
    ...spanTx('c1', '2023-01', '2024-06'),
    ...spanTx('c2', '2023-06', '2024-11'),
    ...spanTx('new', '2026-03', '2026-11'),
    ...spanTx('s1', '2024-06', '2026-08'),
    ...spanTx('s2', '2024-06', '2026-08'),
    ...spanTx('s3', '2024-06', '2026-08'),
    ...spanTx('l1', '2024-06', '2026-11'),
    ...spanTx('l2', '2024-06', '2026-11'),
    { id: 'part-1', account_id: 'part', date: '2026-11-02', amount: -400 },
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.missing, []);
  assert.deepEqual(sp.window, { from: '2025-08', to: '2026-07', months: 12 });
  // Three stale and two live for 12 months, plus the new card for Apr-Jul: 3*12+2*12+4 = 64 hundreds.
  assert.equal(sp.monthlySpend, 533.33);
  assert.deepEqual(sp.incomplete.map(a => a.id), ['part']);
  assert.deepEqual(sp.closed.map(a => a.id), ['c1', 'c2']);
  assert.deepEqual(sp.limitedBy.map(a => a.id), ['s1', 's2', 's3']);
  const note = spendingFigures(sp, { clock: '2026-11-05' }).monthlySpend.notes.join(' ');
  assert.match(note, /ends in Jul 2026/);
  for (const a of sp.limitedBy) assert.ok(note.includes(accountLabel(a)), accountLabel(a));
  assert.ok(note.includes(accountLabel(accounts[8])), 'partial account is named');
});

test('a closed account does not cap the window and counts only inside its own range', () => {
  const accounts = [labeled('old', 'Old card'), labeled('live', 'Live checking', 'checking')];
  const transactions = [
    ...spanTx('old', '2024-01', '2025-12', -50),
    ...spanTx('live', '2024-06', '2026-11', -100),
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.window, { from: '2025-11', to: '2026-10', months: 12 });
  assert.deepEqual(sp.closed.map(a => a.id), ['old']);
  // Old card's complete months run through Nov 2025, so only Nov 2025 overlaps the window.
  assert.equal(sp.monthlySpend, 104.17);
});

test('an account that opens inside the window is zero before its first complete month', () => {
  const accounts = [labeled('chk', 'Checking', 'checking'), labeled('new', 'New card')];
  const transactions = [
    ...spanTx('chk', '2024-06', '2026-11', -100),
    ...spanTx('new', '2026-03', '2026-11', -80),
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.window, { from: '2025-11', to: '2026-10', months: 12 });
  // New card complete months start Apr 2026: seven months inside Nov 2025-Oct 2026.
  assert.equal(sp.monthlySpend, 146.67);
});

test('an account with no complete month is named and does not block the household', () => {
  const accounts = [labeled('chk', 'Checking', 'checking'), labeled('part', 'Partial card')];
  const transactions = [
    ...spanTx('chk', '2025-01', '2026-11', -100),
    { id: 'part-1', account_id: 'part', date: '2026-11-02', amount: -400 },
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.missing, []);
  assert.deepEqual(sp.window, { from: '2025-11', to: '2026-10', months: 12 });
  assert.deepEqual(sp.incomplete.map(a => a.id), ['part']);
  assert.equal(sp.monthlySpend, 100);
  const note = spendingFigures(sp, { clock: '2026-11-05' }).monthlySpend.notes.join(' ');
  assert.ok(note.includes(accountLabel(accounts[1])));
});

test('a stale feed still caps the window end', () => {
  const accounts = [labeled('live', 'Live checking', 'checking'), labeled('stale', 'Stale checking', 'checking')];
  const transactions = [
    ...spanTx('live', '2024-06', '2026-11', -100),
    ...spanTx('stale', '2024-06', '2026-08', -100),
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.window, { from: '2025-08', to: '2026-07', months: 12 });
  assert.deepEqual(sp.limitedBy.map(a => a.id), ['stale']);
  assert.equal(sp.monthlySpend, 200);
  const note = spendingFigures(sp, { clock: '2026-11-05' }).monthlySpend.notes.join(' ');
  assert.match(note, /ends in Jul 2026/);
  assert.ok(note.includes(accountLabel(accounts[1])));
});

test('a gap keeps the latest run instead of reading the account as newly opened', () => {
  const accounts = [labeled('a', 'Checking', 'checking'), labeled('b', 'Card')];
  const transactions = [
    ...spanTx('a', '2025-01', '2026-11', -100),
    ...spanTx('b', '2025-01', '2026-11', -100).filter(t => !t.date.startsWith('2026-06')),
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.deepEqual(sp.window, { from: '2026-07', to: '2026-10', months: 4 });
  assert.equal(sp.monthlySpend, 200);
});

test('no_spending_history remains when fewer than three complete months survive', () => {
  const accounts = [labeled('chk', 'Checking', 'checking'), labeled('old', 'Old card')];
  const transactions = [
    ...spanTx('chk', '2026-08', '2026-11', -100),
    ...spanTx('old', '2023-01', '2024-06', -100),
  ];
  const sp = spendingInputs({ accounts, transactions, clock: '2026-11-05' });
  assert.equal(sp.window, null);
  assert.ok(sp.missing.includes('no_spending_history'));
});

test('the spending note uses stored display names, not the kind word', async t => {
  const db = await store(t);
  await household(db, { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  await db.prepare('UPDATE accounts SET name = ?, display_name = ? WHERE id = ?').run('chase_total_checking', 'Bills account', 'chk');
  await account(db, 'part', 'card', 'travel_rewards_card');
  await db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run('Travel card', 'part');
  await txn(db, 'part', '2026-11-02', -50, 'One charge');
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  const note = figOf(r, rec, 'monthlySpend').notes.join(' ');
  assert.ok(note.includes('Bills account'), note);
  assert.ok(note.includes('Travel card'), note);
  assert.equal(note.includes('chase_total_checking'), false);
});

test('fewer than three complete months is a question, not a number', async t => {
  const db = await store(t);
  await household(db, { months: [1, 2, 3, 4] });
  await putGoal(db, 'cushion', { title: 'A cash cushion' });
  await putGoal(db, 'free', { title: 'work becomes optional because investments cover household spending', horizon: '3-10y' });
  const r = await build(db);
  for (const id of ['cushion', 'free']) {
    const rec = recOf(r, id);
    assert.equal(rec.state, 'question', id);
    assert.ok(rec.missing.includes('no_spending_history'), `${id} missing ${rec.missing}`);
    assert.equal(rec.accept, null);
  }
});

// ---------------------------------------------------------------- cushion

test('cushion: six months of spending rounded up to the next hundred, tracking personal cash with a balance', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  assert.equal(rec.kind, 'cushion');
  assert.equal(rec.state, 'suggested');
  assert.equal(rec.title, 'A cash cushion');
  assert.equal(rec.horizonLabel, 'Next few years');
  const target = figOf(r, rec, 'target');
  assert.equal(target.v, 18100, '6 * 3,005 = 18,030, rounded up to 18,100');
  assert.equal(target.kind, 'e');
  assert.equal(target.locator.parameters.cushionMonths, 6);
  assert.equal(figOf(r, rec, 'current').v, 7000);
  // Checking and savings have balances; wallet cash has none; business, brokerage, IRA and HSA are not personal cash.
  assert.deepEqual([...rec.track.accounts].sort(), ['chk', 'sav']);
  assert.match(rec.trackLabel, /Joint checking/);
  assert.match(rec.trackLabel, /High yield savings/);
  assert.doesNotMatch(rec.trackLabel, /Business|Wallet|brokerage/);
  // 18,100 - 7,000 = 11,100 at 1,000 a month: twelve months after the clock month end (Nov 30).
  assert.equal(rec.dateSource, 'projected');
  assert.equal(rec.targetDate, '2027-11-30');
  assert.equal(rec.covered, false);
  assert.deepEqual(rec.accept, { target: 18100, targetDate: '2027-11-30', track: rec.track });
  assert.equal(rec.params.cushionMonths, 6);
  assert.equal(rec.ask, null);
  assert.deepEqual(rec.missing, []);
  assert.match(rec.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(rec.why && digitFree(rec.why), `why is plain text without digits: ${rec.why}`);
});

test('cushion already covered: the date is the end of the chosen horizon and covered is true', async t => {
  const db = await store(t);
  await household(db, { cash: { chk: 2000, sav: 20000 } });
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: 'now' });
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  assert.equal(rec.state, 'suggested');
  assert.equal(rec.covered, true);
  assert.equal(figOf(r, rec, 'current').v, 22000);
  assert.equal(figOf(r, rec, 'target').v, 18100);
  assert.equal(rec.dateSource, 'horizon');
  assert.equal(rec.targetDate, '2026-12-31');
  assert.equal(rec.horizonLabel, 'This year');
  assert.equal(rec.accept.target, 18100);
});

test('cushion with savings not positive: no projection, the date is the horizon end', async t => {
  const db = await store(t);
  await household(db, { income: 3005 });
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  assert.equal(figOf(r, rec, 'monthlySavings').v, 0);
  assert.equal(rec.dateSource, 'horizon');
  assert.equal(rec.targetDate, '2029-12-31');
  assert.equal(rec.covered, false);
});

// ---------------------------------------------------------------- independence

test('independence: annual spending over the withdrawal rate, rounded up to the next thousand, tracking investments', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  const r = await build(db);
  const rec = recOf(r, 'free');
  assert.equal(rec.kind, 'independence');
  assert.equal(rec.state, 'suggested');
  const target = figOf(r, rec, 'target');
  assert.equal(target.v, 902000, '36,060 / 0.04 = 901,500, rounded up to 902,000');
  assert.equal(target.kind, 'm');
  assert.equal(target.locator.parameters.withdrawalRate, 0.04);
  assert.equal(target.locator.parameters.realReturn, 0.04);
  assert.equal(rec.params.withdrawalRate, 0.04);
  // Brokerage positions summed and the IRA balance; the Roth has no value and the HSA is excluded.
  assert.deepEqual([...rec.track.accounts].sort(), ['brk', 'ret']);
  assert.equal(figOf(r, rec, 'current').v, 500000);
  // Annuity solution with 1,000 a month from 500,000 is about 123 months (monthly rate 0.04 / 12)
  // or 124 months (0.04 a year compounded monthly): Feb 2037 or Mar 2037.
  assert.equal(rec.dateSource, 'projected');
  assert.ok(['2037-02-28', '2037-03-31'].includes(rec.targetDate), rec.targetDate);
  assert.equal(rec.covered, false);
  assert.deepEqual(rec.accept, { target: 902000, targetDate: rec.targetDate, track: rec.track });
});

test('independence: a remembered withdrawal rate changes the target; the newest valid one wins', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  assert.equal(SUGGEST_SETTING, 'goals.suggestions');
  const remember = async (id, text, at) => await db.prepare("INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)").run(id, text, at, at);
  await remember('a', 'Plan on a 3% withdrawal rate', '2026-10-01T00:00:00.000Z');
  await remember('b', 'Use a withdrawal rate of 3.5%', '2026-10-02T00:00:00.000Z');
  await remember('c', 'Withdrawal rate 9%, which is out of range', '2026-10-03T00:00:00.000Z');
  await remember('d', 'Keep cash flexible', '2026-10-04T00:00:00.000Z');
  const r = await build(db);
  const rec = recOf(r, 'free');
  assert.equal(rec.params.withdrawalRate, 0.035);
  assert.equal(figOf(r, rec, 'target').v, 1031000, '36,060 / 0.035 = 1,030,285.71, rounded up to 1,031,000');
  assert.equal(figOf(r, rec, 'target').locator.parameters.withdrawalRate, 0.035);
  assert.equal(rec.accept.target, 1031000);
});

test('independence beyond fifty years of saving: the date is the end of the Long range horizon', async t => {
  const db = await store(t);
  await household(db, { income: 3006, brokerage: [500, 500], retirement: null });
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  const r = await build(db);
  const rec = recOf(r, 'free');
  assert.equal(figOf(r, rec, 'monthlySavings').v, 1);
  assert.equal(figOf(r, rec, 'current').v, 1000);
  assert.equal(rec.dateSource, 'horizon');
  assert.equal(rec.targetDate, '2036-12-31');
  assert.equal(rec.horizonLabel, 'Long range');
  assert.deepEqual(rec.track.accounts, ['brk']);
});

test('a brokerage to checking transfer is not income, so it does not raise savings', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  await txn(db, 'brk', '2026-05-03', -2000, 'Withdrawal');
  await txn(db, 'chk', '2026-05-05', 2000, 'Transfer from brokerage');
  const r = await build(db);
  const rec = recOf(r, 'free');
  assert.equal(figOf(r, rec, 'monthlySavings').v, 1000);
  assert.equal(figOf(r, rec, 'monthlySpend').v, 3005);
});

// ---------------------------------------------------------------- tax

async function room(db, key, v, computedOn, { unavailable = null, kind = 'm' } = {}) {
  await db.prepare("INSERT OR IGNORE INTO sources (id, label) VALUES ('calc:retirement', 'Retirement room calculators')").run();
  await db.prepare("INSERT INTO figures (key, v, src, kind, label, locator, updated_at, unavailable_reason) VALUES (?, ?, 'calc:retirement', ?, 'Room left this year', ?, ?, ?)")
    .run(key, v, kind, JSON.stringify({ calc: 'room', inputs: {}, computedOn }), `${computedOn}T09:00:00.000Z`, unavailable);
}

test('tax: this year\'s room from stored planner figures, by Dec 31, tracking nothing', async t => {
  const db = await store(t);
  await room(db, 'room.solo401k.pretax', 20000, '2026-11-01');
  await room(db, 'room.hsa', 4000, '2026-11-01');
  await putGoal(db, 'tax', { title: 'Pay less tax, without stress' });
  const r = await build(db);
  const rec = recOf(r, 'tax');
  assert.equal(rec.kind, 'tax');
  assert.equal(rec.state, 'suggested');
  const target = figOf(r, rec, 'target');
  assert.equal(target.v, 24000);
  assert.equal(target.kind, 'm');
  assert.equal(rec.targetDate, '2026-12-31');
  assert.equal(rec.dateSource, 'deadline');
  assert.equal(rec.track, null);
  assert.equal(rec.trackLabel, null);
  assert.deepEqual(rec.accept, { target: 24000, targetDate: '2026-12-31', track: null });
  assert.equal(rec.figures.rooms.length, 2);
  for (const key of rec.figures.rooms) {
    assert.ok(key.startsWith('suggest.tax.room.'), key);
    assert.equal(r.figures[key].kind, 'm');
  }
  assert.equal(rec.figures.rooms.reduce((s, k) => s + r.figures[k].v, 0), 24000);
});

test('tax: a withheld room figure is ignored', async t => {
  const db = await store(t);
  await room(db, 'room.solo401k.pretax', 20000, '2026-11-01');
  await room(db, 'room.hsa', 4000, '2026-11-01', { unavailable: 'Waiting on payroll records' });
  await putGoal(db, 'tax', { title: 'Pay less tax, without stress' });
  const r = await build(db);
  const rec = recOf(r, 'tax');
  assert.equal(figOf(r, rec, 'target').v, 20000);
  assert.equal(rec.figures.rooms.length, 1);
});

test('tax: room computed in January belongs to last year\'s planning year, so January asks', async t => {
  const db = await store(t, '2027-01-15');
  await room(db, 'room.solo401k.pretax', 20000, '2027-01-10');
  await room(db, 'room.hsa', 4000, '2027-01-10');
  await putGoal(db, 'tax', { title: 'Pay less tax, without stress' });
  const rec = recOf(await build(db, '2027-01-15'), 'tax');
  assert.equal(rec.state, 'question');
  assert.ok(rec.missing.includes('no_tax_room'), `missing ${rec.missing}`);
  assert.equal(rec.accept, null);
});

test('tax: no room figures at all is a question', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'tax', { title: 'Pay less tax, without stress' });
  const rec = recOf(await build(db), 'tax');
  assert.equal(rec.state, 'question');
  assert.ok(rec.missing.includes('no_tax_room'));
});

// ---------------------------------------------------------------- questions

test('questions never carry a number', async t => {
  const db = await store(t);
  await putGoal(db, 'kids', { title: 'Kids and family' });
  await putGoal(db, 'both', { title: 'Retire early and cut taxes' });
  await putGoal(db, 'cushion', { title: 'A cash cushion' });
  await putGoal(db, 'free', { title: 'Work less, on our terms' });
  // Spending exists but no cash or investment account holds a stored value.
  await household(db, { cash: {}, brokerage: [], retirement: null });
  await db.prepare("DELETE FROM balances WHERE account_id IN ('biz', 'hsa')").run();
  const r = await build(db);
  const expect = { kids: 'unsupported_goal', both: 'ambiguous_goal', cushion: 'no_cash_balance', free: 'no_investment_balance' };
  for (const [id, code] of Object.entries(expect)) {
    const rec = recOf(r, id);
    assert.equal(rec.state, 'question', id);
    assert.ok(rec.missing.includes(code), `${id} missing ${rec.missing}`);
    assert.equal(rec.accept, null, id);
    assert.equal(rec.figures.target, undefined, id);
    assert.equal(rec.ask, ASK, id);
    assert.ok(digitFree(rec.why), `${id} why has no digits: ${rec.why}`);
  }
  assert.equal(recOf(r, 'kids').kind, null);
  assert.equal(recOf(r, 'both').kind, null);
  assert.ok(!Object.keys(r.figures).some(k => k.endsWith('.target')), 'no target figure for any question');
});

test('a store with no accounts asks on every starter goal', async t => {
  const db = await store(t);
  for (const [id, title] of [['c', 'A cash cushion'], ['w', 'Work less, on our terms'], ['p', 'Pay less tax, without stress']]) await putGoal(db, id, { title });
  const r = await build(db);
  assert.equal(r.suggestions.length, 3);
  for (const rec of r.suggestions) {
    assert.equal(rec.state, 'question', rec.goalId);
    assert.ok(rec.missing.length > 0);
    assert.equal(rec.ask, ASK);
  }
  assert.ok(recOf(r, 'c').missing.includes('no_spending_history'));
});

// ---------------------------------------------------------------- dismissal

test('a declined suggestion stays declined when the goal text or an input changes', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  await setSetting(db, SUGGEST_SETTING, { cushion: { declined: true } });
  let rec = recOf(await build(db), 'cushion');
  assert.equal(rec.state, 'declined');
  assert.equal(rec.accept.target, 18100, 'a declined record keeps the suggestion it hides');
  assert.ok(rec.figures.target);

  await editGoal(db, 'cushion', { title: 'Our cash cushion' });
  assert.equal(recOf(await build(db), 'cushion').state, 'declined', 'a new title does not revive it');
  await txn(db, 'chk', '2026-05-20', -120, 'Hardware store');
  assert.equal(recOf(await build(db), 'cushion').state, 'declined', 'new spending does not revive it');

  // Entries for goals that do not exist, and old dismissal entries, are ignored.
  await setSetting(db, SUGGEST_SETTING, { gone: { declined: true }, cushion: { dismissed: rec.fingerprint } });
  assert.equal(recOf(await build(db), 'cushion').state, 'suggested');
});

// ---------------------------------------------------------------- provenance and scope

test('every suggested figure carries calculator provenance; only untargeted owner goals get a record', async t => {
  const db = await store(t);
  await household(db);
  await room(db, 'room.solo401k.pretax', 20000, '2026-11-01');
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  await putGoal(db, 'free', { title: 'Work less, on our terms', horizon: '3-10y' });
  await putGoal(db, 'tax', { title: 'Pay less tax, without stress' });
  await putGoal(db, 'seed', { title: 'A cash cushion', origin: 'seed' });
  await putGoal(db, 'set', { title: 'A cash cushion', target: 25000, targetDate: '2027-12-31', track: { accounts: ['chk'] } });
  await putGoal(db, 'zero', { title: 'A cash cushion', target: 0 });
  await putGoal(db, 'old', { title: 'A cash cushion', archived: true });
  await putGoal(db, 'done', { title: 'A cash cushion', status: 'done' });
  const r = await build(db);
  assert.deepEqual(r.suggestions.map(s => s.goalId).sort(), ['cushion', 'free', 'tax']);

  const keys = Object.keys(r.figures);
  assert.ok(keys.length >= 9, `figures: ${keys}`);
  for (const [key, f] of Object.entries(r.figures)) {
    assert.match(key, /^suggest\.(cushion|free|tax)\./, key);
    assert.ok(Number.isFinite(f.v), key);
    assert.equal(f.src, 'calc:targets', key);
    assert.ok(['e', 'm', 'a'].includes(f.kind), key);
    assert.ok(typeof f.label === 'string' && f.label.trim() && digitFree(f.label), `${key} label: ${f.label}`);
    assert.ok(Array.isArray(f.notes) && f.notes.length, `${key} has notes`);
    for (const n of f.notes) assert.ok(typeof n === 'string' && n.trim() && !/<[a-z/]|\{[a-z]+:/i.test(n), `${key} note is plain text: ${n}`);
    const loc = f.locator;
    assert.ok(loc && typeof loc.calc === 'string', key);
    assert.ok(loc.parameters && typeof loc.parameters === 'object', key);
    assert.ok(Array.isArray(loc.steps) && loc.steps.length, key);
    for (const s of loc.steps) assert.ok('label' in s && 'formula' in s && 'value' in s, key);
    assert.equal(loc.computedOn, CLOCK, key);
    assert.ok(Array.isArray(loc.sources) && loc.sources.length, `${key} has sources`);
    for (const s of loc.sources) {
      assert.ok(s.rows && typeof s.rows.table === 'string', `${key} source rows`);
      assert.ok(Array.isArray(s.rows.ids) && s.rows.ids.length <= 50, key);
      assert.equal(typeof s.rows.count, 'number', key);
      assert.ok(s.rows.count >= s.rows.ids.length, key);
    }
  }
  for (const rec of r.suggestions) {
    for (const [name, ref] of Object.entries(rec.figures)) {
      for (const k of [ref].flat()) assert.ok(r.figures[k], `${rec.goalId}.${name} -> ${k} exists`);
    }
  }
  const cushion = recOf(r, 'cushion');
  assert.ok(figOf(r, cushion, 'monthlySpend').locator.sources.some(s => s.rows.table === 'transactions'));
  assert.ok(figOf(r, cushion, 'current').locator.sources.some(s => s.rows.table === 'balances'));
  assert.ok(figOf(r, cushion, 'target').locator.window, 'the window rides on the locator');
  assert.ok(figOf(r, recOf(r, 'tax'), 'target').locator.sources.some(s => s.rows.table === 'figures'));
});

// ---------------------------------------------------------------- business-owned accounts

// A checking account that belongs to the business: monthly outflows of 700 (January to August),
// a stored balance of 9,000 and a 1,500 transfer into Joint checking on May 3 and 5.
async function businessChecking(db, id = 'bchk') {
  await account(db, id, 'checking', 'Studio operating');
  for (const m of [1, 2, 3, 4, 5, 6, 7, 8]) await txn(db, id, `2026-${pad(m)}-12`, -700, 'Vendor');
  await balance(db, id, '2026-10-31', 9000);
  await txn(db, id, '2026-05-03', -1500, 'Owner draw');
  await txn(db, 'chk', '2026-05-05', 1500, 'Draw from business');
}

for (const owner of ['business', 'Business']) {
  test(`a checking account owned by "${owner}" is not personal spending or cash; its transfer in is income`, async t => {
    const db = await store(t);
    await household(db);
    await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
    await businessChecking(db);
    await db.prepare('UPDATE accounts SET owner = ? WHERE id = ?').run(owner, 'bchk');
    const r = await build(db);
    const rec = recOf(r, 'cushion');
    assert.equal(rec.state, 'suggested');
    assert.equal(figOf(r, rec, 'monthlySpend').v, 3005, 'business outflows are not personal spending');
    assert.equal(figOf(r, rec, 'current').v, 7000, 'business cash is not the cushion');
    assert.deepEqual([...rec.track.accounts].sort(), ['chk', 'sav']);
    assert.doesNotMatch(rec.trackLabel, /Studio/);
    assert.equal(rec.accept.target, 18100);
    assert.equal(figOf(r, rec, 'monthlySavings').v, 1250, 'the 1,500 transfer in over six months is income: 1,000 + 250');
  });
}

test('a checking account named in the accounts.businessEntity owner fact is not personal spending or cash', async t => {
  const db = await store(t);
  await household(db);
  await putGoal(db, 'cushion', { title: 'A cash cushion', horizon: '1-3y' });
  await businessChecking(db, 'echk');
  await db.prepare("INSERT INTO facts (key, value, src, confirmed, updated_at) VALUES ('accounts.businessEntity', ?, 'owner', 1, ?)")
    .run(JSON.stringify({ echk: 'Some LLC' }), CLOCK);
  const r = await build(db);
  const rec = recOf(r, 'cushion');
  assert.equal(rec.state, 'suggested');
  assert.equal(figOf(r, rec, 'monthlySpend').v, 3005);
  assert.equal(figOf(r, rec, 'current').v, 7000);
  assert.deepEqual([...rec.track.accounts].sort(), ['chk', 'sav']);
  assert.doesNotMatch(rec.trackLabel, /Studio/);
  assert.equal(figOf(r, rec, 'monthlySavings').v, 1250);
});
