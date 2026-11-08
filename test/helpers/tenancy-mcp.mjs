import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './server.mjs';
import { browser, register } from './tenancy.mjs';
import { createAuthenticator } from './webauthn.mjs';
import { startRuntime, writeInstanceKeys, toolText } from './tenancy-runtime.mjs';
import { mcpPost } from '../../src/mcp/test/helpers.mjs';
import { createAuthStore } from '../../src/auth/store.mjs';
import { SCOPES } from '../../src/mcp/keys.mjs';
import { writeSyntheticPack, ALWAYS } from './packs.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';
import { stageUpdate } from '../../src/ingest/model-updates.mjs';

export { toolText };
export const mcp = (baseUrl, key, method, params = {}, headers = {}) => mcpPost(baseUrl, { auth: key ? `Bearer ${key}` : undefined, method, params, headers });

export const refreshImportFixture = household => ({ operation: 'import_file', name: `Synthetic ${household.canary} notes.md`, mime: 'text/markdown', text: `# ${household.canary}\n\nKeep answers short.` });

export async function refreshReviewFixture(household) {
  const bytes = Buffer.from(`${household.canary} source note.`), fileId = `${household.canary}-review`;
  const source = await indexSource({ fileId, format: 'text', bytes });
  const stored = await storeFile({ vault: await openVault(household.ctx), id: fileId, bytes, purpose: 'upload' });
  household.db.prepare('INSERT INTO files(id,name,sha256,stored_path,status,uploaded_at) VALUES (?,?,?,?,?,?)')
    .run(fileId, 'Synthetic review.txt', source.sha256, stored, 'needs_confirmation', '2032-03-10T12:00:00Z');
  const span = { fileId, sha256: source.sha256, byteStart: 0, byteEnd: bytes.length };
  const proposal = stageUpdate({ db: household.db, household: household.ctx, actorId: household.admin.userId }, { source, actions: [{ tool: 'note', span }] });
  return { operation: 'review_import', proposalId: proposal.proposalId, version: proposal.version, decision: 'approve', evidence: 'yes' };
}

export const expectedTransactionFixture = household => ({ operation: 'expected_transaction', subject: household.canary,
  direction: 'inflow', dueDate: '2032-06-19', datePrecision: 'day', amount: null,
  evidence: `${household.canary} pays on 2032-06-19` });

export function accountCategoryFixtures(household) {
  const transactionId = Number(household.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('colliding-account','2026-11-01',-25,'Synthetic store')").run().lastInsertRowid);
  return {
    categorize: { operation: 'transaction', transactionId, category: 'Groceries' },
    update_account: { operation: 'rename', id: 'colliding-account', displayName: household.canary + ' reserve' },
  };
}

export async function mcpHouseholds() {
  const root = await tempDir('fathom-mt06-');
  let server;
  try {
    server = await startRuntime({ dataDir: join(root, 'data'), keys: writeInstanceKeys(join(root, 'keys')), engine: 'off' });
    const { app, baseUrl } = server;
    const platform = app.platform;
    const store = createAuthStore(platform);
    const enroll = async (id, email, role) => {
      const invitation = store.invite(id, email, { role });
      const client = browser(baseUrl);
      const device = createAuthenticator();
      const result = await register(baseUrl, client, device, { token: invitation.token });
      assert.equal(result.options.status, 200, result.options.text);
      assert.equal(result.verify?.status, 200, result.verify?.text);
      assert.ok(client.session());
      return { userId: invitation.user.id, client, device, cookie: `__Host-fathom-session=${client.session()}` };
    };
    const A = { id: platform.prepare('SELECT id FROM households WHERE serves_store = 1').get().id, canary: 'SyntheticAlphaCanary' };
    A.admin = await enroll(A.id, 'alpha@example.test', 'admin');
    store.grantOperator(A.admin.userId);
    store.setPlatformSetting('multi_household_enabled', true);
    const made = await A.admin.client.post('/api/operator/households', { displayName: 'Synthetic second household', adminEmail: 'bravo@example.test' });
    assert.equal(made.status, 200, made.text);
    const B = { id: made.json.household.id, canary: 'SyntheticBravoCanary' };
    B.admin = await enroll(B.id, 'bravo@example.test', 'admin');
    const member = await enroll(A.id, 'member@example.test', 'admin');
    const create = async (household, client = household.admin.client, scopes = SCOPES) => {
      const response = await client.post('/api/keys', { name: 'Synthetic integration key', scopes, householdId: household === A ? B.id : A.id, userId: 'foreign-user' });
      assert.equal(response.status, 200, response.text);
      return response.json;
    };
    for (const hh of [A, B]) {
      hh.ctx = app.runtimes.get(hh.id);
      hh.db = hh.ctx.db;
      hh.db.prepare('INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?)').run('synthetic.canary', JSON.stringify(hh.canary), '2026-11-05');
      hh.db.prepare('INSERT INTO recs (id, def, status, updated_at) VALUES (?, ?, ?, ?)')
        .run('colliding-rec', JSON.stringify({ id: 'colliding-rec', title: hh.canary, tasks: [{ t: 'Synthetic task' }] }), 'proposed', '2026-11-05');
      hh.db.prepare('INSERT INTO recs (id, def, status, updated_at) VALUES (?, ?, ?, ?)')
        .run(`${hh.canary}-only`, JSON.stringify({ title: hh.canary }), 'proposed', '2026-11-05');
      hh.db.prepare('INSERT INTO accounts (id, name, kind) VALUES (?, ?, ?)').run('colliding-account', hh.canary, 'checking');
      hh.retirementBalance = hh === A ? 12345 : 67890;
      hh.db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)')
        .run('colliding-account', '2026-11-05', hh.retirementBalance);
      hh.retirement = { operation: 'growth', solve: 'balance', years: 0,
        balance: { ref: { tool: 'accounts', args: { operation: 'detail', id: 'colliding-account' }, path: 'balance' } } };
      writeSyntheticPack(hh.ctx.root, { id: 'your-plans', appliesWhen: ALWAYS, entries: [
        { file: 'shared.md', title: hh.canary, body: `# ${hh.canary}\n\n${hh.canary} private guidance.\n` },
        { file: `${hh.canary}.md`, title: hh.canary, body: `# ${hh.canary}\n\n${hh.canary} private guidance.\n` },
      ] });
      hh.key = await create(hh);
    }
    const call = async (hh, name, args, extra = {}) => mcp(baseUrl, hh.key.key, 'tools/call', { name, arguments: args }, extra);
    return { A, B, member, platform, store, app, baseUrl, create, call, enroll, env: server.env,
      async close() { await server.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (err) {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

export function result(response) {
  assert.equal(response.status, 200, response.text);
  assert.notEqual(response.json?.result?.isError, true, toolText(response));
  return JSON.parse(toolText(response));
}

export function digest(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

export function c7ReadFixtures(household) {
  const {db,canary}=household;
  const amount=household.retirementBalance,monthly=canary.includes('Alpha')?400:600;
  db.prepare("UPDATE accounts SET owner='owner' WHERE id='colliding-account'").run();
  const fact=(key,value)=>db.prepare('INSERT INTO facts(key,value,as_of,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key,JSON.stringify(value),'2026-11-05','2026-11-05');
  fact('household.ownerBirthDate',canary.includes('Alpha')?'1980-06-15':'1985-08-31');
  fact('household.retireAge',{owner:50});
  fact('obligations.mortgage',{balance:10000,rate:0,monthlyPayment:monthly,escrowMonthly:100,payoffDate:'2027-01-01'});
  for(let month=1;month<=10;month++) {
    const date=`2026-${String(month).padStart(2,'0')}-10`;
    db.prepare('INSERT INTO transactions(account_id,date,amount,category,description,parser,dedupe_key) VALUES (?,?,?,?,?,?,?)')
      .run('colliding-account',date,-monthly,'Mortgage',canary,'aggregator',`${canary}-${month}`);
  }
  return [
    {tool:'spending',args:{operation:'obligations',obligations:['mortgage']},path:'obligations.0.monthly.value',expected:monthly},
    {tool:'spending',args:{operation:'projection',years:2,obligations:['mortgage']},path:'years.1.spending.value',expected:1200},
    {tool:'retirement',args:{operation:'access',people:'owner'},path:'people.0.born.value',expected:canary.includes('Alpha')?'1980-06-15':'1985-08-31'},
    {tool:'retirement',args:{operation:'bridge'},path:'accessible.cash.value',expected:amount},
  ];
}
