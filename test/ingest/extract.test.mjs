// AC5 (with plan revisions R1, R2, R6, R7, R8): PDFs and unknown text go through a classify call
// and a per-type schema extraction. Text reaches the model redacted, with money amounts swapped for
// opaque tokens that code resolves back. Schemas never ask for identifiers. Extracted values become
// rows only through deterministic code; the employer relationship is grounded or confirmed, never
// extracted; low-confidence facts wait for confirmation.

import { seedHistoricalRows, seedHistoricalDocument, historicalNorthwindRows } from '../helpers/historical-import.mjs';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import {
  fixture, textFile, northwindFile, paystubText, realStore, fakeEngine, recordingEngine, offEngine, all, one, count, items, NOW,
} from '../helpers/ingest.mjs';
import { textPdf, imagePdf, multiPagePdf, malformedPdf, partialTextPdf, inflateBombPdf } from '../helpers/pdf.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

let X;
let RD;
let P;
let F;
let C;
let D;
let B;
let compileSchema;
before(async () => {
  X = await src('src/ingest/extract.mjs');
  RD = await src('src/ingest/redact.mjs');
  P = await src('src/ingest/pipeline.mjs');
  F = await src('src/store/facts.mjs');
  C = await src('src/ingest/confirm.mjs');
  D = await src('src/ingest/dedupe.mjs');
  B = await src('src/scenario/build.mjs');
  ({ compileSchema } = await src('src/engine/schema.mjs'));
});

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

const paystubFile = (opts = {}, name) => textFile(name || `paystub-${opts.payDate || '2032-03-15'}-${(opts.employer || 'a').length}.txt`, paystubText(opts), 'text/plain');

const CLASSIFY_PAYSTUB = [{ docType: 'paystub', taxYear: 2032, confidence: 0.95 }];
const PAYSTUB = {
  payDate: '2032-03-15', periodStart: '2032-03-01', periodEnd: '2032-03-15', employerName: 'Example Employer LLC',
  gross: 5000, net: 3600, federalWithholding: 700, stateWithholding: 250, state: 'CO', socialSecurity: 310,
  medicare: 72.5, retirementDeferral: 0, hsaDeferral: 0, ytdGross: 30000, confidence: 0.95,
};
const W2 = {
  taxYear: 2031, employerName: 'Example Employer LLC', wages: 90000, federalWithheld: 12000, socialSecurityWages: 90000,
  medicareWages: 90000, state: 'CO', stateWages: 90000, stateWithheld: 3500, retirementPlan: true, box12: [{ code: 'D', amount: 6000 }], confidence: 0.92,
};
const STATEMENT = {
  institution: 'Example Bank', accountLast4: '4321', accountKind: 'brokerage', periodEnd: '2032-03-31', endingBalance: 1500.25,
  holdings: [{ symbol: 'EXMPL', name: 'Example Index Fund', quantity: 10, value: 1234.5 }], confidence: 0.9,
};
const PLAN = { planType: '401k', employerMatch: 'Generic match description', matchPercent: 100, matchLimitPercent: 4, employeeLimit: 23000, catchUpLimit: 7500, planYear: 2032, confidence: 0.9 };
const NOTES = {
  facts: [
    { key: 'household.dependents', value: '2', confidence: 0.95 },
    { key: 'household.state', value: 'CO', confidence: 0.6 },
    { key: 'income.agiEstimate', value: 'quite a lot', confidence: 0.9 },
  ],
  goals: [{ title: 'Build a cash reserve', when: '2033', confidence: 0.9 }],
};
// G6: a PDF pdfjs cannot open is withheld, so a statement PDF sent as a document is image-only.
const PDF_BYTES = imagePdf({ tag: 'synthetic statement for tests' });
const EMPLOYER_FACTS = ['income.w2', 'income.sCorp', 'benefits.employer401k', 'benefits.hsa'];

const ctx = { fileId: 'f-000000000000000000000001', households: { entities: [] } };
const facts = (rows) => Object.fromEntries(rows.filter((r) => r.kind === 'fact').map((r) => [r.key, r.value]));
const taxRows = (rows) => rows.filter((r) => r.kind === 'tax_payment');
const docRows = (rows) => rows.filter((r) => r.kind === 'document');
const paystubResponses = (extracted) => [CLASSIFY_PAYSTUB, [extracted]];

describe('redact', () => {
  test('masks SSN, EIN and long digit runs exactly', () => {
    assert.equal(RD.redact('SSN 123-45-6789, EIN 12-3456789, acct 000123456789'), 'SSN XXX-XX-XXXX, EIN XX-XXXXXXX, acct XXXXXXXX6789');
    assert.equal(RD.redact('ref 12345'), 'ref X2345');
  });

  test('keeps short runs, dates and amounts', () => {
    const text = 'Paid 1234.56 on 2032-03-15 for invoice 4711';
    assert.equal(RD.redact(text), text);
  });

  test('is idempotent', () => {
    const once = RD.redact('SSN 123-45-6789 EIN 12-3456789 card 4444333322221111 ok 42');
    assert.equal(RD.redact(once), once);
  });

  test('redactCells masks long strings and long integer parts, leaves small numbers alone', () => {
    assert.deepEqual(RD.redactCells(['acct 123456789', 1234567.89, 42, 'plain']), ['acct XXXXX6789', 'XXX4567.89', 42, 'plain']);
  });
});

describe('redactForExtraction (R2)', () => {
  const value = (ref) => Number(String(ref).replace(/[$,\s]/g, ''));

  test('the plan case: money becomes a token, identifiers are masked', () => {
    const out = RD.redactForExtraction('Gross pay $123456.78\nAccount 000123456789\nSSN 123-45-6789');
    for (const raw of ['123456', '000123456789', '123-45-6789']) assert.ok(!out.text.includes(raw), `${raw} not sent`);
    assert.ok(out.text.includes('#A1#'));
    assert.equal(value(out.refs['#A1#']), 123456.78);
    assert.ok(out.text.includes('XXX-XX-XXXX'));
    assert.ok(out.text.includes('XXXXXXXX6789'));
    assert.doesNotMatch(out.text, /\d{5,}/);
  });

  test('money-shaped forms with long runs are tokenized in order; short money and other runs are not', () => {
    const out = RD.redactForExtraction('A $123456.78 B $ 98765 C 1,234.56 D 12,345.67 E 98765.4 F EIN 12-3456789 G 4711');
    assert.deepEqual(Object.keys(out.refs).sort(), ['#A1#', '#A2#']);
    assert.equal(value(out.refs['#A1#']), 123456.78);
    assert.equal(value(out.refs['#A2#']), 98765);
    assert.ok(out.text.includes('1,234.56') && out.text.includes('12,345.67'), 'runs of 4 or fewer stay');
    assert.ok(out.text.includes('X8765.4'), 'a run without money shape is masked');
    assert.ok(out.text.includes('XX-XXXXXXX'));
    assert.ok(out.text.includes('G 4711'));
    assert.doesNotMatch(out.text, /\d{5,}/);
  });
});

describe('schemas', () => {
  const BANNED = (key) => {
    const k = key.toLowerCase();
    return k.endsWith('ssn') || k === 'ein' || k.endsWith('ein') || k === 'tin' || k.endsWith('tin') || k.includes('taxid')
      || k.includes('accountnumber') || k.includes('routing') || k.includes('address') || k.includes('socialsecuritynumber')
      || k === 'employerishouseholdbusiness'
      || ['firstname', 'lastname', 'fullname', 'employeename', 'personname', 'street', 'zip', 'postalcode'].includes(k);
  };

  function walk(schema, path, problems) {
    if (!schema || typeof schema !== 'object') return;
    if (Array.isArray(schema.type)) problems.push(`${path}: type array`);
    if (schema.type === 'null') problems.push(`${path}: null type`);
    if (schema.type === 'object') {
      if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties is not false`);
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        const payrollRecipient = key === 'employeeName' && ['w2', 'paystub'].includes(path);
        if (BANNED(key) && !payrollRecipient) problems.push(`${path}.${key}: banned property`);
        walk(sub, `${path}.${key}`, problems);
      }
    }
    if (schema.items) walk(schema.items, `${path}[]`, problems);
    for (const k of ['anyOf', 'oneOf', 'allOf']) (schema[k] || []).forEach((s, i) => walk(s, `${path}.${k}${i}`, problems));
  }

  test('DOC_TYPES is the frozen list and every type but other has a schema', () => {
    assert.deepEqual([...X.DOC_TYPES], ['paystub', 'w2', '1099-int', '1099-div', '1099-b', '1099-nec', '1099-misc', 'k1', 'form1040', 'statement', 'plan', 'notes', 'other']);
    for (const t of X.DOC_TYPES.filter((d) => d !== 'other')) assert.ok(X.SCHEMAS[t], `schema for ${t}`);
  });

  test('no schema asks for identifiers or the employer relationship; all are strict', () => {
    const problems = [];
    walk(X.CLASSIFY_SCHEMA, 'classify', problems);
    for (const [t, schema] of Object.entries(X.SCHEMAS)) {
      walk(schema, t, problems);
      const wrapped = { type: 'object', properties: { rows: { type: 'array', items: schema } }, required: ['rows'], additionalProperties: false };
      assert.doesNotThrow(() => compileSchema(wrapped), `${t} compiles under Ajv strict`);
    }
    assert.deepEqual(problems, []);
    assert.ok(X.SCHEMAS.paystub.properties.employerName, 'paystub extracts employerName');
    assert.ok(X.SCHEMAS.w2.properties.employerName, 'w2 extracts employerName');
    for (const type of ['w2', 'paystub']) assert.ok(X.SCHEMAS[type].properties.employeeName, 'payroll recipient names support household matching');
    for (const [type, schema] of Object.entries(X.SCHEMAS).filter(([type]) => !['w2', 'paystub'].includes(type))) {
      assert.equal(schema.properties?.employeeName, undefined, `${type} does not request a payroll recipient`);
    }
    assert.deepEqual([...X.CLASSIFY_SCHEMA.required].sort(), ['confidence', 'docType']);
    assert.deepEqual([...X.CLASSIFY_SCHEMA.properties.docType.enum], [...X.DOC_TYPES]);
  });

  test('scripted responses satisfy the schemas; amount fields accept a token, not free text', () => {
    const check = (schema, v) => compileSchema(schema)(v);
    assert.ok(check(X.CLASSIFY_SCHEMA, CLASSIFY_PAYSTUB[0]));
    assert.ok(check(X.SCHEMAS.paystub, PAYSTUB));
    assert.ok(check(X.SCHEMAS.paystub, { ...PAYSTUB, gross: '#A1#' }));
    assert.ok(!check(X.SCHEMAS.paystub, { ...PAYSTUB, gross: '123456.78' }));
    assert.ok(!check(X.SCHEMAS.paystub, { ...PAYSTUB, employerIsHouseholdBusiness: true }));
    assert.ok(check(X.SCHEMAS.w2, W2));
    assert.ok(check(X.SCHEMAS.statement, STATEMENT));
    assert.ok(check(X.SCHEMAS.plan, PLAN));
    assert.ok(check(X.SCHEMAS.notes, NOTES));
    assert.ok(!check(X.SCHEMAS.statement, { ...STATEMENT, accountLast4: '123456' }), 'accountLast4 is four digits');
  });
});

describe('toRows', () => {
  test('paystub: document and withholding rows with a grounded, unique payer', () => {
    const rows = X.toRows('paystub', PAYSTUB, ctx);
    assert.ok(Array.isArray(rows));
    assert.deepEqual(docRows(rows).map((r) => r.docType), ['paystub']);
    const tax = taxRows(rows).sort((a, b) => a.amount - b.amount);
    assert.deepEqual(tax.map((r) => [r.jurisdiction, r.amount, r.paymentKind, r.date, r.datePrecision, r.taxYear, r.sheetYear]), [
      ['CO', 250, 'withholding', '2032-03-15', 'day', 2032, 2032],
      ['federal', 700, 'withholding', '2032-03-15', 'day', 2032, 2032],
    ]);
    // R10: paystub:<employerKey>:<payDate>:<gross cents>
    for (const r of tax) assert.match(r.payer, /^paystub:[0-9a-f]{12}:2032-03-15:500000$/);
  });

  test('R1: two paydays in a month, one month in two years and two employers on a date never collide', () => {
    const fed = (extracted) => taxRows(X.toRows('paystub', extracted, ctx)).find((r) => r.jurisdiction === 'federal');
    const variants = [
      PAYSTUB,
      { ...PAYSTUB, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31' },
      { ...PAYSTUB, payDate: '2031-03-15', periodStart: '2031-03-01', periodEnd: '2031-03-15' },
      { ...PAYSTUB, employerName: 'Other Example Company' },
    ];
    const rows = variants.map(fed);
    assert.deepEqual(rows.map((r) => r.sheetYear), [2032, 2032, 2031, 2032]);
    assert.equal(new Set(rows.map((r) => D.dedupeKey(r))).size, 4);
    assert.notEqual(rows[0].payer, rows[3].payer, 'employers differ in the payer');
  });

  test('w2: year-end withholding rows with a w2 payer', () => {
    const rows = X.toRows('w2', W2, ctx);
    const tax = taxRows(rows).sort((a, b) => a.amount - b.amount);
    assert.deepEqual(tax.map((r) => [r.jurisdiction, r.amount, r.date, r.datePrecision, r.paymentKind, r.sheetYear]), [
      ['CO', 3500, '2031-12-31', 'year', 'withholding', 2031],
      ['federal', 12000, '2031-12-31', 'year', 'withholding', 2031],
    ]);
    // R10: w2:<employerKey>:<taxYear>:<wages cents>
    for (const r of tax) assert.match(r.payer, /^w2:[0-9a-f]{12}:2031:9000000$/);
    assert.deepEqual(docRows(rows).map((r) => [r.docType, r.taxYear]), [['w2', 2031]]);
  });

  test('R10: two W-2s from one employer with different wages stay distinct', () => {
    const a = taxRows(X.toRows('w2', W2, ctx));
    const b = taxRows(X.toRows('w2', { ...W2, wages: 45000, socialSecurityWages: 45000, medicareWages: 45000, stateWages: 45000 }, ctx));
    const fedA = a.find((r) => r.jurisdiction === 'federal');
    const fedB = b.find((r) => r.jurisdiction === 'federal');
    assert.equal(fedA.payer.split(':')[1], fedB.payer.split(':')[1], 'same employer key');
    assert.match(fedB.payer, /^w2:[0-9a-f]{12}:2031:4500000$/);
    assert.notEqual(D.dedupeKey(fedA), D.dedupeKey(fedB));
    assert.equal(D.dedupeKey(fedA), D.dedupeKey(taxRows(X.toRows('w2', W2, ctx)).find((r) => r.jurisdiction === 'federal')), 'a rescan keeps its key');
  });

  test('R10: two 1099-INT from one payer with different interest stay distinct', () => {
    const base = { taxYear: 2031, payerKind: 'bank', payerName: 'Example Savings', interest: 210, earlyWithdrawalPenalty: 0, federalWithheld: 30, confidence: 0.9 };
    const a = taxRows(X.toRows('1099-int', base, ctx))[0];
    const b = taxRows(X.toRows('1099-int', { ...base, interest: 95.5 }, ctx))[0];
    assert.match(a.payer, /^1099-int:[0-9a-f]{12}:2031:21000$/);
    assert.match(b.payer, /^1099-int:[0-9a-f]{12}:2031:9550$/);
    assert.notEqual(D.dedupeKey(a), D.dedupeKey(b));
  });

  test('1099-nec, k1 and 1099 withholding', () => {
    assert.deepEqual(facts(X.toRows('1099-nec', { taxYear: 2031, payerKind: 'business', payerName: 'Example Client Co', nonemployeeCompensation: 12000, federalWithheld: 0, confidence: 0.9 }, ctx)), { 'income.selfEmployed': true });
    assert.deepEqual(facts(X.toRows('k1', { taxYear: 2031, entityKind: 'partnership', ordinaryIncome: 5000, guaranteedPayments: 0, selfEmploymentEarnings: 5000, distributions: 1000, confidence: 0.9 }, ctx)), { 'income.partnership': true });
    assert.deepEqual(facts(X.toRows('k1', { taxYear: 2031, entityKind: 's_corp', ordinaryIncome: 5000, guaranteedPayments: 0, selfEmploymentEarnings: 0, distributions: 1000, confidence: 0.9 }, ctx)), { 'income.sCorp': true });
    const int = taxRows(X.toRows('1099-int', { taxYear: 2031, payerKind: 'bank', payerName: 'Example Savings', interest: 210, earlyWithdrawalPenalty: 0, federalWithheld: 30, confidence: 0.9 }, ctx));
    assert.deepEqual(int.map((r) => [r.jurisdiction, r.amount, r.date, r.paymentKind, r.sheetYear]), [['federal', 30, '2031-12-31', 'withholding', 2031]]);
    assert.match(int[0].payer, /^1099-int:[0-9a-f]{12}:2031:21000$/);
  });

  test('form1040: household facts and an AGI estimate', () => {
    const rows = X.toRows('form1040', { taxYear: 2031, filingStatus: 'mfj', dependents: 2, state: 'CO', agi: 150000, taxableIncome: 120000, totalTax: 20000, payments: 21000, confidence: 0.9 }, ctx);
    assert.deepEqual(facts(rows), { 'household.filingStatus': 'mfj', 'household.dependents': 2, 'household.state': 'CO', 'income.agiEstimate': 150000 });
  });

  test('statement: a balance and positions priced from value over quantity', () => {
    const rows = X.toRows('statement', STATEMENT, ctx);
    const bal = rows.filter((r) => r.kind === 'balance');
    assert.equal(bal.length, 1);
    assert.deepEqual([bal[0].date, bal[0].amount, bal[0].account.mask, bal[0].account.inst], ['2032-03-31', 1500.25, '4321', 'Example Bank']);
    const pos = rows.filter((r) => r.kind === 'position');
    assert.deepEqual(pos.map((p) => [p.symbol, p.asOf, p.quantity, p.value, p.price]), [['EXMPL', '2032-03-31', 10, 1234.5, 123.45]]);
  });

  test('plan: document type plan and benefit facts by plan type', () => {
    const k = X.toRows('plan', PLAN, ctx);
    assert.deepEqual(docRows(k).map((r) => r.docType), ['plan']);
    assert.deepEqual(facts(k), { 'benefits.employer401k': true });
    assert.deepEqual(facts(X.toRows('plan', { ...PLAN, planType: 'hsa' }, ctx)), { 'benefits.hsa': true });
    assert.deepEqual(facts(X.toRows('plan', { ...PLAN, planType: 'other' }, ctx)), {});
  });

  test('notes: typed facts, invalid values dropped, goals as documents', () => {
    const rows = X.toRows('notes', NOTES, ctx);
    assert.deepEqual(facts(rows), { 'household.dependents': 2, 'household.state': 'CO' });
    const byKey = Object.fromEntries(rows.filter((r) => r.kind === 'fact').map((r) => [r.key, r.confidence]));
    assert.deepEqual(byKey, { 'household.dependents': 0.95, 'household.state': 0.6 });
    const goals = docRows(rows).filter((r) => r.docType === 'goal');
    assert.deepEqual(goals.map((g) => g.fields), [{ title: 'Build a cash reserve', when: '2033', confidence: 0.9 }]);
  });
});

describe('historical document rows', () => {


  test('R1: four paystubs store eight distinct withholding rows', async () => withStore(async (s) => {
    const cases = [
      [{ payDate: '2032-03-15' }, PAYSTUB],
      [{ payDate: '2032-03-31' }, { ...PAYSTUB, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31' }],
      [{ payDate: '2031-03-15' }, { ...PAYSTUB, payDate: '2031-03-15', periodStart: '2031-03-01', periodEnd: '2031-03-15' }],
      [{ payDate: '2032-03-15', employer: 'Other Example Company' }, { ...PAYSTUB, employerName: 'Other Example Company' }],
    ];
    for (const [text, extracted] of cases) {
      const r = await seedHistoricalDocument(s, paystubFile(text), paystubResponses(extracted));
      assert.equal(r.status, 'imported');
      assert.equal(r.counts.duplicates, 0);
      assert.equal((r.counts.rows || {}).tax_payment, 2);
    }
    const tax = await all(s.db, 'SELECT * FROM tax_payments');
    assert.equal(tax.length, 8);
    assert.ok(tax.every((t) => t.kind === 'withholding' && t.payer.startsWith('paystub:')));
    // R15 with D4: wh:<employerKey>:<taxYear>:<jurisdiction>:<recipient>, with the payer's employer
    // key; the recipient is unknown until the employer_recipient question is answered.
    for (const t of tax) {
      assert.match(t.source_slot, /^wh:[0-9a-f]{12}:(2031|2032):(federal|co):unknown$/i);
      assert.equal(t.source_slot.split(':')[1], t.payer.split(':')[1]);
      assert.equal(t.source_slot.split(':')[2], String(t.tax_year));
      // G4: while the recipient is unknown the payer identity carries the document.
      assert.ok(t.payer.endsWith(`:doc:${t.file_id}`), t.payer);
    }
    assert.equal(new Set(tax.map((t) => t.dedupe_key)).size, 8);
    assert.deepEqual(tax.filter((t) => t.jurisdiction === 'federal').map((t) => t.tax_year).sort(), [2031, 2032, 2032, 2032]);
  }));

  test('R6: an unknown employer queues employer_relation and holds the employer facts', async () => withStore(async (s) => {
    const extracted = { ...PAYSTUB, retirementDeferral: 400, hsaDeferral: 100 };
    const r = await seedHistoricalDocument(s, paystubFile(), paystubResponses(extracted));
    assert.equal(r.status, 'imported');
    assert.equal(r.sourceKind, 'paystub');
    const q = await items(s.db, 'employer_relation');
    assert.equal(q.length, 1);
    assert.match(q[0].subject, /^[0-9a-f]{12}$/);
    assert.deepEqual(JSON.parse(q[0].options), [{ id: 'outside', label: 'An outside employer' }, { id: 'household', label: 'Our own business' }]);
    for (const k of EMPLOYER_FACTS) assert.ok(!(k in F.getFacts(s.db)), `${k} not written before the answer`);
    const tax = await all(s.db, 'SELECT * FROM tax_payments ORDER BY amount');
    assert.deepEqual(tax.map((t) => [t.jurisdiction, t.amount, t.kind, t.date, t.date_precision, t.tax_year]), [
      ['CO', 250, 'withholding', '2032-03-15', 'day', 2032],
      ['federal', 700, 'withholding', '2032-03-15', 'day', 2032],
    ]);

    C.answer(s.db, q[0].id, 'outside', { now: NOW });
    const after = F.getFacts(s.db);
    assert.equal(after['income.w2'], true);
    assert.equal(after['benefits.employer401k'], true);
    assert.equal(after['benefits.hsa'], true);
    assert.ok(!('income.sCorp' in after));

    const next = await seedHistoricalDocument(s, paystubFile({ payDate: '2032-03-31' }), paystubResponses({ ...extracted, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31' }));
    assert.equal(next.status, 'imported');
    assert.equal((await items(s.db, 'employer_relation')).length, 1, 'the same employer asks nothing new');
    assert.equal(C.pendingItems(s.db).filter((i) => i.kind === 'employer_relation').length, 0);
    assert.equal(F.getFacts(s.db)['income.w2'], true);
  }));

  test('R6: answering household writes income.sCorp, not income.w2', async () => withStore(async (s) => {
    await seedHistoricalDocument(s, paystubFile(), paystubResponses(PAYSTUB));
    C.answer(s.db, (await items(s.db, 'employer_relation'))[0].id, 'household', { now: NOW });
    const f = F.getFacts(s.db);
    assert.equal(f['income.sCorp'], true);
    assert.ok(!('income.w2' in f));
  }));

  test('R6: an employer named like a stored P&L entity is the household business, with no question', async () => withStore(async (s) => {
    await seedHistoricalRows(s,northwindFile(),historicalNorthwindRows(), { parser: 'pnl-workbook', period: { from: '2032-04-01', to: '2032-04-30' } });
    const packState = async () => await all(s.db, 'SELECT id, def, updated_at FROM packs_state ORDER BY id');
    const before = await packState();
    const r = await seedHistoricalDocument(s, paystubFile({ employer: 'Northwind Design' }), paystubResponses({ ...PAYSTUB, employerName: 'Northwind Design' }));
    assert.equal(r.status, 'imported');
    assert.equal((await items(s.db, 'employer_relation')).length, 0);
    const f = F.getFacts(s.db);
    assert.equal(f['income.sCorp'], true);
    assert.ok(!('income.w2' in f));
    assert.equal((await one(s.db, "SELECT confirmed FROM facts WHERE key = 'income.sCorp'")).confirmed, 0);
    assert.notDeepEqual(await packState(), before, 'pack state refreshed after facts changed');
  }));





  test('markdown notes skip classify; a low-confidence fact is stored unconfirmed and queues fact_check', async () => withStore(async (s) => {
    const engine = await recordingEngine([[NOTES]]);
    const r = await seedHistoricalDocument(s, fixture('notes.md'), engine.responses);
    assert.equal(r.status, 'imported');
    const sourceId = (await one(s.db, 'SELECT source_id FROM files WHERE id = ?', r.fileId)).source_id;
    assert.match(sourceId, /^ing:/);
    const checks = await items(s.db, 'fact_check');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].subject, `${sourceId}|household.state|"CO"`);
    assert.equal(checks[0].status, 'pending');
    assert.deepEqual(JSON.parse(checks[0].options).map((o) => o.id), ['yes', 'no']);
    const stored = Object.fromEntries((await all(s.db, 'SELECT key, value, confirmed FROM facts')).map((f) => [f.key, [JSON.parse(f.value), f.confirmed]]));
    assert.deepEqual(stored, { 'household.dependents': [2, 0], 'household.state': ['CO', 0] });
    assert.equal(await count(s.db, 'documents', "file_id = ? AND doc_type = 'notes'", r.fileId), 1);
  }));


});

// R14: held assertions per document while the employer relation is open.
describe('held employer facts', () => {
  test('two paystubs before the answer each hold their own facts; outside applies both with their own file ids', async () => withStore(async (s) => {
    const first = await seedHistoricalDocument(s, paystubFile(), paystubResponses({ ...PAYSTUB, retirementDeferral: 400, hsaDeferral: 0 }));
    const second = await seedHistoricalDocument(s, paystubFile({ payDate: '2032-03-31' }), paystubResponses({
      ...PAYSTUB, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31', retirementDeferral: 0, hsaDeferral: 100,
    }));
    assert.equal(first.status, 'imported');
    assert.equal(second.status, 'imported');
    const q = await items(s.db, 'employer_relation');
    assert.equal(q.length, 1, 'one question for the employer');
    const key = (await one(s.db, 'SELECT payer FROM tax_payments LIMIT 1')).payer.split(':')[1];
    const held = await all(s.db, 'SELECT * FROM held_facts ORDER BY id');
    assert.ok(held.length >= 2);
    assert.ok(held.every((h) => h.hold === `employer:${key}`));
    assert.deepEqual([...new Set(held.map((h) => h.file_id))].sort(), [first.fileId, second.fileId].sort(), 'each document holds its own rows');
    for (const k of EMPLOYER_FACTS) assert.ok(!(k in F.getFacts(s.db)), `${k} held, not written`);

    C.answer(s.db, q[0].id, 'outside', { now: NOW });
    const fact = async (k) => await one(s.db, 'SELECT * FROM facts WHERE key = ?', k);
    assert.equal(JSON.parse((await fact('income.w2')).value), true);
    assert.ok([first.fileId, second.fileId].includes((await fact('income.w2')).file_id));
    assert.equal((await fact('benefits.employer401k')).file_id, first.fileId, 'the 401k deferral came from the first paystub');
    assert.equal((await fact('benefits.hsa')).file_id, second.fileId, 'the HSA deferral came from the second paystub');
    assert.equal(await count(s.db, 'held_facts'), 0, 'held rows are applied and removed');
  }));
});

// R15 with D4: once the employer's withholding is known to belong to one person (answer owner), a
// W-2 total summarizes that person's paystub withholding for the same employer, year and
// jurisdiction.
describe('annual withholding supersedes paystub detail', () => {
  const W2_2032 = { ...W2, taxYear: 2032 };
  const w2File = () => textFile('w2-2032.txt', 'Synthetic wage and tax statement for 2032', 'text/plain');
  const w2Engine = () => fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]]);
  const stub = (payDate, start) => [paystubFile({ payDate }), { ...PAYSTUB, payDate, periodStart: start, periodEnd: payDate }];
  const stubs = [stub('2032-03-15', '2032-03-01'), stub('2032-03-31', '2032-03-16')];
  const answerRecipient = (db, option) => {
    const q = C.pendingItems(db).find((i) => i.kind === 'employer_recipient');
    assert.ok(q, 'employer_recipient is asked');
    C.answer(db, q.id, option, { now: NOW });
  };

  async function assertSummarized(db) {
    const active = await all(db, 'SELECT * FROM tax_payments ORDER BY amount');
    assert.deepEqual(active.map((t) => [t.jurisdiction, t.amount, t.kind, t.tax_year_basis]), [
      ['CO', 3500, 'withholding', 'annual_total'],
      ['federal', 12000, 'withholding', 'annual_total'],
    ], 'only the W-2 totals stay active');
    for (const t of active) {
      // G4: the resolved payer identity is <R10 payer>:<recipient>.
      assert.match(t.payer, /^w2:[0-9a-f]{12}:2032:9000000:owner$/);
      assert.equal(t.source_slot, `wh:${t.payer.split(':')[1]}:2032:${t.source_slot.split(':')[3]}:owner`);
      assert.match(t.source_slot.split(':')[3], /^(federal|co)$/i);
    }
    const sup = await all(db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' ORDER BY id");
    assert.equal(sup.length, 4, 'two paystubs, two jurisdictions');
    assert.ok(sup.every((x) => x.reason === 'summarized'));
    for (const x of sup) assert.match(JSON.parse(x.row).payer, /^paystub:[0-9a-f]{12}:2032-03-(15|31):500000:owner$/, 'archived under the resolved payer identity');
    assert.deepEqual(sup.map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [250, 250, 700, 700]);
  }

  test('W-2 first, answer owner, then paystubs: paystub withholding is archived instead of inserted', async () => withStore(async (s) => {
    const w = await seedHistoricalDocument(s, w2File(), (await w2Engine()).responses);
    assert.equal(w.status, 'imported');
    answerRecipient(s.db, 'owner');
    for (const [file, extracted] of stubs) {
      const r = await seedHistoricalDocument(s, file, paystubResponses(extracted));
      assert.equal(r.status, 'imported');
    }
    await assertSummarized(s.db);
  }));

  test('paystubs first, then the W-2, then answer owner: paystub withholding is archived and deleted', async () => withStore(async (s) => {
    for (const [file, extracted] of stubs) await seedHistoricalDocument(s, file, paystubResponses(extracted));
    assert.equal(await count(s.db, 'tax_payments'), 4);
    await seedHistoricalDocument(s, w2File(), (await w2Engine()).responses);
    assert.equal(await count(s.db, 'tax_payments'), 6, 'nothing is summarized while the recipient is unknown');
    answerRecipient(s.db, 'owner');
    await assertSummarized(s.db);
  }));
});

// Review finding F2: a minus sign or accounting parentheses around a money-shaped number are part
// of the token's value, and the token replaces them in the sent text.
describe('signed amount tokens', () => {
  const SIGNED_TEXT = [
    'SYNTHETIC PAYSTUB CORRECTION',
    'Employer: Example Employer LLC',
    'Pay date 2032-03-15',
    'Gross pay -123456.78',
    'Net pay (234,567.89)',
    'Federal withholding $-345678.90',
    'State withholding -$456789.01',
  ].join('\n');
  const signedFile = () => textFile('paystub-correction.txt', SIGNED_TEXT, 'text/plain');
  const RUNS = ['123456', '234,567', '234567', '345678', '456789'];
  // Independent of the code under test: accepts '-1.5', '(1.5)', '$-1.5', '-$1.5', with commas.
  const numeric = (ref) => {
    const s = String(ref).trim();
    const negative = /^\(.*\)$/.test(s) || s.includes('-');
    const n = Number(s.replace(/[()$,\s-]/g, ''));
    return negative ? -n : n;
  };

  test('refs carry the sign and the text keeps only the tokens', () => {
    const out = RD.redactForExtraction(SIGNED_TEXT);
    const lines = out.text.split('\n');
    const tokenOn = (label) => (new RegExp(`^${label} \\$?(#A\\d+#)$`).exec(lines.find((l) => l.startsWith(label))) || [])[1];
    const tokens = ['Gross pay', 'Net pay', 'Federal withholding', 'State withholding'].map(tokenOn);
    assert.ok(tokens.every(Boolean), `each amount is a bare token, got ${JSON.stringify(lines.slice(3))}`);
    assert.deepEqual(tokens.map((t) => numeric(out.refs[t])), [-123456.78, -234567.89, -345678.9, -456789.01]);
    assert.ok(lines.includes(`Gross pay ${tokens[0]}`), 'the minus sign is inside the token');
    assert.ok(lines.includes(`Net pay ${tokens[1]}`), 'the parentheses are inside the token');
    for (const run of RUNS) assert.ok(!out.text.includes(run), `${run} not sent`);
  });


});

// D4 with G4: withholding belongs to a recipient (owner, spouse, unknown). The employer question
// decides it for every document of the employer, or "both" asks per document; unknown never
// summarizes. While the recipient is unknown the payer identity is <R10 payer>:doc:<file id>, so two
// members' identical documents never collapse; once it resolves the payer identity is
// <R10 payer>:<recipient> and the row is rekeyed.
describe('withholding recipients (D4, G4)', () => {
  const W2_2032 = { ...W2, taxYear: 2032 };
  const STUB_B = { ...PAYSTUB, gross: 2500, net: 1900, federalWithholding: 300, stateWithholding: 100, ytdGross: 15000 };
  const w2File = () => textFile('w2-member-a-2032.txt', 'Synthetic wage and tax statement for 2032, member A', 'text/plain');
  const importAll = async (s) => ({
    w2: (await seedHistoricalDocument(s, w2File(), [[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]])).fileId,
    a: (await seedHistoricalDocument(s, paystubFile({}, 'paystub-member-a.txt'), paystubResponses(PAYSTUB))).fileId,
    b: (await seedHistoricalDocument(s, paystubFile({ gross: '2500.00' }, 'paystub-member-b.txt'), paystubResponses(STUB_B))).fileId,
  });
  const key = () => X.nameKey('Example Employer LLC');
  const payers = () => ({ w2: `w2:${key()}:2032:9000000`, a: `paystub:${key()}:2032-03-15:500000`, b: `paystub:${key()}:2032-03-15:250000` });
  const pendingOf = (db, kind) => C.pendingItems(db).filter((i) => i.kind === kind);
  const recipientQuestions = (db) => C.pendingItems(db).filter((i) => i.kind === 'employer_recipient' || i.kind === 'document_recipient');
  const answerEmployer = (db, option) => C.answer(db, pendingOf(db, 'employer_recipient')[0].id, option, { now: NOW });
  const active = async (db) => await all(db, 'SELECT * FROM tax_payments ORDER BY payer, amount');
  const rekeyed = (t) => D.dedupeKey({ kind: 'tax_payment', jurisdiction: t.jurisdiction, sheetYear: t.tax_year, date: t.date, payer: t.payer });
  // Two members' paystubs with identical payroll figures; the bytes differ only in a trailing line.
  const memberStub = (member, payDate = '2032-03-15') => textFile(`paystub-member-${member}-${payDate}.txt`, `${paystubText({ payDate })}\nSynthetic member ${member}`, 'text/plain');
  const importStub = async (s, member, payDate = '2032-03-15') => {
    const extracted = payDate === '2032-03-15' ? PAYSTUB : { ...PAYSTUB, payDate, periodStart: '2032-03-16', periodEnd: payDate };
    const r = await seedHistoricalDocument(s, memberStub(member, payDate), paystubResponses(extracted));
    assert.equal(r.status, 'imported');
    return r.fileId;
  };

  test('the new kinds exist and tax_payments has a recipient column', async () => withStore(async (s) => {
    assert.ok(C.KINDS.includes('employer_recipient'));
    assert.ok(C.KINDS.includes('document_recipient'));
    assert.ok((await all(s.db, 'PRAGMA table_info(tax_payments)')).some((c) => c.name === 'recipient'));
  }));

  test('unknown recipient: a W-2 plus paystubs leave everything active under per-document payers and queue the employer question', async () => withStore(async (s) => {
    const ids = await importAll(s);
    const p = payers();
    const rows = await active(s.db);
    assert.equal(rows.length, 6, 'W-2 and both paystubs stay active');
    for (const t of rows) assert.match(t.source_slot, new RegExp(`^wh:${key()}:2032:(federal|co):unknown$`, 'i'));
    assert.deepEqual(rows.map((t) => t.payer).sort(), [`${p.a}:doc:${ids.a}`, `${p.a}:doc:${ids.a}`, `${p.b}:doc:${ids.b}`, `${p.b}:doc:${ids.b}`, `${p.w2}:doc:${ids.w2}`, `${p.w2}:doc:${ids.w2}`].sort());
    assert.equal(await count(s.db, 'superseded_rows', "reason = 'summarized'"), 0);
    const q = pendingOf(s.db, 'employer_recipient');
    assert.equal(q.length, 1, 'one question for the employer');
    assert.equal(q[0].subject, key());
    assert.deepEqual(q[0].options, [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'both', label: 'Both of you' }]);
  }));

  test('two members at one employer: after both and each document recipient, B stays active and A is summarized', async () => withStore(async (s) => {
    const ids = await importAll(s);
    answerEmployer(s.db, 'both');
    const docs = pendingOf(s.db, 'document_recipient');
    const p = payers();
    const subject = { w2: `${p.w2}:doc:${ids.w2}`, a: `${p.a}:doc:${ids.a}`, b: `${p.b}:doc:${ids.b}` };
    assert.deepEqual(docs.map((d) => d.subject).sort(), Object.values(subject).sort(), 'one question per document, its subject the per-document payer');
    for (const d of docs) assert.deepEqual(d.options.map((o) => o.id), ['owner', 'spouse']);
    const answer = { [subject.w2]: 'owner', [subject.a]: 'owner', [subject.b]: 'spouse' };
    for (const d of docs) C.answer(s.db, d.id, answer[d.subject], { now: NOW });

    const rows = await all(s.db, 'SELECT * FROM tax_payments ORDER BY amount');
    assert.deepEqual(rows.map((t) => [t.payer, t.amount, t.source_slot.split(':').at(-1), t.recipient]), [
      [`${p.b}:spouse`, 100, 'spouse', 'spouse'], [`${p.b}:spouse`, 300, 'spouse', 'spouse'],
      [`${p.w2}:owner`, 3500, 'owner', 'owner'], [`${p.w2}:owner`, 12000, 'owner', 'owner'],
    ], "B's paystub withholding stays; A's W-2 totals stay");
    for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t), 'rekeyed under the resolved payer');
    const sup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'summarized'");
    assert.deepEqual(sup.map((x) => [JSON.parse(x.row).payer, JSON.parse(x.row).amount]).sort((x, y) => x[1] - y[1]), [[`${p.a}:owner`, 250], [`${p.a}:owner`, 700]], "A's paystubs are summarized by A's W-2");
  }));

  for (const importOrder of [['a', 'b'], ['b', 'a']]) {
    for (const answerOrder of [['a', 'b'], ['b', 'a']]) {
      test(`identical payroll figures for two members (import ${importOrder.join(',')}, answer ${answerOrder.join(',')}) never collapse`, async () => withStore(async (s) => {
        const ids = {};
        for (const m of importOrder) ids[m] = await importStub(s, m);
        const base = payers().a;
        let rows = await active(s.db);
        assert.equal(rows.length, 4, 'both documents stay, two jurisdictions each');
        assert.deepEqual(rows.map((t) => t.payer).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`, `${base}:doc:${ids.b}`].sort());
        assert.equal(new Set(rows.map((t) => t.dedupe_key)).size, 4);

        answerEmployer(s.db, 'both');
        const docs = pendingOf(s.db, 'document_recipient');
        assert.deepEqual(docs.map((d) => d.subject).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`].sort(), 'one question per document');
        const recipient = { a: 'owner', b: 'spouse' };
        for (const m of answerOrder) C.answer(s.db, docs.find((d) => d.subject === `${base}:doc:${ids[m]}`).id, recipient[m], { now: NOW });

        rows = await active(s.db);
        assert.deepEqual(rows.map((t) => [t.payer, t.recipient, t.source_slot.split(':').at(-1), t.amount]), [
          [`${base}:owner`, 'owner', 'owner', 250], [`${base}:owner`, 'owner', 'owner', 700],
          [`${base}:spouse`, 'spouse', 'spouse', 250], [`${base}:spouse`, 'spouse', 'spouse', 700],
        ]);
        assert.ok(rows.every((t) => !t.payer.includes(':doc:')), 'the file id leaves the payer once resolved');
        for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t));
        assert.equal(await count(s.db, 'superseded_rows'), 0);
        assert.equal(recipientQuestions(s.db).length, 0);
      }));
    }
  }

  for (const answerOrder of [['a', 'b'], ['b', 'a']]) {
    test(`identical documents answered with one recipient (answer ${answerOrder.join(',')}): the rekeyed newer row is archived as duplicate`, async () => withStore(async (s) => {
      const ids = { a: await importStub(s, 'a'), b: await importStub(s, 'b') };
      const base = payers().a;
      answerEmployer(s.db, 'both');
      const docs = pendingOf(s.db, 'document_recipient');
      assert.deepEqual(docs.map((d) => d.subject).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`].sort(), 'one question per document');
      for (const m of answerOrder) C.answer(s.db, docs.find((d) => d.subject === `${base}:doc:${ids[m]}`).id, 'owner', { now: NOW });
      const rows = await active(s.db);
      assert.deepEqual(rows.map((t) => [t.payer, t.amount, t.file_id]), [[`${base}:owner`, 250, ids.a], [`${base}:owner`, 700, ids.a]], 'one row per jurisdiction, from the older file');
      const dup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'duplicate' ORDER BY id");
      assert.deepEqual(dup.map((x) => [x.file_id, JSON.parse(x.row).amount]).sort((x, y) => x[1] - y[1]), [[ids.b, 250], [ids.b, 700]], 'the newer document is archived');
    }));
  }

  for (const option of ['owner', 'spouse']) {
    test(`a remembered employer answer (${option}) resolves a later import at once`, async () => withStore(async (s) => {
      await importStub(s, 'a');
      answerEmployer(s.db, option);
      const base = payers().a;
      assert.deepEqual((await active(s.db)).map((t) => t.payer), [`${base}:${option}`, `${base}:${option}`]);
      await importStub(s, 'a', '2032-03-31');
      const later = await all(s.db, "SELECT * FROM tax_payments WHERE date = '2032-03-31' ORDER BY amount");
      assert.deepEqual(later.map((t) => [t.payer, t.recipient, t.source_slot.split(':').at(-1)]), [
        [`paystub:${key()}:2032-03-31:500000:${option}`, option, option], [`paystub:${key()}:2032-03-31:500000:${option}`, option, option],
      ]);
      for (const t of later) assert.equal(t.dedupe_key, rekeyed(t));
      assert.equal(recipientQuestions(s.db).length, 0, 'nothing new is asked');
    }));
  }

  test('a remembered both and document answer: a later identical document is asked about on its own and the answered one is kept', async () => withStore(async (s) => {
    const a = await importStub(s, 'a');
    const base = payers().a;
    answerEmployer(s.db, 'both');
    const [docA] = pendingOf(s.db, 'document_recipient');
    assert.equal(docA.subject, `${base}:doc:${a}`);
    C.answer(s.db, docA.id, 'owner', { now: NOW });

    const b = await importStub(s, 'b');
    const docs = pendingOf(s.db, 'document_recipient');
    assert.deepEqual(docs.map((d) => d.subject), [`${base}:doc:${b}`], 'only the new document is asked about');
    assert.equal(pendingOf(s.db, 'employer_recipient').length, 0, 'the employer answer is remembered');
    assert.deepEqual((await active(s.db)).map((t) => t.payer), [`${base}:doc:${b}`, `${base}:doc:${b}`, `${base}:owner`, `${base}:owner`]);

    C.answer(s.db, docs[0].id, 'spouse', { now: NOW });
    assert.deepEqual((await active(s.db)).map((t) => [t.payer, t.file_id]), [[`${base}:owner`, a], [`${base}:owner`, a], [`${base}:spouse`, b], [`${base}:spouse`, b]]);
    assert.equal(recipientQuestions(s.db).length, 0);
  }));

  // Review finding H1: every withholding-bearing document, not only employer ones, belongs to a
  // recipient. Two members' 1099s from one payer with identical figures, recipient unknown, stay two
  // rows under <R10 payer>:doc:<file id>, each asked about on its own; answered apart they stay two,
  // answered alike the newer is archived as duplicate. One entry per 1099 kind the extractor knows.
  const PAYER_NAME = 'Example Savings Bank';
  const FORM_1099 = {
    '1099-int': { amounts: { interest: 1200, earlyWithdrawalPenalty: 0 }, primary: '120000' },
    '1099-div': { amounts: { ordinaryDividends: 900, qualifiedDividends: 600, capitalGainDistributions: 100 }, primary: '90000' },
    '1099-b': { amounts: { proceeds: 15000, costBasis: 12000, shortTermGain: 1000, longTermGain: 2000 }, primary: '1500000' },
    '1099-nec': { amounts: { nonemployeeCompensation: 20000 }, primary: '2000000' },
    '1099-misc': { amounts: { rents: 0, royalties: 0, otherIncome: 3000 }, primary: '300000' },
  };
  const WITHHOLDING_FIELDS = ['federalWithheld', 'federalWithholding', 'stateWithheld', 'stateWithholding'];
  const form1099 = (docType) => ({ taxYear: 2032, payerKind: 'bank', payerName: PAYER_NAME, ...FORM_1099[docType].amounts, federalWithheld: 240, confidence: 0.9 });
  const import1099 = async (s, docType, member) => {
    const file = textFile(`${docType}-member-${member}-2032.txt`, `Synthetic ${docType} for tax year 2032, member ${member}`, 'text/plain');
    const r = await seedHistoricalDocument(s, file, [[{ docType, taxYear: 2032, confidence: 0.9 }], [form1099(docType)]]);
    assert.equal(r.status, 'imported');
    return r.fileId;
  };
  const base1099 = (docType) => `${docType}:${X.nameKey(PAYER_NAME)}:2032:${FORM_1099[docType].primary}`;
  // Imports member a then member b and checks the unresolved state. Returns {ids, docs}.
  async function importBoth1099(s, docType) {
    const ids = { a: await import1099(s, docType, 'a'), b: await import1099(s, docType, 'b') };
    const base = base1099(docType);
    const rows = await active(s.db);
    assert.equal(rows.length, 2, `both members' ${docType} withholding rows are kept`);
    assert.deepEqual(rows.map((t) => [t.payer, t.recipient, t.amount]).sort(), [[`${base}:doc:${ids.a}`, 'unknown', 240], [`${base}:doc:${ids.b}`, 'unknown', 240]].sort());
    assert.equal(new Set(rows.map((t) => t.dedupe_key)).size, 2);
    for (const t of rows) assert.match(t.source_slot, new RegExp(`^wh:${X.nameKey(PAYER_NAME)}:2032:federal:unknown$`));
    const docs = pendingOf(s.db, 'document_recipient');
    assert.deepEqual(docs.map((d) => d.subject).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`].sort(), 'one document_recipient question per document');
    for (const d of docs) {
      assert.deepEqual(d.options.map((o) => o.id), ['owner', 'spouse']);
      assert.ok(d.question.includes(X.labelOf(docType)) && !/paystub|W-2/.test(d.question), `the question names the ${X.labelOf(docType)}, got ${d.question}`);
    }
    return { ids, docs, base };
  }
  const answerDoc = (s, docs, subject, option) => C.answer(s.db, docs.find((d) => d.subject === subject).id, option, { now: NOW });

  test('H1: the 1099 table covers every 1099 kind and every withholding-bearing schema is W-2, paystub or a 1099', () => {
    assert.deepEqual(Object.keys(FORM_1099).sort(), X.DOC_TYPES.filter((t) => t.startsWith('1099-')).sort());
    const bearing = Object.entries(X.SCHEMAS).filter(([, schema]) => WITHHOLDING_FIELDS.some((f) => Object.hasOwn(schema.properties ?? {}, f))).map(([t]) => t);
    assert.deepEqual(bearing.sort(), ['paystub', 'w2', ...Object.keys(FORM_1099)].sort());
    for (const docType of Object.keys(FORM_1099)) {
      assert.equal(taxRows(X.toRows(docType, form1099(docType), ctx)).length, 1, `${docType} with federalWithheld yields a withholding row`);
    }
  });

  for (const docType of Object.keys(FORM_1099)) {
    test(`H1: two members' identical ${docType} withholding, recipient unknown, both kept and asked per document; owner and spouse keep both`, async () => withStore(async (s) => {
      const { ids, docs, base } = await importBoth1099(s, docType);
      answerDoc(s, docs, `${base}:doc:${ids.a}`, 'owner');
      answerDoc(s, docs, `${base}:doc:${ids.b}`, 'spouse');
      const rows = await active(s.db);
      assert.deepEqual(rows.map((t) => [t.payer, t.recipient, t.source_slot.split(':').at(-1), t.amount, t.file_id]), [
        [`${base}:owner`, 'owner', 'owner', 240, ids.a],
        [`${base}:spouse`, 'spouse', 'spouse', 240, ids.b],
      ]);
      for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t), 'rekeyed under the resolved payer');
      assert.equal(await count(s.db, 'superseded_rows', "table_name = 'tax_payments'"), 0);
      assert.equal(recipientQuestions(s.db).length, 0);
    }));

    for (const answerOrder of [['a', 'b'], ['b', 'a']]) {
      test(`H1: two members' identical ${docType} withholding answered with one recipient (answer ${answerOrder.join(',')}) collapse; the newer is archived as duplicate`, async () => withStore(async (s) => {
        const { ids, docs, base } = await importBoth1099(s, docType);
        for (const m of answerOrder) answerDoc(s, docs, `${base}:doc:${ids[m]}`, 'owner');
        const rows = await active(s.db);
        assert.deepEqual(rows.map((t) => [t.payer, t.recipient, t.amount, t.file_id]), [[`${base}:owner`, 'owner', 240, ids.a]], 'one row, from the older file');
        assert.equal(rows[0].dedupe_key, rekeyed(rows[0]));
        const dup = await all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' ORDER BY id");
        assert.deepEqual(dup.map((x) => [x.reason, x.file_id, JSON.parse(x.row).payer, JSON.parse(x.row).amount]), [['duplicate', ids.b, `${base}:owner`, 240]]);
        assert.equal(recipientQuestions(s.db).length, 0);
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0, 'equal amounts are a duplicate, never a conflict');
      }));
    }
  }

  // Review finding K1: payer identity excludes the withholding amount, so an original document and
  // its correction (same payer, year and primary figure, different withholding) share an identity
  // once the recipient resolves. Equal amounts are a duplicate; differing amounts queue one
  // withholding_conflict question (first: keep the earlier-imported row, second: the later one,
  // both: both are real payments) and keep both rows active until it is answered. The rejected row
  // is archived as withholding_conflict, never deleted, and the answer is remembered.
  const W2_FIRST = { ...W2_2032, stateWithheld: 0, federalWithheld: 12000 };
  const W2_SECOND = { ...W2_FIRST, federalWithheld: 13000 };
  const w2Of = (member, extracted) => ({
    file: (again = '') => textFile(`w2-${member}-2032${again}.txt`, `Synthetic wage and tax statement for 2032, copy ${member}${again}`, 'text/plain'),
    engine: () => fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [extracted]]),
  });
  const int1099Of = (member, federalWithheld) => ({
    file: (again = '') => textFile(`1099-int-${member}-2032${again}.txt`, `Synthetic 1099-int for tax year 2032, copy ${member}${again}`, 'text/plain'),
    engine: () => fakeEngine([[{ docType: '1099-int', taxYear: 2032, confidence: 0.9 }], [{ ...form1099('1099-int'), federalWithheld }]]),
  });
  const importDoc = async (s, d) => {
    const r = await seedHistoricalDocument(s, d.file(), (await d.engine()).responses);
    assert.equal(r.status, 'imported');
    return r.fileId;
  };
  const answerConflict = (s, option) => {
    const q = pendingOf(s.db, 'withholding_conflict');
    assert.equal(q.length, 1, 'one withholding_conflict question');
    return C.answer(s.db, q[0].id, option, { now: NOW });
  };
  const archivedWith = async (db, reason) => await all(db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = ? ORDER BY id", reason);
  const federal = async (db) => (await active(db)).filter((t) => t.jurisdiction === 'federal').sort((x, y) => x.id - y.id);
  // Each case imports the earlier document (first) then the later one (second), both resolved to the
  // owner, and returns {ids, base, docs, amounts}.
  const CONFLICT_CASES = [
    ...[['a', 'b'], ['b', 'a']].map((answerOrder) => ({
      name: `1099-int original and correction, document answers ${answerOrder.join(',')}`,
      async run(s) {
        const docs = { first: int1099Of('original', 200), second: int1099Of('corrected', 240) };
        const ids = { first: await importDoc(s, docs.first), second: await importDoc(s, docs.second) };
        const base = base1099('1099-int');
        const asked = pendingOf(s.db, 'document_recipient');
        const member = { a: ids.first, b: ids.second };
        for (const m of answerOrder) answerDoc(s, asked, `${base}:doc:${member[m]}`, 'owner');
        return { ids, base, docs, amounts: { first: 200, second: 240 }, again: '' };
      },
    })),
    {
      name: 'two W-2s from one employer, rekeyed by the employer answer',
      async run(s) {
        const docs = { first: w2Of('first', W2_FIRST), second: w2Of('second', W2_SECOND) };
        const ids = { first: await importDoc(s, docs.first), second: await importDoc(s, docs.second) };
        answerEmployer(s.db, 'owner');
        return { ids, base: payers().w2, docs, amounts: { first: 12000, second: 13000 }, again: '-again' };
      },
    },
    {
      name: 'two W-2s from one employer, the second resolved at import by the remembered employer answer',
      async run(s) {
        const docs = { first: w2Of('first', W2_FIRST), second: w2Of('second', W2_SECOND) };
        const first = await importDoc(s, docs.first);
        answerEmployer(s.db, 'owner');
        const ids = { first, second: await importDoc(s, docs.second) };
        return { ids, base: payers().w2, docs, amounts: { first: 12000, second: 13000 }, again: '-again' };
      },
    },
  ];

  test('K1: withholding_conflict is a confirm kind', () => {
    assert.ok(C.KINDS.includes('withholding_conflict'));
  });

  for (const c of CONFLICT_CASES) {
    test(`K1: ${c.name}: differing withholding is not a duplicate; one withholding_conflict question and both rows stay active`, async () => withStore(async (s) => {
      const { ids, amounts } = await c.run(s);
      assert.deepEqual((await federal(s.db)).map((t) => [t.recipient, t.amount, t.file_id]), [['owner', amounts.first, ids.first], ['owner', amounts.second, ids.second]]);
      assert.equal((await archivedWith(s.db, 'duplicate')).length, 0, 'no row is archived as duplicate');
      assert.equal((await archivedWith(s.db, 'revised')).length, 0, 'no row is revised in place');
      assert.equal((await archivedWith(s.db, 'withholding_conflict')).length, 0, 'nothing is archived before the answer');
      const q = pendingOf(s.db, 'withholding_conflict');
      assert.equal(q.length, 1, 'exactly one withholding_conflict question');
      assert.deepEqual(q[0].options.map((o) => o.id), ['first', 'second', 'both']);
      assert.equal(recipientQuestions(s.db).length, 0);
    }));

    const KEEP = { first: ['first'], second: ['second'], both: ['first', 'second'] };
    for (const option of ['first', 'second', 'both']) {
      test(`K1: ${c.name}: answering ${option} keeps ${KEEP[option].join(' and ')}; a re-import asks nothing and changes nothing`, async () => withStore(async (s) => {
        const { ids, base, docs, amounts, again } = await c.run(s);
        answerConflict(s, option);
        const kept = await federal(s.db);
        assert.deepEqual(kept.map((t) => [t.recipient, t.amount, t.file_id]), KEEP[option].map((k) => ['owner', amounts[k], ids[k]]));
        if (option !== 'both') {
          assert.equal(kept[0].payer, `${base}:owner`, 'the survivor carries the resolved payer identity');
          assert.equal(kept[0].dedupe_key, rekeyed(kept[0]));
        }
        const rejected = option === 'first' ? 'second' : option === 'second' ? 'first' : null;
        const archived = await archivedWith(s.db, 'withholding_conflict');
        assert.deepEqual(archived.map((x) => [x.file_id, JSON.parse(x.row).amount]), rejected ? [[ids[rejected], amounts[rejected]]] : [], 'the rejected row is archived, never dropped');
        assert.equal((await archivedWith(s.db, 'duplicate')).length, 0);
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0);

        const pending = C.pendingItems(s.db).map((i) => i.id);
        const rows = await active(s.db);
        const superseded = await count(s.db, 'superseded_rows');
        // W-2: re-downloaded copies (same extraction, new bytes) route through import under the
        // remembered employer answer. 1099: the recipient answer is per document (H1), so a new copy
        // would rightly ask again; the same bytes are uploaded and skipped as an identical file.
        for (const d of [docs.first, docs.second]) {
          const r = await seedHistoricalDocument(s, d.file(again), (await d.engine()).responses);
          assert.equal(r.status, again ? 'imported' : 'duplicate');
        }
        assert.deepEqual(C.pendingItems(s.db).map((i) => i.id), pending, 'nothing new is asked');
        assert.deepEqual(await active(s.db), rows, 'active rows are unchanged');
        assert.equal(await count(s.db, 'superseded_rows'), superseded, 'nothing more is archived');
      }));
    }
  }

  test('K1 guard: two W-2s with equal state and differing federal withholding: the state row collapses as duplicate, only federal is asked about', async () => withStore(async (s) => {
    const first = await importDoc(s, w2Of('first', { ...W2_FIRST, stateWithheld: 3500 }));
    const second = await importDoc(s, w2Of('second', { ...W2_SECOND, stateWithheld: 3500 }));
    answerEmployer(s.db, 'owner');
    const state = (await active(s.db)).filter((t) => t.jurisdiction !== 'federal');
    assert.deepEqual(state.map((t) => [t.amount, t.file_id]), [[3500, first]], 'one state row, from the earlier file');
    assert.deepEqual((await archivedWith(s.db, 'duplicate')).map((x) => [x.file_id, JSON.parse(x.row).jurisdiction, JSON.parse(x.row).amount]), [[second, state[0].jurisdiction, 3500]]);
    assert.deepEqual((await federal(s.db)).map((t) => [t.amount, t.file_id]), [[12000, first], [13000, second]]);
    const q = pendingOf(s.db, 'withholding_conflict');
    assert.equal(q.length, 1, 'one question, for federal only');
  }));

  // Review finding L1: a withholding_conflict names stored rows, and tax_payments ids are reused
  // once rows are removed. A conflict whose rows are removed (summarized by a W-2) is closed, and
  // answering a conflict whose rows no longer match what it asked about is refused as stale and
  // changes nothing.
  const snapshot = async (db) => ({ rows: await all(db, 'SELECT * FROM tax_payments ORDER BY id'), superseded: await all(db, 'SELECT * FROM superseded_rows ORDER BY id') });
  const refusedStale = (db, id, option) => assert.throws(() => C.answer(db, id, option, { now: NOW }),
    (e) => e?.name === 'ConfirmError' && ['stale', 'not_found'].includes(e.code), `answering ${option} is refused as stale`);
  const stubVersion = (version, federalWithholding) => ({
    file: () => textFile(`paystub-version-${version}-2032-03-15.txt`, `${paystubText()}\nSynthetic version ${version}`, 'text/plain'),
    engine: () => fakeEngine(paystubResponses({ ...PAYSTUB, stateWithholding: undefined, federalWithholding })),
  });

  test('L1: a paystub withholding_conflict whose rows a W-2 summarizes is closed; answering it later never touches 1099 rows that reuse the ids', async () => withStore(async (s) => {
    const w2 = await importDoc(s, w2Of('federal-only', { ...W2_2032, stateWithheld: undefined }));
    await importDoc(s, stubVersion(1, 700));
    await importDoc(s, stubVersion(2, 650));
    assert.equal((await active(s.db)).length, 3, 'the W-2 and both paystub versions, federal only, recipient unknown');

    answerEmployer(s.db, 'owner');
    assert.deepEqual((await active(s.db)).map((t) => [t.payer, t.amount, t.file_id]), [[`${payers().w2}:owner`, 12000, w2]], 'the W-2 summarizes both paystub versions');
    assert.equal((await archivedWith(s.db, 'summarized')).length, 2);
    assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0, 'the conflict closes once its rows are summarized');
    const conflicts = await items(s.db, 'withholding_conflict');

    // Two members' 1099-INTs with withholding; their rows may take the ids the paystub rows freed.
    const ids1099 = [await import1099(s, '1099-int', 'a'), await import1099(s, '1099-int', 'b')];
    const before = await snapshot(s.db);
    assert.deepEqual(before.rows.filter((t) => t.payer.startsWith('1099-int:')).map((t) => [t.file_id, t.amount]), ids1099.map((id) => [id, 240]));
    for (const c of conflicts) for (const option of ['first', 'second', 'both']) refusedStale(s.db, c.id, option);
    assert.deepEqual(await snapshot(s.db), before, 'no tax row or archive changes');
  }));

  // Direct SQL is used because no import path changes a conflicted row in a known-recipient slot.
  const MUTATIONS = [
    ['its amount is changed by direct SQL', async (db, row) => await db.prepare('UPDATE tax_payments SET amount = ? WHERE id = ?').run(260, row.id)],
    ['it is deleted and an unrelated row takes its id, by direct SQL', async (db, row) => {
      await db.prepare('DELETE FROM tax_payments WHERE id = ?').run(row.id);
      await db.prepare(`INSERT INTO tax_payments (id, jurisdiction, tax_year, date, amount, file_id, dedupe_key, source_slot, payer, recipient)
                  VALUES (?, 'federal', 2032, '2032-12-31', 55, ?, 'synthetic-unrelated-key', 'wh:synthetic:2032:federal:owner', 'synthetic-unrelated-payer', 'owner')`).run(row.id, row.file_id);
    }],
  ];
  for (const [how, mutate] of MUTATIONS) {
    test(`L1 guard: a pending withholding_conflict whose later row changed (${how}) is refused as stale and changes nothing`, async () => withStore(async (s) => {
      const ids = { first: await importDoc(s, int1099Of('original', 200)), second: await importDoc(s, int1099Of('corrected', 240)) };
      const base = base1099('1099-int');
      const asked = pendingOf(s.db, 'document_recipient');
      for (const id of [ids.first, ids.second]) answerDoc(s, asked, `${base}:doc:${id}`, 'owner');
      const [q] = pendingOf(s.db, 'withholding_conflict');
      assert.ok(q, 'a withholding_conflict is pending');
      mutate(s.db, await one(s.db, "SELECT * FROM tax_payments WHERE file_id = ? AND jurisdiction = 'federal'", ids.second));
      const before = await snapshot(s.db);
      for (const option of ['first', 'second']) refusedStale(s.db, q.id, option);
      assert.deepEqual(await snapshot(s.db), before, 'no tax row or archive changes');
    }));
  }

  // Review finding L2: an explicit zero withholding field is observed, so a correction to zero
  // conflicts with the earlier nonzero amount under K1; an absent field stays absent.
  const federalOf = async (db, base) => (await active(db)).filter((t) => t.jurisdiction === 'federal' && t.payer.startsWith(base));
  const totalOf = (rows) => rows.reduce((sum, t) => sum + t.amount, 0);
  const W2_ZERO = { ...W2_FIRST, federalWithheld: 0 };
  const ZERO_CASES = [
    {
      name: '1099-INT',
      amount: 200,
      async run(s) {
        const ids = { first: await importDoc(s, int1099Of('original', 200)), second: await importDoc(s, int1099Of('corrected', 0)) };
        const base = base1099('1099-int');
        for (const d of pendingOf(s.db, 'document_recipient')) C.answer(s.db, d.id, 'owner', { now: NOW });
        return { ids, base };
      },
    },
    {
      name: 'W-2 rekeyed by the employer answer',
      amount: 12000,
      async run(s) {
        const ids = { first: await importDoc(s, w2Of('first', W2_FIRST)), second: await importDoc(s, w2Of('corrected', W2_ZERO)) };
        answerEmployer(s.db, 'owner');
        return { ids, base: payers().w2 };
      },
    },
    {
      name: 'W-2 resolved at import by the remembered employer answer',
      amount: 12000,
      async run(s) {
        const first = await importDoc(s, w2Of('first', W2_FIRST));
        answerEmployer(s.db, 'owner');
        return { ids: { first, second: await importDoc(s, w2Of('corrected', W2_ZERO)) }, base: payers().w2 };
      },
    },
  ];
  for (const c of ZERO_CASES) {
    for (const option of ['first', 'second']) {
      test(`L2: ${c.name} corrected to explicit zero federal withholding queues one withholding_conflict; answering ${option} leaves ${option === 'first' ? c.amount : 0}`, async () => withStore(async (s) => {
        const { ids, base } = await c.run(s);
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 1, 'one withholding_conflict question');
        answerConflict(s, option);
        const rows = await federalOf(s.db, base);
        const archived = (await archivedWith(s.db, 'withholding_conflict')).map((x) => [x.file_id, JSON.parse(x.row).amount]);
        if (option === 'second') {
          assert.equal(totalOf(rows), 0, 'no federal withholding remains for the payer');
          assert.ok(rows.every((t) => t.amount === 0 && t.file_id === ids.second), 'only the corrected zero row may stay');
          assert.deepEqual(archived, [[ids.first, c.amount]], 'the nonzero row is archived as withholding_conflict');
        } else {
          assert.equal(totalOf(rows), c.amount);
          assert.deepEqual(rows.filter((t) => t.amount !== 0).map((t) => [t.amount, t.file_id]), [[c.amount, ids.first]]);
          assert.ok(!archived.some(([fileId]) => fileId === ids.first), 'the earlier row is kept');
        }
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0);
      }));
    }
  }

  const ABSENT_CASES = [
    ['1099-INT', '1099-int', { ...form1099('1099-int'), federalWithheld: undefined }, () => int1099Of('original', 200), () => int1099Of('absent', undefined), () => base1099('1099-int'), false],
    ['W-2', 'w2', { ...W2_FIRST, federalWithheld: undefined }, () => w2Of('first', W2_FIRST), () => w2Of('absent', { ...W2_FIRST, federalWithheld: undefined }), () => payers().w2, true],
  ];
  for (const [name, docType, extracted, firstDoc, absentDoc, baseOf, employer] of ABSENT_CASES) {
    test(`L2 guard: a ${name} with the federal withholding field absent emits no federal row and queues no withholding_conflict`, async () => withStore(async (s) => {
      const fields = JSON.parse(JSON.stringify(extracted));
      assert.ok(!Object.hasOwn(fields, 'federalWithheld'));
      assert.equal(taxRows(X.toRows(docType, fields, ctx)).filter((r) => r.jurisdiction === 'federal').length, 0, 'toRows emits no federal withholding row');
      const first = await importDoc(s, firstDoc());
      if (employer) answerEmployer(s.db, 'owner');
      const second = await importDoc(s, absentDoc());
      for (const d of pendingOf(s.db, 'document_recipient')) C.answer(s.db, d.id, 'owner', { now: NOW });
      assert.deepEqual((await federalOf(s.db, baseOf())).map((t) => [t.amount, t.file_id]), [[name === 'W-2' ? 12000 : 200, first]], 'the earlier withholding stays');
      assert.equal(await count(s.db, 'tax_payments', "file_id = ? AND jurisdiction = 'federal'", second), 0, 'the absent field stores no federal row');
      assert.equal((await items(s.db, 'withholding_conflict')).length, 0, 'no withholding_conflict is queued');
    }));
  }

  // Review finding M1: payer identity includes the primary income amount, so a corrected form whose
  // income also changed takes a different key and K1 never sees it. A document withholding row of a
  // known recipient that lands in the slot (payer, year, jurisdiction, recipient) of an active row
  // of the same document type from another file under a different key queues one
  // withholding_conflict, whether or not the amounts differ; both is the answer for genuinely
  // separate forms. W-2 versus paystub summarization, different recipients and different document
  // types never conflict.
  const formOf = (docType, member, fields) => ({
    file: (again = '') => textFile(`${docType}-${member}-2032${again}.txt`, `Synthetic ${docType} for tax year 2032, copy ${member}${again}`, 'text/plain'),
    engine: () => fakeEngine([[{ docType, taxYear: 2032, confidence: 0.9 }], [{ ...form1099(docType), ...fields }]]),
  });
  const slotOf = (slotKey, recipient, jurisdiction = 'federal') => `wh:${slotKey}:2032:${jurisdiction}:${recipient}`;
  const inSlot = async (db, slot) => (await active(db)).filter((t) => t.source_slot === slot).sort((x, y) => x.id - y.id);
  const payerSlot = (recipient = 'owner') => slotOf(X.nameKey(PAYER_NAME), recipient);
  const employerSlot = (recipient = 'owner') => slotOf(key(), recipient);
  const answerDocs = (s, recipientOf) => {
    for (const d of pendingOf(s.db, 'document_recipient')) C.answer(s.db, d.id, recipientOf(d), { now: NOW });
  };
  const M1_KEEP = { first: ['first'], second: ['second'], both: ['first', 'second'] };
  const W2_CORRECTED = { ...W2_FIRST, wages: 88000, socialSecurityWages: 88000, medicareWages: 88000, stateWages: 88000, federalWithheld: 11500 };

  const M1_CASES = [
    ...[['first', 'second'], ['second', 'first']].map((answerOrder) => ({
      name: `1099-INT corrected with different interest to explicit zero withholding, document answers ${answerOrder.join(',')}`,
      slot: payerSlot,
      amounts: { first: 200, second: 0 },
      async run(s) {
        const ids = {
          first: await importDoc(s, formOf('1099-int', 'm1-original', { interest: 1200, federalWithheld: 200 })),
          second: await importDoc(s, formOf('1099-int', 'm1-corrected', { interest: 1000, federalWithheld: 0 })),
        };
        const asked = pendingOf(s.db, 'document_recipient');
        assert.equal(asked.length, 2, 'one document_recipient question per 1099-INT');
        for (const m of answerOrder) C.answer(s.db, asked.find((d) => d.context.payer.endsWith(`:doc:${ids[m]}`)).id, 'owner', { now: NOW });
        return ids;
      },
    })),
    {
      name: 'W-2 corrected with different wages and withholding, rekeyed by the employer answer',
      slot: employerSlot,
      amounts: { first: 12000, second: 11500 },
      async run(s) {
        const ids = { first: await importDoc(s, w2Of('m1-first', W2_FIRST)), second: await importDoc(s, w2Of('m1-corrected', W2_CORRECTED)) };
        answerEmployer(s.db, 'owner');
        return ids;
      },
    },
    {
      name: 'W-2 corrected with different wages and withholding, resolved at import by the remembered employer answer',
      slot: employerSlot,
      amounts: { first: 12000, second: 11500 },
      async run(s) {
        const first = await importDoc(s, w2Of('m1-first', W2_FIRST));
        answerEmployer(s.db, 'owner');
        return { first, second: await importDoc(s, w2Of('m1-corrected', W2_CORRECTED)) };
      },
    },
  ];

  for (const c of M1_CASES) {
    for (const option of ['first', 'second', 'both']) {
      const left = M1_KEEP[option].reduce((sum, k) => sum + c.amounts[k], 0);
      test(`M1: ${c.name}: one withholding_conflict; answering ${option} leaves ${left} federal withholding for the payer`, async () => withStore(async (s) => {
        const ids = await c.run(s);
        assert.equal(recipientQuestions(s.db).length, 0, 'both documents are resolved to the owner');
        assert.deepEqual((await inSlot(s.db, c.slot())).map((t) => [t.amount, t.file_id]), [[c.amounts.first, ids.first], [c.amounts.second, ids.second]], 'both rows stay active until the answer');
        assert.equal((await items(s.db, 'withholding_conflict')).length, 1, 'exactly one withholding_conflict is queued');
        assert.equal((await archivedWith(s.db, 'duplicate')).length, 0);

        answerConflict(s, option);
        const rows = await inSlot(s.db, c.slot());
        assert.deepEqual(rows.map((t) => [t.amount, t.file_id]), M1_KEEP[option].map((k) => [c.amounts[k], ids[k]]));
        assert.equal(totalOf(rows), left, 'the payer\'s active federal withholding total');
        for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t), 'each active row is keyed by its payer identity');
        const rejected = option === 'first' ? 'second' : option === 'second' ? 'first' : null;
        assert.deepEqual((await archivedWith(s.db, 'withholding_conflict')).map((x) => [x.file_id, JSON.parse(x.row).amount]),
          rejected ? [[ids[rejected], c.amounts[rejected]]] : [], 'the rejected row is archived as withholding_conflict');
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0);
        assert.equal((await items(s.db, 'withholding_conflict')).length, 1, 'no further question');
      }));
    }
  }

  test('M1: two genuinely separate 1099-INTs from one payer for one recipient ask once; both keeps both and a re-import asks nothing new', async () => withStore(async (s) => {
    const docs = { first: formOf('1099-int', 'm1-account-1', { interest: 1200, federalWithheld: 200 }), second: formOf('1099-int', 'm1-account-2', { interest: 300, federalWithheld: 45 }) };
    const ids = { first: await importDoc(s, docs.first), second: await importDoc(s, docs.second) };
    answerDocs(s, () => 'owner');
    assert.equal((await items(s.db, 'withholding_conflict')).length, 1, 'one question');
    answerConflict(s, 'both');
    const kept = await inSlot(s.db, payerSlot());
    assert.deepEqual(kept.map((t) => [t.amount, t.file_id]), [[200, ids.first], [45, ids.second]], 'both stay active');
    assert.equal(await count(s.db, 'superseded_rows', "table_name = 'tax_payments'"), 0, 'nothing is archived');

    const conflicts = (await items(s.db, 'withholding_conflict')).length;
    const rows = await active(s.db);
    // The same bytes again are an identical file.
    for (const d of [docs.first, docs.second]) assert.equal((await seedHistoricalDocument(s, d.file(), (await d.engine()).responses)).status, 'duplicate');
    assert.deepEqual(await active(s.db), rows);
    // A re-downloaded copy asks its own document question (H1); answered owner, it is a duplicate
    // of the kept row and raises no withholding_conflict.
    for (const d of [docs.first, docs.second]) assert.equal((await seedHistoricalDocument(s, d.file('-again'), (await d.engine()).responses)).status, 'imported');
    answerDocs(s, () => 'owner');
    assert.equal(recipientQuestions(s.db).length, 0);
    assert.equal((await items(s.db, 'withholding_conflict')).length, conflicts, 'no withholding_conflict is asked again');
    assert.deepEqual(await active(s.db), rows, 'active rows are unchanged');
    assert.deepEqual((await archivedWith(s.db, 'duplicate')).map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [45, 200], 'the copies are archived as duplicates');
  }));

  // M1 guard: R15 summarization in a shared employer slot is unchanged, whatever the order.
  const W2_STUB_ORDERS = [
    ['the W-2 and both paystubs imported, then owner', async (s) => { await importAll(s); answerEmployer(s.db, 'owner'); }],
    ['the W-2, owner, then both paystubs', async (s) => {
      await importDoc(s, { file: w2File, engine: () => fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]]) });
      answerEmployer(s.db, 'owner');
      await importDoc(s, { file: () => paystubFile({}, 'paystub-member-a.txt'), engine: () => fakeEngine(paystubResponses(PAYSTUB)) });
      await importDoc(s, { file: () => paystubFile({ gross: '2500.00' }, 'paystub-member-b.txt'), engine: () => fakeEngine(paystubResponses(STUB_B)) });
    }],
    ['one paystub, owner, the second paystub, then the W-2', async (s) => {
      await importDoc(s, { file: () => paystubFile({}, 'paystub-member-a.txt'), engine: () => fakeEngine(paystubResponses(PAYSTUB)) });
      answerEmployer(s.db, 'owner');
      await importDoc(s, { file: () => paystubFile({ gross: '2500.00' }, 'paystub-member-b.txt'), engine: () => fakeEngine(paystubResponses(STUB_B)) });
      await importDoc(s, { file: w2File, engine: () => fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]]) });
    }],
  ];
  for (const [order, run] of W2_STUB_ORDERS) {
    test(`M1 guard: a W-2 plus its employer's paystubs in one slot (${order}) summarize as today and never conflict`, async () => withStore(async (s) => {
      await run(s);
      const p = payers();
      assert.deepEqual((await active(s.db)).map((t) => [t.payer, t.amount]).sort((x, y) => x[1] - y[1]), [[`${p.w2}:owner`, 3500], [`${p.w2}:owner`, 12000]], 'only the W-2 totals stay active');
      assert.deepEqual((await archivedWith(s.db, 'summarized')).map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [100, 250, 300, 700], 'every paystub row is summarized');
      assert.equal((await items(s.db, 'withholding_conflict')).length, 0, 'no withholding_conflict is ever queued');
    }));
  }

  for (const [order, run] of [
    ['remembered owner, then the later paystub', async (s) => { await importStub(s, 'a'); answerEmployer(s.db, 'owner'); await importStub(s, 'a', '2032-03-31'); }],
    ['both paystubs, then owner', async (s) => { await importStub(s, 'a'); await importStub(s, 'a', '2032-03-31'); answerEmployer(s.db, 'owner'); }],
  ]) {
    test(`M1 guard: two paystubs of one employer on different pay dates with no W-2 (${order}) both stay and never conflict`, async () => withStore(async (s) => {
      await run(s);
      assert.deepEqual((await inSlot(s.db, employerSlot())).map((t) => [t.date, t.amount]), [['2032-03-15', 700], ['2032-03-31', 700]].sort((x, y) => x[0].localeCompare(y[0])));
      assert.equal((await items(s.db, 'withholding_conflict')).length, 0);
    }));
  }

  test('M1 guard: two 1099-INTs from one payer with different interest for different recipients never conflict', async () => withStore(async (s) => {
    const ids = {
      owner: await importDoc(s, formOf('1099-int', 'm1-owner', { interest: 1200, federalWithheld: 200 })),
      spouse: await importDoc(s, formOf('1099-int', 'm1-spouse', { interest: 1000, federalWithheld: 0 })),
    };
    answerDocs(s, (d) => (d.context.payer.endsWith(`:doc:${ids.owner}`) ? 'owner' : 'spouse'));
    assert.deepEqual((await inSlot(s.db, payerSlot('owner'))).map((t) => [t.amount, t.file_id]), [[200, ids.owner]]);
    assert.deepEqual((await inSlot(s.db, payerSlot('spouse'))).map((t) => [t.amount, t.file_id]), [[0, ids.spouse]]);
    assert.equal((await items(s.db, 'withholding_conflict')).length, 0);
  }));

  test('M1 guard: two W-2s from one employer with different wages for different recipients never conflict', async () => withStore(async (s) => {
    const ids = { owner: await importDoc(s, w2Of('m1-owner', W2_FIRST)), spouse: await importDoc(s, w2Of('m1-spouse', W2_CORRECTED)) };
    answerEmployer(s.db, 'both');
    answerDocs(s, (d) => (d.context.payer.endsWith(`:doc:${ids.owner}`) ? 'owner' : 'spouse'));
    assert.deepEqual((await inSlot(s.db, employerSlot('owner'))).map((t) => [t.amount, t.file_id]), [[12000, ids.owner]]);
    assert.deepEqual((await inSlot(s.db, employerSlot('spouse'))).map((t) => [t.amount, t.file_id]), [[11500, ids.spouse]]);
    assert.equal((await items(s.db, 'withholding_conflict')).length, 0);
  }));

  for (const answerOrder of [['1099-int', '1099-div'], ['1099-div', '1099-int']]) {
    test(`M1 guard: a 1099-INT and a 1099-DIV from one payer for one recipient (answers ${answerOrder.join(',')}) never conflict`, async () => withStore(async (s) => {
      const ids = {
        '1099-int': await importDoc(s, formOf('1099-int', 'm1-int', { interest: 1200, federalWithheld: 200 })),
        '1099-div': await importDoc(s, formOf('1099-div', 'm1-div', { federalWithheld: 240 })),
      };
      const asked = pendingOf(s.db, 'document_recipient');
      for (const t of answerOrder) C.answer(s.db, asked.find((d) => d.context.payer.endsWith(`:doc:${ids[t]}`)).id, 'owner', { now: NOW });
      assert.deepEqual((await inSlot(s.db, payerSlot())).map((t) => [t.payer.split(':')[0], t.amount, t.file_id]), [['1099-int', 200, ids['1099-int']], ['1099-div', 240, ids['1099-div']]], 'both share the slot and stay active');
      assert.equal((await items(s.db, 'withholding_conflict')).length, 0);
    }));
  }

  // Review finding N1: a remembered first or second answer names the form it kept, not a position.
  // A re-downloaded copy (new bytes, same extracted data) of either form, imported after the answer
  // and resolved to the same recipient, collapses against the kept row: the kept rows stay active,
  // the copy is never active (archived as withholding_conflict or duplicate, or counted as a
  // duplicate without being stored), the total is not double counted and nothing new is asked.
  const N1_CASES = [
    {
      name: 'K1 1099-INT original and correction with equal interest',
      slot: payerSlot,
      docs: { first: int1099Of('n1-original', 200), second: int1099Of('n1-corrected', 240) },
      amounts: { first: 200, second: 240 },
      resolve: (s) => answerDocs(s, () => 'owner'),
    },
    {
      name: 'K1 W-2 original and correction with equal wages',
      slot: employerSlot,
      docs: { first: w2Of('n1-first', W2_FIRST), second: w2Of('n1-second', W2_SECOND) },
      amounts: { first: 12000, second: 13000 },
      resolve: (s) => answerEmployer(s.db, 'owner'),
    },
    {
      name: 'M1 1099-INT corrected with different interest',
      slot: payerSlot,
      docs: { first: formOf('1099-int', 'n1-m1-original', { interest: 1200, federalWithheld: 200 }), second: formOf('1099-int', 'n1-m1-corrected', { interest: 1000, federalWithheld: 150 }) },
      amounts: { first: 200, second: 150 },
      resolve: (s) => answerDocs(s, () => 'owner'),
    },
    {
      name: 'M1 W-2 corrected with different wages',
      slot: employerSlot,
      docs: { first: w2Of('n1-m1-first', W2_FIRST), second: w2Of('n1-m1-corrected', W2_CORRECTED) },
      amounts: { first: 12000, second: 11500 },
      resolve: (s) => answerEmployer(s.db, 'owner'),
    },
  ];
  const N1_SCENARIOS = [
    { option: 'second', copy: 'first', keep: ['second'], label: 'keep the correction, then a re-downloaded original' },
    { option: 'first', copy: 'second', keep: ['first'], label: 'keep the original, then a re-downloaded correction' },
    { option: 'second', copy: 'second', keep: ['second'], label: 'keep the correction, then a re-downloaded correction' },
    { option: 'both', copy: 'first', keep: ['first', 'second'], label: 'keep both, then a re-downloaded original' },
  ];
  const archivedOf = async (db, fileId) => await all(db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND file_id = ? ORDER BY id", fileId);

  for (const c of N1_CASES) {
    for (const sc of N1_SCENARIOS) {
      const left = sc.keep.reduce((sum, k) => sum + c.amounts[k], 0);
      test(`N1: ${c.name}: ${sc.label} keeps ${sc.keep.join(' and ')} (${left}) and asks nothing new`, async () => withStore(async (s) => {
        const ids = { first: await importDoc(s, c.docs.first), second: await importDoc(s, c.docs.second) };
        c.resolve(s);
        answerConflict(s, sc.option);
        const expected = sc.keep.map((k) => [c.amounts[k], ids[k]]);
        assert.deepEqual((await inSlot(s.db, c.slot())).map((t) => [t.amount, t.file_id]), expected, 'the answer is applied');
        const conflicts = (await items(s.db, 'withholding_conflict')).length;
        const pending = C.pendingItems(s.db).map((i) => i.id);
        const keptArchives = await mapSeries(sc.keep, async (k) => (await archivedOf(s.db, ids[k])).length);

        const d = c.docs[sc.copy];
        const r = await seedHistoricalDocument(s, d.file('-again'), (await d.engine()).responses);
        assert.equal(r.status, 'imported', 'new bytes are a new file');
        answerDocs(s, () => 'owner');
        assert.equal(recipientQuestions(s.db).length, 0, 'the copy is resolved to the owner');

        const rows = await inSlot(s.db, c.slot());
        assert.deepEqual(rows.map((t) => [t.amount, t.file_id]), expected, `${sc.keep.join(' and ')} stay active and the copy collapses`);
        assert.equal(totalOf(rows), left, 'the payer\'s active federal withholding total');
        assert.ok(!(await active(s.db)).some((t) => t.file_id === r.fileId), 'the copy is never active');
        for (const x of await archivedOf(s.db, r.fileId)) assert.ok(['withholding_conflict', 'duplicate'].includes(x.reason), `the copy is archived as withholding_conflict or duplicate, not ${x.reason}`);
        assert.deepEqual(await mapSeries(sc.keep, async (k) => (await archivedOf(s.db, ids[k])).length), keptArchives, 'no kept row is archived');
        assert.equal(pendingOf(s.db, 'withholding_conflict').length, 0, 'no withholding_conflict is pending');
        assert.equal((await items(s.db, 'withholding_conflict')).length, conflicts, 'no new withholding_conflict is queued');
        assert.deepEqual(C.pendingItems(s.db).map((i) => i.id), pending, 'nothing new is pending');
      }));
    }
  }
});

// D6 with G6 to G8: a PDF whose text layer has any text is read with pdfjs (in a worker) and goes
// to the model as redacted text, like a text file; only an image-only PDF goes as a document. A PDF
// pdfjs cannot read completely (failed or incomplete) waits as needs_extraction with note
// pdf_unreadable and is never sent. counts.extractPath records the path. pdfText's own outcomes are
// in pdftext.test.mjs.
describe('Unicode minus (D7)', () => {
  const MINUS = ['\u2212', '\u2012', '\u2013', '\u2014', '\uFE63', '\uFF0D'];
  const hex = (c) => c.codePointAt(0).toString(16);

  test('each minus form before an amount becomes a negative ref; a prose dash is left alone', () => {
    for (const m of MINUS) {
      const out = RD.redactForExtraction(`Ending balance ${m}$123456.78\nNet change ${m}234567.89\nFee ${m}$12.50`);
      assert.deepEqual(Object.values(out.refs).map(Number), [-123456.78, -234567.89], `U+${hex(m)}`);
      assert.doesNotMatch(out.text, /\d{5,}/);
      assert.ok(out.text.includes('Fee -$12.50'), `U+${hex(m)} before a short amount becomes ASCII minus`);
    }
    const prose = 'Cash reserve \u2013 rainy day fund \u2014 keep it simple \u2212 always';
    assert.equal(RD.redactForExtraction(prose).text, prose);
  });

  test('each minus form yields a negative stored balance through extraction', async () => withStore(async (s) => {
    for (const [i, m] of MINUS.entries()) {
      const file = textFile(`statement-minus-${hex(m)}.txt`, `SYNTHETIC STATEMENT\nEnding balance ${m}$123456.78\n`, 'text/plain');
      const engine = await fakeEngine([[{ docType: 'statement', confidence: 0.9 }], [{ ...STATEMENT, accountLast4: `900${i}`, endingBalance: '#A1#', holdings: [] }]]);
      const r = await seedHistoricalDocument(s, file, engine.responses);
      assert.equal(r.status, 'imported');
      const acct = await one(s.db, 'SELECT id FROM accounts WHERE mask = ?', `900${i}`);
      assert.deepEqual((await all(s.db, 'SELECT amount FROM balances WHERE account_id = ?', acct.id)).map((b) => b.amount), [-123456.78], `U+${hex(m)}`);
    }
  }));
});
