import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, evaluate, activePacks, packContext, getEntry } from '../index.mjs';

const cite = { label: 'IRS estimated tax guidance', url: 'https://www.irs.gov/publications/p505' };
const rule = (fact, op = 'eq', value = true) => ({ fact, op, value });
const manifest = (overrides = {}) => ({
  id: 'sample-pack', name: 'Sample pack', version: '1.0.0', taxYear: 2026,
  reviewed: '2026-01-01', curator: 'Synthetic editorial fixture', covers: ['Planning'],
  appliesWhen: rule('income.sCorp'), suggestWhen: rule('income.selfEmployed'),
  whatIf: { prompt: 'What changes if the owner becomes self-employed?' },
  entries: [{ file: 'overview.md', title: 'Overview', cites: [cite] }], ...overrides,
});
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'pack-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writePack(root, folder, data = manifest()) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data));
  for (const entry of data.entries ?? []) {
    if (typeof entry.file !== 'string' || entry.file.includes('..') || entry.file.startsWith('/')) continue;
    const file = join(dir, entry.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Synthetic planning guidance\n\nThe owner reviews the planning assumptions.\n');
  }
  return dir;
}

test('discovers immediate packs, direct packs and a synthetic mounted private pack', (t) => {
  const root = scratch(t);
  writePack(root, 'b', manifest({ id: 'b-pack' }));
  writePack(root, 'a', manifest({ id: 'a-pack' }));
  mkdirSync(join(root, 'unrelated'));
  writePack(join(root, 'unrelated'), 'nested', manifest({ id: 'not-immediate' }));
  const privateDir = fileURLToPath(new URL('./fixtures/your-plans/', import.meta.url));
  const packs = loadPacks([root, privateDir]);
  assert.deepEqual(packs.map((p) => p.id), ['a-pack', 'b-pack', 'your-plans']);
  assert.equal(loadPacks([join(root, 'a')])[0].id, 'a-pack');
  assert.deepEqual(loadPacks([join(root, 'unrelated', 'nested', 'empty')].filter(() => false)), []);
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.deepEqual(loadPacks([empty]), []);
  assert.ok(packs.every((p) => typeof p.directory === 'string'));
  const entry = getEntry(packs, 'your-plans', 'planning-review');
  assert.equal(entry.id, 'planning-review');
  assert.equal(entry.title, 'Synthetic planning review');
  assert.match(entry.body, /The owner/);
  assert.ok(entry.cites.length > 0);
  assert.equal(getEntry(packs, 'missing-pack', 'overview'), undefined);
  assert.equal(getEntry(packs, 'a-pack', 'missing-entry'), undefined);
  assert.equal(getEntry(packs, 'a-pack', 'overview.md'), undefined);
});

test('loader rejects malformed manifests while a valid neighbor remains loadable', async (t) => {
  const cases = [
    ['missing id', (m) => { delete m.id; }], ['unsafe id', (m) => { m.id = '../escape'; }],
    ['empty name', (m) => { m.name = ''; }], ['numeric name', (m) => { m.name = 1; }],
    ['empty version', (m) => { m.version = ''; }], ['missing curator', (m) => { delete m.curator; }],
    ['string year', (m) => { m.taxYear = '2026'; }], ['fractional year', (m) => { m.taxYear = 2026.5; }],
    ['invalid calendar date', (m) => { m.reviewed = '2026-02-30'; }],
    ['non ISO date', (m) => { m.reviewed = '01/01/2026'; }],
    ['empty covers', (m) => { m.covers = []; }], ['invalid cover', (m) => { m.covers = [3]; }],
    ['missing whatIf prompt', (m) => { m.whatIf = {}; }],
    ['empty whatIf prompt', (m) => { m.whatIf.prompt = ''; }],
    ['empty entries', (m) => { m.entries = []; }], ['missing title', (m) => { delete m.entries[0].title; }],
    ['empty citations', (m) => { m.entries[0].cites = []; }],
    ['empty citation label', (m) => { m.entries[0].cites[0].label = ''; }],
    ['relative citation', (m) => { m.entries[0].cites[0].url = '/source'; }],
    ['non http citation', (m) => { m.entries[0].cites[0].url = 'file:///source'; }],
    ['wrong entry extension', (m) => { m.entries[0].file = 'overview.txt'; }],
    ['path traversal', (m) => { m.entries[0].file = '../outside.md'; }],
    ['absolute path', (m) => { m.entries[0].file = '/outside.md'; }],
    ['duplicate entry stems', (m) => { m.entries.push({ ...m.entries[0], file: 'nested/overview.md' }); }],
    ['unsupported rule', (m) => { m.appliesWhen.op = 'execute'; }],
    ['missing activation rule', (m) => { delete m.appliesWhen; }],
  ];
  for (const [label, change] of cases) await t.test(label, (st) => {
    const root = scratch(st);
    const good = writePack(root, 'good', manifest({ id: 'valid-neighbor' }));
    const broken = manifest();
    change(broken);
    const bad = writePack(root, 'bad', broken);
    assert.equal(loadPacks([good])[0].id, 'valid-neighbor');
    assert.throws(() => loadPacks([root]), (error) => error.message.includes(bad));
  });
});

test('loader rejects bad JSON, missing content, empty content, duplicate IDs and symlink escapes', async (t) => {
  for (const kind of ['json', 'missing', 'empty', 'duplicate', 'symlink']) await t.test(kind, (st) => {
    const root = scratch(st);
    const good = writePack(root, 'good', manifest({ id: 'valid-neighbor' }));
    const bad = writePack(root, 'bad', manifest({ id: kind === 'duplicate' ? 'valid-neighbor' : 'bad-pack' }));
    if (kind === 'json') writeFileSync(join(bad, 'manifest.json'), '{');
    if (kind === 'missing' || kind === 'symlink') rmSync(join(bad, 'overview.md'));
    if (kind === 'empty') writeFileSync(join(bad, 'overview.md'), ' \n');
    if (kind === 'symlink') {
      writeFileSync(join(root, 'outside.md'), 'Outside the pack boundary');
      symlinkSync(join(root, 'outside.md'), join(bad, 'overview.md'));
    }
    assert.equal(loadPacks([good]).length, 1);
    assert.throws(() => loadPacks([root]), (error) => error.message.includes(bad));
  });
  const missing = join(scratch(t), 'missing-root');
  assert.throws(() => loadPacks([missing]), (error) => error.message.includes(missing));
  assert.throws(() => loadPacks('not-an-array'));
});

test('rules use strict JSON equality, numeric comparisons, membership and own-key presence', () => {
  const facts = { n: 8, text: '8', off: false, nil: null, list: [1, { x: 2 }], obj: { b: 2, a: 1 } };
  for (const [op, expected] of [['gt', true], ['gte', true], ['lt', false], ['lte', false]]) {
    assert.equal(evaluate(rule('n', op, 7), facts), expected);
    assert.equal(evaluate(rule('text', op, 7), facts), false);
    assert.equal(evaluate(rule('n', op, 7), { n: NaN }), false);
    assert.equal(evaluate(rule('n', op, 7), { n: Infinity }), false);
  }
  assert.equal(evaluate(rule('n', 'gte', 8), facts), true);
  assert.equal(evaluate(rule('n', 'lte', 8), facts), true);
  assert.equal(evaluate(rule('n', 'eq', '8'), facts), false);
  assert.equal(evaluate(rule('n', 'ne', '8'), facts), true);
  assert.equal(evaluate(rule('obj', 'eq', { a: 1, b: 2 }), facts), true);
  assert.equal(evaluate(rule('list', 'eq', [{ x: 2 }, 1]), facts), false);
  assert.equal(evaluate(rule('obj', 'in', [{ a: 1, b: 2 }]), facts), true);
  assert.equal(evaluate(rule('n', 'in', ['8']), facts), false);
  for (const fact of ['off', 'nil']) assert.equal(evaluate({ fact, op: 'exists' }, facts), true);
  assert.equal(evaluate(rule('nil', 'eq', null), facts), true);
  assert.equal(evaluate(rule('off', 'eq', false), facts), true);
  assert.equal(evaluate({ fact: 'inherited', op: 'exists' }, Object.create({ inherited: true })), false);
  assert.equal(evaluate(rule('inherited'), Object.create({ inherited: true })), false);
});

test('missing comparisons remain unknown through negation and three-valued composition', () => {
  const unknown = rule('absent');
  const yes = rule('present');
  const no = rule('present', 'eq', false);
  const facts = { present: true };
  for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']) {
    const comparison = rule('absent', op, op === 'in' ? [1] : 1);
    assert.equal(evaluate(comparison, facts), false);
    assert.equal(evaluate({ not: comparison }, facts), false);
  }
  for (const [condition, expected] of [
    [{ all: [] }, true], [{ any: [] }, false], [{ not: unknown }, false],
    [{ not: { not: unknown } }, false], [{ all: [yes, unknown] }, false],
    [{ any: [no, unknown] }, false], [{ any: [unknown, yes] }, true],
    [{ not: { all: [unknown, no] } }, true], [{ not: { any: [unknown, yes] } }, false],
    [{ all: [yes, { not: no }] }, true], [{ not: { fact: 'absent', op: 'exists' } }, true],
  ]) assert.equal(evaluate(condition, facts), expected, JSON.stringify(condition));
});

test('invalid tagged unions and operands fail even in short-circuited branches', () => {
  const invalid = [null, {}, [], { all: {} }, { any: [null] }, { not: null },
    { all: [], any: [] }, { not: rule('x'), fact: 'x' }, { all: [], extra: true },
    { fact: '', op: 'eq', value: true }, { fact: 'x', op: 'execute', value: true },
    { fact: 'x', op: 'eq' }, { fact: 'x', op: 'exists', value: true },
    rule('x', 'in', 1), rule('x', 'gt', '1'), rule('x', 'gt', Infinity),
    { ...rule('x'), extra: true }, rule('x', 'eq', undefined)];
  for (const condition of invalid) {
    assert.throws(() => evaluate(condition, { x: true }));
    assert.throws(() => evaluate({ any: [rule('x'), condition] }, { x: true }));
    assert.throws(() => evaluate({ all: [rule('x', 'eq', false), condition] }, { x: true }));
  }
});

test('activation gives active precedence, known suggestions and factual reasons for matching branches', (t) => {
  const root = scratch(t);
  writePack(root, 'active', manifest({ id: 'active-pack', appliesWhen: { any: [rule('income.sCorp'), rule('never.matches')] } }));
  writePack(root, 'suggested', manifest({ id: 'suggested-pack', appliesWhen: rule('unknown.activation'),
    suggestWhen: { all: [rule('giving.charitable', 'eq', false), rule('income.agiEstimate', 'gt', 200000)] } }));
  writePack(root, 'available', manifest({ id: 'available-pack', appliesWhen: rule('absent'), suggestWhen: rule('also.absent') }));
  writePack(root, 'negated', manifest({ id: 'negated-pack', appliesWhen: { not: rule('giving.charitable') } }));
  const facts = { 'income.sCorp': true, 'income.selfEmployed': true, 'giving.charitable': false, 'income.agiEstimate': 225000 };
  const activation = activePacks(loadPacks([root]), facts);
  const byId = Object.fromEntries(activation.map((a) => [a.pack.id, a]));
  assert.equal(byId['active-pack'].status, 'active');
  assert.match(byId['active-pack'].why, /income\.sCorp/);
  assert.match(byId['active-pack'].why, /true/);
  assert.doesNotMatch(byId['active-pack'].why, /never\.matches/);
  assert.equal(byId['suggested-pack'].status, 'suggested');
  assert.match(byId['suggested-pack'].why, /giving\.charitable/);
  assert.match(byId['suggested-pack'].why, /false/);
  assert.match(byId['suggested-pack'].why, /income\.agiEstimate/);
  assert.match(byId['suggested-pack'].why, /225000/);
  assert.doesNotMatch(byId['suggested-pack'].why, /unknown\.activation/);
  assert.equal(byId['available-pack'].status, 'available');
  assert.match(byId['available-pack'].why, /no matching|neither.*match/i);
  assert.equal(byId['negated-pack'].status, 'active');
  assert.match(byId['negated-pack'].why, /giving\.charitable/);
  assert.match(byId['negated-pack'].why, /false/);
});

test('context is stable versioned active knowledge, preserves metadata and changes with body or version', (t) => {
  const root = scratch(t);
  const entries = [{ file: 'zeta.md', title: 'Zeta', cites: [cite] }, { file: 'alpha.md', title: 'Alpha', cites: [cite] }];
  writePack(root, 'z', manifest({ id: 'z-pack', entries }));
  writePack(root, 'a', manifest({ id: 'a-pack' }));
  const privateDir = fileURLToPath(new URL('./fixtures/your-plans/', import.meta.url));
  const packs = loadPacks([root, privateDir]);
  const facts = { 'income.sCorp': true, 'income.selfEmployed': true, 'private.marker': 'FACTS MUST STAY OUT' };
  const activation = activePacks(packs, facts);
  const context = packContext(activation);
  const parsed = JSON.parse(context);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.packs.map((p) => p.id), ['a-pack', 'your-plans', 'z-pack']);
  const z = parsed.packs.find((p) => p.id === 'z-pack');
  for (const key of ['id', 'name', 'version', 'taxYear', 'reviewed', 'curator', 'covers', 'appliesWhen', 'suggestWhen', 'whatIf']) {
    assert.deepEqual(z[key], packs.find((p) => p.id === 'z-pack')[key]);
  }
  assert.deepEqual(z.entries.map((e) => e.id), ['alpha', 'zeta']);
  assert.equal(z.entries[0].body, getEntry(packs, 'z-pack', 'alpha').body);
  assert.deepEqual(z.entries[0].cites, [cite]);
  const reverseObjects = (value) => Array.isArray(value) ? value.map(reverseObjects) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjects(item)])) : value;
  const shuffled = reverseObjects(activation).reverse();
  for (const item of shuffled) item.pack.entries.reverse();
  assert.equal(packContext(shuffled), context);
  assert.doesNotMatch(context, /FACTS MUST STAY OUT|"directory"|"status"|"why"/);
  assert.ok(!context.includes(root));
  const withStatuses = activation.map((item, i) => ({ ...item, status: i === 0 ? 'active' : i === 1 ? 'suggested' : 'available' }));
  assert.deepEqual(JSON.parse(packContext(withStatuses)).packs.map((p) => p.id), [withStatuses[0].pack.id]);
  assert.deepEqual(JSON.parse(packContext([])).packs, []);
  packs[0].entries[0].body += '\nChanged guidance.';
  assert.notEqual(packContext(activation), context);
  packs[0].entries[0].body = getEntry(loadPacks([root]), packs[0].id, packs[0].entries[0].id).body;
  packs[0].version = '2.0.0';
  assert.notEqual(packContext(activation), context);
});
