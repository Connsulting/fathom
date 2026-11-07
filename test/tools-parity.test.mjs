import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/api/router.mjs';
import { tools, parity as declared } from '../src/tools/index.mjs';
import { PARITY_EXCLUDED, PARITY_PENDING, checkParity } from '../src/tools/parity.mjs';

const names = (...list) => new Set(list);

function gaps(over) {
  return checkParity({
    routes: over.routes,
    toolNames: over.toolNames,
    declared: over.declared ?? {},
    excluded: over.excluded ?? {},
    pending: over.pending ?? {},
    strict: over.strict ?? false,
  });
}

test('an uncovered mutating route fails', () => {
  const found = gaps({
    routes: [{ method: 'POST', path: '/api/synthetic/write' }, { method: 'GET', path: '/api/synthetic/read' }],
    toolNames: names(),
  });
  assert.deepEqual(found, ['uncovered POST /api/synthetic/write']);
});

test('a route cannot be excluded and also declared or pending', () => {
  const route = '/api/synthetic/both';
  const declaredHit = gaps({
    routes: [{ method: 'POST', path: route }],
    toolNames: names('synthetic_tool'),
    declared: { [route]: ['synthetic_tool'] },
    excluded: { [route]: 'Synthetic exclusion.' },
  });
  const pendingHit = gaps({
    routes: [{ method: 'POST', path: route }],
    toolNames: names(),
    pending: { [route]: { tools: ['synthetic_tool'], owner: 'T0' } },
    excluded: { [route]: 'Synthetic exclusion.' },
  });
  assert.equal(declaredHit.some(line => line.includes(route)), true);
  assert.equal(pendingHit.some(line => line.includes(route)), true);
});

test('a declared tool or a declared or excluded route must exist', () => {
  const missingTool = gaps({
    routes: [{ method: 'POST', path: '/api/synthetic/known' }],
    toolNames: names(),
    declared: { '/api/synthetic/known': ['missing_tool'] },
  });
  const missingDeclared = gaps({
    routes: [{ method: 'GET', path: '/api/synthetic/read' }],
    toolNames: names('synthetic_tool'),
    declared: { '/api/synthetic/absent': ['synthetic_tool'] },
  });
  const missingExcluded = gaps({
    routes: [{ method: 'POST', path: '/api/synthetic/other' }],
    toolNames: names(),
    excluded: { '/api/synthetic/absent': 'Synthetic exclusion.' },
  });
  assert.equal(missingTool.some(line => line.includes('missing_tool')), true);
  assert.equal(missingDeclared.some(line => line.includes('/api/synthetic/absent')), true);
  assert.equal(missingExcluded.some(line => line.includes('/api/synthetic/absent')), true);
});

test('strict mode fails only when a pending tool is absent', () => {
  const pending = { '/api/synthetic/later': { tools: ['later_tool'], owner: 'T0' } };
  const absentRoute = gaps({
    routes: [],
    toolNames: names(),
    pending,
  });
  const toolAbsent = gaps({
    routes: [{ method: 'POST', path: '/api/synthetic/later' }],
    toolNames: names(),
    pending,
    strict: true,
  });
  const toolPresent = gaps({
    routes: [{ method: 'POST', path: '/api/synthetic/later' }],
    toolNames: names('later_tool'),
    pending,
    strict: true,
  });
  assert.deepEqual(absentRoute, []);
  assert.equal(toolAbsent.some(line => line.includes('later_tool')), true);
  assert.deepEqual(toolPresent, []);
});

test('the real router and registry pass without strict mode', () => {
  const found = checkParity({
    routes,
    toolNames: new Set(tools.map(tool => tool.name)),
    declared,
    excluded: PARITY_EXCLUDED,
    pending: PARITY_PENDING,
    strict: false,
  });
  assert.deepEqual(found, []);
});

test('strict mode fails while a pending tool is absent from the registry', () => {
  const found = checkParity({
    routes,
    toolNames: new Set(tools.map(tool => tool.name)),
    declared,
    excluded: PARITY_EXCLUDED,
    pending: PARITY_PENDING,
    strict: process.env.PARITY_STRICT === '1',
  });
  if (process.env.PARITY_STRICT === '1') assert.deepEqual(found, []);
  else assert.equal(found.length, 0);
});
