import { setSetting } from '../../src/store/db.mjs';
import { ingestFile, accountIdOf } from '../../src/ingest/pipeline.mjs';
import { parser } from '../../src/ingest/simplefin.mjs';
import { aggregatorFile, textFile, NOW } from './ingest.mjs';

export const positionsFile = (mask = '6294') => textFile('positions-2032-02-29.csv',
  `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value\n000${mask},Individual Brokerage,SYN,Synthetic fund,10,120,1200\n`);

export async function seedDuplicate(s, { sure = false, mask = '6294', sfKey = 'synthetic-bridge', conflict = false } = {}) {
  setSetting(s.db, 'clock', '2032-03-10');
  const name = sure ? 'Synthetic checking' : 'Individual Brokerage';
  await ingestFile(s.db, sure ? aggregatorFile(`checking-${mask}.csv`, [
    { date: '2032-02-29', inst: 'Example Bank', account: name, number: `000${mask}`, amount: '10', description: 'File posting' },
  ]) : positionsFile(mask), s.opts(null));
  const keep = s.db.prepare('SELECT * FROM accounts WHERE mask = ? AND identity NOT LIKE ?').get(mask, 'simplefin:%');
  const own = accountIdOf(`simplefin:${sfKey}`);
  const account = { inst: sure ? 'Example Bank' : 'Example Brokerage', name: `${name} x${mask}`, mask, kind: sure ? 'checking' : 'brokerage' };
  const doc = { accounts: [{ accountId: own, identity: `simplefin:${sfKey}`, account,
    balance: { date: '2032-02-29', amount: conflict ? 1300 : 1200 },
    transactions: [{ date: '2032-02-29', amount: -10, description: 'Bridge posting', externalId: 'bridge-posting' }] }] };
  await ingestFile(s.db, textFile(`bridge-${mask}.json`, JSON.stringify(doc)), s.opts(null, { parser }));
  s.db.prepare("INSERT INTO simplefin_accounts (sf_key,account_id,status,name,created_at,backfilled) VALUES (?,?,'mapped',?,?,1)").run(sfKey, own, account.name, NOW);
  s.db.prepare('INSERT INTO simplefin_snapshots (sf_key,snapshot,at) VALUES (?,?,?)').run(sfKey, JSON.stringify({ ...account, maskSure: true, balance: conflict ? 1300 : 1200, balanceDate: '2032-02-29' }), NOW);
  for (const id of [keep.id, own]) {
    s.db.prepare('INSERT INTO balances (account_id,date,amount,dedupe_key) VALUES (?,?,?,?)').run(id, '2032-01-31', 1000, `synthetic:${id}:jan`);
    if (!s.db.prepare('SELECT 1 FROM balances WHERE account_id = ? AND date = ?').get(id, '2032-02-29'))
      s.db.prepare('INSERT INTO balances (account_id,date,amount,dedupe_key) VALUES (?,?,?,?)').run(id, '2032-02-29', 1200, `synthetic:${id}:feb`);
  }
  s.db.prepare("UPDATE accounts SET owner='You', kind=? WHERE id=?").run(sure ? 'cash' : 'taxable', keep.id);
  return { keep: keep.id, own, sfKey, file: sure ? null : positionsFile(mask) };
}
