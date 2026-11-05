// PDFs and unknown text: one classify call, then one extraction call with a per-type JSON Schema.
// Text reaches the model through redactForExtraction (identifiers masked, long money amounts
// swapped for opaque tokens that code resolves back). A PDF whose text layer holds any text
// (pdftext.mjs) is read the same way; an image-only PDF cannot be redacted and goes as a document,
// so no schema ever asks for an identifier (SSN, EIN, TIN, account numbers, people's names,
// addresses). A PDF that cannot be read completely is withheld and never sent. Extracted values
// become rows only through the deterministic code below, after schema and code validation.

import { createHash } from 'node:crypto';
import { redactForExtraction } from './redact.mjs';
import { pdfText } from './pdftext.mjs';
import { isoDate, number, cents, institution, text as decodeText } from './format.mjs';
import { normalizeName } from './confirm.mjs';

export const DOC_TYPES = Object.freeze(['paystub', 'w2', '1099-int', '1099-div', '1099-b', '1099-nec', '1099-misc', 'k1', 'form1040', 'statement', 'plan', 'notes', 'other']);

// Frozen fact keys (docs/architecture.md, Facts) and their value types.
export const FACT_TYPES = Object.freeze({
  'household.state': 'state',
  'household.filingStatus': 'filingStatus',
  'household.dependents': 'int',
  'household.expectingChild': 'bool',
  'household.dependentAges': 'intList',
  'income.w2': 'bool',
  'income.sCorp': 'bool',
  'income.selfEmployed': 'bool',
  'income.partnership': 'bool',
  'income.agiEstimate': 'number',
  'benefits.hsa': 'bool',
  'benefits.employer401k': 'bool',
  'retirement.solo401k': 'bool',
  'retirement.ira': 'bool',
  'retirement.backdoorRothCandidate': 'bool',
  'accounts.has529': 'bool',
  'giving.charitable': 'bool',
  'giving.annualEstimate': 'number',
});
export const FROZEN_FACT_KEYS = Object.freeze(Object.keys(FACT_TYPES));
const FILING_STATUSES = ['mfj', 'mfs', 'single', 'hoh', 'qss'];

const TOKEN = /^#A[0-9]+#$/;
const AMOUNT = () => ({ anyOf: [{ type: 'number' }, { type: 'string', pattern: '^#A[0-9]+#$' }] });
const STR = () => ({ type: 'string' });
const INT = () => ({ type: 'integer' });
const NUM = () => ({ type: 'number' });
const BOOL = () => ({ type: 'boolean' });
const CONFIDENCE = () => ({ type: 'number', minimum: 0, maximum: 1 });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const CLASSIFY_SCHEMA = obj({ docType: { type: 'string', enum: [...DOC_TYPES] }, taxYear: INT(), confidence: CONFIDENCE() }, ['docType', 'confidence']);

const form1099 = (amounts) => obj({ taxYear: INT(), payerKind: STR(), payerName: STR(), ...Object.fromEntries(amounts.map((a) => [a, AMOUNT()])), federalWithheld: AMOUNT(), confidence: CONFIDENCE() }, ['taxYear', 'confidence']);

export const SCHEMAS = Object.freeze({
  paystub: obj({
    payDate: STR(), periodStart: STR(), periodEnd: STR(), employerName: STR(), gross: AMOUNT(), net: AMOUNT(),
    federalWithholding: AMOUNT(), stateWithholding: AMOUNT(), state: STR(), socialSecurity: AMOUNT(), medicare: AMOUNT(),
    retirementDeferral: AMOUNT(), hsaDeferral: AMOUNT(), ytdGross: AMOUNT(), confidence: CONFIDENCE(),
  }, ['payDate', 'confidence']),
  w2: obj({
    taxYear: INT(), employerName: STR(), wages: AMOUNT(), federalWithheld: AMOUNT(), socialSecurityWages: AMOUNT(), medicareWages: AMOUNT(),
    state: STR(), stateWages: AMOUNT(), stateWithheld: AMOUNT(), retirementPlan: BOOL(),
    box12: { type: 'array', items: obj({ code: STR(), amount: AMOUNT() }, ['code', 'amount']) }, confidence: CONFIDENCE(),
  }, ['taxYear', 'confidence']),
  '1099-int': form1099(['interest', 'earlyWithdrawalPenalty']),
  '1099-div': form1099(['ordinaryDividends', 'qualifiedDividends', 'capitalGainDistributions']),
  '1099-b': form1099(['proceeds', 'costBasis', 'shortTermGain', 'longTermGain']),
  '1099-nec': form1099(['nonemployeeCompensation']),
  '1099-misc': form1099(['rents', 'royalties', 'otherIncome']),
  k1: obj({
    taxYear: INT(), entityKind: { type: 'string', enum: ['partnership', 's_corp'] }, ordinaryIncome: AMOUNT(), guaranteedPayments: AMOUNT(),
    selfEmploymentEarnings: AMOUNT(), distributions: AMOUNT(), confidence: CONFIDENCE(),
  }, ['taxYear', 'entityKind', 'confidence']),
  form1040: obj({
    taxYear: INT(), filingStatus: { type: 'string', enum: FILING_STATUSES }, dependents: INT(), state: STR(), agi: AMOUNT(),
    taxableIncome: AMOUNT(), totalTax: AMOUNT(), payments: AMOUNT(), confidence: CONFIDENCE(),
  }, ['taxYear', 'confidence']),
  statement: obj({
    institution: STR(), accountLast4: { type: 'string', pattern: '^[0-9]{4}$' }, accountKind: STR(), periodEnd: STR(), endingBalance: AMOUNT(),
    holdings: { type: 'array', items: obj({ symbol: STR(), name: STR(), quantity: AMOUNT(), value: AMOUNT() }, ['symbol', 'value']) },
    confidence: CONFIDENCE(),
  }, ['periodEnd', 'confidence']),
  plan: obj({
    planType: { type: 'string', enum: ['401k', '403b', '457', 'simple_ira', 'sep_ira', 'solo_401k', 'hsa', 'fsa', 'pension', 'other'] },
    employerMatch: STR(), matchPercent: NUM(), matchLimitPercent: NUM(), employeeLimit: AMOUNT(), catchUpLimit: AMOUNT(), planYear: INT(),
    confidence: CONFIDENCE(),
  }, ['planType', 'confidence']),
  notes: obj({
    facts: { type: 'array', items: obj({ key: { type: 'string', enum: [...FROZEN_FACT_KEYS] }, value: STR(), confidence: CONFIDENCE() }, ['key', 'value', 'confidence']) },
    goals: { type: 'array', items: obj({ title: STR(), when: STR(), confidence: CONFIDENCE() }, ['title', 'confidence']) },
  }, ['facts', 'goals']),
});

const SOURCE_KIND = { paystub: 'paystub', w2: 'tax_doc', '1099-int': 'tax_doc', '1099-div': 'tax_doc', '1099-b': 'tax_doc', '1099-nec': 'tax_doc', '1099-misc': 'tax_doc', k1: 'tax_doc', form1040: 'tax_doc', statement: 'statement', plan: 'other', notes: 'notes', other: 'other' };
export const sourceKindOf = (docType) => SOURCE_KIND[docType] ?? 'other';

const LABELS = { paystub: 'Paystub', w2: 'W-2', '1099-int': '1099-INT', '1099-div': '1099-DIV', '1099-b': '1099-B', '1099-nec': '1099-NEC', '1099-misc': '1099-MISC', k1: 'K-1', form1040: 'Form 1040', statement: 'Account statement', plan: 'Plan summary', notes: 'Markdown notes', other: 'Document' };
export const labelOf = (docType) => LABELS[docType] ?? 'Document';

const CLASSIFY_SYSTEM = 'Classify this household financial document. Choose the closest docType; use other when none fits. '
  + 'Give the tax year only when the document states one. Some numbers are masked or replaced by tokens like #A1# on purpose.';
const extractSystem = (docType) => `Extract the fields of this ${labelOf(docType)} exactly as the document states them. `
  + 'Leave out any field the document does not state; never guess. Use ISO dates (YYYY-MM-DD). '
  + 'Where an amount appears as a token like #A1#, return the token string itself for that amount. '
  + 'Business names only: never return a person\'s name, an address or an identifying number.';

// First 12 hex of sha256 of a normalized business name; an absent name hashes 'unknown'.
export const nameKey = (name) => createHash('sha256').update(normalizeName(name) || 'unknown').digest('hex').slice(0, 12);
const centsOf = (value) => (Number.isFinite(value) ? String(Math.round(value * 100)) : 'na');
const isIso = (value) => typeof value === 'string' && isoDate(value) === value;
const positive = (value) => Number.isFinite(value) && value > 0;

// Replace amount tokens with numbers from refs. An unknown token drops its field with a warning.
export function resolveTokens(value, refs = {}, warnings = [], path = '') {
  if (typeof value === 'string' && TOKEN.test(value)) {
    const raw = Object.hasOwn(refs, value) ? number(refs[value]) : null;
    if (raw === null) { warnings.push({ code: 'unresolved_amount', locator: { field: path } }); return undefined; }
    return raw;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveTokens(v, refs, warnings, `${path}[${i}]`)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveTokens(v, refs, warnings, path ? `${path}.${k}` : k);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

// Code validation after the schema: dates, years and amounts must be usable.
export function validateExtraction(docType, x) {
  if (!x || typeof x !== 'object') return false;
  for (const v of Object.values(x)) if (typeof v === 'number' && !Number.isFinite(v)) return false;
  const year = (y) => Number.isInteger(y) && y >= 1900 && y <= 2200;
  switch (docType) {
    case 'paystub': return isIso(x.payDate) && (x.periodStart === undefined || isIso(x.periodStart)) && (x.periodEnd === undefined || isIso(x.periodEnd));
    case 'statement': return isIso(x.periodEnd);
    case 'notes': return Array.isArray(x.facts) && Array.isArray(x.goals);
    case 'plan': return x.planYear === undefined || year(x.planYear);
    default: return year(x.taxYear);
  }
}

function parseFactValue(key, raw) {
  const type = FACT_TYPES[key];
  const s = String(raw ?? '').trim();
  switch (type) {
    case 'bool': return /^(true|yes|y)$/i.test(s) ? true : /^(false|no|n)$/i.test(s) ? false : undefined;
    case 'int': { const n = number(s); return n !== null && Number.isInteger(n) && n >= 0 ? n : undefined; }
    case 'number': { const n = number(s); return n === null ? undefined : n; }
    case 'intList': {
      const parts = s.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean).map(Number);
      return parts.length && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : undefined;
    }
    case 'state': return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : undefined;
    case 'filingStatus': return FILING_STATUSES.includes(s.toLowerCase()) ? s.toLowerCase() : undefined;
    default: return undefined;
  }
}

const fact = (key, value, confidence, locator, extra = {}) => ({ kind: 'fact', key, value, confidence, locator, ...extra });

// Withholding slot wh:<payerKey>:<taxYear>:<jurisdiction>:<recipient>. The recipient starts
// unknown and the pipeline resolves it per document: for employer withholding (paystub, W-2) from
// the employer_recipient and document_recipient answers (employerKey and employer carry what it
// needs), for a 1099 from its own document_recipient answer (issuer names the payer).
function withholding({ docType, jurisdiction, amount, date, datePrecision, taxYear, basis, payer, slotKey, field, employer, issuer }) {
  return {
    kind: 'tax_payment', jurisdiction, amount: cents(amount), paymentKind: 'withholding', date, datePrecision, taxYear, sheetYear: taxYear,
    taxYearBasis: basis, payer, recipient: 'unknown', sourceSlot: `wh:${slotKey}:${taxYear}:${normalizeName(jurisdiction)}:unknown`,
    ...(employer !== undefined ? { employerKey: slotKey, employer } : { issuer: issuer ?? '' }), locator: { document: docType, field },
  };
}

// Employer-dependent facts: resolved to household when the employer is a known household entity;
// otherwise held for an employer_relation answer.
function employerFacts(docType, x, { entities = [] }, benefits) {
  const name = String(x.employerName ?? '').trim();
  const key = nameKey(name);
  const confidence = x.confidence;
  const locator = { document: docType, field: 'employerName' };
  const household = Boolean(name) && entities.some((e) => normalizeName(e) === normalizeName(name));
  if (household) return [fact('income.sCorp', true, confidence, locator)];
  const hold = { hold: `employer:${key}`, employerKey: key, employerName: name };
  return [
    fact('income.w2', true, confidence, locator, hold),
    ...(benefits.employer401k ? [fact('benefits.employer401k', true, confidence, { document: docType, field: benefits.employer401k }, hold)] : []),
    ...(benefits.hsa ? [fact('benefits.hsa', true, confidence, { document: docType, field: benefits.hsa }, hold)] : []),
  ];
}

// Deterministic rows from validated, token-resolved fields. ctx = {fileId, households: {entities},
// warnings?}: warnings (codes only) are pushed onto ctx.warnings when given.
export function toRows(docType, extracted, ctx = {}) {
  const x = extracted ?? {};
  const warnings = ctx.warnings ?? [];
  const households = ctx.households ?? {};
  const rows = [];
  const doc = (fields, taxYear) => rows.push({ kind: 'document', docType: docType === 'plan' ? 'plan' : docType, ...(taxYear !== undefined ? { taxYear } : {}), fields, locator: { document: docType } });
  switch (docType) {
    case 'paystub': {
      const year = Number(x.payDate.slice(0, 4));
      doc(x, year);
      const key = nameKey(x.employerName);
      const payer = `paystub:${key}:${x.payDate}:${centsOf(x.gross)}`;
      const base = { docType, date: x.payDate, datePrecision: 'day', taxYear: year, basis: 'pay_date', payer, slotKey: key, employer: String(x.employerName ?? '').trim() };
      if (positive(x.federalWithholding)) rows.push(withholding({ ...base, jurisdiction: 'federal', amount: x.federalWithholding, field: 'federalWithholding' }));
      if (positive(x.stateWithholding)) rows.push(withholding({ ...base, jurisdiction: stateCode(x.state), amount: x.stateWithholding, field: 'stateWithholding' }));
      rows.push(...employerFacts(docType, x, households, {
        employer401k: positive(x.retirementDeferral) ? 'retirementDeferral' : null,
        hsa: positive(x.hsaDeferral) ? 'hsaDeferral' : null,
      }));
      break;
    }
    case 'w2': {
      doc(x, x.taxYear);
      const key = nameKey(x.employerName);
      const payer = `w2:${key}:${x.taxYear}:${centsOf(x.wages)}`;
      const base = { docType, date: `${x.taxYear}-12-31`, datePrecision: 'year', taxYear: x.taxYear, basis: 'annual_total', payer, slotKey: key, employer: String(x.employerName ?? '').trim() };
      if (positive(x.federalWithheld)) rows.push(withholding({ ...base, jurisdiction: 'federal', amount: x.federalWithheld, field: 'federalWithheld' }));
      if (positive(x.stateWithheld)) rows.push(withholding({ ...base, jurisdiction: stateCode(x.state), amount: x.stateWithheld, field: 'stateWithheld' }));
      const codes = (x.box12 ?? []).filter((b) => positive(b.amount)).map((b) => String(b.code).trim().toUpperCase());
      rows.push(...employerFacts(docType, x, households, {
        employer401k: x.retirementPlan === true ? 'retirementPlan' : codes.some((c) => ['D', 'E', 'G', 'S'].includes(c)) ? 'box12' : null,
        hsa: codes.includes('W') ? 'box12' : null,
      }));
      break;
    }
    case '1099-int': case '1099-div': case '1099-b': case '1099-nec': case '1099-misc': {
      doc(x, x.taxYear);
      const primary = { '1099-int': x.interest, '1099-div': x.ordinaryDividends, '1099-b': x.proceeds, '1099-nec': x.nonemployeeCompensation,
        '1099-misc': [x.rents, x.royalties, x.otherIncome].find((v) => Number.isFinite(v) && v !== 0) }[docType];
      const key = nameKey(x.payerName);
      if (positive(x.federalWithheld)) {
        rows.push(withholding({ docType, jurisdiction: 'federal', amount: x.federalWithheld, date: `${x.taxYear}-12-31`, datePrecision: 'year', taxYear: x.taxYear,
          basis: 'form_year', payer: `${docType}:${key}:${x.taxYear}:${centsOf(primary)}`, slotKey: key, field: 'federalWithheld', issuer: String(x.payerName ?? '').trim() }));
      }
      if (docType === '1099-nec') rows.push(fact('income.selfEmployed', true, x.confidence, { document: docType, field: 'nonemployeeCompensation' }));
      break;
    }
    case 'k1':
      doc(x, x.taxYear);
      rows.push(fact(x.entityKind === 's_corp' ? 'income.sCorp' : 'income.partnership', true, x.confidence, { document: docType, field: 'entityKind' }));
      break;
    case 'form1040': {
      doc(x, x.taxYear);
      const at = (field) => ({ document: docType, field });
      if (FILING_STATUSES.includes(x.filingStatus)) rows.push(fact('household.filingStatus', x.filingStatus, x.confidence, at('filingStatus')));
      if (Number.isInteger(x.dependents) && x.dependents >= 0) rows.push(fact('household.dependents', x.dependents, x.confidence, at('dependents')));
      const state = parseFactValue('household.state', x.state);
      if (state !== undefined) rows.push(fact('household.state', state, x.confidence, at('state')));
      if (Number.isFinite(x.agi)) rows.push(fact('income.agiEstimate', cents(x.agi), x.confidence, at('agi')));
      break;
    }
    case 'statement': {
      doc(x);
      const account = () => ({ inst: institution(x.institution ?? ''), mask: x.accountLast4 ?? '', ...(x.accountKind ? { kind: x.accountKind } : {}) });
      if (Number.isFinite(x.endingBalance)) rows.push({ kind: 'balance', account: account(), date: x.periodEnd, amount: cents(x.endingBalance), locator: { document: docType, field: 'endingBalance' } });
      // G5: a holdings list (even an empty one) is a snapshot of the account on periodEnd; without
      // the key the statement says nothing about holdings.
      if (Array.isArray(x.holdings)) rows.push({ kind: 'snapshot', account: account(), asOf: x.periodEnd, locator: { document: docType, field: 'holdings' } });
      (x.holdings ?? []).forEach((h, i) => {
        const symbol = String(h.symbol ?? '').trim();
        if (!symbol || !Number.isFinite(h.value)) { warnings.push({ code: 'invalid_holding', locator: { document: docType, holding: i } }); return; }
        const quantity = Number.isFinite(h.quantity) ? h.quantity : null;
        rows.push({ kind: 'position', account: account(), asOf: x.periodEnd, symbol, name: h.name ?? '', quantity, price: quantity > 0 ? cents(h.value / quantity) : null,
          value: cents(h.value), locator: { document: docType, holding: i } });
      });
      break;
    }
    case 'plan':
      doc(x, x.planYear);
      if (['401k', '403b', '457'].includes(x.planType)) rows.push(fact('benefits.employer401k', true, x.confidence, { document: docType, field: 'planType' }));
      if (x.planType === 'hsa') rows.push(fact('benefits.hsa', true, x.confidence, { document: docType, field: 'planType' }));
      break;
    case 'notes':
      // The pipeline stores the note as a reference to its encrypted file; extraction adds facts and goals.
      (x.facts ?? []).forEach((f, i) => {
        const value = FACT_TYPES[f.key] ? parseFactValue(f.key, f.value) : undefined;
        if (value === undefined) { warnings.push({ code: 'invalid_fact', locator: { document: docType, fact: i } }); return; }
        rows.push(fact(f.key, value, f.confidence, { document: docType, fact: i }));
      });
      (x.goals ?? []).forEach((g, i) => {
        if (!String(g.title ?? '').trim()) return;
        rows.push({ kind: 'document', docType: 'goal', fields: g, locator: { document: docType, goal: i } });
      });
      break;
    default:
      doc(x);
  }
  return rows;
}

const stateCode = (value) => (/^[A-Za-z]{2}$/.test(String(value ?? '').trim()) ? String(value).trim().toUpperCase() : 'state');

// Period grounded in extracted fields (R8).
export function periodOf(docType, x) {
  if (docType === 'paystub') return { from: x.periodStart ?? x.payDate, to: x.payDate };
  if (SOURCE_KIND[docType] === 'tax_doc') return { from: `${x.taxYear}-01-01`, to: `${x.taxYear}-12-31` };
  if (docType === 'statement') return { from: null, to: x.periodEnd };
  return { from: null, to: null };
}

export const isPdf = (file) => /\.pdf$/i.test(file.name ?? '') || /application\/pdf/i.test(file.mime ?? '')
  || (file.bytes?.length >= 5 && Buffer.from(file.bytes.subarray(0, 5)).toString('latin1') === '%PDF-');

// Decoded UTF-8 text without control characters, or null.
export function plainText(file) {
  try {
    const text = decodeText(file);
    return /[\x00-\x08\x0B\x0E-\x1F\x7F]/.test(text) ? null : text;
  } catch { return null; }
}

const waiting = (reason, extractPath) => ({
  status: 'needs_extraction', reason, docType: null, rows: [], sourceKind: null, period: { from: null, to: null }, warnings: [], ...(extractPath ? { extractPath } : {}),
});
const reasonOf = (error) => (error?.name === 'EngineOffError' ? 'engine_off' : 'engine_error');

const engineOff = (engine) => !engine || (typeof engine.isOn === 'function' && !engine.isOn());
const redactedText = (text) => {
  const redacted = redactForExtraction(text);
  return { document: { type: 'text', text: redacted.text }, refs: redacted.refs };
};

// Classify (unless opts.docType forces a type), then extract with the type's schema. The path is
// text (a text file), pdf_text_layer (a PDF with any text, sent as redacted text), pdf_document (an
// image-only PDF, sent as a document) or pdf_withheld (a PDF read incompletely or not at all: it
// waits with reason pdf_unreadable and nothing is sent).
// Returns {status: 'imported', docType, rows, sourceKind, period, warnings, extractPath} or
// {status: 'needs_extraction', reason: 'engine_off' | 'engine_error' | 'invalid' | 'pdf_unreadable', extractPath?, ...}.
export async function extractDocument(engine, file, { docType: forced, households = { entities: [] }, fileId = null } = {}) {
  let document;
  let refs = {};
  let extractPath;
  if (isPdf(file)) {
    if (engineOff(engine)) return waiting('engine_off');
    const layer = await pdfText(file.bytes);
    if (layer.status === 'text') {
      ({ document, refs } = redactedText(layer.text));
      extractPath = 'pdf_text_layer';
    } else if (layer.status === 'image_only') {
      document = { type: 'pdf', data: file.bytes };
      extractPath = 'pdf_document';
    } else return waiting('pdf_unreadable', 'pdf_withheld');
  } else {
    const text = plainText(file);
    if (text === null) return waiting('invalid');
    ({ document, refs } = redactedText(text));
    extractPath = 'text';
  }
  if (engineOff(engine)) return waiting('engine_off', extractPath);
  const failed = (reason) => waiting(reason, extractPath);
  let docType = forced;
  let classifiedYear;
  try {
    if (!docType) {
      const [c] = await engine.extract({ document, schema: CLASSIFY_SCHEMA, system: CLASSIFY_SYSTEM, maxTokens: 256 });
      if (!c || !DOC_TYPES.includes(c.docType)) return failed('invalid');
      docType = c.docType;
      classifiedYear = c.taxYear;
    }
    if (!DOC_TYPES.includes(docType)) return failed('invalid');
    const warnings = [];
    if (docType === 'other') {
      const sha = createHash('sha256').update(file.bytes).digest('hex');
      const fields = { sha256: sha };
      return { status: 'imported', docType, rows: [{ kind: 'document', docType: 'other', ...(Number.isInteger(classifiedYear) ? { taxYear: classifiedYear } : {}), fields, locator: { document: 'other' } }],
        sourceKind: 'other', period: { from: null, to: null }, warnings, extractPath };
    }
    const [raw] = await engine.extract({ document, schema: SCHEMAS[docType], system: extractSystem(docType), maxTokens: 4096 });
    if (!raw) return failed('invalid');
    const extracted = resolveTokens(raw, refs, warnings);
    if (!validateExtraction(docType, extracted)) return failed('invalid');
    const rows = toRows(docType, extracted, { fileId, households, warnings });
    return { status: 'imported', docType, rows, sourceKind: sourceKindOf(docType), period: periodOf(docType, extracted), warnings, extractPath };
  } catch (error) {
    return failed(reasonOf(error));
  }
}
