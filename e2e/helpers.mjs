// Shared helpers for the Fathom end-to-end suite.
// Expected copy comes from demo/scenario.mjs at test time; amounts are never hard-coded.

import { test as base, expect } from '@playwright/test';
import scenario from '../demo/scenario.mjs';

export { expect };
export const S = scenario;

// True when the suite targets an already running server (smoke mode). Nothing local is
// created and read-only specs must not reset the target.
export const REMOTE = !!process.env.BASE_URL;

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// The Email screen's preview iframe is sandboxed (sandbox="" with srcdoc) on purpose, so Chromium
// logs this message when the init script below runs inside it. It is expected and harmless; only
// this exact message is ignored.
const SANDBOX_SCRIPT_BLOCKED = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.?$/;

// Every spec imports `test` from here. It fails the test on any console error, uncaught page
// error or CSP violation. Failed font loads are ignored so an offline runner can still pass;
// a font blocked by CSP is still reported through the securitypolicyviolation event.
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`securitypolicyviolation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile || ''}:${e.lineNumber || 0}`);
      });
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (SANDBOX_SCRIPT_BLOCKED.test(msg.text().trim())) return;
      const url = (msg.location() && msg.location().url) || '';
      if (/Failed to load resource/.test(msg.text()) && FONT_HOSTS.some((h) => url.startsWith(`https://${h}/`))) return;
      problems.push(`console error: ${msg.text()}${url ? ` (${url})` : ''}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await use(page);
    expect(problems, 'console errors, page errors or CSP violations').toEqual([]);
  }
});

// POST /api/demo/reset with a JSON content type. `baseURL` targets another server (January).
export async function resetDemo(request, baseURL) {
  const url = baseURL ? new URL('/api/demo/reset', baseURL).href : '/api/demo/reset';
  const res = await request.post(url, { headers: { 'content-type': 'application/json' }, data: {} });
  expect(res.status(), `POST ${url}`).toBe(200);
}

/* ---------- scenario oracle (independent of src/, mirrors CONTRACT.md) ---------- */

const OPEN_SOON = ['accepted', 'doing'];

// Live status at seed time: statusByDemo.november ?? status (pinned decision 3).
export function liveStatus(r) {
  return (r.statusByDemo && r.statusByDemo.november) || r.status;
}

export function visibleRecs() {
  return S.recs.filter((r) => liveStatus(r) !== 'hidden');
}

export function rec(id) {
  const r = S.recs.find((x) => x.id === id);
  if (!r) throw new Error(`no rec ${id} in demo/scenario.mjs`);
  return r;
}

// CONTRACT needsYou(): proposed, or accepted/doing with window.days <= 30; sorted by days.
export function needsYouIds() {
  return visibleRecs()
    .filter((r) => {
      const st = liveStatus(r);
      return st === 'proposed' || (OPEN_SOON.includes(st) && Number(r.window?.days ?? 9999) <= 30);
    })
    .map((r, i) => ({ id: r.id, d: Number(r.window?.days ?? 9999), i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.id);
}

function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function trimZeros(s) {
  return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
}

// Same formatting as the mock core's api.money.
export function money(n, o = {}) {
  n = Number(n);
  if (!Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  let body;
  if (o.k) {
    if (a >= 999500) body = '$' + trimZeros((a / 1e6).toFixed(2)) + 'M';
    else if (a >= 1e3) body = '$' + trimZeros((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'K';
    else body = '$' + Math.round(a);
  } else {
    body = '$' + commas(Math.round(a));
  }
  const zero = /^\$0(\.0+)?[KM]?$/.test(body);
  const sign = n < 0 && !zero ? '-' : (o.sign && n > 0 ? '+' : '');
  return sign + body;
}

// Same formatting as Horizon's usd() on the Engine screen (cents when the value has them).
export function usd(n) {
  n = Number(n);
  const [w, f] = (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)).split('.');
  return '$' + commas(w) + (f ? '.' + f : '');
}

// Resolve scenario tokens to plain text, the way api.txt() does.
export function plain(str) {
  return String(str ?? '').replace(/\{(f|fk|l|p|n):([A-Za-z0-9_]+)\}/g, (m, k, key) => {
    if (k === 'n') return S.names?.[key] ?? m;
    if (k === 'l') return S.law?.[key] != null ? money(S.law[key]) : m;
    if (k === 'p') return S.pct?.[key] != null ? `${S.pct[key]}%` : m;
    const f = S.fig?.[key];
    if (!f) return m;
    return money(f.v, { k: k === 'fk' });
  });
}

export function attentionHeadline() {
  return plain(S.verdict.attention.headline).replace(/\{count\}/g, String(needsYouIds().length));
}
export function clearHeadline() {
  return plain(S.verdict.clear.headline);
}

// An ask.suggested question whose refs name at least two visible recs. Asked as free text inside
// rec A's modal, its answer carries a ref link to rec B (see the summary for the pinned behavior).
export function crossRefPair() {
  const vis = new Set(visibleRecs().map((r) => r.id));
  for (const q of S.ask?.suggested || []) {
    const refs = (q.refs || []).filter((id) => vis.has(id));
    if (refs.length >= 2) return { a: refs[0], b: refs[1], q: plain(q.q) };
  }
  throw new Error('demo/scenario.mjs has no ask.suggested question with two visible refs');
}

/* ---------- page helpers ---------- */

export const recDialog = (page) => page.locator('.h-dlg[role="dialog"]');
export const mainNav = (page) => page.getByRole('navigation', { name: 'Main' });

export async function gotoRoute(page, route) {
  await page.goto(`/#/${route}`);
  await expect(page.locator('header.h-top')).toBeVisible();
}

export async function expectH1(page, text) {
  await expect(page.getByRole('heading', { level: 1, name: text, exact: true })).toBeVisible();
}

// Open a rec from a page link (in-app entry, pushes one history entry). `scope` is the list the
// link lives in: '.h-rows' on Plan, '.h-ny-list' on the brief.
export async function openRecFromPage(page, id, scope = '.h-rows') {
  await page.locator(`${scope} a[data-go="rec"][data-id="${id}"]`).first().click();
  await expect(recDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/rec/${id}$`));
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(plain(rec(id).title));
}

export async function closeDialogWithX(page) {
  await recDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(recDialog(page)).toHaveCount(0);
}

// The provenance popover for the figure just clicked shows the expected Source row.
export async function expectPopoverSource(page, label) {
  const pop = page.locator('.fx-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v')).toHaveText(label);
}

// Oracle note 2: walk text nodes (not elements); any text node with a bare dollar amount must sit
// inside .fx-fig, .fx-law, an svg axis tick (.h-sc-t) or the popover.
export async function bareDollarNodes(page) {
  return page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const where = (el) => {
      const parts = [];
      for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
        parts.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : ''));
      }
      return parts.join(' > ');
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\$[0-9]/.test(n.nodeValue)) continue;
      const el = n.parentElement;
      if (!el || el.closest('script, style, template')) continue;
      if (el.closest('.fx-fig, .fx-law, .h-sc-t, .fx-pop')) continue;
      out.push(`${n.nodeValue.trim().slice(0, 100)} @ ${where(el)}`);
    }
    return out;
  });
}

// Main routes with their h1 text (rec and per-pack routes are handled by the specs).
export function mainRoutes() {
  return [
    ['brief', attentionHeadline()],
    ['plan', 'Everything on the calendar'],
    ['ask', 'Ask about your money'],
    ['wargame', 'What is open, and what is coming'],
    ['wargame/salary', plain(S.wargame.salary.title)],
    ['wargame/deferral', plain(S.wargame.deferral.title)],
    ['goals', 'Where you are headed'],
    ['accounts', 'Read-only mirror'],
    ['advisor', plain(S.advisor.name)],
    ['yearend', 'The packet for your accountant'],
    ['connect', 'Bring your own AI'],
    ['engine', 'Running'],
    ['email', 'Monthly digest'],
    ['packs', 'What Fathom knows']
  ];
}
