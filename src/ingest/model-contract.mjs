import Ajv from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import { FACT_TYPES, SCHEMAS } from './extract.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const positive = { type: 'integer', minimum: 1 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const choice = (...values) => ({ type: 'string', enum: values });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const refIds = { type: 'array', items: string, minItems: 1, uniqueItems: true };
const precision = choice('exact', 'cent', 'dollar', 'day', 'month', 'year', 'unknown');
const datePrecision = choice('day', 'month', 'year', 'unknown');
const baseRef = { fileId: string, sha256: hash, rawHash: hash, valueType: choice('number', 'text', 'boolean', 'date', 'empty', 'error'), precision };
export const SOURCE_REF_SCHEMA = { oneOf: [
  object({ ...baseRef, sheet: object({ index: { type: 'integer', minimum: 0 }, nameRef: string }),
    cell: { type: 'string', pattern: '^[A-Z]+[1-9][0-9]*$' }, row: positive, column: positive,
    formula: { type: 'boolean' }, cached: { type: 'boolean' }, mergedAnchor: string, hidden: { type: 'boolean' } },
  [...Object.keys(baseRef), 'sheet', 'cell', 'row', 'column', 'formula', 'cached']),
  object({ ...baseRef, row: positive, column: positive, headerRef: string }),
  object({ ...baseRef, page: positive, line: positive, byteStart: { type: 'integer', minimum: 0 }, byteEnd: positive },
    [...Object.keys(baseRef), 'line', 'byteStart', 'byteEnd']),
] };

export const TRANSFORM_SCHEMA = { oneOf: [
  ...['identity', 'trim', 'sum', 'debit_credit'].map(op => object({ op: { const: op } })),
  ...['date_decode', 'month_anchor'].map(op => object({ op: { const: op }, locale: choice('iso', 'en-US', 'en-GB'), epoch: choice('1900', '1904') })),
  object({ op: { const: 'currency_decode' }, currency: { const: 'USD' } }),
  object({ op: { const: 'sign' }, mode: choice('as_is', 'negate') }),
] };
export const FIELD_SCHEMA = object({ refs: refIds, transform: TRANSFORM_SCHEMA });
const fields = (required, optional = [], nullableFields = []) => object(Object.fromEntries(
  [...required, ...optional, ...nullableFields].map(k => [k, nullableFields.includes(k) ? nullable(FIELD_SCHEMA) : FIELD_SCHEMA])), required);
const target = (name, fieldSchema, extra = {}, requiredExtra = Object.keys(extra)) => object(
  { target: { const: name }, fields: fieldSchema, ...extra }, ['target', 'fields', ...requiredExtra]);

function citedShape(schema) {
  if (schema.type === 'array') return { type: 'array', items: citedShape(schema.items) };
  if (schema.type === 'object') return object(Object.fromEntries(Object.entries(schema.properties)
    .filter(([key]) => key !== 'confidence').map(([key, value]) => [key, citedShape(value)])),
  (schema.required ?? []).filter(key => key !== 'confidence'));
  return FIELD_SCHEMA;
}

export const TARGET_SCHEMAS = Object.freeze({
  transaction: target('transaction', fields(['accountId', 'postedDate', 'amount', 'description'], ['category', 'externalId'])),
  balance: target('balance', fields(['accountId', 'asOf', 'amount']), { basis: choice('running', 'closing'), datePrecision }),
  pnl: target('pnl', fields(['entity', 'period', 'category', 'amount', 'basis'], [], ['basis']), { purpose: choice('business', 'household_spending') }),
  fact: target('fact', fields(['value', 'asOf', 'subject']), { key: choice(...Object.keys(FACT_TYPES)), scope: choice('household', 'person', 'entity', 'account'), datePrecision }),
  tax_payment: target('tax_payment', fields(['jurisdiction', 'payer', 'recipient', 'amount', 'taxYear', 'taxYearBasis', 'paymentDate']),
    { kind: choice('estimate', 'withholding', 'extension', 'return', 'other'), status: choice('paid', 'required'), datePrecision }),
  account_metadata: target('account_metadata', fields(['alias', 'institution', 'mask', 'kind', 'holder', 'accountId'])),
  position: target('position', fields(['accountId', 'asOf', 'symbol', 'quantity', 'value'], ['name', 'price', 'costBasis'])),
  document: { oneOf: Object.entries(SCHEMAS).filter(([name]) => !['notes', 'other'].includes(name)).map(([docType, schema]) =>
    target('document', citedShape(schema), { docType: { const: docType } })) },
  expected_transaction: target('expected_transaction', fields(['subject', 'dueDate', 'statement', 'actor'], ['accountId'], ['amount']),
    { direction: choice('inflow', 'outflow'), status: choice('expected', 'observed', 'cancelled'), datePrecision }),
});

export const PROPOSAL_SCHEMA = object({
  version: positive, fileId: string, sha256: hash, proposalId: string, interpreterVersion: string,
  mappingId: nullable(string), mappingVersion: nullable(positive),
  rows: { type: 'array', items: { oneOf: Object.values(TARGET_SCHEMAS) } },
  coverage: { type: 'array', items: object({ regionId: string,
    disposition: choice('imported_detail', 'control_total', 'duplicate_summary', 'forecast', 'explanatory_text', 'unresolved', 'empty', 'error', 'uncached_formula', 'hidden', 'excluded'),
    refs: refIds, reason: FIELD_SCHEMA }, ['regionId', 'disposition', 'refs']) },
  completeness: choice('complete', 'incomplete'),
});

export const LOCATOR_SCHEMA = object({
  version: positive, fileId: string, proposalId: string, mappingId: nullable(string), mappingVersion: nullable(positive),
  interpreterVersion: string, fields: { type: 'object', additionalProperties: FIELD_SCHEMA },
  derivedFrom: { type: 'array', items: SOURCE_REF_SCHEMA, minItems: 1 }, completeness: choice('complete', 'incomplete'),
});

const ajv = new Ajv({ allErrors: true, strict: true });
const checkProposal = ajv.compile(PROPOSAL_SCHEMA);
const checkRef = ajv.compile(SOURCE_REF_SCHEMA);
const result = errors => ({ valid: errors.length === 0, errors });
const schemaErrors = check => (check.errors ?? []).map(e => `${e.instancePath || '/'}: ${e.keyword}`);

function refErrors(ref, source) {
  if (!checkRef(ref)) return schemaErrors(checkRef);
  const errors = [];
  if (ref.fileId !== source.fileId || ref.sha256 !== source.sha256) errors.push('source_mismatch');
  if (ref.sheet) {
    let column = 0;
    for (const char of ref.cell.match(/^[A-Z]+/)[0]) column = column * 26 + char.charCodeAt(0) - 64;
    if (column !== ref.column || Number(ref.cell.match(/[0-9]+$/)[0]) !== ref.row) errors.push('coordinate_mismatch');
  } else if (Object.hasOwn(ref, 'byteStart') && ref.byteEnd <= ref.byteStart) errors.push('invalid_span');
  return errors;
}

export function validateSourceRef(ref, source) {
  const errors = refErrors(ref, source);
  if (!Object.values(source.refs).some(expected => isDeepStrictEqual(expected, ref))) errors.push('reference_mismatch');
  return result(errors);
}

// The caller supplies its local source index. Model proposals contain opaque ref ids only.
export function validateProposal(proposal, source) {
  if (!checkProposal(proposal)) return result(schemaErrors(checkProposal));
  const errors = [];
  if (proposal.fileId !== source.fileId || proposal.sha256 !== source.sha256) errors.push('source_mismatch');
  if ((proposal.mappingId === null) !== (proposal.mappingVersion === null)) errors.push('mapping_version_mismatch');
  function refs(ids, supportingValue = true) {
    for (const id of ids) {
      const ref = Object.hasOwn(source.refs, id) ? source.refs[id] : null;
      if (!ref) { errors.push('unknown_reference'); continue; }
      errors.push(...refErrors(ref, source));
      if (supportingValue && (['error', 'empty'].includes(ref.valueType) || ref.formula && !ref.cached)) errors.push('unusable_reference');
    }
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'refs') && Object.hasOwn(value, 'transform')) {
      refs(value.refs);
      const n = value.refs.length, op = value.transform.op;
      if (op === 'debit_credit' ? n !== 2 : op === 'month_anchor' ? n > 2 : op !== 'sum' && n !== 1) errors.push('transform_arity');
    } else for (const child of Object.values(value)) visit(child);
  }
  for (const row of proposal.rows) visit(row.fields);
  const seen = new Set();
  for (const region of proposal.coverage) {
    if (!source.regions.includes(region.regionId) || seen.has(region.regionId)) errors.push('unknown_or_duplicate_region');
    seen.add(region.regionId);
    refs(region.refs, !['empty', 'error', 'uncached_formula', 'unresolved'].includes(region.disposition));
    if (!['imported_detail', 'control_total', 'unresolved'].includes(region.disposition) && !region.reason) errors.push('missing_exclusion_reason');
    if (region.reason) visit(region.reason);
    if (proposal.completeness === 'complete' && region.disposition === 'unresolved') errors.push('unresolved_coverage');
  }
  if (proposal.completeness === 'complete' && source.regions.some(id => !seen.has(id))) errors.push('missing_coverage');
  return result(errors);
}
