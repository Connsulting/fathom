import { createHash } from 'node:crypto';
import { writeXlsx, XLSX_MIME } from './xlsx.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { ingestFile } from '../../src/ingest/pipeline.mjs';
import { randomUUID } from 'node:crypto';
import { stageImport, reviewImport } from '../../src/ingest/model-review.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { createAuthStore } from '../../src/auth/store.mjs';

export async function importProposedRows(store, rows, { name = 'synthetic.xlsx', now = '2032-04-17T12:00:00.000Z', marker = '', approve = true } = {}) {
  const leaves = [], shared = new Map();
  function cite(value, key) {
    if (Array.isArray(value)) return value.map(v => cite(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k, v]) => k !== 'confidence' && v !== undefined && v !== null).map(([k, v]) => [k, cite(v, k)]));
    const token = JSON.stringify(value);
    let id = !['amount', 'quantity', 'value'].includes(key) ? shared.get(token) : null;
    if (!id) { id = 'r' + leaves.length; leaves.push(value); if (!['amount', 'quantity', 'value'].includes(key)) shared.set(token, id); }
    return { refs: [id], transform: { op: 'identity' } };
  }
  const targets = rows.map(row => ({ ...row, fields: cite(row.fields) }));
  const data = [leaves];
  if (marker) data.push([marker]);
  const bytes = writeXlsx([{ name: 'Synthetic source', rows: data }]);
  const fileId = 'f-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const source = await indexSource({ fileId, bytes, format: 'xlsx' });
  const coverage = source.regions.map(regionId => ({ regionId, refs: source.inventory[regionId].refs,
    disposition: marker && source.inventory[regionId].refs.includes('r' + leaves.length) ? 'explanatory_text' : 'imported_detail',
    ...(marker && source.inventory[regionId].refs.includes('r' + leaves.length) ? { reason: { refs: ['r' + leaves.length], transform: { op: 'identity' } } } : {}) }));
  createAuthStore(store.platform).setPlatformSetting('instance_model_cap_usd', 50);
  const engine = createRuntimeEngine({ db: store.db, config: { engine: 'fake' }, allowed: () => store.household.outbound.enabled('engine') });
  const household = { ...store.household, engine };
  const ctx = { db: store.db, household, scheduler: { trigger() {} }, actorId: 'actor-synthetic', now, ownerText: 'yes', scopes: ['write:imports', 'write:facts', 'write:goals', 'write:steps', 'write:recs'] };
  await ingestFile(store.db, { name, bytes, mime: XLSX_MIME }, { ...ctx, household: { ...household, engine: { isOn: () => false } } });
  const staged = stageImport(ctx, { source, proposal: { proposalId: randomUUID(), version: 1, fileId, sha256: source.sha256, interpreterVersion: 'synthetic', mappingId: null, mappingVersion: null, rows: targets, coverage, completeness: 'complete' } });
  if (!approve || staged.status !== 'needs_confirmation') return { fileId, ...staged };
  return { fileId, ...staged, ...await reviewImport(ctx, { proposalId: staged.proposalId, version: staged.version, decision: 'approve', evidence: 'yes' }) };
}
