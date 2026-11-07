// Regression tests for the ten code-review findings on the planner (F1..F10). Each test states the
// required outcome; expected amounts come from src/calc or from the synthetic inputs directly.

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { resolveTokens } from '../../src/shared/tokens.mjs';
import { sepRoom } from '../../src/calc/index.mjs';
import { recAction } from '../../src/api/handlers.mjs';
import {
  scratch, addFile, addPayroll, w2Doc, paystubDoc, addFact, accountIdByMask, contentValue, figureRow, recRow, plannerRec, activeRecIds,
  recEvents, SCORP, SOLE_PROP, MASKS, INST, OWNER_FACTS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch();
after(() => S.cleanup());

const plan = (db, now = NOW) => planRun(db, { now });
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);
const ctxOf = (db, params = {}, body = {}) => ({ db, config: { clock: NOW }, params, body });
const SP = r2(10 * (SOLE_PROP.income - SOLE_PROP.expenses.Supplies) * 12 / 10); // Bluebird projected net
const CONF = { planConfirmed: true, aggregationConfirmed: true };

// An extra aggregator export (outflow-positive amounts, like the real one).
const AGG_HEADER = ['Date', 'Account Type', 'Account Name', 'Account Number', 'Institution Name', 'Amount', 'Description', 'Category'];
function aggregatorFile(name, rows) {
  const text = [AGG_HEADER, ...rows].map(r => r.join(',')).join('\n') + '\n';
  return { name, mime: 'text/csv', bytes: new TextEncoder().encode(text) };
}

// Every string anywhere in a value.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return out;
}

const EVIL = '<img src=x onerror=alert(1)>';

function assertNoRawMarkup(db) {
  for (const r of db.prepare('SELECT id, def FROM recs').all()) {
    assert.ok(!r.def.includes('<img'), `stored def of ${r.id} carries raw markup`);
  }
  for (const m of db.prepare('SELECT conversation_key, text FROM messages').all()) {
    assert.ok(!m.text.includes('<img'), `message in ${m.conversation_key} carries raw markup`);
  }
  for (const rec of buildScenario(db, { clock: NOW }).recs) {
    assert.ok(!JSON.stringify(rec).includes('<img'), `scenario rec ${rec.id} carries raw markup`);
  }
}

describe('review fixes', () => {
  test('AC4: an unclassified P&L entity name with markup reaches missing-data prose only HTML-escaped (F1)', async () => {
    const evilEntity = { name: `Acme ${EVIL} Works`, type: null, owner: 'owner', income: 1000, expenses: { Supplies: 100 }, doc: false };
    const db = await S.store({ variant: { entities: [SCORP, SOLE_PROP, evilEntity] } });
    await plan(db);
    assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data asks how the entity is taxed');
    assertNoRawMarkup(db);
    assert.ok(JSON.stringify(recRow(db, 'missing-data').def).includes('&lt;img'), 'the name is still shown, escaped');
  });

  test('AC4: an imported account name with markup in a va529 task is HTML-escaped (F1)', async () => {
    const db = await S.store();
    const grand = '7777';
    await addFile(db, aggregatorFile('aggregator-grandparent.csv', [
      ['2026-05-10', '529', `Grandparent 529 ${EVIL}`, grand, INST.college, '-500.00', 'College plan deposit', 'Deposit'],
    ]), { answers: { hints: { [`${INST.college}|${grand}`]: { kind: '529', owner: null } } } });
    const college = accountIdByMask(db, MASKS.college);
    const other = accountIdByMask(db, grand);
    addFact(db, 'accounts.va529', {
      [college]: { virginiaPlan: true, carryforward: 0 },
      [other]: { virginiaPlan: true, carryforward: 0 },
    });
    await plan(db);
    assert.ok(activeRecIds(db).includes('va529'));
    assertNoRawMarkup(db);
    assert.ok(recRow(db, 'va529').def.tasks.some(t => t.t.includes('&lt;img')), 'the age-70 task names the account, escaped');
  });

  test('AC3: a second partnership with no K-1 blocks household tax figures and missing-data lists it (F2)', async () => {
    const partners = [
      { name: 'Alder Partners', type: 'partnership', owner: 'owner', income: 0, expenses: {} },
      { name: 'Birch Partners', type: 'partnership', owner: 'owner', income: 0, expenses: {} },
    ];
    // K-1s carry no partnership name in ingest's extraction shape (plan R6-0). Two genuinely
    // different synthetic K-1s, so ingest stores two documents (identical ones dedupe into one).
    const alderK1 = { docType: 'k1', fields: { taxYear: 2026, entityKind: 'partnership', ordinaryIncome: 30000, guaranteedPayments: 10000, selfEmploymentEarnings: 40000, distributions: 5000 } };
    const birchK1 = { docType: 'k1', fields: { taxYear: 2026, entityKind: 'partnership', ordinaryIncome: 12000, guaranteedPayments: 0, selfEmploymentEarnings: 12000, distributions: 2000 } };
    const k1Docs = db => db.prepare("SELECT count(*) AS n FROM documents WHERE doc_type = 'k1'").get().n;
    const db = await S.store({ variant: { entities: [SCORP, SOLE_PROP, ...partners], payroll: [alderK1] } });
    const result = await plan(db);
    assert.equal(figureRow(db, 'agi.est'), null, 'agi.est not produced');
    assert.equal(figureRow(db, 'tax.fed.proj'), null, 'tax.fed.proj not produced');
    assert.ok(activeRecIds(db).includes('missing-data'));
    const md = JSON.stringify(recRow(db, 'missing-data').def);
    assert.ok(result.warnings.includes('partnership_incomplete') || /K-1|partnership/i.test(md), 'missing-data names the incomplete partnership');
    // Two different K-1s for the two partnerships: both documents are stored, but a K-1 names no
    // partnership, so which statement belongs to which partnership is unknown. Plan R6-1 item 4.2:
    // any count other than one K-1 and one classified partnership blocks k1_unmatched, never a guess.
    const both = await S.store({ variant: { entities: [SCORP, SOLE_PROP, ...partners], payroll: [alderK1, birchK1] } });
    await plan(both);
    assert.equal(k1Docs(both), 2, 'ingest stores both K-1s');
    assert.equal(figureRow(both, 'agi.est'), null, 'two unnamed K-1s for two partnerships stay blocked');
    assert.ok(activeRecIds(both).includes('missing-data'));
    // liveness: one partnership with its one complete K-1 produces the figures
    const one = await S.store({ variant: { entities: [SCORP, SOLE_PROP, partners[0]], payroll: [alderK1] } });
    await plan(one);
    assert.equal(k1Docs(one), 1);
    assert.ok(figureRow(one, 'agi.est'), 'agi.est with the matching K-1');
  });

  test('AC3: W-2 wages from a classified S corp with no P&L count in agi.est (F3)', async () => {
    const corp = { name: 'Cedar Holdings', type: 's_corp', owner: 'owner', income: 0, expenses: {} };
    const wages = 40000;
    const without = await S.store({ variant: { entities: [SCORP, SOLE_PROP, corp] } });
    const withW2 = await S.store({ variant: { entities: [SCORP, SOLE_PROP, corp], payroll: [w2Doc({ employerName: 'Cedar Holdings', person: 'owner', relation: 'household', wages, medicareWages: wages })] } });
    await plan(without);
    await plan(withW2);
    const a = figureRow(without, 'agi.est');
    const b = figureRow(withW2, 'agi.est');
    assert.ok(a && b, 'both stores have agi.est');
    near(r2(b.v - a.v), wages, 'agi.est rises by the W-2 box 1 wages');
  });

  test('AC3: married filing separately blocks household tax figures with mfs_unsupported (F4)', async () => {
    const db = await S.store({ variant: { facts: { 'household.filingStatus': 'mfs' } } });
    await plan(db);
    for (const key of ['agi.est', 'tax.fed.proj', 'tax.fed.taxable', 'tax.va.proj', 'sh.fed.required', 'room.ira.household']) {
      assert.equal(figureRow(db, key), null, `${key} not produced for mfs`);
    }
    assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data fires');
    // a store that switches to mfs parks its tax recs with the reason
    const sw = await S.store();
    await plan(sw);
    addFact(sw, 'household.filingStatus', 'mfs');
    await plan(sw);
    const ev = recEvents(sw, 'fed-q4-estimate').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.arg], ['block', 'planner', 'mfs_unsupported']);
    assert.equal(recRow(sw, 'fed-q4-estimate').status, 'waiting');
    assert.ok(activeRecIds(sw).includes('missing-data'));
  });

  test('AC3: a Roth IRA contribution reduces the owner IRA room and the household room (F5)', async () => {
    const db = await S.store();
    const mask = '8888';
    const inst = 'Sample Brokerage';
    await addFile(db, aggregatorFile('aggregator-roth.csv', [
      ['2026-04-01', 'Roth IRA', 'Roth IRA', mask, inst, '-2000.00', 'IRA deposit', 'IRA contribution'],
    ]), { answers: { hints: { [`${inst}|${mask}`]: { name: 'Roth IRA', kind: 'roth', owner: 'owner' } } } });
    await plan(db);
    assert.equal(figureRow(db, 'room.ira.owner').v, 7500 - 2000);
    assert.equal(figureRow(db, 'room.ira.spouse').v, 7500, 'the spouse room is untouched');
    assert.equal(figureRow(db, 'room.ira.household').v, 15000 - 2000);
  });

  test('AC4: an IRA with no balance on file makes that person pro-rata unknown, never clear (F6)', async () => {
    const db = await S.store();
    const mask = '9999';
    const inst = 'Sample Brokerage';
    await addFile(db, aggregatorFile('aggregator-ira.csv', [
      ['2026-06-01', 'IRA', 'Traditional IRA', mask, inst, '25.00', 'Account fee', 'Fees'],
    ]), { answers: { hints: { [`${inst}|${mask}`]: { name: 'Traditional IRA', kind: 'retirement', owner: 'spouse' } } } });
    await plan(db);
    assert.ok(activeRecIds(db).includes('backdoor-roth'));
    const def = recRow(db, 'backdoor-roth').def;
    for (const s of strings(def)) assert.doesNotMatch(s, /spouse[^.]*\bcan convert without\b/i, 'the spouse is not stated clear');
    const confirmBalance = /\b(confirm|tell us|upload|add|enter)\b[^.]*\bbalance\b/i;
    assert.ok(def.tasks.some(t => confirmBalance.test(t.t)), 'a task asks to confirm the IRA balance');
    // liveness: with every IRA balance on file no such task appears
    const base = await S.store();
    await plan(base);
    assert.ok(!recRow(base, 'backdoor-roth').def.tasks.some(t => confirmBalance.test(t.t)));
  });

  test('AC3: SEP room for a sole proprietor with outside wages above the wage base passes those wages (F7)', async () => {
    const outside = 200000;
    const db = await S.store({ variant: { payroll: [w2Doc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', wages: outside, medicareWages: outside })] } });
    await plan(db);
    const expected = sepRoom({ kind: 'self-employed', netProfit: SP, filingStatus: 'mfj', w2SocialSecurityWages: outside, w2MedicareWages: outside, employerContributions: 0, ...CONF }).value;
    const naive = sepRoom({ kind: 'self-employed', netProfit: SP, filingStatus: 'mfj', employerContributions: 0, ...CONF }).value;
    assert.notEqual(expected, naive, 'the variant discriminates');
    near(figureRow(db, 'room.sep').v, expected, 'room.sep');
  });

  test('AC3: outside wages produce inc.ytd.w2 and inc.ytd.total sums every income figure (F8)', async () => {
    const entitySum = db => r2(db.prepare("SELECT key, v FROM figures WHERE key LIKE 'inc.ytd.%' AND key NOT IN ('inc.ytd.total', 'inc.ytd.w2')").all().reduce((a, r) => a + r.v, 0));
    const base = await S.store();
    await plan(base);
    const total = figureRow(base, 'inc.ytd.total');
    assert.ok(total, 'inc.ytd.total on the base set');
    assert.equal(total.kind, 'a');
    near(total.v, entitySum(base), 'base inc.ytd.total');
    near(total.v, 10 * (SCORP.income + SOLE_PROP.income), 'base total from the P&L');

    const db = await S.store({ variant: { payroll: [paystubDoc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', payDate: '2026-10-31', periodStart: '2026-10-16', periodEnd: '2026-10-31', ytdGross: 50000, retirementDeferral: 0, hsaDeferral: 0 })] } });
    await plan(db);
    const w2 = figureRow(db, 'inc.ytd.w2');
    assert.ok(w2, 'inc.ytd.w2');
    assert.equal(w2.kind, 'a');
    near(w2.v, 50000, 'inc.ytd.w2 is the year-to-date wages');
    const t = figureRow(db, 'inc.ytd.total');
    assert.equal(t.kind, 'a');
    near(t.v, r2(entitySum(db) + w2.v), 'inc.ytd.total');
  });

  test('AC4: a calculator that starts throwing parks its rec as waiting instead of retiring it, and recovers (F9)', async () => {
    const db = await S.store();
    await plan(db);
    recAction(ctxOf(db, { id: 'hsa-room' }, { action: 'start' }));
    addFact(db, 'household.birthYears', { owner: 1900 }); // age outside the calculator range
    await plan(db);
    const row = recRow(db, 'hsa-room');
    assert.equal(row.status, 'waiting');
    assert.equal(row.waiting_on, 'data');
    assert.equal(plannerRec(db, 'hsa-room').retired_at, null, 'not retired');
    const ev = recEvents(db, 'hsa-room').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['block', 'planner', 'doing', 'waiting']);
    addFact(db, 'household.birthYears', { owner: 1981 });
    await plan(db);
    assert.equal(recRow(db, 'hsa-room').status, 'doing', 'back to the prior status');
    assert.equal(recEvents(db, 'hsa-room').at(-1).action, 'unblock');
  });

  test('AC4: every token in every planner rec resolves, including va529 with no contributions this year (F10)', async () => {
    const check = db => {
      const scenario = buildScenario(db, { clock: NOW });
      const ids = new Set(db.prepare('SELECT rec_id FROM planner_recs').all().map(r => r.rec_id));
      const missing = [];
      for (const rec of scenario.recs.filter(r => ids.has(r.id))) {
        for (const s of strings(rec)) {
          const text = resolveTokens(scenario, s, false, { onMissing: m => missing.push(`${rec.id}: ${m}`) });
          assert.ok(!text.includes('[?'), `${rec.id} has an unresolved token in "${s}"`);
        }
      }
      assert.deepEqual(missing, []);
    };
    const base = await S.store();
    await plan(base);
    check(base);

    const db = await S.store();
    db.prepare('DELETE FROM transactions WHERE account_id = ?').run(accountIdByMask(db, MASKS.college));
    await plan(db);
    assert.ok(activeRecIds(db).includes('va529'), 'the eligible account still has deduction room');
    assert.equal(figureRow(db, 'va529.deductionLeft').v, 4000);
    check(db);
  });
});

describe('review fixes, round two', () => {
  test('AC3: a spouse W-2 from the household S corp adds exactly its box 1 wages to agi.est (G1)', async () => {
    const spouseWages = 30000;
    const base = await S.store();
    const withSpouse = await S.store({ variant: { payroll: [w2Doc({ employerName: SCORP.name, person: 'spouse', wages: spouseWages, medicareWages: spouseWages })] } });
    await plan(base);
    await plan(withSpouse);
    near(r2(figureRow(withSpouse, 'agi.est').v - figureRow(base, 'agi.est').v), spouseWages, 'agi.est rises by the spouse wages');
    // the owner's own-corp wages come from the P&L: an owner W-2 from the same corp is not added again
    const withOwner = await S.store({ variant: { payroll: [w2Doc({ employerName: SCORP.name, person: 'owner', wages: 12 * SCORP.expenses['Officer salary'], medicareWages: 12 * SCORP.expenses['Officer salary'] })] } });
    await plan(withOwner);
    near(figureRow(withOwner, 'agi.est').v, figureRow(base, 'agi.est').v, 'owner own-corp wages not double counted');
  });

  test('AC4: SEP room alone does not raise the year-end retirement rec (G2)', async () => {
    const db = await S.store({
      variant: {
        entities: [SOLE_PROP],
        payroll: [w2Doc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', wages: 50000, medicareWages: 74500, box12: [{ code: 'D', amount: 24500 }] })],
        facts: { 'business.salaryRange': undefined },
      },
    });
    await plan(db);
    assert.ok(figureRow(db, 'room.sep') && figureRow(db, 'room.sep').v > 0, 'the sole prop has SEP room');
    const employee = figureRow(db, 'room.solo401k.employee');
    assert.ok(!employee || employee.v === 0, 'no employee deferral room left');
    assert.ok(!activeRecIds(db).includes('year-end-retirement'), 'SEP has no year-end deadline');
    assert.equal(recRow(db, 'year-end-retirement'), null);
  });

  test('AC4: a solo 401(k) calculator failure parks year-end-retirement as waiting even with spouse SEP room (G2)', async () => {
    const db = await S.store();
    await plan(db);
    assert.ok(activeRecIds(db).includes('year-end-retirement'));
    assert.ok(figureRow(db, 'room.sep').v > 0, 'the spouse has SEP room');
    const before = recRow(db, 'year-end-retirement').def;
    addFact(db, 'household.birthYears', { owner: 1900 }); // age outside the calculator range
    await plan(db);
    const row = recRow(db, 'year-end-retirement');
    assert.equal(row.status, 'waiting');
    assert.equal(row.waiting_on, 'data');
    assert.deepEqual(row.def, before, 'def unchanged while blocked');
    assert.equal(plannerRec(db, 'year-end-retirement').retired_at, null);
    const ev = recEvents(db, 'year-end-retirement').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['block', 'planner', 'proposed', 'waiting']);
    addFact(db, 'household.birthYears', { owner: 1981 });
    await plan(db);
    assert.equal(recRow(db, 'year-end-retirement').status, 'proposed');
    assert.equal(recEvents(db, 'year-end-retirement').at(-1).action, 'unblock');
  });

  test('AC6: every salary war-game point stays inside an approved range that is not on thousands (G3)', async () => {
    const range = { min: 50400, max: 110400 };
    const db = await S.store({ variant: { facts: { 'business.salaryRange': range } } });
    await plan(db);
    const salary = contentValue(db, 'wargame').salary;
    assert.ok(salary && salary.points.length >= 2, 'salary war game built');
    const ids = salary.points.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'point ids distinct');
    const values = [];
    for (const p of salary.points) {
      const s = figureRow(db, `wg.salary.${p.id}.salary`);
      assert.ok(s, `wg.salary.${p.id}.salary`);
      assert.ok(s.v >= range.min && s.v <= range.max, `${p.id} salary ${s.v} inside the range`);
      values.push(s.v);
      const x = figureRow(db, `wg.salary.${p.id}.x`);
      const comp = x && x.locator && x.locator.inputs && x.locator.inputs.compensation;
      if (comp != null) assert.ok(comp >= range.min && comp <= range.max, `${p.id} x computed on ${comp} inside the range`);
    }
    assert.equal(new Set(values).size, values.length, 'salaries distinct');
  });
});

describe('review fixes, round three', () => {
  test('AC4: a Virginia itemized gap parks the salary and deferral recs as waiting and restores them (H1)', async () => {
    const db = await S.store();
    await plan(db);
    for (const id of ['scorp-salary', 'invoice-deferral']) assert.ok(activeRecIds(db).includes(id), `${id} fires first`);
    recAction(ctxOf(db, { id: 'scorp-salary' }, { action: 'start' }));
    const prior = { 'scorp-salary': 'doing', 'invoice-deferral': 'proposed' };

    addFact(db, 'tax.itemizedEstimate', 40000); // federal itemizes, Virginia estimate missing
    await plan(db);
    for (const id of Object.keys(prior)) {
      const row = recRow(db, id);
      assert.equal(row.status, 'waiting', `${id} waiting`);
      assert.equal(row.waiting_on, 'data', `${id} waits on data`);
      assert.equal(plannerRec(db, id).retired_at, null, `${id} not retired`);
      const ev = recEvents(db, id).at(-1);
      assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['block', 'planner', prior[id], 'waiting']);
    }

    addFact(db, 'tax.vaItemizedEstimate', 20000);
    await plan(db);
    for (const [id, status] of Object.entries(prior)) {
      assert.equal(recRow(db, id).status, status, `${id} back to ${status}`);
      const ev = recEvents(db, id).at(-1);
      assert.deepEqual([ev.action, ev.actor, ev.to_status], ['unblock', 'planner', status]);
    }
  });

  test('AC3: an owner-set pre-tax own-corp deferral lowers agi.est by its amount; a Roth one does not (H2)', async () => {
    const record = { person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000 };
    const base = await S.store();
    const pretax = await S.store({ variant: { facts: { 'retirement.contributions': [record] } } });
    const roth = await S.store({ variant: { facts: { 'retirement.contributions': [{ ...record, roth: true }] } } });
    await plan(base);
    await plan(pretax);
    await plan(roth);
    const agi = db => figureRow(db, 'agi.est').v;
    near(r2(agi(base) - agi(pretax)), 10000, 'pre-tax deferral comes out of wages');
    near(agi(roth), agi(base), 'a Roth deferral leaves agi.est unchanged');
  });

  test('AC6: an S corp with no officer salary still gets a salary war game inside the range with no current point (H3)', async () => {
    const noSalary = { ...SCORP, expenses: { Software: SCORP.expenses.Software } };
    const db = await S.store({ variant: { entities: [noSalary, SOLE_PROP] } });
    await plan(db);
    assert.ok(activeRecIds(db).includes('scorp-salary'), 'scorp-salary fires');
    const salary = contentValue(db, 'wargame').salary;
    assert.ok(salary && salary.points.length >= 2, 'salary war game built');
    assert.equal(salary.points.filter(p => p.current).length, 0, 'no current point at zero salary');
    const { min, max } = OWNER_FACTS['business.salaryRange'];
    for (const p of salary.points) {
      const s = figureRow(db, `wg.salary.${p.id}.salary`);
      assert.ok(s && s.v >= min && s.v <= max, `${p.id} salary inside the range`);
    }
  });
});

describe('review fixes, round four', () => {
  test('AC3: an own-corp deferral record does not reduce W-2 box 1 wages that already exclude it (I1)', async () => {
    const record = { person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000 };
    const agiPair = async variant => {
      const without = await S.store({ variant });
      const withRecord = await S.store({ variant: { ...variant, facts: { ...(variant.facts || {}), 'retirement.contributions': [record] } } });
      await plan(without);
      await plan(withRecord);
      const a = figureRow(without, 'agi.est');
      const b = figureRow(withRecord, 'agi.est');
      assert.ok(a && b, 'both stores have agi.est');
      return [a.v, b.v];
    };

    // A classified S corp with no P&L lines; its wages come only from the W-2.
    const cedar = 'Cedar Holdings';
    const [docOnly, docOnlyWithRecord] = await agiPair({
      entities: [SOLE_PROP, { name: cedar, type: 's_corp', owner: 'owner', income: 0, expenses: {} }],
      payroll: [w2Doc({ employerName: cedar, person: 'owner', relation: 'household', wages: 60000, medicareWages: 60000 })],
    });
    near(docOnlyWithRecord, docOnly, 'S corp without P&L: the record leaves agi.est unchanged');

    // The S corp has P&L lines but no officer salary; wages again come from the W-2.
    const [noSalary, noSalaryWithRecord] = await agiPair({
      entities: [{ ...SCORP, expenses: { Software: SCORP.expenses.Software } }, SOLE_PROP],
      payroll: [w2Doc({ employerName: SCORP.name, person: 'owner', wages: 60000, medicareWages: 60000 })],
    });
    near(noSalaryWithRecord, noSalary, 'S corp with zero P&L salary: the record leaves agi.est unchanged');
  });
});
