// AC5 (with plan revisions R1, R2, R6, R7, R8): PDFs and unknown text go through a classify call
// and a per-type schema extraction. Text reaches the model redacted, with money amounts swapped for
// opaque tokens that code resolves back. Schemas never ask for identifiers. Extracted values become
// rows only through deterministic code; the employer relationship is grounded or confirmed, never
// extracted; low-confidence facts wait for confirmation.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import {
  fixture, textFile, northwindFile, paystubText, realStore, fakeEngine, recordingEngine, offEngine, all, one, count, items, NOW,
} from '../helpers/ingest.mjs';

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
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% synthetic statement for tests\n%%EOF\n');
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
        if (BANNED(key)) problems.push(`${path}.${key}: banned property`);
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

describe('extractDocument', () => {
  test('text paystub: classify then extract, redacted text, token resolved, metadata returned (R2, R8)', async () => {
    const engine = await recordingEngine(paystubResponses({ ...PAYSTUB, gross: '#A1#' }));
    const out = await X.extractDocument(engine, paystubFile({ gross: '$123456.78' }));
    assert.equal(out.status, 'imported');
    assert.equal(out.docType, 'paystub');
    assert.equal(out.sourceKind, 'paystub');
    assert.deepEqual(out.period, { from: '2032-03-01', to: '2032-03-15' });
    assert.ok(Array.isArray(out.warnings));
    assert.equal(docRows(out.rows).find((r) => r.docType === 'paystub').fields.gross, 123456.78);
    assert.equal(engine.extracts.length, 2);
    assert.equal(engine.extracts[0].maxTokens, 256, 'classify is a short call');
    assert.ok(engine.extracts.every((r) => r.document.type === 'text'));
    const sent = engine.sent();
    for (const raw of ['123456', '000123456789', '123-45-6789', '12-3456789']) assert.ok(!sent.includes(raw), `${raw} never sent`);
    assert.ok(engine.extracts[1].document.text.includes('#A1#'));
    assert.ok(engine.extracts[1].document.text.includes('XXX-XX-XXXX'));
    assert.doesNotMatch(sent, /\d{5,}/);
  });

  test('an unknown token drops the field with an unresolved_amount warning', async () => {
    const out = await X.extractDocument(await fakeEngine(paystubResponses({ ...PAYSTUB, gross: '#A9#' })), paystubFile({ gross: '$123456.78' }));
    assert.equal(out.status, 'imported');
    assert.ok(!('gross' in docRows(out.rows).find((r) => r.docType === 'paystub').fields));
    assert.ok(out.warnings.some((w) => w.code === 'unresolved_amount'));
  });

  test('a PDF is sent as a pdf document; statement metadata', async () => {
    const engine = await recordingEngine([[{ docType: 'statement', confidence: 0.9 }], [STATEMENT]]);
    const out = await X.extractDocument(engine, { name: 'statement-2032-03.pdf', bytes: PDF_BYTES, mime: 'application/pdf' });
    assert.equal(out.status, 'imported');
    assert.equal(out.docType, 'statement');
    assert.equal(out.sourceKind, 'statement');
    assert.equal(out.period.to, '2032-03-31');
    assert.equal(engine.extracts[0].document.type, 'pdf');
    assert.ok(Buffer.from(engine.extracts[0].document.data).equals(Buffer.from(PDF_BYTES)));
  });

  test('source kind and period per document type', async () => {
    const w2 = await X.extractDocument(await fakeEngine([[{ docType: 'w2', taxYear: 2031, confidence: 0.9 }], [W2]]), textFile('w2.txt', 'Synthetic wage statement'));
    assert.equal(w2.sourceKind, 'tax_doc');
    assert.deepEqual(w2.period, { from: '2031-01-01', to: '2031-12-31' });
    const plan = await X.extractDocument(await fakeEngine([[{ docType: 'plan', confidence: 0.9 }], [PLAN]]), textFile('plan.txt', 'Synthetic plan summary'));
    assert.equal(plan.sourceKind, 'other');
    const other = await X.extractDocument(await fakeEngine([[{ docType: 'other', confidence: 0.7 }]]), textFile('misc.txt', 'Synthetic note.'));
    assert.equal(other.sourceKind, 'other');
    assert.deepEqual(other.period, { from: null, to: null });
  });

  test('docType other stops after classify with an other document row', async () => {
    const engine = await recordingEngine([[{ docType: 'other', confidence: 0.7 }]]);
    const out = await X.extractDocument(engine, textFile('misc.txt', 'Synthetic note with nothing to extract.'));
    assert.equal(out.status, 'imported');
    assert.equal(engine.extracts.length, 1);
    assert.deepEqual(docRows(out.rows).map((r) => r.docType), ['other']);
  });

  test('engine off, budget reached and an invalid extraction all wait; a valid one beside them imports', async () => {
    const off = await X.extractDocument(await offEngine(), paystubFile());
    assert.deepEqual([off.status, off.reason], ['needs_extraction', 'engine_off']);
    const broke = await X.extractDocument(await fakeEngine(paystubResponses(PAYSTUB), { capUsd: 0 }), paystubFile());
    assert.deepEqual([broke.status, broke.reason], ['needs_extraction', 'engine_error']);
    const invalid = await X.extractDocument(await fakeEngine(paystubResponses({ ...PAYSTUB, bogus: 1 })), paystubFile());
    assert.equal(invalid.status, 'needs_extraction');
    assert.ok(['invalid', 'engine_error'].includes(invalid.reason));
    const ok = await X.extractDocument(await fakeEngine(paystubResponses(PAYSTUB)), paystubFile());
    assert.equal(ok.status, 'imported');
  });
});

describe('through ingestFile', () => {
  test('R2: the stored document field is the resolved amount', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, paystubFile({ gross: '$123456.78' }), s.opts(await fakeEngine(paystubResponses({ ...PAYSTUB, gross: '#A1#' }))));
    assert.equal(r.status, 'imported');
    const doc = one(s.db, "SELECT fields FROM documents WHERE doc_type = 'paystub'");
    assert.equal(JSON.parse(doc.fields).gross, 123456.78);
  }));

  test('R1: four paystubs store eight distinct withholding rows', () => withStore(async (s) => {
    const cases = [
      [{ payDate: '2032-03-15' }, PAYSTUB],
      [{ payDate: '2032-03-31' }, { ...PAYSTUB, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31' }],
      [{ payDate: '2031-03-15' }, { ...PAYSTUB, payDate: '2031-03-15', periodStart: '2031-03-01', periodEnd: '2031-03-15' }],
      [{ payDate: '2032-03-15', employer: 'Other Example Company' }, { ...PAYSTUB, employerName: 'Other Example Company' }],
    ];
    for (const [text, extracted] of cases) {
      const r = await P.ingestFile(s.db, paystubFile(text), s.opts(await fakeEngine(paystubResponses(extracted))));
      assert.equal(r.status, 'imported');
      assert.equal(r.counts.duplicates, 0);
      assert.equal((r.counts.rows || {}).tax_payment, 2);
    }
    const tax = all(s.db, 'SELECT * FROM tax_payments');
    assert.equal(tax.length, 8);
    assert.ok(tax.every((t) => t.kind === 'withholding' && t.payer.startsWith('paystub:')));
    // R15: wh:<employerKey>:<taxYear>:<jurisdiction>, with the payer's employer key.
    for (const t of tax) {
      assert.match(t.source_slot, /^wh:[0-9a-f]{12}:(2031|2032):(federal|co)$/i);
      assert.equal(t.source_slot.split(':')[1], t.payer.split(':')[1]);
      assert.equal(t.source_slot.split(':')[2], String(t.tax_year));
    }
    assert.equal(new Set(tax.map((t) => t.dedupe_key)).size, 8);
    assert.deepEqual(tax.filter((t) => t.jurisdiction === 'federal').map((t) => t.tax_year).sort(), [2031, 2032, 2032, 2032]);
  }));

  test('R6: an unknown employer queues employer_relation and holds the employer facts', () => withStore(async (s) => {
    const extracted = { ...PAYSTUB, retirementDeferral: 400, hsaDeferral: 100 };
    const r = await P.ingestFile(s.db, paystubFile(), s.opts(await fakeEngine(paystubResponses(extracted))));
    assert.equal(r.status, 'imported');
    assert.equal(r.sourceKind, 'paystub');
    const q = items(s.db, 'employer_relation');
    assert.equal(q.length, 1);
    assert.match(q[0].subject, /^[0-9a-f]{12}$/);
    assert.deepEqual(JSON.parse(q[0].options), [{ id: 'outside', label: 'An outside employer' }, { id: 'household', label: 'Our own business' }]);
    for (const k of EMPLOYER_FACTS) assert.ok(!(k in F.getFacts(s.db)), `${k} not written before the answer`);
    const tax = all(s.db, 'SELECT * FROM tax_payments ORDER BY amount');
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

    const next = await P.ingestFile(s.db, paystubFile({ payDate: '2032-03-31' }), s.opts(await fakeEngine(paystubResponses({ ...extracted, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31' }))));
    assert.equal(next.status, 'imported');
    assert.equal(items(s.db, 'employer_relation').length, 1, 'the same employer asks nothing new');
    assert.equal(C.pendingItems(s.db).filter((i) => i.kind === 'employer_relation').length, 0);
    assert.equal(F.getFacts(s.db)['income.w2'], true);
  }));

  test('R6: answering household writes income.sCorp, not income.w2', () => withStore(async (s) => {
    await P.ingestFile(s.db, paystubFile(), s.opts(await fakeEngine(paystubResponses(PAYSTUB))));
    C.answer(s.db, items(s.db, 'employer_relation')[0].id, 'household', { now: NOW });
    const f = F.getFacts(s.db);
    assert.equal(f['income.sCorp'], true);
    assert.ok(!('income.w2' in f));
  }));

  test('R6: an employer named like a stored P&L entity is the household business, with no question', () => withStore(async (s) => {
    await P.ingestFile(s.db, northwindFile(), s.opts(await offEngine()));
    const before = count(s.db, 'packs_state');
    const r = await P.ingestFile(s.db, paystubFile({ employer: 'Northwind Design' }), s.opts(await fakeEngine(paystubResponses({ ...PAYSTUB, employerName: 'Northwind Design' }))));
    assert.equal(r.status, 'imported');
    assert.equal(items(s.db, 'employer_relation').length, 0);
    const f = F.getFacts(s.db);
    assert.equal(f['income.sCorp'], true);
    assert.ok(!('income.w2' in f));
    assert.equal(one(s.db, "SELECT confirmed FROM facts WHERE key = 'income.sCorp'").confirmed, 0);
    assert.ok(count(s.db, 'packs_state') > before, 'pack state refreshed after facts changed');
  }));

  test('R8: a PDF statement imports a balance and positions and a statement source dated periodEnd', () => withStore(async (s) => {
    const engine = await recordingEngine([[{ docType: 'statement', confidence: 0.9 }], [STATEMENT]]);
    const r = await P.ingestFile(s.db, { name: 'statement-2032-03.pdf', bytes: PDF_BYTES, mime: 'application/pdf' }, s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(r.sourceKind, 'statement');
    assert.equal(engine.extracts[0].document.type, 'pdf');
    assert.equal(one(s.db, 'SELECT mask FROM accounts').mask, '4321');
    assert.deepEqual(all(s.db, 'SELECT date, amount FROM balances').map((b) => [b.date, b.amount]), [['2032-03-31', 1500.25]]);
    assert.deepEqual(all(s.db, 'SELECT symbol, price FROM positions').map((p) => [p.symbol, p.price]), [['EXMPL', 123.45]]);
    const f = one(s.db, 'SELECT period_to FROM files WHERE id = ?', r.fileId);
    assert.equal(f.period_to, '2032-03-31');
    const sc = B.buildScenario(s.db, { clock: '2032-04-10' });
    const src = sc.live.ingest.sources.find((x) => x.kind === 'statement');
    assert.ok(src, 'statement source listed');
    assert.equal(src.asOf, '2032-03-31');
  }));

  test('engine off: the paystub waits as needs_extraction and stores no rows', () => withStore(async (s) => {
    const r = await P.ingestFile(s.db, paystubFile(), s.opts(await offEngine()));
    assert.equal(r.status, 'needs_extraction');
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', r.fileId).status, 'needs_extraction');
    assert.equal(count(s.db, 'documents'), 0);
    assert.equal(count(s.db, 'tax_payments'), 0);
  }));

  test('markdown notes skip classify; a low-confidence fact is stored unconfirmed and queues fact_check', () => withStore(async (s) => {
    const engine = await recordingEngine([[NOTES]]);
    const r = await P.ingestFile(s.db, fixture('notes.md'), s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(engine.extracts.length, 1, 'notes extraction only, no classify call');
    const sourceId = one(s.db, 'SELECT source_id FROM files WHERE id = ?', r.fileId).source_id;
    assert.match(sourceId, /^ing:/);
    const checks = items(s.db, 'fact_check');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].subject, `${sourceId}|household.state|"CO"`);
    assert.equal(checks[0].status, 'pending');
    assert.deepEqual(JSON.parse(checks[0].options).map((o) => o.id), ['yes', 'no']);
    const stored = Object.fromEntries(all(s.db, 'SELECT key, value, confirmed FROM facts').map((f) => [f.key, [JSON.parse(f.value), f.confirmed]]));
    assert.deepEqual(stored, { 'household.dependents': [2, 0], 'household.state': ['CO', 0] });
    assert.equal(count(s.db, 'documents', "file_id = ? AND doc_type = 'notes'", r.fileId), 1);
  }));

  test('R7: notes with the engine off wait; retryFile with the engine on extracts and keeps one notes document', () => withStore(async (s) => {
    const first = await P.ingestFile(s.db, fixture('notes.md'), s.opts(await offEngine()));
    assert.equal(first.status, 'needs_extraction');
    assert.equal(count(s.db, 'facts'), 0);
    const retried = await P.retryFile(s.db, first.fileId, s.opts(await fakeEngine([[NOTES]])));
    assert.equal(retried.status, 'imported');
    assert.equal(retried.fileId, first.fileId);
    assert.equal(F.getFacts(s.db)['household.dependents'], 2);
    assert.equal(count(s.db, 'documents', "doc_type = 'goal'"), 1);
    assert.equal(count(s.db, 'documents', "doc_type = 'notes'"), 1, 'exactly one notes document');
    assert.equal(one(s.db, 'SELECT status FROM files WHERE id = ?', first.fileId).status, 'imported');
  }));
});

// R14: held assertions per document while the employer relation is open.
describe('held employer facts', () => {
  test('two paystubs before the answer each hold their own facts; outside applies both with their own file ids', () => withStore(async (s) => {
    const first = await P.ingestFile(s.db, paystubFile(), s.opts(await fakeEngine(paystubResponses({ ...PAYSTUB, retirementDeferral: 400, hsaDeferral: 0 }))));
    const second = await P.ingestFile(s.db, paystubFile({ payDate: '2032-03-31' }), s.opts(await fakeEngine(paystubResponses({
      ...PAYSTUB, payDate: '2032-03-31', periodStart: '2032-03-16', periodEnd: '2032-03-31', retirementDeferral: 0, hsaDeferral: 100,
    }))));
    assert.equal(first.status, 'imported');
    assert.equal(second.status, 'imported');
    const q = items(s.db, 'employer_relation');
    assert.equal(q.length, 1, 'one question for the employer');
    const key = one(s.db, 'SELECT payer FROM tax_payments LIMIT 1').payer.split(':')[1];
    const held = all(s.db, 'SELECT * FROM held_facts ORDER BY id');
    assert.ok(held.length >= 2);
    assert.ok(held.every((h) => h.hold === `employer:${key}`));
    assert.deepEqual([...new Set(held.map((h) => h.file_id))].sort(), [first.fileId, second.fileId].sort(), 'each document holds its own rows');
    for (const k of EMPLOYER_FACTS) assert.ok(!(k in F.getFacts(s.db)), `${k} held, not written`);

    C.answer(s.db, q[0].id, 'outside', { now: NOW });
    const fact = (k) => one(s.db, 'SELECT * FROM facts WHERE key = ?', k);
    assert.equal(JSON.parse(fact('income.w2').value), true);
    assert.ok([first.fileId, second.fileId].includes(fact('income.w2').file_id));
    assert.equal(fact('benefits.employer401k').file_id, first.fileId, 'the 401k deferral came from the first paystub');
    assert.equal(fact('benefits.hsa').file_id, second.fileId, 'the HSA deferral came from the second paystub');
    assert.equal(count(s.db, 'held_facts'), 0, 'held rows are applied and removed');
  }));
});

// R15: a W-2 total summarizes paystub withholding for the same employer, year and jurisdiction.
describe('annual withholding supersedes paystub detail', () => {
  const W2_2032 = { ...W2, taxYear: 2032 };
  const w2File = () => textFile('w2-2032.txt', 'Synthetic wage and tax statement for 2032', 'text/plain');
  const w2Engine = () => fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]]);
  const stub = (payDate, start) => [paystubFile({ payDate }), { ...PAYSTUB, payDate, periodStart: start, periodEnd: payDate }];
  const stubs = [stub('2032-03-15', '2032-03-01'), stub('2032-03-31', '2032-03-16')];

  function assertSummarized(db) {
    const active = all(db, 'SELECT * FROM tax_payments ORDER BY amount');
    assert.deepEqual(active.map((t) => [t.jurisdiction, t.amount, t.kind, t.tax_year_basis]), [
      ['CO', 3500, 'withholding', 'annual_total'],
      ['federal', 12000, 'withholding', 'annual_total'],
    ], 'only the W-2 totals stay active');
    for (const t of active) {
      assert.match(t.payer, /^w2:[0-9a-f]{12}:2032:9000000$/);
      assert.equal(t.source_slot, `wh:${t.payer.split(':')[1]}:2032:${t.source_slot.split(':')[3]}`);
      assert.match(t.source_slot.split(':')[3], /^(federal|co)$/i);
    }
    const sup = all(db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' ORDER BY id");
    assert.equal(sup.length, 4, 'two paystubs, two jurisdictions');
    assert.ok(sup.every((x) => x.reason === 'summarized'));
    assert.ok(sup.every((x) => String(JSON.parse(x.row).payer).startsWith('paystub:')));
    assert.deepEqual(sup.map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [250, 250, 700, 700]);
  }

  test('W-2 first, then paystubs: paystub withholding is archived instead of inserted', () => withStore(async (s) => {
    const w = await P.ingestFile(s.db, w2File(), s.opts(await w2Engine()));
    assert.equal(w.status, 'imported');
    for (const [file, extracted] of stubs) {
      const r = await P.ingestFile(s.db, file, s.opts(await fakeEngine(paystubResponses(extracted))));
      assert.equal(r.status, 'imported');
    }
    assertSummarized(s.db);
  }));

  test('paystubs first, then the W-2: paystub withholding is archived and deleted', () => withStore(async (s) => {
    for (const [file, extracted] of stubs) await P.ingestFile(s.db, file, s.opts(await fakeEngine(paystubResponses(extracted))));
    assert.equal(count(s.db, 'tax_payments'), 4);
    await P.ingestFile(s.db, w2File(), s.opts(await w2Engine()));
    assertSummarized(s.db);
  }));
});
