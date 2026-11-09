// Goal links per recommendation (AC1, AC4 links). Every rec serves at least one open goal or is
// explicitly housekeeping. Links are stored as goal kinds on the rec (trigger modules and the demo
// scenario name them) and resolved to goal ids at read time, so adding or archiving a goal relinks
// without a re-plan. Owners per trigger are pinned here too (the planner default; ownerFor picks
// the person from the household when the trigger has one).

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import demo from '../demo/scenario.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { goalCreate, goalArchive } from '../src/api/goals.mjs';
import { recAction } from '../src/api/handlers.mjs';
import { triggers } from '../src/jobs/triggers/index.mjs';
import { recTopics, servesGoals, TOPIC_LABEL } from '../src/shared/goals.mjs';
import { OWNERS, OWNER_LABEL, isOwner, personOwner, recLinkError } from '../src/shared/rec-links.mjs';
import { planRun } from './helpers/plan.mjs';
import { scratch, createRealStore, recRow } from './helpers/real-store.mjs';
import { tempDb } from './helpers/server.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-rec-links-');
after(async () => await S.cleanup());

const OPEN = s => !['hidden', 'done', 'dismissed'].includes(s);
const housekeepingCount = sc => sc.recs.filter(r => r.housekeeping === true && OPEN(r.status)).length;
const ctxOf = (db, body = {}, params = {}) => ({ db, config: { clock: NOW }, body, params });

// ---------------------------------------------------------------- pinned mappings

// [goalKinds, static owner, has ownerFor]
const TRIGGER_MAP = {
  'fed-q4-estimate': [['tax'], 'you', false],
  'va-q4-estimate': [['tax'], 'you', false],
  'year-end-retirement': [['retirement', 'tax'], 'you', true],
  'solo401k-setup': [['retirement'], 'you', true],
  'scorp-salary': [['tax', 'retirement'], 'you', true],
  'invoice-deferral': [['tax'], 'you', true],
  'hsa-room': [['health', 'retirement', 'tax'], 'you', false],
  va529: [['education', 'tax'], 'both', false],
  'charitable-bunching': [['giving', 'tax'], 'both', false],
  'backdoor-roth': [['retirement'], 'you', true],
  'dependent-care-fsa': [['tax', 'cash'], 'both', false],
  'new-child': [['cash', 'health'], 'both', false],
  'missing-data': [[], 'you', false],
};

const DEMO_MAP = {
  offcycle: [['retirement', 'tax'], 'you'],
  deferral: [['tax', 'cash'], 'you'],
  dcfsa: [['tax'], 'both'],
  va529: [['education', 'tax'], 'both'],
  vaq4: [['tax'], 'you'],
  reserve: [['cash', 'tax'], 'automatic'],
  spsep: [['retirement', 'tax'], 'spouse'],
  hsa: [['health', 'retirement', 'tax'], 'you'],
  backdoor: [['retirement'], 'you'],
  spouseentity: [['tax'], 'spouse'],
  babyprep: [['cash', 'health'], 'both'],
  umbrella: [[], 'both'],
  compmemo: [['tax'], 'advisor'],
  filingplan: [[], 'both'],
  mortgage: [['home'], 'both'],
  q3: [['tax'], 'automatic'],
  megabackdoor: [['retirement'], 'advisor'],
  daf: [['giving', 'tax'], 'both'],
};

const byId = id => triggers.find(t => t.id === id);

describe('shared rec-links module', () => {
  test('OWNERS, OWNER_LABEL, isOwner and personOwner', () => {
    assert.deepEqual([...OWNERS], ['you', 'spouse', 'both', 'advisor', 'automatic']);
    assert.deepEqual({ ...OWNER_LABEL }, { you: 'You', spouse: 'Spouse', both: 'Both', advisor: 'Advisor', automatic: 'Automatic' });
    for (const o of OWNERS) assert.equal(isOwner(o), true, o);
    for (const bad of ['Spouse', 'YOU', '', 'owner', 'nobody', null, undefined, 1, {}, ['you']]) assert.equal(isOwner(bad), false, JSON.stringify(bad));
    assert.equal(personOwner('spouse'), 'spouse');
    assert.equal(personOwner('owner'), 'you');
    assert.equal(personOwner(null), 'you');
    assert.equal(personOwner(undefined), 'you');
  });

  test('recLinkError: a rec serves a goal or is housekeeping, exactly one, with a known owner', () => {
    const g = [{ id: 'g', title: 'Kids', origin: 'owner' }];
    assert.equal(recLinkError({ owner: 'you', housekeeping: false, serves: g }), null);
    assert.equal(recLinkError({ owner: 'both', housekeeping: true, serves: [] }), null);
    const errors = [
      ['neither serves nor housekeeping', { owner: 'you', housekeeping: false, serves: [] }],
      ['both serves and housekeeping', { owner: 'you', housekeeping: true, serves: g }],
      ['unknown owner', { owner: 'nobody', housekeeping: true, serves: [] }],
      ['owner case', { owner: 'Spouse', housekeeping: true, serves: [] }],
      ['missing owner', { housekeeping: true, serves: [] }],
      ['housekeeping not boolean', { owner: 'you', housekeeping: 'yes', serves: [] }],
      ['housekeeping missing', { owner: 'you', serves: g }],
      ['serves missing', { owner: 'you', housekeeping: true }],
      ['serves not an array', { owner: 'you', housekeeping: false, serves: 'g' }],
    ];
    for (const [what, rec] of errors) {
      const e = recLinkError(rec);
      assert.equal(typeof e, 'string', what);
      assert.ok(e.length > 0, what);
    }
  });

  test('recTopics is exactly the known goal kinds on the rec; domain, value and id no longer count', () => {
    assert.deepEqual([...recTopics({ goalKinds: ['retirement', 'tax'] })].sort(), ['retirement', 'tax']);
    assert.deepEqual([...recTopics({ goalKinds: ['retirement', 'bogus'] })], ['retirement']);
    assert.equal(recTopics({ id: 'backdoor-roth', domain: 'retirement', value: [{ cls: 'tax' }] }).size, 0);
    assert.equal(recTopics({ id: 'hsa', goalKinds: [] }).size, 0);
    assert.equal(recTopics(null).size, 0);
    // A rec with goal kinds serves a goal of that kind; the same rec without them serves nothing.
    const goals = [{ id: 'k', title: 'Kids college' }];
    assert.deepEqual(servesGoals({ id: 'x', goalKinds: ['education'] }, goals).map(x => x.id), ['k']);
    assert.deepEqual(servesGoals({ id: 'va529', domain: 'family' }, goals), []);
  });
});

describe('trigger modules (AC1)', () => {
  test('every trigger exports goalKinds and owner as pinned, and ownerFor where the owner depends on the household', () => {
    assert.deepEqual(triggers.map(t => t.id).sort(), Object.keys(TRIGGER_MAP).sort(), 'the table covers the catalog');
    for (const t of triggers) {
      const [kinds, owner, hasFor] = TRIGGER_MAP[t.id];
      assert.ok(Array.isArray(t.goalKinds), `${t.id} goalKinds`);
      assert.deepEqual([...t.goalKinds], kinds, `${t.id} goalKinds`);
      for (const k of t.goalKinds) assert.ok(Object.hasOwn(TOPIC_LABEL, k), `${t.id} kind ${k} is a goal topic`);
      assert.equal(t.owner, owner, `${t.id} owner`);
      assert.ok(isOwner(t.owner), `${t.id} owner is an OWNER`);
      assert.equal(typeof t.ownerFor === 'function', hasFor, `${t.id} ownerFor`);
    }
  });

  test('year-end-retirement and solo401k-setup follow the solo plan person; no solo plan keeps the static owner', () => {
    for (const id of ['year-end-retirement', 'solo401k-setup']) {
      const t = byId(id);
      const ctx = solo => ({ info: { solo }, facts: {}, fig: {} });
      assert.equal(t.ownerFor(ctx({ person: 'owner', kind: 'scorp', entity: 'x' }), {}), 'you', id);
      assert.equal(t.ownerFor(ctx({ person: 'spouse', kind: 'sole', entity: 'y' }), {}), 'spouse', id);
      assert.equal(t.ownerFor(ctx(null), {}), t.owner, `${id} with no solo plan`);
    }
  });

  test('scorp-salary and invoice-deferral follow the person the war game models; the confirm form keeps the static owner', () => {
    for (const id of ['scorp-salary', 'invoice-deferral']) {
      const t = byId(id);
      const ctx = { info: { solo: { person: 'owner' } }, facts: {}, fig: {} };
      assert.equal(t.ownerFor(ctx, { person: 'spouse', grounding: [] }), 'spouse', id);
      assert.equal(t.ownerFor(ctx, { person: 'owner', grounding: [] }), 'you', id);
      // The war game person decides, not the solo plan person.
      assert.equal(t.ownerFor({ ...ctx, info: { solo: { person: 'spouse' } } }, { person: 'owner', grounding: [] }), 'you', id);
      assert.equal(t.ownerFor(ctx, { confirm: ['business.cashBasis'], grounding: [] }), t.owner, `${id} confirm form`);
    }
  });

  test('backdoor-roth: both people acting is Both, only the spouse is Spouse, else You', () => {
    const t = byId('backdoor-roth');
    const ctx = { info: {}, facts: {}, fig: {} };
    const p = (person, room, basis = false) => ({ person, proRata: 'clear', room, basis });
    const owner = people => t.ownerFor(ctx, { people, grounding: [] });
    assert.equal(owner([p('owner', true), p('spouse', true)]), 'both');
    assert.equal(owner([p('owner', true), p('spouse', false, true)]), 'both', 'spouse basis only still acts');
    assert.equal(owner([p('owner', false), p('spouse', true)]), 'spouse');
    assert.equal(owner([p('owner', false), p('spouse', false, true)]), 'spouse');
    assert.equal(owner([p('owner', true), p('spouse', false)]), 'you');
    assert.equal(owner([p('owner', true)]), 'you');
    assert.equal(owner([p('owner', false, true)]), 'you');
  });
});

describe('demo store (AC1, AC4)', () => {
  let s;
  before(async () => {
    s = await tempDb();
    await seedDemo(s.db);
  });
  after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });

  test('every rec in demo/scenario.mjs names its goal kinds and owner as pinned', () => {
    assert.deepEqual(demo.recs.map(r => r.id).sort(), Object.keys(DEMO_MAP).sort());
    for (const r of demo.recs) {
      const [kinds, owner] = DEMO_MAP[r.id];
      assert.deepEqual(r.goalKinds, kinds, `${r.id} goalKinds`);
      assert.equal(r.owner, owner, `${r.id} owner`);
    }
  });

  test('AC4: every scenario rec carries owner, ownerOverride, goalKinds, serves and housekeeping, and passes recLinkError', async () => {
    const sc = await buildScenario(s.db, { clock: NOW });
    assert.equal(sc.recs.length, demo.recs.length);
    for (const r of sc.recs) {
      assert.equal(recLinkError(r), null, `${r.id}: ${recLinkError(r)}`);
      assert.ok(Array.isArray(r.serves), `${r.id} serves is always an array`);
      assert.equal(typeof r.housekeeping, 'boolean', `${r.id} housekeeping`);
      assert.equal(r.housekeeping, r.serves.length === 0, `${r.id} housekeeping is derived from serves`);
      assert.equal(r.owner, DEMO_MAP[r.id][1], `${r.id} owner`);
      assert.equal(r.ownerOverride, false, `${r.id} ownerOverride`);
      assert.deepEqual(r.goalKinds, DEMO_MAP[r.id][0], `${r.id} goalKinds`);
    }
    // The stored def does not duplicate the columns.
    for (const row of await s.db.prepare('SELECT id, def FROM recs').all()) {
      const def = JSON.parse(row.def);
      assert.ok(!('owner' in def) && !('goalKinds' in def), `${row.id} def holds no owner or goalKinds`);
    }
  });

  test('AC4: links resolve against open goals: va529 serves the education goal, umbrella and a done goal rec are housekeeping', async () => {
    const sc = await buildScenario(s.db, { clock: NOW });
    const rec = id => sc.recs.find(r => r.id === id);
    assert.deepEqual(rec('va529').serves.map(g => g.id), ['kids']);
    assert.equal(rec('va529').housekeeping, false);
    assert.ok(rec('spsep').serves.some(g => g.id === 'port4'));
    assert.deepEqual(rec('umbrella').serves, []);
    assert.equal(rec('umbrella').housekeeping, true);
    assert.equal(rec('filingplan').housekeeping, true);
    // The only home goal (mortgage) is done, so the mortgage rec links to nothing.
    assert.equal(sc.goals.find(g => g.id === 'mortgage').status, 'done');
    assert.equal(rec('mortgage').housekeeping, true);
  });

  test('AC4: live.housekeeping counts open housekeeping recs (not hidden, done or dismissed)', async () => {
    const sc = await buildScenario(s.db, { clock: NOW });
    assert.equal(typeof sc.live.housekeeping, 'number');
    const n = housekeepingCount(sc);
    assert.ok(n >= 2, 'umbrella and filingplan are open housekeeping recs');
    assert.equal(sc.live.housekeeping, n);
    // mortgage is housekeeping but done, so it is not counted; dismissing umbrella drops the count.
    const after = (await recAction(ctxOf(s.db, { action: 'dismiss' }, { id: 'umbrella' }))).scenario;
    assert.equal(after.live.housekeeping, n - 1);
    assert.equal(after.live.housekeeping, housekeepingCount(after));
    await recAction(ctxOf(s.db, { action: 'start' }, { id: 'umbrella' }));
  });
});

describe('planner on the synthetic real store (AC1, AC4)', () => {
  let db;
  before(async () => {
    db = await S.store();
    await planRun(db, { now: NOW });
  });

  test('AC4: every rec the planner writes carries its trigger goal kinds, a known owner and passes recLinkError', async () => {
    const rows = await db.prepare("SELECT r.id, r.owner, r.owner_override, r.goal_kinds, p.trigger_id FROM recs r JOIN planner_recs p ON p.rec_id = r.id").all();
    assert.ok(rows.length >= 10, 'the synthetic household gets its recs');
    for (const r of rows) {
      const t = byId(r.trigger_id);
      assert.deepEqual(JSON.parse(r.goal_kinds), [...t.goalKinds], `${r.id} goal_kinds`);
      assert.ok(isOwner(r.owner), `${r.id} owner ${r.owner}`);
      assert.equal(r.owner_override, 0, `${r.id} owner_override`);
    }
    const sc = await buildScenario(db, { clock: NOW });
    for (const r of sc.recs) {
      assert.equal(recLinkError(r), null, `${r.id}: ${recLinkError(r)}`);
      assert.deepEqual(r.goalKinds, [...byId(r.id).goalKinds], `${r.id} scenario goalKinds`);
    }
  });

  test('AC4: an owner goal of a matching kind relinks a housekeeping rec without a re-plan; archiving it reverts', async () => {
    const before = await buildScenario(db, { clock: NOW });
    assert.equal(before.goals.length, 0, 'a real store starts without goals');
    const va = before.recs.find(r => r.id === 'va529');
    assert.equal(va.housekeeping, true, 'no goals: every rec is housekeeping');
    assert.deepEqual(va.serves, []);
    assert.equal(before.live.housekeeping, housekeepingCount(before));
    const recsBefore = (await db.prepare('SELECT * FROM recs ORDER BY id').all()).map(r => ({ ...r }));
    const runs = (await db.prepare('SELECT count(*) AS n FROM job_runs').get()).n;

    const { goal, scenario } = await goalCreate(ctxOf(db, { title: 'College for the kids' }));
    const linked = scenario.recs.find(r => r.id === 'va529');
    assert.deepEqual(linked.serves.map(g => g.id), [goal.id]);
    assert.equal(linked.serves[0].origin, 'owner');
    assert.equal(linked.housekeeping, false);
    assert.equal(recLinkError(linked), null);
    assert.equal(scenario.recs.find(r => r.id === 'fed-q4-estimate').housekeeping, true, 'a tax rec does not link to an education goal');
    assert.equal(scenario.live.housekeeping, before.live.housekeeping - 1);
    assert.deepEqual((await db.prepare('SELECT * FROM recs ORDER BY id').all()).map(r => ({ ...r })), recsBefore, 'no rec row was rewritten');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM job_runs').get()).n, runs, 'no planning run');

    const archived = (await goalArchive(ctxOf(db, {}, { id: goal.id }))).scenario;
    const back = archived.recs.find(r => r.id === 'va529');
    assert.deepEqual(back.serves, []);
    assert.equal(back.housekeeping, true);
    assert.equal(archived.live.housekeeping, before.live.housekeeping);
  });
});

test('AC4: missing-data is always housekeeping, whatever goals exist', async () => {
  const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
  await planRun(db, { now: NOW });
  const row = await recRow(db, 'missing-data');
  assert.ok(row, 'an empty real store gets missing-data');
  assert.deepEqual(JSON.parse(row.goal_kinds), []);
  assert.equal(row.owner, 'you');
  for (const title of ['Retire early', 'College fund', 'A year of cash', 'Pay less tax', 'Give more to charity', 'HSA for medical bills', 'Pay off the house']) {
    await goalCreate(ctxOf(db, { title }));
  }
  const sc = await buildScenario(db, { clock: NOW });
  const md = sc.recs.find(r => r.id === 'missing-data');
  assert.equal(sc.goals.length, 7);
  assert.deepEqual(md.serves, []);
  assert.equal(md.housekeeping, true);
  assert.equal(recLinkError(md), null);
  assert.equal(sc.live.housekeeping, 1);
});
