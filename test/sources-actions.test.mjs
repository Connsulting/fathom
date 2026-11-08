// SRC1 AC3 and AC4: per-source actions with Undo, through the HTTP API and the tool registry.
//   POST /api/accounts/:id/archive {archived?} -> {scenario, receipt}: the account leaves current
//     balances, household totals and Ask; its transactions stay. Undo restores it.
//   POST /api/files/:id/remove -> {scenario, receipt}: the file's rows go, figures recompute, the
//     file and a source left with no live file leave the Sources list. Undo restores exactly.
//   POST /api/accounts/:id/merge {withId} -> {scenario, survivorId, itemId, receipt}: Undo reopens.
//   GET /api/sources -> the Sources view (an array, or {sources: [...]}).
// Undo is POST /api/actions/:id/undo or the undo tool. Each action is also a tool operation
// (sources.archive_account, sources.remove_file, sources.merge_accounts, accounts.sources) with
// route parity declared. Expected figures are read from the API before the action, never literals
// from private data. Every file, account and institution here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src, serveAppFixture } from './helpers/server.mjs';
import { realStore, fixture, aggregatorFile, textFile, offEngine, one, NOW } from './helpers/ingest.mjs';

let P;
let SF;
let T;
let B;
let DB;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  SF = await src('src/ingest/simplefin.mjs');
  T = await src('src/tools/index.mjs');
  B = await src('src/scenario/build.mjs');
  DB = await src('src/store/db.mjs');
});

const CLOCK = '2032-03-10';
const AT = new Date(`${CLOCK}T12:00:00.000Z`);
const INST = 'Example Bank';

const listOf = (body) => (Array.isArray(body) ? body : body?.sources);
// Household total: the sum of each current account's balance figure, as the Money list adds them.
const totalOf = (scenario) => scenario.accounts.reduce((sum, a) => sum + Number(scenario.fig[a.fig]?.v ?? 0), 0);
const idsOf = (scenario) => scenario.accounts.map((a) => a.id);
const toolCtx = (s, extra = {}) => ({ db: s.db, now: AT, actorId: 'person-a', ...extra });
const isCode = (code) => (e) => e?.code === code;

async function ingest(s, file, opts = {}) {
  const r = await P.ingestFile(s.db, file, s.opts(await offEngine(), opts));
  assert.equal(r.status, 'imported', `${file.name} imported`);
  return { ...r, row: await one(s.db, 'SELECT * FROM files WHERE id = ?', r.fileId) };
}
const accountOfFile = async (s, fileId) => await one(s.db, `SELECT * FROM accounts WHERE id IN (
  SELECT account_id FROM transactions WHERE file_id = ? UNION SELECT account_id FROM balances WHERE file_id = ?
  UNION SELECT account_id FROM positions WHERE file_id = ?)`, fileId, fileId, fileId);

// A real store with three uploaded files: an aggregator export and a bank activity export of one
// cash account (the activity file adds its balances and a newer transaction), and a positions
// export of an investment account.
async function seeded(s) {
  DB.setSetting(s.db, 'clock', CLOCK);
  const agg = await ingest(s, fixture('aggregator.csv', 'text/csv'));
  const bank = await ingest(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  const pos = await ingest(s, fixture('positions.csv', 'text/csv'));
  const cash = await accountOfFile(s, bank.fileId);
  const invest = await accountOfFile(s, pos.fileId);
  assert.equal((await accountOfFile(s, agg.fileId)).id, cash.id, 'precondition: both cash exports feed one account');
  return { agg, bank, pos, cash: cash.id, invest: invest.id };
}

async function withApp(fn, seed = seeded) {
  const s = await realStore();
  let app;
  try {
    const ids = await seed(s);
    app = await serveAppFixture({ db: s.db, config: s.config, authenticated: true });
    const api = {
      async sources() {
        const r = await app.request({ path: '/api/sources' });
        assert.equal(r.status, 200, r.text);
        const list = listOf(r.json);
        assert.ok(Array.isArray(list), 'GET /api/sources lists sources');
        return list;
      },
      scenario: () => app.getScenario(),
      async txTotal(id) {
        const r = await app.request({ path: `/api/accounts/${encodeURIComponent(id)}/transactions` });
        assert.equal(r.status, 200, r.text);
        return r.json.total;
      },
      post: (path, body = {}) => app.postJson(path, body),
      undo: (id) => app.postJson(`/api/actions/${encodeURIComponent(id)}/undo`, {}),
      ask: () => T.callTool('accounts', { operation: 'list' }, toolCtx(s)),
    };
    await fn({ s, app, api, ...ids });
  } finally {
    await app?.close();
    s.close();
  }
}

/* ---------- archive an account (HTTP) ---------- */

test('archive takes an account out of current accounts, household totals and Ask, keeps its transactions, and Undo restores it', async () => withApp(async ({ api, cash }) => {
  const before = await api.scenario();
  assert.ok(idsOf(before).includes(cash));
  const total = totalOf(before);
  const txBefore = await api.txTotal(cash);
  assert.ok(txBefore > 0);
  assert.ok((await api.ask()).some((a) => a.id === cash));

  const r = await api.post(`/api/accounts/${cash}/archive`, {});
  assert.equal(r.status, 200, `a valid archive is not refused: ${r.text}`);
  assert.ok(r.json.receipt && typeof r.json.receipt.id === 'string', 'archive returns a receipt');
  assert.ok(!idsOf(r.json.scenario).includes(cash), 'the returned scenario drops the account');
  assert.ok(totalOf(r.json.scenario) < total, 'household totals drop the archived balance');
  const after = await api.scenario();
  assert.ok(!idsOf(after).includes(cash));
  assert.equal(totalOf(after), totalOf(r.json.scenario));
  assert.ok(!(await api.ask()).some((a) => a.id === cash), 'Ask accounts.list leaves the archived account out');
  assert.equal(await api.txTotal(cash), txBefore, 'history is kept');
  const listed = (await api.sources()).flatMap((x) => x.accounts).find((a) => a.id === cash);
  assert.ok(listed, 'Sources still lists the archived account so it can be restored');
  assert.equal(listed.archived, true);

  const undo = await api.undo(r.json.receipt.id);
  assert.equal(undo.status, 200, undo.text);
  assert.ok(idsOf(undo.json.scenario).includes(cash));
  const restored = await api.scenario();
  assert.deepEqual(idsOf(restored), idsOf(before));
  assert.equal(totalOf(restored), total);
  assert.ok((await api.ask()).some((a) => a.id === cash));
}));

test('archiving twice is a no-op with no receipt, and restore with archived false gets its own receipt', async () => withApp(async ({ api, invest }) => {
  const first = await api.post(`/api/accounts/${invest}/archive`, {});
  assert.equal(first.status, 200, first.text);
  const again = await api.post(`/api/accounts/${invest}/archive`, { archived: true });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.receipt, null);
  const restore = await api.post(`/api/accounts/${invest}/archive`, { archived: false });
  assert.equal(restore.status, 200, restore.text);
  assert.ok(restore.json.receipt?.id);
  assert.ok(idsOf(restore.json.scenario).includes(invest));
  // The first receipt's row changed since: its Undo is refused and nothing moves.
  const stale = await api.undo(first.json.receipt.id);
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.json?.error ?? stale.text, /changed since/);
  assert.ok(idsOf(await api.scenario()).includes(invest));
}));

/* ---------- remove an uploaded file (HTTP) ---------- */

test('removing a file deletes its rows, recomputes figures, drops it from Sources, and Undo restores exactly', async () => withApp(async ({ api, bank, cash }) => {
  const sourcesBefore = await api.sources();
  const before = await api.scenario();
  const txBefore = await api.txTotal(cash);
  const bankSource = sourcesBefore.find((x) => x.files.some((f) => f.id === bank.fileId));
  assert.ok(bankSource, 'precondition: Sources lists the bank export');
  assert.equal(bankSource.files.length, 1, 'precondition: the bank export is its source\'s only live file');

  const r = await api.post(`/api/files/${bank.fileId}/remove`, {});
  assert.equal(r.status, 200, `a valid removal is not refused: ${r.text}`);
  assert.ok(r.json.receipt?.id, 'removal returns a receipt');
  assert.equal(await api.txTotal(cash), txBefore - bank.counts.rows.transaction, 'its transactions are gone');
  assert.notEqual(totalOf(r.json.scenario), totalOf(before), 'its balances no longer count');
  assert.ok(idsOf(r.json.scenario).includes(cash), 'the account still has rows from the other export');
  const sourcesAfter = await api.sources();
  assert.ok(!sourcesAfter.some((x) => x.files.some((f) => f.id === bank.fileId)), 'the file leaves the Sources list');
  assert.ok(!sourcesAfter.some((x) => x.id === bankSource.id), 'a source with no live file leaves the list');

  const twice = await api.post(`/api/files/${bank.fileId}/remove`, {});
  assert.equal(twice.status, 409, 'an already removed file is refused');

  const undo = await api.undo(r.json.receipt.id);
  assert.equal(undo.status, 200, undo.text);
  assert.equal(await api.txTotal(cash), txBefore);
  const restored = await api.scenario();
  assert.equal(totalOf(restored), totalOf(before));
  assert.deepEqual(restored.accounts, before.accounts);
  assert.deepEqual(await api.sources(), sourcesBefore, 'Sources is back exactly as it was');
}));

test('removing a file that leaves an account with no rows archives it; Undo after that account changed is refused', async () => withApp(async ({ api, pos, invest }) => {
  const r = await api.post(`/api/files/${pos.fileId}/remove`, {});
  assert.equal(r.status, 200, r.text);
  assert.ok(!idsOf(r.json.scenario).includes(invest), 'the emptied account leaves current accounts');
  const restore = await api.post(`/api/accounts/${invest}/archive`, { archived: false });
  assert.equal(restore.status, 200, restore.text);
  const undo = await api.undo(r.json.receipt.id);
  assert.equal(undo.status, 409, `Undo after the rows changed is a conflict: ${undo.text}`);
  assert.ok(idsOf(await api.scenario()).includes(invest), 'the refused Undo changed nothing');
}));

test('unknown ids are 404', async () => withApp(async ({ api }) => {
  assert.equal((await api.post('/api/accounts/acct-no-such-account/archive', {})).status, 404);
  assert.equal((await api.post('/api/files/f-000000000000000000000000/remove', {})).status, 404);
  assert.equal((await api.post('/api/accounts/acct-no-such-account/merge', { withId: 'acct-no-such-other' })).status, 404);
}));

/* ---------- merge (HTTP) ---------- */

// A file account with no mask (aggregator export) and a connected account written the way the
// SimpleFIN sync writes one, so the detector proposes nothing and the merge is manual.
async function mergePair(s) {
  DB.setSetting(s.db, 'clock', CLOCK);
  const name = 'Household spending';
  await ingest(s, aggregatorFile('household-spending.csv', [
    { date: '2032-02-20', amount: '25.00', type: 'Checking', inst: INST, account: name, number: '', description: `${name} posting` },
  ]), { engine: null });
  const file = (await one(s.db, "SELECT * FROM accounts WHERE name = ? AND coalesce(identity, '') NOT LIKE 'simplefin:%'", name)).id;
  await s.db.prepare('INSERT INTO balances (account_id, date, amount, dedupe_key) VALUES (?, ?, ?, ?)').run(file, '2032-02-29', 500, `synthetic:${file}:feb`);
  const sfKey = 'synthetic-sources';
  const own = P.accountIdOf(`simplefin:${sfKey}`);
  const account = { inst: INST, name: 'Everyday x4321', mask: '4321', kind: 'checking' };
  const doc = { accounts: [{ accountId: own, identity: `simplefin:${sfKey}`, account, balance: { date: '2032-02-29', amount: 1200 },
    transactions: [{ date: '2032-02-29', amount: -10, description: 'Bridge posting', externalId: `bridge-${sfKey}` }] }] };
  const r = await P.ingestFile(s.db, textFile(`bridge-${sfKey}.json`, JSON.stringify(doc)), s.opts(null, { parser: SF.parser }));
  assert.equal(r.status, 'imported');
  await s.db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?, ?, 'mapped', ?, ?, 1)").run(sfKey, own, account.name, NOW);
  await s.db.prepare('INSERT INTO simplefin_snapshots (sf_key, snapshot, at) VALUES (?, ?, ?)').run(sfKey, JSON.stringify({ ...account, maskSure: true, balance: 1200, balanceDate: '2032-02-29' }), NOW);
  return { file, own };
}

test('merge still works over HTTP and returns a receipt whose Undo reopens the merge', async () => withApp(async ({ api, file, own }) => {
  const before = await api.scenario();
  assert.ok(idsOf(before).includes(file) && idsOf(before).includes(own));
  const r = await api.post(`/api/accounts/${file}/merge`, { withId: own });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.survivorId, file);
  assert.ok(Number.isInteger(r.json.itemId));
  assert.ok(r.json.receipt?.id, 'merge returns a receipt');
  assert.ok(!idsOf(r.json.scenario).includes(own));
  const undo = await api.undo(r.json.receipt.id);
  assert.equal(undo.status, 200, undo.text);
  const after = await api.scenario();
  assert.deepEqual(idsOf(after).sort(), idsOf(before).sort(), 'Undo reopens the merge: both accounts are back');
  assert.equal(totalOf(after), totalOf(before));
}, mergePair));

/* ---------- the same actions through the tool registry ---------- */

const undoArgs = (receipt) => ({ available: true, tool: 'undo', args: { operation: 'undo', id: receipt.id } });

async function withStore(fn, seed = seeded) {
  const s = await realStore();
  try { await fn({ s, ...(await seed(s)) }); } finally { s.close(); }
}
const scenarioIds = (s) => idsOf(B.buildScenario(s.db, { clock: CLOCK }));
const askIds = async (s) => (await T.callTool('accounts', { operation: 'list' }, toolCtx(s))).map((a) => a.id);
const txCount = async (s, id) => (await s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(id)).n;

test('sources.archive_account archives with a receipt and Undo; another actor or scope cannot undo it', async () => withStore(async ({ s, cash }) => {
  const txBefore = await txCount(s, cash);
  const out = await T.callTool('sources', { operation: 'archive_account', id: cash }, toolCtx(s));
  assert.ok(out.receipt?.id, 'a valid archive is not refused');
  assert.equal(out.receipt.scope, 'write:sources');
  assert.deepEqual(out.undo, undoArgs(out.receipt));
  assert.ok(!scenarioIds(s).includes(cash));
  assert.ok(!(await askIds(s)).includes(cash));
  assert.equal(await txCount(s, cash), txBefore);
  for (const other of [{ actorId: 'person-b' }, { scopes: ['write:goals'], channel: 'mcp' }]) {
    await assert.rejects(T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s, other)));
    assert.ok(!scenarioIds(s).includes(cash));
  }
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s, { scopes: ['write:sources'], channel: 'mcp' }));
  assert.ok(scenarioIds(s).includes(cash));
  assert.ok((await askIds(s)).includes(cash));
  await assert.rejects(T.callTool('sources', { operation: 'archive_account', id: 'acct-no-such-account' }, toolCtx(s)), isCode('not_found'));
}));

test('sources.remove_file removes rows with a receipt; the undo tool restores them; removing twice is a conflict', async () => withStore(async ({ s, bank, cash }) => {
  const txBefore = await txCount(s, cash);
  const scenarioBefore = B.buildScenario(s.db, { clock: CLOCK });
  const out = await T.callTool('sources', { operation: 'remove_file', id: bank.fileId }, toolCtx(s));
  assert.ok(out.receipt?.id, 'a valid removal is not refused');
  assert.deepEqual(out.undo, undoArgs(out.receipt));
  assert.equal(await txCount(s, cash), txBefore - bank.counts.rows.transaction);
  assert.notEqual(totalOf(B.buildScenario(s.db, { clock: CLOCK })), totalOf(scenarioBefore));
  await assert.rejects(T.callTool('sources', { operation: 'remove_file', id: bank.fileId }, toolCtx(s)), isCode('conflict'));
  await assert.rejects(T.callTool('sources', { operation: 'remove_file', id: 'f-000000000000000000000000' }, toolCtx(s)), isCode('not_found'));
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s));
  assert.equal(await txCount(s, cash), txBefore);
  assert.equal(totalOf(B.buildScenario(s.db, { clock: CLOCK })), totalOf(scenarioBefore));
}));

test('sources.merge_accounts merges with a receipt and the undo tool reopens it', async () => withStore(async ({ s, file, own }) => {
  const out = await T.callTool('sources', { operation: 'merge_accounts', id: file, withId: own }, toolCtx(s));
  assert.ok(out.receipt?.id);
  assert.deepEqual(out.undo, undoArgs(out.receipt));
  assert.ok(!(await askIds(s)).includes(own));
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s));
  const ids = await askIds(s);
  assert.ok(ids.includes(file) && ids.includes(own), 'both accounts are back');
}, mergePair));

test('accounts.sources returns the same Sources view as GET /api/sources', async () => withApp(async ({ s, api }) => {
  const viaApi = await api.sources();
  const viaTool = listOf(await T.callTool('accounts', { operation: 'sources' }, toolCtx(s)));
  assert.deepEqual(viaTool, viaApi);
  assert.ok(viaApi.length > 0);
  for (const x of viaApi) for (const k of ['id', 'name', 'range', 'state', 'accounts', 'files']) assert.ok(Object.hasOwn(x, k), `${x.id} has ${k}`);
}));

/* ---------- parity, routes, scope, labels, public demo ---------- */

test('route parity, router registration, write scope and MCP label', async () => {
  const { routes } = await src('src/api/router.mjs');
  const { WRITE_SCOPES } = await src('src/shared/action-scopes.mjs');
  const { SCOPE_INFO } = await src('src/mcp/keys.mjs');
  const expected = {
    'POST /api/accounts/:id/archive': ['sources.archive_account'],
    'POST /api/files/:id/remove': ['sources.remove_file'],
    'POST /api/accounts/:id/merge': ['sources.merge_accounts', 'update_account.merge'],
    'GET /api/sources': ['accounts.sources'],
  };
  for (const [route, ops] of Object.entries(expected)) {
    assert.deepEqual(T.parity[route], ops, `parity for ${route}`);
    const [method, path] = route.split(' ');
    assert.ok(routes.some((r) => r.method === method && r.path === path), `router registers ${route}`);
  }
  assert.ok(WRITE_SCOPES.includes('write:sources'));
  const tool = T.getTool('sources');
  assert.equal(tool?.kind, 'write');
  assert.deepEqual(tool.operations.map((o) => o.name).sort(), ['archive_account', 'merge_accounts', 'remove_file']);
  for (const op of tool.operations) assert.deepEqual(T.operationScopes(op), ['write:sources'], `${op.name} scope`);
  const read = T.getTool('accounts').operations.find((o) => o.name === 'sources');
  assert.ok(read, 'accounts.sources exists');
  assert.deepEqual(T.operationScopes(read), ['read']);
  const info = SCOPE_INFO.find((x) => x.id === 'write:sources');
  assert.equal(info?.label, 'Manage data sources');
  assert.equal(info.access, 'Archive or restore accounts, remove imported files, merge duplicate accounts, and undo your changes.');
});

test('the public demo sandboxes archive and the Sources list, but not file removal', async () => {
  const { demoRouteBehavior } = await src('src/public-demo/control.mjs');
  assert.equal(demoRouteBehavior('POST', '/api/accounts/:id/archive'), 'sandbox');
  assert.equal(demoRouteBehavior('GET', '/api/sources'), 'sandbox');
  assert.equal(demoRouteBehavior('POST', '/api/files/:id/remove'), 'off');
});

test('an archived account leaves accounts.holdings, with or without an account filter', async () => withStore(async ({ s, invest }) => {
  const holdings = (args = {}) => T.callTool('accounts', { operation: 'holdings', ...args }, toolCtx(s));
  assert.ok((await holdings()).some((p) => p.accountId === invest), 'precondition: the investment account has holdings');
  const out = await T.callTool('sources', { operation: 'archive_account', id: invest }, toolCtx(s));
  assert.ok(!(await holdings()).some((p) => p.accountId === invest));
  assert.deepEqual(await holdings({ id: invest }), []);
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s));
  assert.ok((await holdings({ id: invest })).length > 0);
}));

test('removing a file removes its documents and recomputes a balance figure it owned without rows', async () => withStore(async ({ s, bank, invest }) => {
  // A synthetic document read from the bank file, and the investment account's balance figure
  // pointed at that file the way an empty holdings snapshot owns a figure with no rows.
  await s.db.prepare("INSERT INTO documents (doc_type, tax_year, fields, file_id) VALUES ('w2', 2031, '{}', ?)").run(bank.fileId);
  const fig = (await one(s.db, 'SELECT fig_key FROM accounts WHERE id = ?', invest)).fig_key;
  assert.ok(fig, 'precondition: the investment account has a balance figure');
  await s.db.prepare('UPDATE figures SET file_id = ? WHERE key = ?').run(bank.fileId, fig);
  const docs = async () => (await s.db.prepare('SELECT count(*) AS n FROM documents WHERE file_id = ?').get(bank.fileId)).n;
  const out = await T.callTool('sources', { operation: 'remove_file', id: bank.fileId }, toolCtx(s));
  assert.equal(await docs(), 0, 'the planner no longer reads the removed file\'s documents');
  const after = (await one(s.db, 'SELECT fig_key FROM accounts WHERE id = ?', invest)).fig_key;
  assert.ok(after && await one(s.db, 'SELECT key FROM figures WHERE key = ?', after), 'the balance figure is recomputed from the remaining holdings');
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s));
  assert.equal(await docs(), 1);
}));

test('an archived account leaves accounts.net_worth and household.health by default', async () => withStore(async ({ s, invest }) => {
  const worth = () => T.callTool('accounts', { operation: 'net_worth' }, toolCtx(s));
  const health = () => T.callTool('household', { operation: 'health' }, toolCtx(s));
  const mentions = (out) => JSON.stringify(out).includes(invest);
  assert.ok(mentions(await worth()) && mentions(await health()), 'precondition: both read the investment account');
  const out = await T.callTool('sources', { operation: 'archive_account', id: invest }, toolCtx(s));
  assert.ok(!mentions(await worth()), 'net worth leaves the archived account out');
  assert.ok(!mentions(await health()), 'data health leaves the archived account out');
  await T.callTool('undo', { operation: 'undo', id: out.receipt.id }, toolCtx(s));
  assert.ok(mentions(await worth()));
}));


const reupload = (app, file) => {
  const boundary = 'synthetic-restore-boundary';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(file.bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return app.request({ method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
};

test('identical re-upload restores removed data through HTTP and consumes the original removal Undo', async () => withApp(async ({ app, api, bank, cash }) => {
  const before = await api.scenario(), txBefore = await api.txTotal(cash);
  const removed = await api.post(`/api/files/${bank.fileId}/remove`);
  assert.equal(removed.status, 200, removed.text);
  const restored = await reupload(app, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.files[0].fileId, bank.fileId);
  assert.equal(restored.json.files[0].restored, true);
  assert.equal(restored.json.files[0].status, 'imported');
  assert.equal(await api.txTotal(cash), txBefore);
  assert.equal(totalOf(await api.scenario()), totalOf(before));
  assert.equal((await api.undo(removed.json.receipt.id)).status, 409, 'the removal was already undone by the upload');
  const duplicate = await reupload(app, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
  assert.equal(duplicate.json.files[0].status, 'duplicate', 'active identical uploads retain duplicate detection');
}));

test('a re-upload refuses an intervening source change with a conflict and leaves removal intact', async () => withApp(async ({ app, api, pos, invest }) => {
  assert.equal((await api.post(`/api/files/${pos.fileId}/remove`)).status, 200);
  assert.equal((await api.post(`/api/accounts/${invest}/archive`, { archived: false })).status, 200);
  const refused = await reupload(app, fixture('positions.csv', 'text/csv'));
  assert.equal(refused.status, 409, refused.text);
  assert.ok(!(await api.sources()).some(source => source.files.some(file => file.id === pos.fileId)));
}));
