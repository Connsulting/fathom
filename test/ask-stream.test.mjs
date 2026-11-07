import { tools as REGISTRY } from '../src/tools/index.mjs';
// Item 19: Ask answers stream. The event protocol over HTTP (start, progress, text, reset, final,
// error), the rule that nothing streamed is ever styled as verified, the trailing Sources strip and
// the markdown subset over escaped text.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createEngine, fakeChunks } from '../src/engine/index.mjs';
import { sdkStreamEvent, consumeSdkMessages } from '../src/engine/live.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer, renderAnswer, groundAnswer, PRODUCT_RULES, PROGRESS_START } from '../src/api/answerer.mjs';
import { stripSources, markdownBlocks, streamHtml, wrapBlocks, listMarkerSpans } from '../src/shared/answer-text.mjs';
import { SERVER_TIMEOUT, withServer, request, postJson, openStore, tempDb } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' };
const QUICK = 'Give me a quick read on where the household stands right now';
const VERIFIED = /fx-src|fx-fig|fx-unverified|data-fig|data-src/;

// Parses a Server-Sent Events body into [{ name, data }].
function events(text) {
  return text.split('\n\n').filter(b => b.trim() && !b.startsWith(':')).map(block => {
    const name = /^event: (.+)$/m.exec(block)[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { name, data };
  });
}

const streamPost = (s, path, body, headers = {}) =>
  postJson(s.baseUrl, path, body, { accept: 'text/event-stream', ...headers });

/* ---------- the stream protocol over HTTP ---------- */

test('POST /api/threads streams start, progress, text and a final event equal to the JSON answer', T, () => withServer({ env: FAKE }, async s => {
  const r = await streamPost(s, '/api/threads', { text: QUICK });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const evs = events(r.text);
  const names = evs.map(e => e.name);
  assert.equal(names[0], 'start');
  assert.match(evs[0].data.key, /^ask:[a-f0-9]{12}$/);
  assert.equal(names[1], 'progress');
  assert.equal(evs[1].data.label, PROGRESS_START);
  assert.equal(names.at(-1), 'final');
  const firstText = names.indexOf('text');
  assert.ok(firstText > 1, 'progress comes before any text');
  assert.ok(names.filter(n => n === 'text').length > 2, 'the text arrives in several chunks');
  // Progress labels are the fixed plain labels only.
  const labels = new Set(REGISTRY.map(t => t.progress));
  for (const e of evs.filter(x => x.name === 'progress')) {
    assert.ok(labels.has(e.data.label) || /^[A-Z][a-z ]+$/.test(e.data.label), e.data.label);
    assert.deepEqual(Object.keys(e.data), ['label']);
  }
  // Streamed text is the raw model text: never HTML, never a verified span.
  const streamed = evs.filter(e => e.name === 'text').map(e => e.data.text).join('');
  assert.doesNotMatch(streamed, /<|fx-/);
  const final = evs.at(-1).data;
  assert.equal(final.thread.key, evs[0].data.key);
  assert.equal(final.message.role, 'fathom');
  assert.match(final.message.text, /class="fx-src"/);
  assert.equal(final.message.provenance.grounding.ok, true);
  // The stored turn is written once.
  const db = await openStore(s.dbFile);
  try {
    const rows = db.prepare('SELECT role FROM messages WHERE conversation_key = ? ORDER BY id').all(final.thread.key);
    assert.deepEqual(rows.map(x => x.role), ['me', 'fathom']);
  } finally { db.close(); }
}));

test('POST /api/ask streams in an existing thread; JSON requests are unchanged', T, () => withServer({ env: FAKE }, async s => {
  const first = await postJson(s.baseUrl, '/api/threads', { text: QUICK });
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'], /^application\/json/);
  const key = first.json.thread.key;
  const r = await streamPost(s, '/api/ask', { key, text: 'And what next?' });
  const evs = events(r.text);
  assert.deepEqual(evs[0], { name: 'start', data: { key } });
  assert.equal(evs.at(-1).name, 'final');
  assert.equal(evs.at(-1).data.scenario.live.conversations[key].length, 4);
}));

test('a validation error before the stream starts is an ordinary JSON error; no stream starts', T, () => withServer({ env: FAKE }, async s => {
  const bad = await streamPost(s, '/api/ask', { key: 'ask:0123456789ab', text: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers['content-type'], /^application\/json/);
  const missing = await streamPost(s, '/api/ask', { key: 'ask:0123456789ab', text: 'hello' });
  assert.equal(missing.status, 404);
}));

test('a client that disconnects mid-stream still gets its answer stored once', T, () => withServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '40' } }, async s => {
  const url = new URL(s.baseUrl);
  const payload = JSON.stringify({ text: QUICK });
  const key = await new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path: '/api/threads',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream',
        'content-length': Buffer.byteLength(payload) } }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        const m = /event: start\ndata: (.+)\n/.exec(buf);
        if (m) { req.destroy(); resolve(JSON.parse(m[1]).key); }
      });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end(payload);
  });
  let rows = [];
  for (let i = 0; i < 50 && rows.length < 2; i++) {
    await new Promise(r => setTimeout(r, 100));
    const db = await openStore(s.dbFile);
    try { rows = db.prepare('SELECT role, text FROM messages WHERE conversation_key = ? ORDER BY id').all(key); } finally { db.close(); }
  }
  assert.deepEqual(rows.map(x => x.role), ['me', 'fathom']);
  assert.match(rows[1].text, /fx-src/);
  const thread = await request(s.baseUrl, { path: `/api/threads/${key.slice(4)}` });
  assert.equal(thread.json.messages.length, 2);
}));

/* ---------- engine and answerer events ---------- */

test('the fake engine emits tool and text events in deterministic chunks without changing the result', async () => {
  const engine = createEngine({ mode: 'fake' });
  const seen = [];
  const res = await engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'q' }],
    fake: [{ text: 'One two three four five six seven.' }], onEvent: e => seen.push(e) });
  assert.equal(res.text, 'One two three four five six seven.');
  assert.deepEqual(seen, fakeChunks(res.text).map(text => ({ type: 'text', text })));
  assert.deepEqual(fakeChunks('One two three four five six seven.'), ['One two three ', 'four five six ', 'seven.']);
  // A throwing listener never fails the call; non-chat purposes never stream.
  const again = await engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'q' }], fake: [{ text: 'Hi there.' }],
    onEvent: () => { throw new Error('boom'); } });
  assert.equal(again.text, 'Hi there.');
  const quiet = [];
  await engine.call({ purpose: 'title', messages: [{ role: 'user', content: 'q' }], fake: [{ text: '{}' }], onEvent: e => quiet.push(e) });
  assert.deepEqual(quiet, []);
});

test('live SDK partial messages map to tool and text events', async () => {
  assert.deepEqual(sdkStreamEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__fathom__household', input: {} } } }),
    { type: 'tool', name: 'household' });
  assert.deepEqual(sdkStreamEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }),
    { type: 'text', text: 'Hi' });
  assert.equal(sdkStreamEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":1}' } } }), null);
  assert.equal(sdkStreamEvent({ type: 'assistant' }), null);
  async function* messages() {
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }], usage: {} } };
    yield { type: 'result', subtype: 'success', result: 'A', total_cost_usd: 0.01 };
  }
  const seen = [];
  const out = await consumeSdkMessages(messages(), e => seen.push(e));
  assert.deepEqual(seen, [{ type: 'text', text: 'A' }]);
  assert.equal(out.result.result, 'A');
});

async function demoAnswerer(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const engine = createRuntimeEngine({ db: s.db, config });
  // The temp store's directory stands in as the household root.
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { s, engine, packs, root: s.dataDir };
}

test('a regeneration streams its revision step, then a plain reset, before the new answer streams', async t => {
  const { s, engine, packs, root } = await demoAnswerer(t);
  let n = 0;
  const wrapped = { ...engine, mode: engine.mode, isOn: () => engine.isOn(), call: req => engine.call({ ...req,
    fake: n++ === 0 ? [{ text: 'You owe $987,654 this year and $876,543 next year.' }] : [{ toolCalls: [{ name: 'household', args: { operation: 'summary', } }] }, { text: 'Nothing to add.' }] }) };
  const seen = [];
  const reply = await createLiveAnswerer({ engine: wrapped, packs, root }).answer({ db: s.db, key: 'ask:0123456789ab', text: 'How much?', onEvent: e => seen.push(e) });
  assert.equal(reply.provenance.grounding.retried, true);
  const types = seen.map(e => e.type);
  const reset = types.indexOf('reset');
  assert.ok(reset > types.indexOf('text'), 'the first answer streamed, then was reset');
  assert.deepEqual(seen.filter(e => e.type === 'reset'), [{ type: 'reset' }], 'one plain reset, no draft flag');
  const revised = seen.findIndex(e => e.type === 'progress' && e.label === 'Revised to remove 2 unchecked figures');
  assert.ok(revised > types.indexOf('text') && revised < reset, 'the revision step comes after the first answer and before the reset');
  assert.equal(seen.slice(reset + 1).filter(e => e.type === 'text').map(e => e.text).join(''), 'Nothing to add.');
  // The reply itself is the only grounded output; streamed text never carries spans.
  for (const e of seen.filter(x => x.type === 'text')) assert.doesNotMatch(e.text, /</);
  // Engine off keeps today's notice and streams nothing.
  const off = [];
  const offReply = await createLiveAnswerer({ engine: { ...wrapped, isOn: () => false, mode: 'fake' }, packs, root })
    .answer({ db: s.db, key: 'ask:0123456789ab', text: 'How much?', onEvent: e => off.push(e) });
  assert.equal(offReply.notice, true);
  assert.deepEqual(off, []);
});

/* ---------- never verified before grounding ---------- */

test('streamHtml shows numbers and tokens only in the neutral checking style, escaped', () => {
  const html = streamHtml('You paid $4,821 and **12%** of {f:est_q3} <script>alert(1)</script> {p:bad');
  assert.doesNotMatch(html, VERIFIED);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span class="fx-checking"[^>]*>\$4,821<\/span>/);
  assert.match(html, /<strong><span class="fx-checking"[^>]*>12%<\/span><\/strong>/);
  assert.match(html, /<span class="fx-checking"[^>]*>\.\.\.<\/span>/, 'an unresolved token shows a placeholder');
  assert.doesNotMatch(html, /\{p:bad|&#123;p:bad/, 'a half-written token is hidden');
  const resolved = streamHtml('Set aside {f:est_q3}.', tok => (tok === '{f:est_q3}' ? '$9,000' : null));
  assert.match(resolved, /<span class="fx-checking"[^>]*>\$9,000<\/span>/);
  assert.doesNotMatch(resolved, VERIFIED);
  // A resolver returning markup is escaped too.
  assert.doesNotMatch(streamHtml('{f:x}', () => '<b>1</b>'), /<b>/);
  // List numbering stays plain so the list still reads as a list.
  assert.equal(streamHtml('1. First\n2. Second'), '<ol><li>First</li><li>Second</li></ol>');
});

/* ---------- Sources ---------- */

test('stripSources removes a trailing Sources paragraph, heading block or sentence only', () => {
  assert.equal(stripSources('Pay the estimate.\n\nSources: household summary, household.figures'), 'Pay the estimate.');
  assert.equal(stripSources('Pay the estimate.\n\n**Sources:**\n- household summary\n- tax pack'), 'Pay the estimate.');
  assert.equal(stripSources('Pay the estimate.\n\nSources\n- household summary'), 'Pay the estimate.');
  assert.equal(stripSources('Pay the estimate. Sources: household summary.'), 'Pay the estimate.');
  assert.equal(stripSources('Pay the estimate.\nSource: household.figures'), 'Pay the estimate.');
  assert.equal(stripSources('Pay it.\n\nReferences: a, b\n\nSources: c'), 'Pay it.');
  // Not a trailing source line: kept.
  assert.equal(stripSources('Your sources of income are steady.'), 'Your sources of income are steady.');
  assert.equal(stripSources('Sources: only this'), 'Sources: only this');
  assert.equal(stripSources('Check the sources: then decide. Then pay.'), 'Check the sources: then decide. Then pay.');
  assert.equal(
    stripSources('Give appreciated assets instead of cash.\n\nSources: "Gifts of appreciated stock" and "Evaluate bunching across tax years."\n\nQuarterly tax payments. Schedule them.'),
    'Give appreciated assets instead of cash.\n\nQuarterly tax payments. Schedule them.',
  );
  assert.equal(stripSources('Open. Sources: "A" and "B." More stays.'), 'Open. More stays.');
  assert.equal(stripSources('Read this.\nReferences: the pack.\nThen decide.'), 'Read this.\nThen decide.');
  assert.equal(
    stripSources('Open. Sources: "Gifts of appreciated stock." and "Evaluate bunching across tax years." Then pay.'),
    'Open. Then pay.',
  );
  assert.equal(
    stripSources('Open. Sources: \u201cGifts of appreciated stock.\u201d and \u201cEvaluate bunching across tax years.\u201d Then pay.'),
    'Open. Then pay.',
  );
  assert.equal(stripSources('See this. Sources: https://irs.gov/publications/p526. Then pay.'), 'See this. Then pay.');
  assert.equal(
    stripSources('Your retirement plan has two funding\nsources: employer contributions and your own deferrals.\nKeep both.'),
    'Your retirement plan has two funding\nsources: employer contributions and your own deferrals.\nKeep both.',
  );
});

test('streamHtml drops a mid-answer Sources sentence and keeps the prose around it', () => {
  const html = streamHtml('Give appreciated assets instead of cash.\n\nSources: "Gifts of appreciated stock" and "Evaluate bunching across tax years."\n\nQuarterly tax payments.');
  assert.match(html, /Give appreciated assets instead of cash/);
  assert.match(html, /Quarterly tax payments/);
  assert.doesNotMatch(html, /Sources/);
  assert.doesNotMatch(html, /Gifts of appreciated/);
  assert.match(streamHtml('Your sources of income are steady.'), /sources of income/);
});

test('stripSources keeps wrapped prose that continues with sources', () => {
  const wrapped = 'Your retirement plan has two funding\nsources: employer contributions and your own deferrals.';
  assert.equal(stripSources(wrapped), wrapped);
  assert.equal(stripSources(`${wrapped}\nKeep both.`), `${wrapped}\nKeep both.`);
  // Capitalized, but after a line that did not end a sentence: still prose.
  const capital = 'Your plan has two funding\nSources: employer and own deferrals.';
  assert.equal(stripSources(capital), capital);
});

test('stripSources removes comma and semicolon separated citations', () => {
  assert.equal(stripSources('Open. Sources: "A", "B." Then pay.'), 'Open. Then pay.');
  assert.equal(stripSources('Open. Sources: "A"; "B". Then pay.'), 'Open. Then pay.');
  assert.equal(stripSources('Open. Sources: household summary, tax pack. Then pay.'), 'Open. Then pay.');
  assert.equal(stripSources('Open. Sources: “A”, “B.” Then pay.'), 'Open. Then pay.');
  const oxford = 'Open. Sources: "A", "B", and "C." Then pay.';
  assert.equal(stripSources(oxford), 'Open. Then pay.');
  assert.equal(stripSources('Open. Sources: "A"; "B"; and "C". Then pay.'), 'Open. Then pay.');
  const html = streamHtml(oxford);
  assert.match(html, /Then pay/);
  assert.doesNotMatch(html, /Sources/);
});

test('stripSources and streamHtml remove a singular Source label', () => {
  assert.equal(stripSources('Open. Source: "A". Then pay.'), 'Open. Then pay.');
  assert.equal(stripSources('Pay it.\n\nSource: household summary\n\nKeep a reserve.'), 'Pay it.\n\nKeep a reserve.');
  const html = streamHtml('Open. Source: "Gifts of appreciated stock". Then pay.');
  assert.match(html, /Then pay/);
  assert.doesNotMatch(html, /Source/);
  assert.equal(stripSources('Open. Reference: "A". Then pay.'), 'Open. Then pay.');
  assert.equal(stripSources('Open. Citation: the tax pack. Then pay.'), 'Open. Then pay.');
});

test('a removed citation list item leaves no bare marker', () => {
  // Mid-list: the whole item goes with its marker; the remaining numbering is left alone.
  assert.equal(stripSources('Do these:\n\n1. Pay the estimate.\n2. Sources: "Quarterly taxes"\n3. Keep a reserve.'),
    'Do these:\n\n1. Pay the estimate.\n3. Keep a reserve.');
  // Trailing item.
  assert.equal(stripSources('Do these:\n\n1. Pay the estimate.\n2. Sources: household summary'),
    'Do these:\n\n1. Pay the estimate.');
  // A bullet item goes with its dash.
  assert.equal(stripSources('Do these:\n\n- Pay the estimate.\n- Sources: tax pack\n- Keep a reserve.'),
    'Do these:\n\n- Pay the estimate.\n- Keep a reserve.');
  // An item with a sentence before the citation keeps the sentence and its marker.
  assert.equal(stripSources('Do these:\n\n1. Pay the estimate.\n2. Keep a reserve. Sources: "A".\n3. File on time.'),
    'Do these:\n\n1. Pay the estimate.\n2. Keep a reserve.\n3. File on time.');
  assert.equal(stripSources('1. Pay the estimate.\n2. Keep a reserve. Sources: "A".'), '1. Pay the estimate.\n2. Keep a reserve.');
});

test('the prompt tells the model not to cite sources and allows the markdown subset', () => {
  assert.match(PRODUCT_RULES, /Never write a Sources/);
  assert.match(PRODUCT_RULES, /Call tools before you write/);
  assert.doesNotMatch(PRODUCT_RULES, /Cite a knowledge pack entry/);
  assert.match(PRODUCT_RULES, /bullet lists/);
});

/* ---------- markdown subset over escaped text ---------- */

test('markdownBlocks renders paragraphs, lists and bold over escaped text only', () => {
  assert.deepEqual(markdownBlocks('Intro line\n\n- one\n- **two**\n\n1. a\n2. b'),
    ['Intro line', '<ul><li>one</li><li><strong>two</strong></li></ul>', '<ol><li>a</li><li>b</li></ol>']);
  assert.deepEqual(markdownBlocks('3. c\n4. d'), ['<ol start="3"><li>c</li><li>d</li></ol>']);
  assert.deepEqual(markdownBlocks('Steps:\n- one\nAfter'), ['Steps:', '<ul><li>one</li></ul>', 'After']);
  assert.deepEqual(markdownBlocks('-$400 is a loss'), ['-$400 is a loss']);
  // Bold never spans a partial tag.
  assert.deepEqual(markdownBlocks('**a <span class="fx-src">$1</span>** b'), ['<strong>a <span class="fx-src">$1</span></strong> b']);
  assert.equal(wrapBlocks(['p1', '<ul><li>x</li></ul>']), '<p>p1</p><ul><li>x</li></ul>');
});

test('renderAnswer escapes model markup and keeps list numbers out of grounding', () => {
  const text = 'Do this:\n\n1. Pay <b>now</b>\n2. File **soon**\n\n- <img src=x onerror=alert()>';
  const g = groundAnswer(text, { scenario: { fig: {} }, toolResults: [], data: [] });
  assert.equal(g.ok, true, JSON.stringify(g.violations));
  const blocks = renderAnswer(text, g.violations, g.literals);
  assert.deepEqual(blocks, ['Do this:', '<ol><li>Pay &lt;b&gt;now&lt;/b&gt;</li><li>File <strong>soon</strong></li></ol>',
    '<ul><li>&lt;img src=x onerror=alert()&gt;</li></ul>']);
  assert.deepEqual(listMarkerSpans('1. a\n  2) b\nx 3. c'), [{ index: 0, length: 2 }, { index: 7, length: 2 }]);
  // A number inside a list item is still checked.
  const bad = groundAnswer('1. Pay $987,654', { scenario: { fig: {} }, toolResults: [], data: [] });
  assert.deepEqual(bad.violations.map(v => v.text), ['$987,654']);
  assert.match(renderAnswer('1. Pay $987,654', bad.violations, bad.literals)[0],
    /^<ol><li>Pay <span class="fx-checking fx-unchecked" title="Not checked against your data">\$987,654<\/span>/);
});
