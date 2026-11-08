import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools/index.mjs';
import { scratch, householdOf, parseJson } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { householdTax } from '../src/jobs/planner/household.mjs';
import { computeFigures } from '../src/jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities } from '../src/jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../src/jobs/planner/facts.mjs';
import { TAX_2026, hsaLimit } from '../src/calc/index.mjs';
import { round } from '../src/calc/figure.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

const S = scratch('fathom-tools-tax-');
const clock = '2026-11-05';
let db, ctx;
before(async () => {
  db = await S.store();
  await planRun(db, { now: clock });
  ctx = { db, dataDir: householdOf(db).root, clock, channel: 'mcp' };
});
after(() => S.cleanup());
function compute() {
  const data = loadPlanningData(db, clock);
  const stored = Object.fromEntries(db.prepare('SELECT key,value,src,confirmed FROM facts').all().map(r => [r.key, { ...r, value: parseJson(r.value, null) }]));
  const entities = resolveEntities(data, Object.fromEntries(Object.entries(stored).map(([k,r]) => [k,r.value])));
  const merged = mergeFacts(stored, deriveFacts(data, { entities }));
  return computeFigures(data, merged.values, { clock, entities, owner: ownerFactsOf(stored) });
}

test('tax estimates preserve stored planner figures, dates, provenance and refs', async () => {
  const out = await callTool('tax', { operation: 'estimate' }, ctx);
  for (const [path,key] of [['federal.projected','tax.fed.proj'],['federal.selfEmployment','tax.fed.se'],['federal.paid','tax.fed.paid'],['state.projected','tax.va.proj'],['safeHarbor.federal.required','sh.fed.required']]) {
    const row = db.prepare('SELECT * FROM figures WHERE key=?').get(key);
    assert.ok(row, key);
    const f = path.split('.').reduce((v,k) => v[k], out);
    assert.equal(f.value, row.v, key);
    assert.equal(f.asOf, clock);
    assert.equal(f.token, `{f:${key}}`);
  }
  assert.equal(out.marginal.federal.unit, 'ratio');
  assert.equal(out.safeHarbor.nextDueDate.value, '2027-01-15');
  await assertRefsResolve(out, ctx);
  const wrongYear = await callTool('tax', { operation: 'estimate' }, { ...ctx, clock: '2028-11-05' });
  assert.equal(wrongYear.federal.projected.value, null);
  await assert.rejects(callTool('tax', { operation: 'estimate', year: 2025 }, ctx), e => e.code === 'bad_input');
});

test('business what-if equals two householdTax runs and retains owner assumptions', async () => {
  const base = compute().tax;
  assert.ok(base?.parts, 'planner exposes exact in-memory household tax inputs');
  const changed = structuredClone(base.parts);
  const biz = changed.biz.find(b => b.kind !== 'scorp' && b.seInput != null);
  assert.ok(biz);
  biz.agi += 20000; biz.qbi += 20000; biz.seInput += 20000;
  const a = householdTax(base.parts), b = householdTax(changed);
  const out = await callTool('tax', { operation: 'estimate', whatIf: { extraIncome: { value: 20000, source: 'owner', evidence: 'an extra $20,000 of business income' } } }, ctx);
  assert.equal(out.whatIf.federalDelta.value, round((b.fedTotal - b.seTotal) - (a.fedTotal - a.seTotal)));
  assert.equal(out.whatIf.selfEmploymentDelta.value, round(b.seTotal - a.seTotal));
  assert.equal(out.whatIf.stateDelta.value, round(b.va - a.va));
  assert.equal(out.whatIf.totalDelta.value, round(b.fedTotal - a.fedTotal + b.va - a.va));
  assert.equal(out.whatIf.totalDelta.provenance.assumptions[0].evidence, 'an extra $20,000 of business income');
  await assertRefsResolve(out, ctx);
});

test('what-if refuses unstated assumptions and unavailable tax inputs but accepts verified Ask evidence', async () => {
  const args = { operation: 'estimate', whatIf: { extraIncome: { value: 20000, source: 'owner', evidence: '$20,000' } } };
  await assert.rejects(callTool('tax', args, { ...ctx, channel: 'ask', ownerStatements: () => ['hello'] }), e => e.code === 'bad_input');
  assert.ok((await callTool('tax', args, { ...ctx, channel: 'ask', ownerStatements: () => ['What about $20,000 extra income?'] })).whatIf.totalDelta.value > 0);
  await assert.rejects(callTool('tax', { operation: 'estimate', whatIf: { extraIncome: 20000 } }, ctx), e => e.code === 'bad_input');
  await assert.rejects(callTool('tax', { operation: 'estimate', whatIf: { extraIncome: { value: 20000, source: 'default' } } }, ctx), e => e.code === 'bad_input');
});

test('room uses current-year stored figures and calculator limits without assuming payroll usage', async () => {
  const out = await callTool('tax', { operation: 'room' }, ctx);
  const hsa = out.rows.find(r => r.type === 'hsa');
  const hsaStored = db.prepare("SELECT * FROM figures WHERE key='room.hsa'").get();
  assert.equal(hsa.remaining.value, hsaStored.v);
  assert.equal(hsa.basis, 'planner');
  assert.equal(hsa.limit.value, hsaLimit(JSON.parse(hsaStored.locator).inputs).value.limit);
  const ira = out.rows.find(r => r.type === 'traditional_ira' && r.person === 'owner');
  assert.equal(ira.remaining.value, db.prepare("SELECT v FROM figures WHERE key='room.ira.owner'").get().v);
  const stale = await callTool('tax', { operation: 'room', year: 2026, types: ['employee_deferral'] }, { ...ctx, clock: '2028-11-05' });
  assert.equal(stale.rows[0].limit.value, TAX_2026.retirement.employeeDeferral);
  assert.equal(stale.rows[0].used, null);
  assert.equal(stale.rows[0].remaining, null);
  assert.ok(stale.gaps.some(g => g.code === 'outside_household_ledger'));
  await assertRefsResolve(out, ctx);
  const only = await callTool('tax', { operation: 'room', person: 'spouse', types: ['traditional_ira'] }, ctx);
  assert.equal(only.rows.length, 1);
  assert.equal(only.rows[0].person, 'spouse');
  assert.ok(out.rows.every(r => r.deadline.unit === 'date' && r.packRefs.length));
});

test('wage, other ordinary income and itemized deduction what-ifs use householdTax lines', async () => {
  const parts = compute().tax.parts;
  for (const [incomeType,field,amount] of [['wages','extraIncome',1300],['other','extraIncome',1300],['other','extraDeduction',65000]]) {
    const changed = structuredClone(parts);
    if (field === 'extraDeduction') changed.itemized += amount;
    else if (incomeType === 'other') changed.otherIncome = amount;
    else {
      assert.equal(changed.w2.length, 1);
      changed.w2[0].agi += amount; changed.w2[0].gross += amount;
      if (changed.w2[0].comp != null) changed.w2[0].comp += amount;
    }
    const a = householdTax(parts), b = householdTax(changed);
    const out = await callTool('tax', { operation: 'estimate', whatIf: { incomeType, [field]: { value: amount, source: 'owner', evidence: `$${amount}` } } }, ctx);
    assert.equal(out.whatIf.totalDelta.value, round(b.fedTotal-a.fedTotal+b.va-a.va), `${incomeType} ${field}`);
  }
});

test('room does not assign one persons HSA or solo room to the other person', async () => {
  const key = 'room.hsa';
  const original = db.prepare('SELECT locator FROM figures WHERE key=?').get(key).locator;
  try {
    const locator = JSON.parse(original); locator.person = 'spouse';
    db.prepare('UPDATE figures SET locator=? WHERE key=?').run(JSON.stringify(locator),key);
    const both = await callTool('tax', { operation: 'room', types: ['hsa'] }, ctx);
    assert.equal(both.rows.length, 1);
    assert.equal(both.rows[0].person, 'spouse');
    assert.equal(both.rows[0].basis, 'planner');
    const owner = await callTool('tax', { operation: 'room', person: 'owner', types: ['hsa'] }, ctx);
    assert.equal(owner.rows[0].remaining, null);
    assert.equal(owner.rows[0].used, null);
  } finally { db.prepare('UPDATE figures SET locator=? WHERE key=?').run(original,key); }
});

test('missing and withheld tax inputs stay unavailable, including what-if totals', async () => {
  const row = db.prepare("SELECT unavailable_reason FROM figures WHERE key='tax.fed.proj'").get();
  try {
    db.prepare("UPDATE figures SET unavailable_reason='missing_fact' WHERE key='tax.fed.proj'").run();
    const out = await callTool('tax', { operation: 'estimate' }, ctx);
    assert.equal(out.federal.projected.value, null);
    assert.equal(out.federal.remaining.value, null);
    assert.ok(out.gaps.some(g => g.code === 'missing_fact'));
  } finally { db.prepare("UPDATE figures SET unavailable_reason=? WHERE key='tax.fed.proj'").run(row.unavailable_reason); }
});
