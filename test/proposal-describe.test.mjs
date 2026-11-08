// Proposal descriptions (src/actions/describe.mjs): every write operation in the registry has a
// describer, and each describer names its action and targets by their stored display names, never
// an id, an enum code or an argument name. All household values here are synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalStore } from '../evals/harness.mjs';
import { tools } from '../src/tools/index.mjs';
import '../src/actions/proposals.mjs';
import { DESCRIBERS, describeProposal, withDescriptions } from '../src/actions/describe.mjs';

const now = '2026-11-07T12:00:00.000Z';
const REC = 'px1-dependent-care';
const GOAL = 'px1-cushion';
const ACCOUNT = 'px1-everyday';
const RECEIPT = 'px1-receipt-1';
const PREF = 'px1-pref-1';

async function store(t) {
  const s = await createEvalStore();
  t.after(() => s.close());
  const { db } = s;
  db.prepare('INSERT INTO recs (id, def, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(REC, JSON.stringify({ id: REC, title: 'Enroll in a dependent care FSA for next year', tasks: [{ t: 'Find the enrollment form' }] }), 'proposed', now);
  db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)")
    .run(GOAL, JSON.stringify({ id: GOAL, title: 'Rainy day cushion', horizon: 'now', target: 9000, track: null }), now);
  db.prepare("INSERT INTO accounts (id, inst, name, kind, parser) VALUES (?, 'Synthetic Credit Union', 'Everyday checking', 'checking', 'test')").run(ACCOUNT);
  const tx = db.prepare("INSERT INTO transactions (account_id, date, amount, description, category, parser) VALUES (?, '2026-10-14', -42.5, 'Corner Bakery Cafe', 'Uncategorized', 'test')").run(ACCOUNT);
  const item = db.prepare(`INSERT INTO confirm_items (kind, subject, question, options, context, status, created_at)
    VALUES ('account_owner', ?, 'Whose account is the Everyday checking account?', ?, '{}', 'pending', ?)`)
    .run(ACCOUNT, JSON.stringify([{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'joint', label: 'Joint' }]), now);
  db.prepare('INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(PREF, 'Keep travel spending modest', 'demo', now, now);
  db.prepare(`INSERT INTO action_receipts (id, scope, kind, entity_id, actor_id, label, before_state, after_state, before_value, after_value, created_at)
    VALUES (?, 'write:recs', 'status', ?, 'demo', 'Status', '{}', '{}', '{}', '{}', ?)`).run(RECEIPT, REC, now);
  return { db, transactionId: Number(tx.lastInsertRowid), confirmId: Number(item.lastInsertRowid) };
}

// No raw id, enum code or "name:" argument line in a description or its details.
function plainOnly(out, codes) {
  const all = [out.text, ...out.details.flatMap(d => [d.label, d.value])].join(' | ');
  for (const code of [REC, GOAL, ACCOUNT, RECEIPT, PREF, ...codes]) assert.ok(!new RegExp(`\\b${code}\\b`).test(all), `no code ${code} in: ${all}`);
  assert.ok(!/\b[a-zA-Z]+:\s/.test(out.text), `no argument line in: ${out.text}`);
  assert.ok(!/\{|\}/.test(all.replace(/\{n:\w+\}/g, '')), `no braces in: ${all}`);
  return out;
}
const describe = (db, tool, operation, args, codes = []) => plainOnly(describeProposal(db, { tool, operation, args }), codes);

test('AC2 every write operation in the registry has a describer, and every describer is a registry write', () => {
  const writes = tools.filter(t => t.kind === 'write').flatMap(t => t.operations.map(o => `${t.name}.${o.name}`));
  assert.ok(writes.length > 20, 'the registry lists its write operations');
  const missing = writes.filter(k => !Object.hasOwn(DESCRIBERS, k));
  assert.deepEqual(missing, [], 'write operations without a describer');
  const extra = Object.keys(DESCRIBERS).filter(k => !writes.includes(k));
  assert.deepEqual(extra, [], 'describers for operations the registry does not have');
});

test('AC1 act_on_recommendation.status names the rec title and each status in the words the UI uses', async t => {
  const { db } = await store(t);
  const title = '"Enroll in a dependent care FSA for next year"';
  const cases = [
    [{ status: 'dismissed' }, `Set aside the recommendation ${title} as Not for us.`],
    [{ status: 'doing' }, `Mark the recommendation ${title} as Doing it.`],
    [{ status: 'done' }, `Mark the recommendation ${title} as Done.`],
    [{ status: 'snoozed', wake: 'after open enrollment' }, `Move the recommendation ${title} to Later until after open enrollment.`],
    [{ status: 'snoozed' }, `Move the recommendation ${title} to Later.`],
    [{ status: 'proposed' }, `Reopen the recommendation ${title} as New.`],
  ];
  for (const [args, text] of cases) {
    const out = describe(db, 'act_on_recommendation', 'status', { id: REC, ...args }, ['dismissed', 'doing', 'snoozed', 'proposed', 'status']);
    assert.equal(out.text, text);
    assert.deepEqual(out.details, []);
  }
});

test('AC1 update_goal create and edit read as goal changes in owner words', async t => {
  const { db } = await store(t);
  const created = describe(db, 'update_goal', 'create', { title: 'Summer camp fund', horizon: '1-3y', kind: 'balance', target: 2500, targetDate: '2027-06-01' }, ['1-3y', 'horizon', 'targetDate', 'kind']);
  assert.equal(created.text, 'Create the goal "Summer camp fund".');
  assert.deepEqual(created.details, [{ label: 'Timeframe', value: 'Next few years' }, { label: 'Kind', value: 'Reach a balance' },
    { label: 'Also sets', value: 'target amount and target date' }]);
  assert.ok(!/2500|2,500|2027/.test(JSON.stringify(created)), 'a model-supplied amount or date is not repeated');

  const edited = describe(db, 'update_goal', 'edit', { id: GOAL, title: 'Emergency cushion', horizon: '3-10y' }, ['3-10y', 'now']);
  assert.equal(edited.text, 'Update the goal "Rainy day cushion".');
  assert.deepEqual(edited.details, [{ label: 'New name', value: '"Emergency cushion" (was "Rainy day cushion")' },
    { label: 'Timeframe', value: 'Long range (was This year)' }]);
  assert.equal(describe(db, 'update_goal', 'edit', { id: GOAL, status: 'done' }, ['status']).text, 'Mark the goal "Rainy day cushion" as done.');
});

test('AC1 update_account.rename names the account by its label', async t => {
  const { db } = await store(t);
  assert.equal(describe(db, 'update_account', 'rename', { id: ACCOUNT, displayName: 'Household bills' }, ['displayName']).text,
    'Rename the account "Everyday checking" to "Household bills".');
  assert.equal(describe(db, 'update_account', 'rename', { id: ACCOUNT, displayName: null }).text, 'Clear the custom name on the account "Everyday checking".');
});

test('AC1 categorize names the transaction and date, or the merchant, and the category', async t => {
  const { db, transactionId } = await store(t);
  assert.equal(describe(db, 'categorize', 'transaction', { transactionId, category: 'dining' }, [String(transactionId)]).text,
    'Categorize the transaction "Corner Bakery Cafe" on Oct 14, 2026 as Dining.');
  assert.equal(describe(db, 'categorize', 'merchant_rule', { merchant: 'corner bakery cafe', category: 'dining' }).text,
    'Categorize every transaction from "Corner Bakery Cafe" as Dining, now and in future imports.');
});

test('AC1 answer names the fact and its value, or the Confirm question and the chosen option', async t => {
  const { db, confirmId } = await store(t);
  assert.equal(describe(db, 'answer', 'fact', { key: 'household.filingStatus', value: 'mfj', evidence: 'We file jointly.' }, ['mfj', 'household', 'filingStatus']).text,
    'Save "Filing status" as Married filing jointly.');
  assert.equal(describe(db, 'answer', 'fact', { key: 'income.sCorp', value: true, evidence: 'Yes, an S corp.' }, ['sCorp', 'true']).text,
    'Save "S corp income" as Yes.');
  assert.equal(describe(db, 'answer', 'confirm', { items: [{ id: confirmId, answer: 'joint' }] }, ['joint', 'account_owner']).text,
    'Answer "Whose account is the Everyday checking account?" with Joint.');
});

test('AC1 update_preferences and undo name the stored preference and the earlier change', async t => {
  const { db } = await store(t);
  assert.equal(describe(db, 'update_preferences', 'remember', { text: 'Prefer index funds', evidence: 'I prefer index funds.' }).text,
    'Remember the preference "Prefer index funds".');
  assert.equal(describe(db, 'update_preferences', 'remember', { id: PREF, text: 'Keep travel under control', evidence: 'x' }).text,
    'Change the preference "Keep travel spending modest" to "Keep travel under control".');
  assert.equal(describe(db, 'update_preferences', 'forget', { id: PREF }).text, 'Forget the preference "Keep travel spending modest".');
  assert.equal(describe(db, 'undo', 'undo', { id: RECEIPT }).text,
    'Undo your earlier change "Status" to "Enroll in a dependent care FSA for next year".');
});

test('model-supplied text cannot become a token', async t => {
  const { db } = await store(t);
  const out = describe(db, 'update_goal', 'create', { title: 'Fund {f:net_worth}' });
  assert.equal(out.text, 'Create the goal "Fund f:net_worth".');
});

test('a missing target, an unknown operation and a failing describer still read as plain language', async t => {
  const { db } = await store(t);
  assert.equal(describe(db, 'act_on_recommendation', 'status', { id: 'gone', status: 'dismissed' }, ['gone']).text,
    'Set aside this recommendation as Not for us.');
  const unknown = describeProposal(db, { tool: 'act_on_recommendation', operation: 'retired_op', args: { id: REC } });
  assert.equal(unknown.text, 'Make the change described above: "Enroll in a dependent care FSA for next year".');
  assert.equal(describeProposal(db, { tool: 'gone_tool', operation: 'x', args: {} }).text, 'Make the change described above.');
  // A stored proposal whose arguments no longer fit its describer falls back to the route label.
  const broken = describeProposal(db, { tool: 'answer', operation: 'confirm', args: { id: REC, items: 'not a list' } });
  assert.equal(broken.text, 'Confirm answers: "Enroll in a dependent care FSA for next year".');
});

test('AC1 withDescriptions fills a stored proposal that predates descriptions and keeps one that has it', async t => {
  const { db } = await store(t);
  const older = { id: 'm1', role: 'fathom', provenance: { pendingAction: { tool: 'act_on_recommendation', operation: 'status', args: { id: REC, status: 'dismissed' } } } };
  const newer = { id: 'm2', role: 'fathom', provenance: { pendingAction: { tool: 'act_on_recommendation', operation: 'status', args: { id: REC, status: 'done' }, description: 'Stored text.' } } };
  const [a, b] = withDescriptions(db, [older, newer]);
  assert.equal(a.provenance.pendingAction.description, 'Set aside the recommendation "Enroll in a dependent care FSA for next year" as Not for us.');
  assert.equal(b.provenance.pendingAction.description, 'Stored text.');
});
