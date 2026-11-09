import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealStore, householdOf, closeRealStore, addFact } from './real-store.mjs';
import { callTool } from '../../src/tools/index.mjs';

export async function spendingStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'spending-test-'));
  const db = await createRealStore(dir, { clock: '2026-11-05' });
  t.after(async () => {
    await closeRealStore(db);
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = { db, dataDir: householdOf(db).root, clock: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') };
  const account = async (id, kind = 'checking', owner = 'Household') =>
    await db
      .prepare(
        "INSERT INTO accounts(id,inst,name,kind,owner,parser) VALUES (?, 'Synthetic Bank', ?, ?, ?, 'aggregator')",
      )
      .run(id, id, kind, owner);
  let n = 0;
  const tx = async (accountId, date, amount, category = null, description = `Synthetic merchant ${++n}`) =>
    (await db
      .prepare(
        'INSERT INTO transactions(account_id,date,amount,category,description,parser,dedupe_key) VALUES (?,?,?,?,?,?,?) RETURNING id',
      )
      .get(accountId, date, amount, category, description, 'aggregator', `synthetic-${++n}`)).id;
  await account('checking');
  await account('card', 'card');
  await account('silent', 'card');
  await account('business', 'business');
  for (let m = 1; m <= 10; m++) {
    const date = `2026-${String(m).padStart(2, '0')}-10`;
    await tx('checking', date, -300, 'Mortgage', 'Mortgage');
    await tx('checking', date, -50, 'Medical', 'Healthcare');
    await tx('checking', date, -100, 'Groceries', 'Market');
    await tx('card', date, -40, 'Shopping', 'Shop');
    await tx('checking', date, -60, 'Income Tax', 'Tax payment');
    await tx('checking', date, 1000, 'Income', 'Salary');
  }
  const call = (operation, args = {}) => callTool('spending', { operation, ...args }, ctx);
  return { db, ctx, account, tx, call, fact: async (k, v) => await addFact(db, k, v) };
}
export const custom = { from: '2026-03', to: '2026-05' };
