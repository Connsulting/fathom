import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempInstance } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { storeFile } from '../src/ingest/vault.mjs';
import { buildYourPlans } from '../src/packs/your-plans.mjs';
import { createLivePacks, yourPlansDir } from '../src/packs/live.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { createLiveAnswerer, NOTICES } from '../src/api/answerer.mjs';
import { callTool } from '../src/tools/index.mjs';
import { ModelCallError } from '../src/engine/errors.mjs';

const ID = 'coverage-plan';
const NAME = 'synthetic-benefits.txt';
const TEXT = '# Dental coverage\n\nThe plan covers routine dental care.\n';
const CLOCK = '2026-11-08';

async function fixture(t) {
  const inst = await tempInstance({ mode: 'demo', init: seedDemo });
  t.after(() => { inst.close(); rmSync(inst.dataDir, { recursive: true, force: true }); });
  const household = await inst.household();
  const stored = await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(TEXT), purpose: 'upload' });
  await inst.db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
    VALUES (?,?,'text/plain',?,'upload',? ,?,'parsed','')`).run(ID, NAME, TEXT.length, CLOCK, stored);
  await inst.db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(ID);
  const config = loadConfig({ FATHOM_DATA: inst.dataDir, FATHOM_ENGINE: 'fake' });
  const runtime = await createRuntimeEngine({ db: inst.db, config });
  return { ...inst, household, runtime, config };
}

function scripted(runtime, stage) {
  return new Proxy(runtime, { get(target, key) {
    if (key === 'extract' && stage === 'extraction') return async () => { throw new ModelCallError('Synthetic extraction failure'); };
    if (key === 'extract' && stage === 'grounding') return request => target.extract({ ...request, fake: [{ text: JSON.stringify({ rows: [
      { title: 'Dental coverage', body: 'The plan covers routine dental care.', excerpt: 'The plan covers routine dental care.', page: 1 },
      { title: 'Vision coverage', body: 'The plan covers lenses.', excerpt: 'The plan covers lenses.', page: 1 },
      { title: 'Hearing coverage', body: 'The plan covers hearing care.', excerpt: 'The plan covers hearing care.', page: 1 },
    ] }) }] });
    if (key === 'call') return request => target.call({ ...request, fake: [{ text: 'Compare the available plan choices.' }] });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const stage of ['source-read', 'extraction', 'grounding', 'pack-load']) {
  test(`${stage}: the build gap survives reload, discloses missing knowledge in Ask, and clears after repair`, async t => {
    const s = await fixture(t);
    const { db, household, runtime } = s;
    const engine = scripted(runtime, stage);
    if (stage === 'source-read') rmSync(join(household.root, 'files', `${ID}.bin`));
    let result = await buildYourPlans({ db, household, engine, clock: CLOCK });
    if (stage === 'pack-load') writeFileSync(join(yourPlansDir(household.root), 'manifest.json'), '{invalid');
    let packs = createLivePacks(db, { dataDir: household.root });
    packs.refresh();
    const first = await buildScenario(db, { packs });
    const issues = first.live.yourPlans.coverage;
    assert.ok(issues.length > 0);
    assert.equal(issues[0].stage, stage);
    assert.ok(issues[0].explanation.includes(stage === 'pack-load' ? 'Your plans' : NAME));
    assert.ok(['rebuild', 'replace'].includes(issues[0].action));
    if (stage !== 'pack-load') assert.deepEqual(result.coverage, issues);
    packs = createLivePacks(db, { dataDir: household.root });
    assert.deepEqual((await buildScenario(db, { packs })).live.yourPlans.coverage, issues, 'new runtime reads persisted coverage');
    const answerer = createLiveAnswerer({ engine, packs, root: household.root, services: { engine, household, config: s.config } });
    const reply = await answerer.answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say?' });
    assert.ok(reply.paragraphs.some(p => p.includes('does not use') && p.includes(stage === 'pack-load' ? 'Your plans' : NAME)), JSON.stringify(reply.paragraphs));
    if (stage === 'grounding') {
      assert.ok(reply.provenance.packIds.includes('your-plans'), 'valid neighboring sections still inform answers');
      assert.ok(issues[0].explanation.includes('Vision coverage'));
      const disclosures = reply.paragraphs.filter(p => p.includes('does not use'));
      assert.equal(disclosures.length, 1, 'missing sections share one plain disclosure line');
      assert.ok(disclosures[0].includes('Hearing coverage'));
    }
    await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(TEXT), purpose: 'upload' });
    result = await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
    assert.equal(result.written, true);
    packs.refresh();
    assert.deepEqual((await buildScenario(db, { packs })).live.yourPlans.coverage, []);
    const repaired = createLiveAnswerer({ engine: scripted(runtime), packs, root: household.root, services: { engine: runtime, household, config: s.config } });
    const answer = await repaired.answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say?' });
    assert.ok(!answer.paragraphs.some(p => p.includes('does not use')));
  });
}

test('a failed rebuild excludes older document knowledge, and an explicitly disabled pack stays silent', async t => {
  const s = await fixture(t);
  const { db, household, runtime } = s;
  await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  const packs = createLivePacks(db, { dataDir: household.root });
  packs.refresh();
  assert.equal(packs.entry('your-plans', '01-dental-coverage').title, 'Dental coverage');
  await buildYourPlans({ db, household, engine: scripted(runtime, 'extraction'), clock: CLOCK });
  assert.equal(packs.entry('your-plans', '01-dental-coverage'), null, 'an older successful build cannot silently supply a failed document');
  const toolContext = { db, dataDir: household.root };
  await assert.rejects(callTool('knowledge', { operation: 'entry', packId: 'your-plans', file: '01-dental-coverage.md' }, toolContext), error => error.code === 'not_found');
  assert.equal((await callTool('knowledge', { operation: 'search', query: 'routine dental' }, toolContext)).total, 0);
  await db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'your-plans'").run();
  const engine = scripted(runtime);
  const answerer = createLiveAnswerer({ engine, packs, root: household.root, services: { engine, household, config: s.config } });
  const reply = await answerer.answer({ db, key: 'ask:0123456789ab', text: 'What are our choices?' });
  assert.ok(!reply.paragraphs.some(p => p.includes('does not use')));
  assert.ok(!reply.provenance.packIds.includes('your-plans'));
});

test('a pack removed from disk is disclosed, and a corrected rebuild clears the persisted load failure', async t => {
  const s = await fixture(t);
  const { db, household, runtime } = s;
  await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  const packs = createLivePacks(db, { dataDir: household.root });
  packs.refresh();
  rmSync(yourPlansDir(household.root), { recursive: true });
  assert.ok((await buildScenario(db, { packs })).live.yourPlans.coverage.some(issue => issue.stage === 'pack-load'));
  await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  assert.deepEqual((await buildScenario(db, { packs })).live.yourPlans.coverage, []);
});

test('missing knowledge cannot turn an empty model response into a successful answer', async t => {
  const s = await fixture(t);
  const { db, household, runtime } = s;
  await buildYourPlans({ db, household, engine: scripted(runtime, 'extraction'), clock: CLOCK });
  const engine = new Proxy(runtime, { get(target, key) {
    if (key === 'call') return request => target.call({ ...request, fake: [{ text: '' }] });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const packs = createLivePacks(db, { dataDir: household.root });
  const reply = await createLiveAnswerer({ engine, packs, root: household.root, services: { engine, household, config: s.config } })
    .answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say?' });
  assert.equal(reply.notice, true);
  assert.deepEqual(reply.paragraphs, [NOTICES.modelError]);
});

test('an unreadable text-only document can be removed from the pack without deleting its stored record', async t => {
  const s = await fixture(t);
  const { db, household, runtime } = s;
  const inserted = await db.prepare("INSERT INTO documents (doc_type,fields) VALUES ('plan',?)").run(JSON.stringify({ text: '' }));
  const documentId = Number(inserted.lastInsertRowid);
  const result = await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  assert.ok(result.coverage.some(issue => issue.documentId === documentId && issue.action === 'remove'));
  const repaired = await buildYourPlans({ db, household, engine: runtime, clock: CLOCK, excludeDocumentIds: [documentId] });
  assert.deepEqual(repaired.coverage, []);
  assert.ok(await db.prepare('SELECT 1 FROM documents WHERE id = ?').get(documentId));
  assert.deepEqual((await buildYourPlans({ db, household, engine: runtime, clock: CLOCK })).coverage, [], 'the exclusion survives later builds');
});

test('removing the last document does not restore its older pack entries on an empty rebuild', async t => {
  const s = await fixture(t);
  const { db, household, runtime } = s;
  await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  const packs = createLivePacks(db, { dataDir: household.root });
  packs.refresh();
  await db.prepare('UPDATE files SET removed_at = ? WHERE id = ?').run(CLOCK, ID);
  const rebuilt = await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
  assert.deepEqual(rebuilt.coverage, []);
  assert.equal(packs.entry('your-plans', '01-dental-coverage'), null);
  const result = await callTool('knowledge', { operation: 'search', query: 'routine dental' }, { db, dataDir: household.root });
  assert.equal(result.total, 0);
});
