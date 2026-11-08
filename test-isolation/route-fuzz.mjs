import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes, findRoute, normalizePath } from '../src/api/router.mjs';
import { tools } from '../src/tools/index.mjs';
import { isMcpTool } from '../src/mcp/keys.mjs';
import { request, runCommand } from '../test/helpers/server.mjs';
import { toolText, uploadFiles } from '../test/helpers/tenancy-runtime.mjs';
import { readZip } from '../src/yearend/zip.mjs';
import { isolationFixture, headersOf, ok } from './fixture.mjs';
import { seedHousehold, financialCases, CONTROL, keyOf } from './cases.mjs';
import { browser, register, signIn } from '../test/helpers/tenancy.mjs';
import { createAuthenticator } from '../test/helpers/webauthn.mjs';
import { SCOPES } from '../src/mcp/keys.mjs';
import { startModelEmulator } from '../test/helpers/model-emulator.mjs';
import { setInstanceCap, setAllocation } from '../src/platform/model-budget.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { aggregatorCsv } from '../test/helpers/ingest.mjs';
import { openObject } from '../src/platform/household-vault.mjs';
import { mcp, refreshImportFixture, expectedTransactionFixture, accountCategoryFixtures } from '../test/helpers/tenancy-mcp.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const seeds = Number(process.env.FATHOM_FUZZ_SEEDS ?? 2);
const budget = Number(process.env.FATHOM_FUZZ_BUDGET_MS ?? 600000);
assert.ok(Number.isInteger(seeds) && seeds >= 1 && seeds <= 100, 'seed_count');
assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 3600000, 'budget');
const started = performance.now();
const probe = process.env.FATHOM_ISOLATION_PROBE;
let activeCase = null;
const checkTime = () => assert.ok(performance.now() - started < budget, 'elapsed_budget');
const hash = x => createHash('sha256').update(x).digest('hex');
const tables = async db => (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).map(r => r.name);
const logicalDigest = async db => hash(JSON.stringify(await mapSeries((await tables(db)), async t => [t, (await db.prepare(`SELECT * FROM "${t}"`).all()).map(r => JSON.stringify(r)).sort()])));
function manifest(dir) {
  if (!existsSync(dir)) return '';
  return hash(JSON.stringify(readdirSync(dir, { recursive: true }).sort().filter(p => !/fathom\.sqlite(?:-|$)/.test(p)).map(p => {
    const file = join(dir, p), st = statSync(file);
    return [p, st.isFile() ? hash(readFileSync(file)) : 'directory'];
  })));
}
const platformTables = ['api_keys', 'household_memberships', 'household_invitations', 'household_data_keys', 'household_outbound',
  'household_model_budgets', 'model_rounds', 'notification_policy', 'notification_subscriptions', 'household_backup_operations'];
const platformSnapshot = async hh => hash(JSON.stringify([
  await hh.platform.prepare('SELECT * FROM households WHERE id=?').get(hh.id),
  ...await mapSeries(platformTables, async table => [table, (await hh.platform.prepare(`SELECT * FROM ${table} WHERE household_id=?`).all(hh.id)).map(row => JSON.stringify(row)).sort()]),
]));
const snapshot = async hh => [await logicalDigest(hh.db), manifest(hh.ctx.root), await platformSnapshot(hh)];
const stable = async (hh, before, code) => assert.deepEqual(await snapshot(hh), before, code);
const FAMILY = {
  household: `account_holders accounts action_receipts advisor_checkin advisor_packets advisor_reviews balances category_merchant_rules category_source_rules column_mappings confirm_auto confirm_auto_declined confirm_guesses confirm_items confirm_undo content conversations deadline_alerts deadlines decisions documents email_sends entity_aliases events expected_transactions facts figures files goals held_facts import_batches import_model_spend import_proposals ingest_epoch job_lock job_runs jobs messages packs_state planner_recs pnl_lines positions preferences rec_events recs schema_migrations settings simplefin_accounts simplefin_connection simplefin_snapshots source_changes sources spend_ledger spending_definitions store_identity superseded_rows tax_payments transaction_category_corrections transaction_category_guesses transaction_category_imports transactions yearend_marks yearend_packets`.split(' '),
  platform: `api_keys audit_events auth_challenges auth_rate_limits auth_sessions auth_tokens household_backup_operations household_data_keys household_invitations household_memberships household_model_budgets household_outbound households instance_operators model_rounds notification_policy notification_subscriptions passkeys platform_operations platform_settings schema_migrations users`.split(' '),
};

function classify(inventory, specs) {
  assert.deepEqual(inventory.map(keyOf).sort(), [...CONTROL, ...Object.keys(specs)].sort(), 'unclassified_route');
  for (const route of inventory) {
    const path = route.path.replace(/:[A-Za-z]+/g, 'fixture');
    assert.equal(keyOf(findRoute(route.method, normalizePath(path).segments).r), keyOf(route), 'dispatch_inventory');
  }
}

async function wire(f, person, method, spec, headers = {}) {
  const opts = { method, path: spec.path, headers: { ...await headersOf(person), origin: f.baseUrl, ...headers } };
  for (const [name, value] of Object.entries(opts.headers)) if (value === undefined) delete opts.headers[name];
  if (spec.multipart && method === 'POST') {
    const fd = new FormData();
    fd.append('files', new Blob([`# ${person.identity.householdId}\n\nSynthetic upload.`], { type: 'text/markdown' }), 'synthetic.md');
    const r = await fetch(f.baseUrl + spec.path, { method, headers: opts.headers, body: fd });
    const text = await r.text(); return { status: r.status, headers: Object.fromEntries(r.headers), text, json: JSON.parse(text) };
  }
  if (method === 'POST') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(spec.body ?? {}); }
  if (spec.zip && method === 'GET') {
    const r = await fetch(f.baseUrl + spec.path, { headers: opts.headers });
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = r.status === 200 ? readZip(bytes).map(e => e.name + '\n' + e.data.toString('utf8')).join('\n') : bytes.toString('utf8');
    return { status: r.status, text, headers: Object.fromEntries(r.headers) };
  }
  return request(f.baseUrl, opts);
}

async function controlSuccess(f, own, other) {
  const c = own.admin.client;
  const done = new Set();
  const run = async (method, template, path = template, body = {}, client = c) => {
    const r = method === 'POST' ? await client.post(path, body) : await client.get(path);
    ok(r); done.add(`${method} ${template}`); return r.json;
  };
  for (const path of ['/api/auth/session', '/api/auth/passkeys', '/api/admin/users', '/api/identity']) {
    const data = await run('GET', path);
    assert.ok(!JSON.stringify(data).includes(other.admin.identity.id), 'control_foreign_user');
    const head = await wire(f, own.admin, 'HEAD', { path });
    assert.equal(head.status, 200, `control_HEAD ${path}`); assert.equal(head.text, '', 'control_HEAD_body');
  }
  await run('POST', '/api/auth/recover', undefined, { email: 'unknown@example.test' });
  await run('POST', '/api/auth/passkeys/link');
  const name = own.canary.toLowerCase() + '-control@example.test';
  let prior = f.mail();
  await run('POST', '/api/admin/users/invite', undefined, { email: name, role: 'member' });
  const token = f.mailedToken(prior, name), device = createAuthenticator(), client = browser(f.baseUrl);
  const registered = await register(f.baseUrl, client, device, { token });
  ok(registered.options); ok(registered.verify);
  done.add('POST /api/auth/register/options'); done.add('POST /api/auth/register/verify');
  const userId = registered.verify.json.identity.id;
  const signed = await signIn(f.baseUrl, device, device.credentials()[0].id);
  ok(signed.options); ok(signed.verify);
  done.add('POST /api/auth/signin/options'); done.add('POST /api/auth/signin/verify');
  await run('POST', '/api/auth/household', undefined, { householdId: own.id }, client);
  const target = other;
  prior = f.mail();
  ok(await target.admin.client.post('/api/admin/users/invite', { email: name, role: 'member' }));
  await run('POST', '/api/auth/invitations/accept', undefined, { token: f.mailedToken(prior, name) }, client);
  await run('POST', '/api/admin/users/:id/role', `/api/admin/users/${userId}/role`, { role: 'admin' });
  await run('POST', '/api/auth/signout', undefined, {}, signed.client);
  await run('POST', '/api/admin/users/:id/passkeys/:keyId/revoke', `/api/admin/users/${userId}/passkeys/${device.credentials()[0].id}/revoke`);
  await run('POST', '/api/admin/users/:id/remove', `/api/admin/users/${userId}/remove`);
  const self = await f.invite(own, own.canary.toLowerCase() + '-self@example.test');
  await run('POST', '/api/auth/passkeys/:id/revoke', `/api/auth/passkeys/${self.credentialId}/revoke`, {}, self.client);
  // Provisioning was exercised through the actual operator route by the fixture.
  done.add('POST /api/operator/households');
  assert.deepEqual([...done].sort(), [...CONTROL].sort(), 'control_success_inventory');
}

function concreteControl(route, hh) {
  return { path: route.path.replace(':keyId', hh.member.credentialId).replace(':id', hh.member.identity.id), body: {} };
}

function routePolicy(route) {
  return findRoute(route.method, normalizePath(route.path.replace(/:[A-Za-z]+/g, 'fixture')).segments).r;
}

async function adversarialRoutes(f, inventory, specs) {
  let count = 0;
  const methods = inventory.flatMap(r => r.method === 'GET' ? [r, { ...r, method: 'HEAD' }] : [r]);
  for (let seed = 1; seed <= seeds; seed++) {
    const rng = (() => { let state = 0x9e3779b9 ^ seed; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }; })();
    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      for (const route of methods) {
        const base = route.method === 'HEAD' ? { ...route, method: 'GET' } : route;
        const spec = structuredCloneRequest(specs.get(other.id)[keyOf(base)] ?? concreteControl(base, other));
        const policy = routePolicy(base);
        const scoped = !policy.public && !policy.operator && (!policy.auth && !policy.session || policy.admin || policy.backupControl);
        for (let kind = 0; kind < 5; kind++) {
          activeCase = { seed, route: keyOf(route), mutation: kind, assertion: 'route_isolation' };
          checkTime();
          const before = await snapshot(other), wireSpec = { ...spec };
          const outbound = [f.externalCount(), manifest(join(own.ctx.root, 'outbox')), manifest(join(f.dataDir, 'outbox'))];
          const headers = {};
          let method = route.method, expected;
          if (scoped) {
            if (kind === 0) { headers['x-fathom-household'] = other.id; expected = 409; }
            if (kind === 1) { headers['x-fathom-context-version'] = String(2 + rng() % 10000); expected = 409; }
            if (kind === 2) { headers['x-fathom-household'] = [own.id, other.id]; expected = 400; }
            if (kind === 3) {
              wireSpec.path += (wireSpec.path.includes('?') ? '&' : '?') + `household=${other.id}&household=${own.id}&contextVersion=1`;
              expected = 400;
            }
            if (kind === 4) { headers['x-fathom-household'] = undefined; headers['x-fathom-context-version'] = undefined; expected = 409; }
          } else {
            if (kind === 0 || kind === 4) { headers.host = `foreign-${rng() % 1000}.example.invalid`; expected = 403; }
            if (kind === 1) { method = 'DELETE'; expected = 405; }
            if (kind === 2) { wireSpec.path = '/api/%2f/' + rng(); expected = 404; }
            if (kind === 3) { wireSpec.path = '/api/%5c/' + rng(); expected = 404; }
          }
          // Foreign references appear in paths, arrays, JSON references and upload metadata;
          // authorization must reject the request before these can reach a handler.
          wireSpec.body = { ...wireSpec.body, householdId: other.id, context: [{ kind: 'file', id: other.upload }],
            nested: { refs: [{ household: other.id, id: other.canary + '-only', storedPath: '../files/foreign.bin' }] } };
          const r = await wire(f, own.admin, method, wireSpec, headers);
          assert.equal(r.status, expected, `seed=${seed} ${keyOf(route)} mutation=${kind} refusal`);
          assert.ok(!r.text.includes(other.canary), `seed=${seed} ${keyOf(route)} mutation=${kind} disclosure`);
          await stable(other, before, `seed=${seed} ${keyOf(route)} mutation=${kind} foreign_effect`);
          assert.deepEqual([f.externalCount(), manifest(join(own.ctx.root, 'outbox')), manifest(join(f.dataDir, 'outbox'))], outbound, 'unauthorized_outbound_effect');
          count++;
        }
      }
    }
  }
  assert.equal(count, seeds * methods.length * 2 * 5, 'deterministic_route_mutation_count');
  return count;
}

const structuredCloneRequest = spec => ({ path: spec.path, body: structuredClone(spec.body ?? {}), zip: spec.zip, multipart: spec.multipart });

async function deterministicPolicies(f, inventory, specs) {
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    for (const route of inventory) {
      activeCase = { seed: 0, route: keyOf(route), mutation: 'authorization-class', assertion: 'deterministic_policy' };
      const policy = routePolicy(route);
      const spec = specs.get(other.id)[keyOf(route)] ?? concreteControl(route, other);
      if (!CONTROL.has(keyOf(route)) || policy.admin || policy.backupControl) {
        const before = await snapshot(other);
        const r = await wire(f, f.operator, route.method, spec);
        assert.equal(r.status, 403, `nonmember_operator ${keyOf(route)}`);
        await stable(other, before, 'operator_foreign_effect');
      }
      if (!policy.public) {
        const r = await wire(f, own.admin, route.method, spec, { cookie: undefined });
        assert.equal(r.status, 401, `anonymous ${keyOf(route)}`);
      }
      if (policy.admin || policy.backupControl) {
        const before = await snapshot(other);
        const r = await wire(f, own.member, route.method, spec);
        assert.equal(r.status, 403, `member ${keyOf(route)}`);
        await stable(other, before, 'admin_foreign_effect');
      }
    }
    for (const [path, body, expected] of [
      [`/api/admin/users/${other.member.identity.id}/role`, { role: 'admin' }, 404],
      [`/api/admin/users/${other.member.identity.id}/remove`, {}, 404],
      [`/api/admin/users/${other.member.identity.id}/passkeys/${other.member.credentialId}/revoke`, {}, 404],
      [`/api/auth/passkeys/${other.member.credentialId}/revoke`, {}, 404],
      ['/api/auth/household', { householdId: other.id }, 403],
    ]) {
      const r = await own.admin.client.post(path, body);
      assert.equal(r.status, expected, 'foreign_control');
      assert.equal((await f.store.membership(other.member.identity.id, other.id)).role, 'member');
      assert.equal((await f.store.listPasskeys(other.member.identity.id)).length, 1);
    }
    const before = await snapshot(other);
    for (const path of ['/api/not-a-route', '/api/%252f/not-a-route', '/api/%2e%2e/files', '/api/%00']) {
      const r = await wire(f, own.admin, 'GET', { path });
      assert.equal(r.status, 404, 'unknown_or_malformed');
    }
    await stable(other, before, 'unknown_route_foreign_effect');
  }
  const memberRoutes = inventory.filter(route => !CONTROL.has(keyOf(route)) && !routePolicy(route).admin && !routePolicy(route).backupControl);
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    f.dual.identity = ok(await f.dual.client.post('/api/auth/household', { householdId: own.id })).identity;
    const old = await headersOf(f.dual);
    const before = await snapshot(other);
    for (const route of memberRoutes) {
      activeCase = { seed: 0, route: keyOf(route), mutation: 'dual-member-foreign-header', assertion: 'dual_context' };
      const r = await wire(f, f.dual, route.method, specs.get(other.id)[keyOf(route)], { 'x-fathom-household': other.id });
      assert.equal(r.status, 409, `dual_foreign_context ${keyOf(route)}`);
      assert.ok(!r.text.includes(other.canary), 'dual_foreign_disclosure');
      await stable(other, before, 'dual_foreign_effect');
    }
    f.dual.identity = ok(await f.dual.client.post('/api/auth/household', { householdId: other.id })).identity;
    const switched = await snapshot(other);
    for (const route of memberRoutes) {
      activeCase = { seed: 0, route: keyOf(route), mutation: 'dual-member-stale-tab', assertion: 'stale_context' };
      const r = await wire(f, f.dual, route.method, specs.get(other.id)[keyOf(route)], old);
      assert.equal(r.status, 409, `dual_stale_context ${keyOf(route)}`);
      assert.ok(!r.text.includes(other.canary), 'dual_stale_disclosure');
      await stable(other, switched, 'dual_stale_effect');
    }
  }
}

async function foreignReferences(f, inventory, specs) {
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    for (const route of inventory.filter(r => !CONTROL.has(keyOf(r)))) {
      activeCase = { seed: 0, route: keyOf(route), mutation: 'valid-context-foreign-reference', assertion: 'reference_isolation' };
      const local = specs.get(own.id)[keyOf(route)], foreign = specs.get(other.id)[keyOf(route)];
      const spec = structuredCloneRequest({ ...foreign, body: local.body });
      for (const key of ['recId', 'withId', 'answers', 'ids', 'context', 'key']) {
        if (Object.hasOwn(foreign.body, key)) spec.body[key] = structuredClone(foreign.body[key]);
      }
      spec.body = { ...spec.body, householdId: other.id, nested: { refs: [{ householdId: other.id, id: other.upload, storedPath: '../files/foreign.bin' }] } };
      const before = await snapshot(other);
      const r = await wire(f, own.admin, route.method, spec);
      if (route.path === '/api/household/backups') await f.app.backups.idle();
      assert.ok([200, 400, 404, 409, 422].includes(r.status), `foreign_reference ${keyOf(route)}`);
      if (route.method === 'GET') assert.ok(!r.text.includes(other.canary), `foreign_read ${keyOf(route)}`);
      await stable(other, before, `foreign_reference_effect ${keyOf(route)}`);
    }
    const before = await snapshot(other), ownSubscriptions = await own.platform.prepare('SELECT * FROM notification_subscriptions WHERE household_id=? ORDER BY user_id').all(own.id);
    const invalidSubscription = await own.admin.client.post('/api/email/subscriptions', { subscriptions: [{ userId: other.admin.identity.id, subscribed: true }] });
    assert.equal(invalidSubscription.status, 400, 'foreign_recipient_refused');
    assert.deepEqual(await own.platform.prepare('SELECT * FROM notification_subscriptions WHERE household_id=? ORDER BY user_id').all(own.id), ownSubscriptions, 'foreign_recipient_no_subscription');
    await stable(other, before, 'foreign_recipient_platform_effect');
  }
}

async function lifecyclePolicies(f, inventory, specs) {
  const financial = inventory.filter(r => !CONTROL.has(keyOf(r)));
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    ok(await own.admin.client.post('/api/engine/cap', { usd: 30 }));
    const thread = ok(await own.admin.client.post('/api/threads', {})).thread;
    for (const route of financial.filter(r => routePolicy(r).stream)) {
      const spec = { path: route.path, body: { text: own.canary + ' streaming question', ...(route.path === '/api/ask' ? { key: thread.key } : {}) } };
      const before = await snapshot(other);
      const r = await wire(f, own.admin, 'POST', spec, { accept: 'text/event-stream' });
      assert.equal(r.status, 200, 'sse_success');
      const events = r.text.split('\n\n').filter(s => s.startsWith('event:')).map(s => ({ name: /^event: (.+)$/m.exec(s)[1], data: JSON.parse(/^data: (.+)$/m.exec(s)[1]) }));
      assert.ok(events.some(e => e.name === 'final'), 'sse_complete');
      for (const e of events) assert.ok(!JSON.stringify(e).includes(other.canary), 'sse_foreign_event');
      await stable(other, before, 'sse_foreign_effect');
    }
    const revoked = await f.invite(own, own.canary.toLowerCase() + '-revoked@example.test');
    const expired = await f.invite(own, own.canary.toLowerCase() + '-expired@example.test');
    await f.store.revokeSession(await revoked.client.session());
    await f.platform.prepare('UPDATE auth_sessions SET expires_at=0 WHERE hash=?').run(hash(await expired.client.session()));
    const removed = own.member;
    const memberKey = ok(await removed.client.post('/api/keys', { name: 'Synthetic removed member', scopes: ['read'] }));
    ok(await own.admin.client.post(`/api/admin/users/${removed.identity.id}/remove`, {}));
    assert.equal((await mcp(f.baseUrl, memberKey.key, 'tools/list')).status, 401, 'removed_creator_key');
    for (const person of [revoked, expired, removed]) {
      const before = await snapshot(other);
      for (const route of financial) {
        const spec = specs.get(other.id)[keyOf(route)];
        assert.equal((await wire(f, person, route.method, spec)).status, 401, `revoked_session ${keyOf(route)}`);
      }
      await stable(other, before, 'revoked_foreign_effect');
    }
    const before = await snapshot(other);
    await f.platform.prepare("UPDATE households SET status='suspended' WHERE id=?").run(own.id);
    try {
      assert.equal((await mcp(f.baseUrl, own.key.key, 'tools/list')).status, 401, 'suspended_key');
      for (const route of financial) {
        const policy = routePolicy(route);
        const expected = policy.backupControl ? route.method === 'POST' ? 409 : 404 : 403;
        assert.equal((await wire(f, own.admin, route.method, specs.get(other.id)[keyOf(route)])).status, expected, `suspended ${keyOf(route)}`);
      }
    } finally { await f.platform.prepare("UPDATE households SET status='active' WHERE id=?").run(own.id); }
    await stable(other, before, 'suspension_foreign_effect');
    assert.equal((await mcp(f.baseUrl, own.key.key, 'tools/list')).status, 200, 'resumed_key_liveness');
  }
}

async function toolGate(f) {
  const registry = tools.filter(isMcpTool);
  let count = 0;
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    // Inspect the actual SDK registrations without executing them. Wire requests below use the
    // server's real key verifier, runtime resolver and persistence.
    const catalog = createToolServer({ scopes: SCOPES, ctx: own.ctx, authorize: () => false, runTool: () => assert.fail('inventory_dispatch') });
    assert.deepEqual([...catalog._requestHandlers.keys()].sort(), ['initialize', 'ping', 'tools/call', 'tools/list'], 'unclassified_rpc_method');
    assert.deepEqual([...catalog._notificationHandlers.keys()].sort(), ['notifications/cancelled', 'notifications/initialized', 'notifications/progress'], 'unclassified_notification_method');
    await catalog.close();
    own.key = ok(await own.admin.client.post('/api/keys', { name: own.canary + ' fuzz', scopes: SCOPES }));
    const thread = ok(await own.admin.client.post('/api/threads', { text: 'Set the expected date to 2027-03-19. Prefer a steady reserve. ' + expectedTransactionFixture(own).evidence })).thread;
    const samples = {
      accounts: { operation: 'list' }, act_on_recommendation: { operation: 'owner', id: 'colliding-rec', owner: 'both' },
      advisor_review: { operation: 'send', recId: 'colliding-rec' },
      answer: { operation: 'fact', key: 'household.expectedDate', value: '2027-03-19', evidence: 'Set the expected date to 2027-03-19', conversationKey: thread.key },
      business: { operation: 'pnl' }, calculate: { operation: 'sum', operands: [{ ref: { tool: 'accounts', args: { operation: 'net_worth' }, path: 'total' } }], label: 'Synthetic balance' },
      goals: { operation: 'list' }, household: { operation: 'summary' }, knowledge: { operation: 'packs' },
      recommendations: { operation: 'list' }, refresh: refreshImportFixture(own),
      retirement: { operation: 'growth', solve: 'balance', years: 0, balance: { ref: { tool: 'accounts', args: { operation: 'detail', id: 'colliding-account' }, path: 'balance' } } },
      sources: { operation: 'archive_account', id: 'colliding-account' }, spending: { operation: 'total' }, tax: { operation: 'estimate' }, transactions: { operation: 'search' },
      ...await accountCategoryFixtures(own), update_goal: { operation: 'create', title: own.canary + ' tool reserve' },
      update_preferences: { operation: 'remember', text: 'Prefer a steady reserve', evidence: 'Prefer a steady reserve', conversationKey: thread.key },
    };
    const invoke = (name, args, headers = {}) => mcp(f.baseUrl, own.key.key, 'tools/call', { name, arguments: args }, headers);
    const action = await invoke('act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'doing' });
    samples.undo = { operation: 'undo', id: JSON.parse(toolText(action)).receipt.id };
    own.toolSamples = samples;
    assert.deepEqual(Object.keys(samples).sort(), registry.map(t => t.name).sort(), 'unclassified_tool');
    const before = await snapshot(other);
    const listed = await mcp(f.baseUrl, own.key.key, 'tools/list');
    assert.deepEqual(listed.json.result.tools.map(t => t.name), registry.map(t => t.name), 'live_tool_inventory');
    for (const method of ['initialize', 'ping']) {
      const params = method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } : {};
      const r = await mcp(f.baseUrl, own.key.key, method, params);
      assert.equal(r.status, 200, `rpc_${method}`); assert.ok(r.json.result, `rpc_result_${method}`);
    }
    for (const tool of registry) {
      assert.equal((await mcp(f.baseUrl, null, 'tools/call', { name: tool.name, arguments: samples[tool.name] }, { cookie: (await headersOf(own.admin)).cookie })).status, 401, `session_only_tool ${tool.name}`);
      const r = await invoke(tool.name, samples[tool.name], { cookie: (await headersOf(other.admin)).cookie, 'x-fathom-household': other.id });
      assert.equal(r.status, 200, `tool_success ${tool.name}`);
      assert.notEqual(r.json.result?.isError, true, `tool_result ${tool.name}: ${toolText(r)}`);
      if (tool.name === 'retirement') assert.equal(JSON.parse(toolText(r)).figure.value, own.retirementBalance, 'complete_balance');
      assert.ok(!toolText(r).includes(other.canary), `tool_disclosure ${tool.name}`);
      await stable(other, before, `tool_foreign_effect ${tool.name}`);
      for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
        activeCase = { seed, route: `tools/call ${tool.name}`, mutation: kind, assertion: 'tool_isolation' };
        checkTime();
        const extra = [{ householdId: other.id }, { household: other.id }, { storedPath: '../' + other.canary },
          { nested: { refs: [{ id: other.canary + '-only', householdId: other.id }] } }, { [`unknown${seed}`]: other.id }][kind];
        const attacked = await invoke(tool.name, { ...samples[tool.name], ...extra }, { cookie: (await headersOf(other.admin)).cookie });
        assert.equal(attacked.json?.result?.isError, true, `seed=${seed} tool=${tool.name} mutation=${kind} refusal`);
        assert.ok(!toolText(attacked).includes(other.canary), 'tool_error_disclosure');
        await stable(other, before, `seed=${seed} tool=${tool.name} mutation=${kind} effect`);
        count++;
      }
    }
    assert.equal((await mcp(f.baseUrl, null, 'tools/list', {}, { cookie: (await headersOf(own.admin)).cookie })).status, 401, 'cookie_is_not_bearer');
    for (const method of ['GET', 'HEAD', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
      for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
        activeCase = { seed, route: `${method} /mcp`, mutation: kind, assertion: 'transport_isolation' };
        const headers = { authorization: `Bearer ${own.key.key}` };
        let expected = 405;
        if (kind === 1) { headers.host = 'foreign.example.invalid'; expected = 403; }
        if (kind === 2) { headers.origin = 'https://foreign.example.invalid'; expected = 403; }
        if (kind === 3) { delete headers.authorization; expected = 401; }
        assert.equal((await request(f.baseUrl, { method, path: kind === 4 ? '/mcp?household=' + other.id : '/mcp', headers })).status, expected, 'mcp_transport_method');
        await stable(other, before, 'transport_foreign_effect'); count++;
      }
    }
    for (const method of ['initialize', 'ping', 'tools/list', 'tools/call']) for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
      activeCase = { seed, route: `/mcp ${method}`, mutation: kind, assertion: 'rpc_isolation' };
      const headers = [{ host: 'foreign.example.invalid' }, { origin: 'https://foreign.example.invalid' },
        { authorization: undefined }, { authorization: 'Bearer synthetic-invalid' }, { 'content-type': 'text/plain' }][kind];
      const r = await mcp(f.baseUrl, own.key.key, method, {}, headers);
      assert.equal(r.status, [403, 403, 401, 401, 415][kind], `seed=${seed} rpc=${method} mutation=${kind} refusal`);
      await stable(other, before, 'rpc_foreign_effect'); count++;
    }
    for (const method of ['notifications/cancelled', 'notifications/initialized', 'notifications/progress']) {
      const params = method === 'notifications/cancelled' ? { requestId: 'synthetic-missing' }
        : method === 'notifications/progress' ? { progressToken: 'synthetic-missing', progress: 0, total: 1 } : {};
      const notify = headers => request(f.baseUrl, { method: 'POST', path: '/mcp', headers: {
        authorization: `Bearer ${own.key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers,
      }, body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
      assert.equal((await notify({})).status, 202, 'notification_success');
      for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
        activeCase = { seed, route: `/mcp ${method}`, mutation: kind, assertion: 'notification_isolation' };
        const headers = [{ host: 'foreign.example.invalid' }, { origin: 'https://foreign.example.invalid' },
          { authorization: undefined }, { authorization: 'Bearer synthetic-invalid' }, { 'content-type': 'text/plain' }][kind];
        assert.equal((await notify(headers)).status, [403, 403, 401, 401, 415][kind], 'notification_refusal');
        await stable(other, before, 'notification_foreign_effect'); count++;
      }
    }
    const readKey = ok(await own.admin.client.post('/api/keys', { name: 'Synthetic read', scopes: ['read'] }));
    for (const tool of registry.filter(t => t.kind === 'write')) {
      const denied = await mcp(f.baseUrl, readKey.key, 'tools/call', { name: tool.name, arguments: samples[tool.name] });
      assert.equal(denied.json?.result?.isError, true, `read_scope ${tool.name}`);
    }
    const privateEntry = await invoke('knowledge', { operation: 'entry', packId: 'your-plans', file: 'household-plan.md' });
    assert.ok(toolText(privateEntry).includes(own.canary) && !toolText(privateEntry).includes(other.canary), 'private_pack_content');
    const batch = await request(f.baseUrl, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${own.key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'household', arguments: { operation: 'summary' } } }]) });
    assert.equal(batch.status, 400, 'rpc_batch_refused');
    for (const path of ['/mcp/', '/%6dcp', '/mcp/nested', '/mcp%2f']) {
      const r = await request(f.baseUrl, { method: 'POST', path, headers: { ...await headersOf(own.admin), 'content-type': 'application/json' }, body: '{}' });
      assert.ok([404, 405].includes(r.status), 'exact_mcp_path');
    }
    ok(await own.admin.client.post(`/api/keys/${readKey.record.id}/revoke`, {}));
    assert.equal((await mcp(f.baseUrl, readKey.key, 'tools/list')).status, 401, 'revoked_key');
    for (const tool of registry) assert.equal((await mcp(f.baseUrl, readKey.key, 'tools/call', { name: tool.name, arguments: samples[tool.name] })).status, 401, `revoked_tool ${tool.name}`);
  }
  assert.equal(count, seeds * (registry.length + 4 + 3 + 6) * 2 * 5, 'deterministic_tool_mutation_count');
  return count;
}

async function collidingUploads(f) {
  const bytes = Buffer.from(aggregatorCsv([{ date: '2026-10-05', amount: '19.99', description: 'Synthetic colliding upload', account: 'Synthetic shared checking', number: '5550009999' }]));
  const responses = await Promise.all(await mapSeries([f.A, f.B], async hh => uploadFiles(f.baseUrl, { cookie: (await headersOf(hh.admin)).cookie, householdId: hh.id, contextVersion: hh.admin.identity.contextVersion }, [{ name: 'shared.csv', bytes }])));
  const ids = responses.map(r => { ok(r); assert.equal(r.json.files[0].status, 'imported', 'independent_upload'); return r.json.files[0].fileId; });
  assert.equal(ids[0], ids[1], 'colliding_file_hash');
  const vaults = await Promise.all([f.A.ctx.vault(), f.B.ctx.vault()]);
  const blobs = [f.A, f.B].map(hh => readFileSync(join(hh.ctx.root, 'files', ids[0] + '.bin')));
  assert.ok(!blobs[0].equals(blobs[1]), 'independent_ciphertexts');
  for (let own = 0; own < 2; own++) {
    assert.deepEqual(Buffer.from(openObject(vaults[own].handle, { purpose: 'upload', objectId: ids[own], blob: blobs[own] })), bytes, 'own_decryption');
    assert.throws(() => openObject(vaults[own].handle, { purpose: 'upload', objectId: ids[own], blob: blobs[1 - own] }), e => e.code === 'vault_auth_failed', 'foreign_ciphertext');
  }
}

async function replayForeignPayloads(f, inventory, specs) {
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
    for (const route of inventory.filter(r => !CONTROL.has(keyOf(r)))) {
      activeCase = { seed: 0, route: keyOf(route), mutation: 'foreign-payload-replay', assertion: 'replay_isolation' };
      const before = await snapshot(other);
      const r = await wire(f, own.admin, route.method, specs.get(other.id)[keyOf(route)]);
      if (route.path === '/api/household/backups') await f.app.backups.idle();
      assert.ok([200, 400, 404, 409, 422].includes(r.status), `foreign_payload ${keyOf(route)}`);
      await stable(other, before, `foreign_payload_effect ${keyOf(route)}`);
    }
    for (const tool of tools.filter(isMcpTool)) {
      activeCase = { seed: 0, route: `tools/call ${tool.name}`, mutation: 'foreign-payload-replay', assertion: 'replay_isolation' };
      const before = await snapshot(other);
      const r = await mcp(f.baseUrl, own.key.key, 'tools/call', { name: tool.name, arguments: other.toolSamples[tool.name] }, { cookie: (await headersOf(other.admin)).cookie });
      assert.equal(r.status, 200, `foreign_tool_payload ${tool.name}`);
      await stable(other, before, `foreign_tool_payload_effect ${tool.name}`);
    }
  }
}

test('adversarial isolation gate crosses real sessions, dispatch, runtimes, persistence and vaults', { timeout: budget + 10000 }, async () => {
  const watchdog = setTimeout(() => { process.stderr.write('isolation_elapsed_budget\n'); process.exit(1); }, Math.max(1, budget - (performance.now() - started)));
  watchdog.unref();
  const originalLog = console.log, originalError = console.error, logs = [];
  console.log = console.error = (...args) => logs.push(args.map(String).join(' '));
  let f;
  const external = [];
  const bridge = createServer((req, res) => {
    external.push(req.url);
    if (req.method === 'POST') res.end('https://synthetic:synthetic@bridge.example.test/access');
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ errors: [], accounts: [] })); }
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const fetchReal = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'bridge.example.test') return fetchReal(url, init);
    assert.equal(u.protocol, 'https:', 'simplefin_https');
    assert.equal(init.redirect, 'error', 'simplefin_redirect');
    return fetchReal(`http://127.0.0.1:${bridge.address().port}${u.pathname}${u.search}`, init);
  };
  let mutations = 0;
  const failures = [];
  try {
    f = await isolationFixture({ extra: { FATHOM_SIMPLEFIN_ALLOWED_HOSTS: 'bridge.example.test' } });
    f.externalCount = () => external.length;
    for (const hh of [f.A, f.B]) await seedHousehold(f, hh);
    const specs = new Map();
    for (const hh of [f.A, f.B]) specs.set(hh.id, await financialCases(f, hh));
    const inventory = routes.filter(r => r.path.startsWith('/api'));
    classify(probe === 'unclassified-route' ? [...inventory, { method: 'GET', path: '/api/deliberately-unclassified' }] : inventory, specs.get(f.A.id));
    assert.throws(() => classify([...inventory, { method: 'GET', path: '/api/deliberately-unclassified' }], specs.get(f.A.id)), /unclassified_route/, 'unknown_route_probe');
    assert.deepEqual(await tables(f.platform), FAMILY.platform, 'platform_schema_scope');
    assert.deepEqual(await tables(f.A.db), FAMILY.household, 'household_schema_scope');
    f.A.db.exec('CREATE TABLE deliberately_unclassified (id TEXT)');
    try { assert.throws(async () => assert.deepEqual(await tables(f.A.db), FAMILY.household), 'unclassified_schema_probe'); }
    finally { f.A.db.exec('DROP TABLE deliberately_unclassified'); }
    if (probe === 'foreign-runtime') {
      const foreign = { ...f.A.ctx, db: f.B.db, root: f.B.ctx.root, packs: f.B.ctx.packs, engine: f.B.ctx.engine, answerer: f.B.ctx.answerer };
      const get = f.app.runtimes.get;
      f.app.runtimes.forIdentity = identity => identity.householdId === f.A.id ? foreign : get(identity.householdId);
      f.app.runtimes.get = id => id === f.A.id ? foreign : get(id);
    }

    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      await controlSuccess(f, own, other);
      for (const route of inventory.filter(r => !CONTROL.has(keyOf(r)))) {
        activeCase = { seed: 0, route: keyOf(route), mutation: 'authorized', assertion: 'authorized_case' };
        try {
        checkTime();
        const spec = specs.get(own.id)[keyOf(route)];
        await spec.before?.(); Object.assign(spec, await spec.prepare?.());
        const before = await snapshot(other);
        const r = await wire(f, own.admin, route.method, spec);
        if (route.path === '/api/household/backups') await f.app.backups.idle();
        assert.equal(r.status, spec.status ?? 200, `authorized ${keyOf(route)} ${r.status} ${r.json?.error ?? ''}`);
        if (route.path === '/api/import-proposals/:proposalId/review') {
          const stale = await wire(f, own.admin, 'POST', { path: spec.path, body: { version: spec.body.version + 10, decision: 'approve', evidence: 'yes' } });
          assert.equal(stale.status, 409, 'authorized_stale_import_response');
          assert.equal(stale.json.code, 'proposal_stale');
          assert.deepEqual(stale.json.diff, ['proposal']);
        }
        assert.ok(!r.text.includes(other.canary), `response ${keyOf(route)}`);
        if (route.path === '/api/email/test' || route.path === '/api/email/brief') {
          assert.equal(r.json.send.status, 'sent', 'authorized_email_delivery');
          const dir = join(own.ctx.root, 'outbox');
          const messages = readdirSync(dir).filter(p => p.endsWith('.json')).map(p => JSON.parse(readFileSync(join(dir, p), 'utf8')));
          assert.ok(messages.length >= 1, 'local_financial_mail_sink');
          for (const message of messages) {
            assert.deepEqual(message.to, [own.admin.identity.email], 'financial_mail_recipient');
            assert.ok(!JSON.stringify(message).includes(other.canary), 'financial_mail_context');
          }
        }
        if (r.status === 200) {
          assert.equal(r.headers['x-fathom-household'], own.id, `response_context ${keyOf(route)}`);
          assert.equal(r.headers['x-fathom-context-version'], String(own.admin.identity.contextVersion), 'response_version');
          const scenario = r.json?.scenario ?? (route.path === '/api/scenario' ? r.json : null);
          if (scenario) {
            assert.ok(!JSON.stringify(scenario).includes(other.canary), `scenario_identity ${keyOf(route)}`);
            const expectedGoals = (await own.db.prepare('SELECT id FROM goals ORDER BY id').all()).map(g => g.id);
            assert.deepEqual(scenario.goals.map(g => g.id).sort(), expectedGoals, `complete_goals ${keyOf(route)}`);
          }
        }
        if (spec.own) assert.ok(r.text.includes(own.canary), `complete_result ${keyOf(route)}`);
        await stable(other, before, `authorized_foreign_effect ${keyOf(route)}`);
        if (route.method === 'GET') {
          const head = await wire(f, own.admin, 'HEAD', spec);
          assert.equal(head.status, spec.headStatus ?? spec.status ?? 200, `authorized_HEAD ${route.path}`);
          assert.equal(head.text, '', 'head_body');
        }
        await spec.after?.();
        } catch (err) { failures.push(`${keyOf(route)}: ${err.message.split('\n')[0]}`); }
      }
    }
    assert.deepEqual(failures, [], 'authorized_case_failures');
    await deterministicPolicies(f, inventory, specs);
    mutations += await adversarialRoutes(f, inventory, specs);
    mutations += await toolGate(f);
    await foreignReferences(f, inventory, specs);
    activeCase = { seed: 0, route: 'lifecycle', mutation: 'lifecycle', assertion: 'lifecycle_isolation' };
    await lifecyclePolicies(f, inventory, specs);
    activeCase = { seed: 0, route: 'POST /api/files', mutation: 'colliding-upload', assertion: 'vault_isolation' };
    await collidingUploads(f);
    await replayForeignPayloads(f, inventory, specs);
    const logText = logs.join('\n');
    for (const value of [f.A.canary, f.B.canary, f.A.key.key, f.B.key.key, f.keys.platformKeyHex, f.keys.secretHex,
      await f.A.admin.client.session(), await f.B.admin.client.session()]) assert.ok(!logText.includes(value), 'sanitized_logs');
  } catch (error) {
    if (activeCase) {
      if (process.env.FATHOM_FUZZ_REPRO_DIR) {
        mkdirSync(process.env.FATHOM_FUZZ_REPRO_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(join(process.env.FATHOM_FUZZ_REPRO_DIR, 'repro.json'), JSON.stringify(activeCase) + '\n', { mode: 0o600 });
      }
    }
    throw error;
  } finally {
    globalThis.fetch = fetchReal;
    await f?.close();
    await new Promise(resolve => bridge.close(resolve));
    clearTimeout(watchdog);
    console.log = originalLog; console.error = originalError;
  }
  console.log(JSON.stringify({ seedStart: 1, seedEnd: seeds, seeds, mutationsPerCase: 5, directions: 2, mutations, elapsedMs: Math.ceil(performance.now() - started) }));
});

if (!probe) test('the executable gate rejects unclassified routes and an injected foreign runtime', { timeout: 120000 }, async () => {
  for (const kind of ['unclassified-route', 'foreign-runtime']) {
    const r = await runCommand(process.execPath, ['test-isolation/route-fuzz.mjs'], { env: { FATHOM_ISOLATION_PROBE: kind }, timeoutMs: 60000 });
    assert.notEqual(r.code, 0, `negative_control_${kind}`);
    const output = r.stdout + r.stderr;
    assert.ok(output.includes(kind === 'unclassified-route' ? 'unclassified_route' : 'authorized_case_failures'), `negative_control_assertion_${kind}`);
    if (kind === 'foreign-runtime') assert.ok(output.includes('response GET /api/scenario'), 'negative_control_uses_real_gate');
  }
});

if (!probe) test('live-mode model and tool continuations see only the real-session household', { timeout: 120000 }, async () => {
  const emulator = await startModelEmulator();
  let f;
  try {
    f = await isolationFixture({ engine: 'live', engineOptions: { testTransport: { baseURL: emulator.baseURL } } });
    await setInstanceCap(f.platform, 100);
    for (const hh of [f.A, f.B]) {
      await setAllocation(f.platform, hh.id, 40);
      ok(await hh.admin.client.post('/api/household/outbound', { jobs: false, engine: true }));
      ok(await hh.admin.client.post('/api/preferences', { text: hh.canary + ' reserve policy' }));
      ok(await hh.admin.client.post('/api/engine', { on: true }));
      ok(await hh.admin.client.post('/api/engine/cap', { usd: 30 }));
    }
    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      const from = emulator.requests.length, before = await snapshot(other);
      emulator.script([{ toolUse: { name: body => body.tools.find(t => /(?:^|__)household$/.test(t.name)).name, input: { operation: 'summary' } } },
        { text: 'Synthetic household answer.' }]);
      const r = ok(await own.admin.client.post('/api/threads', { text: 'Explain the stored reserve policy.' }));
      assert.equal(r.message.notice, false, 'live_answer');
      const calls = emulator.requests.slice(from);
      assert.ok(calls.length >= 2, 'live_tool_continuation');
      assert.ok(calls.some(c => JSON.stringify(c.body).includes(own.canary)), 'own_model_context');
      for (const call of calls) assert.ok(!JSON.stringify(call.body).includes(other.canary), 'foreign_model_context');
      await stable(other, before, 'model_foreign_effect');
      const rows = await f.platform.prepare("SELECT state FROM model_rounds WHERE household_id=? AND kind='round'").all(own.id);
      assert.ok(rows.length >= 2 && rows.every(row => row.state === 'settled'), 'live_reservations_settled');
    }
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const from = emulator.requests.length;
    emulator.script([{ wait: held, toolUse: { name: body => body.tools.find(t => /(?:^|__)household$/.test(t.name)).name, input: { operation: 'summary' } } }]);
    const pending = fetch(f.baseUrl + '/api/threads', { method: 'POST', headers: {
      ...await headersOf(f.A.member), origin: f.baseUrl, 'content-type': 'application/json', accept: 'text/event-stream',
    }, body: JSON.stringify({ text: 'Synthetic revoked streaming request.' }) });
    await emulator.waitForRequests(from + 1);
    ok(await f.A.admin.client.post(`/api/admin/users/${f.A.member.identity.id}/remove`, {}));
    release();
    const cut = await (await pending).text();
    assert.ok(cut.includes('event: error') && !cut.includes('event: final'), 'revoked_sse_has_no_final');
    await f.app.runtimes.quiesce(f.A.id);
    assert.equal(emulator.requests.length, from + 1, 'no_new_paid_round_after_removal');
    checkTime();
  } finally { await emulator.close(); await f?.close(); }
});
