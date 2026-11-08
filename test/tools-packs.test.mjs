// AC2: the knowledge pack tools (knowledge.packs, knowledge.entry, knowledge.search) on the demo store
// with the repo packs, and on a synthetic temp pack dir passed as ctx.packDirs.

import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo } from '../demo/seed.mjs';
import { tools, getTool, callTool, ToolError } from '../src/tools/index.mjs';
import { loadPacks, activePacks } from '../src/packs/index.mjs';
import { compileSchema } from '../src/engine/schema.mjs';
import { parseJson } from '../src/store/db.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { packStatus } from '../src/shared/rules.mjs';
import { resolveTokens } from '../src/shared/tokens.mjs';
import { tokenScope } from '../src/scenario/build.mjs';
import { ROOT, tempDb, tempDir } from './helpers/server.mjs';

const NAMES = ['knowledge'];
const PACK_FIELDS = ['covers', 'entries', 'id', 'name', 'reviewed', 'status', 'taxYear', 'version', 'why'];
const ENTRY_FIELDS = ['citations', 'file', 'id', 'markdown', 'packId', 'packName', 'reviewed', 'taxYear', 'title', 'version'];
const RESULT_FIELDS = ['file', 'id', 'packId', 'score', 'snippet', 'title'];
const NOW = new Date('2026-11-05T15:00:00Z');
const isCode = code => err => err instanceof ToolError && err.code === code;

async function setFact(db, key, value) {
  await db.prepare(`INSERT OR REPLACE INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run(key, JSON.stringify(value));
}

async function setPackState(db, id, active) {
  await db.prepare(`INSERT OR REPLACE INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
              VALUES (?, '{}', ?, 0, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run(id, active);
}

// ---------------------------------------------------------------- pack link helpers

const REPO_PACKS = join(ROOT, 'packs');
// The demo rows that link to a repo manifest (row id -> manifest id), independent of the code under test.
const LINKS = {
  scorp: 's-corp-owner',
  selfemp: 'self-employed-partnership',
  w2: 'w2-benefits',
  virginia: 'virginia-resident',
  kids: 'kids-dependents',
  retire: 'advanced-retirement',
  giving: 'charitable-giving',
};
// What the seeded demo rows say with no owner override: row def.status through packStatus.
const SEEDED_STATUS = {
  'advanced-retirement': 'active',
  'charitable-giving': 'suggested',
  'kids-dependents': 'active',
  's-corp-owner': 'active',
  'self-employed-partnership': 'active',
  'account-tax-treatment': 'active',
  'spending-and-obligations': 'active',
  'virginia-resident': 'active',
  'w2-benefits': 'active',
};
const ON = 'Turned on by the owner.';
const OFF = 'Turned off by the owner.';

const rowOf = async (db, id) => {
  const r = await db.prepare('SELECT id, def, active, exploring FROM packs_state WHERE id = ?').get(id);
  return r && { ...r, def: parseJson(r.def, {}) };
};

// The rule from the spec, written out: base is the row def.status when a string, else the
// facts-derived status; live is the row's override columns; a manifest pack with no linked row keeps
// the facts-derived view. A row links by def.manifest, else by its own id.
async function expectedView(db, dirs = [REPO_PACKS]) {
  const rows = (await db.prepare('SELECT id, def, active, exploring FROM packs_state').all()).map(r => ({ ...r, def: parseJson(r.def, {}) }));
  const scope = await tokenScope(db);
  return activePacks(loadPacks(dirs), await getFacts(db)).map(v => {
    const row = rows.find(r => (typeof r.def.manifest === 'string' ? r.def.manifest : r.id) === v.pack.id);
    if (!row) return v;
    const live = { active: row.active == null ? null : Boolean(row.active), exploring: Boolean(row.exploring) };
    const status = packStatus(typeof row.def.status === 'string' ? row.def.status : v.status, live);
    let why = v.why;
    if (row.active != null) why = row.active ? ON : OFF;
    else if (typeof row.def.why === 'string' && row.def.why) why = resolveTokens(scope, row.def.why, false);
    return { pack: v.pack, status, why };
  });
}

const viewOf = async (db, manifestId) => (await expectedView(db)).find(v => v.pack.id === manifestId);
const listed = async (ctx, id) => (await callTool('knowledge', { operation: 'packs', }, ctx)).find(p => p.id === id);
const packOf = id => loadPacks([REPO_PACKS]).find(p => p.id === id);

// The full title of the pack's first entry as a query: every term sits in that entry, so it matches
// whenever the pack is searched.
const titleQuery = id => packOf(id).entries[0].title;

async function hits(ctx, id, extra = {}) {
  const r = await callTool('knowledge', { operation: 'search',  query: titleQuery(id), limit: 20, ...extra }, ctx);
  return r.results.filter(x => x.packId === id);
}

// Tool contexts carry the household root as dataDir (MT-03); a temp store's directory stands in as
// one with no private Your plans pack, so only the repo packs load.
async function freshDemo() {
  const t = await tempDb();
  await seedDemo(t.db);
  return { t, ctx: { db: t.db, now: NOW, dataDir: t.dataDir } };
}

// ---------------------------------------------------------------- synthetic pack fixture

const CITE = { label: 'IRS Publication 505', url: 'https://www.irs.gov/publications/p505' };
const CITE2 = { label: 'A synthetic second source', url: 'https://www.irs.gov/forms-pubs' };

function writePack(root, manifest, bodies) {
  const dir = join(root, manifest.id);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(bodies)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function base(id, name, rules, entries) {
  return {
    id, name, version: '1.2.3', taxYear: 2026, reviewed: '2026-10-01', curator: 'Synthetic test fixture',
    covers: ['synthetic coverage b', 'synthetic coverage a'], ...rules,
    whatIf: { prompt: 'What changes in this synthetic case?' }, entries,
  };
}

const GIZMOS = 24;
const pad = n => String(n).padStart(2, '0');

async function writeFixture() {
  const root = await tempDir('fathom-packs-');
  const alphaBodies = {
    'quarterly-widgets.md': 'One widget here.\nPlanning   notes   follow\n\nwith extra   whitespace.\n',
    'zebra-notes.md': 'widget widget widget zebra stripes.\n',
    'guides/deep-dive.md': 'A deep dive on the synthetic topic. Nothing else.\n',
  };
  const alphaEntries = [
    { file: 'quarterly-widgets.md', title: 'Quarterly widget planning', cites: [CITE] },
    { file: 'zebra-notes.md', title: 'Zebra notes', cites: [CITE] },
    { file: 'guides/deep-dive.md', title: 'Deep dive guide', cites: [CITE2, CITE] },
  ];
  for (let i = 1; i <= GIZMOS; i++) {
    alphaBodies[`item-${pad(i)}.md`] = `Entry ${i} mentions a gizmo once. ${'filler text '.repeat(40)}\n`;
    alphaEntries.push({ file: `item-${pad(i)}.md`, title: `Item ${pad(i)}`, cites: [CITE] });
  }
  writePack(root, base('alpha-test', 'Alpha synthetic pack', { appliesWhen: { fact: 'income.selfEmployed', op: 'eq', value: true } }, alphaEntries), alphaBodies);
  writePack(root, base('beta-test', 'Beta synthetic pack', {
    appliesWhen: { fact: 'household.expectingChild', op: 'eq', value: true },
    suggestWhen: { fact: 'income.selfEmployed', op: 'eq', value: true },
  }, [{ file: 'beta-widget.md', title: 'Beta widget entry', cites: [CITE] }]), { 'beta-widget.md': 'A widget in a suggested pack.\n' });
  writePack(root, base('gamma-test', 'Gamma synthetic pack', { appliesWhen: { fact: 'test.flag', op: 'eq', value: true } },
    [{ file: 'gamma-widget.md', title: 'Gamma widget entry', cites: [CITE] }]), { 'gamma-widget.md': 'A widget in an available pack.\n' });
  return root;
}

// ---------------------------------------------------------------- suites

describe('registry entries', () => {
  test('the three pack tools are registered read tools with strict-compilable schemas', () => {
    for (const n of NAMES) {
      const x = getTool(n);
      assert.ok(x, `registered ${n}`);
      assert.equal(x.kind, 'read');
      assert.ok(typeof x.description === 'string' && x.description.length > 0);
      assert.equal(x.inputSchema.type, 'object');
      assert.equal(x.inputSchema.additionalProperties, false);
      assert.doesNotThrow(() => compileSchema(x.inputSchema), `${n} compiles under strict Ajv`);
      const props = x.inputSchema.properties || {};
      for (const [k, v] of Object.entries(props)) assert.ok(!Array.isArray(v.type), `${n}.${k} has no type array`);
    }
    assert.deepEqual(getTool('knowledge').operations.find(o => o.name === 'entry').required.slice().sort(), ['file', 'packId']);
    assert.deepEqual(getTool('knowledge').operations.find(o => o.name === 'search').required, ['query']);
    assert.deepEqual(tools.filter(x => x.operations.some(o => o.scope === 'write:recs' || o.scopes?.includes('write:recs'))).map(x => x.name), ['act_on_recommendation', 'advisor_review', 'undo']);
  });
});

describe('demo store with the repo packs', () => {
  let t;
  let ctx;
  let expected;
  before(async () => {
    t = await tempDb();
    await seedDemo(t.db);
    ctx = { db: t.db, now: NOW, dataDir: t.dataDir };
    expected = await expectedView(t.db);
  });
  after(() => t && t.close());

  test('knowledge.packs lists every repo pack sorted by id with the status of its linked demo row', async () => {
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    assert.deepEqual(list.map(p => p.id), expected.map(e => e.pack.id));
    assert.deepEqual(Object.fromEntries(list.map(p => [p.id, p.status])), SEEDED_STATUS);
    assert.deepEqual(list.map(p => p.id), [...list.map(p => p.id)].sort());
    for (const p of list) {
      assert.deepEqual(Object.keys(p).sort(), PACK_FIELDS);
      const e = expected.find(x => x.pack.id === p.id);
      assert.equal(p.status, e.status, `${p.id} status`);
      assert.equal(p.why, e.why, `${p.id} why`);
      assert.equal(p.name, e.pack.name);
      assert.equal(p.version, e.pack.version);
      assert.equal(p.taxYear, e.pack.taxYear);
      assert.equal(p.reviewed, e.pack.reviewed);
      assert.deepEqual([...p.covers].sort(), [...e.pack.covers].sort());
      assert.deepEqual(p.entries.map(x => x.file).sort(), e.pack.entries.map(x => x.file).sort());
      for (const x of p.entries) assert.deepEqual(Object.keys(x).sort(), ['file', 'title']);
    }
    assert.ok(list.some(p => p.status === 'active'), 'the demo rows activate at least one pack');
    assert.ok(list.some(p => p.status !== 'active'), 'the demo rows leave at least one pack inactive');
  });

  test('a linked row supplies the why: scenario tokens resolved to plain text, no braces left', async () => {
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    const scope = await tokenScope(t.db);
    for (const [rowId, manifest] of Object.entries(LINKS)) {
      const row = await rowOf(t.db, rowId);
      const p = list.find(x => x.id === manifest);
      assert.equal(p.why, resolveTokens(scope, row.def.why, false), `${manifest} why`);
      assert.ok(!/\{(fk|f|l|p|n):/.test(p.why), `${manifest} why has no raw tokens: ${p.why}`);
      assert.ok(!p.why.includes('[?'), `${manifest} why has no unresolved token: ${p.why}`);
      assert.notEqual(p.why, ON);
      assert.notEqual(p.why, OFF);
    }
    assert.equal(list.find(x => x.id === 'charitable-giving').why.includes('embedded gain'), true);
  });

  test('name, version, tax year and review date still come from the manifest, id stays the manifest id', async () => {
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    for (const { pack } of expected) {
      const p = list.find(x => x.id === pack.id);
      assert.equal(p.name, pack.name);
      assert.equal(p.version, pack.version);
      assert.equal(p.taxYear, pack.taxYear);
      assert.equal(p.reviewed, pack.reviewed);
    }
    for (const rowId of Object.keys(LINKS)) assert.ok(!list.some(p => p.id === rowId), `${rowId} is a row id, not a pack id`);
  });

  test('with no overrides the linked rows read packStatus(def.status, live) and the active ones are searchable', async () => {
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    for (const [rowId, manifest] of Object.entries(LINKS)) {
      const row = await rowOf(t.db, rowId);
      assert.equal(row.active, null, `${rowId} has no override`);
      const want = packStatus(row.def.status, { active: null, exploring: false });
      assert.equal(list.find(p => p.id === manifest).status, want, `${manifest} status`);
      const found = await hits(ctx, manifest);
      if (want === 'active') {
        assert.ok(found.some(x => x.id === packOf(manifest).entries[0].id), `${manifest} first entry is searchable`);
      } else {
        assert.deepEqual(found, [], `${manifest} is not searchable at ${want}`);
      }
    }
  });

  test('knowledge.packs is deterministic', async () => {
    assert.deepEqual(await callTool('knowledge', { operation: 'packs', }, ctx), await callTool('knowledge', { operation: 'packs', }, ctx));
  });

  test('knowledge.entry returns any repo entry, active or not', async () => {
    for (const { pack } of expected) {
      const entry = pack.entries[0];
      const got = await callTool('knowledge', { operation: 'entry',  packId: pack.id, file: entry.file }, ctx);
      assert.equal(got.packId, pack.id);
      assert.equal(got.title, entry.title);
      assert.equal(got.markdown, entry.body);
      assert.ok(got.citations.length > 0);
    }
  });

  test('search only reaches active packs', async () => {
    const active = new Set(expected.filter(e => e.status === 'active').map(e => e.pack.id));
    const r = await callTool('knowledge', { operation: 'search',  query: 'tax', limit: 20 }, ctx);
    assert.ok(r.results.length > 0, 'the active demo packs mention tax');
    for (const x of r.results) assert.ok(active.has(x.packId), `${x.packId} is active`);
  });

  test('an empty real store still lists packs', async () => {
    const empty = await tempDb();
    try {
      const list = await callTool('knowledge', { operation: 'packs' }, { db: empty.db, now: NOW, dataDir: empty.dataDir });
      const want = activePacks(loadPacks([join(ROOT, 'packs')]), {});
      assert.deepEqual(list.map(p => [p.id, p.status]), want.map(e => [e.pack.id, e.status]));
    } finally {
      await empty.close();
    }
  });
});

describe('owner overrides on the demo rows reach the pack tools', () => {
  let t;
  let ctx;
  beforeEach(async () => {
    ({ t, ctx } = await freshDemo());
  });
  afterEach(() => t && t.close());

  const run = async (sql, ...args) => await t.db.prepare(sql).run(...args);
  const entryOf = id => packOf(id).entries[0];

  test('turning the UI pack scorp off takes s-corp-owner out of knowledge.packs and search; entries stay readable', async () => {
    assert.equal((await listed(ctx, 's-corp-owner')).status, 'active', 'precondition');
    assert.ok((await hits(ctx, 's-corp-owner')).some(x => x.id === entryOf('s-corp-owner').id), 'precondition: searchable');

    await run("UPDATE packs_state SET active = 0 WHERE id = 'scorp'");
    const p = await listed(ctx, 's-corp-owner');
    assert.equal(p.status, 'available');
    assert.equal(p.why, OFF);
    assert.equal(p.id, 's-corp-owner');
    assert.equal(p.name, packOf('s-corp-owner').name);

    assert.deepEqual(await hits(ctx, 's-corp-owner'), [], 'no s-corp-owner result');
    assert.deepEqual(await hits(ctx, 's-corp-owner', { packId: 's-corp-owner' }), [], 'none when asked for the pack by id');
    const only = await callTool('knowledge', { operation: 'search',  query: titleQuery('s-corp-owner'), packId: 's-corp-owner' }, ctx);
    assert.deepEqual([only.results, only.total, only.truncated], [[], 0, false]);

    const got = await callTool('knowledge', { operation: 'entry',  packId: 's-corp-owner', file: entryOf('s-corp-owner').file }, ctx);
    assert.equal(got.markdown, entryOf('s-corp-owner').body, 'knowledge.entry works for a pack that is off');

    // The other demo packs are untouched.
    for (const id of ['kids-dependents', 'w2-benefits', 'virginia-resident']) assert.equal((await listed(ctx, id)).status, 'active', id);
  });

  test('turning scorp back on, or clearing the override, restores s-corp-owner', async () => {
    await run("UPDATE packs_state SET active = 0 WHERE id = 'scorp'");
    assert.equal((await listed(ctx, 's-corp-owner')).status, 'available');

    await run("UPDATE packs_state SET active = 1 WHERE id = 'scorp'");
    const on = await listed(ctx, 's-corp-owner');
    assert.equal(on.status, 'active');
    assert.equal(on.why, ON);
    assert.ok((await hits(ctx, 's-corp-owner')).some(x => x.id === entryOf('s-corp-owner').id), 'searchable when turned on');

    await run("UPDATE packs_state SET active = NULL WHERE id = 'scorp'");
    const cleared = await listed(ctx, 's-corp-owner');
    assert.equal(cleared.status, 'active', 'the seeded base status is active');
    assert.equal(cleared.why, resolveTokens(await tokenScope(t.db), (await rowOf(t.db, 'scorp')).def.why, false), 'back to the row why');
    assert.ok((await hits(ctx, 's-corp-owner')).length > 0, 'searchable again');
  });

  test('turning off each linked active pack removes exactly that manifest pack', async () => {
    for (const [rowId, manifest] of Object.entries(LINKS)) {
      if (SEEDED_STATUS[manifest] !== 'active') continue;
      await run('UPDATE packs_state SET active = 0 WHERE id = ?', rowId);
      const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
      for (const p of list) {
        if (p.id === manifest) {
          assert.equal(p.status, 'available', `${manifest} off`);
          assert.equal(p.why, OFF);
        } else {
          assert.equal(p.status, SEEDED_STATUS[p.id], `${p.id} while ${manifest} is off`);
        }
      }
      assert.deepEqual(await hits(ctx, manifest), [], `${manifest} not searchable while off`);
      await run('UPDATE packs_state SET active = NULL WHERE id = ?', rowId);
    }
  });

  test('an exploring row whose base is not active reads exploring and is not searchable', async () => {
    await run("UPDATE packs_state SET exploring = 1 WHERE id = 'giving'");
    const p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'exploring');
    assert.equal(p.why, resolveTokens(await tokenScope(t.db), (await rowOf(t.db, 'giving')).def.why, false), 'no override, so the row why');
    assert.deepEqual(await hits(ctx, 'charitable-giving'), []);
    assert.deepEqual(await hits(ctx, 'charitable-giving', { packId: 'charitable-giving' }), []);
    const got = await callTool('knowledge', { operation: 'entry',  packId: 'charitable-giving', file: entryOf('charitable-giving').file }, ctx);
    assert.equal(got.markdown, entryOf('charitable-giving').body);
  });

  test('exploring does not demote a pack that is active', async () => {
    await run("UPDATE packs_state SET exploring = 1 WHERE id = 'scorp'");
    assert.equal((await listed(ctx, 's-corp-owner')).status, 'active');
    assert.ok((await hits(ctx, 's-corp-owner')).length > 0);
  });

  test('an exploring pack that the owner turned off reads exploring and is not searchable', async () => {
    await run("UPDATE packs_state SET exploring = 1, active = 0 WHERE id = 'giving'");
    const p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'exploring', 'packStatus: off but exploring reads exploring');
    assert.equal(p.why, OFF);
    assert.deepEqual(await hits(ctx, 'charitable-giving'), []);
  });

  test('a base-available pack turned on reads active, says so, and becomes searchable', async () => {
    await run("UPDATE packs_state SET def = json_set(def, '$.status', 'available') WHERE id = 'giving'");
    const before = await listed(ctx, 'charitable-giving');
    assert.equal(before.status, 'available');
    assert.deepEqual(await hits(ctx, 'charitable-giving'), []);

    await run("UPDATE packs_state SET active = 1 WHERE id = 'giving'");
    const p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'active');
    assert.equal(p.why, ON);
    assert.ok((await hits(ctx, 'charitable-giving')).some(x => x.id === entryOf('charitable-giving').id));
  });

  test('a seeded suggested pack turned on reads active too', async () => {
    assert.equal((await listed(ctx, 'charitable-giving')).status, 'suggested');
    await run("UPDATE packs_state SET active = 1, exploring = 1 WHERE id = 'giving'");
    const p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'active');
    assert.equal(p.why, ON);
    assert.ok((await hits(ctx, 'charitable-giving')).length > 0);
  });

  test('a string def.status on the row beats the facts', async () => {
    assert.equal((await getFacts(t.db))['household.dependents'] > 0, true, 'the demo facts say a dependent');
    await run("UPDATE packs_state SET def = json_set(def, '$.status', 'available') WHERE id = 'kids'");
    const p = await listed(ctx, 'kids-dependents');
    assert.equal(p.status, 'available');
    assert.deepEqual(await hits(ctx, 'kids-dependents'), []);
  });

  test('a row def with no string status falls back to the facts-derived status', async () => {
    // The demo seed's income.agiEstimate makes the facts suggest charitable-giving, like its row;
    // without it the facts leave the pack available, so a fallback is visible.
    await run("DELETE FROM facts WHERE key = 'income.agiEstimate'");
    const facts = activePacks(loadPacks([REPO_PACKS]), await getFacts(t.db));
    const byFacts = facts.find(v => v.pack.id === 'charitable-giving');
    assert.equal(byFacts.status, 'available', 'precondition: the demo facts leave charitable-giving available');

    await run("UPDATE packs_state SET def = json_remove(def, '$.status') WHERE id = 'giving'");
    let p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'available');
    assert.equal(p.why, resolveTokens(await tokenScope(t.db), (await rowOf(t.db, 'giving')).def.why, false), 'a non-empty row why still wins');

    await run("UPDATE packs_state SET def = json_set(def, '$.status', 7) WHERE id = 'giving'");
    p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, 'available', 'a non-string status is ignored');

    await run("UPDATE packs_state SET active = 1 WHERE id = 'giving'");
    assert.equal((await listed(ctx, 'charitable-giving')).status, 'active');
  });

  test('an empty row why falls back to the activation why', async () => {
    await run("UPDATE packs_state SET def = json_set(def, '$.why', '') WHERE id = 'virginia'");
    const p = await listed(ctx, 'virginia-resident');
    assert.equal(p.status, 'active');
    assert.equal(p.why, (await viewOf(t.db, 'virginia-resident')).why);
    assert.match(p.why, /household\.state/);
  });

  test('a manifest pack with no linked row falls back to the facts-derived activation status', async () => {
    const byFacts = async id => activePacks(loadPacks([REPO_PACKS]), await getFacts(t.db)).find(v => v.pack.id === id);
    // As above: without the seed's income.agiEstimate the facts leave charitable-giving available.
    await run("DELETE FROM facts WHERE key = 'income.agiEstimate'");
    await run("DELETE FROM packs_state WHERE id = 'giving'");
    let p = await listed(ctx, 'charitable-giving');
    assert.equal(p.status, (await byFacts('charitable-giving')).status);
    assert.equal(p.status, 'available', 'not the seeded row suggested');
    assert.equal(p.why, (await byFacts('charitable-giving')).why);
    assert.deepEqual(await hits(ctx, 'charitable-giving'), []);

    await run("DELETE FROM packs_state WHERE id = 'scorp'");
    p = await listed(ctx, 's-corp-owner');
    assert.equal(p.status, 'active');
    assert.equal(p.why, (await byFacts('s-corp-owner')).why);
    assert.match(p.why, /income\.sCorp/);
    assert.ok((await hits(ctx, 's-corp-owner')).length > 0, 'facts-derived active is searchable');

    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    assert.equal(list.length, 9, 'every manifest pack is still listed');
  });

  test('rows without a manifest preserve live status beside unchanged manifest packs', async () => {
    const before = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    await run("UPDATE packs_state SET active = 1 WHERE id IN ('contractor', 'abroad', 'rental')");
    assert.deepEqual((await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries), before);
    await run("DELETE FROM packs_state WHERE id IN ('contractor', 'abroad', 'rental')");
    assert.deepEqual((await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries), before);
  });

  test('the whole list follows the rule after a mix of overrides', async () => {
    await run("UPDATE packs_state SET active = 0 WHERE id IN ('scorp', 'w2')");
    await run("UPDATE packs_state SET active = 1 WHERE id = 'giving'");
    await run("UPDATE packs_state SET exploring = 1 WHERE id = 'virginia'");
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    const want = await expectedView(t.db);
    assert.deepEqual(list.map(p => [p.id, p.status, p.why]), want.map(v => [v.pack.id, v.status, v.why]));
    assert.deepEqual(Object.fromEntries(list.map(p => [p.id, p.status])), {
      'advanced-retirement': 'active',
      'charitable-giving': 'active',
      'kids-dependents': 'active',
      's-corp-owner': 'available',
      'self-employed-partnership': 'active',
      'account-tax-treatment': 'active',
      'spending-and-obligations': 'active',
      'virginia-resident': 'active',
      'w2-benefits': 'available',
    });
    const all = await callTool('knowledge', { operation: 'search',  query: 'tax', limit: 20 }, ctx);
    const activeIds = new Set(list.filter(p => p.status === 'active').map(p => p.id));
    for (const x of all.results) assert.ok(activeIds.has(x.packId), `${x.packId} is active`);
  });
});

describe('a real-store shaped row (untagged, id equal to the manifest id)', () => {
  let t;
  let ctx;
  beforeEach(async () => {
    t = await tempDb();
    ctx = { db: t.db, now: NOW, dataDir: t.dataDir };
  });
  afterEach(() => t && t.close());

  test('turning off a facts-active pack takes effect', async () => {
    await setFact(t.db, 'income.sCorp', true);
    assert.equal((await listed(ctx, 's-corp-owner')).status, 'active', 'precondition: active from facts');
    assert.ok((await hits(ctx, 's-corp-owner')).length > 0, 'precondition: searchable');

    await setPackState(t.db, 's-corp-owner', 0);
    const p = await listed(ctx, 's-corp-owner');
    assert.equal(p.status, 'available');
    assert.equal(p.why, OFF);
    assert.deepEqual(await hits(ctx, 's-corp-owner'), []);
    const got = await callTool('knowledge', { operation: 'entry',  packId: 's-corp-owner', file: packOf('s-corp-owner').entries[0].file }, ctx);
    assert.equal(got.markdown, packOf('s-corp-owner').entries[0].body);
  });

  test('turning on a pack the facts do not activate takes effect', async () => {
    assert.equal((await listed(ctx, 'w2-benefits')).status, 'available', 'precondition: no w2 fact');
    await setPackState(t.db, 'w2-benefits', 1);
    const p = await listed(ctx, 'w2-benefits');
    assert.equal(p.status, 'active');
    assert.equal(p.why, ON);
    assert.ok((await hits(ctx, 'w2-benefits')).length > 0);
  });

  test('a null override leaves the facts-derived status and why', async () => {
    await setFact(t.db, 'income.sCorp', true);
    await setPackState(t.db, 's-corp-owner', null);
    const want = await viewOf(t.db, 's-corp-owner');
    const p = await listed(ctx, 's-corp-owner');
    assert.equal(p.status, 'active');
    assert.equal(p.why, want.why);
  });

  test('an exploring row whose facts do not activate it reads exploring and is not searchable', async () => {
    await t.db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                  VALUES ('w2-benefits', '{}', NULL, 1, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run();
    assert.equal((await listed(ctx, 'w2-benefits')).status, 'exploring');
    assert.deepEqual(await hits(ctx, 'w2-benefits'), []);
  });

  test('a tagged row links to its manifest, not to a manifest named like the row', async () => {
    await t.db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                  VALUES ('mine', '{"manifest":"w2-benefits","status":"available"}', 1, 0, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run();
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    assert.ok(!list.some(p => p.id === 'mine'));
    assert.equal(list.find(p => p.id === 'w2-benefits').status, 'active');
    assert.equal(list.find(p => p.id === 'w2-benefits').why, ON);
    assert.equal(list.find(p => p.id === 's-corp-owner').status, 'available');
  });
});

describe('synthetic pack dir via ctx.packDirs', () => {
  let t;
  let ctx;
  let root;
  before(async () => {
    root = await writeFixture();
    t = await tempDb();
    await setFact(t.db, 'income.selfEmployed', true);
    await setFact(t.db, 'household.expectingChild', false);
    ctx = { db: t.db, now: NOW, packDirs: [root] };
  });
  after(() => t && t.close());

  const ids = list => Object.fromEntries(list.map(p => [p.id, p.status]));

  test('knowledge.packs shape and statuses from facts', async () => {
    const list = (await callTool('knowledge', { operation: 'packs' }, ctx)).filter(p => p.entries);
    assert.deepEqual(list.map(p => p.id), ['alpha-test', 'beta-test', 'gamma-test']);
    assert.deepEqual(ids(list), { 'alpha-test': 'active', 'beta-test': 'suggested', 'gamma-test': 'available' });
    const alpha = list[0];
    assert.deepEqual(Object.keys(alpha).sort(), PACK_FIELDS);
    assert.equal(alpha.name, 'Alpha synthetic pack');
    assert.equal(alpha.version, '1.2.3');
    assert.equal(alpha.taxYear, 2026);
    assert.equal(alpha.reviewed, '2026-10-01');
    assert.deepEqual([...alpha.covers].sort(), ['synthetic coverage a', 'synthetic coverage b']);
    assert.equal(alpha.entries.length, 3 + GIZMOS);
    assert.ok(alpha.entries.some(e => e.file === 'guides/deep-dive.md' && e.title === 'Deep dive guide'));
    assert.match(alpha.why, /income\.selfEmployed/);
    assert.equal(typeof list[2].why, 'string');
  });

  test('facts change the statuses', async () => {
    await setFact(t.db, 'household.expectingChild', true);
    await setFact(t.db, 'test.flag', true);
    try {
      assert.deepEqual(ids(await callTool('knowledge', { operation: 'packs', }, ctx)), { 'alpha-test': 'active', 'beta-test': 'active', 'gamma-test': 'active' });
    } finally {
      await setFact(t.db, 'household.expectingChild', false);
      await t.db.prepare("DELETE FROM facts WHERE key = 'test.flag'").run();
    }
    assert.deepEqual(ids(await callTool('knowledge', { operation: 'packs', }, ctx)), { 'alpha-test': 'active', 'beta-test': 'suggested', 'gamma-test': 'available' });
  });

  test('packs_state override: active 1 turns a pack on, 0 turns it off, null leaves it', async () => {
    await setPackState(t.db, 'gamma-test', 1);
    await setPackState(t.db, 'alpha-test', 0);
    await setPackState(t.db, 'beta-test', null);
    try {
      assert.deepEqual(ids(await callTool('knowledge', { operation: 'packs', }, ctx)), { 'alpha-test': 'available', 'beta-test': 'suggested', 'gamma-test': 'active' });
      const r = await callTool('knowledge', { operation: 'search',  query: 'widget' }, ctx);
      assert.deepEqual(r.results.map(x => x.packId), ['gamma-test'], 'search follows the override');
    } finally {
      await t.db.prepare("DELETE FROM packs_state WHERE id IN ('alpha-test', 'beta-test', 'gamma-test')").run();
    }
    assert.deepEqual(ids(await callTool('knowledge', { operation: 'packs', }, ctx)), { 'alpha-test': 'active', 'beta-test': 'suggested', 'gamma-test': 'available' });
  });

  test('knowledge.entry by file and by id, with citations', async () => {
    const byFile = await callTool('knowledge', { operation: 'entry',  packId: 'alpha-test', file: 'guides/deep-dive.md' }, ctx);
    const byId = await callTool('knowledge', { operation: 'entry',  packId: 'alpha-test', file: 'deep-dive' }, ctx);
    assert.deepEqual(byFile, byId);
    assert.deepEqual(Object.keys(byFile).sort(), ENTRY_FIELDS);
    assert.equal(byFile.packId, 'alpha-test');
    assert.equal(byFile.packName, 'Alpha synthetic pack');
    assert.equal(byFile.file, 'guides/deep-dive.md');
    assert.equal(byFile.id, 'deep-dive');
    assert.equal(byFile.title, 'Deep dive guide');
    assert.equal(byFile.markdown, 'A deep dive on the synthetic topic. Nothing else.\n');
    assert.deepEqual([...byFile.citations].sort((a, b) => (a.label < b.label ? -1 : 1)), [CITE2, CITE].sort((a, b) => (a.label < b.label ? -1 : 1)));
    for (const c of byFile.citations) assert.deepEqual(Object.keys(c).sort(), ['label', 'url']);
    assert.equal(byFile.version, '1.2.3');
    assert.equal(byFile.taxYear, 2026);
    assert.equal(byFile.reviewed, '2026-10-01');
  });

  test('knowledge.entry works for a pack that is not active', async () => {
    const got = await callTool('knowledge', { operation: 'entry',  packId: 'gamma-test', file: 'gamma-widget.md' }, ctx);
    assert.equal(got.title, 'Gamma widget entry');
  });

  test('knowledge.entry: unknown pack or entry is not_found', async () => {
    await assert.rejects(callTool('knowledge', { operation: 'entry',  packId: 'no-such-pack', file: 'zebra-notes.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('knowledge', { operation: 'entry',  packId: 'alpha-test', file: 'no-such-entry.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('knowledge', { operation: 'entry',  packId: 'alpha-test', file: 'deep-dive.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('knowledge', { operation: 'entry',  packId: 'beta-test', file: 'zebra-notes.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('knowledge', { operation: 'entry',  packId: 'alpha-test', file: '../beta-test/beta-widget.md' }, ctx), isCode('not_found'));
  });

  test('knowledge.entry: bad input', async () => {
    for (const args of [{}, { packId: 'alpha-test' }, { file: 'zebra-notes.md' }, { packId: '', file: 'zebra-notes.md' },
      { packId: 'alpha-test', file: '' }, { packId: 'alpha-test', file: 'x'.repeat(201) }, { packId: 'alpha-test', file: 7 },
      { packId: 'alpha-test', file: 'zebra-notes.md', extra: true }]) {
      await assert.rejects(callTool('knowledge', { operation: 'entry', ...args }, ctx), isCode('bad_input'), JSON.stringify(args).slice(0, 80));
    }
  });

  test('search scores title hits over body hits and orders deterministically', async () => {
    const r = await callTool('knowledge', { operation: 'search',  query: 'widget' }, ctx);
    assert.ok(!Object.hasOwn(r, 'query'), 'the query argument is not echoed');
    assert.deepEqual(r.results.map(x => x.id), ['quarterly-widgets', 'zebra-notes']);
    assert.deepEqual(r.results.map(x => x.score), [6, 3]);
    assert.equal(r.total, 2);
    assert.equal(r.truncated, false);
    for (const x of r.results) {
      assert.deepEqual(Object.keys(x).sort(), RESULT_FIELDS);
      assert.equal(x.packId, 'alpha-test');
      assert.ok(x.snippet.length <= 200);
      assert.match(x.snippet.toLowerCase(), /widget/);
      assert.ok(!/\s{2,}|\n/.test(x.snippet), 'whitespace collapsed');
    }
    assert.equal(r.results[0].file, 'quarterly-widgets.md');
    assert.equal(r.results[0].title, 'Quarterly widget planning');
    assert.deepEqual(await callTool('knowledge', { operation: 'search',  query: 'widget' }, ctx), r, 'same query, same answer');
  });

  test('search needs every term and is case-insensitive', async () => {
    const r = await callTool('knowledge', { operation: 'search',  query: 'Widget ZEBRA' }, ctx);
    assert.deepEqual(r.results.map(x => x.id), ['zebra-notes']);
    const none = await callTool('knowledge', { operation: 'search',  query: 'widget unicorn' }, ctx);
    assert.deepEqual(none.results, []);
    assert.equal(none.total, 0);
    assert.equal(none.truncated, false);
  });

  test('search is active-only and honors packId', async () => {
    const all = await callTool('knowledge', { operation: 'search',  query: 'widget' }, ctx);
    assert.ok(!all.results.some(x => x.packId !== 'alpha-test'), 'suggested and available packs are not searched');
    const gamma = await callTool('knowledge', { operation: 'search',  query: 'widget', packId: 'gamma-test' }, ctx);
    assert.deepEqual(gamma.results, []);
    const alpha = await callTool('knowledge', { operation: 'search',  query: 'widget', packId: 'alpha-test' }, ctx);
    assert.deepEqual(alpha.results.map(x => x.id), ['quarterly-widgets', 'zebra-notes']);
  });

  test('search caps results at the limit and reports truncation', async () => {
    const def = await callTool('knowledge', { operation: 'search',  query: 'gizmo' }, ctx);
    assert.equal(def.results.length, 10);
    assert.equal(def.total, GIZMOS);
    assert.equal(def.truncated, true);
    assert.deepEqual(def.results.map(x => x.id), Array.from({ length: 10 }, (_, i) => `item-${pad(i + 1)}`), 'ties break by entry id');
    const max = await callTool('knowledge', { operation: 'search',  query: 'gizmo', limit: 20 }, ctx);
    assert.equal(max.results.length, 20);
    assert.equal(max.truncated, true);
    const one = await callTool('knowledge', { operation: 'search',  query: 'gizmo', limit: 1 }, ctx);
    assert.deepEqual(one.results.map(x => x.id), ['item-01']);
    for (const x of max.results) assert.ok(x.snippet.length <= 200);
  });

  test('search: bad input', async () => {
    for (const args of [{}, { query: 'a' }, { query: '!!' }, { query: '? x' }, { query: 'q'.repeat(201) }, { query: 7 },
      { query: 'widget', limit: 0 }, { query: 'widget', limit: 21 }, { query: 'widget', limit: 2.5 }, { query: 'widget', packId: 3 },
      { query: 'widget', extra: 1 }]) {
      await assert.rejects(callTool('knowledge', { operation: 'search', ...args }, ctx), isCode('bad_input'), JSON.stringify(args).slice(0, 80));
    }
  });

  test('knowledge.packs takes no arguments', async () => {
    await assert.rejects(callTool('knowledge', { operation: 'packs',  extra: 1 }, ctx), isCode('bad_input'));
  });
});

test('merged pack listing preserves every scenario pack id and live status', async () => {
  const { t, ctx } = await freshDemo();
  try {
    const result = await callTool('knowledge', { operation: 'packs' }, ctx);
    for (const row of await t.db.prepare('SELECT id, def, active, exploring FROM packs_state').all()) {
      const def = parseJson(row.def, {});
      const expected = packStatus(def.status, { active: row.active == null ? null : !!row.active, exploring: !!row.exploring });
      assert.equal(result.find(p => p.id === row.id)?.status, expected, row.id);
    }
    for (const row of result.filter(p => !p.entries)) assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'status', 'why']);
  } finally { t.close(); }
});
