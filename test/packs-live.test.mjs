// AC4 over HTTP: the scenario shows the seeded demo pack defs with the loaded manifests' fields
// (src/packs/live.mjs), the server serves one pack entry at GET /api/packs/:id/entries/:entryId,
// and the toggle keeps working with its note. Fact changes refresh pack state through ingest
// (refreshPackState, real stores only), so direct store writes are not watched per request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SERVER_TIMEOUT, withServer, request, postJson, getScenario, openStore, tempDb, tempInstance } from './helpers/server.mjs';
import { writeSyntheticPack, NEVER } from './helpers/packs.mjs';
import { escapeUserText, money } from '../src/shared/tokens.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { buildScenario } from '../src/scenario/build.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake' };
const NOTE = 'Recommendations update on the next planning run.';
const manifestOf = id => JSON.parse(readFileSync(join(ROOT, 'packs', id, 'manifest.json'), 'utf8'));
const packOf = (scenario, id) => scenario.packs.find(p => p.id === id);

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

test('the scenario shows the demo pack defs with manifest metadata under the demo ids', T, async () => withServer({ env: FAKE }, async s => {
  const sc = await getScenario(s.baseUrl);
  const giving = packOf(sc, 'giving');
  const manifest = manifestOf('charitable-giving');
  assert.equal(giving.manifest, 'charitable-giving');
  assert.equal(giving.version, manifest.version);
  assert.equal(giving.taxYear, manifest.taxYear);
  assert.equal(giving.reviewed, manifest.reviewed);
  assert.equal(giving.entryList.length, manifest.entries.length);
  assert.ok(giving.entryList.every(e => typeof e.id === 'string' && typeof e.title === 'string' && Array.isArray(e.cites)));
  assert.equal(giving.status, 'suggested');
  assert.equal(giving.name, 'Charitable giving');
  const scorp = packOf(sc, 'scorp');
  assert.equal(scorp.status, 'active');
  assert.equal(scorp.manifest, 's-corp-owner');
  assert.equal(scorp.version, manifestOf('s-corp-owner').version);
  assert.ok(!sc.packs.some(p => p.id === 's-corp-owner' || p.id === 'charitable-giving'), 'no duplicate rows');
  const contractor = packOf(sc, 'contractor');
  assert.equal(contractor.status, 'available');
  assert.equal(contractor.version, undefined, 'illustrative packs are untouched');
}));

test('GET /api/packs/:id/entries/:entryId serves one manifest entry and 404s otherwise', T, async () => withServer({ env: FAKE }, async s => {
  const r = await ok(request(s.baseUrl, { path: '/api/packs/giving/entries/bunching' }));
  const manifest = manifestOf('charitable-giving');
  const listed = manifest.entries.find(e => e.file === 'bunching.md');
  assert.deepEqual(Object.keys(r.entry).sort(), ['body', 'cites', 'id', 'title']);
  assert.equal(r.entry.id, 'bunching');
  assert.equal(r.entry.title, listed.title);
  assert.equal(r.entry.body, readFileSync(join(ROOT, 'packs', 'charitable-giving', 'bunching.md'), 'utf8'));
  assert.deepEqual(r.entry.cites.map(c => c.url).sort(), listed.cites.map(c => c.url).sort());
  for (const path of [
    '/api/packs/giving/entries/no-such-entry',
    '/api/packs/no-such-pack/entries/bunching',
    '/api/packs/contractor/entries/bunching',
    '/api/packs/giving/entries/..%2Fmanifest',
    '/api/packs/giving/entries/bunching.md',
  ]) {
    const miss = await request(s.baseUrl, { path });
    assert.equal(miss.status, 404, `${path} -> ${miss.status}`);
    assert.equal(typeof miss.json?.error, 'string');
  }
  assert.equal((await postJson(s.baseUrl, '/api/packs/giving/entries/bunching', {})).status, 405);
}));

test('toggle keeps working with the planning-run note, and the override survives later refreshes', T, async () => withServer({ env: FAKE }, async s => {
  const on = await ok(postJson(s.baseUrl, '/api/packs/giving/toggle', {}));
  assert.equal(on.status, 'active');
  assert.equal(on.note, NOTE);
  assert.equal(on.scenario.live.packs.giving.active, true);
  const sc = await getScenario(s.baseUrl);
  assert.equal(sc.live.packs.giving.active, true);
  const off = await ok(postJson(s.baseUrl, '/api/packs/giving/toggle', {}));
  assert.equal(off.status, 'suggested');
  assert.equal(off.note, NOTE);
}));

// ---------------------------------------------------------------- B4: a manifest What if prompt is literal text

// A synthetic manifest pack in the data volume pack directory whose What if prompt carries markup
// and a real figure token (true_reserve is a demo figure). It is never active, so What if is offered.
const HOSTILE_ID = 'synthetic-whatif';
const HOSTILE_PROMPT = 'Would <img src=x onerror=alert(1)> change {f:true_reserve} for us?';
const HOSTILE_PACK = { id: HOSTILE_ID, name: 'Synthetic what if', prompt: HOSTILE_PROMPT, appliesWhen: NEVER, covers: ['synthetic choices'] };

test('B4: POST /api/packs/:id/whatif stores a manifest prompt as escaped literal text', T, async t => {
  // A demo instance built as the server builds one, with the synthetic pack in its household root
  // (households/<id>/packs/your-plans) before the server starts.
  const inst = await tempInstance({ mode: 'demo', init: seedDemo });
  const dataDir = inst.dataDir;
  inst.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeSyntheticPack(inst.root, HOSTILE_PACK);
  await withServer({ dataDir, env: FAKE }, async s => {
    const def = packOf(await getScenario(s.baseUrl), HOSTILE_ID);
    assert.ok(def, 'the synthetic pack is loaded from the data volume');
    assert.equal(def.manifest, HOSTILE_ID);
    assert.notEqual(def.status, 'active');
    assert.equal(def.whatIf.prompt, HOSTILE_PROMPT);

    const { scenario } = await ok(postJson(s.baseUrl, `/api/packs/${HOSTILE_ID}/whatif`, {}));
    const conv = scenario.live.conversations[`pack:${HOSTILE_ID}`];
    assert.equal(conv[0].role, 'me');
    const stored = conv[0].text;
    assert.equal(stored, escapeUserText(HOSTILE_PROMPT));
    assert.ok(stored.includes('&lt;img'), stored);
    assert.ok(!stored.includes('<img'), stored);
    assert.ok(stored.includes('&#123;f:'), stored);
    assert.ok(!stored.includes('{f:true_reserve}'), stored);
    assert.equal(conv[1].role, 'fathom');
    assert.equal(conv[1].notice, false);
    const db = await openStore(s.dbFile);
    try {
      const row = await db.prepare("SELECT text FROM messages WHERE conversation_key = ? AND role = 'me'").get(`pack:${HOSTILE_ID}`);
      assert.equal(row.text, escapeUserText(HOSTILE_PROMPT));
    } finally { await db.close(); }
  });
});

test('B4: the What if question for a manifest pack is the raw prompt, and its stored form is dropped from history', async t => {
  const s = await tempDb();
  t.after(() => { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); });
  await seedDemo(s.db);
  // The temp store's directory stands in as the household root.
  writeSyntheticPack(s.dataDir, HOSTILE_PACK);
  const runtime = await createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' }) });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  const requests = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') return async request => { requests.push(request); return target.call(request); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const answerer = createLiveAnswerer({ engine, packs, root: s.dataDir, services: { engine, config: { dataDir: s.dataDir } } });
  const figure = money((await buildScenario(s.db)).fig.true_reserve.v);

  const first = await answerer.whatIf({ db: s.db, packId: HOSTILE_ID });
  assert.ok(!first.notice);
  const question = requests[0].messages.at(-1);
  assert.equal(question.role, 'user');
  assert.equal(question.content, HOSTILE_PROMPT, 'the literal token text reaches the engine unresolved');
  assert.ok(!question.content.includes(figure), 'the figure value never replaces the token');

  // A prior notice round stored the owner message in its stored (escaped) form.
  const key = `pack:${HOSTILE_ID}`;
  await s.db.prepare('INSERT OR IGNORE INTO conversations (key, created_at) VALUES (?, ?)').run(key, '2026-11-05T09:00:00.000Z');
  const insert = s.db.prepare('INSERT INTO messages (conversation_key, role, text, refs, notice, ts, provenance) VALUES (?, ?, ?, ?, ?, ?, NULL)');
  await insert.run(key, 'me', escapeUserText(HOSTILE_PROMPT), '[]', 0, 'Nov 5, 9:00 AM');
  await insert.run(key, 'fathom', '<p>Engine is off, so answers are paused.</p>', '[]', 1, 'Nov 5, 9:00 AM');
  await answerer.whatIf({ db: s.db, packId: HOSTILE_ID });
  const turns = requests[1].messages.filter(m => String(m.content).includes('onerror'));
  assert.equal(turns.length, 1, 'the earlier copy of the prompt is dropped; only the question remains');
  assert.equal(requests[1].messages.at(-1).content, HOSTILE_PROMPT);
});

test('B4: an illustrative demo pack What if keeps its token form in the stored message', T, async () => withServer({ env: FAKE }, async s => {
  const def = packOf(await getScenario(s.baseUrl), 'contractor');
  assert.equal(def.manifest, undefined, 'contractor is illustrative');
  assert.ok(def.whatIf.prompt.includes('{n:'), 'its prompt carries a token');
  const { scenario } = await ok(postJson(s.baseUrl, '/api/packs/contractor/whatif', {}));
  assert.equal(scenario.live.conversations['pack:contractor'][0].text, def.whatIf.prompt);
}));
