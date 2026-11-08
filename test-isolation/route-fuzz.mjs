import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { routes, findRoute, normalizePath } from '../src/api/router.mjs';
import { tools } from '../src/tools/index.mjs';
import { isMcpTool } from '../src/mcp/keys.mjs';
import { request, runCommand } from '../test/helpers/server.mjs';
import { toolText } from '../test/helpers/tenancy-runtime.mjs';
import { readZip } from '../src/yearend/zip.mjs';
import { isolationFixture, headersOf, ok } from './fixture.mjs';
import { seedHousehold, financialCases, CONTROL, keyOf } from './cases.mjs';
import { browser, register, signIn } from '../test/helpers/tenancy.mjs';
import { createAuthenticator } from '../test/helpers/webauthn.mjs';
import { SCOPES } from '../src/mcp/keys.mjs';
import { mcp, refreshImportFixture, expectedTransactionFixture, accountCategoryFixtures } from '../test/helpers/tenancy-mcp.mjs';

const seeds = Number(process.env.FATHOM_FUZZ_SEEDS ?? 2);
const budget = Number(process.env.FATHOM_FUZZ_BUDGET_MS ?? 600000);
assert.ok(Number.isInteger(seeds) && seeds >= 1 && seeds <= 100, 'seed_count');
assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 3600000, 'budget');
const started = performance.now();
const probe = process.env.FATHOM_ISOLATION_PROBE;
const checkTime = () => assert.ok(performance.now() - started < budget, 'elapsed_budget');
const hash = x => createHash('sha256').update(x).digest('hex');
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const logicalDigest = db => hash(JSON.stringify(tables(db).map(t => [t, db.prepare(`SELECT * FROM "${t}"`).all().map(r => JSON.stringify(r)).sort()])));
function manifest(dir) {
  if (!existsSync(dir)) return '';
  return hash(JSON.stringify(readdirSync(dir, { recursive: true }).sort().filter(p => !/fathom\.sqlite(?:-|$)/.test(p)).map(p => {
    const file = join(dir, p), st = statSync(file);
    return [p, st.isFile() ? hash(readFileSync(file)) : 'directory'];
  })));
}
const snapshot = hh => [logicalDigest(hh.db), manifest(hh.ctx.root)];
const stable = (hh, before, code) => assert.deepEqual(snapshot(hh), before, code);
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
  const opts = { method, path: spec.path, headers: { ...headersOf(person), origin: f.baseUrl, ...headers } };
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
          checkTime();
          const before = snapshot(other), wireSpec = { ...spec };
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
          stable(other, before, `seed=${seed} ${keyOf(route)} mutation=${kind} foreign_effect`);
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
      const policy = routePolicy(route);
      const spec = specs.get(other.id)[keyOf(route)] ?? concreteControl(route, other);
      if (!policy.public) {
        const r = await wire(f, own.admin, route.method, spec, { cookie: undefined });
        assert.equal(r.status, 401, `anonymous ${keyOf(route)}`);
      }
      if (policy.admin || policy.backupControl) {
        const before = snapshot(other);
        const r = await wire(f, own.member, route.method, spec);
        assert.equal(r.status, 403, `member ${keyOf(route)}`);
        stable(other, before, 'admin_foreign_effect');
      }
    }
    for (const [path, body, expected] of [
      [`/api/admin/users/${other.member.identity.id}/role`, { role: 'admin' }, 404],
      [`/api/admin/users/${other.member.identity.id}/remove`, {}, 404],
      [`/api/admin/users/${other.member.identity.id}/passkeys/${other.member.credentialId}/revoke`, {}, 404],
      [`/api/auth/passkeys/${other.member.credentialId}/revoke`, {}, 404],
      ['/api/auth/household', { householdId: other.id }, 403],
    ]) {
      const before = logicalDigest(f.platform);
      const r = await own.admin.client.post(path, body);
      assert.equal(r.status, expected, 'foreign_control');
      assert.equal(f.store.membership(other.member.identity.id, other.id).role, 'member');
      assert.equal(f.store.listPasskeys(other.member.identity.id).length, 1);
    }
    const before = snapshot(other);
    for (const path of ['/api/not-a-route', '/api/%252f/not-a-route', '/api/%2e%2e/files', '/api/%00']) {
      const r = await wire(f, own.admin, 'GET', { path });
      assert.equal(r.status, 404, 'unknown_or_malformed');
    }
    stable(other, before, 'unknown_route_foreign_effect');
  }
}

async function toolGate(f) {
  const registry = tools.filter(isMcpTool);
  let count = 0;
  for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
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
      ...accountCategoryFixtures(own), update_goal: { operation: 'create', title: own.canary + ' tool reserve' },
      update_preferences: { operation: 'remember', text: 'Prefer a steady reserve', evidence: 'Prefer a steady reserve', conversationKey: thread.key },
    };
    const invoke = (name, args, headers = {}) => mcp(f.baseUrl, own.key.key, 'tools/call', { name, arguments: args }, headers);
    const action = await invoke('act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'doing' });
    samples.undo = { operation: 'undo', id: JSON.parse(toolText(action)).receipt.id };
    assert.deepEqual(Object.keys(samples).sort(), registry.map(t => t.name).sort(), 'unclassified_tool');
    const before = snapshot(other);
    const listed = await mcp(f.baseUrl, own.key.key, 'tools/list');
    assert.deepEqual(listed.json.result.tools.map(t => t.name), registry.map(t => t.name), 'live_tool_inventory');
    for (const method of ['initialize', 'ping']) {
      const params = method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } : {};
      const r = await mcp(f.baseUrl, own.key.key, method, params);
      assert.equal(r.status, 200, `rpc_${method}`); assert.ok(r.json.result, `rpc_result_${method}`);
    }
    for (const tool of registry) {
      const r = await invoke(tool.name, samples[tool.name], { cookie: headersOf(other.admin).cookie, 'x-fathom-household': other.id });
      assert.equal(r.status, 200, `tool_success ${tool.name}`);
      assert.notEqual(r.json.result?.isError, true, `tool_result ${tool.name}: ${toolText(r)}`);
      assert.ok(!toolText(r).includes(other.canary), `tool_disclosure ${tool.name}`);
      stable(other, before, `tool_foreign_effect ${tool.name}`);
      for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
        checkTime();
        const extra = [{ householdId: other.id }, { household: other.id }, { storedPath: '../' + other.canary },
          { nested: { refs: [{ id: other.canary + '-only', householdId: other.id }] } }, { [`unknown${seed}`]: other.id }][kind];
        const attacked = await invoke(tool.name, { ...samples[tool.name], ...extra }, { cookie: headersOf(other.admin).cookie });
        assert.equal(attacked.json?.result?.isError, true, `seed=${seed} tool=${tool.name} mutation=${kind} refusal`);
        assert.ok(!toolText(attacked).includes(other.canary), 'tool_error_disclosure');
        stable(other, before, `seed=${seed} tool=${tool.name} mutation=${kind} effect`);
        count++;
      }
    }
    assert.equal((await mcp(f.baseUrl, null, 'tools/list', {}, { cookie: headersOf(own.admin).cookie })).status, 401, 'cookie_is_not_bearer');
    for (const method of ['GET', 'HEAD', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
      assert.equal((await request(f.baseUrl, { method, path: '/mcp', headers: { authorization: `Bearer ${own.key.key}` } })).status, 405, 'mcp_transport_method');
    }
    for (const method of ['initialize', 'ping', 'tools/list', 'tools/call']) for (let seed = 1; seed <= seeds; seed++) for (let kind = 0; kind < 5; kind++) {
      const headers = kind % 2 ? { host: 'foreign.example.invalid' } : { origin: 'https://foreign.example.invalid' };
      const r = await mcp(f.baseUrl, own.key.key, method, {}, headers);
      assert.equal(r.status, 403, `seed=${seed} rpc=${method} mutation=${kind} refusal`); count++;
    }
    const readKey = ok(await own.admin.client.post('/api/keys', { name: 'Synthetic read', scopes: ['read'] }));
    const denied = await mcp(f.baseUrl, readKey.key, 'tools/call', { name: 'update_goal', arguments: { operation: 'create', title: 'Synthetic denied' } });
    assert.equal(denied.json?.result?.isError, true, 'read_scope');
    ok(await own.admin.client.post(`/api/keys/${readKey.record.id}/revoke`, {}));
    assert.equal((await mcp(f.baseUrl, readKey.key, 'tools/list')).status, 401, 'revoked_key');
  }
  assert.equal(count, seeds * (registry.length + 4) * 2 * 5, 'deterministic_tool_mutation_count');
  return count;
}

test('adversarial isolation gate crosses real sessions, dispatch, runtimes, persistence and vaults', { timeout: budget + 10000 }, async () => {
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
    for (const hh of [f.A, f.B]) await seedHousehold(f, hh);
    const specs = new Map();
    for (const hh of [f.A, f.B]) specs.set(hh.id, await financialCases(f, hh));
    const inventory = routes.filter(r => r.path.startsWith('/api'));
    classify(probe === 'unclassified-route' ? [...inventory, { method: 'GET', path: '/api/deliberately-unclassified' }] : inventory, specs.get(f.A.id));
    assert.throws(() => classify([...inventory, { method: 'GET', path: '/api/deliberately-unclassified' }], specs.get(f.A.id)), /unclassified_route/, 'unknown_route_probe');
    assert.deepEqual(tables(f.platform), FAMILY.platform, 'platform_schema_scope');
    assert.deepEqual(tables(f.A.db), FAMILY.household, 'household_schema_scope');
    if (probe === 'foreign-runtime') {
      const foreign = { ...f.A.ctx, db: f.B.db, root: f.B.ctx.root, packs: f.B.ctx.packs, engine: f.B.ctx.engine, answerer: f.B.ctx.answerer };
      const get = f.app.runtimes.get;
      f.app.runtimes.forIdentity = identity => identity.householdId === f.A.id ? foreign : get(identity.householdId);
      f.app.runtimes.get = id => id === f.A.id ? foreign : get(id);
      const response = await wire(f, f.A.admin, 'GET', { path: '/api/scenario' });
      assert.equal(response.status, 200, 'foreign_runtime_authorized');
      assert.ok(!response.text.includes(f.B.canary), 'foreign_runtime_disclosure');
      assert.fail('foreign_runtime_probe_not_observed');
    }

    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      await controlSuccess(f, own, other);
      for (const route of inventory.filter(r => !CONTROL.has(keyOf(r)))) {
        try {
        checkTime();
        const spec = specs.get(own.id)[keyOf(route)];
        await spec.before?.(); Object.assign(spec, await spec.prepare?.());
        const before = snapshot(other);
        const r = await wire(f, own.admin, route.method, spec);
        if (route.path === '/api/household/backups') await f.app.backups.idle();
        assert.equal(r.status, spec.status ?? 200, `authorized ${keyOf(route)} ${r.status} ${r.json?.error ?? ''}`);
        assert.ok(!r.text.includes(other.canary), `response ${keyOf(route)}`);
        if (spec.own) assert.ok(r.text.includes(own.canary), `complete_result ${keyOf(route)}`);
        stable(other, before, `authorized_foreign_effect ${keyOf(route)}`);
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
  } finally {
    globalThis.fetch = fetchReal;
    await f?.close();
    await new Promise(resolve => bridge.close(resolve));
  }
  console.log(JSON.stringify({ seeds, mutations, elapsedMs: Math.ceil(performance.now() - started) }));
});

if (!probe) test('the executable gate rejects unclassified routes and an injected foreign runtime', { timeout: 120000 }, async () => {
  for (const kind of ['unclassified-route', 'foreign-runtime']) {
    const r = await runCommand(process.execPath, ['test-isolation/route-fuzz.mjs'], { env: { FATHOM_ISOLATION_PROBE: kind }, timeoutMs: 60000 });
    assert.notEqual(r.code, 0, `negative_control_${kind}`);
    assert.ok((r.stdout + r.stderr).includes(kind === 'unclassified-route' ? 'unclassified_route' : 'foreign_runtime_disclosure'), `negative_control_assertion_${kind}`);
  }
});
