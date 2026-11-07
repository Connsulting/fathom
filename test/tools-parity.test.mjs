import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/api/router.mjs';
import { tools } from '../src/tools/index.mjs';
import { parityErrors, PARITY_EXCLUDED, PARITY_PENDING } from '../src/tools/parity.mjs';

const route = 'POST /api/synthetic';
const router = [{ method: 'POST', path: '/api/synthetic' }];
const registry = (declared = []) => [{ name: 'synthetic', operations: [{ name: 'change', routes: declared }] }];
const pending = { [route]: { ticket: 'C9', operations: ['synthetic.change'] } };
const check = (rs, ts, opts = {}) => parityErrors(rs, ts, { excluded: {}, pending: {}, strict: false, ...opts });

test('parity requires coverage for every method, including undeclared POST reads', () => {
  assert.match(check(router, [])[0], /uncovered/);
  assert.deepEqual(check(router, registry([route])), []);
  assert.deepEqual(check(router, [], { excluded: { [route]: 'health check' } }), []);
  assert.deepEqual(check(router, [], { pending }), []);
});
test('exclusions cannot overlap declared or pending routes', () => {
  const excluded = { [route]: 'health check' };
  assert.match(check(router, registry([route]), { excluded })[0], /excluded/);
  assert.match(check(router, [], { excluded, pending })[0], /excluded/);
});
test('declared, excluded and pending routes must exist in the router', () => {
  assert.match(check([], registry([route]))[0], /not in router/);
  assert.match(check([], [], { excluded: { [route]: 'health check' } })[0], /not in router/);
  assert.match(check([], [], { pending })[0], /not in router/);
});
test('each registered pending pair must itself declare the route', () => {
  assert.match(check(router, registry(), { pending })[0], /must declare/);
  const sibling = [...registry(), { name: 'other', operations: [{ name: 'change', routes: [route] }] }];
  assert.match(check(router, sibling, { pending })[0], /must declare/);
  assert.deepEqual(check(router, registry([route]), { pending }), []);
});
test('strict parity refuses absent pairs even when another operation covers the route', () => {
  assert.match(check(router, [], { pending, strict: true })[0], /not registered/);
  const sibling = [{ name: 'other', operations: [{ name: 'change', routes: [route] }] }];
  assert.match(check(router, sibling, { pending, strict: true })[0], /not registered/);
  assert.deepEqual(check(router, registry([route]), { pending, strict: true }), []);
});
test('real API router and registry meet parity with explicit exclusions and pending work', () => {
  assert.ok(Object.keys(PARITY_EXCLUDED).length > 0);
  assert.ok(Object.keys(PARITY_PENDING).length > 0);
  assert.deepEqual(parityErrors(routes, tools), []);
});
