// AC4 over HTTP: at startup the server replaces the seeded demo pack defs with the loaded
// manifests, serves one pack entry at GET /api/packs/:id/entries/:entryId, keeps the toggle
// working with its note, and sees a fact written straight into the store on the very next
// request (R5): the first GET /api/scenario shows the flipped status and the first ask after the
// change carries the new pack context (provenance.packIds).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SERVER_TIMEOUT, withServer, request, postJson, getScenario, openStore } from './helpers/server.mjs';

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

async function writeDb(file, fn) {
  const db = await openStore(file);
  try { return fn(db); } finally { db.close(); }
}

test('startup replaces the demo pack defs with manifest metadata under the demo ids', T, () => withServer({ env: FAKE }, async s => {
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

test('GET /api/packs/:id/entries/:entryId serves one manifest entry and 404s otherwise', T, () => withServer({ env: FAKE }, async s => {
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

test('toggle keeps working with the planning-run note, and the override survives later refreshes', T, () => withServer({ env: FAKE }, async s => {
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

test('a fact written straight into the store shows on the first GET of the scenario', T, () => withServer({ env: FAKE }, async s => {
  assert.equal(packOf(await getScenario(s.baseUrl), 'giving').status, 'suggested');
  await writeDb(s.dbFile, db => db.prepare("UPDATE facts SET value = 'true' WHERE key = 'giving.charitable'").run());
  const sc = await getScenario(s.baseUrl);
  assert.equal(packOf(sc, 'giving').status, 'active');
}));

test('a fact written straight into the store reaches the pack context of the first ask after it', T, () => withServer({ env: FAKE }, async s => {
  const before = await ok(postJson(s.baseUrl, '/api/ask', { key: 'ask', text: 'Synthetic pack context question' }));
  assert.ok(!before.message.provenance.packIds.includes('charitable-giving'));
  await writeDb(s.dbFile, db => db.prepare("UPDATE facts SET value = 'true' WHERE key = 'giving.charitable'").run());
  const after = await ok(postJson(s.baseUrl, '/api/ask', { key: 'ask', text: 'Synthetic pack context question' }));
  assert.ok(after.message.provenance.packIds.includes('charitable-giving'));
}));

test('a fact change through the db followed by a POST flips activation in that response', T, () => withServer({ env: FAKE }, async s => {
  assert.equal(packOf(await getScenario(s.baseUrl), 'virginia').status, 'active');
  await writeDb(s.dbFile, db => db.prepare("UPDATE facts SET value = '\"MD\"' WHERE key = 'household.state'").run());
  const r = await ok(postJson(s.baseUrl, '/api/engine', { on: true }));
  assert.equal(packOf(r.scenario, 'virginia').status, 'suggested');
}));
