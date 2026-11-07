// Ask everywhere: one pending and streaming implementation. Under web/horizon only screens/chat.js
// calls askStream / newThreadStream and defines the pending and live rendering; the panel host
// (screens/ask-panel.js) mounts chat.js instead of copying it. design.js's pack composer
// `api.askFree(v, key)` is the one declared askFree call outside chat.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './helpers/server.mjs';

const HORIZON = join(ROOT, 'web/horizon');
const CHAT = 'screens/chat.js';
const PANEL = 'screens/ask-panel.js';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

// Source with block comments and line comments removed, so prose that names a function is not a call.
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = walk(HORIZON).map(abs => ({ rel: relative(HORIZON, abs).split(sep).join('/'), src: code(abs) }));
const others = files.filter(f => f.rel !== CHAT);
const chat = files.find(f => f.rel === CHAT);

const CALL = name => new RegExp(`\\b${name}\\s*\\(`, 'g');
const DEFINES = name => new RegExp(`\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=|\\b${name}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\()|^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
const LIVE_FNS = ['pendingHtml', 'liveHtml', 'paintLive', 'streamEvent'];

test('screens/chat.js holds the streaming calls and the pending and live rendering (liveness)', () => {
  assert.ok(chat, 'web/horizon/screens/chat.js exists');
  assert.ok(CALL('askStream').test(chat.src), 'chat.js calls askStream(');
  assert.ok(CALL('newThreadStream').test(chat.src), 'chat.js calls newThreadStream(');
  for (const fn of LIVE_FNS) assert.ok(DEFINES(fn).test(chat.src), `chat.js defines ${fn}`);
});

test('no other module under web/horizon calls askStream( or newThreadStream(', () => {
  const hits = [];
  for (const f of others) {
    for (const name of ['askStream', 'newThreadStream']) {
      const n = (f.src.match(CALL(name)) || []).length;
      if (n) hits.push(`${f.rel}: ${name} x${n}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('no other module under web/horizon defines pendingHtml, liveHtml, paintLive or streamEvent', () => {
  const hits = [];
  for (const f of others) for (const fn of LIVE_FNS) if (DEFINES(fn).test(f.src)) hits.push(`${f.rel}: ${fn}`);
  assert.deepEqual(hits, []);
});

test('askFree outside chat.js is only the pack composer call in design.js', () => {
  const hits = [];
  for (const f of others) {
    for (const m of f.src.matchAll(/\baskFree\s*\([^)]*\)/g)) hits.push(`${f.rel}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  const design = files.find(f => f.rel === 'design.js');
  assert.ok(design, 'web/horizon/design.js exists');
  assert.equal((design.src.match(/\bapi\.askFree\(v, key\)/g) || []).length, 1, 'the declared pack composer call is still there');
  const unexpected = hits.filter(h => h !== 'design.js: askFree(v, key)');
  assert.deepEqual(unexpected, [], 'no other askFree call outside chat.js');
});

test('screens/ask-panel.js exists and mounts chat.js', () => {
  const abs = join(HORIZON, PANEL);
  assert.ok(existsSync(abs), 'web/horizon/screens/ask-panel.js exists');
  const src = code(abs);
  const imports = /\bimport\s[^;]*?from\s*['"]\.\/chat\.js['"]/.test(src) || /\bimport\s*\(\s*['"]\.\/chat\.js['"]\s*\)/.test(src);
  assert.ok(imports, "ask-panel.js imports './chat.js'");
});
