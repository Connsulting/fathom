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
  'FATHOM_PUBLIC_URL', 'FATHOM_ALLOWED_HOSTS', 'FATHOM_TRUSTED_PROXIES',
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

test('architecture.md and README.md describe passkey accounts and separate MCP bearer access', () => {
  for (const [name, text] of [['architecture.md', doc], ['README.md', readme]]) {
    assert.match(text, /passkey/i, name);
    assert.match(text, /session/i, name);
    assert.match(text, /FATHOM_PUBLIC_URL/, name);
    assert.match(text, /user:invite|user-invite\.mjs/, name);
    assert.match(text, /--admin/, name);
    assert.match(text, /recover/i, name);
    assert.match(text, /bearer/i, name);
    assert.match(text, /demo/i, name);
  }
  assert.match(doc, /one household|single household/i);
  assert.match(doc, /ownerless|creator|creating user/i);
  assert.match(doc, /Origin/);
  assert.match(doc, /credProps|discoverab|resident/i);
  assert.match(doc, /unrecoverable|offline database/i);
});

test('account docs explain explicit proxy trust, recent sign-in and security notices', () => {
  for (const [name, text] of [['architecture.md', doc], ['README.md', readme]]) {
    const proxy = text.split('\n').find(line => line.includes('FATHOM_TRUSTED_PROXIES') && line.includes('|'));
    assert.ok(proxy, `${name} lists the trusted proxy setting`);
    assert.match(proxy, /CIDR/, name);
    assert.match(proxy, /comma/i, name);
    assert.match(proxy, /IPv4/i, name);
    assert.match(proxy, /IPv6/i, name);
    assert.match(proxy, /\[\]|none|empty|no proxies/i, `${name} defaults to trusting no proxies`);
    assert.match(text, /X-Forwarded-For/i, name);
    const blocks = text.split(/\n\s*\n/).map(block => block.replace(/\s+/g, ' '));
    assert.ok(blocks.some(block => /passkey/i.test(block) && /sign[ -]?in|signed in/i.test(block)
      && /(?:10|ten)[ -]minutes?/i.test(block)), `${name} explains the ten-minute add-passkey requirement`);
    for (const subject of ['Fathom passkey added', 'Fathom account recovered']) assert.ok(text.includes(subject), `${name} lists ${subject}`);
    assert.ok(blocks.some(block => /recover/i.test(block) && /admin/i.test(block) && /notif|notice|email/i.test(block)),
      `${name} explains recovery notifications to admins`);
    assert.ok(blocks.some(block => /notif|notice/i.test(block) && /separate|individ|one recipient/i.test(block)),
      `${name} explains separate security mail recipients`);
  }
  assert.match(doc, /signed_in_at/, 'architecture documents the stored sign-in timestamp');
  assert.match(doc, /recent_signin_required/, 'architecture documents the stable stale-registration code');
  assert.ok(doc.split(/\n\s*\n/).some(block => /notice|notification/i.test(block) && /email_sends/.test(block)),
    'architecture distinguishes direct security notices from financial email bookkeeping');
});

test('account docs distinguish passkey revocation from user removal and say bootstrap sends before printing', () => {
  for (const [name, text] of [['architecture.md', doc], ['README.md', readme]]) {
    const blocks = text.split(/\n\s*\n/).map(block => block.replace(/\s+/g, ' '));
    assert.ok(blocks.some(block => /passkey/i.test(block) && /revok|revoc/i.test(block) && /MCP/i.test(block)
      && /remain|stay|leav|keep|unaffected|does not revoke|not revoked|do not revoke/i.test(block)),
      `${name} explicitly says MCP keys survive passkey revocation`);
    assert.ok(blocks.some(block => /remov/i.test(block) && /MCP/i.test(block) && /revok|delet/i.test(block)
      && /creat|own/i.test(block)), `${name} says removing a user revokes the keys they own`);
    assert.ok(blocks.some(block => /bootstrap|user:invite|user-invite\.mjs/i.test(block) && /email|send|sent/i.test(block)
      && /print/i.test(block) && /after|before|success/i.test(block)), `${name} says bootstrap emails before printing its link`);
  }
});

test('account docs describe add-a-device passkey links', () => {
  assert.match(doc, /add-passkey/, 'architecture names the add-passkey token purpose');
  assert.ok(doc.split('\n').some(line => line.includes('/api/auth/passkeys/link') && line.includes('POST')),
    'architecture lists POST /api/auth/passkeys/link');
  const blocks = readme.split(/\n\s*\n/).map(block => block.replace(/\s+/g, ' '));
  assert.ok(blocks.some(block => /another device/i.test(block) && /passkey/i.test(block)),
    'README explains adding a passkey on another device');
});
