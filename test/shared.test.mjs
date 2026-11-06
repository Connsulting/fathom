// Shared browser-safe logic (src/shared) that the server tools and the UI must agree on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_STATUS, needsRule, needsYou, verdictLevel } from '../src/shared/rules.mjs';
import { money, resolveTokens } from '../src/shared/tokens.mjs';
import { ROOT } from './helpers/server.mjs';

const rec = (id, status, days) => ({ id, status, window: { label: 'x', days } });

test('shared modules import nothing from node', () => {
  for (const f of ['src/shared/rules.mjs', 'src/shared/tokens.mjs']) {
    const code = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/from\s+['"]node:|require\(/.test(code), `${f} must stay browser safe`);
  }
});

test('ACTION_STATUS maps every action', () => {
  assert.deepEqual({ ...ACTION_STATUS }, {
    start: 'doing', complete: 'done', dismiss: 'dismissed', snooze: 'snoozed', reopen: 'proposed',
  });
});

test('needsRule follows the CONTRACT rule', () => {
  assert.equal(needsRule('proposed', rec('a', 'proposed', 400)), true);
  assert.equal(needsRule('doing', rec('a', 'doing', 5)), true);
  assert.equal(needsRule('doing', rec('a', 'doing', 30)), true);
  assert.equal(needsRule('doing', rec('a', 'doing', 31)), false);
  for (const s of ['waiting', 'snoozed', 'done', 'dismissed', 'hidden']) assert.equal(needsRule(s, rec('a', s, 1)), false, s);
});

test('needsYou sorts by window and excludes hidden; verdictLevel follows it', () => {
  const recs = [rec('late', 'proposed', 50), rec('soon', 'doing', 3), rec('h', 'hidden', 1), rec('w', 'waiting', 1), rec('mid', 'doing', 20)];
  assert.deepEqual(needsYou(recs).map(r => r.id), ['soon', 'mid', 'late']);
  assert.equal(verdictLevel(recs), 'attention');
  assert.equal(verdictLevel([rec('d', 'done', 1), rec('h', 'hidden', 1)]), 'clear');
});

test('money formats like the mock', () => {
  assert.equal(money(44854), '$44,854');
  assert.equal(money(44854.4), '$44,854');
  assert.equal(money(-1390), '-$1,390');
  assert.equal(money(1700, { sign: true }), '+$1,700');
  assert.equal(money(45000, { k: true }), '$45K');
  assert.equal(money(2380000, { k: true }), '$2.38M');
  assert.equal(money(0), '$0');
});

test('resolveTokens resolves each token type, as HTML or text', () => {
  const sc = {
    fig: { cash: { v: 44854, src: 's1', kind: 'a', label: 'Cash' } },
    law: { cap: 24500 },
    pct: { rate: 35 },
    names: { me: 'Pat <Q>' },
  };
  const s = 'Have {f:cash} ({fk:cash}), cap {l:cap}, rate {p:rate}, for {n:me}.';
  assert.equal(resolveTokens(sc, s, false), 'Have $44,854 ($45K), cap $24,500, rate 35%, for Pat <Q>.');
  const html = resolveTokens(sc, s, true);
  assert.match(html, /<span class="fx-fig" data-fig="cash" data-kind="a"[^>]*>\$44,854<\/span>/);
  assert.match(html, /<span class="fx-law">\$24,500<\/span>/);
  assert.ok(html.includes('Pat &lt;Q&gt;'));
  assert.equal(resolveTokens(sc, 'no tokens here', true), 'no tokens here');
  assert.equal(resolveTokens(sc, '&#123;f:cash&#125;', true), '&#123;f:cash&#125;', 'escaped braces stay inert');
});
