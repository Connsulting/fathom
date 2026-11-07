import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS } from '../../src/ingest/extract.mjs';
import { validateProposal, validateSourceRef, TARGET_SCHEMAS } from '../../src/ingest/model-contract.mjs';

const hash = 'a'.repeat(64);
const rawHash = 'b'.repeat(64);
const source = () => ({ fileId: 'f-synthetic', sha256: hash, refs: {
  r1: { fileId: 'f-synthetic', sha256: hash, sheet: { index: 0, nameRef: 's0' }, cell: 'B2', row: 2, column: 2,
    rawHash, valueType: 'number', precision: 'cent', formula: false, cached: false },
  t1: { fileId: 'f-synthetic', sha256: hash, page: 1, line: 2, byteStart: 5, byteEnd: 12,
    rawHash, valueType: 'text', precision: 'exact' },
  c1: { fileId: 'f-synthetic', sha256: hash, row: 2, column: 1, headerRef: 'header-0', rawHash, valueType: 'text', precision: 'exact' },
}, regions: ['region-0'] });
const field = (refs = ['r1'], transform = { op: 'identity' }) => ({ refs, transform });
const fieldsByTarget = {
  transaction: ['accountId', 'postedDate', 'amount', 'description'],
  balance: ['accountId', 'asOf', 'amount'],
  pnl: ['entity', 'period', 'category', 'amount', 'basis'],
  fact: ['value', 'asOf', 'subject'],
  tax_payment: ['jurisdiction', 'payer', 'recipient', 'amount', 'taxYear', 'taxYearBasis', 'paymentDate'],
  account_metadata: ['alias', 'institution', 'mask', 'kind', 'holder', 'accountId'],
  position: ['accountId', 'asOf', 'symbol', 'quantity', 'value'],
  document: ['taxYear', 'employerName', 'wages', 'medicareWages'],
  expected_transaction: ['subject', 'dueDate', 'statement', 'actor'],
};
const options = {
  balance: { basis: 'closing', datePrecision: 'day' },
  pnl: { purpose: 'business' }, fact: { key: 'household.dependents', scope: 'household', datePrecision: 'day' },
  tax_payment: { kind: 'estimate', status: 'paid', datePrecision: 'month' },
  document: { docType: 'w2' }, expected_transaction: { direction: 'inflow', status: 'expected', datePrecision: 'day' },
};
const row = target => ({ target, fields: Object.fromEntries(fieldsByTarget[target].map(k => [k, field()])), ...options[target] });
const proposal = (target = 'transaction') => ({ version: 1, fileId: 'f-synthetic', sha256: hash,
  proposalId: 'proposal-synthetic', interpreterVersion: '1', mappingId: null, mappingVersion: null,
  rows: [row(target)], coverage: [{ regionId: 'region-0', disposition: 'imported_detail', refs: ['r1'] }], completeness: 'complete' });

test('all typed targets accept cited fields and unknown expectation amounts stay null', () => {
  assert.deepEqual(Object.keys(TARGET_SCHEMAS).sort(), Object.keys(fieldsByTarget).sort());
  for (const target of Object.keys(fieldsByTarget)) {
    const p = proposal(target);
    if (target === 'expected_transaction') p.rows[0].fields.amount = null;
    assert.deepEqual(validateProposal(p, source()), { valid: true, errors: [] }, target);
  }
});

test('literal amounts, percentages, quantities, unknown fields and executable transforms refuse', () => {
  for (const value of [42, '42', { value: 42 }, { refs: ['r1'], transform: { op: 'eval', code: 'return 42' } }]) {
    const p = proposal(); p.rows[0].fields.amount = value;
    assert.equal(validateProposal(p, source()).valid, false);
  }
  for (const change of [p => p.rows[0].fields.quantity = 2, p => p.confidence = 1,
    p => p.rows[0].target = 'sql', p => p.rows[0].fields.amount.transform.extra = 'USD',
    p => p.rows[0].fields.amount.refs = ['invented'], p => p.sha256 = 'c'.repeat(64),
    p => p.version = 0, p => p.rows[0].fields.amount.refs = ['r1', 'r1']]) {
    const p = proposal(); change(p); assert.equal(validateProposal(p, source()).valid, false);
  }
});

test('source references bind exact file, hash, type, coordinates and text byte spans', () => {
  const s = source();
  for (const ref of Object.values(s.refs)) assert.equal(validateSourceRef(ref, s).valid, true);
  for (const key of ['fileId', 'sha256', 'rawHash', 'valueType', 'cell', 'row', 'column']) {
    const ref = structuredClone(s.refs.r1); ref[key] = typeof ref[key] === 'number' ? 99 : 'fabricated';
    assert.equal(validateSourceRef(ref, s).valid, false, key);
  }
  const p = proposal(); p.rows[0].fields.description = field(['t1']);
  assert.equal(validateProposal(p, s).valid, true);
  s.refs.t1.byteEnd = 4;
  assert.equal(validateProposal(p, s).valid, false);
});

test('uncached formulas and error or empty cells cannot support accepted fields', () => {
  for (const change of [r => { r.formula = true; r.cached = false; }, r => r.valueType = 'error', r => r.valueType = 'empty']) {
    const s = source(); change(s.refs.r1); assert.equal(validateProposal(proposal(), s).valid, false);
  }
  const s = source(); s.refs.r1.formula = true; s.refs.r1.cached = true;
  assert.equal(validateProposal(proposal(), s).valid, true);
});

test('allowlisted transforms require their declared parameters and operand arity', () => {
  for (const transform of [{ op: 'trim' }, { op: 'date_decode', locale: 'en-US', epoch: '1904' },
    { op: 'month_anchor', locale: 'iso', epoch: '1900' }, { op: 'currency_decode', currency: 'USD' },
    { op: 'sign', mode: 'negate' }, { op: 'sum' }]) {
    const p = proposal(); p.rows[0].fields.amount = field(['r1'], transform);
    assert.equal(validateProposal(p, source()).valid, true, transform.op);
  }
  for (const transform of [{ op: 'date_decode' }, { op: 'currency_decode', currency: 'EUR' }, { op: 'sign', mode: 'guess' }, { op: 'debit_credit' }]) {
    const p = proposal(); p.rows[0].fields.amount = field(['r1'], transform);
    assert.equal(validateProposal(p, source()).valid, false);
  }
  const p = proposal(); p.rows[0].fields.amount = field(['r1', 't1'], { op: 'debit_credit' });
  assert.equal(validateProposal(p, source()).valid, true);
});

test('coverage cannot claim complete while missing, duplicating or leaving a region unresolved', () => {
  for (const coverage of [[], [{ regionId: 'missing', disposition: 'imported_detail', refs: ['r1'] }],
    [{ regionId: 'region-0', disposition: 'unresolved', refs: ['r1'] }],
    [{ regionId: 'region-0', disposition: 'forecast', refs: ['r1'] }]]) {
    const p = proposal(); p.coverage = coverage; assert.equal(validateProposal(p, source()).valid, false);
  }
  const p = proposal(); p.coverage[0] = { regionId: 'region-0', disposition: 'forecast', refs: ['r1'], reason: field(['t1']) };
  assert.equal(validateProposal(p, source()).valid, true);
  p.coverage.push(p.coverage[0]); assert.equal(validateProposal(p, source()).valid, false);
  p.coverage = [{ regionId: 'region-0', disposition: 'unresolved', refs: ['r1'] }]; p.completeness = 'incomplete';
  assert.equal(validateProposal(p, source()).valid, true);
});

test('registered fact keys, document box fields and target enum rules are closed', () => {
  for (const [target, change] of [['fact', r => r.key = 'invented.fact'], ['document', r => r.fields.fakeBox = field()],
    ['balance', r => r.basis = 'month_end'], ['pnl', r => r.purpose = 'tax_wages'],
    ['tax_payment', r => r.datePrecision = 'guessed'], ['expected_transaction', r => r.status = 'paid']]) {
    const p = proposal(target); change(p.rows[0]); assert.equal(validateProposal(p, source()).valid, false, target);
  }
});


test('CSV ordinal references remain distinct under duplicate headers', () => {
  const s = source(); s.refs.c2 = { ...s.refs.c1, column: 2, headerRef: 'header-1' };
  assert.equal(validateSourceRef(s.refs.c2, s).valid, true);
  assert.equal(validateSourceRef({ ...s.refs.c2, column: 3 }, s).valid, false);
  const p = proposal(); p.rows[0].fields.description = field(['c2']);
  assert.equal(validateProposal(p, s).valid, true);
});


test('every existing document shape supports cited tax boxes and plan terms without numeric literals', () => {
  const cite = schema => schema.type === 'object' ? Object.fromEntries(Object.entries(schema.properties)
    .filter(([key]) => key !== 'confidence').map(([key, child]) => [key, cite(child)]))
    : schema.type === 'array' ? [cite(schema.items)] : field();
  for (const [docType, schema] of Object.entries(SCHEMAS).filter(([key]) => !['notes', 'other'].includes(key))) {
    const p = proposal('document'); p.rows[0] = { target: 'document', docType, fields: cite(schema) };
    assert.equal(validateProposal(p, source()).valid, true, docType);
    const key = Object.keys(p.rows[0].fields)[0]; p.rows[0].fields[key] = 2032;
    assert.equal(validateProposal(p, source()).valid, false, docType);
  }
});
