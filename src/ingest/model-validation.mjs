import { createHash } from 'node:crypto';
import { validateProposal } from './model-contract.mjs';
import { parseInterpretation } from './model-parse.mjs';
import { resolveField } from './model-source.mjs';
import { persistImport } from './pipeline.mjs';
import { isoDate, number, cents } from './format.mjs';

export const importEffect = validation => Object.fromEntries(['valid', 'errors', 'rows', 'counts', 'bindings', 'identities', 'questions', 'summary'].map(key => [key, validation[key] ?? null]));
const collect = (value, out = []) => {
  if (value?.refs && value.transform) out.push(...value.refs);
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collect(v, out));
  return out;
};
const toCents = value => Math.round(cents(value) * 100);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(value) === value;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const normalize = value => String(value ?? '').trim().toLowerCase();

function accountFor(db, value) {
  const id = db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(value));
  if (id) return id.archived_at === null ? id : null;
  const matches = db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL').all().filter(a => normalize(a.name) === normalize(value));
  return matches.length === 1 ? matches[0] : null;
}

export function importPlan(rows) {
  const dates = rows.map(r => r.date ?? r.asOf ?? (r.period ? r.period + '-01' : null)).filter(Boolean).sort();
  return { status: 'imported', parser: 'model-import', label: 'Reviewed import', sourceKind: 'model_import',
    parsed: { rows, warnings: [], period: { from: dates[0] ?? null, to: dates.at(-1) ?? null } } };
}

export function validateImport(ctx, proposal, source) {
  const checked = validateProposal(proposal, source);
  const errors = [...checked.errors], rows = [], bindings = [], identities = [];
  const fail = reason => ({ valid: false, errors: [...new Set([...errors, reason])], rows, bindings, identities, counts: null, summary: null });
  if (!checked.valid) return fail('invalid_proposal');
  if (source.status !== 'indexed') return fail('needs_source_text');
  if (ctx.db.prepare('SELECT removed_at FROM files WHERE id=?').get(source.fileId)?.removed_at) return fail('source_removed');
  const parsed = parseInterpretation({ rows: proposal.rows, coverage: proposal.coverage, completeness: proposal.completeness, controls: proposal.controls ?? [] }, source);
  if (!parsed.valid) return fail('invalid_source_values');
  if (proposal.completeness !== 'complete') errors.push('incomplete_coverage');
  const used = new Set(collect(proposal.rows)), amountRefs = new Set();
  for (const row of proposal.rows) for (const key of ['amount', 'value', 'quantity']) {
    const refs = row.fields[key]?.refs ?? [];
    for (const ref of refs) {
      const identity = `${row.target}:${key}:${ref}`;
      if (amountRefs.has(identity)) errors.push('reused_detail_reference');
      amountRefs.add(identity);
    }
  }
  for (const region of proposal.coverage) {
    const expected = source.inventory[region.regionId]?.refs ?? [];
    if (region.refs.length !== expected.length || expected.some(id => !region.refs.includes(id))) errors.push('incomplete_region');
    if (region.refs.some(id => source.refs[id].rawHash !== createHash('sha256').update(JSON.stringify(source.values[id])).digest('hex'))) errors.push('source_value_changed');
    if (region.disposition === 'unresolved') errors.push('unresolved_coverage');
    if (['imported_detail', 'control_total'].includes(region.disposition) && region.refs.some(id => source.refs[id].valueType === 'error' || source.refs[id].formula && !source.refs[id].cached)) errors.push('unusable_coverage');
    if (region.reason) {
      try { if (typeof resolveField(source, region.reason) !== 'string' || !resolveField(source, region.reason).trim()) errors.push('invalid_exclusion_reason'); }
      catch { errors.push('invalid_exclusion_reason'); }
    }
    if (region.disposition === 'imported_detail' && region.refs.some(id => number(source.values[id]) !== null && !used.has(id))) errors.push('unmapped_amount');
  }
  for (let i = 0; i < parsed.resolved.length; i++) {
    const row = parsed.resolved[i], f = row.fields, original = proposal.rows[i];
    const derivedFrom = [...new Set(collect(original.fields))].map(id => source.refs[id]);
    const locator = { version: proposal.version, fileId: proposal.fileId, proposalId: proposal.proposalId,
      mappingId: proposal.mappingId, mappingVersion: proposal.mappingVersion, interpreterVersion: proposal.interpreterVersion,
      fields: structuredClone(original.fields), derivedFrom, completeness: proposal.completeness };
    let account = null;
    if (Object.hasOwn(f, 'accountId')) {
      account = accountFor(ctx.db, f.accountId);
      if (!account) errors.push('account_unresolved');
      else {
        bindings.push(account.id);
        identities.push(Object.fromEntries(['id', 'inst', 'mask', 'name', 'owner', 'kind', 'identity'].map(key => [key, account[key]])));
      }
    }
    const base = { locator, ...(account ? { accountId: account.id, account: { inst: account.inst, mask: account.mask, name: account.name },
      ...(account.identity?.startsWith('simplefin:') ? { identity: account.identity } : {}) } : {}) };
    const amount = f.amount;
    if (Object.hasOwn(f, 'amount') && (typeof amount !== 'number' || !Number.isFinite(amount))) errors.push('invalid_amount');
    const date = f.postedDate ?? f.asOf ?? f.paymentDate;
    if (date !== undefined && !day(date)) errors.push('invalid_date');
    if (row.target === 'transaction') rows.push({ ...base, kind: 'transaction', date: f.postedDate, amount, description: String(f.description),
      ...(f.category ? { category: String(f.category) } : {}), ...(f.externalId ? { externalId: String(f.externalId) } : {}) });
    else if (row.target === 'balance') {
      if (row.basis !== 'closing' || row.datePrecision !== 'day') errors.push('balance_basis_unresolved');
      rows.push({ ...base, kind: 'balance', date: f.asOf, amount });
    } else if (row.target === 'position') rows.push({ ...base, kind: 'position', asOf: f.asOf, symbol: String(f.symbol), quantity: f.quantity, value: f.value,
      name: f.name ?? null, price: f.price ?? null, costBasis: f.costBasis ?? null });
    else if (row.target === 'pnl') {
      if (!PERIOD.test(f.period) || !['cash', 'accrual', 'unknown'].includes(f.basis)) errors.push('pnl_context_unresolved');
      const entity = ctx.db.prepare('SELECT entity FROM entity_aliases WHERE alias = ?').get(normalize(f.entity))?.entity;
      if (!entity) errors.push('entity_unresolved');
      else bindings.push(`entity:${entity}`);
      rows.push({ ...base, kind: 'pnl_line', entity, period: f.period, category: String(f.category), amount });
    } else if (row.target === 'tax_payment') {
      if (row.status !== 'paid' || !Number.isInteger(Number(f.taxYear)) || Number(f.taxYear) < 1900 || Number(f.taxYear) > 2200 ||
        !f.taxYearBasis || !['you', 'spouse', 'joint'].includes(f.recipient) || row.datePrecision === 'unknown') errors.push('tax_context_unresolved');
      rows.push({ ...base, kind: 'tax_payment', jurisdiction: String(f.jurisdiction), payer: String(f.payer), recipient: f.recipient,
        amount, taxYear: Number(f.taxYear), sheetYear: Number(f.taxYear), taxYearBasis: String(f.taxYearBasis), date: f.paymentDate, datePrecision: row.datePrecision, paymentKind: row.kind });
    } else errors.push('action_adapter_required');
  }
  const controls = proposal.controls ?? [], controlled = new Set(controls.flatMap(c => c.field.refs));
  for (const region of proposal.coverage.filter(r => r.disposition === 'control_total')) {
    if (!region.refs.some(id => controlled.has(id))) errors.push('missing_control');
  }
  for (const control of controls) {
    try {
      if (control.precision === 'dollar' && !control.field.refs.every(id => source.refs[id]?.precision === 'dollar')) errors.push('rounding_precision_unproven');
      if (!control.field.refs.every(id => proposal.coverage.some(c => c.disposition === 'control_total' && c.refs.includes(id)))) throw new TypeError();
      const total = resolveField(source, control.field);
      const detail = control.rows.reduce((sum, index) => {
        const amount = parsed.resolved[index]?.fields.amount;
        if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError();
        return sum + toCents(amount);
      }, 0);
      const rounded = cents => control.precision === 'dollar' ? Math.round(cents / 100) : cents;
      if (typeof total !== 'number' || !Number.isFinite(total) || rounded(toCents(total)) !== rounded(detail)) errors.push('total_mismatch');
    } catch { errors.push('invalid_control'); }
  }
  if (errors.length) return fail('validation_failed');
  const grouped = new Map();
  const persisted = rows.filter(row => {
    if (row.kind !== 'pnl_line') return true;
    const key = JSON.stringify([row.entity, row.period, row.category]);
    if (!grouped.has(key)) { grouped.set(key, row); return true; }
    const prior = grouped.get(key); prior.amount = (toCents(prior.amount) + toCents(row.amount)) / 100;
    prior.locator.derivedFrom.push(...row.locator.derivedFrom);
    prior.locator.fields.amount.refs.push(...row.locator.fields.amount.refs);
    const signs = value => value.transform.op === 'debit_credit' ? ['negate', 'as_is']
      : value.transform.op === 'sum' ? value.transform.signs ?? value.refs.map(() => 'as_is') : [value.transform.mode === 'negate' ? 'negate' : 'as_is'];
    const first = prior.locator.fields.amount, second = row.locator.fields.amount;
    const initial = { ...first, refs: first.refs.slice(0, -second.refs.length) };
    first.transform = { op: 'sum', signs: [...signs(initial), ...signs(second)] };
    return false;
  });
  let counts, questions;
  ctx.db.exec('SAVEPOINT import_preview');
  try {
    counts = persistImport(ctx.db, source.fileId, { name: 'Reviewed import', bytes: source.bytes }, importPlan(structuredClone(persisted)), { now: new Date(typeof ctx.now === 'function' ? ctx.now() : ctx.now ?? Date.now()).toISOString() }).result.counts;
    questions = ctx.db.prepare('SELECT kind,subject,question,options,context,status FROM confirm_items WHERE file_id=? ORDER BY kind,subject').all(source.fileId).map(row => ({ ...row }));
  } catch { errors.push('persistence_refused'); }
  finally { ctx.db.exec('ROLLBACK TO import_preview'); ctx.db.exec('RELEASE import_preview'); }
  if (errors.length) return fail('validation_failed');
  return { valid: true, errors: [], rows: persisted, bindings: [...new Set(bindings)].sort(), identities, questions, counts,
    summary: { rows: proposal.rows.length, amount: parsed.resolved.reduce((n, row) => n + toCents(row.fields.amount ?? 0), 0) / 100,
      totalStatus: controls.length ? 'totals_match' : 'no_sheet_total', totalMessage: controls.length ? 'Totals match the sheet' : 'No sheet total to check' } };
}
