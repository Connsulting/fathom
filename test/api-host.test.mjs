// DNS rebinding: the Host allowlist covers every /api route, not only key management and /mcp.
// Default allowlist: IP literals, localhost and *.localhost, plus FATHOM_PUBLIC_URL's host and
// FATHOM_ALLOWED_HOSTS. /healthz and static files stay unguarded.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_TIMEOUT, spawnServer, request, postJson } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json, 'JSON body');
  return r;
}

async function forbidden(resPromise, label = '') {
  const r = await resPromise;
  assert.equal(r.status, 403, `${label} expected 403, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.deepEqual(r.json, { error: 'forbidden host' }, label);
  return r;
}

describe('Host allowlist across the whole /api surface', () => {
  let s;
  let evil;
  let foreign;
  before(async () => {
    s = await spawnServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_ALLOWED_HOSTS: 'agent.example.test' } });
    evil = `rebind.example:${s.port}`;
    foreign = { host: evil, origin: `http://${evil}` };
  }, T);
  after(async () => { if (s) await s.stop(); });

  const scenario = async headers => (await ok(request(s.baseUrl, { path: '/api/scenario', headers }))).json;

  test('a foreign Host cannot read the scenario', async () => {
    await forbidden(request(s.baseUrl, { path: '/api/scenario', headers: { host: evil } }), 'GET /api/scenario');
    await forbidden(request(s.baseUrl, { path: '/api/scenario', headers: foreign }), 'GET /api/scenario with Origin');
  });

  test('a foreign Host with a matching Origin cannot mutate; the engine stays on', async () => {
    assert.equal((await scenario()).live.engine, true, 'precondition: engine on');
    await forbidden(postJson(s.baseUrl, '/api/engine', { on: false }, foreign), 'POST /api/engine');
    assert.equal((await scenario()).live.engine, true, 'engine still on after the refused POST');
  });

  test('other routes, encoded paths, unknown paths and wrong methods are all refused', async () => {
    const before = JSON.stringify(await scenario());
    await forbidden(postJson(s.baseUrl, '/api/recs/any-id/action', { action: 'accept' }, foreign), 'POST recs action');
    await forbidden(postJson(s.baseUrl, '/api/ask', { key: 'deferral', text: 'hello' }, foreign), 'POST /api/ask');
    await forbidden(postJson(s.baseUrl, '/api/threads', { text: 'hello' }, foreign), 'POST /api/threads');
    await forbidden(request(s.baseUrl, { path: '/api/threads', headers: foreign }), 'GET /api/threads');
    await forbidden(postJson(s.baseUrl, '/api/demo/reset', {}, foreign), 'POST demo reset');
    await forbidden(request(s.baseUrl, { path: '/api/%73cenario', headers: foreign }), 'encoded /api/%73cenario');
    await forbidden(request(s.baseUrl, { path: '/api/nope', headers: foreign }), 'unknown /api/nope');
    await forbidden(request(s.baseUrl, { path: '/api', headers: foreign }), 'bare /api');
    await forbidden(request(s.baseUrl, { path: '/api/', headers: foreign }), '/api/');
    await forbidden(request(s.baseUrl, { path: '/api/scenario?x=1', headers: foreign }), 'query string');
    await forbidden(request(s.baseUrl, { method: 'DELETE', path: '/api/scenario', headers: foreign }), 'wrong method DELETE');
    await forbidden(request(s.baseUrl, { method: 'PUT', path: '/api/engine', headers: foreign }), 'wrong method PUT');
    await forbidden(request(s.baseUrl, { path: '/api/engine', headers: foreign }), 'wrong method GET on a POST route');
    assert.equal(JSON.stringify(await scenario()), before, 'refused requests changed nothing');
  });

  test('liveness: IP literal, localhost and a configured host are served, read and mutation', async () => {
    await ok(postJson(s.baseUrl, '/api/engine', { on: true }));
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, 'agent.example.test']) {
      const headers = { host, origin: `http://${host}` };
      assert.equal((await scenario({ host })).live.engine, true, `read via ${host}`);
      const off = await ok(postJson(s.baseUrl, '/api/engine', { on: false }, headers));
      assert.equal(off.json.scenario.live.engine, false, `mutation via ${host}`);
      assert.equal((await scenario()).live.engine, false);
      const on = await ok(postJson(s.baseUrl, '/api/engine', { on: true }, headers));
      assert.equal(on.json.scenario.live.engine, true, `restore via ${host}`);
    }
    assert.equal((await scenario()).live.engine, true);
  });

  test('liveness: an encoded path on an allowed Host is still served', async () => {
    await ok(request(s.baseUrl, { path: '/api/%73cenario' }));
    const r = await request(s.baseUrl, { path: '/api/nope' });
    assert.equal(r.status, 404);
  });

  // A small valid multipart body: one text file in the "files" field.
  const upload = () => {
    const boundary = 'fathom-host-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from('date,amount,description\n2032-01-05,-12.34,Synthetic host test row\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, 'content-type': `multipart/form-data; boundary=${boundary}` };
  };
  const files = async headers => (await ok(request(s.baseUrl, { path: '/api/files', headers }))).json.files;

  test('a foreign Host with a matching Origin cannot use the ingest routes', async () => {
    const empty = await files();
    assert.ok(!empty.some(f => f.name === 'synthetic.csv'), 'precondition: the upload is not stored yet');
    const pending = (await ok(request(s.baseUrl, { path: '/api/confirm' }))).json;
    const { body, 'content-type': contentType } = upload();
    await forbidden(request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { ...foreign, 'content-type': contentType }, body }), 'POST /api/files');
    await forbidden(request(s.baseUrl, { path: '/api/files', headers: foreign }), 'GET /api/files');
    await forbidden(postJson(s.baseUrl, '/api/files/any-id/retry', {}, foreign), 'POST /api/files/:id/retry');
    await forbidden(request(s.baseUrl, { path: '/api/confirm', headers: foreign }), 'GET /api/confirm');
    await forbidden(postJson(s.baseUrl, '/api/confirm/list', {}, foreign), 'POST /api/confirm/list');
    await forbidden(postJson(s.baseUrl, '/api/confirm/1/answer', { answer: 'yes' }, foreign), 'POST /api/confirm/:id/answer');
    await forbidden(postJson(s.baseUrl, '/api/confirm/any-id/answer', { answer: 'yes' }, foreign), 'POST /api/confirm/<non numeric>/answer');
    const after = await files();
    assert.deepEqual(after, empty, 'no file was stored by the refused requests');
    assert.ok(!after.some(f => f.name === 'synthetic.csv'), 'the refused upload is not in the file list');
    assert.deepEqual((await ok(request(s.baseUrl, { path: '/api/confirm' }))).json, pending, 'the confirm queue is unchanged');

    // Control: the same body on an allowed Host is accepted, so the refusals above were the Host guard.
    const accepted = await ok(request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { 'content-type': contentType }, body }));
    assert.equal(accepted.json.files.length, 1);
    assert.ok((await files()).some(f => f.name === 'synthetic.csv'), 'the allowed upload is listed');
  });

  test('a foreign Host without an Origin is refused on the ingest routes too', async () => {
    await forbidden(request(s.baseUrl, { path: '/api/files', headers: { host: evil } }), 'GET /api/files');
    await forbidden(postJson(s.baseUrl, '/api/confirm/list', {}, { host: evil }), 'POST /api/confirm/list');
  });

  test('liveness: the ingest routes answer on an IP literal and on the configured DNS name', async () => {
    for (const host of [`127.0.0.1:${s.port}`, 'agent.example.test']) {
      const headers = { host, origin: `http://${host}` };
      const list = await ok(request(s.baseUrl, { path: '/api/files', headers }));
      assert.ok(Array.isArray(list.json.files), `GET /api/files via ${host}`);
      const confirm = await ok(postJson(s.baseUrl, '/api/confirm/list', {}, headers));
      assert.ok(Array.isArray(confirm.json.items), `POST /api/confirm/list via ${host}`);
      const pending = await ok(request(s.baseUrl, { path: '/api/confirm', headers }));
      assert.ok(Array.isArray(pending.json.items), `GET /api/confirm via ${host}`);
    }
  });

  test('/healthz and the UI shell stay unguarded for a foreign Host', async () => {
    const h = await request(s.baseUrl, { path: '/healthz', headers: { host: evil } });
    assert.equal(h.status, 200);
    assert.equal(h.json && h.json.ok, true);
    const page = await request(s.baseUrl, { path: '/', headers: { host: evil } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] || '', /text\/html/);
  });
});
