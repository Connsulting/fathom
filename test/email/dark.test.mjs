// Every HTML email Fathom sends is dark, whatever the mail client's own theme: the monthly brief,
// the deadline alert, the three auth link emails, the two security notices and the test email.
// Each is rendered with synthetic data and checked for the dark-only color-scheme metas, a dark
// body and wrapper, no light backgrounds, palette-only colors and WCAG AA contrast. The palette
// module (src/email/palette.mjs) is checked for AA on every text and background pair it declares.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import scenarioDemo from '../../demo/scenario.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { addDays } from '../../src/scenario/build.mjs';
import { buildBrief, renderBrief } from '../../src/email/brief.mjs';
import { dueAlerts, renderAlerts } from '../../src/jobs/alerts.mjs';
import { authLinkMail, passkeyAddedMail, accountRecoveredMail } from '../../src/auth/mail.mjs';
import { C, TEXT_PAIRS, simpleDarkEmail } from '../../src/email/palette.mjs';

const CLOCK = scenarioDemo.meta.clock;
const URL_BASE = 'https://fathom.example.invalid';
const PALETTE = new Set(Object.values(C).filter((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v)));

const channel = (n) => { const v = n / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function seeded(fn) {
  const t = await tempDb();
  try {
    seedDemo(t.db);
    return await fn(t.db);
  } finally {
    try { t.db.close(); } catch { /* closed */ }
    rmSync(t.dataDir, { recursive: true, force: true });
  }
}

// The dark contract every HTML email meets.
function assertDark(html, name) {
  assert.equal(typeof html, 'string', name);
  assert.ok(html.includes('<meta name="color-scheme" content="dark">'), `${name}: color-scheme meta`);
  assert.ok(html.includes('<meta name="supported-color-schemes" content="dark">'), `${name}: supported-color-schemes meta`);
  assert.ok(/:root\{[^}]*color-scheme:dark[;}]/.test(html), `${name}: color-scheme: dark on the root`);
  assert.ok(!/prefers-color-scheme|color-scheme[^;}"<>]*light/i.test(html), `${name}: no light scheme or light media query`);

  const body = /<body\b[^>]*>/.exec(html)?.[0] || '';
  assert.ok(body.includes(`bgcolor="${C.page}"`) && body.includes(`background-color:${C.page}`), `${name}: dark body background`);
  const first = /<table\b[^>]*>/.exec(html.slice(html.indexOf('<body')))?.[0] || '';
  assert.ok(/width="100%"/.test(first) && first.includes(`bgcolor="${C.page}"`), `${name}: full width dark wrapper table first`);

  // Every table and cell carries its surface twice (attribute and inline), from the palette.
  const surfaces = [...html.matchAll(/<(?:table|td)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(surfaces.length >= 3, `${name}: table layout`);
  for (const tag of surfaces) {
    const attr = /bgcolor="(#[0-9a-f]{6})"/.exec(tag);
    const inline = /style="[^"]*background-color:(#[0-9a-f]{6})/.exec(tag);
    assert.ok(attr && inline && attr[1] === inline[1], `${name}: bgcolor and inline background agree: ${tag.slice(0, 90)}`);
  }

  // No background anywhere is outside the palette or light; no white by any spelling.
  const backgrounds = [...html.matchAll(/(?:bgcolor="|background(?:-color)?:\s*)([^";}\s]+)/g)].map((m) => m[1].toLowerCase());
  assert.ok(backgrounds.length > 3, `${name}: backgrounds found`);
  for (const bg of backgrounds) {
    assert.ok(PALETTE.has(bg), `${name}: background ${bg} is a palette color`);
    assert.ok(bg !== '#ffffff' && bg !== '#fff' && luminance(bg) < 0.6, `${name}: background ${bg} is not light`);
  }
  assert.ok(!/#fff\b|#ffffff|\bwhite\b|rgb\(|hsl\(/i.test(html), `${name}: no white or functional color spelling`);

  // Every text color is a palette color; all but the dark ink read at AA on every dark surface.
  const surfaceSet = [C.page, C.card, C.tile];
  for (const m of html.matchAll(/(?:^|[^-\w])color:\s*(#[0-9a-f]{6})/g)) {
    assert.ok(PALETTE.has(m[1]), `${name}: text color ${m[1]} is a palette color`);
    if (m[1] === C.ink) continue; // dark ink sits only on the accent button, checked below
    for (const bg of surfaceSet) assert.ok(contrast(m[1], bg) >= 4.5, `${name}: ${m[1]} on ${bg} is ${contrast(m[1], bg).toFixed(2)}`);
  }
  if (html.includes(C.ink)) assert.ok(html.includes(`background-color:${C.accent};color:${C.ink}`), `${name}: dark ink only on the accent`);

  // Every element that sets text color also sets a font family or sits in a cell that does: no
  // element is left to the client's default (light-theme) text color. Anchors carry their own color.
  for (const a of html.matchAll(/<a\b[^>]*>/g)) assert.ok(/style="[^"]*color:#[0-9a-f]{6}/.test(a[0]), `${name}: link carries a color`);
}

test('the palette is Horizon dark and every declared text pair meets WCAG AA', () => {
  assert.equal(C.page, '#0a0c0d');
  assert.equal(C.card, '#101315');
  assert.equal(C.accent, '#3fcfae');
  for (const bg of [C.page, C.card, C.tile, C.line, C.line2]) assert.ok(luminance(bg) < 0.03, `${bg} is dark`);
  assert.ok(TEXT_PAIRS.length >= 10);
  for (const [fg, bg, label] of TEXT_PAIRS) {
    assert.ok(/^#[0-9a-f]{6}$/.test(fg) && /^#[0-9a-f]{6}$/.test(bg), label);
    assert.ok(contrast(fg, bg) >= 4.5, `${label}: ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}, needs 4.5`);
  }
  // Body text is well above AA, and the button ink is readable on the accent.
  assert.ok(contrast(C.text, C.card) >= 12);
  assert.ok(contrast(C.ink, C.accent) >= 7);
});

test('the monthly brief is dark', () => seeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  const { html } = renderBrief(model, { src: 'template', text: '' });
  assertDark(html, 'brief');
  assert.ok(html.includes('Open Fathom'), 'button');
  for (const word of ['Tax paid', 'Next deadline', 'To confirm', 'Needs you', 'Next 90 days']) assert.ok(html.includes(word), word);
}));

test('the monthly brief is dark without links and with no tiles', () => seeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const { html } = renderBrief({ ...model, tiles: { tax: null, next: null, confirm: null }, deadlines: [] }, { src: 'template', text: '' });
  assertDark(html, 'brief without links');
}));

test('the deadline alert is dark, with and without links', async () => {
  const t = await tempDb();
  try {
    const now = '2032-06-01T11:00:00.000Z';
    t.db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, ?, ?)').run(addDays('2032-06-01', 3), 'x', 'Synthetic deadline', null, 0);
    t.db.prepare(`INSERT INTO recs (id, def, status, tasks_done, window_close, window_label, sort, updated_at)
                  VALUES (?, ?, 'proposed', '[]', ?, ?, 0, ?)`).run('syn-rec', JSON.stringify({ id: 'syn-rec', title: 'Synthetic rec' }), addDays('2032-06-01', 5), 'By soon', now);
    const due = dueAlerts(t.db, { clock: '2032-06-01' });
    assert.equal(due.length, 2);
    for (const publicUrl of [URL_BASE, null]) {
      const { html } = renderAlerts(due, { clock: '2032-06-01', publicUrl });
      assertDark(html, `alert ${publicUrl ? 'with' : 'without'} links`);
      assert.ok(html.includes('Synthetic deadline'));
    }
  } finally {
    try { t.db.close(); } catch { /* closed */ }
    rmSync(t.dataDir, { recursive: true, force: true });
  }
});

test('the auth link emails are dark', () => {
  for (const purpose of ['invite', 'recovery', 'add-passkey']) {
    const { message } = authLinkMail({ publicUrl: URL_BASE }, { email: 'owner@example.test' }, 'tok_synthetic', purpose);
    assertDark(message.html, `auth ${purpose}`);
    assert.ok(message.html.includes(`background-color:${C.accent};color:${C.ink}`), `${purpose}: accent button`);
  }
});

test('the security notices are dark and carry no URL', () => {
  for (const [name, mail] of [
    ['passkey added', passkeyAddedMail({ to: 'owner@example.test', account: 'owner@example.test' })],
    ['account recovered', accountRecoveredMail({ to: 'owner@example.test', account: 'owner@example.test' })],
  ]) {
    assertDark(mail.html, name);
    assert.ok(!/https?:\/\//.test(mail.html), `${name}: no URL`);
    assert.ok(!/<a\b/i.test(mail.html), `${name}: no anchor`);
  }
});

test('the test email is dark', () => {
  const html = simpleDarkEmail({ title: 'Fathom test email', paragraphs: ['This is a test email from Fathom.', 'No household data is included.'] });
  assertDark(html, 'test email');
  assert.ok(html.includes('This is a test email from Fathom.'));
  assert.ok(simpleDarkEmail({ title: 'x', paragraphs: ['<b>&"'] }).includes('&lt;b&gt;&amp;&quot;'), 'escaped');
});
