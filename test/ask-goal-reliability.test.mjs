import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalStore, runCases } from '../evals/harness.mjs';
import { loadCases } from '../evals/cases.mjs';
import { tools } from '../src/tools/index.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer, groundAnswer, renderAnswer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { HORIZONS, HORIZON_IDS } from '../src/shared/goals.mjs';

const now = '2026-11-07T12:00:00.000Z';
const key = 'ask:0123456789ab';
const note = 'Each parent contributes $4,000 in December, due 2026-12-31.';
const args = { title: 'Parent education contribution', horizon: 'now', target: 4000, targetDate: '2026-12-31' };

async function setup(t) {
  const s = await createEvalStore();
  t.after(() => s.close());
  s.db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(key, now);
  const ctx = { db: s.db, now, actorId: 'demo', ownerText: 'yeah', conversationKey: key, turnId: 'goal-turn' };
  return { ...s, ctx, registry: () => createRegistryServer(tools, { purpose: 'chat', ctx }) };
}
function storedGoal(db, text = note) {
  const def = { id: 'education-note', title: 'Education savings', note: text, horizon: 'now', target: 8000, track: null };
  db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)").run(def.id, JSON.stringify(def), now);
}
function message(db, text, provenance, role = 'fathom', thread = key) {
  db.prepare('INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, ?, ?, ?, ?)')
    .run(thread, role, text, now, provenance ? JSON.stringify(provenance) : null);
}
function proposal(db, { sourced = true, target = 4000, thread = key } = {}) {
  const text = `Create a goal for $${target.toLocaleString('en-US')} by 2026-12-31?`;
  const literals = sourced ? [
    { text: `$${target.toLocaleString('en-US')}`, index: text.indexOf('$'), source: 'household summary' },
    { text: '2026-12-31', index: text.indexOf('2026-12-31'), source: 'household summary' },
  ] : [];
  message(db, renderAnswer(text, [], literals).join(''), { literals, grounding: { ok: sourced, unverified: sourced ? [] : [String(target)] } }, 'fathom', thread);
}

test('AC1: replay both failed goal call shapes through the Ask registry, then correct horizon', async t => {
  const { db, registry } = await setup(t);
  storedGoal(db); proposal(db);
  const r = registry();
  for (const extra of [{ note, track: null }, {}]) {
    const rejected = await r.invoke('create_goal', { ...args, horizon: 'This year', ...extra });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /horizon.*(?:one of|allowed)/i);
    assert.equal(r.results.at(-1).result.error, rejected.content[0].text);
    const corrected = await r.invoke('create_goal', { ...args, ...extra });
    assert.ok(!corrected.isError, corrected.content[0].text);
    assert.equal(r.results.at(-1).result.goal.target, 4000);
    assert.equal(r.results.at(-1).result.goal.track, null);
  }
});

test('AC2: create and edit schemas offer canonical horizons with every display label', () => {
  for (const name of ['create_goal', 'edit_goal']) {
    const h = tools.find(t => t.name === name).inputSchema.properties.horizon;
    assert.deepEqual(h.enum, HORIZON_IDS);
    for (const { id, label } of HORIZONS) assert.ok(h.description.includes(id) && h.description.includes(label));
  }
});

test('AC3: schema and handler errors retain argument reasons without sibling household values', async t => {
  const { ctx, registry } = await setup(t);
  ctx.ownerText = 'Use $4,000 by 2026-02-30';
  const r = registry();
  for (const [input, reason] of [
    [{ ...args, target: 'wrong' }, /target.*(?:number|null)/],
    [{ ...args, extra: 'private sibling' }, /extra.*(?:unknown|additional|allowed)/i],
    [{ ...args, title: '' }, /title.*required/],
    [{ ...args, targetDate: '2026-02-30' }, /targetDate.*date/],
    [{ ...args, target: 97361 }, /target.*(?:stated|stored|evidence)/i],
  ]) {
    const out = await r.invoke('create_goal', input);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, reason);
    assert.equal(r.results.at(-1).result.error, out.content[0].text);
    assert.ok(!out.content[0].text.includes('Parent education contribution'));
    assert.ok(!out.content[0].text.includes('private sibling'));
  }
  const unknown = await r.invoke('not_a_tool', {});
  assert.match(unknown.content[0].text, /tool.*(?:unknown|not available)/i);
});

test('AC4: stored goal definitions and notes, facts and available figures support goal values', async t => {
  const { db, registry } = await setup(t);
  storedGoal(db);
  for (const input of [args, { ...args, target: 8000 }]) {
    assert.ok(!(await registry().invoke('create_goal', input)).isError);
  }
  db.prepare("INSERT INTO facts (key, value, confirmed) VALUES ('goal.syntheticTarget', '7319', 1)").run();
  db.prepare("INSERT INTO facts (key, value, confirmed) VALUES ('goal.syntheticDate', ?, 1)").run(JSON.stringify('2028-09-17'));
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 7319, targetDate: '2028-09-17' })).isError);
  const value = db.prepare('SELECT v FROM figures WHERE unavailable_reason IS NULL AND v > 0 LIMIT 1').get().v;
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: value })).isError);
});

test('AC4: sourced immediate stored proposals accept short explicit confirmations', async t => {
  const { db, ctx, registry } = await setup(t);
  proposal(db, { target: 97361 });
  for (const reply of ['yes', 'yeah', 'sure', 'do it', 'go ahead', 'ok', 'okay', 'Yes, please create it.']) {
    ctx.ownerText = reply;
    const out = await registry().invoke('create_goal', { ...args, target: 97361 });
    assert.ok(!out.isError, `${reply}: ${out.content[0].text}`);
  }
});

test('AC4: invented, unsourced, negative, delayed and current-turn proposals confirm nothing', async t => {
  const { db, ctx, registry } = await setup(t);
  const input = { ...args, target: 97361 };
  proposal(db, { sourced: false, target: input.target });
  assert.equal((await registry().invoke('create_goal', input)).isError, true);
  proposal(db, { target: input.target });
  for (const reply of ['no', 'wait', 'not yet', 'yeah but wait', 'yes, do not create it', 'okay maybe later', 'surely not', 'yesterday']) {
    ctx.ownerText = reply;
    assert.equal((await registry().invoke('create_goal', input)).isError, true, reply);
  }
  ctx.ownerText = 'yeah';
  message(db, 'Something unrelated.', null);
  assert.equal((await registry().invoke('create_goal', input)).isError, true);
  const before = registry();
  proposal(db, { target: input.target });
  assert.equal((await before.invoke('create_goal', input)).isError, true, 'only pre-existing assistant rows count');
  assert.ok(!(await registry().invoke('create_goal', input)).isError, 'next request can confirm saved proposal');
});

test('AC4: a stored confirmation belongs to its actor and thread', async t => {
  const { db, ctx, registry } = await setup(t);
  proposal(db, { target: 97361 });
  message(db, 'yeah', { ownerInput: { actorId: 'someone-else' } }, 'me');
  ctx.ownerText = null;
  assert.equal((await registry().invoke('create_goal', { ...args, target: 97361 })).isError, true);
  message(db, 'yeah', { ownerInput: { actorId: 'demo' } }, 'me');
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 97361 })).isError);
});

test('AC5 and AC3: real Ask gets read/retry rules and saves failed write reasons', async t => {
  const { db } = await setup(t);
  const transport = createEngine({ mode: 'fake' });
  let seen;
  const engine = { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: 'Contribution goals', toolResults: [] });
    seen = request.system;
    return transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'create_goal', args: { ...args, horizon: 'This year' } }] },
      { text: 'The horizon needs a valid identifier.' },
    ] });
  } };
  const response = await threadCreate({ db, config: {}, answerer: createLiveAnswerer({ engine }), body: { text: 'Create my contribution goal.' } });
  assert.match(seen, /read-only lookups.*before replying/i);
  assert.match(seen, /all.*529.*checking.*transfers/i);
  assert.match(seen, /never ask permission to read/i);
  assert.match(seen, /failed write.*quote.*reason.*retry.*corrected arguments/i);
  assert.match(seen, /never.*UI.*discover.*error/i);
  assert.match(response.message.provenance.tools.find(t => t.name === 'create_goal').result.error, /horizon/i);
});

test('AC6: Ask excludes small counts and ordinals, and still checks money, percents and dates', async t => {
  const { db } = await setup(t);
  const scenario = buildScenario(db);
  for (const text of ['There are two goals, one per parent.', 'Option 2 is ready; step 3 follows.', 'Choose the twentieth option.', 'There are twenty accounts.', 'There are 20 goals.']) {
    assert.equal(groundAnswer(text, { scenario }).ok, true, text);
  }
  for (const text of ['$2', 'two dollars', 'twenty percent', '2%', '2029-12-31', 'January 2, 2029', 'There are twenty-one accounts.']) {
    assert.equal(groundAnswer(text, { scenario }).ok, false, text);
  }
});

test('AC7: tier one replays a stored-note proposal and confirmed create through real Ask', async () => {
  const c = (await loadCases()).find(c => c.id === 'goals-confirm-stored-note');
  assert.ok(c, 'goal confirmation case is in the default tier-one catalog');
  const score = await runCases({ cases: [c] });
  assert.equal(score.cases[0].status, 'pass', JSON.stringify(score.cases[0]));
  const turn = score.cases[0].turns.at(-1);
  const write = turn.tools.find(t => t.name === 'create_goal');
  assert.equal(write.result.goal.horizon, 'now');
  assert.equal(write.result.goal.target, 4000);
  assert.equal(write.result.goal.targetDate, '2026-12-31');
  assert.ok(write.result.receipt.id);
});
