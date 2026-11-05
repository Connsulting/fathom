// AC10: docs/architecture.md records the frozen architecture plus the actual tables and routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '../src/api/router.mjs';
import { listTables } from '../src/store/db.mjs';
import { ROOT, tempDb } from './helpers/server.mjs';

const doc = readFileSync(join(ROOT, 'docs/architecture.md'), 'utf8');
const headings = doc.split('\n').filter(l => /^#{1,6}\s/.test(l)).join('\n');

const SECTIONS = {
  stack: /stack/i,
  layout: /layout/i,
  money: /money/i,
  UI: /\bUI\b|user interface/i,
  facts: /facts/i,
  'pack manifest': /pack manifest/i,
  'parser interface': /parser interface/i,
  'tool interface': /tool interface/i,
  'engine gateway': /engine gateway/i,
  config: /config/i,
};

const FACT_KEYS = [
  'household.state', 'household.filingStatus', 'household.dependents', 'household.expectingChild',
  'household.dependentAges', 'income.w2', 'income.sCorp', 'income.selfEmployed', 'income.partnership',
  'income.agiEstimate', 'benefits.hsa', 'benefits.employer401k', 'retirement.solo401k', 'retirement.ira',
  'retirement.backdoorRothCandidate', 'accounts.has529', 'giving.charitable', 'giving.annualEstimate',
];

const ENV_KEYS = [
  'FATHOM_DATA', 'FATHOM_PORT', 'FATHOM_HOST', 'FATHOM_DEMO', 'FATHOM_ENGINE', 'FATHOM_CLOCK',
  'FATHOM_CLAUDE_CREDENTIAL_FILE', 'FATHOM_DATA_KEY_FILE', 'FATHOM_EMAIL_TRANSPORT',
  'FATHOM_PUBLIC_URL', 'FATHOM_ALLOWED_HOSTS', 'FATHOM_OWNER_LOGINS', 'FATHOM_OWNER_LOGINS_FILE',
];

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

test('architecture.md has every frozen section as a heading', () => {
  for (const [name, re] of Object.entries(SECTIONS)) assert.match(headings, re, `missing section: ${name}`);
});

test('architecture.md lists every frozen fact key', () => {
  for (const k of FACT_KEYS) assert.ok(doc.includes(k), `missing fact key ${k}`);
});

test('architecture.md lists every config env key', () => {
  for (const k of ENV_KEYS) assert.ok(doc.includes(k), `missing env key ${k}`);
});

test('architecture.md mentions every table the migrations create', async () => {
  const t = await tempDb();
  try {
    const tables = listTables(t.db);
    assert.ok(tables.length > 0);
    for (const name of tables) assert.match(doc, new RegExp(`\\b${name}\\b`), `missing table ${name}`);
  } finally {
    t.close();
  }
});

test('architecture.md lists every API route with its method', () => {
  assert.ok(Array.isArray(routes) && routes.length > 0);
  const lines = doc.split('\n');
  for (const { method, path } of routes) {
    assert.ok(typeof method === 'string' && typeof path === 'string');
    assert.ok(lines.some(l => l.includes(path) && l.includes(method.toUpperCase())), `missing route ${method} ${path}`);
  }
  for (const p of ['/healthz', '/api/scenario', '/api/recs/:id/action', '/api/ask', '/api/threads', '/api/demo/reset', '/api/identity']) {
    assert.ok(routes.some(r => r.path === p), `router registers ${p}`);
  }
});

test('architecture.md and README.md state the owner identity trust model', () => {
  for (const [name, text] of [['architecture.md', doc], ['README.md', readme]]) {
    assert.match(text, /tailscale serve/i, `${name} names tailscale serve as the only path in`);
    assert.match(text, /Tailscale-User-Login/i, `${name} names the identity header`);
    assert.ok(text.includes('FATHOM_OWNER_LOGINS'), `${name} names FATHOM_OWNER_LOGINS`);
  }
  assert.match(headings, /owner identity/i, 'architecture.md has an Owner identity section');
  assert.ok(!doc.includes('There is no authentication in this item'), 'the old no-authentication note is gone');
});
