// Account dialog edits: last 4 (AC1), owner and kind through the confirm queue (AC2), manual merge
// with a confirmation plan and undo (AC3), and the meta line that says Manual once (AC4).
// Every account, institution and amount here is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers/server.mjs';
import { realStore, aggregatorFile, textFile, NOW } from './helpers/ingest.mjs';
import { seedDuplicate } from './helpers/account-merge.mjs';

const INST = 'Example Bank';

const mods = async () => ({
  A: await src('src/api/accounts.mjs'),
  D: await src('src/api/account-detail.mjs'),
  C: await src('src/ingest/confirm.mjs'),
  M: await src('src/ingest/account-merge.mjs'),
  P: await src('src/ingest/pipeline.mjs'),
  SF: await src('src/ingest/simplefin.mjs'),
});

const ctx = (s, id, body = {}, extra = {}) => ({ db: s.db, config: s.config, params: { id }, body, query: {}, ...extra });

async function status(fn) {
  try { await fn(); } catch (e) { return e.status ?? e.code ?? 'throw'; }
  return 'ok';
}

const withStore = async (fn) => {
  const s = await realStore();
  try { await fn(s, await mods()); } finally { s.close(); }
};

const row = (db, id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
const itemsOf = (db, kind, subject) => db.prepare('SELECT * FROM confirm_items WHERE kind = ? AND subject = ? ORDER BY id').all(kind, subject);
const scenarioAccount = (res, id) => (res.scenario?.accounts || []).find((a) => a.id === id);

// A manual account inserted directly: no mask, no identity, no confirm item.
function plainAccount(s, id = 'acct-plain', { owner = 'You', kind = 'cash', name = 'Reserve savings', mask = null, identity = null } = {}) {
  s.db.prepare('INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Sample Bank', mask, name, owner, kind, 'manual', identity);
  s.db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)').run(id, '2032-02-20', -25, 'Synthetic posting');
  return id;
}

// A file account with no account number, so no mask, imported through the aggregator parser.
async function fileAccount(s, P, name, { balance = null, amount = '25.00' } = {}) {
  const r = await P.ingestFile(s.db, aggregatorFile(`${name.toLowerCase().replace(/\W+/g, '-')}.csv`, [
    { date: '2032-02-20', amount, type: 'Checking', inst: INST, account: name, number: '', description: `${name} posting` },
  ]), s.opts(null));
  assert.equal(r.status, 'imported');
  const acct = s.db.prepare("SELECT * FROM accounts WHERE name = ? AND coalesce(identity, '') NOT LIKE 'simplefin:%'").get(name);
  assert.ok(acct, `${name} was imported`);
  assert.equal(acct.mask, null, 'precondition: the file account has no mask');
  if (balance != null) s.db.prepare('INSERT INTO balances (account_id, date, amount, dedupe_key) VALUES (?, ?, ?, ?)').run(acct.id, '2032-02-29', balance, `synthetic:${acct.id}:feb`);
  return acct.id;
}

// A connected account, written the way the SimpleFIN sync writes one.
async function connectedAccount(s, { P, SF }, { sfKey = 'synthetic-edit', mask = '4321', name = `Everyday x${mask}`, balance = 1200 } = {}) {
  const own = P.accountIdOf(`simplefin:${sfKey}`);
  const account = { inst: INST, name, mask, kind: 'checking' };
  const doc = { accounts: [{ accountId: own, identity: `simplefin:${sfKey}`, account,
    balance: { date: '2032-02-29', amount: balance },
    transactions: [{ date: '2032-02-29', amount: -10, description: 'Bridge posting', externalId: `bridge-${sfKey}` }] }] };
  const r = await P.ingestFile(s.db, textFile(`bridge-${sfKey}.json`, JSON.stringify(doc)), s.opts(null, { parser: SF.parser }));
  assert.equal(r.status, 'imported');
  s.db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?, ?, 'mapped', ?, ?, 1)").run(sfKey, own, name, NOW);
  s.db.prepare('INSERT INTO simplefin_snapshots (sf_key, snapshot, at) VALUES (?, ?, ?)').run(sfKey, JSON.stringify({ ...account, maskSure: true, balance, balanceDate: '2032-02-29' }), NOW);
  assert.equal(row(s.db, own).mirror, 'connected');
  return own;
}

const askOwner = (C, db, id) => C.ask(db, { kind: 'account_owner', subject: id, question: 'Whose account is this?', options: C.OWNER_OPTIONS, context: {}, now: NOW });
const askKind = (C, db, id) => C.ask(db, { kind: 'account_kind', subject: id, question: 'What kind of account is this?', options: C.KIND_OPTIONS, context: {}, now: NOW });

/* ---------- AC1: last 4 ---------- */

test('AC1: last 4 refuses anything that is not exactly four digits', () => withStore(async (s, { A }) => {
  const id = plainAccount(s);
  for (const mask of ['123', '12345', '12ab', 'abcd', '12 34', ' 1234x', null, '', 1234, ['1234'], { mask: '1234' }]) {
    assert.equal(await status(() => A.accountMask(ctx(s, id, { mask }))), 400, `mask ${JSON.stringify(mask)} is refused`);
  }
  assert.equal(await status(() => A.accountMask(ctx(s, id, {}))), 400, 'a missing mask is refused');
  assert.equal(row(s.db, id).mask, null, 'nothing was stored');
}));

test('AC1: last 4 refuses an account that already has a mask or a SimpleFIN identity, and an unknown account', () => withStore(async (s, { A }) => {
  const masked = plainAccount(s, 'acct-masked', { mask: '5555' });
  const linked = plainAccount(s, 'acct-linked', { identity: 'simplefin:synthetic-linked' });
  assert.equal(await status(() => A.accountMask(ctx(s, masked, { mask: '1234' }))), 409);
  assert.equal(row(s.db, masked).mask, '5555');
  assert.equal(await status(() => A.accountMask(ctx(s, linked, { mask: '1234' }))), 409);
  assert.equal(row(s.db, linked).mask, null);
  assert.equal(await status(() => A.accountMask(ctx(s, 'nope', { mask: '1234' }))), 404);
  assert.equal(await status(() => A.accountMask(ctx(s, '', { mask: '1234' }))), 400);
}));

test('AC1: a good last 4 is stored, the label says ending 1234, and the control is offered only while it can be used', () => withStore(async (s, { A, D }) => {
  const id = plainAccount(s);
  const masked = plainAccount(s, 'acct-masked', { mask: '5555' });
  const linked = plainAccount(s, 'acct-linked', { identity: 'simplefin:synthetic-linked' });
  assert.equal(D.accountDetail(ctx(s, id)).account.maskEditable, true);
  assert.equal(D.accountDetail(ctx(s, masked)).account.maskEditable, false);
  assert.equal(D.accountDetail(ctx(s, linked)).account.maskEditable, false);

  const res = await A.accountMask(ctx(s, id, { mask: '1234' }));
  assert.equal(row(s.db, id).mask, '1234');
  assert.ok(res.scenario && Array.isArray(res.scenario.accounts), 'the write returns the scenario');
  assert.equal(res.account.id, id);
  assert.match(res.account.name, /ending 1234/);
  assert.match(scenarioAccount(res, id).name, /ending 1234/);
  const d = D.accountDetail(ctx(s, id));
  assert.match(d.account.label, /ending 1234/);
  assert.equal(d.account.maskEditable, false, 'once set, last 4 is not offered again');
  assert.equal(await status(() => A.accountMask(ctx(s, id, { mask: '9999' }))), 409, 'a second write is refused');
  assert.equal(row(s.db, id).mask, '1234');
}));

test('AC1: a stored last 4 lets duplicate detection propose a pair it could not see before', () => withStore(async (s, m) => {
  const { A, M } = m;
  const file = await fileAccount(s, m.P, 'Household spending');
  const own = await connectedAccount(s, m, { mask: '4321' });
  const subject = `merge:${file}:${own}`;
  assert.deepEqual(M.detectAccountPairs(s.db).filter((p) => p.candidateId === file && p.ownId === own), [], 'precondition: no pair without the mask');
  assert.equal(itemsOf(s.db, 'account_match', subject).length, 0);

  await A.accountMask(ctx(s, file, { mask: '4321' }));
  const pairs = M.detectAccountPairs(s.db);
  assert.ok(pairs.some((p) => p.candidateId === file && p.ownId === own), 'the pair is proposed');
  const items = itemsOf(s.db, 'account_match', subject);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending', 'a Same account? question is waiting');
}));

/* ---------- AC2: owner and kind ---------- */

const OWNER_LABEL = { owner: 'You', spouse: 'Your spouse', joint: 'Joint', business: 'Business' };

test('AC2: every owner id is accepted and stored as the confirm label; anything else is refused and changes nothing', () => withStore(async (s, { A, C }) => {
  const id = plainAccount(s, 'acct-o', { owner: null });
  askOwner(C, s.db, id);
  const before = { acct: row(s.db, id), items: itemsOf(s.db, 'account_owner', id) };
  for (const owner of ['nobody', 'You', 'Your spouse', '', null, 1, 'OWNER', 'both']) {
    assert.equal(await status(() => A.accountOwner(ctx(s, id, { owner }))), 400, `owner ${JSON.stringify(owner)} is refused`);
  }
  assert.equal(await status(() => A.accountOwner(ctx(s, id, {}))), 400);
  assert.deepEqual(row(s.db, id), before.acct, 'a refused write changes no account column');
  assert.deepEqual(itemsOf(s.db, 'account_owner', id), before.items, 'a refused write changes no confirm item');
  assert.equal(await status(() => A.accountOwner(ctx(s, 'nope', { owner: 'spouse' }))), 404);

  for (const [owner, label] of Object.entries(OWNER_LABEL)) {
    const res = await A.accountOwner(ctx(s, id, { owner }));
    assert.equal(row(s.db, id).owner, label, `${owner} is stored as ${label}`);
    const items = itemsOf(s.db, 'account_owner', id);
    assert.equal(items.length, 1, 'one confirm item per account');
    assert.equal(items[0].status, 'answered');
    assert.equal(items[0].answer, owner);
    assert.equal(scenarioAccount(res, id).owner, label, 'the returned scenario shows the new owner');
    assert.equal(res.account.owner, label);
    assert.ok(res.before && typeof res.before === 'object', 'the write returns what undo needs');
  }
}));

test('AC2: every kind id is accepted and stored; anything else is refused and changes nothing', () => withStore(async (s, { A, C }) => {
  const id = plainAccount(s, 'acct-k', { kind: null });
  askKind(C, s.db, id);
  const before = { acct: row(s.db, id), items: itemsOf(s.db, 'account_kind', id) };
  for (const kind of ['crypto', 'manual', 'Checking', 'savings', '', null, 529]) {
    assert.equal(await status(() => A.accountKind(ctx(s, id, { kind }))), 400, `kind ${JSON.stringify(kind)} is refused`);
  }
  assert.deepEqual(row(s.db, id), before.acct);
  assert.deepEqual(itemsOf(s.db, 'account_kind', id), before.items);
  assert.equal(await status(() => A.accountKind(ctx(s, 'nope', { kind: 'cash' }))), 404);

  for (const { id: kind } of C.KIND_OPTIONS) {
    const res = await A.accountKind(ctx(s, id, { kind }));
    assert.equal(row(s.db, id).kind, kind);
    const items = itemsOf(s.db, 'account_kind', id);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'answered');
    assert.equal(items[0].answer, kind);
    assert.equal(scenarioAccount(res, id).kind, kind);
  }
}));

test('AC2: an owner edit works from a pending item, an answered item, a final item and no item', () => withStore(async (s, { A, C }) => {
  const pending = plainAccount(s, 'acct-pending', { owner: null });
  askOwner(C, s.db, pending);
  const answered = plainAccount(s, 'acct-answered', { owner: null });
  C.answer(s.db, askOwner(C, s.db, answered).id, 'owner', { now: NOW });
  const final = plainAccount(s, 'acct-final', { owner: null });
  const finalId = askOwner(C, s.db, final).id;
  C.answer(s.db, finalId, 'owner', { now: NOW });
  askOwner(C, s.db, final);
  assert.equal(C.finalReason(s.db, C.getItem(s.db, finalId)), 'used_since', 'precondition: a later import made the answer final');
  const none = plainAccount(s, 'acct-none', { owner: 'You' });
  assert.equal(itemsOf(s.db, 'account_owner', none).length, 0);

  for (const id of [pending, answered, final, none]) {
    await A.accountOwner(ctx(s, id, { owner: 'spouse' }));
    assert.equal(row(s.db, id).owner, 'Your spouse', `${id} took the edit`);
    const items = itemsOf(s.db, 'account_owner', id);
    assert.equal(items.length, 1, `${id} has one item`);
    assert.equal(items[0].status, 'answered');
    assert.equal(items[0].answer, 'spouse');
  }
}));

test('AC2: a later import asking the same question keeps the edited owner and kind', () => withStore(async (s, { A, C }) => {
  const id = plainAccount(s, 'acct-keep', { owner: null, kind: null });
  C.answer(s.db, askOwner(C, s.db, id).id, 'owner', { now: NOW });
  C.answer(s.db, askKind(C, s.db, id).id, 'checking', { now: NOW });
  askOwner(C, s.db, id); askKind(C, s.db, id);
  await A.accountOwner(ctx(s, id, { owner: 'joint' }));
  await A.accountKind(ctx(s, id, { kind: 'cash' }));
  askOwner(C, s.db, id);
  askKind(C, s.db, id);
  assert.equal(row(s.db, id).owner, 'Joint');
  assert.equal(row(s.db, id).kind, 'cash');

  const fresh = plainAccount(s, 'acct-fresh', { owner: 'You', kind: 'cash' });
  await A.accountOwner(ctx(s, fresh, { owner: 'business' }));
  await A.accountKind(ctx(s, fresh, { kind: 'business' }));
  askOwner(C, s.db, fresh);
  askKind(C, s.db, fresh);
  assert.equal(row(s.db, fresh).owner, 'Business');
  assert.equal(row(s.db, fresh).kind, 'business');
}));

test('AC2: undo restores an answered owner, including one that was final', () => withStore(async (s, { A, C }) => {
  const id = plainAccount(s, 'acct-undo-a', { owner: null });
  const itemId = askOwner(C, s.db, id).id;
  C.answer(s.db, itemId, 'owner', { now: NOW });
  const res = await A.accountOwner(ctx(s, id, { owner: 'spouse' }));
  assert.equal(row(s.db, id).owner, 'Your spouse');
  const undone = await A.accountOwner(ctx(s, id, { undo: res.before }));
  assert.equal(row(s.db, id).owner, 'You');
  const item = C.getItem(s.db, itemId);
  assert.equal(item.status, 'answered');
  assert.equal(item.answer, 'owner');
  assert.equal(scenarioAccount(undone, id).owner, 'You');

  const final = plainAccount(s, 'acct-undo-f', { owner: null });
  const finalId = askOwner(C, s.db, final).id;
  C.answer(s.db, finalId, 'owner', { now: NOW });
  askOwner(C, s.db, final);
  const out = await A.accountOwner(ctx(s, final, { owner: 'business' }));
  await A.accountOwner(ctx(s, final, { undo: out.before }));
  assert.equal(row(s.db, final).owner, 'You');
  assert.equal(C.getItem(s.db, finalId).answer, 'owner');
}));

test('AC2: undo of an edit that answered a pending question puts it back to pending', () => withStore(async (s, { A, C }) => {
  const id = plainAccount(s, 'acct-undo-p', { owner: null, kind: null });
  const ownerItem = askOwner(C, s.db, id).id;
  const kindItem = askKind(C, s.db, id).id;
  const o = await A.accountOwner(ctx(s, id, { owner: 'joint' }));
  const k = await A.accountKind(ctx(s, id, { kind: 'card' }));
  assert.equal(row(s.db, id).owner, 'Joint');
  assert.equal(row(s.db, id).kind, 'card');
  await A.accountOwner(ctx(s, id, { undo: o.before }));
  await A.accountKind(ctx(s, id, { undo: k.before }));
  assert.equal(row(s.db, id).owner, null);
  assert.equal(row(s.db, id).kind, null);
  assert.equal(C.getItem(s.db, ownerItem).status, 'pending');
  assert.equal(C.getItem(s.db, ownerItem).answer, null);
  assert.equal(C.getItem(s.db, kindItem).status, 'pending');
}));

test('AC2: undo of an edit that created the question removes it and restores the column', () => withStore(async (s, { A }) => {
  const id = plainAccount(s, 'acct-undo-n', { owner: 'You', kind: 'cash' });
  const o = await A.accountOwner(ctx(s, id, { owner: 'business' }));
  const k = await A.accountKind(ctx(s, id, { kind: 'retirement' }));
  assert.equal(itemsOf(s.db, 'account_owner', id).length, 1);
  assert.equal(itemsOf(s.db, 'account_kind', id).length, 1);
  await A.accountOwner(ctx(s, id, { undo: o.before }));
  await A.accountKind(ctx(s, id, { undo: k.before }));
  assert.equal(row(s.db, id).owner, 'You');
  assert.equal(row(s.db, id).kind, 'cash');
  assert.equal(itemsOf(s.db, 'account_owner', id).length, 0, 'the created owner item is gone');
  assert.equal(itemsOf(s.db, 'account_kind', id).length, 0, 'the created kind item is gone');
}));

test('AC2: repeating the same value is a quiet no-op', () => withStore(async (s, { A }) => {
  const id = plainAccount(s, 'acct-same', { owner: 'You', kind: 'cash' });
  await A.accountOwner(ctx(s, id, { owner: 'spouse' }));
  const again = await A.accountOwner(ctx(s, id, { owner: 'spouse' }));
  assert.equal(row(s.db, id).owner, 'Your spouse');
  assert.equal(scenarioAccount(again, id).owner, 'Your spouse');
  assert.equal(itemsOf(s.db, 'account_owner', id).length, 1);
  await A.accountKind(ctx(s, id, { kind: 'cash' }));
  await A.accountKind(ctx(s, id, { kind: 'cash' }));
  assert.equal(row(s.db, id).kind, 'cash');
  assert.ok(itemsOf(s.db, 'account_kind', id).length <= 1);
}));

test('AC2: an owner or kind edit schedules a replan and the detail reports the option keys', () => withStore(async (s, { A, D }) => {
  const id = plainAccount(s, 'acct-plan', { owner: 'You', kind: 'cash' });
  const calls = [];
  const scheduler = { soon: (job) => { calls.push(job); return true; }, trigger: (job) => { calls.push(job); return Promise.resolve(); } };
  const before = D.accountDetail(ctx(s, id)).account;
  assert.equal(before.ownerKey, 'owner');
  assert.equal(before.kindKey, 'cash');
  await A.accountOwner(ctx(s, id, { owner: 'spouse' }, { scheduler }));
  assert.ok(calls.includes('plan'), 'the plan job is scheduled after an owner edit');
  calls.length = 0;
  await A.accountKind(ctx(s, id, { kind: 'taxable' }, { scheduler }));
  assert.ok(calls.includes('plan'), 'the plan job is scheduled after a kind edit');
  const after = D.accountDetail(ctx(s, id)).account;
  assert.equal(after.ownerKey, 'spouse');
  assert.equal(after.kindKey, 'taxable');
}));

/* ---------- AC3: manual merge ---------- */

const snapshot = (db) => ({
  accounts: db.prepare('SELECT id, inst, mask, name, owner, kind, mirror, identity, display_name FROM accounts ORDER BY id').all(),
  transactions: db.prepare('SELECT * FROM transactions ORDER BY id').all(),
  balances: db.prepare('SELECT * FROM balances ORDER BY id').all(),
  positions: db.prepare('SELECT * FROM positions ORDER BY id').all(),
  simplefin: db.prepare('SELECT sf_key, account_id, candidate_id, status FROM simplefin_accounts ORDER BY sf_key').all(),
  goals: db.prepare('SELECT id, def FROM goals ORDER BY id').all(),
});

const putGoal = (db, accountId) => db.prepare("INSERT INTO goals (id, def, origin, created_at, updated_at) VALUES ('synthetic-goal', ?, 'owner', ?, ?)")
  .run(JSON.stringify({ id: 'synthetic-goal', title: 'Reserve', target: 5000, targetDate: '2033-01-01', track: { accounts: [accountId] } }), NOW, NOW);

// A file account and a connected account the detector does not pair: no file mask, different names
// and balances far apart.
async function undetectedPair(s, m) {
  const file = await fileAccount(s, m.P, 'Household spending', { balance: 500 });
  const own = await connectedAccount(s, m, { mask: '4321', name: 'Everyday x4321', balance: 1200 });
  assert.equal(m.M.detectAccountPairs(s.db).length, 0, 'precondition: the detector proposes nothing');
  return { file, own };
}

test('AC3: merge candidates list every other account with what a merge would keep and move', () => withStore(async (s, m) => {
  const { file, own } = await undetectedPair(s, m);
  const other = await fileAccount(s, m.P, 'Rainy day fund');
  const total = s.db.prepare('SELECT count(*) AS n FROM accounts').get().n;

  const out = await m.A.accountMergeCandidates(ctx(s, file));
  assert.ok(Array.isArray(out.items));
  assert.equal(out.items.length, total - 1, 'every other account');
  assert.equal(out.items.some((c) => c.id === file), false, 'never the account itself');
  for (const c of out.items) {
    for (const k of ['id', 'label', 'inst', 'kind', 'mask', 'lastDataDate', 'mirror', 'plan']) assert.ok(Object.hasOwn(c, k), `candidate has ${k}`);
    assert.equal(typeof c.label, 'string');
    for (const k of ['keepId', 'keepLabel', 'ownId', 'ownLabel', 'moves']) assert.ok(Object.hasOwn(c.plan, k), `plan has ${k}`);
    for (const k of ['transactions', 'balances', 'positions', 'sources']) assert.equal(typeof c.plan.moves[k], 'number', `moves.${k} is a count`);
    assert.equal(c.refused == null, true, 'only two connected accounts are refused');
  }
  const c = out.items.find((x) => x.id === own);
  assert.equal(c.mirror, 'connected');
  assert.equal(c.mask, '4321');
  assert.equal(c.lastDataDate, '2032-02-29');
  assert.equal(c.plan.keepId, file, 'the file account survives');
  assert.equal(c.plan.ownId, own);
  assert.equal(typeof c.plan.keepLabel, 'string');
  assert.equal(typeof c.plan.ownLabel, 'string');
  assert.equal(c.plan.moves.transactions, s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(own).n);
  assert.equal(c.plan.moves.balances, s.db.prepare('SELECT count(*) AS n FROM balances WHERE account_id = ?').get(own).n);
  assert.equal(c.plan.moves.positions, 0);
  const f = out.items.find((x) => x.id === other);
  assert.equal(f.plan.keepId, file, 'two file accounts: the open account survives');
  assert.equal(f.plan.ownId, other);

  const fromConnected = await m.A.accountMergeCandidates(ctx(s, own));
  const back = fromConnected.items.find((x) => x.id === file);
  assert.equal(back.plan.keepId, file, 'from the connected account the file account still survives');
  assert.equal(back.plan.ownId, own);
  assert.equal(await status(() => m.A.accountMergeCandidates(ctx(s, 'nope'))), 404);
}));

test('AC3: two connected accounts are listed as refused and a merge of them is refused with nothing changed', () => withStore(async (s, m) => {
  const first = await seedDuplicate(s, { sure: true, mask: '6294', sfKey: 'synthetic-one' });
  const second = await seedDuplicate(s, { sure: true, mask: '7310', sfKey: 'synthetic-two' });
  const list = await m.A.accountMergeCandidates(ctx(s, first.own));
  const c = list.items.find((x) => x.id === second.own);
  assert.equal(typeof c.refused, 'string');
  assert.ok(c.refused.length > 0);
  const before = snapshot(s.db);
  assert.equal(await status(() => m.A.accountMerge(ctx(s, first.own, { withId: second.own }))), 409);
  assert.deepEqual(snapshot(s.db), before);
}));

test('AC3: a merge with itself, an unknown account or no account is refused', () => withStore(async (s, m) => {
  const { file } = await undetectedPair(s, m);
  const before = snapshot(s.db);
  assert.equal(await status(() => m.A.accountMerge(ctx(s, file, { withId: file }))), 400);
  assert.equal(await status(() => m.A.accountMerge(ctx(s, file, {}))), 400);
  assert.equal(await status(() => m.A.accountMerge(ctx(s, file, { withId: 'nope' }))), 404);
  assert.equal(await status(() => m.A.accountMerge(ctx(s, 'nope', { withId: file }))), 404);
  assert.deepEqual(snapshot(s.db), before);
}));

for (const from of ['file', 'connected']) {
  test(`AC3: a manual merge of an undetected pair, opened from the ${from} account, keeps the file account and undo restores both`, () => withStore(async (s, m) => {
    const { file, own } = await undetectedPair(s, m);
    putGoal(s.db, own);
    const ownTx = s.db.prepare('SELECT id FROM transactions WHERE account_id = ?').all(own).map((r) => r.id);
    assert.ok(ownTx.length > 0);
    const before = snapshot(s.db);

    const [open, other] = from === 'file' ? [file, own] : [own, file];
    const res = await m.A.accountMerge(ctx(s, open, { withId: other }));
    assert.equal(res.survivorId, file);
    assert.ok(Number.isInteger(res.itemId) && res.itemId > 0, 'the merge returns its confirm item');
    assert.ok(res.scenario && Array.isArray(res.scenario.accounts));
    assert.equal(res.scenario.accounts.some((a) => a.id === own), false);
    assert.equal(row(s.db, own), undefined, 'the connected account row is gone');
    assert.equal(row(s.db, file).mirror, 'connected', 'the survivor takes the feed');
    for (const id of ownTx) {
      const t = s.db.prepare('SELECT account_id FROM transactions WHERE id = ?').get(id);
      assert.ok(!t || t.account_id === file, 'connected rows moved to the survivor');
    }
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(own).n, 0);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM balances WHERE account_id = ?').get(own).n, 0);
    assert.equal(s.db.prepare('SELECT account_id FROM simplefin_accounts WHERE sf_key = ?').get('synthetic-edit').account_id, file);
    assert.deepEqual(JSON.parse(s.db.prepare("SELECT def FROM goals WHERE id = 'synthetic-goal'").get().def).track.accounts, [file]);
    const item = m.C.getItem(s.db, res.itemId);
    assert.equal(item.kind, 'account_match');
    assert.equal(item.status, 'answered');
    assert.equal(item.answer, 'same');

    m.C.reopenItem(s.db, res.itemId, { now: NOW });
    assert.deepEqual(snapshot(s.db), before, 'undo restores both accounts and every row');
  }));
}

test('AC3: two file accounts merge into the open account and it stays manual', () => withStore(async (s, m) => {
  for (const pick of [0, 1]) {
    const a = await fileAccount(s, m.P, `Spending ${pick} alpha`);
    const b = await fileAccount(s, m.P, `Spending ${pick} beta`, { amount: '40.00' });
    const [open, other] = pick === 0 ? [a, b] : [b, a];
    const otherTx = s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(other).n;
    const keptTx = s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(open).n;
    const before = snapshot(s.db);
    const res = await m.A.accountMerge(ctx(s, open, { withId: other }));
    assert.equal(res.survivorId, open, 'the account whose dialog is open survives');
    assert.equal(row(s.db, other), undefined);
    assert.equal(row(s.db, open).mirror, 'manual', 'no connected account was merged in');
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(open).n, keptTx + otherTx);
    m.C.reopenItem(s.db, res.itemId, { now: NOW });
    assert.deepEqual(snapshot(s.db), before);
  }
}));

/* ---------- AC4: meta line ---------- */

const metaTexts = async (info, a, d) => {
  const { metaParts } = await import('../web/horizon/screens/account.js');
  assert.equal(typeof metaParts, 'function', 'metaParts is exported');
  const parts = metaParts(info, a, d);
  assert.ok(Array.isArray(parts));
  for (const p of parts) {
    assert.equal(typeof p.cls, 'string');
    assert.equal(typeof p.text, 'string');
  }
  return parts.map((p) => p.text);
};
const count = (texts, re) => texts.filter((t) => re.test(t)).length;

test('AC4: a manual kind on a manual account says Manual once', async () => {
  const info = { id: 'x', inst: 'Sample Bank', kind: 'manual', owner: 'You', mirror: 'manual' };
  const a = { id: 'x', inst: 'Sample Bank', kind: 'manual', owner: 'You', mirror: 'manual', asOf: '2032-02-20', fresh: 'fresh', imported: true };
  const texts = await metaTexts(info, a, { account: info, fresh: 'fresh', asOf: '2032-02-20' });
  assert.equal(count(texts, /\bmanual\b/i), 1, `Manual once in ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('You'), 'the owner is shown');
  assert.equal(count(texts, /^Last data /), 1, 'Last data is shown');
  const owned = await metaTexts({ ...info, owner: 'Manual' }, { ...a, owner: 'Manual' }, { account: { ...info, owner: 'Manual' } });
  assert.equal(count(owned, /\bmanual\b/i), 1);
});

test('AC4: a checking account that is manual shows Checking and Manual once each', async () => {
  const info = { id: 'x', inst: 'Sample Bank', kind: 'checking', owner: 'Joint', mirror: 'manual' };
  const a = { id: 'x', inst: 'Sample Bank', kind: 'checking', owner: 'Joint', mirror: 'manual', asOf: '2032-02-20', fresh: 'stale', imported: true };
  const texts = await metaTexts(info, a, { account: info, fresh: 'stale', asOf: '2032-02-20' });
  assert.equal(count(texts, /^Checking$/), 1);
  assert.equal(count(texts, /\bmanual\b/i), 1);
  assert.ok(texts.includes('Joint'));
  assert.equal(count(texts, /^Last data /), 1);
});
