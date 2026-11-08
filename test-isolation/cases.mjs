import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createThread } from '../src/api/threads.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { yearendChecklist } from '../src/yearend/expected.mjs';
import { writePlansPack } from '../test/helpers/tenancy-runtime.mjs';
import { importProposedRows } from '../test/helpers/import-proposal-fixture.mjs';
import { ok } from './fixture.mjs';
import { SCOPES } from '../src/mcp/keys.mjs';

const now = '2026-11-05T12:00:00.000Z';
export const keyOf = r => `${r.method} ${r.path}`;
export const CONTROL = new Set([
  'GET /api/auth/session', 'POST /api/auth/register/options', 'POST /api/auth/register/verify',
  'POST /api/auth/signin/options', 'POST /api/auth/signin/verify', 'POST /api/auth/recover',
  'POST /api/auth/signout', 'GET /api/auth/passkeys', 'POST /api/auth/passkeys/link',
  'POST /api/auth/passkeys/:id/revoke', 'GET /api/admin/users', 'POST /api/admin/users/invite',
  'POST /api/admin/users/:id/role', 'POST /api/admin/users/:id/remove',
  'POST /api/admin/users/:id/passkeys/:keyId/revoke', 'POST /api/auth/invitations/accept',
  'POST /api/auth/household', 'POST /api/operator/households', 'GET /api/identity',
]);

export async function seedHousehold(f, hh) {
  await setSetting(hh.db, 'mode', 'demo');
  await seedDemo(hh.db);
  await setSetting(hh.db, 'mode', 'real');
  await setSetting(hh.db, 'engine', { on: true });
  await hh.db.prepare("UPDATE content SET value=? WHERE key='meta'").run(JSON.stringify({ household: hh.canary }));
  await hh.db.prepare("INSERT OR REPLACE INTO facts(key,value,updated_at) VALUES ('synthetic.canary',?,?)").run(JSON.stringify(hh.canary), now);
  await hh.db.prepare("INSERT OR REPLACE INTO accounts(id,name,kind) VALUES ('colliding-account',?,'checking')").run(hh.canary);
  hh.retirementBalance = hh === f.A ? 12345 : 67890;
  await hh.db.prepare("INSERT INTO balances(account_id,date,amount) VALUES ('colliding-account','2026-11-05',?)").run(hh.retirementBalance);
  await hh.db.prepare("INSERT OR REPLACE INTO recs(id,def,status,updated_at) VALUES ('colliding-rec',?,'proposed',?)")
    .run(JSON.stringify({ id: 'colliding-rec', title: hh.canary, summary: hh.canary, domain: 'data' }), now);
  await hh.db.prepare("INSERT INTO recs(id,def,status,updated_at) VALUES (?,?,'proposed',?)")
    .run(hh.canary + '-only', JSON.stringify({ title: hh.canary }), now);
  writePlansPack(hh.ctx.root, hh.canary); await hh.ctx.packs.refresh();
  hh.key = ok(await hh.admin.client.post('/api/keys', { name: hh.canary, scopes: SCOPES }));
  hh.thread = ok(await hh.admin.client.post('/api/threads', { text: hh.canary + ' plan' })).thread;
  hh.packet = ok(await hh.admin.client.post('/api/advisor/packets', {})).packetId;
  ok(await hh.admin.client.post('/api/household/outbound', { jobs: false, email: true, engine: true, simplefin: true }));
  hh.upload = ok(await hh.admin.client.post('/api/onboarding/notes', { text: canaryNote(hh) })).file.fileId;
}

const canaryNote = hh => hh.canary + ' synthetic reserve policy';

export async function financialCases(f, hh) {
  const db = hh.db, canary = hh.canary;
  const war = (await db.prepare("SELECT value FROM content WHERE key='wargame'").get()).value;
  const resetWar = async () => {
    await db.prepare("UPDATE content SET value=? WHERE key='wargame'").run(war);
    await db.prepare("UPDATE decisions SET status='open',decided_line=NULL,unavailable_reason=NULL WHERE id='deferral'").run();
  };
  const goal = ok(await hh.admin.client.post('/api/goals', { title: canary, horizon: '1-3y' })).goal;
  const pref = ok(await hh.admin.client.post('/api/preferences', { text: canary + ' reserve' })).preference;
  const thread = await createThread(db, now);
  await db.prepare("UPDATE decisions SET status='open', decided_line=NULL WHERE wargame='deferral'").run();
  const args = { operation: 'wargame', name: 'deferral' };
  const result = await callTool('recommendations', args, { db, clock: '2026-11-05' });
  const spec = { source: { tool: 'recommendations', args, path: 'deferral.options' }, fields: ['figures.amount'] };
  const snapshot = buildSnapshot('compare', spec, [{ name: 'recommendations', args, result }]);
  const msg = (await db.prepare("INSERT INTO messages(conversation_key,role,text,ts,provenance) VALUES (?,'fathom',?,?,?) RETURNING id")
    .get(thread.key, canary, now, JSON.stringify({ blocks: [{ id: 'b1', op: 'compare', spec, snapshot }] }))).id;
  const proposalThread = await createThread(db, now);
  const proposalMsg = (await db.prepare("INSERT INTO messages(conversation_key,role,text,ts,provenance) VALUES (?,'fathom',?,?,?) RETURNING id")
    .get(proposalThread.key, canary, now, JSON.stringify({ pendingAction: { tool: 'act_on_recommendation', operation: 'status', args: { id: 'colliding-rec', status: 'done' } } }))).id;
  const confirm = Number((await db.prepare("INSERT INTO confirm_items(kind,subject,question,options,context,status,created_at) VALUES ('fact_check',?,?,?,?,'pending',?) RETURNING id")
    .get('synthetic.' + canary, canary, JSON.stringify([{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]), JSON.stringify({ key: 'synthetic.' + canary, value: canary }), now)).id);
  const review = ok(await hh.admin.client.post('/api/advisor/reviews', { recId: 'colliding-rec' })).reviewId;
  const entity = (await db.prepare('SELECT entity FROM pnl_lines LIMIT 1').get())?.entity;
  const whatif = (await db.prepare('SELECT id FROM packs_state WHERE json_extract(def,\'$.whatIf\') IS NOT NULL LIMIT 1').get())?.id;
  const mark = (await yearendChecklist(db, { year: 2026, clock: '2026-11-05' })).items[0].key;
  const basic = (path, body = {}, extra = {}) => ({ path, body, ...extra });
  return {
    'GET /api/scenario': basic('/api/scenario', {}, { own: true }),
    'GET /api/pace': basic('/api/pace'),
    'POST /api/tour/seen': basic('/api/tour/seen'),
    'POST /api/recs/:id/action': basic('/api/recs/colliding-rec/action', { action: 'reopen' }),
    'POST /api/actions/:id/undo': basic('/api/actions/pending/undo', {}, { async prepare() {
      const made = ok(await hh.admin.client.post('/api/preferences', { text: canary + ' temporary reserve' }));
      return { path: `/api/actions/${made.receipt.id}/undo` };
    } }),
    'POST /api/preferences': basic('/api/preferences', { text: canary + ' keep a reserve' }),
    'POST /api/preferences/:id': basic(`/api/preferences/${pref.id}`, { text: canary + ' edited reserve' }),
    'POST /api/preferences/:id/delete': basic(`/api/preferences/${pref.id}/delete`),
    'POST /api/recs/:id/answers': basic('/api/recs/colliding-rec/answers', { answers: [{ key: 'household.filingStatus', value: 'mfj' }] }, { async before() {
      ok(await hh.admin.client.post('/api/household/outbound', { jobs: true }));
      await db.prepare('UPDATE recs SET def=? WHERE id=?').run(JSON.stringify({ title: canary, question: { keys: ['household.filingStatus'] } }), 'colliding-rec');
    }, after: async () => { ok(await hh.admin.client.post('/api/household/outbound', { jobs: false })); } }),
    'POST /api/recs/:id/start-over': basic('/api/recs/colliding-rec/start-over'),
    'POST /api/wargame/:name/pick': basic('/api/wargame/deferral/pick', { index: 0 }, { before: resetWar }),
    'POST /api/decisions/:id/decide': basic('/api/decisions/deferral/decide', { index: 0 }, { before: resetWar }),
    'POST /api/decisions/:id/revisit': basic('/api/decisions/deferral/revisit'),
    'POST /api/packs/:id/toggle': basic(`/api/packs/${whatif}/toggle`),
    'POST /api/packs/:id/whatif': basic(`/api/packs/${whatif}/whatif`),
    'GET /api/packs/:id/entries/:entryId': basic('/api/packs/your-plans/entries/household-plan', {}, { own: true }),
    'POST /api/engine': basic('/api/engine', { on: true }),
    'POST /api/engine/cap': basic('/api/engine/cap', { usd: 0 }),
    'POST /api/your-plans/build': basic('/api/your-plans/build', {}, { async before() { await setSetting(db, 'engine', { on: true }); } }),
    'POST /api/ask': basic('/api/ask', { key: hh.thread.key, text: canary + ' question' }),
    'GET /api/threads': basic('/api/threads'),
    'POST /api/threads': basic('/api/threads', { text: canary + ' stream' }),
    'GET /api/threads/:id': basic(`/api/threads/${hh.thread.id}`, {}, { own: true }),
    'GET /api/threads/:id/blocks': basic(`/api/threads/${thread.id}/blocks`),
    'POST /api/threads/:id/messages/:messageId/blocks/:blockId/act': basic(`/api/threads/${thread.id}/messages/m${msg}/blocks/b1/act`, { action: 'pick', option: 0 }, { before: resetWar }),
    'POST /api/threads/:id/rename': basic(`/api/threads/${hh.thread.id}/rename`, { title: canary + ' renamed' }),
    'POST /api/threads/:id/archive': basic(`/api/threads/${hh.thread.id}/archive`),
    'POST /api/threads/:id/trash': basic(`/api/threads/${hh.thread.id}/trash`),
    'POST /api/threads/:id/restore': basic(`/api/threads/${hh.thread.id}/restore`),
    'POST /api/threads/:id/delete': basic(`/api/threads/${hh.thread.id}/delete`, {}, { async before() { await db.prepare('UPDATE conversations SET trashed_at=? WHERE key=?').run(now, hh.thread.key); } }),
    'POST /api/threads/:id/proposals/:messageId': basic(`/api/threads/${proposalThread.id}/proposals/m${proposalMsg}`, { decision: 'decline' }),
    'GET /api/accounts/:id': basic('/api/accounts/colliding-account', {}, { own: true }),
    'GET /api/accounts/:id/transactions': basic('/api/accounts/colliding-account/transactions'),
    'GET /api/pnl': basic('/api/pnl'),
    'GET /api/pnl/rows': basic(`/api/pnl/rows?entity=${encodeURIComponent(entity)}&section=expenses&category=Travel`),
    'GET /api/spending': basic('/api/spending'),
    'GET /api/spending/rows': basic('/api/spending/rows?bucket=household&category=Groceries'),
    'POST /api/accounts/:id/name': basic('/api/accounts/colliding-account/name', { displayName: canary }),
    'POST /api/accounts/:id/mask': basic('/api/accounts/colliding-account/mask', { mask: '9876' }),
    'POST /api/accounts/:id/owner': basic('/api/accounts/colliding-account/owner', { owner: 'owner' }),
    'POST /api/accounts/:id/kind': basic('/api/accounts/colliding-account/kind', { kind: 'checking' }),
    'GET /api/accounts/:id/merge-candidates': basic('/api/accounts/colliding-account/merge-candidates'),
    'POST /api/accounts/:id/merge': basic('/api/accounts/colliding-account/merge', { withId: 'merge-account' }, { async before() { await db.prepare("INSERT OR IGNORE INTO accounts(id,name,kind,mirror,identity) VALUES ('merge-account','Synthetic merge','checking','connected','simplefin:synthetic')").run(); } }),
    'POST /api/accounts/:id/archive': basic('/api/accounts/colliding-account/archive', { archived: false }),
    'GET /api/sources': basic('/api/sources'),
    'GET /api/goals/suggestions': basic('/api/goals/suggestions'),
    'POST /api/goals': basic('/api/goals', { title: canary + ' buffer' }),
    'POST /api/goals/:id': basic(`/api/goals/${goal.id}`, { title: canary + ' changed' }),
    'POST /api/goals/:id/archive': basic(`/api/goals/${goal.id}/archive`),
    'POST /api/goals/:id/delete': basic(`/api/goals/${goal.id}/delete`),
    'POST /api/goals/:id/suggestion': basic(`/api/goals/${goal.id}/suggestion`, { action: 'undo' }, { async prepare() {
      const made = ok(await hh.admin.client.post('/api/goals', { title: 'A cash cushion', horizon: '1-3y' })).goal;
      assert.ok(made.adopted); return { path: `/api/goals/${made.id}/suggestion` };
    } }),
    'POST /api/curve': basic('/api/curve', { id: 'tax_cash', value: 0.5 }),
    'POST /api/onboarding': basic('/api/onboarding', { step: 6 }),
    'POST /api/onboarding/notes': basic('/api/onboarding/notes', { text: canary + ' reserve notes' }),
    'POST /api/demo/reset': basic('/api/demo/reset', {}, { status: 404, policy: 'demo-only' }),
    'GET /api/keys': basic('/api/keys', {}, { own: true }),
    'POST /api/keys': basic('/api/keys', { name: canary + ' extra', scopes: ['read'] }),
    'POST /api/keys/:id/revoke': basic(`/api/keys/${hh.key.record.id}/revoke`),
    'GET /api/mcp': basic('/api/mcp'),
    'POST /api/files': basic('/api/files', {}, { multipart: true }),
    'GET /api/files': basic('/api/files'),
    'POST /api/files/:id/retry': basic(`/api/files/${hh.upload}/retry`, {}, { async before() { await db.prepare("UPDATE files SET status='pending' WHERE id=?").run(hh.upload); } }),
    'POST /api/import-proposals/:proposalId/review': basic('/api/import-proposals/pending/review', { version: 1, decision: 'correct', evidence: 'The state should be MD instead.' }, { async prepare() {
      const p = await importProposedRows({ db, platform: f.platform, household: hh.ctx }, [{ target: 'fact', fields: { key: 'household.state', value: 'VA' } }], { approve: false, marker: canary });
      await db.prepare('UPDATE import_proposals SET actor_id=? WHERE id=?').run(hh.admin.identity.id, p.proposalId);
      return { path: `/api/import-proposals/${p.proposalId}/review`, body: { version: p.version, decision: 'correct', evidence: 'The state should be MD instead.' } };
    } }),
    'POST /api/files/:id/remove': basic(`/api/files/${hh.upload}/remove`),
    'GET /api/confirm': basic('/api/confirm'),
    'POST /api/confirm/list': basic('/api/confirm/list', {}),
    'POST /api/confirm/answers': basic('/api/confirm/answers', { answers: [{ id: confirm, answer: 'yes' }] }),
    'POST /api/confirm/reopen-many': basic('/api/confirm/reopen-many', { ids: [confirm] }),
    'GET /api/confirm/:id': basic(`/api/confirm/${confirm}`),
    'POST /api/confirm/:id/answer': basic(`/api/confirm/${confirm}/answer`, { answer: 'yes' }),
    'POST /api/confirm/:id/reopen': basic(`/api/confirm/${confirm}/reopen`),
    'GET /api/email/subscriptions': basic('/api/email/subscriptions'),
    'POST /api/email/subscriptions': basic('/api/email/subscriptions', { subscriptions: [{ userId: hh.admin.identity.id, subscribed: true }] }),
    'GET /api/email': basic('/api/email'),
    'POST /api/email/test': basic('/api/email/test'),
    'POST /api/email/brief': basic('/api/email/brief'),
    'GET /api/jobs': basic('/api/jobs'),
    'POST /api/advisor/reviews': basic('/api/advisor/reviews', { recId: 'colliding-rec' }),
    'POST /api/advisor/reviews/:id/verdict': basic(`/api/advisor/reviews/${review}/verdict`, { verdict: 'confirmed', note: canary, date: '2026-11-05' }),
    'POST /api/advisor/checkin': basic('/api/advisor/checkin', { date: '2026-11-06', time: '12:00', lengthMin: 30 }),
    'POST /api/advisor/packets': basic('/api/advisor/packets'),
    'GET /api/advisor/packets/:id': basic(`/api/advisor/packets/${hh.packet}`, {}, { own: true }),
    'POST /api/jobs/:id/run': basic('/api/jobs/freshness/run', {}, { before: async () => { ok(await hh.admin.client.post('/api/household/outbound', { jobs: true })); }, after: async () => { ok(await hh.admin.client.post('/api/household/outbound', { jobs: false })); } }),
    'POST /api/simplefin/connect': basic('/api/simplefin/connect', { token: Buffer.from('https://bridge.example.test/claim/' + canary).toString('base64') }),
    'POST /api/simplefin/disconnect': basic('/api/simplefin/disconnect'),
    'POST /api/yearend/marks': basic('/api/yearend/marks', { year: 2026, key: mark, reason: canary }),
    'GET /api/yearend/packet': basic('/api/yearend/packet', {}, { zip: true, own: true, headStatus: 405 }),
    'GET /api/household/outbound': basic('/api/household/outbound'),
    'POST /api/household/outbound': basic('/api/household/outbound', { jobs: false, simplefin: true, email: true, engine: true }),
    'POST /api/household/backups': basic('/api/household/backups'),
    'GET /api/household/backups/:id/status': basic('/api/household/backups/pending/status', {}, { async prepare() {
      const row = await f.platform.prepare('SELECT id FROM household_backup_operations WHERE household_id=? ORDER BY created_at DESC LIMIT 1').get(hh.id);
      assert.ok(row); return { path: `/api/household/backups/${row.id}/status` };
    } }),
  };
}
