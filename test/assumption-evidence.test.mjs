// C3 owner assumptions: assumptionStated normalizes the owner's words by unit (percent words to
// ratios, money magnitudes to cents, whole or half ages and years), and checkAssumption refuses an
// owner value the owner's statements do not hold. ctx.ownerStatements is C2's; it is stubbed here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { statedValues, assumptionStated, checkAssumption } from '../src/tools/assumption-evidence.mjs';
import { tempDb } from './helpers/server.mjs';

const Q02 = 'What investment balance would cover that at a 4 percent withdrawal rate?';
const Q25 = 'If returns are 3 percent instead of 4, when would we reach the target?';
const Q26 = 'What target do we need at a 3.5 percent withdrawal rate?';
const Q27 = 'If we saved $1,000 more a month, how much sooner would we reach the target?';
const Q28 = 'What is $15 million in retirement accounts worth after tax compared with $15 million in a brokerage account?';

let t;
before(async () => {
  t = await tempDb();
  await seedDemo(t.db);
});
after(() => t && t.close());

const ask = statements => ({ db: t.db, now: new Date('2026-11-05T15:00:00Z'), ownerStatements: () => statements });
const owner = (value, evidence) => ({ value, source: 'owner', evidence });

test('the questions\' wording states the owner\'s rates and amounts', () => {
  assert.equal(assumptionStated(0.04, 'ratio', [Q02]), true, 'Q02 accepts withdrawalRate 0.04');
  assert.equal(assumptionStated(0.05, 'ratio', [Q02]), false, 'Q02 refuses 0.05');
  assert.equal(assumptionStated(0.03, 'ratio', [Q25]), true, 'Q25 accepts realReturn 0.03');
  assert.equal(assumptionStated(0.035, 'ratio', [Q26]), true, 'Q26 accepts 0.035');
  assert.equal(assumptionStated(3.5, 'ratio', [Q26]), false, 'Q26 refuses 3.5');
  assert.equal(assumptionStated(1000, 'usd_per_month', [Q27]), true, 'Q27 accepts 1000 usd_per_month');
  assert.equal(assumptionStated(15000000, 'usd', [Q28]), true, 'Q28 accepts 15000000 usd');
  assert.equal(assumptionStated(15, 'usd', [Q28]), false, 'Q28 never reads the bare coefficient');
});

test('percent forms and bare decimals each map to the same ratio', () => {
  for (const text of ['4%', '4 %', '4 percent', '4 per cent', '4pct', '4 pct', '0.04', 'use .04']) {
    assert.equal(assumptionStated(0.04, 'ratio', [text]), true, text);
  }
  assert.equal(assumptionStated(0.04, 'ratio', ['4']), false, 'a bare whole number is not a rate');
  assert.equal(assumptionStated(0.04, 'ratio', ['40%']), false);
  assert.equal(assumptionStated(-0.01, 'ratio', ['a real return of minus 1 percent']), true);
  assert.equal(assumptionStated(-0.01, 'ratio', ['-1%']), true);
  assert.equal(assumptionStated(0.07 * 0.5, 'ratio', ['3.5%']), true, 'compared within 1e-9');
  assert.deepEqual(statedValues('between 3.5 percent and 0.04', 'ratio').map(v => Math.round(v * 1e9) / 1e9), [0.035, 0.04]);
});

test('money reads $, commas and magnitudes to the cent', () => {
  for (const [text, value] of [['$1,000.50', 1000.5], ['20k', 20000], ['20 thousand', 20000], ['$2m', 2000000], ['1.5 million', 1500000]]) {
    assert.equal(assumptionStated(value, 'usd', [text]), true, text);
    assert.equal(assumptionStated(value + 0.01, 'usd', [text]), false, `${text} plus a cent`);
  }
  assert.equal(assumptionStated(1000, 'usd_per_year', ['$1,000 a year']), true);
});

test('ages and years take a whole or half number', () => {
  assert.equal(assumptionStated(59.5, 'age', ['retire at 59 and a half']), true);
  assert.equal(assumptionStated(59.5, 'age', ['retire at 59.5']), true);
  assert.equal(assumptionStated(59, 'age', ['retire at 59 and a half']), false);
  assert.equal(assumptionStated(60, 'age', ['retire at 60']), true);
  assert.equal(assumptionStated(10, 'years', ['over 10 years']), true);
  assert.equal(assumptionStated(10.25, 'years', ['over 10.25 years']), false, 'only whole or half years');
});

test('in Ask an owner assumption must be stated in the owner\'s messages', async () => {
  const spec = { name: 'withdrawalRate', unit: 'ratio' };
  const accepted = await checkAssumption(owner(0.04, '4 percent withdrawal rate'), spec, ask([Q02]));
  assert.deepEqual(accepted, { name: 'withdrawalRate', value: 0.04, unit: 'ratio', source: 'owner', stated: '4%', evidence: '4 percent withdrawal rate' });
  await assert.rejects(async () => await checkAssumption(owner(0.05, '4 percent withdrawal rate'), spec, ask([Q02])), e => e.code === 'bad_input' && /withdrawalRate/.test(e.message));
  await assert.rejects(async () => await checkAssumption(owner(0.04, '4 percent withdrawal rate'), spec, ask(['What about 5 percent?'])),
    e => e.code === 'bad_input', 'evidence the owner never wrote is refused');
  assert.equal((await checkAssumption(owner(0.035, '3.5 percent'), spec, ask([Q26]))).value, 0.035);
  assert.equal((await checkAssumption(owner(1000, '$1,000 more a month'), { name: 'extraMonthlySavings', unit: 'usd_per_month' }, ask([Q27]))).stated, '$1,000 a month');
  assert.equal((await checkAssumption(owner(15000000, '$15 million in a brokerage account'), { name: 'value', unit: 'usd' }, ask([Q28]))).value, 15000000);
});

test('without ctx.ownerStatements an Ask context refuses owner assumptions', async () => {
  const ctx = { db: t.db, now: new Date('2026-11-05T15:00:00Z') };
  await assert.rejects(async () => await checkAssumption(owner(0.04, '4 percent'), { name: 'withdrawalRate', unit: 'ratio' }, ctx),
    e => e.code === 'bad_input' && /owner/.test(e.message));
});

test('over MCP the owner value is checked against its evidence alone and kept verbatim', async () => {
  const ctx = { db: t.db, channel: 'mcp' };
  const kept = await checkAssumption(owner(0.04, 'the owner said 4 percent'), { name: 'withdrawalRate', unit: 'ratio' }, ctx);
  assert.equal(kept.evidence, 'the owner said 4 percent');
  await assert.rejects(async () => await checkAssumption(owner(0.05, 'the owner said 4 percent'), { name: 'withdrawalRate', unit: 'ratio' }, ctx), e => e.code === 'bad_input');
});

test('owner without evidence, fact mismatches and non-default defaults are refused', async () => {
  const ctx = ask([Q02]);
  const spec = { name: 'withdrawalRate', unit: 'ratio', default: 0.04 };
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'owner' }, spec, ctx), e => e.code === 'bad_input' && /evidence/.test(e.message));
  assert.deepEqual(await checkAssumption({ value: 0.04, source: 'default' }, spec, ctx), { name: 'withdrawalRate', value: 0.04, unit: 'ratio', source: 'default', stated: '4%' });
  await assert.rejects(async () => await checkAssumption({ value: 0.05, source: 'default' }, spec, ctx), e => e.code === 'bad_input' && /default/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'default' }, { name: 'rate', unit: 'ratio' }, ctx), e => e.code === 'bad_input' && /default/.test(e.message));

  const agi = JSON.parse((await t.db.prepare("SELECT value FROM facts WHERE key = 'income.agiEstimate'").get()).value);
  const income = { name: 'income', unit: 'usd' };
  assert.equal((await checkAssumption({ value: agi, source: 'fact', factKey: 'income.agiEstimate' }, income, ctx)).value, agi);
  await assert.rejects(async () => await checkAssumption({ value: agi + 1, source: 'fact', factKey: 'income.agiEstimate' }, income, ctx), e => e.code === 'bad_input' && /income\.agiEstimate/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: agi, source: 'fact' }, income, ctx), e => e.code === 'bad_input' && /factKey/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: agi, source: 'fact', factKey: 'income.noSuchFact' }, income, ctx), e => e.code === 'bad_input');
});

test('a preference assumption needs an existing preference that states the value', async () => {
  await t.db.prepare("INSERT INTO preferences (id, text, actor_id, created_at, updated_at) VALUES ('pref_rate', 'Plan with a 3.5 percent withdrawal rate', 'user_test', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')").run();
  const ctx = ask([]);
  const spec = { name: 'withdrawalRate', unit: 'ratio' };
  assert.equal((await checkAssumption({ value: 0.035, source: 'preference', preferenceId: 'pref_rate' }, spec, ctx)).preferenceId, 'pref_rate');
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'preference', preferenceId: 'pref_rate' }, spec, ctx), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption({ value: 0.035, source: 'preference', preferenceId: 'pref_missing' }, spec, ctx), e => e.code === 'bad_input' && /preference/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: 0.035, source: 'preference' }, spec, ctx), e => e.code === 'bad_input' && /preferenceId/.test(e.message));
});

test('assumption shapes are validated: value finite, known source, bounds and note length', async () => {
  const ctx = ask([Q02]);
  const spec = { name: 'withdrawalRate', unit: 'ratio', min: 0.02, max: 0.06 };
  await assert.rejects(async () => await checkAssumption({ value: '0.04', source: 'owner', evidence: '4 percent' }, spec, ctx), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'guess' }, spec, ctx), e => e.code === 'bad_input' && /source/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'owner', evidence: '4 percent', extra: 1 }, spec, ctx), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption({ value: 0.04, source: 'owner', evidence: '4 percent', note: 'x'.repeat(201) }, spec, ctx), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption(owner(0.01, '1 percent'), spec, ask(['1 percent'])), e => e.code === 'bad_input' && /0\.02/.test(e.message));
  assert.equal((await checkAssumption({ value: 0.04, source: 'owner', evidence: '4 percent', note: 'their rule of thumb' }, spec, ctx)).note, 'their rule of thumb');
});

// Review round 1 regressions.
test('owner evidence never splits a number out of the owner\'s words', async () => {
  const spec = { name: 'withdrawalRate', unit: 'ratio' };
  await assert.rejects(async () => await checkAssumption(owner(0.04, '4 percent'), spec, ask(['Use 14 percent'])), e => e.code === 'bad_input');
  assert.equal((await checkAssumption(owner(0.14, '14 percent'), spec, ask(['Use 14 percent']))).value, 0.14);
  await assert.rejects(async () => await checkAssumption(owner(0.04, '0.04'), spec, ask(['A rate of 10.04 is fine'])), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption(owner(1000, '1,000'), { name: 'amount', unit: 'usd' }, ask(['Spend $21,000 a year'])), e => e.code === 'bad_input');
  assert.equal((await checkAssumption(owner(0.04, '4 percent withdrawal rate'), spec, ask([Q02]))).value, 0.04, 'an excerpt on word boundaries still counts');
});

test('a fact assumption needs a stored number, never a coerced boolean or list', async () => {
  const fact = t.db.prepare(`INSERT OR REPLACE INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                             VALUES (?, ?, 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`);
  await fact.run('test.flag', 'true');
  await fact.run('test.list', '[2]');
  await fact.run('test.text', '"12"');
  const ctx = ask([]);
  await assert.rejects(async () => await checkAssumption({ value: 1, source: 'fact', factKey: 'test.flag' }, { name: 'n', unit: 'usd' }, ctx), e => e.code === 'bad_input' && /test\.flag/.test(e.message));
  await assert.rejects(async () => await checkAssumption({ value: 2, source: 'fact', factKey: 'test.list' }, { name: 'n', unit: 'usd' }, ctx), e => e.code === 'bad_input');
  await assert.rejects(async () => await checkAssumption({ value: 12, source: 'fact', factKey: 'test.text' }, { name: 'n', unit: 'usd' }, ctx), e => e.code === 'bad_input');
});

test('money evidence keeps its sign', async () => {
  assert.equal(assumptionStated(-1000, 'usd', ['-$1,000']), true);
  assert.equal(assumptionStated(1000, 'usd', ['-$1,000']), false);
  assert.equal(assumptionStated(-1000, 'usd', ['minus $1,000']), true);
  assert.equal(assumptionStated(-1000, 'usd', ['$-1,000']), true);
  assert.equal(assumptionStated(1000, 'usd', ['$1,000-2,000']), true, 'a range dash is not a sign');
  assert.equal(assumptionStated(-2000, 'usd', ['$1,000-2,000']), false);
  const mcp = { db: t.db, channel: 'mcp' };
  const kept = await checkAssumption(owner(-1000, 'a -$1,000 adjustment'), { name: 'adjustment', unit: 'usd' }, mcp);
  assert.equal(kept.stated, '-$1,000');
  await assert.rejects(async () => await checkAssumption(owner(1000, 'a -$1,000 adjustment'), { name: 'adjustment', unit: 'usd' }, mcp), e => e.code === 'bad_input');
});
