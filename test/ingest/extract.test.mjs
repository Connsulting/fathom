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
import { textPdf, imagePdf, multiPagePdf, malformedPdf, partialTextPdf, inflateBombPdf } from '../helpers/pdf.mjs';

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

  function assertSummarized(db) {
    const active = all(db, 'SELECT * FROM tax_payments ORDER BY amount');
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
    const sup = all(db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' ORDER BY id");
    assert.equal(sup.length, 4, 'two paystubs, two jurisdictions');
    assert.ok(sup.every((x) => x.reason === 'summarized'));
    for (const x of sup) assert.match(JSON.parse(x.row).payer, /^paystub:[0-9a-f]{12}:2032-03-(15|31):500000:owner$/, 'archived under the resolved payer identity');
    assert.deepEqual(sup.map((x) => JSON.parse(x.row).amount).sort((a, b) => a - b), [250, 250, 700, 700]);
  }

  test('W-2 first, answer owner, then paystubs: paystub withholding is archived instead of inserted', () => withStore(async (s) => {
    const w = await P.ingestFile(s.db, w2File(), s.opts(await w2Engine()));
    assert.equal(w.status, 'imported');
    answerRecipient(s.db, 'owner');
    for (const [file, extracted] of stubs) {
      const r = await P.ingestFile(s.db, file, s.opts(await fakeEngine(paystubResponses(extracted))));
      assert.equal(r.status, 'imported');
    }
    assertSummarized(s.db);
  }));

  test('paystubs first, then the W-2, then answer owner: paystub withholding is archived and deleted', () => withStore(async (s) => {
    for (const [file, extracted] of stubs) await P.ingestFile(s.db, file, s.opts(await fakeEngine(paystubResponses(extracted))));
    assert.equal(count(s.db, 'tax_payments'), 4);
    await P.ingestFile(s.db, w2File(), s.opts(await w2Engine()));
    assert.equal(count(s.db, 'tax_payments'), 6, 'nothing is summarized while the recipient is unknown');
    answerRecipient(s.db, 'owner');
    assertSummarized(s.db);
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

  test('extractDocument and the pipeline store negative values', () => withStore(async (s) => {
    const redacted = RD.redactForExtraction(SIGNED_TEXT);
    const order = Object.keys(redacted.refs);
    assert.equal(order.length, 4);
    const extracted = { ...PAYSTUB, gross: order[0], net: order[1], federalWithholding: order[2], stateWithholding: order[3] };

    const engine = await recordingEngine(paystubResponses(extracted));
    const out = await X.extractDocument(engine, signedFile());
    assert.equal(out.status, 'imported');
    const fields = docRows(out.rows).find((r) => r.docType === 'paystub').fields;
    assert.deepEqual([fields.gross, fields.net, fields.federalWithholding, fields.stateWithholding], [-123456.78, -234567.89, -345678.9, -456789.01]);
    for (const run of RUNS) assert.ok(!engine.sent().includes(run), `${run} never sent`);

    const r = await P.ingestFile(s.db, signedFile(), s.opts(await fakeEngine(paystubResponses(extracted))));
    assert.equal(r.status, 'imported');
    const stored = JSON.parse(one(s.db, "SELECT fields FROM documents WHERE doc_type = 'paystub'").fields);
    assert.deepEqual([stored.gross, stored.net, stored.federalWithholding, stored.stateWithholding], [-123456.78, -234567.89, -345678.9, -456789.01]);
  }));
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
    w2: (await P.ingestFile(s.db, w2File(), s.opts(await fakeEngine([[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [W2_2032]])))).fileId,
    a: (await P.ingestFile(s.db, paystubFile({}, 'paystub-member-a.txt'), s.opts(await fakeEngine(paystubResponses(PAYSTUB))))).fileId,
    b: (await P.ingestFile(s.db, paystubFile({ gross: '2500.00' }, 'paystub-member-b.txt'), s.opts(await fakeEngine(paystubResponses(STUB_B))))).fileId,
  });
  const key = () => X.nameKey('Example Employer LLC');
  const payers = () => ({ w2: `w2:${key()}:2032:9000000`, a: `paystub:${key()}:2032-03-15:500000`, b: `paystub:${key()}:2032-03-15:250000` });
  const pendingOf = (db, kind) => C.pendingItems(db).filter((i) => i.kind === kind);
  const recipientQuestions = (db) => C.pendingItems(db).filter((i) => i.kind === 'employer_recipient' || i.kind === 'document_recipient');
  const answerEmployer = (db, option) => C.answer(db, pendingOf(db, 'employer_recipient')[0].id, option, { now: NOW });
  const active = (db) => all(db, 'SELECT * FROM tax_payments ORDER BY payer, amount');
  const rekeyed = (t) => D.dedupeKey({ kind: 'tax_payment', jurisdiction: t.jurisdiction, sheetYear: t.tax_year, date: t.date, payer: t.payer });
  // Two members' paystubs with identical payroll figures; the bytes differ only in a trailing line.
  const memberStub = (member, payDate = '2032-03-15') => textFile(`paystub-member-${member}-${payDate}.txt`, `${paystubText({ payDate })}\nSynthetic member ${member}`, 'text/plain');
  const importStub = async (s, member, payDate = '2032-03-15') => {
    const extracted = payDate === '2032-03-15' ? PAYSTUB : { ...PAYSTUB, payDate, periodStart: '2032-03-16', periodEnd: payDate };
    const r = await P.ingestFile(s.db, memberStub(member, payDate), s.opts(await fakeEngine(paystubResponses(extracted))));
    assert.equal(r.status, 'imported');
    return r.fileId;
  };

  test('the new kinds exist and tax_payments has a recipient column', () => withStore(async (s) => {
    assert.ok(C.KINDS.includes('employer_recipient'));
    assert.ok(C.KINDS.includes('document_recipient'));
    assert.ok(all(s.db, 'PRAGMA table_info(tax_payments)').some((c) => c.name === 'recipient'));
  }));

  test('unknown recipient: a W-2 plus paystubs leave everything active under per-document payers and queue the employer question', () => withStore(async (s) => {
    const ids = await importAll(s);
    const p = payers();
    const rows = active(s.db);
    assert.equal(rows.length, 6, 'W-2 and both paystubs stay active');
    for (const t of rows) assert.match(t.source_slot, new RegExp(`^wh:${key()}:2032:(federal|co):unknown$`, 'i'));
    assert.deepEqual(rows.map((t) => t.payer).sort(), [`${p.a}:doc:${ids.a}`, `${p.a}:doc:${ids.a}`, `${p.b}:doc:${ids.b}`, `${p.b}:doc:${ids.b}`, `${p.w2}:doc:${ids.w2}`, `${p.w2}:doc:${ids.w2}`].sort());
    assert.equal(count(s.db, 'superseded_rows', "reason = 'summarized'"), 0);
    const q = pendingOf(s.db, 'employer_recipient');
    assert.equal(q.length, 1, 'one question for the employer');
    assert.equal(q[0].subject, key());
    assert.deepEqual(q[0].options, [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'both', label: 'Both of you' }]);
  }));

  test('two members at one employer: after both and each document recipient, B stays active and A is summarized', () => withStore(async (s) => {
    const ids = await importAll(s);
    answerEmployer(s.db, 'both');
    const docs = pendingOf(s.db, 'document_recipient');
    const p = payers();
    const subject = { w2: `${p.w2}:doc:${ids.w2}`, a: `${p.a}:doc:${ids.a}`, b: `${p.b}:doc:${ids.b}` };
    assert.deepEqual(docs.map((d) => d.subject).sort(), Object.values(subject).sort(), 'one question per document, its subject the per-document payer');
    for (const d of docs) assert.deepEqual(d.options.map((o) => o.id), ['owner', 'spouse']);
    const answer = { [subject.w2]: 'owner', [subject.a]: 'owner', [subject.b]: 'spouse' };
    for (const d of docs) C.answer(s.db, d.id, answer[d.subject], { now: NOW });

    const rows = all(s.db, 'SELECT * FROM tax_payments ORDER BY amount');
    assert.deepEqual(rows.map((t) => [t.payer, t.amount, t.source_slot.split(':').at(-1), t.recipient]), [
      [`${p.b}:spouse`, 100, 'spouse', 'spouse'], [`${p.b}:spouse`, 300, 'spouse', 'spouse'],
      [`${p.w2}:owner`, 3500, 'owner', 'owner'], [`${p.w2}:owner`, 12000, 'owner', 'owner'],
    ], "B's paystub withholding stays; A's W-2 totals stay");
    for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t), 'rekeyed under the resolved payer');
    const sup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'summarized'");
    assert.deepEqual(sup.map((x) => [JSON.parse(x.row).payer, JSON.parse(x.row).amount]).sort((x, y) => x[1] - y[1]), [[`${p.a}:owner`, 250], [`${p.a}:owner`, 700]], "A's paystubs are summarized by A's W-2");
  }));

  for (const importOrder of [['a', 'b'], ['b', 'a']]) {
    for (const answerOrder of [['a', 'b'], ['b', 'a']]) {
      test(`identical payroll figures for two members (import ${importOrder.join(',')}, answer ${answerOrder.join(',')}) never collapse`, () => withStore(async (s) => {
        const ids = {};
        for (const m of importOrder) ids[m] = await importStub(s, m);
        const base = payers().a;
        let rows = active(s.db);
        assert.equal(rows.length, 4, 'both documents stay, two jurisdictions each');
        assert.deepEqual(rows.map((t) => t.payer).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`, `${base}:doc:${ids.b}`].sort());
        assert.equal(new Set(rows.map((t) => t.dedupe_key)).size, 4);

        answerEmployer(s.db, 'both');
        const docs = pendingOf(s.db, 'document_recipient');
        assert.deepEqual(docs.map((d) => d.subject).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`].sort(), 'one question per document');
        const recipient = { a: 'owner', b: 'spouse' };
        for (const m of answerOrder) C.answer(s.db, docs.find((d) => d.subject === `${base}:doc:${ids[m]}`).id, recipient[m], { now: NOW });

        rows = active(s.db);
        assert.deepEqual(rows.map((t) => [t.payer, t.recipient, t.source_slot.split(':').at(-1), t.amount]), [
          [`${base}:owner`, 'owner', 'owner', 250], [`${base}:owner`, 'owner', 'owner', 700],
          [`${base}:spouse`, 'spouse', 'spouse', 250], [`${base}:spouse`, 'spouse', 'spouse', 700],
        ]);
        assert.ok(rows.every((t) => !t.payer.includes(':doc:')), 'the file id leaves the payer once resolved');
        for (const t of rows) assert.equal(t.dedupe_key, rekeyed(t));
        assert.equal(count(s.db, 'superseded_rows'), 0);
        assert.equal(recipientQuestions(s.db).length, 0);
      }));
    }
  }

  for (const answerOrder of [['a', 'b'], ['b', 'a']]) {
    test(`identical documents answered with one recipient (answer ${answerOrder.join(',')}): the rekeyed newer row is archived as duplicate`, () => withStore(async (s) => {
      const ids = { a: await importStub(s, 'a'), b: await importStub(s, 'b') };
      const base = payers().a;
      answerEmployer(s.db, 'both');
      const docs = pendingOf(s.db, 'document_recipient');
      assert.deepEqual(docs.map((d) => d.subject).sort(), [`${base}:doc:${ids.a}`, `${base}:doc:${ids.b}`].sort(), 'one question per document');
      for (const m of answerOrder) C.answer(s.db, docs.find((d) => d.subject === `${base}:doc:${ids[m]}`).id, 'owner', { now: NOW });
      const rows = active(s.db);
      assert.deepEqual(rows.map((t) => [t.payer, t.amount, t.file_id]), [[`${base}:owner`, 250, ids.a], [`${base}:owner`, 700, ids.a]], 'one row per jurisdiction, from the older file');
      const dup = all(s.db, "SELECT * FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'duplicate' ORDER BY id");
      assert.deepEqual(dup.map((x) => [x.file_id, JSON.parse(x.row).amount]).sort((x, y) => x[1] - y[1]), [[ids.b, 250], [ids.b, 700]], 'the newer document is archived');
    }));
  }

  for (const option of ['owner', 'spouse']) {
    test(`a remembered employer answer (${option}) resolves a later import at once`, () => withStore(async (s) => {
      await importStub(s, 'a');
      answerEmployer(s.db, option);
      const base = payers().a;
      assert.deepEqual(active(s.db).map((t) => t.payer), [`${base}:${option}`, `${base}:${option}`]);
      await importStub(s, 'a', '2032-03-31');
      const later = all(s.db, "SELECT * FROM tax_payments WHERE date = '2032-03-31' ORDER BY amount");
      assert.deepEqual(later.map((t) => [t.payer, t.recipient, t.source_slot.split(':').at(-1)]), [
        [`paystub:${key()}:2032-03-31:500000:${option}`, option, option], [`paystub:${key()}:2032-03-31:500000:${option}`, option, option],
      ]);
      for (const t of later) assert.equal(t.dedupe_key, rekeyed(t));
      assert.equal(recipientQuestions(s.db).length, 0, 'nothing new is asked');
    }));
  }

  test('a remembered both and document answer: a later identical document is asked about on its own and the answered one is kept', () => withStore(async (s) => {
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
    assert.deepEqual(active(s.db).map((t) => t.payer), [`${base}:doc:${b}`, `${base}:doc:${b}`, `${base}:owner`, `${base}:owner`]);

    C.answer(s.db, docs[0].id, 'spouse', { now: NOW });
    assert.deepEqual(active(s.db).map((t) => [t.payer, t.file_id]), [[`${base}:owner`, a], [`${base}:owner`, a], [`${base}:spouse`, b], [`${base}:spouse`, b]]);
    assert.equal(recipientQuestions(s.db).length, 0);
  }));
});

// D6 with G6 to G8: a PDF whose text layer has any text is read with pdfjs (in a worker) and goes
// to the model as redacted text, like a text file; only an image-only PDF goes as a document. A PDF
// pdfjs cannot read completely (failed or incomplete) waits as needs_extraction with note
// pdf_unreadable and is never sent. counts.extractPath records the path. pdfText's own outcomes are
// in pdftext.test.mjs.
describe('PDF text layer (D6)', () => {
  const LINES = [
    'SYNTHETIC BROKERAGE STATEMENT',
    'Example Bank brokerage account statement for the period ending March 31, 2032.',
    'Account holder SSN 123-45-6789',
    'Account number 000123456789',
    'Ending balance $123456.78',
    'This synthetic statement exists only to exercise the text layer reader in tests.',
    'Holdings are listed for illustration and carry no real market data whatsoever.',
  ];
  const classify = [{ docType: 'statement', confidence: 0.9 }];

  test('the helper PDFs are what pdfjs reads: text on the text page, none on the image page', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const read = async (bytes) => {
      const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
      const page = await doc.getPage(1);
      const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
      return { pages: doc.numPages, text };
    };
    const t = await read(textPdf(LINES));
    assert.equal(t.pages, 1);
    for (const line of LINES) assert.ok(t.text.includes(line), `pdfjs reads: ${line}`);
    const i = await read(imagePdf());
    assert.equal(i.pages, 1);
    assert.equal(i.text.trim(), '');
  });

  test('a text-layer PDF reaches the engine as redacted text only and imports with pdf_text_layer', () => withStore(async (s) => {
    const engine = await recordingEngine([classify, [{ ...STATEMENT, endingBalance: '#A1#', holdings: [] }]]);
    const r = await P.ingestFile(s.db, { name: 'statement-text-2032-03.pdf', bytes: textPdf(LINES), mime: 'application/pdf' }, s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(engine.extracts.length, 2);
    assert.ok(engine.extracts.every((x) => x.document.type === 'text' && !('data' in x.document)), 'never a PDF block');
    assert.equal(r.counts.extractPath, 'pdf_text_layer');
    const sent = engine.sent();
    assert.doesNotMatch(sent, /\d{5,}/);
    for (const raw of ['123-45-6789', '000123456789', '123456']) assert.ok(!sent.includes(raw), `${raw} never sent`);
    assert.ok(sent.includes('XXX-XX-XXXX'));
    assert.ok(engine.extracts[1].document.text.includes('#A1#'));
    assert.deepEqual(all(s.db, 'SELECT amount FROM balances').map((b) => b.amount), [123456.78], 'the token resolves in code');
  }));

  test('an image-only PDF goes as a PDF document with pdf_document; a text file reports text', () => withStore(async (s) => {
    const bytes = imagePdf();
    const engine = await recordingEngine([classify, [STATEMENT]]);
    const r = await P.ingestFile(s.db, { name: 'statement-scan-2032-03.pdf', bytes, mime: 'application/pdf' }, s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(r.counts.extractPath, 'pdf_document');
    assert.equal(engine.extracts[0].document.type, 'pdf');
    assert.ok(Buffer.from(engine.extracts[0].document.data).equals(Buffer.from(bytes)));
    const t = await P.ingestFile(s.db, paystubFile(), s.opts(await fakeEngine(paystubResponses(PAYSTUB))));
    assert.equal(t.counts.extractPath, 'text');
  }));

  // G6: a short statement (fewer than 200 letters) still goes as redacted text, never as a PDF.
  test('a short text-layer statement with an account number and an SSN-like pattern goes as redacted text', () => withStore(async (s) => {
    const SHORT = ['Statement', 'Acct 000123456789', 'SSN 123-45-6789', 'Balance $1500.25'];
    assert.ok((SHORT.join(' ').match(/\p{L}/gu) ?? []).length < 200);
    const engine = await recordingEngine([classify, [{ ...STATEMENT, endingBalance: '#A1#', holdings: [] }]]);
    const r = await P.ingestFile(s.db, { name: 'statement-short-2032-03.pdf', bytes: textPdf(SHORT), mime: 'application/pdf' }, s.opts(engine));
    assert.equal(r.status, 'imported');
    assert.equal(r.counts.extractPath, 'pdf_text_layer');
    assert.equal(engine.extracts.length, 2);
    assert.ok(engine.extracts.every((x) => x.document.type === 'text' && !('data' in x.document)), 'never a PDF block');
    const sent = engine.sent();
    for (const raw of ['000123456789', '123-45-6789', '1500.25']) assert.ok(!sent.includes(raw), `${raw} never sent`);
    assert.doesNotMatch(sent, /\d{5,}/);
    assert.deepEqual(all(s.db, 'SELECT amount FROM balances').map((b) => b.amount), [1500.25]);
  }));

  // G6 and G8: failed (malformed, partial-text error) and incomplete (over 50 pages, output cap)
  // PDFs are withheld: needs_extraction, note pdf_unreadable, extractPath pdf_withheld, no engine call.
  const withheld = [
    ['a malformed PDF', 'malformed', () => malformedPdf()],
    ['a 51-page PDF', 'pages-51', () => multiPagePdf(51)],
    ['a PDF whose second content stream is corrupt', 'partial', () => partialTextPdf(['Synthetic readable line before the corrupt stream'])],
    ['a PDF whose stream inflates past the 2 MB text cap', 'text-bomb', () => inflateBombPdf({ inflatedBytes: 8 * 1024 * 1024, fill: 'text' })],
  ];
  for (const [what, tag, make] of withheld) {
    test(`${what} is withheld: needs_extraction, pdf_unreadable, pdf_withheld and never reaches the engine`, () => withStore(async (s) => {
      const engine = await recordingEngine([classify, [STATEMENT]]);
      const r = await P.ingestFile(s.db, { name: `statement-${tag}.pdf`, bytes: await make(), mime: 'application/pdf' }, s.opts(engine));
      assert.equal(r.status, 'needs_extraction');
      assert.equal(r.counts.extractPath, 'pdf_withheld');
      assert.equal(engine.extracts.length, 0, 'nothing is sent to the model');
      assert.equal(engine.calls.length, 0);
      const f = one(s.db, 'SELECT status, note FROM files WHERE id = ?', r.fileId);
      assert.deepEqual([f.status, f.note], ['needs_extraction', 'pdf_unreadable']);
      for (const table of ['documents', 'balances', 'positions', 'accounts']) assert.equal(count(s.db, table), 0, `${table} untouched`);
    }));
  }
});

// D7: Unicode minus forms directly before a digit or `$` count as a minus sign; prose dashes stay.
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

  test('each minus form yields a negative stored balance through extraction', () => withStore(async (s) => {
    for (const [i, m] of MINUS.entries()) {
      const file = textFile(`statement-minus-${hex(m)}.txt`, `SYNTHETIC STATEMENT\nEnding balance ${m}$123456.78\n`, 'text/plain');
      const engine = await fakeEngine([[{ docType: 'statement', confidence: 0.9 }], [{ ...STATEMENT, accountLast4: `900${i}`, endingBalance: '#A1#', holdings: [] }]]);
      const r = await P.ingestFile(s.db, file, s.opts(engine));
      assert.equal(r.status, 'imported');
      const acct = one(s.db, 'SELECT id FROM accounts WHERE mask = ?', `900${i}`);
      assert.deepEqual(all(s.db, 'SELECT amount FROM balances WHERE account_id = ?', acct.id).map((b) => b.amount), [-123456.78], `U+${hex(m)}`);
    }
  }));
});
