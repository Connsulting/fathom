// Action owner per recommendation (AC2, AC4 owner). The planner assigns a default owner per
// trigger (the household person for retirement and business recs), the owner changes it through
// the rec action endpoint or the MCP tool, an owner-set value (owner_override) survives every
// later planning run, and the scenario and MCP payloads expose owner, ownerOverride, serves and
// housekeeping.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recAction } from '../src/api/handlers.mjs';
import { HttpError } from '../src/api/http.mjs';
import { goalCreate, goalArchive } from '../src/api/goals.mjs';
import { callTool, getTool, ToolError } from '../src/tools/index.mjs';
import { OWNERS } from '../src/shared/rec-links.mjs';
import { planRun } from './helpers/plan.mjs';
import { scratch, addFact, removeFact, recRow, plannerRec, recEvents, SCORP, SOLE_PROP } from './helpers/real-store.mjs';
import { tempDb } from './helpers/server.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-rec-owner-');
after(async () => await S.cleanup());

const plan = async (db, now = NOW) => planRun(db, { now });
const ctxOf = (db, params = {}, body = {}) => ({ db, config: { clock: NOW }, params, body });
const act = async (db, id, action, arg) => await recAction(ctxOf(db, { id }, arg === undefined ? { action } : { action, arg }));
const ownerOf = async (db, id) => ({ ...await db.prepare('SELECT owner, owner_override FROM recs WHERE id = ?').get(id) });
const eventCount = async (db, id) => (await db.prepare('SELECT count(*) AS n FROM rec_events WHERE rec_id = ?').get(id)).n;
const lastEvent = async (db, id) => ({ ...await db.prepare('SELECT action, arg, from_status, to_status, actor FROM rec_events WHERE rec_id = ? ORDER BY id DESC LIMIT 1').get(id) });
const rejects = (fn, status) => assert.rejects(fn, e => e instanceof HttpError && e.status === status, `HTTP ${status}`);
const isCode = code => err => err instanceof ToolError && err.code === code;
const OPEN = s => !['hidden', 'done', 'dismissed'].includes(s);

// Planner defaults on the synthetic household: the S corp and the solo plan belong to the owner,
// both spouses have IRA room (backdoor-roth acts for both).
const BASE_OWNERS = {
  'fed-q4-estimate': 'you', 'va-q4-estimate': 'you', 'year-end-retirement': 'you', 'solo401k-setup': 'you',
  'scorp-salary': 'you', 'invoice-deferral': 'you', 'hsa-room': 'you', va529: 'both', 'charitable-bunching': 'both',
  'backdoor-roth': 'both', 'new-child': 'both',
};
// The same household with the S corp owned by the spouse and the sole proprietorship by the owner.
const SPOUSE_CORP = Object.freeze({ entities: [{ ...SCORP, owner: 'spouse' }, { ...SOLE_PROP, owner: 'owner' }] });
const SPOUSE_RECS = ['year-end-retirement', 'solo401k-setup', 'scorp-salary', 'invoice-deferral'];

async function demoStore() {
  const s = await tempDb();
  await seedDemo(s.db);
  return s;
}

// ---------------------------------------------------------------- planner defaults

describe('planner default owners (AC2)', () => {
  let base;
  before(async () => {
    base = await S.store();
    await plan(base);
  });

  test('each planner rec gets its trigger default owner with no override', async () => {
    for (const [id, owner] of Object.entries(BASE_OWNERS)) {
      assert.deepEqual(await ownerOf(base, id), { owner, owner_override: 0 }, id);
    }
  });

  test('where the spouse owns the S corp, its retirement and business recs default to the spouse', async () => {
    const db = await S.store({ variant: SPOUSE_CORP });
    await plan(db);
    assert.equal((await recRow(db, 'scorp-salary')).def.scenario, 'salary', 'precondition: the salary war game is modelled');
    assert.equal((await recRow(db, 'invoice-deferral')).def.scenario, 'deferral', 'precondition: the deferral war game is modelled');
    for (const id of SPOUSE_RECS) assert.deepEqual(await ownerOf(db, id), { owner: 'spouse', owner_override: 0 }, id);
    // liveness: the same recs on the base household belong to the owner
    for (const id of SPOUSE_RECS) assert.equal((await ownerOf(base, id)).owner, 'you', `base ${id}`);
    // Recs with no person rule keep their static owner.
    assert.equal((await ownerOf(db, 'va529')).owner, 'both');
    assert.equal((await ownerOf(db, 'fed-q4-estimate')).owner, 'you');
  });

  test('a non-overridden owner follows the planner default: a static backfill converges after one run', async () => {
    const db = await S.store({ variant: SPOUSE_CORP });
    await plan(db);
    // As migration 019 leaves a store: the static trigger owner, no override.
    await db.prepare("UPDATE recs SET owner = 'you', owner_override = 0 WHERE id = 'year-end-retirement'").run();
    await plan(db);
    assert.deepEqual(await ownerOf(db, 'year-end-retirement'), { owner: 'spouse', owner_override: 0 });
  });
});

// ---------------------------------------------------------------- the owner action

describe('owner action through recAction (AC2)', () => {
  let s;
  before(async () => { s = await demoStore(); });
  after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });

  test('AC4: setting an owner stores it with the override flag, records a ui event and returns the scenario', async () => {
    const before = (await s.db.prepare("SELECT status FROM recs WHERE id = 'va529'").get()).status;
    assert.deepEqual(await ownerOf(s.db, 'va529'), { owner: 'both', owner_override: 0 });
    const r = await act(s.db, 'va529', 'owner', 'spouse');
    assert.deepEqual(await ownerOf(s.db, 'va529'), { owner: 'spouse', owner_override: 1 });
    assert.deepEqual(await lastEvent(s.db, 'va529'), { action: 'owner', arg: 'spouse', from_status: before, to_status: before, actor: 'ui' });
    assert.equal((await s.db.prepare("SELECT status FROM recs WHERE id = 'va529'").get()).status, before, 'status unchanged');
    const rec = r.scenario.recs.find(x => x.id === 'va529');
    assert.equal(rec.owner, 'spouse');
    assert.equal(rec.ownerOverride, true);
    assert.equal(rec.housekeeping, false);
    assert.deepEqual(rec.serves.map(g => g.id), ['kids']);
    assert.deepEqual(rec.goalKinds, ['education', 'tax']);
    const other = r.scenario.recs.find(x => x.id === 'vaq4');
    assert.equal(other.ownerOverride, false, 'other recs are untouched');
  });

  test('accepts every valid owner', async () => {
    for (const o of OWNERS) {
      const r = await act(s.db, 'vaq4', 'owner', o);
      assert.equal(r.scenario.recs.find(x => x.id === 'vaq4').owner, o, o);
      assert.deepEqual(await ownerOf(s.db, 'vaq4'), { owner: o, owner_override: 1 }, o);
    }
  });

  test('an unknown owner is a 400 and writes nothing', async () => {
    const before = await ownerOf(s.db, 'dcfsa');
    const events = await eventCount(s.db, 'dcfsa');
    for (const bad of ['nobody', 'Spouse', 'YOU', '', null, 3, ['you']]) await rejects(async () => await act(s.db, 'dcfsa', 'owner', bad), 400);
    await rejects(async () => await act(s.db, 'dcfsa', 'owner'), 400);
    assert.deepEqual(await ownerOf(s.db, 'dcfsa'), before);
    assert.equal(await eventCount(s.db, 'dcfsa'), events);
    // liveness: a valid owner on the same rec is accepted
    await act(s.db, 'dcfsa', 'owner', 'advisor');
    assert.equal((await ownerOf(s.db, 'dcfsa')).owner, 'advisor');
  });

  test('a hidden or missing rec is a 404 and writes nothing', async () => {
    assert.equal((await s.db.prepare("SELECT status FROM recs WHERE id = 'daf'").get()).status, 'hidden');
    const before = await ownerOf(s.db, 'daf');
    await rejects(async () => await act(s.db, 'daf', 'owner', 'spouse'), 404);
    await rejects(async () => await act(s.db, 'no-such-rec', 'owner', 'spouse'), 404);
    assert.deepEqual(await ownerOf(s.db, 'daf'), before);
    assert.equal(await eventCount(s.db, 'daf'), 0);
  });
});

// ---------------------------------------------------------------- override survival

describe('an owner override survives planning (AC2)', () => {
  test('a second planning run keeps the override even where the planner default differs; others follow the default', async () => {
    const db = await S.store();
    await plan(db);
    await act(db, 'year-end-retirement', 'owner', 'spouse');
    await act(db, 'hsa-room', 'owner', 'you'); // the same as the default, but owner-set
    await plan(db);
    assert.deepEqual(await ownerOf(db, 'year-end-retirement'), { owner: 'spouse', owner_override: 1 }, 'default is you; the override stays');
    assert.deepEqual(await ownerOf(db, 'hsa-room'), { owner: 'you', owner_override: 1 });
    assert.deepEqual(await ownerOf(db, 'solo401k-setup'), { owner: 'you', owner_override: 0 });
    const sc = await buildScenario(db, { clock: NOW });
    const yr = sc.recs.find(r => r.id === 'year-end-retirement');
    assert.equal(yr.owner, 'spouse');
    assert.equal(yr.ownerOverride, true);
    assert.equal(sc.recs.find(r => r.id === 'solo401k-setup').ownerOverride, false);
  });

  test('the override survives retire then revive', async () => {
    const db = await S.store();
    await plan(db);
    await act(db, 'va529', 'owner', 'advisor');
    await addFact(db, 'accounts.has529', false, { src: 'you', confirmed: true });
    await plan(db);
    assert.ok((await plannerRec(db, 'va529')).retired_at, 'precondition: retired');
    assert.deepEqual(await ownerOf(db, 'va529'), { owner: 'advisor', owner_override: 1 });
    await removeFact(db, 'accounts.has529');
    await plan(db);
    assert.equal((await plannerRec(db, 'va529')).retired_at, null, 'precondition: revived');
    assert.equal((await recRow(db, 'va529')).status, 'proposed');
    assert.deepEqual(await ownerOf(db, 'va529'), { owner: 'advisor', owner_override: 1 });
  });

  test('the override survives a precision gap and its resolution', async () => {
    const db = await S.store();
    await plan(db);
    await act(db, 'va-q4-estimate', 'owner', 'automatic');
    await db.prepare("UPDATE transactions SET category = 'Uncategorized' WHERE lower(category) LIKE '%charit%' OR lower(category) LIKE '%donat%'").run();
    await addFact(db, 'tax.itemizedEstimate', 40000);
    await plan(db, '2026-11-20');
    assert.equal((await recRow(db, 'va-q4-estimate')).status, 'proposed', 'estimate remains actionable');
    assert.ok((await recRow(db, 'va-q4-estimate')).def.gaps.some(g => g.code === 'va_itemized_missing'));
    assert.deepEqual(await ownerOf(db, 'va-q4-estimate'), { owner: 'automatic', owner_override: 1 });
    await addFact(db, 'tax.vaItemizedEstimate', 20000);
    await plan(db, '2026-11-20');
    assert.equal((await recRow(db, 'va-q4-estimate')).status, 'proposed', 'precondition: unblocked');
    assert.deepEqual(await ownerOf(db, 'va-q4-estimate'), { owner: 'automatic', owner_override: 1 });
    const ev = (await recEvents(db, 'va-q4-estimate')).filter(e => e.action === 'owner');
    assert.equal(ev.length, 1, 'one owner event, from the owner');
  });
});

// ---------------------------------------------------------------- MCP

describe('MCP owner tool and linked recs (AC2, AC4)', () => {
  let s;
  let ctx;
  const call = (name, args = {}) => callTool(name, args, ctx);
  before(async () => {
    s = await demoStore();
    ctx = { db: s.db, now: new Date('2026-11-05T15:00:00Z') };
  });
  after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });

  test('act_on_recommendation.owner is a write:recs tool taking id and owner', () => {
    const t = getTool('act_on_recommendation');
    assert.ok(t, 'registered');
    assert.equal(t.operations.find(o => o.name === 'owner').scope, 'write:recs');
    assert.deepEqual([...t.operations.find(o => o.name === 'owner').required].sort(), ['id', 'owner']);
  });

  test('AC4: act_on_recommendation.owner sets the owner, records set_owner by tool and returns the linked rec', async () => {
    const status = (await s.db.prepare("SELECT status FROM recs WHERE id = 'va529'").get()).status;
    const r = await call('act_on_recommendation', { operation: 'owner',  id: 'va529', owner: 'spouse' });
    assert.equal(r.id, 'va529');
    assert.equal(r.owner, 'spouse');
    assert.equal(r.ownerOverride, true);
    assert.equal(r.housekeeping, false);
    assert.ok(Array.isArray(r.serves) && r.serves.length > 0);
    assert.deepEqual(await ownerOf(s.db, 'va529'), { owner: 'spouse', owner_override: 1 });
    assert.deepEqual(await lastEvent(s.db, 'va529'), { action: 'set_owner', arg: 'spouse', from_status: status, to_status: status, actor: 'demo' });
    assert.equal((await call('recommendations', { operation: 'detail',  id: 'va529' })).owner, 'spouse');
  });

  test('act_on_recommendation.owner accepts every valid owner and refuses a bad owner or a hidden rec', async () => {
    for (const o of OWNERS) assert.equal((await call('act_on_recommendation', { operation: 'owner',  id: 'vaq4', owner: o })).owner, o, o);
    const before = await ownerOf(s.db, 'vaq4');
    const events = await eventCount(s.db, 'vaq4');
    for (const bad of ['nobody', 'Spouse', '']) await assert.rejects(call('act_on_recommendation', { operation: 'owner',  id: 'vaq4', owner: bad }), isCode('bad_input'), bad);
    await assert.rejects(call('act_on_recommendation', { operation: 'owner',  id: 'vaq4' }), isCode('bad_input'));
    await assert.rejects(call('act_on_recommendation', { operation: 'owner',  id: 'daf', owner: 'spouse' }), isCode('not_found'));
    await assert.rejects(call('act_on_recommendation', { operation: 'owner',  id: 'no-such-rec', owner: 'spouse' }), isCode('not_found'));
    assert.deepEqual(await ownerOf(s.db, 'vaq4'), before);
    assert.equal(await eventCount(s.db, 'vaq4'), events);
    assert.equal((await ownerOf(s.db, 'daf')).owner_override, 0);
  });

  test('AC4: recommendations.list and recommendations.detail expose owner, ownerOverride, housekeeping and serves', async () => {
    const list = await call('recommendations', { operation: 'list' });
    assert.ok(list.length > 0);
    for (const r of list) {
      assert.ok(OWNERS.includes(r.owner), `${r.id} owner`);
      assert.equal(typeof r.ownerOverride, 'boolean', `${r.id} ownerOverride`);
      assert.equal(typeof r.housekeeping, 'boolean', `${r.id} housekeeping`);
      assert.ok(Array.isArray(r.serves), `${r.id} serves`);
      assert.equal(r.housekeeping, r.serves.length === 0, `${r.id}`);
      const one = await call('recommendations', { operation: 'detail',  id: r.id });
      for (const k of ['owner', 'ownerOverride', 'housekeeping', 'serves']) assert.deepEqual(one[k], r[k], `${r.id} ${k}`);
    }
    assert.equal(list.find(r => r.id === 'umbrella').housekeeping, true);
  });

  test('AC4: household.summary housekeepingCount counts open housekeeping recs', async () => {
    const list = await call('recommendations', { operation: 'list' });
    const n = list.filter(r => r.housekeeping && OPEN(r.status)).length;
    assert.ok(n > 0);
    const sum = await call('household', { operation: 'summary' });
    assert.equal(sum.housekeepingCount, n);
    assert.equal(sum.housekeepingCount, (await buildScenario(s.db, { clock: '2026-11-05' })).live.housekeeping, 'the same definition as the scenario');
  });

  test('AC4: an owner goal titled with brace text stays literal in serves from every rec tool', async () => {
    const gctx = (body = {}, params = {}) => ({ db: s.db, config: { clock: '2026-11-05' }, body, params });
    // Only the owner goal is open, so the retirement rec serves exactly it.
    for (const g of (await buildScenario(s.db, { clock: '2026-11-05' })).goals) await goalArchive(gctx({}, { id: g.id }));
    const TITLE = 'Retire {f:cash.total}';
    const goal = (await goalCreate(gctx({ title: TITLE }))).goal;
    const check = (r, what) => {
      assert.deepEqual(r.serves.map(g => [g.id, g.title, g.origin]), [[goal.id, TITLE, 'owner']], what);
      // Rec text is still token-resolved.
      const { serves, ...rest } = r;
      assert.doesNotMatch(JSON.stringify(rest), /\{f:/, `${what}: rec text resolved`);
    };
    check((await call('recommendations', { operation: 'list' })).find(r => r.id === 'backdoor'), 'recommendations');
    check(await call('recommendations', { operation: 'detail',  id: 'backdoor' }), 'recommendations');
    check(await call('act_on_recommendation', { operation: 'status',  id: 'backdoor', status: 'doing' }), 'act_on_recommendation');
    check(await call('act_on_recommendation', { operation: 'owner',  id: 'backdoor', owner: 'both' }), 'act_on_recommendation');
  });
});
