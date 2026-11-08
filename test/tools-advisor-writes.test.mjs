import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { serveAppFixture } from './helpers/server.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import { readPacket } from '../src/advisor/packet.mjs';
import { VaultError } from '../src/ingest/vault.mjs';

const S = scratch('fathom-advisor-writes-');
after(async () => await S.cleanup());
const CLOCK = '2026-11-05';
const NOW = CLOCK + 'T12:00:00.000Z';
async function store() {
  const db = await S.store();
  await planRun(db, { now: CLOCK });
  const household = householdOf(db);
  return { db, household, services: household.services, actorId: 'owner-test', channel: 'mcp', clock: CLOCK, now: NOW,
    ownerText: 'The advisor vetoed this on 2026-11-04. Wait until next year.' };
}
const call = (ctx, operation, args = {}) => callTool('advisor_review', { operation, ...args }, ctx);
const recId = 'fed-q4-estimate';

test('send and veto match HTTP review writes and preserve unavailable Undo reasons', async t => {
  const ctx = await store();
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const sent = await call(ctx, 'send', { recId });
  assert.ok(sent.reviewId);
  assert.equal(sent.undo.available, false);
  assert.match(sent.undo.reason, /record|supersed/i);
  assert.equal(sent.receipt.scope, 'write:recs');
  const route = await srv.postJson('/api/advisor/reviews', { recId });
  assert.equal(route.status, 200, route.text);
  assert.equal(route.json.reviewId, sent.reviewId);
  const args = { reviewId: sent.reviewId, verdict: 'vetoed', note: 'Wait until next year.', date: '2026-11-04',
    evidence: ctx.ownerText };
  const result = await call(ctx, 'verdict', args);
  assert.equal(result.review.verdict, 'vetoed');
  assert.equal(result.review.date, args.date);
  assert.equal(result.undo.available, false);
  assert.match(result.undo.reason, /outside|send.*again/i);
  assert.equal((await ctx.db.prepare('SELECT status FROM recs WHERE id = ?').get(recId)).status, 'dismissed');
  const event = await ctx.db.prepare("SELECT * FROM rec_events WHERE rec_id = ? AND action = 'dismiss' ORDER BY id DESC LIMIT 1").get(recId);
  assert.equal(event.arg, 'advisor vetoed');
  await assert.rejects(callTool('undo', { operation: 'undo', id: sent.receipt.id }, ctx), { code: 'bad_input' });
  const again = await call(ctx, 'send', { recId });
  assert.notEqual(again.reviewId, sent.reviewId);
  const confirmed = await srv.postJson(`/api/advisor/reviews/${again.reviewId}/verdict`, { verdict: 'confirmed', date: CLOCK });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal((await ctx.db.prepare('SELECT verdict FROM advisor_reviews WHERE id = ?').get(again.reviewId)).verdict, 'confirmed');
});

test('verdict requires the owner words for verdict, note and date and refuses repeated verdicts', async () => {
  const ctx = await store();
  const sent = await call(ctx, 'send', { recId });
  const base = { reviewId: sent.reviewId, verdict: 'vetoed', date: '2026-11-04', evidence: ctx.ownerText };
  await assert.rejects(call(ctx, 'verdict', { ...base, note: 'Invented explanation' }), { code: 'bad_input' });
  await assert.rejects(call(ctx, 'verdict', { ...base, verdict: 'confirmed' }), { code: 'bad_input' });
  await assert.rejects(call(ctx, 'verdict', { ...base, date: '2026-02-30' }), { code: 'bad_input' });
  assert.equal((await ctx.db.prepare('SELECT verdict FROM advisor_reviews WHERE id = ?').get(sent.reviewId)).verdict, null);
  await call(ctx, 'verdict', base);
  await assert.rejects(call(ctx, 'verdict', base), { code: 'conflict' });
});

test('advisor verdict choices accept owner-facing approval and rejection words, with the date supplied separately', async () => {
  const ctx = await store();
  for (const [evidence, verdict] of [
    ['My advisor approved it', 'confirmed'], ['The advisor signed off', 'confirmed'], ['My advisor agreed', 'confirmed'],
    ['The advisor said no', 'vetoed'], ['My advisor rejected it', 'vetoed'], ['The advisor declined', 'vetoed'],
    ['My advisor confirmed and approved it', 'confirmed'],
  ]) {
    const { reviewId } = await call(ctx, 'send', { recId });
    const ask = { ...ctx, channel: 'ask', ownerText: evidence };
    const result = await call(ask, 'verdict', { reviewId, verdict, date: CLOCK, evidence });
    assert.equal(result.review.verdict, verdict);
    assert.equal(result.review.date, CLOCK);
  }
  const { reviewId } = await call(ctx, 'send', { recId });
  const evidence = 'My advisor approved it';
  await assert.rejects(call({ ...ctx, channel: 'ask', ownerText: 'We have not asked the advisor' }, 'verdict',
    { reviewId, verdict: 'confirmed', date: CLOCK, evidence }), { code: 'bad_input' });
  await assert.rejects(call({ ...ctx, channel: 'ask', ownerText: evidence }, 'verdict',
    { reviewId, verdict: 'vetoed', date: CLOCK, evidence }), { code: 'bad_input' });
  const mixed = 'The advisor approved one option and rejected another';
  await assert.rejects(call({ ...ctx, channel: 'ask', ownerText: mixed }, 'verdict',
    { reviewId, verdict: 'confirmed', date: CLOCK, evidence: mixed }), { code: 'bad_input' });
});

test('checkin matches its route and Undo restores the full prior row or absence', async t => {
  const ctx = await store();
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const fields = { date: '2026-12-10', time: '14:30', lengthMin: 45 };
  const result = await call(ctx, 'checkin', fields);
  assert.equal(result.checkin.date, fields.date);
  assert.equal(result.checkin.lengthMin, fields.lengthMin);
  await callTool('undo', result.undo.args, ctx);
  assert.equal(await ctx.db.prepare('SELECT * FROM advisor_checkin').get(), undefined);
  const route = await srv.postJson('/api/advisor/checkin', fields);
  assert.equal(route.status, 200, route.text);
  const prior = await ctx.db.prepare('SELECT * FROM advisor_checkin').get();
  const second = await call(ctx, 'checkin', { date: '2026-12-15' });
  assert.ok(second.checkin.lengthMin >= 15);
  await callTool('undo', second.undo.args, ctx);
  assert.deepEqual(await ctx.db.prepare('SELECT * FROM advisor_checkin').get(), prior);
  await assert.rejects(call(ctx, 'checkin', { date: '2026-02-30' }), { code: 'bad_input' });
  await assert.rejects(call(ctx, 'checkin', { ...fields, lengthMin: 10 }), { code: 'bad_input' });
});

test('packet stores encrypted household bytes and matches the HTTP packet content', async t => {
  const ctx = await store();
  await assert.rejects(call(ctx, 'packet'), { code: 'conflict' });
  await call(ctx, 'send', { recId });
  await assert.rejects(call({ ...ctx, services: { ...ctx.services, vault: async () => { throw new VaultError('platform_key_missing'); } } }, 'packet'), { code: 'conflict' });
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM advisor_packets').get()).n, 0);
  const result = await call(ctx, 'packet');
  assert.deepEqual(result.recIds, [recId]);
  assert.equal(result.undo.available, false);
  assert.match(result.undo.reason, /record/);
  const vault = await ctx.services.vault();
  const stored = await readPacket(ctx.db, { id: result.packetId, vault });
  assert.match(stored.bytes.toString(), /Advisor review packet/);
  const srv = await serveAppFixture({ db: ctx.db, config: ctx.household.config, authenticated: true });
  t.after(() => srv.close());
  const route = await srv.postJson('/api/advisor/packets');
  assert.equal(route.status, 200, route.text);
  const other = await readPacket(ctx.db, { id: route.json.packetId, vault });
  assert.equal(other.bytes.toString(), stored.bytes.toString());
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM advisor_packets').get()).n, 2);
});

test('advisor proposals do not write and become stale when reviews or checkin change', async () => {
  const ctx = await store();
  const proposals = [];
  const tool = proposalTools([getTool('advisor_review')])[0];
  await tool.handler({ operation: 'send', recId, propose: true }, { ...ctx, onProposal: p => proposals.push(p) });
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM advisor_reviews').get()).n, 0);
  const p = proposals[0];
  const { setSetting } = await import('../src/store/db.mjs');
  await setSetting(ctx.db, 'ask.titleRejects', { unparsable: 1 });
  await setSetting(ctx.db, 'ask.titleRetried.ask:0123456789ab', true);
  assert.equal(await proposalBasis(ctx.db, p.tool, p.scopes, p.args), p.basis);
  await call(ctx, 'send', { recId });
  assert.notEqual(await proposalBasis(ctx.db, p.tool, p.scopes, p.args), p.basis);
  const before = await proposalBasis(ctx.db, 'advisor_review', ['write:recs'], { date: '2026-12-10' });
  await call(ctx, 'checkin', { date: '2026-12-10', lengthMin: 30 });
  assert.notEqual(await proposalBasis(ctx.db, 'advisor_review', ['write:recs'], { date: '2026-12-10' }), before);
});
