// Shared helpers for the Fathom end-to-end suite.
// Expected copy comes from demo/scenario.mjs at test time; amounts are never hard-coded.

import { test as base, expect } from '@playwright/test';
import scenario from '../demo/scenario.mjs';

export { expect };
export const S = scenario;

// True when the suite targets an already running server (smoke mode). Nothing local is
// created and read-only specs must not reset the target.
export const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

// Real-store smoke (FATHOM_SMOKE_TARGET=real). Default is the demo suite.
export const SMOKE_REAL = process.env.FATHOM_SMOKE_TARGET === 'real';

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// The Email screen's preview iframe is sandboxed (sandbox="" with srcdoc) on purpose, so Chromium
// logs this message when the init script below runs inside it. It is expected and harmless; only
// this exact message is ignored.
const SANDBOX_SCRIPT_BLOCKED = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.?$/;

// Abort a non-GET/HEAD request to the app origin and record it. Cross-origin requests,
// including font hosts, are left alone. Callers fail the test when `blocked` is non-empty.
export async function installWriteGuard(context, baseURL, blocked) {
  const origin = new URL(baseURL).origin;
  await context.route('**/*', async (route) => {
    const req = route.request();
    let url;
    try {
      url = new URL(req.url());
    } catch {
      await route.continue();
      return;
    }
    const method = req.method().toUpperCase();
    if (url.origin === origin && method !== 'GET' && method !== 'HEAD') {
      blocked.push(`${method} ${url.pathname}`);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
}

const FONT_URL = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

function noteFailedApi(page, origin, failed) {
  page.on('response', (res) => {
    let url;
    try { url = new URL(res.url()); } catch { return; }
    if (url.origin !== origin || res.status() < 400) return;
    if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
      failed.push(`${res.status()} ${res.request().method()} ${url.pathname}`);
    }
  });
}

// Every spec imports `test` from here. It fails the test on any console error, uncaught page
// error or CSP violation. Failed font loads are ignored so an offline runner can still pass;
// a font blocked by CSP is still reported through the securitypolicyviolation event.
export const test = base.extend({
  // Installed on the context so every page in every spec is covered in real mode, including a
  // spec added later. The browser context's route does not see Playwright's APIRequestContext.
  context: async ({ context, baseURL }, use) => {
    if (!SMOKE_REAL) {
      await use(context);
      return;
    }
    const blocked = [];
    const failed = [];
    const origin = new URL(baseURL).origin;
    await installWriteGuard(context, baseURL, blocked);
    await context.route(FONT_URL, (route) => route.fulfill({
      status: 200,
      body: '',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'text/css' }
    }));
    const attach = (page) => noteFailedApi(page, origin, failed);
    context.on('page', attach);
    for (const page of context.pages()) attach(page);
    await use(context);
    expect(blocked, 'real-mode smoke issued a write').toEqual([]);
    expect(failed, 'failed API request').toEqual([]);
  },
  request: async ({ request, baseURL }, use) => {
    if (!SMOKE_REAL) {
      await use(request);
      return;
    }
    const origin = new URL(baseURL).origin;
    const block = (method, url) => {
      const abs = new URL(typeof url === 'string' ? url : String(url), baseURL);
      if (abs.origin === origin && method !== 'GET' && method !== 'HEAD') {
        throw new Error(`real-mode smoke blocked ${method} ${abs.pathname}`);
      }
    };
    const wrapped = {
      post: (url, opts) => { block('POST', url); return request.post(url, opts); },
      put: (url, opts) => { block('PUT', url); return request.put(url, opts); },
      patch: (url, opts) => { block('PATCH', url); return request.patch(url, opts); },
      delete: (url, opts) => { block('DELETE', url); return request.delete(url, opts); },
      fetch: (url, opts = {}) => {
        const fromReq = url && typeof url === 'object' ? String(url.method || 'GET') : '';
        const method = (fromReq || String((opts && opts.method) || 'GET')).toUpperCase();
        const href = typeof url === 'string' ? url : String((url && url.url) || url);
        block(method, href);
        return request.fetch(url, opts);
      }
    };
    await use(new Proxy(request, {
      get(target, prop) {
        if (Object.prototype.hasOwnProperty.call(wrapped, prop)) return wrapped[prop];
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }));
  },
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
  if (REMOTE || SMOKE_REAL) throw new Error('Refusing to reset a supplied server');
  if (baseURL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
    throw new Error('Demo reset requires a local test server');
  }
  const url = baseURL ? new URL('/api/demo/reset', baseURL).href : '/api/demo/reset';
  const res = await request.post(url, { headers: { 'content-type': 'application/json' }, data: {} });
  expect(res.status(), `POST ${url}`).toBe(200);
}

/* ---------- scenario oracle (independent of src/, mirrors CONTRACT.md) ---------- */

const OPEN_SOON = ['doing'];

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

// CONTRACT needsYou(): proposed, or doing with window.days <= 30; sorted by days.
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
// link lives in: '.h-rows' on Plan, '.h-gnext' (a goal card's next action or a
// housekeeping row) on Home.
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

/* ---------- Ask conversations ---------- */

// The Ask empty state heading (#/ask, no conversation open).
export const ASK_HELLO = 'What do you want to know?';
// An open conversation's URL; group 1 is the thread id.
export const ASK_THREAD_URL = /#\/ask\/([a-f0-9]{12})$/;

// The Ask composer: the centered one in the empty state, the docked one in an open conversation.
export function askInput(page) {
  return page.locator('form.h-askx-compose textarea[name="q"]');
}

// Types a question into the Ask composer, sends it with Enter and waits for the Fathom reply.
// Returns the id of the conversation it landed in.
export async function askOnAsk(page, text) {
  const replies = page.locator('.h-thread .h-msg.fathom');
  const before = await replies.count();
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(replies).toHaveCount(before + 1);
  return ASK_THREAD_URL.exec(page.url())[1];
}

// GET /api/scenario as JSON.
export async function fetchScenario(request) {
  const res = await request.get('/api/scenario');
  expect(res.status(), 'GET /api/scenario').toBe(200);
  return res.json();
}

// Home and the pace board are headed by the pace rollup headline, which the server computes.
export async function paceHeadline(request) {
  return (await fetchScenario(request)).pace.rollup.headline;
}

// A mainRoutes heading is a string, or an async function of the request fixture for headings
// that come from the API.
export async function headingFor(heading, request) {
  return typeof heading === 'function' ? heading(request) : heading;
}

// Main routes with their h1 text (rec and per-pack routes are handled by the specs).
export function mainRoutes() {
  return [
    ['home', paceHeadline],
    ['pace', paceHeadline],
    ['plan', 'Everything on the calendar'],
    ['ask', ASK_HELLO],
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
    ['packs', 'What Fathom knows'],
    ['memories', 'Memories']
  ];
}

/* ---------- Confirm deck ---------- */

// Home's data-health line (it replaced the Year banner and the Confirm nav badge) and its
// Confirm link, shown while questions are pending.
export const questionsToConfirm = (n) => `${n} question${n === 1 ? '' : 's'} to confirm`;
export const dataHealth = (page) => page.locator('section.h-home div.h-dhealth');
export const healthConfirm = (page) => dataHealth(page).locator('a[data-go="confirm"]');
// Home's verdict headline once any goal has a target: covered, or how many due goal actions need you.
export const HOME_VERDICT = /^(You are covered through Dec 31|\d+ things? needs? you before Dec 31)$/;

export const deckCard = (page) => page.locator('article.h-deck-card.cur');
export const deckProgress = (page) => page.locator('[data-deck-progress]');

// Current card's item id, as a number.
export async function deckCurrentId(page) {
  await expect(deckCard(page)).toHaveCount(1);
  return Number(await deckCard(page).getAttribute('data-item'));
}

// Pending item ids in deck order: the order of the scenario's live.ingest.items (impact rank,
// then id), which is the order the deck walks. GET /api/confirm lists by id and is not the order.
export async function deckOrder(request) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  return (await res.json()).live.ingest.items.map((i) => i.id);
}

// Move the deck to item `id` with the j and k keys. `order` is the session order (deckOrder at
// entry). Each press waits for the current card to change.
export async function deckTo(page, order, id) {
  if (!order.includes(id)) throw new Error(`item ${id} is not in the deck order`);
  for (let i = 0; i <= order.length * 2; i++) {
    const at = await deckCurrentId(page);
    if (at === id) return;
    await page.keyboard.press(order.indexOf(id) > order.indexOf(at) ? 'j' : 'k');
    await expect(deckCard(page)).not.toHaveAttribute('data-item', String(at));
  }
  throw new Error(`could not reach item ${id} in the deck`);
}

// The current card's key: its item id, or g:<kind> for a group card.
export async function deckKey(page) {
  const card = deckCard(page);
  await expect(card).toHaveCount(1);
  const item = await card.getAttribute('data-item');
  return item != null ? item : `g:${await card.getAttribute('data-group')}`;
}

async function deckPress(page, key) {
  const at = await deckKey(page);
  await page.keyboard.press(key);
  await expect.poll(() => deckKey(page), { message: `the deck moves off ${at} with ${key}` }).not.toBe(at);
}

// Rewind the deck to its first card with k, then call fn(key) on every card while moving forward
// with j until the position reads n of n. Item cards and group cards alike; works without knowing the order.
export async function deckEach(page, fn) {
  const prev = page.locator('button[data-deck="prev"]');
  await expect(deckCard(page)).toHaveCount(1);
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  for (let i = 0; i < 100 && await prev.isEnabled(); i++) await deckPress(page, 'k');
  const pos = page.locator('[data-deck-progress]');
  for (let i = 0; i < 100; i++) {
    if ((await fn(await deckKey(page))) === false) return;
    // Next never disables (it wraps or reads Done), so the end is the position n of n.
    const m = /^(\d+) of (\d+)$/.exec(((await pos.textContent()) || '').trim());
    if (!m || Number(m[1]) >= Number(m[2])) return;
    await deckPress(page, 'j');
  }
}

// Move the deck to the card matching `sel` (appended to article.h-deck-card.cur, for example
// '[data-group="account_owner"]' or '[data-item="7"]') and return its locator.
export async function deckFind(page, sel) {
  const target = page.locator(`article.h-deck-card.cur${sel}`);
  let found = false;
  await deckEach(page, async () => {
    found = (await target.count()) === 1;
    return !found;
  });
  if (!found) throw new Error(`no deck card matches ${sel}`);
  return target;
}
