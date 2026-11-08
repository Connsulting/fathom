import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tools, getTool, callTool, buildRegistry, instructions, mcpInstructions, parity } from '../src/tools/index.mjs';
import { toolsForScopes, SCOPES } from '../src/mcp/keys.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';

const expected = {
  show: ['chart', 'table', 'compare', 'timeline'],
  household: ['summary', 'facts', 'fact_shapes', 'figures', 'deadlines', 'health', 'imports'],
  accounts: ['list', 'holdings', 'detail', 'net_worth', 'sources'], sources: ['archive_account', 'remove_file', 'merge_accounts'], tax: ['estimate', 'room'], transactions: ['search'], business: ['pnl', 'rows'],
  spending: ['total', 'compare', 'definitions', 'cash_flow', 'recurring'],
  goals: ['list', 'pace'], recommendations: ['list', 'detail', 'advisor', 'wargame'],
  knowledge: ['packs', 'search', 'entry'], answer: ['fact'],
  act_on_recommendation: ['status', 'owner', 'step'], update_goal: ['create', 'edit'],
  update_preferences: ['remember', 'forget', 'save_definition', 'delete_definition', 'pack'], refresh: ['import_file', 'retry_import', 'build_your_plans', 'run_job'], undo: ['undo'],
  calculate: ['add', 'subtract', 'multiply', 'divide', 'sum', 'min', 'max', 'negate', 'annualize', 'monthly', 'percent_of', 'round_up', 'compound'],
};
const oldNames = [
  ['household','summary'], ['get','facts'], ['get','fact','answer','shapes'], ['get','figures'],
  ['list','deadlines'], ['list','accounts'], ['list','positions'], ['query','transactions'],
  ['pnl','by','month'], ['list','goals'], ['get','pace'], ['list','recommendations'],
  ['get','recommendation'], ['advisor','status'], ['list','packs'], ['packs','status'],
  ['search','pack','entries'], ['get','pack','entry'], ['record','household','fact'],
  ['set','recommendation','status'], ['set','recommendation','owner'], ['set','recommendation','step'],
  ['create','goal'], ['edit','goal'], ['remember','preference'],
  ...['fact','goal','preference','recommendation','step'].map(k => ['undo',k,'action']),
].map(parts => parts.join('_'));

test('only the declared operation tools register, with no old aliases', () => {
  assert.deepEqual(tools.map(t => t.name), Object.keys(expected).sort());
  for (const tool of tools) {
    assert.deepEqual(new Set(tool.operations.map(o => o.name)), new Set(expected[tool.name]));
    assert.deepEqual(tool.inputSchema.required, ['operation']);
    assert.deepEqual(tool.inputSchema.properties.operation.enum, tool.operations.map(o => o.name));
    assert.ok(tool.operations.length <= 8 || tool.name === 'calculate');
    assert.ok(tool.operations.every(o => o.route && Array.isArray(o.routes) && o.summary.length <= 140));
    assert.ok(tool.operations.every(o => (tool.kind === 'read') === (o.scope === 'read')));
    if (tool.kind === 'read' && tool.name !== 'calculate' && !tool.askOnly) assert.deepEqual(tool.operations[0].required, []);
  }
  for (const name of oldNames) assert.equal(getTool(name), null);
  assert.doesNotThrow(() => createRegistryServer(tools, { purpose: 'chat' }));
});

test('loader rejects duplicate operations, conflicting schemas and invalid scope kinds', () => {
  const header = [{ name: 'example', kind: 'read', purpose: 'Example.', progress: 'Reading', source: 'example' }];
  const op = { tool: 'example', name: 'list', scope: 'read', summary: 'List.', route: 'Examples', params: { id: { type: 'string' } }, required: [], routes: [], handler: () => [] };
  assert.equal(buildRegistry([{ operations: [op] }], header).tools.length, 1);
  assert.throws(() => buildRegistry([{ operations: [op, op] }], header), /duplicate/i);
  assert.throws(() => buildRegistry([{ operations: [op, { ...op, name: 'other', params: { id: { type: 'integer' } } }] }], header), /schema/i);
  assert.throws(() => buildRegistry([{ operations: [{ ...op, scope: 'write:recs' }] }], header), /scope/i);
});

test('operation-local validation names the operation through direct and Ask boundaries', async () => {
  const server = createRegistryServer(tools, { purpose: 'chat' });
  for (const args of [{ operation: 'missing' }, { operation: 'summary', keys: [] }, { operation: 'summary', constructor: {} }]) {
    await assert.rejects(callTool('household', args, {}), e => e.code === 'bad_input' && e.message.includes(`household.${args.operation}`));
    const result = await server.invoke('household', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`household\\.${args.operation}`));
  }
  await assert.rejects(callTool('recommendations', { operation: 'detail' }, {}), e => e.code === 'bad_input' && /recommendations.detail/.test(e.message));
  const missing = await server.invoke('recommendations', { operation: 'detail' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /recommendations.detail/);
  assert.equal((await server.invoke('household', { operation: 'fact_shapes' })).isError, undefined);
});

test('scope filtering narrows operation enums and hides all writes from read-only keys', () => {
  const read = toolsForScopes(['read']);
  assert.ok(read.every(t => t.kind === 'read'));
  const mixed = toolsForScopes(['read', 'write:recs']);
  const rec = mixed.find(t => t.name === 'act_on_recommendation');
  assert.deepEqual(rec.inputSchema.properties.operation.enum, ['owner', 'status']);
  assert.ok(mixed.some(t => t.name === 'undo'));
  assert.ok(createRegistryServer(tools, { purpose: 'chat' }).names.includes('undo'));
  assert.ok(!createRegistryServer(tools, { purpose: 'plan' }).names.includes('undo'));
});

test('catalog and instructions stay within the context budget', t => {
  const listed = toolsForScopes(SCOPES).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const chars = JSON.stringify(listed).length;
  const longest = Math.max(...listed.map(t => t.description.length));
  t.diagnostic(`catalog=${chars} max-description=${longest} mcp-instructions=${mcpInstructions.length}`);
  assert.ok(chars <= 30000);
  assert.ok(longest <= 900);
  assert.ok(mcpInstructions.length <= 8000);
});

test('tracked callers contain no retired tool names', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const pattern = new RegExp(`\\b(${oldNames.join('|')})\\b`, 'g');
  const found = [];
  for (const path of paths) {
    if (path === 'docs/ask-tools.md') continue;
    let body;
    try { body = readFileSync(path, 'utf8'); } catch { continue; }
    body = body.replace(new RegExp('<\\/?' + ['household', 'summary'].join('_') + '>', 'g'), '');
    if (pattern.test(body)) found.push(path);
    pattern.lastIndex = 0;
  }
  assert.deepEqual(found, []);
});

test('the assembled rule text holds section 4 rules 2 to 6', async () => {
  const { rules } = await import('../src/tools/catalog/calculate.mjs');
  assert.equal(rules.length, 5);
  for (const line of rules) assert.ok(instructions.includes(line), line);
  const [arithmetic, quoting, refs, assumptions, gaps] = rules;
  assert.match(arithmetic, /digits.*derived figures only from calculate.*no figure without a tool source/);
  assert.match(quoting, /quote.*\{f:key\}.*calculate with refs and named assumptions/);
  assert.match(quoting, /unsigned.*spent.*paid/);
  assert.match(refs, /Copy a figure's ref field.*do not compose refs by hand.*same arguments/);
  assert.match(assumptions, /name, value and source.*owner.*evidence.*preference.*fact.*default.*Never mark a value as the owner's/);
  assert.match(gaps, /Report data gaps.*Never fill a gap with an estimate.*fix/);
});

test('C4 declares spending and business API intent coverage for the parity gate', () => {
  assert.deepEqual(parity['GET /api/spending'], ['spending.total']);
  assert.deepEqual(parity['GET /api/spending/rows'], ['transactions.search']);
  assert.deepEqual(parity['GET /api/pnl'], ['business.pnl']);
  assert.deepEqual(parity['GET /api/pnl/rows'], ['business.rows']);
});

 test('Ask-only first operations may require arguments and the Ask budget stays bounded', t => {
  const header = [{ name: 'example', kind: 'read', purpose: 'Example.', askOnly: true }];
  const op = { tool: 'example', name: 'draw', scope: 'read', summary: 'Draw.', route: 'Draw', routes: [], params: { source: { type: 'string' } }, required: ['source'], handler: () => null };
  assert.equal(buildRegistry([{ operations: [op] }], header).tools.length, 1);
  assert.throws(() => buildRegistry([{ operations: [op] }], [{ ...header[0], askOnly: false }]), /requires arguments/);
  const offered = tools.filter(t => !t.mcpOnly).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const chars = JSON.stringify(offered).length;
  t.diagnostic(`ask-catalog=${chars} ask-instructions=${instructions.length}`);
  assert.ok(chars < 30000); assert.ok(instructions.length < 8000);
  assert.ok(instructions.includes('show')); assert.equal(getTool('show').askOnly, true);
});

test('show schema accepts only paths and references, with numeric values confined to source args', () => {
  const inspect = (schema, path = []) => {
    if (path.at(-1) === 'args') return;
    assert.ok(!['number', 'integer'].includes(schema.type), path.join('.'));
    if (schema.type === 'object') assert.equal(schema.additionalProperties, false, path.join('.'));
    for (const [key, child] of Object.entries(schema.properties ?? {})) inspect(child, [...path, key]);
    if (schema.items) inspect(schema.items, [...path, 'items']);
  };
  inspect(getTool('show').inputSchema);
});
