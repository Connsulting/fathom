import test from 'node:test';
import assert from 'node:assert/strict';
import { afterSignIn, safeHash, safePath, signInTarget } from '../web/auth/return-path.js';
import { signInLocation } from '../src/api/identity.mjs';

test('a document GET redirects to sign-in and an API path does not', () => {
  assert.equal(signInLocation('/'), '/signin');
  assert.equal(signInLocation('/plan'), '/signin?next=' + encodeURIComponent('/plan'));
  assert.equal(signInLocation('/account'), '/signin?next=' + encodeURIComponent('/account'));
  assert.equal(signInLocation('/signin'), '/signin');
  assert.equal(signInTarget('/', '#/plan'), '/signin#/plan');
  assert.equal(signInTarget('/account', ''), '/signin?next=' + encodeURIComponent('/account'));
});

test('a fragment route or a same-origin path returns there, and hostile targets fall back to Home', () => {
  assert.equal(afterSignIn({ hash: '#/plan', href: 'http://localhost/signin#/plan' }), '/#/plan');
  assert.equal(afterSignIn({ hash: '#/rec/abc', href: 'http://localhost/signin#/rec/abc' }), '/#/rec/abc');
  assert.equal(afterSignIn({ hash: '', href: 'http://localhost/signin?next=' + encodeURIComponent('/account') }), '/account');
  assert.equal(afterSignIn({ hash: '#/plan', href: 'http://localhost/signin?next=' + encodeURIComponent('https://evil.example') + '#/plan' }), '/#/plan');
  assert.equal(afterSignIn({ hash: '', href: 'http://localhost/signin' }), '/#/home');
  for (const hostile of [
    'https://evil.example',
    'http://evil.example/phish',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/%5c%5cevil.example',
    '/evil.example%0d%0aLocation:%20https://evil.example',
    'javascript:alert(1)',
    '/signin/../\\evil',
    'https://localhost/signin?next=https://evil.example',
  ]) {
    assert.equal(safePath(hostile), null, hostile);
    assert.equal(afterSignIn({ hash: '', href: 'http://localhost/signin?next=' + encodeURIComponent(hostile) }), '/#/home', hostile);
  }
  assert.equal(safeHash('#/javascript:alert(1)'), null);
  assert.equal(safeHash('#//evil.example'), null);
  assert.equal(safeHash('#/plan/../../evil'), null);
  assert.equal(safeHash('https://evil.example'), null);
  assert.equal(safeHash('#/nope'), null);
});
