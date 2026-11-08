import { randomUUID } from 'node:crypto';
import { realStore, NOW } from './ingest.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';

export const field = (id, transform = { op: 'identity' }) => ({ refs: [id], transform });
export const recipe = () => ({ schemaVersion: 1, currency: 'USD', tables: [{ sheet: null, headerRow: 1, target: 'transaction',
  fields: { accountId: { columns: [1], transform: { op: 'trim' } }, postedDate: { columns: [2], transform: { op: 'date_decode', locale: 'iso', epoch: '1900' } },
    amount: { columns: [3], transform: { op: 'currency_decode', currency: 'USD' } }, description: { columns: [4], transform: { op: 'trim' } } }, attributes: {},
  roles: [{ column: 1, equals: 'Total', disposition: 'control_total', amountColumn: 3 }] }] });

export async function fixture(options = {}) {
  const store = await realStore(options);
  store.db.prepare("INSERT INTO accounts (id,name,inst,kind,owner,identity) VALUES ('account-synthetic','Synthetic account','Example bank','cash','you','synthetic-account')").run();
  const ctx = { db: store.db, household: store.household, actorId: 'actor-synthetic', scopes: ['write:imports'], now: NOW, ownerText: 'yes' };
  async function source(text = 'Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\naccount-synthetic,2032-03-03,2.25,Synthetic refund\nTotal,,-10.00,Control total\n', format = 'csv') {
    const file = { fileId: 'f-' + randomUUID(), format, name: 'synthetic.' + format, bytes: Buffer.from(text) };
    const indexed = await indexSource(file);
    const vault = await openVault(store.household);
    const path = await storeFile({ vault, id: file.fileId, bytes: file.bytes, purpose: 'upload' });
    store.db.prepare('INSERT INTO files (id,name,sha256,size,mime,uploaded_at,stored_path,status) VALUES (?,?,?,?,?,?,?,?)')
      .run(file.fileId, file.name, indexed.sha256, file.bytes.length, format === 'csv' ? 'text/csv' : 'text/plain', NOW, path, 'waiting_for_engine');
    return indexed;
  }
  return { ...store, ctx, source };
}
