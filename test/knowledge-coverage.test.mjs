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
import { createLiveAnswerer } from '../src/api/answerer.mjs';
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
  inst.db.prepare(`INSERT INTO files (id,name,mime,size,source_kind,uploaded_at,stored_path,status,note)
    VALUES (?,?,'text/plain',?,'upload',? ,?,'parsed','')`).run(ID, NAME, TEXT.length, CLOCK, stored);
  inst.db.prepare("INSERT INTO documents (doc_type,fields,file_id) VALUES ('plan','{}',?)").run(ID);
  const config = loadConfig({ FATHOM_DATA: inst.dataDir, FATHOM_ENGINE: 'fake' });
  const runtime = createRuntimeEngine({ db: inst.db, config });
  return { ...inst, household, runtime, config };
}

function scripted(runtime, stage) {
  return new Proxy(runtime, { get(target, key) {
    if (key === 'extract' && stage === 'extraction') return async () => { throw new ModelCallError('Synthetic extraction failure'); };
    if (key === 'extract' && stage === 'grounding') return request => target.extract({ ...request, fake: [{ text: JSON.stringify({ rows: [
      { title: 'Dental coverage', body: 'The plan covers routine dental care.', excerpt: 'The plan covers routine dental care.', page: 1 },
      { title: 'Vision coverage', body: 'The plan covers lenses.', excerpt: 'The plan covers lenses.', page: 1 },
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
    const first = buildScenario(db, { packs });
    const issues = first.live.yourPlans.coverage;
    assert.ok(issues.length > 0);
    assert.equal(issues[0].stage, stage);
    assert.ok(issues[0].explanation.includes(stage === 'pack-load' ? 'Your plans' : NAME));
    assert.ok(['rebuild', 'replace'].includes(issues[0].action));
    if (stage !== 'pack-load') assert.deepEqual(result.coverage, issues);
    packs = createLivePacks(db, { dataDir: household.root });
    assert.deepEqual(buildScenario(db, { packs }).live.yourPlans.coverage, issues, 'new runtime reads persisted coverage');
    const answerer = createLiveAnswerer({ engine, packs, root: household.root, services: { engine, household, config: s.config } });
    const reply = await answerer.answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say?' });
    assert.ok(reply.paragraphs.some(p => p.includes('does not use') && p.includes(stage === 'pack-load' ? 'Your plans' : NAME)), JSON.stringify(reply.paragraphs));
    if (stage === 'grounding') {
      assert.ok(reply.provenance.packIds.includes('your-plans'), 'valid neighboring sections still inform answers');
      assert.ok(issues[0].explanation.includes('Vision coverage'));
    }
    await storeFile({ vault: await household.vault(), id: ID, bytes: Buffer.from(TEXT), purpose: 'upload' });
    result = await buildYourPlans({ db, household, engine: runtime, clock: CLOCK });
    assert.equal(result.written, true);
    packs.refresh();
    assert.deepEqual(buildScenario(db, { packs }).live.yourPlans.coverage, []);
    const repaired = createLiveAnswerer({ engine: scripted(runtime), packs, root: household.root, services: { engine: runtime, household, config: s.config } });
    const answer = await repaired.answer({ db, key: 'ask:0123456789ab', text: 'What do our plan documents say?' });
    assert.ok(!answer.paragraphs.some(p => p.includes('does not use')));
  });
}
