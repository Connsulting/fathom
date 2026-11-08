import { createHash } from 'node:crypto';
import { refreshPackState } from '../../src/packs/state.mjs';
import { tx } from '../../src/store/db.mjs';
import { persistImport } from '../../src/ingest/pipeline.mjs';
import { toRows, periodOf, labelOf, sourceKindOf, resolveTokens } from '../../src/ingest/extract.mjs';
import { redactForExtraction } from '../../src/ingest/redact.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';
import { NOW } from './ingest.mjs';

export async function seedHistoricalRows(store, file, rows, { parser = 'historical', period = { from: null, to: null }, sourceKind = 'other', capabilities = {} } = {}) {
  const hash = createHash('sha256').update(file.bytes).digest('hex'), fileId = 'f-' + hash.slice(0, 24), db = store.db;
  if (db.prepare('SELECT 1 FROM files WHERE id=?').get(fileId)) return { fileId, status: 'duplicate', counts: { rows: {} } };
  const stored = await storeFile({ vault: await openVault(store.household), id: fileId, bytes: file.bytes, purpose: 'upload' });
  db.prepare('INSERT INTO files(id,name,mime,size,sha256,uploaded_at,stored_path,status) VALUES (?,?,?,?,?,?,?,?)')
    .run(fileId, file.name, file.mime ?? null, file.bytes.length, hash, NOW, stored, 'imported');
  const groups = new Map();
  rows = rows.filter(row => {
    if (row.kind !== 'pnl_line') return true;
    const entity = db.prepare('SELECT entity FROM entity_aliases WHERE alias=?').get(row.entity.toLowerCase().replace(/[^a-z0-9]/g,''))?.entity;
    if (entity) row.entity = entity;
    const key = JSON.stringify([row.entity,row.period,row.category]);
    if (!groups.has(key)) { groups.set(key,row); return true; }
    const prior = groups.get(key); prior.amount += row.amount; prior.locator.cells.push(...row.locator.cells); return false;
  });
  const result = tx(db, () => persistImport(db, fileId, file, { status: 'imported', parser, label: labelOf(parser.replace('extract-', '')), sourceKind, capabilities,
    parsed: { rows, warnings: [], period } }, { now: NOW }));
  if (result.factsChanged) refreshPackState(db, { dataDir: store.household.root, now: NOW });
  return result.result;
}
export async function seedHistoricalDocument(store, file, responses) {
  const classified = responses[0]?.[0]?.docType;
  const docType = classified ?? 'notes', raw = responses[classified ? 1 : 0]?.[0];
  const fields = resolveTokens(raw, redactForExtraction(Buffer.from(file.bytes).toString()).refs);
  const fileId = 'f-' + createHash('sha256').update(file.bytes).digest('hex').slice(0,24);
  const entities = store.db.prepare('SELECT DISTINCT entity FROM pnl_lines').all().map(r => r.entity);
  const rows = toRows(docType, fields, { fileId, households: { entities }, warnings: [] });
  if (docType === 'notes') {
    rows.forEach(row => row.parser = 'extract-notes');
    rows.unshift({ kind: 'document', docType: 'notes', fields: { ref: fileId, sha256: createHash('sha256').update(file.bytes).digest('hex'), chars: file.bytes.length, lines: 1 }, locator: { row: 1 } });
  }
  return seedHistoricalRows(store, file, rows, { parser: docType === 'notes' ? 'notes' : `extract-${docType}`, period: periodOf(docType, fields), sourceKind: sourceKindOf(docType), capabilities: { positions: docType === 'statement' } });
}
export const historicalNorthwindRows = (travel = 200) => [
  ['Northwind Design','Income',1500,['C2','C3']], ['Northwind Design','Software',-25,['C2']], ['Northwind','Software',-100,['C2','C3']], ['Northwind','Travel',-travel,['C4']],
].map(([entity,category,amount,cells]) => ({ kind: 'pnl_line', entity, category, amount, period: '2032-04', locator: { sheet: entity, cells } }));
export function historicalTaxRows(revised = false) {
  return [[2032,1,'Spouse','federal',150,'B4'],[2032,1,'Owner','federal',200,'C4'],[2032,1,'Spouse','state',50,'E4'],[2032,1,'Owner','state',75,'F4'],
    [2032,2,'Owner','federal',revised ? 250 : 225,'C5'],[2032,2,'Owner','state',80,'F5'],[2032,3,'Owner','federal',425,'C6'],[2032,3,'Spouse','state',-10,'E6'],
    [2031,12,'Spouse','federal',100,'B3'],[2031,12,'Spouse','state',25,'E3']].map(([year,month,payer,jurisdiction,amount,cell]) => ({
      kind: 'tax_payment', sheetYear: year, taxYear: year, taxYearBasis: 'sheet_label', datePrecision: 'month', payer, jurisdiction, amount,
      date: `${year}-${String(month).padStart(2,'0')}-${new Date(Date.UTC(year,month,0)).getUTCDate()}`, paymentKind: 'paid', locator: { sheet: String(year), cell },
    }));
}
