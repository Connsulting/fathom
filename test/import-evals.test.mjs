import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateCases, manifestOf } from '../evals/imports/generate.mjs';
import { runEvaluation, scoreRows } from '../evals/imports/run.mjs';
import { readFileSync } from 'node:fs';

test('all 96 generated lifecycle cases have committed independent source and outcome oracles', () => {
  const cases = generateCases();
  assert.equal(cases.length, 96);
  assert.equal(cases.filter(c => c.variant === 'base').length, 24);
  assert.deepEqual([...new Set(cases.map(c => c.variant))].sort(), ['base', 'changed', 'overlap', 'repeat']);
  assert.deepEqual(manifestOf(cases), JSON.parse(readFileSync(new URL('../evals/imports/manifest.json', import.meta.url))));
  for (const c of cases) {
    assert.ok(c.oracle.outcome);
    assert.ok(c.oracle.source.refs.length);
    assert.ok(c.oracle.expected.length);
  }
});

test('row matching counts multiplicity, precision, identity, signs and citations exactly', () => {
  const a = { target: 'transaction', accountId: 'a', amount: -3, datePrecision: 'day', refs: ['s0:A2'], references: [{ rawHash: 'synthetic-hash', valueType: 'number', precision: 'exact' }] };
  assert.equal(scoreRows([a, a], [a]).f1, 2 / 3);
  for (const patch of [{ accountId: 'b' }, { amount: 3 }, { datePrecision: 'month' }, { refs: ['s0:A3'] }, { references: [{ rawHash: 'synthetic-hash', valueType: 'number', precision: 'cent' }] }, { references: [{ rawHash: 'different-hash', valueType: 'number', precision: 'exact' }] }]) {
    assert.equal(scoreRows([a], [{ ...a, ...patch }]).f1, 0);
  }
});

test('offline CLI runs all real API lifecycles and refuses unsafe injected results', () => {
  const result = spawnSync(process.execPath, ['evals/imports/run.mjs', '--offline'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cases.length, 96);
  assert.equal(report.passed, 96);
  assert.equal(report.f1, 1);
  assert.equal(report.safety.unsafeAccepted, 0);
  assert.equal(report.safety.lostDuplicates, 0);
  assert.equal(report.safety.unsupportedFigures, 0);
  assert.equal(report.safety.crossHouseholdWrites, 0);
  assert.ok(report.lifecycle.approvals > 0);
  assert.ok(report.lifecycle.retries > 0);
  assert.ok(report.lifecycle.undos > 0);
  assert.ok(report.lifecycle.foreignRefusals > 0);
  assert.ok(report.lifecycle.zeroCallRepeats > 0);
  assert.ok(report.lifecycle.changedApprovals > 0);
  const unsafe = spawnSync(process.execPath, ['evals/imports/run.mjs', '--offline', '--inject-unsafe', 'literal'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(unsafe.status, 1);
  assert.ok(JSON.parse(unsafe.stdout).failed > 0);
  assert.doesNotMatch(result.stdout, /Synthetic Studio|account-synthetic|payroll provider|prompt|rawHash/);
});

test('uncited cells, wrong accounts, wrong totals and cell instructions cannot silently pass the oracle', async () => {
  for (const injectUnsafe of ['reference', 'account', 'total', 'instruction', 'exclusion']) {
    const report = await runEvaluation({ offline: true, caseIds: [injectUnsafe === 'account' ? 'reordered_sheets-1' : 'pnl_ledgers_refunds-1'], injectUnsafe });
    assert.equal(report.ok, false, injectUnsafe);
    assert.equal(report.failed, 1, injectUnsafe);
    if (injectUnsafe === 'exclusion') assert.equal(report.f1, 0, 'exclusion roles participate in exact row matching');
    if (injectUnsafe === 'account') assert.ok(report.safety.unsafeAccepted > 0, 'a valid but wrongly bound posting must fail quality admission');
    else assert.equal(report.safety.unsafeAccepted, 0, injectUnsafe);
  }
});
