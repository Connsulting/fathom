// Auth email structure (src/auth/mail.mjs): three link emails (invite, recovery, add-passkey) and
// two security notices (passkey added, account recovered). One table-based layout; link emails
// carry exactly one URL, the link; notices carry none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authLinkMail, passkeyAddedMail, accountRecoveredMail } from '../src/auth/mail.mjs';
import * as service from '../src/auth/service.mjs';

const PUBLIC_URL = 'https://fathom.example.test';
const config = { publicUrl: PUBLIC_URL };
const user = { email: 'owner@example.test' };
const HOSTILE = `<script>alert("x")</script> & 'q'`;
const SUBJECTS = {
  invite: 'Your Fathom invitation',
  recovery: 'Your Fathom recovery link',
  'add-passkey': 'Add a Fathom passkey on another device',
};

const newToken = () => randomBytes(32).toString('base64url');
const urls = s => s.match(/https?:\/\/[^\s"'<>]+/g) || [];
const visible = html => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&#x2F;|&#47;/gi, '/').replace(/&amp;/g, '&');
const anchors = html => [...html.matchAll(/<a\b[^>]*>/gi)].map(m => m[0]);
const hrefs = html => [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)].map(m => m[2]);

function layout(html, name) {
  assert.equal(typeof html, 'string', name);
  assert.match(html, /<table\b[^>]*\brole\s*=\s*["']presentation["']/i, `${name}: presentation tables`);
  assert.match(html, /560px/, `${name}: 560px max width`);
  assert.match(html, /style\s*=\s*["'][^"']*:/i, `${name}: inline styles`);
  assert.match(visible(html), /fathom/i, `${name}: wordmark`);
  assert.match(html, /<h[1-6][\s>]/i, `${name}: a heading`);
  for (const banned of [/<img\b/i, /<script\b/i, /<svg\b/i, /<link\b/i, /@import/i, /<iframe\b/i, /<form\b/i]) {
    assert.doesNotMatch(html, banned, `${name}: ${banned}`);
  }
}

for (const purpose of Object.keys(SUBJECTS)) {
  test(`${purpose} link email: subject, recipient, one button to the exact link, fallback text and footer`, () => {
    const token = newToken();
    const out = authLinkMail(config, user, token, purpose);
    const link = `${PUBLIC_URL}/enroll#${token}`;
    assert.equal(out.link, link);
    assert.deepEqual(Object.keys(out.message).sort(), ['html', 'subject', 'text', 'to']);
    const { to, subject, text, html } = out.message;
    assert.equal(to, user.email);
    assert.equal(subject, SUBJECTS[purpose]);
    layout(html, purpose);

    const links = anchors(html);
    assert.equal(links.length, 1, 'one button anchor');
    assert.deepEqual(hrefs(links[0]), [link], 'the button href is exactly the link');
    assert.ok(hrefs(html).every(value => value === link), 'no other href');
    assert.ok(visible(html).includes(link), 'the exact link is visible as fallback text');
    assert.ok(urls(html).length >= 2, 'button and fallback both carry the link');
    assert.deepEqual([...new Set(urls(html))], [link], 'html carries no URL but the link');
    assert.match(visible(html), /once/i);
    assert.match(visible(html), /expires? in 20 minutes/i);
    assert.match(visible(html), /did not ask/i);

    assert.equal(typeof text, 'string');
    assert.ok(text.includes(link), 'text carries the link');
    assert.deepEqual([...new Set(urls(text))], [link], 'text carries no URL but the link');
    assert.match(text, /once/i);
    assert.match(text, /expires? in 20 minutes/i);
    assert.match(text, /did not ask/i);
    assert.doesNotMatch(text, /<[a-z][^>]*>/i, 'the text part has no markup');
  });
}

test('link emails differ by purpose and never mix their subjects', () => {
  const token = newToken();
  const bodies = Object.keys(SUBJECTS).map(purpose => authLinkMail(config, user, token, purpose).message);
  assert.equal(new Set(bodies.map(m => m.subject)).size, 3);
  assert.equal(new Set(bodies.map(m => m.html)).size, 3);
  assert.equal(new Set(bodies.map(m => m.text)).size, 3);
  assert.match(bodies[2].text, /another device/i, 'the add-passkey email says what it is for');
  assert.match(bodies[1].text, /recover/i);
});

test('the link uses the configured public origin only', () => {
  const token = newToken();
  const out = authLinkMail({ publicUrl: 'http://localhost:4823' }, user, token, 'add-passkey');
  assert.equal(out.link, `http://localhost:4823/enroll#${token}`);
  assert.deepEqual([...new Set(urls(out.message.html))], [out.link]);
});

test('enrollmentMail is gone from the auth service', () => {
  assert.equal(service.enrollmentMail, undefined);
});

for (const [name, build, check] of [
  ['passkey added', () => passkeyAddedMail({ to: user.email, account: user.email, passkeyName: 'Synthetic phone' }), (all) => {
    assert.match(all, /Synthetic phone/);
    assert.match(all, /owner@example\.test/);
    assert.match(all, /passkey/i);
  }],
  ['account recovered', () => accountRecoveredMail({ to: user.email, account: user.email }), (all) => {
    assert.match(all, /recover/i);
    assert.match(all, /complet/i);
    assert.match(all, /new passkey/i);
    assert.match(all, /owner@example\.test/);
  }],
]) {
  test(`${name} notice: same layout, no button, no link and no URL`, () => {
    const out = build();
    assert.deepEqual(Object.keys(out).sort(), ['html', 'subject', 'text', 'to']);
    assert.equal(out.to, user.email);
    assert.equal(out.subject, name === 'passkey added' ? 'Fathom passkey added' : 'Fathom account recovered');
    layout(out.html, name);
    check(visible(out.html));
    check(out.text);
    for (const part of [out.subject, out.text, out.html]) {
      assert.doesNotMatch(part, /https?:\/\/|href\s*=|\/enroll|<a\b|www\./i, `${name}: no link of any kind`);
    }
  });
}

test('notices go to the given recipient while naming the account', () => {
  const out = accountRecoveredMail({ to: 'second-admin@example.test', account: user.email });
  assert.equal(out.to, 'second-admin@example.test');
  assert.match(out.text, /owner@example\.test/);
});

test('passkey names and account values are escaped in html and verbatim in text', () => {
  const entity = /&lt;script&gt;alert\((?:&quot;|&#34;|&#x22;)x(?:&quot;|&#34;|&#x22;)\)&lt;\/script&gt; &amp; (?:'|&#39;|&#x27;)q(?:'|&#39;|&#x27;)/i;
  const added = passkeyAddedMail({ to: user.email, account: user.email, passkeyName: HOSTILE });
  assert.doesNotMatch(added.html, /<script/i);
  assert.ok(!added.html.includes(HOSTILE));
  assert.ok(!added.html.includes('alert("x")'));
  assert.match(added.html, entity);
  assert.ok(added.text.includes(HOSTILE), 'the text part keeps the name verbatim');

  const account = `o'w"n<er>&@example.test`;
  for (const out of [
    passkeyAddedMail({ to: user.email, account, passkeyName: 'Synthetic phone' }),
    accountRecoveredMail({ to: user.email, account }),
  ]) {
    assert.ok(!out.html.includes(account));
    assert.ok(!out.html.includes('<er>'));
    assert.match(out.html, /&lt;er&gt;&amp;@example\.test/);
    assert.ok(out.text.includes(account));
  }
  const recovered = accountRecoveredMail({ to: user.email, account: HOSTILE });
  assert.doesNotMatch(recovered.html, /<script/i);
  assert.match(recovered.html, entity);
});
