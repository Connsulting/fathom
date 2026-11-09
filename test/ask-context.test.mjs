// Ask everywhere, the pure context module (web/horizon/screens/ask-context.js): the page chip
// descriptor for every route, the details a screen publishes about its view (month, range, owner,
// dates, filters, an open item) as label text and the wire qualifier q, the wire payload (kind and
// id, with `@q` when the chip has one), the one chip markup and the shared Ask about button.
// Synthetic data only; no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, MAX_REFS, routeContext, refKey, chipPayload, chipHtml, addButtonHtml } from '../web/horizon/screens/ask-context.js';

const ALL_KINDS = ['account', 'transaction', 'rec', 'step', 'goal', 'figure', 'pnl', 'spending', 'confirm', 'money', 'pack', 'page'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Synthetic token resolver: names only. A figure token would never reach a label.
const txt = (s) => String(s ?? '').replace(/\{n:spouse\}/g, 'Partner').replace(/\{n:biz\}/g, 'Studio LLC');

// Figure values that sit beside the names and titles in the synthetic data; no label may carry them.
const FIG_VALUES = ['48213', '48,213', '7391', '7,391', '615.27'];

const ctx = {
  txt,
  accounts: [
    { id: 'acc_plain', name: 'Studio checking', displayName: null, imported: true, balance: 48213.55 },
    { id: 'acc_token', name: '{n:spouse} savings', displayName: null, imported: false, balance: 7391 },
    { id: 'acc_renamed', name: 'Renamed {n:spouse} fund', displayName: 'Renamed {n:spouse} fund', imported: false, balance: 615.27 },
    { id: 'acc_import', name: 'Upload {n:biz} card', displayName: null, imported: true, balance: 48213 },
  ],
  recs: [
    { id: 'rec_open', title: 'Elect {n:spouse} benefits', status: 'proposed', value: [{ text: 'About 7,391 saved' }] },
    { id: 'rec_hidden', title: 'Hidden synthetic item', status: 'hidden' },
  ],
  packs: [{ id: 'pk_one', name: '{n:spouse} pack', size: 48213 }],
  confirm: null,
};

const route = (name, params) => (params ? { name, params } : { name });
const desc = (name, kind, id, label, q = '') => ({ route: name, kind, id, title: label.split(' > ').at(-1), label, q });

/* ---------- constants ---------- */

test('KINDS is the frozen list of reference kinds, pnl and spending included', () => {
  assert.deepEqual([...KINDS], ALL_KINDS);
  assert.ok(Object.isFrozen(KINDS));
  assert.ok(KINDS.includes('pnl') && KINDS.includes('spending'));
  assert.equal(MAX_REFS, 8);
});

test('refKey joins kind and id with a colon', () => {
  assert.equal(refKey({ kind: 'rec', id: 'rec_open' }), 'rec:rec_open');
  assert.equal(refKey({ kind: 'confirm', id: 'group:account_owner' }), 'confirm:group:account_owner');
  assert.equal(refKey({ kind: 'step', id: 'rec_open:2' }), 'step:rec_open:2');
});

test('refKey ignores the q qualifier', () => {
  assert.equal(refKey({ kind: 'pnl', id: 'entity:studio', q: 'month=2026-03' }), 'pnl:entity:studio');
  assert.equal(refKey({ kind: 'money', id: 'overview', q: 'range=1Y' }), refKey({ kind: 'money', id: 'overview', q: 'range=3M' }));
  assert.equal(refKey({ kind: 'page', id: 'home', q: '' }), 'page:home');
});

/* ---------- routeContext: the table ---------- */

test('routeContext: page routes under Home, Plan, Ask, Money and Settings', () => {
  const rows = [
    [route('home'), desc('home', 'page', 'home', 'Home')],
    [route('pace'), desc('pace', 'page', 'pace', 'Home > Pace')],
    [route('brief'), desc('brief', 'page', 'brief', 'Home > Brief')],
    [route('goals'), desc('goals', 'page', 'goals', 'Home > Goals')],
    [route('plan'), desc('plan', 'page', 'plan', 'Plan')],
    [route('yearend'), desc('yearend', 'page', 'yearend', 'Plan > Year end')],
    [route('advisor'), desc('advisor', 'page', 'advisor', 'Plan > Advisor')],
    [route('wargame'), desc('wargame', 'page', 'wargame', 'Ask > What-if')],
    [route('wargame', { id: 'salary' }), desc('wargame', 'page', 'wargame', 'Ask > What-if')],
    [route('money'), desc('money', 'money', 'overview', 'Money > Overview')],
    [route('accounts'), desc('accounts', 'money', 'accounts', 'Money > Accounts')],
    [route('add'), desc('add', 'page', 'add', 'Money > Files')],
    [route('settings'), desc('settings', 'page', 'settings', 'Settings')],
    [route('connect'), desc('connect', 'page', 'connect', 'Settings > Connect')],
    [route('engine'), desc('engine', 'page', 'engine', 'Settings > Engine')],
    [route('email'), desc('email', 'page', 'email', 'Settings > Email')],
    [route('onboarding'), desc('onboarding', 'page', 'onboarding', 'Setup')],
  ];
  for (const [r, want] of rows) {
    assert.deepEqual(routeContext(r, ctx), want, `${r.name} ${JSON.stringify(r.params || {})}`);
  }
});

test('routeContext: the Ask page has no page chip', () => {
  assert.equal(routeContext(route('ask'), ctx), null);
  assert.equal(routeContext(route('ask', { id: '0123456789ab' }), ctx), null);
});

test('routeContext: an unknown route falls back to Home', () => {
  assert.deepEqual(routeContext(route('nowhere'), ctx), desc('nowhere', 'page', 'home', 'Home'));
});

test('routeContext: an account dialog names the account by the account.js display rule', () => {
  // Not imported and no display name: tokens resolve through txt.
  assert.deepEqual(routeContext(route('account', { id: 'acc_token' }), ctx), desc('account', 'account', 'acc_token', 'Money > Partner savings'));
  // A display name is shown as is, never token-resolved.
  assert.deepEqual(routeContext(route('account', { id: 'acc_renamed' }), ctx),
    desc('account', 'account', 'acc_renamed', 'Money > Renamed {n:spouse} fund'));
  // Imported text is verbatim.
  assert.deepEqual(routeContext(route('account', { id: 'acc_import' }), ctx), desc('account', 'account', 'acc_import', 'Money > Upload {n:biz} card'));
  assert.deepEqual(routeContext(route('account', { id: 'acc_plain' }), ctx), desc('account', 'account', 'acc_plain', 'Money > Studio checking'));
});

test('routeContext: an unknown account falls back to Money > Accounts', () => {
  assert.deepEqual(routeContext(route('account', { id: 'acc_missing' }), ctx), desc('account', 'money', 'accounts', 'Money > Accounts'));
  assert.deepEqual(routeContext(route('account'), ctx), desc('account', 'money', 'accounts', 'Money > Accounts'));
});

test('routeContext: a visible rec names its title as plain text; hidden or missing falls back to Plan', () => {
  assert.deepEqual(routeContext(route('rec', { id: 'rec_open' }), ctx), desc('rec', 'rec', 'rec_open', 'Plan > Elect Partner benefits'));
  assert.deepEqual(routeContext(route('rec', { id: 'rec_hidden' }), ctx), desc('rec', 'page', 'plan', 'Plan'));
  assert.deepEqual(routeContext(route('rec', { id: 'rec_missing' }), ctx), desc('rec', 'page', 'plan', 'Plan'));
});

test('routeContext: Confirm with and without a current card, single and grouped', () => {
  assert.deepEqual(routeContext(route('confirm'), ctx), desc('confirm', 'page', 'confirm', 'Home > Confirm'));
  assert.deepEqual(routeContext(route('confirm'), { ...ctx, confirm: { id: '17', label: 'Account owner' } }),
    desc('confirm', 'confirm', '17', 'Confirm > Account owner'));
  assert.deepEqual(routeContext(route('confirm'), { ...ctx, confirm: { id: 'group:account_owner', label: 'Account owners' } }),
    desc('confirm', 'confirm', 'group:account_owner', 'Confirm > Account owners'));
});

test('routeContext: packs with a known id name the pack; no id or an unknown id is the Packs page', () => {
  assert.deepEqual(routeContext(route('packs', { id: 'pk_one' }), ctx), desc('packs', 'pack', 'pk_one', 'Ask > Partner pack'));
  assert.deepEqual(routeContext(route('packs'), ctx), desc('packs', 'page', 'packs', 'Ask > Packs'));
  assert.deepEqual(routeContext(route('packs', { id: 'pk_missing' }), ctx), desc('packs', 'page', 'packs', 'Ask > Packs'));
});

test('routeContext: missing lists and txt default to empty lists and identity', () => {
  assert.deepEqual(routeContext(route('account', { id: 'acc_token' }), {}), desc('account', 'money', 'accounts', 'Money > Accounts'));
  assert.deepEqual(routeContext(route('rec', { id: 'rec_open' }), {}), desc('rec', 'page', 'plan', 'Plan'));
  assert.deepEqual(routeContext(route('packs', { id: 'pk_one' }), {}), desc('packs', 'page', 'packs', 'Ask > Packs'));
  const noTxt = { ...ctx, txt: undefined };
  assert.deepEqual(routeContext(route('account', { id: 'acc_token' }), noTxt), desc('account', 'account', 'acc_token', 'Money > {n:spouse} savings'));
});

test('routeContext: labels never carry a figure value and title is the last label segment', () => {
  const routes = [
    route('home'), route('pace'), route('brief'), route('goals'), route('confirm'), route('plan'), route('yearend'),
    route('advisor'), route('wargame'), route('packs'), route('packs', { id: 'pk_one' }), route('money'), route('accounts'),
    route('add'), route('settings'), route('connect'), route('engine'), route('email'), route('onboarding'),
    route('rec', { id: 'rec_open' }), route('rec', { id: 'rec_hidden' }),
    ...ctx.accounts.map((a) => route('account', { id: a.id })),
  ];
  for (const r of routes) {
    const d = routeContext(r, ctx);
    assert.ok(d, `${r.name} has a descriptor`);
    assert.equal(typeof d.label, 'string');
    assert.ok(!d.label.startsWith('On:'), 'label is the chip text after "On: "');
    for (const v of FIG_VALUES) assert.ok(!d.label.includes(v), `${r.name}: label ${d.label} carries ${v}`);
    assert.equal(d.title, d.label.split(' > ').at(-1));
    assert.ok(KINDS.includes(d.kind));
  }
});

/* ---------- chipPayload: the only thing on the wire ---------- */

test('chipPayload keeps kind and id only and drops every other field', () => {
  const out = chipPayload([{ kind: 'rec', id: 'rec_open', label: 'Plan > Elect Partner benefits', route: 'rec', title: 'x', v: 7391 }]);
  assert.deepEqual(out, [{ kind: 'rec', id: 'rec_open' }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['id', 'kind']);
});

test('chipPayload dedupes by refKey keeping the first', () => {
  const out = chipPayload([
    { kind: 'account', id: 'acc_plain', label: 'First' },
    { kind: 'rec', id: 'acc_plain', label: 'Same id, other kind' },
    { kind: 'account', id: 'acc_plain', label: 'Second' },
  ]);
  assert.deepEqual(out, [{ kind: 'account', id: 'acc_plain' }, { kind: 'rec', id: 'acc_plain' }]);
});

test('chipPayload drops bad kinds, empty or long or non-string ids, and non-objects', () => {
  const long = 'x'.repeat(201);
  const edge = 'y'.repeat(200);
  const out = chipPayload([
    null, undefined, 'account:acc_plain', 42, [], true,
    { kind: 'bogus', id: 'a' },
    { kind: 'Account', id: 'a' },
    { kind: '', id: 'a' },
    { id: 'a' },
    { kind: 'account' },
    { kind: 'account', id: '' },
    { kind: 'account', id: long },
    { kind: 'account', id: 5 },
    { kind: 'account', id: null },
    { kind: 'account', id: edge },
    { kind: 'pnl', id: 'entity:studio' },
    { kind: 'spending', id: 'category:travel' },
  ]);
  assert.deepEqual(out, [{ kind: 'account', id: edge }, { kind: 'pnl', id: 'entity:studio' }, { kind: 'spending', id: 'category:travel' }]);
});

test('chipPayload caps at MAX_REFS, counting only kept unique entries', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'transaction', id: `t${i}`, label: `Row ${i}` }));
  const out = chipPayload(many);
  assert.equal(out.length, MAX_REFS);
  assert.deepEqual(out, many.slice(0, 8).map(({ kind, id }) => ({ kind, id })));
  const mixed = [many[0], { kind: 'bogus', id: 'z' }, many[0], null, ...many.slice(1)];
  assert.deepEqual(chipPayload(mixed), many.slice(0, 8).map(({ kind, id }) => ({ kind, id })));
});

test('chipPayload of a non-array is empty', () => {
  for (const v of [undefined, null, {}, 'account:acc_plain', 3, { kind: 'account', id: 'a' }]) {
    assert.deepEqual(chipPayload(v), [], JSON.stringify(v));
  }
  assert.deepEqual(chipPayload([]), []);
});

test('every kind survives chipPayload, pnl and spending included', () => {
  const list = ALL_KINDS.slice(0, 8).map((kind) => ({ kind, id: `${kind}_1` }));
  assert.deepEqual(chipPayload(list), list);
  const rest = ALL_KINDS.slice(8).map((kind) => ({ kind, id: `${kind}_1` }));
  assert.deepEqual(chipPayload(rest), rest);
});

/* ---------- chipHtml ---------- */

const NASTY = 'Tom & "Jerry" <b>bold</b> \'q\'';
const NASTY_ESC = esc(NASTY);

test('chipHtml renders one span chip with an escaped label and refKey', () => {
  const html = chipHtml({ kind: 'account', id: 'a"<1', label: NASTY }, { esc, removable: false });
  assert.match(html, /^<span class="h-ctx"/);
  assert.ok(html.endsWith('</span>'), html);
  assert.ok(html.includes(`data-ref="${esc('account:a"<1')}"`), html);
  assert.match(html, /<span class="h-ctx-l">/);
  assert.ok(html.includes(`On: ${NASTY_ESC}`), html);
  assert.ok(!html.includes('<b>'), 'label markup is escaped');
  assert.ok(!html.includes('a"<1'), 'raw id never appears');
  assert.ok(!html.includes('h-ctx-x'), 'no remove button when not removable');
  assert.ok(!html.includes('data-ctx-remove'), html);
  assert.ok(!html.includes('data-page'), html);
  assert.ok(!/<a\b/.test(html), 'no link without href');
});

test('chipHtml adds the remove button only when removable, with its aria-label', () => {
  const html = chipHtml({ kind: 'rec', id: 'r"1', label: NASTY }, { esc, removable: true });
  const btn = /<button\b[^>]*>/.exec(html);
  assert.ok(btn, html);
  assert.ok(btn[0].includes('type="button"'), btn[0]);
  assert.match(btn[0], /class="h-ctx-x"/);
  assert.ok(btn[0].includes(`data-ctx-remove="${esc('rec:r"1')}"`), btn[0]);
  assert.ok(btn[0].includes(`aria-label="Remove ${NASTY_ESC} from context"`), btn[0]);
  assert.equal((html.match(/<button\b/g) || []).length, 1);
  assert.ok(!html.includes('<b>'));
});

test('chipHtml marks the page chip with data-page', () => {
  const html = chipHtml({ kind: 'money', id: 'overview', label: 'Money > Overview' }, { esc, removable: true, page: true });
  const open = /^<span\b[^>]*>/.exec(html)[0];
  assert.ok(open.includes('data-page="1"'), open);
  assert.ok(open.includes('data-ref="money:overview"'), open);
  assert.ok(html.includes('On: Money &gt; Overview'), html);
});

test('chipHtml renders the label as a link when href is given, passing data-go, data-id and the caller class', () => {
  const html = chipHtml({ kind: 'rec', id: 'rec_open', label: 'Elect & enroll' },
    { esc, removable: false, href: '#/rec/rec_open', go: 'rec', id: 'rec_open', cls: 'h-askx-ctx' });
  const a = /<a\b[^>]*>/.exec(html);
  assert.ok(a, html);
  assert.match(a[0], /class="[^"]*\bh-ctx-l\b[^"]*"/);
  assert.match(a[0], /class="[^"]*\bh-askx-ctx\b[^"]*"/);
  assert.ok(a[0].includes('href="#/rec/rec_open"'), a[0]);
  assert.ok(a[0].includes('data-go="rec"'), a[0]);
  assert.ok(a[0].includes('data-id="rec_open"'), a[0]);
  assert.ok(html.includes('Elect &amp; enroll'), html);
  assert.ok(html.includes('</a>'), html);
  assert.ok(!html.includes('<span class="h-ctx-l">'), 'the label is the link, not a span');
  assert.ok(!html.includes('h-ctx-x'), html);
});

/* ---------- addButtonHtml ---------- */

test('addButtonHtml is one escaped button carrying kind, id and label, named Ask about <label>', () => {
  const html = addButtonHtml('account', 'a"<1', NASTY, esc);
  const open = /^<button\b[^>]*>/.exec(html);
  assert.ok(open, html);
  const tag = open[0];
  assert.ok(tag.includes('type="button"'), tag);
  assert.match(tag, /class="h-add"/);
  assert.ok(tag.includes('data-ctx-add="account"'), tag);
  assert.ok(tag.includes(`data-ctx-id="${esc('a"<1')}"`), tag);
  assert.ok(tag.includes(`data-ctx-label="${NASTY_ESC}"`), tag);
  assert.ok(tag.includes(`aria-label="Ask about ${NASTY_ESC}"`), tag);
  assert.ok(tag.includes(`title="Ask about ${NASTY_ESC}"`), tag);
  assert.ok(!html.includes('to chat'), 'the old Add to chat wording is gone');
  assert.match(html, /<svg\b[\s\S]*<\/svg>/);
  assert.ok(html.endsWith('</button>'), html);
  assert.ok(!html.includes('<b>'), 'label markup is escaped');
  assert.equal((html.match(/<button\b/g) || []).length, 1);
});

test('addButtonHtml aria-label and title are the same text', () => {
  const html = addButtonHtml('goal', 'g1', 'Synthetic reserve', esc);
  const aria = /aria-label="([^"]*)"/.exec(html)[1];
  const title = /title="([^"]*)"/.exec(html)[1];
  assert.equal(aria, 'Ask about Synthetic reserve');
  assert.equal(title, aria);
});

test('addButtonHtml draws a chat bubble with a plus as a stroked 16px h-i icon', () => {
  const html = addButtonHtml('rec', 'rec_open', 'Synthetic item', esc);
  const svg = /<svg\b[^>]*>/.exec(html);
  assert.ok(svg, html);
  assert.match(svg[0], /class="h-i"/);
  assert.match(svg[0], /viewBox="0 0 16 16"/);
  assert.match(svg[0], /width="16"/);
  assert.match(svg[0], /height="16"/);
  assert.match(svg[0], /aria-hidden="true"/);
  const paths = [...html.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 2, `a bubble path and a plus path: ${html}`);
  const [bubble, plus] = paths;
  assert.match(bubble, /^M[\s\S]*z$/i, 'the bubble is one closed outline');
  assert.match(bubble, /[aA]/, 'with rounded corners');
  assert.match(plus, /^M8 [\d.]+v[\d.]+M[\d.]+ [\d.]+h[\d.]+$/, 'the plus is one vertical and one horizontal stroke centered at x 8');
  assert.ok(!html.includes('M8 3.5v9M3.5 8h9'), 'not the old bare plus');
  assert.ok(!/fill="(?!none)/.test(html), 'stroked, no fill');
});

test('addButtonHtml works for every kind', () => {
  for (const kind of ALL_KINDS) {
    const html = addButtonHtml(kind, `${kind}_1`, 'Synthetic item', esc);
    assert.ok(html.includes(`data-ctx-add="${kind}"`), kind);
    assert.ok(html.includes(`data-ctx-id="${kind}_1"`), kind);
  }
});

test('routeContext: the P&L route names the page and then the entity on screen (view.pnl), else the P&L page', () => {
  assert.deepEqual(routeContext({ name: 'pnl', params: {} }, { view: { pnl: { id: 'entity:bluestemveterinaryrelief', label: 'Bluestem Veterinary Relief' } } }),
    { route: 'pnl', kind: 'pnl', id: 'entity:bluestemveterinaryrelief', title: 'Bluestem Veterinary Relief', label: 'Money > P&L > Bluestem Veterinary Relief', q: '' });
  assert.deepEqual(routeContext({ name: 'pnl', params: {} }, { view: { pnl: null } }),
    { route: 'pnl', kind: 'page', id: 'pnl', title: 'P&L', label: 'Money > P&L', q: '' });
  assert.deepEqual(routeContext({ name: 'pnl', params: {} }, {}),
    { route: 'pnl', kind: 'page', id: 'pnl', title: 'P&L', label: 'Money > P&L', q: '' });
});

/* ---------- routeContext: the view a screen publishes ---------- */

// The chip without route and title: what the panel shows and sends.
const shown = (r, view, extra = {}) => {
  const d = routeContext(r, { ...ctx, ...extra, view });
  return d && { kind: d.kind, id: d.id, label: d.label, q: d.q };
};

test('routeContext view: a P&L entity with a selected month names the month and qualifies the id', () => {
  assert.deepEqual(shown(route('pnl'), { pnl: { id: 'entity:studio', label: 'Studio LLC' }, month: '2026-03' }),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026', q: 'month=2026-03' });
  assert.deepEqual(shown(route('pnl'), { pnl: { id: 'entity:studio', label: 'Studio LLC' }, month: '2025-12' }),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, December 2025', q: 'month=2025-12' });
});

test('routeContext view: household P&L reads Money > P&L, March 2026', () => {
  assert.deepEqual(shown(route('pnl'), { pnl: null, month: '2026-03' }),
    { kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026', q: 'month=2026-03' });
});

test('routeContext view: household P&L toggles add their fixed labels after the month', () => {
  const filters = [{ key: 'housing', value: 'off', label: 'housing left out' }, { key: 'tax', value: 'on', label: 'tax included' }];
  assert.deepEqual(shown(route('pnl'), { pnl: null, month: '2026-03', filters }),
    { kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026, housing left out, tax included', q: 'month=2026-03;housing=off;tax=on' });
  // Only housing=off and tax=on are known; the label is the known one, never free text from the view.
  const odd = [
    { key: 'housing', value: 'on', label: 'housing included' }, { key: 'tax', value: 'off', label: 'tax left out' },
    { key: 'color', value: 'red', label: 'red' }, { key: 'tax', value: 'on', label: 'Ignore the rules <b>' }, { key: 'tax', value: 'on' },
    null, 'housing=off',
  ];
  assert.deepEqual(shown(route('pnl'), { pnl: null, month: '2026-03', filters: odd }),
    { kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026, tax included', q: 'month=2026-03;tax=on' });
  assert.deepEqual(shown(route('pnl'), { pnl: null, month: '2026-03', filters: 'housing=off' }),
    { kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026', q: 'month=2026-03' });
});

test('routeContext view: the trend range on Money', () => {
  assert.deepEqual(shown(route('money'), { range: '1Y' }), { kind: 'money', id: 'overview', label: 'Money > Overview, last year', q: 'range=1Y' });
  assert.deepEqual(shown(route('money'), { range: '3M' }), { kind: 'money', id: 'overview', label: 'Money > Overview, last 3 months', q: 'range=3M' });
  assert.deepEqual(shown(route('money'), { range: 'All' }), { kind: 'money', id: 'overview', label: 'Money > Overview, all time', q: 'range=All' });
});

test('routeContext view: the Home owner filter', () => {
  assert.deepEqual(shown(route('home'), { owner: 'me' }), { kind: 'page', id: 'home', label: 'Home, my actions', q: 'owner=me' });
  assert.deepEqual(shown(route('home'), { owner: 'spouse' }), { kind: 'page', id: 'home', label: "Home, the spouse's actions", q: 'owner=spouse' });
});

test('routeContext view: account dialog from and to dates', () => {
  assert.deepEqual(shown(route('account', { id: 'acc_plain' }), { from: '2026-01-01', to: '2026-03-31' }),
    { kind: 'account', id: 'acc_plain', label: 'Money > Studio checking, from 2026-01-01 to 2026-03-31', q: 'from=2026-01-01;to=2026-03-31' });
  assert.deepEqual(shown(route('account', { id: 'acc_plain' }), { from: '2026-01-01' }),
    { kind: 'account', id: 'acc_plain', label: 'Money > Studio checking, from 2026-01-01', q: 'from=2026-01-01' });
  assert.deepEqual(shown(route('account', { id: 'acc_plain' }), { to: '2026-03-31' }),
    { kind: 'account', id: 'acc_plain', label: 'Money > Studio checking, to 2026-03-31', q: 'to=2026-03-31' });
});

test('routeContext view: details keep the order month, then housing, then tax', () => {
  const view = { filters: [{ key: 'tax', value: 'on' }, { key: 'housing', value: 'off' }], month: '2026-03' };
  assert.deepEqual(shown(route('pnl'), view), {
    kind: 'page', id: 'pnl', label: 'Money > P&L, March 2026, housing left out, tax included', q: 'month=2026-03;housing=off;tax=on',
  });
});

test('routeContext view: each route keeps only the view fields it owns', () => {
  const all = {
    pnl: { id: 'entity:studio', label: 'Studio LLC' }, month: '2026-03', range: '3M', owner: 'me', from: '2026-01-01', to: '2026-03-31',
    filters: [{ key: 'housing', value: 'off' }], item: { kind: 'goal', id: 'g_synth', label: 'Synthetic reserve' },
  };
  assert.deepEqual(shown(route('money'), all), { kind: 'money', id: 'overview', label: 'Money > Overview, last 3 months', q: 'range=3M' });
  assert.deepEqual(shown(route('pnl'), all),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026, housing left out', q: 'month=2026-03;housing=off' });
  // The P&L rows dialog sits over the P&L and keeps its fields.
  assert.deepEqual(shown(route('pnlrows'), all),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026, housing left out', q: 'month=2026-03;housing=off' });
  assert.deepEqual(shown(route('pnl'), { ...all, filters: [{ key: 'type', value: 'income' }] }),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026, income only', q: 'month=2026-03;type=income' });
  assert.deepEqual(shown(route('pnl'), { ...all, filters: [{ key: 'type', value: 'all' }] }),
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026', q: 'month=2026-03' });
  assert.deepEqual(shown(route('home'), all), { kind: 'page', id: 'home', label: 'Home, my actions', q: 'owner=me' });
  assert.deepEqual(shown(route('goals'), all), { kind: 'goal', id: 'g_synth', label: 'Home > Goals > Synthetic reserve', q: '' });
  // The account dialog over Money: the trend range of the page beneath is not the dialog's.
  assert.deepEqual(shown(route('account', { id: 'acc_plain' }), all),
    { kind: 'account', id: 'acc_plain', label: 'Money > Studio checking, from 2026-01-01 to 2026-03-31', q: 'from=2026-01-01;to=2026-03-31' });
  assert.deepEqual(shown(route('account', { id: 'acc_plain' }), { range: '1Y' }),
    { kind: 'account', id: 'acc_plain', label: 'Money > Studio checking', q: '' });
  // Every other route ignores the view.
  for (const r of [route('accounts'), route('plan'), route('pace'), route('rec', { id: 'rec_open' }), route('packs'), route('settings'), route('confirm'), route('nowhere')]) {
    const plain = routeContext(r, ctx);
    assert.deepEqual(routeContext(r, { ...ctx, view: all }), plain, r.name);
    assert.equal(plain.q, '', r.name);
  }
});

test('routeContext view: an open goal form names the goal under the page', () => {
  assert.deepEqual(shown(route('goals'), { item: { kind: 'goal', id: 'g_synth', label: 'Synthetic reserve' } }),
    { kind: 'goal', id: 'g_synth', label: 'Home > Goals > Synthetic reserve', q: '' });
  // Only goal items; one without an id or label is the page.
  assert.deepEqual(shown(route('goals'), { item: { kind: 'rec', id: 'rec_open', label: 'x' } }), { kind: 'page', id: 'goals', label: 'Home > Goals', q: '' });
  assert.deepEqual(shown(route('goals'), { item: { kind: 'goal', id: '', label: 'x' } }), { kind: 'page', id: 'goals', label: 'Home > Goals', q: '' });
  assert.deepEqual(shown(route('goals'), { item: { kind: 'goal', label: 'x' } }), { kind: 'page', id: 'goals', label: 'Home > Goals', q: '' });
  assert.deepEqual(shown(route('goals'), { item: 'goal:g_synth' }), { kind: 'page', id: 'goals', label: 'Home > Goals', q: '' });
});

test('routeContext view: invalid values are dropped from the label and the qualifier', () => {
  const bad = [
    { month: '2026-13' }, { month: '2026-00' }, { month: '2026-3' }, { month: 'March' }, { month: 202603 }, { month: '2026-03-01' },
    { range: '6M' }, { range: '1y' }, { range: 'all' }, { range: 12 },
    { owner: 'both' }, { owner: 'Me' }, { owner: 'everyone' },
    { from: '2026-1-1' }, { from: 'yesterday' }, { to: '2026-03-31T00:00' }, { to: 20260331 },
    { filters: [{ key: 'housing', value: 'off;tax=on' }] },
    { pnl: { id: '', label: 'Empty' } },
  ];
  for (const view of bad) {
    const d = shown(route('pnl'), view);
    assert.deepEqual(d, { kind: 'page', id: 'pnl', label: 'Money > P&L', q: '' }, JSON.stringify(view));
  }
  for (const view of [null, undefined, 'month=2026-03', 7, []]) {
    assert.deepEqual(shown(route('money'), view), { kind: 'money', id: 'overview', label: 'Money > Overview', q: '' }, String(view));
  }
  // A good value next to a bad one is kept.
  assert.deepEqual(shown(route('money'), { range: '1Y', month: '2026-13', owner: 'both' }),
    { kind: 'money', id: 'overview', label: 'Money > Overview, last year', q: 'range=1Y' });
});

test('routeContext view: the Ask page still has no page chip', () => {
  assert.equal(routeContext(route('ask'), { ...ctx, view: { range: '1Y', month: '2026-03' } }), null);
});

/* ---------- chipPayload: the qualifier ---------- */

test('chipPayload appends @q to the id when the chip has a nonempty q', () => {
  assert.deepEqual(chipPayload([
    { kind: 'pnl', id: 'entity:studio', label: 'Money > P&L > Studio LLC, March 2026', q: 'month=2026-03' },
    { kind: 'money', id: 'overview', q: 'range=1Y' },
    { kind: 'page', id: 'home', q: '' },
    { kind: 'account', id: 'acc_plain', q: 7 },
    { kind: 'rec', id: 'rec_open' },
  ]), [
    { kind: 'pnl', id: 'entity:studio@month=2026-03' },
    { kind: 'money', id: 'overview@range=1Y' },
    { kind: 'page', id: 'home' },
    { kind: 'account', id: 'acc_plain' },
    { kind: 'rec', id: 'rec_open' },
  ]);
});

test('chipPayload drops q when the qualified id would pass 200 characters', () => {
  const q = 'month=2026-03';
  const fits = 'x'.repeat(200 - q.length - 1);
  const over = 'y'.repeat(200 - q.length);
  assert.deepEqual(chipPayload([{ kind: 'account', id: fits, q }]), [{ kind: 'account', id: `${fits}@${q}` }]);
  assert.equal(`${fits}@${q}`.length, 200);
  assert.deepEqual(chipPayload([{ kind: 'account', id: over, q }]), [{ kind: 'account', id: over }]);
});

test('chipPayload dedupes by refKey whatever the qualifier', () => {
  assert.deepEqual(chipPayload([
    { kind: 'money', id: 'overview', q: 'range=1Y' },
    { kind: 'money', id: 'overview', q: 'range=3M' },
    { kind: 'money', id: 'overview' },
  ]), [{ kind: 'money', id: 'overview@range=1Y' }]);
});
