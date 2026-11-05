// AC2: the knowledge pack tools (list_packs, get_pack_entry, search_pack_entries) on the demo store
// with the repo packs, and on a synthetic temp pack dir passed as ctx.packDirs.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedDemo } from '../demo/seed.mjs';
import { tools, getTool, callTool, ToolError } from '../src/tools/index.mjs';
import { loadPacks, activePacks } from '../src/packs/index.mjs';
import { compileSchema } from '../src/engine/schema.mjs';
import { parseJson } from '../src/store/db.mjs';
import { ROOT, tempDb, tempDir } from './helpers/server.mjs';

const NAMES = ['list_packs', 'get_pack_entry', 'search_pack_entries'];
const PACK_FIELDS = ['covers', 'entries', 'id', 'name', 'reviewed', 'status', 'taxYear', 'version', 'why'];
const ENTRY_FIELDS = ['citations', 'file', 'id', 'markdown', 'packId', 'packName', 'reviewed', 'taxYear', 'title', 'version'];
const RESULT_FIELDS = ['file', 'id', 'packId', 'score', 'snippet', 'title'];
const NOW = new Date('2026-11-05T15:00:00Z');
const isCode = code => err => err instanceof ToolError && err.code === code;

const factsOf = db => Object.fromEntries(db.prepare('SELECT key, value FROM facts').all().map(f => [f.key, parseJson(f.value, f.value)]));

function setFact(db, key, value) {
  db.prepare(`INSERT OR REPLACE INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run(key, JSON.stringify(value));
}

function setPackState(db, id, active) {
  db.prepare(`INSERT OR REPLACE INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
              VALUES (?, '{}', ?, 0, 0, 0, '[]', 0, '2026-11-01T09:00:00Z')`).run(id, active);
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
      assert.equal(x.scope, 'read');
      assert.ok(typeof x.description === 'string' && x.description.length > 0);
      assert.equal(x.inputSchema.type, 'object');
      assert.equal(x.inputSchema.additionalProperties, false);
      assert.doesNotThrow(() => compileSchema(x.inputSchema), `${n} compiles under strict Ajv`);
      const props = x.inputSchema.properties || {};
      for (const [k, v] of Object.entries(props)) assert.ok(!Array.isArray(v.type), `${n}.${k} has no type array`);
    }
    assert.deepEqual(getTool('get_pack_entry').inputSchema.required.slice().sort(), ['file', 'packId']);
    assert.deepEqual(getTool('search_pack_entries').inputSchema.required, ['query']);
    assert.deepEqual(tools.filter(x => x.scope === 'write:recs').map(x => x.name), ['set_recommendation_status']);
  });
});

describe('demo store with the repo packs', () => {
  let t;
  let ctx;
  let expected;
  before(async () => {
    t = await tempDb();
    seedDemo(t.db);
    ctx = { db: t.db, now: NOW };
    expected = activePacks(loadPacks([join(ROOT, 'packs')]), factsOf(t.db));
  });
  after(() => t && t.close());

  test('list_packs lists every repo pack sorted by id with statuses derived from facts', async () => {
    const list = await callTool('list_packs', {}, ctx);
    assert.deepEqual(list.map(p => p.id), expected.map(e => e.pack.id));
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
    assert.ok(list.some(p => p.status === 'active'), 'the demo facts activate at least one pack');
    assert.ok(list.some(p => p.status !== 'active'), 'the demo facts leave at least one pack inactive');
  });

  test('list_packs is deterministic', async () => {
    assert.deepEqual(await callTool('list_packs', {}, ctx), await callTool('list_packs', {}, ctx));
  });

  test('get_pack_entry returns any repo entry, active or not', async () => {
    for (const { pack } of expected) {
      const entry = pack.entries[0];
      const got = await callTool('get_pack_entry', { packId: pack.id, file: entry.file }, ctx);
      assert.equal(got.packId, pack.id);
      assert.equal(got.title, entry.title);
      assert.equal(got.markdown, entry.body);
      assert.ok(got.citations.length > 0);
    }
  });

  test('search only reaches active packs', async () => {
    const active = new Set(expected.filter(e => e.status === 'active').map(e => e.pack.id));
    const r = await callTool('search_pack_entries', { query: 'tax', limit: 20 }, ctx);
    assert.ok(r.results.length > 0, 'the active demo packs mention tax');
    for (const x of r.results) assert.ok(active.has(x.packId), `${x.packId} is active`);
  });

  test('an empty real store still lists packs', async () => {
    const empty = await tempDb();
    try {
      const list = await callTool('list_packs', {}, { db: empty.db, now: NOW });
      const want = activePacks(loadPacks([join(ROOT, 'packs')]), {});
      assert.deepEqual(list.map(p => [p.id, p.status]), want.map(e => [e.pack.id, e.status]));
    } finally {
      empty.close();
    }
  });
});

describe('synthetic pack dir via ctx.packDirs', () => {
  let t;
  let ctx;
  let root;
  before(async () => {
    root = await writeFixture();
    t = await tempDb();
    setFact(t.db, 'income.selfEmployed', true);
    setFact(t.db, 'household.expectingChild', false);
    ctx = { db: t.db, now: NOW, packDirs: [root] };
  });
  after(() => t && t.close());

  const ids = list => Object.fromEntries(list.map(p => [p.id, p.status]));

  test('list_packs shape and statuses from facts', async () => {
    const list = await callTool('list_packs', {}, ctx);
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
    setFact(t.db, 'household.expectingChild', true);
    setFact(t.db, 'test.flag', true);
    try {
      assert.deepEqual(ids(await callTool('list_packs', {}, ctx)), { 'alpha-test': 'active', 'beta-test': 'active', 'gamma-test': 'active' });
    } finally {
      setFact(t.db, 'household.expectingChild', false);
      t.db.prepare("DELETE FROM facts WHERE key = 'test.flag'").run();
    }
    assert.deepEqual(ids(await callTool('list_packs', {}, ctx)), { 'alpha-test': 'active', 'beta-test': 'suggested', 'gamma-test': 'available' });
  });

  test('packs_state override: active 1 turns a pack on, 0 turns it off, null leaves it', async () => {
    setPackState(t.db, 'gamma-test', 1);
    setPackState(t.db, 'alpha-test', 0);
    setPackState(t.db, 'beta-test', null);
    try {
      assert.deepEqual(ids(await callTool('list_packs', {}, ctx)), { 'alpha-test': 'available', 'beta-test': 'suggested', 'gamma-test': 'active' });
      const r = await callTool('search_pack_entries', { query: 'widget' }, ctx);
      assert.deepEqual(r.results.map(x => x.packId), ['gamma-test'], 'search follows the override');
    } finally {
      t.db.prepare("DELETE FROM packs_state WHERE id IN ('alpha-test', 'beta-test', 'gamma-test')").run();
    }
    assert.deepEqual(ids(await callTool('list_packs', {}, ctx)), { 'alpha-test': 'active', 'beta-test': 'suggested', 'gamma-test': 'available' });
  });

  test('get_pack_entry by file and by id, with citations', async () => {
    const byFile = await callTool('get_pack_entry', { packId: 'alpha-test', file: 'guides/deep-dive.md' }, ctx);
    const byId = await callTool('get_pack_entry', { packId: 'alpha-test', file: 'deep-dive' }, ctx);
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

  test('get_pack_entry works for a pack that is not active', async () => {
    const got = await callTool('get_pack_entry', { packId: 'gamma-test', file: 'gamma-widget.md' }, ctx);
    assert.equal(got.title, 'Gamma widget entry');
  });

  test('get_pack_entry: unknown pack or entry is not_found', async () => {
    await assert.rejects(callTool('get_pack_entry', { packId: 'no-such-pack', file: 'zebra-notes.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('get_pack_entry', { packId: 'alpha-test', file: 'no-such-entry.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('get_pack_entry', { packId: 'alpha-test', file: 'deep-dive.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('get_pack_entry', { packId: 'beta-test', file: 'zebra-notes.md' }, ctx), isCode('not_found'));
    await assert.rejects(callTool('get_pack_entry', { packId: 'alpha-test', file: '../beta-test/beta-widget.md' }, ctx), isCode('not_found'));
  });

  test('get_pack_entry: bad input', async () => {
    for (const args of [{}, { packId: 'alpha-test' }, { file: 'zebra-notes.md' }, { packId: '', file: 'zebra-notes.md' },
      { packId: 'alpha-test', file: '' }, { packId: 'alpha-test', file: 'x'.repeat(201) }, { packId: 'alpha-test', file: 7 },
      { packId: 'alpha-test', file: 'zebra-notes.md', extra: true }]) {
      await assert.rejects(callTool('get_pack_entry', args, ctx), isCode('bad_input'), JSON.stringify(args).slice(0, 80));
    }
  });

  test('search scores title hits over body hits and orders deterministically', async () => {
    const r = await callTool('search_pack_entries', { query: 'widget' }, ctx);
    assert.equal(r.query, 'widget');
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
    assert.deepEqual(await callTool('search_pack_entries', { query: 'widget' }, ctx), r, 'same query, same answer');
  });

  test('search needs every term and is case-insensitive', async () => {
    const r = await callTool('search_pack_entries', { query: 'Widget ZEBRA' }, ctx);
    assert.deepEqual(r.results.map(x => x.id), ['zebra-notes']);
    const none = await callTool('search_pack_entries', { query: 'widget unicorn' }, ctx);
    assert.deepEqual(none.results, []);
    assert.equal(none.total, 0);
    assert.equal(none.truncated, false);
  });

  test('search is active-only and honors packId', async () => {
    const all = await callTool('search_pack_entries', { query: 'widget' }, ctx);
    assert.ok(!all.results.some(x => x.packId !== 'alpha-test'), 'suggested and available packs are not searched');
    const gamma = await callTool('search_pack_entries', { query: 'widget', packId: 'gamma-test' }, ctx);
    assert.deepEqual(gamma.results, []);
    const alpha = await callTool('search_pack_entries', { query: 'widget', packId: 'alpha-test' }, ctx);
    assert.deepEqual(alpha.results.map(x => x.id), ['quarterly-widgets', 'zebra-notes']);
  });

  test('search caps results at the limit and reports truncation', async () => {
    const def = await callTool('search_pack_entries', { query: 'gizmo' }, ctx);
    assert.equal(def.results.length, 10);
    assert.equal(def.total, GIZMOS);
    assert.equal(def.truncated, true);
    assert.deepEqual(def.results.map(x => x.id), Array.from({ length: 10 }, (_, i) => `item-${pad(i + 1)}`), 'ties break by entry id');
    const max = await callTool('search_pack_entries', { query: 'gizmo', limit: 20 }, ctx);
    assert.equal(max.results.length, 20);
    assert.equal(max.truncated, true);
    const one = await callTool('search_pack_entries', { query: 'gizmo', limit: 1 }, ctx);
    assert.deepEqual(one.results.map(x => x.id), ['item-01']);
    for (const x of max.results) assert.ok(x.snippet.length <= 200);
  });

  test('search: bad input', async () => {
    for (const args of [{}, { query: 'a' }, { query: '!!' }, { query: '? x' }, { query: 'q'.repeat(201) }, { query: 7 },
      { query: 'widget', limit: 0 }, { query: 'widget', limit: 21 }, { query: 'widget', limit: 2.5 }, { query: 'widget', packId: 3 },
      { query: 'widget', extra: 1 }]) {
      await assert.rejects(callTool('search_pack_entries', args, ctx), isCode('bad_input'), JSON.stringify(args).slice(0, 80));
    }
  });

  test('list_packs takes no arguments', async () => {
    await assert.rejects(callTool('list_packs', { extra: 1 }, ctx), isCode('bad_input'));
  });
});
