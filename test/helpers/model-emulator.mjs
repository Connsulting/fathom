// A loopback model HTTP emulator for the MT-05 live-mode tests (test/tenancy-budget.test.mjs,
// test/tenancy-engine.test.mjs, test/tenancy-reconcile.test.mjs). It listens on 127.0.0.1, port 0,
// and implements POST /v1/messages (non-streaming JSON) so a live engine built with the
// programmatic `testTransport: { baseURL }` option runs its real request path with synthetic usage
// and no paid call.
//
// The response shape follows the Anthropic Messages API response documented at
// https://docs.claude.com/en/api/messages: { id, type: 'message', role: 'assistant', model,
// content: [{ type: 'text', text } | { type: 'tool_use', id, name, input }], stop_reason
// ('end_turn' or 'tool_use'), stop_sequence, usage: { input_tokens, output_tokens, ... } }.
// Errors use the documented error envelope { type: 'error', error: { type, message } }.
//
// startModelEmulator({ usage }) -> { baseURL, requests, script(list), waitForRequests(n), inFlight,
//   maxInFlight, close() }
// `usage` is the default usage object, or a function of the request body returning one.
// requests: every received request in arrival order as { index, body (parsed JSON), headers,
//   model, responded, response }.
// script(list) appends scripted responses; each request takes the next one, and a request with no
// script left gets the default response. An item is an object, or a function (body, entry) that
// returns one (it may have side effects, such as revoking a session between rounds). Fields:
//   text        the text block (default: JSON matching a rows/title schema, else a synthetic answer)
//   usage       this response's usage (object or function of the body)
//   toolUse     { name?, input?, id? } returns a tool_use block and stop_reason 'tool_use'; name
//               defaults to the first tool the request offered (a function of the body is allowed)
//   wait        a promise awaited before responding (holds the round in flight)
//   before      an async function (body, entry) run before responding
//   hang        never respond (a crash mid-round); close() destroys the socket
//   destroy     destroy the socket without a response (a transport error, cost unknown)
//   status      respond with this HTTP error status and the error envelope
// Every value is synthetic.

import http from 'node:http';

export const DEFAULT_USAGE = Object.freeze({ input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
export const DEFAULT_ANSWER = 'Synthetic answer with no figures.';
export const DEFAULT_TITLE = 'Synthetic thread title';

const pause = ms => new Promise(r => setTimeout(r, ms));

function defaultText(body) {
  const schema = body?.output_config?.format?.schema;
  const props = schema && typeof schema === 'object' && schema.properties ? schema.properties : {};
  if (Object.hasOwn(props, 'rows')) return JSON.stringify({ rows: [] });
  if (Object.hasOwn(props, 'title')) return JSON.stringify({ title: DEFAULT_TITLE });
  return DEFAULT_ANSWER;
}

function send(res, status, payload, n) {
  const bytes = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'request-id': `req_synthetic_${n}` });
  res.end(bytes);
}

export async function startModelEmulator({ usage = DEFAULT_USAGE } = {}) {
  const requests = [];
  const queue = [];
  const sockets = new Set();
  let inFlight = 0;
  let maxInFlight = 0;
  let closed = false;

  const usageFor = (item, body) => {
    const u = item.usage ?? usage;
    return structuredClone(typeof u === 'function' ? u(body) : u);
  };

  async function handle(req, res, raw) {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'POST' || path !== '/v1/messages') {
      send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Synthetic emulator: unknown route' } }, 0);
      return;
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch {
      send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic emulator: body is not JSON' } }, 0);
      return;
    }
    const entry = { index: requests.length, body, headers: { ...req.headers }, model: body.model, responded: false, response: null };
    requests.push(entry);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => { if (!entry.responded) { entry.responded = true; inFlight -= 1; } };
    try {
      let item = queue.length ? queue.shift() : {};
      if (typeof item === 'function') item = (await item(body, entry)) ?? {};
      if (item.before) await item.before(body, entry);
      if (item.wait) await item.wait;
      if (item.hang) return; // held until close() destroys the socket
      if (item.destroy) { done(); req.socket.destroy(); return; }
      const n = entry.index + 1;
      if (item.status) {
        done();
        send(res, item.status, { type: 'error', error: { type: item.errorType ?? 'api_error', message: 'Synthetic emulator error' } }, n);
        return;
      }
      const content = [];
      const text = item.text ?? (item.toolUse ? null : defaultText(body));
      if (typeof text === 'string' && text) content.push({ type: 'text', text });
      if (item.toolUse) {
        const offered = Array.isArray(body.tools) ? body.tools : [];
        const name = typeof item.toolUse.name === 'function' ? item.toolUse.name(body) : (item.toolUse.name ?? offered[0]?.name);
        content.push({ type: 'tool_use', id: item.toolUse.id ?? `toolu_synthetic_${n}`, name, input: item.toolUse.input ?? {} });
      }
      const message = {
        id: `msg_synthetic_${n}`, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: item.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null, usage: usageFor(item, body),
      };
      entry.response = message;
      done();
      send(res, 200, message, n);
    } catch {
      done();
      try { res.destroy(); } catch { /* already gone */ }
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { handle(req, res, Buffer.concat(chunks)); });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  return {
    baseURL,
    requests,
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
    script(list) { queue.push(...list); return this; },
    get scripted() { return queue.length; },
    // Resolves once at least n requests arrived; rejects after timeoutMs.
    async waitForRequests(n, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      while (requests.length < n) {
        if (Date.now() > until) throw new Error(`emulator: expected ${n} requests, got ${requests.length}`);
        await pause(10);
      }
      return requests.slice(0, n);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// A promise with its resolve function, for `wait` items.
export function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}
