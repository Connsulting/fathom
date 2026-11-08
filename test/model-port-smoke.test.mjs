import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const run = (baseUrl, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/model-port-smoke.mjs'], { env: { ...process.env,
    FATHOM_SMOKE_ADAPTER: 'ollama', FATHOM_SMOKE_MODEL: 'synthetic-model', FATHOM_SMOKE_BASE_URL: baseUrl, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
});
test('smoke CLI drives every purpose, prints only verdicts and counts, and fails invalid answers', async t => {
  let calls = 0, invalid = false;
  const server = http.createServer(async (req, res) => {
    calls++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(req.url, '/api/chat'); assert.equal(body.model, 'synthetic-model');
    const choice = !!body.format?.properties?.q0;
    const content = invalid ? '{}' : choice ? '{"q0":{"choice":"Groceries","confidence":0.9,"probabilities":{"Groceries":0.9,"Business":0.1}}}' : '{"ok":true}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ done: true, done_reason: 'stop', message: { content }, prompt_eval_count: 20, eval_count: 10 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const good = await run(url); assert.equal(good.code, 0, good.stderr); assert.equal(calls, 4);
  assert.deepEqual(good.stdout.trim().split('\n'), ['ask', 'title', 'categorize', 'import'].map(p => `${p} pass input_tokens=20 output_tokens=10`));
  invalid = true;
  const bad = await run(url); assert.equal(bad.code, 1); assert.equal(calls, 8);
  assert.deepEqual(bad.stdout.trim().split('\n'), ['ask', 'title', 'categorize', 'import'].map(p => `${p} fail input_tokens=20 output_tokens=10`));
  assert.ok(!bad.stdout.includes('synthetic-model'));
});
