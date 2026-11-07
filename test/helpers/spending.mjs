import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealStore, householdOf, closeRealStore, addFact } from './real-store.mjs';
import { callTool } from '../../src/tools/index.mjs';

export async function spendingStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'spending-test-'));
  const db = await createRealStore(dir, { clock: '2026-11-05' });
  t.after(() => { closeRealStore(db); rmSync(dir, { recursive: true, force: true }); });
  const ctx = { db, dataDir: householdOf(db).root, clock: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') };
  const account = (id, kind = 'checking', owner = 'Household') => db.prepare("INSERT INTO accounts(id,inst,name,kind,owner,parser) VALUES (?, 'Synthetic Bank', ?, ?, ?, 'aggregator')").run(id, id, kind, owner);
  let n = 0;
  const tx = (accountId, date, amount, category = null, description = `Synthetic merchant ${++n}`) => db.prepare('INSERT INTO transactions(account_id,date,amount,category,description,parser,dedupe_key) VALUES (?,?,?,?,?,?,?)').run(accountId, date, amount, category, description, 'aggregator', `synthetic-${++n}`).lastInsertRowid;
  account('checking'); account('card', 'card'); account('silent', 'card'); account('business', 'business');
  for (let m = 1; m <= 10; m++) {
    const date = `2026-${String(m).padStart(2, '0')}-10`;
    tx('checking', date, -300, 'Mortgage', 'Mortgage');
    tx('checking', date, -50, 'Medical', 'Healthcare');
    tx('checking', date, -100, 'Groceries', 'Market');
    tx('card', date, -40, 'Shopping', 'Shop');
    tx('checking', date, -60, 'Income Tax', 'Tax payment');
    tx('checking', date, 1000, 'Income', 'Salary');
  }
  const call = (operation, args = {}) => callTool('spending', { operation, ...args }, ctx);
  return { db, ctx, account, tx, call, fact: (k,v) => addFact(db,k,v) };
}
export const custom = { from: '2026-03', to: '2026-05' };
