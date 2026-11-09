// README screenshots for Fathom.
//
// Starts the demo build through e2e/serve.mjs (a wiped .e2e-data-shots data directory, the real
// server in demo mode, the fake engine, the scenario's own November clock), drives it with
// headless Chromium from @playwright/test and writes:
//
//   docs/images/home.png                 Home: pace rollup headline and goal cards
//   docs/images/plan-recommendation.png  Plan with a recommendation dialog open
//   docs/images/ask.png                  Ask with a question answered by the fake engine
//   docs/images/money.png                Money: accounts, balances and trends
//   docs/images/brief-email.png          the monthly brief email as rendered HTML
//   docs/images/home-phone.png           Home at phone width
//   docs/architecture/fathom-architecture.png
//                                        the architecture diagram, when
//                                        docs/architecture/fathom-architecture.html exists
//
// Run:   node scripts/screenshots.mjs --port <n>     (or SCREENSHOT_PORT=<n>)
// A port is required and must be free; pick one no other agent or test run is using.
// Needs Chromium for Playwright (npx playwright install chromium). Web fonts load from Google
// Fonts; without network the shots fall back to system fonts.
//
// Only synthetic demo data is shown (demo/ scenario, example.invalid addresses). Still open every
// image and check it before committing: right screen, meaningful state, nothing non-synthetic.
//
// Prints each file written; exits nonzero on any failure. The child server is always stopped.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { api, fail, installCleanup, parseArgs, parsePort, repo, resetDemo, startDemo, stopServer } from './demo-server.mjs';

const DATA = '.e2e-data-shots';
const IMAGES = join(repo, 'docs', 'images');
const ARCH_HTML = join(repo, 'docs', 'architecture', 'fathom-architecture.html');
const ARCH_PNG = join(repo, 'docs', 'architecture', 'fathom-architecture.png');

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// One of the scenario's suggested questions (demo/scenario.mjs ask.suggested), asked as free text:
// the fake engine answers it with its canned, sourced paragraphs.
const ASK_QUESTION = 'What am I screwing up this month?';

// Applied right before each shot: no motion, no caret, no focus rings, no scrollbars.
const STILL_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
  :focus, :focus-visible { outline: none !important; box-shadow: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

const CLI = { portEnv: 'SCREENSHOT_PORT', usage: 'node scripts/screenshots.mjs --port <n>' };

/* ---------- page helpers ---------- */

// Resolves once no request has been in flight for `quietMs`.
function trackNetwork(page) {
  let inflight = 0;
  let last = Date.now();
  const done = () => { inflight = Math.max(0, inflight - 1); last = Date.now(); };
  page.on('request', () => { inflight++; last = Date.now(); });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return async (quietMs = 500, timeoutMs = 15_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (inflight === 0 && Date.now() - last >= quietMs) return;
      await page.waitForTimeout(100);
    }
    fail(`network did not go idle on ${page.url()}`);
  };
}

async function newPage(browser, opts) {
  // bypassCSP lets the still-frame style tag in; the app's CSP forbids inline styles.
  const context = await browser.newContext({ ...opts, colorScheme: 'dark', reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US', bypassCSP: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const idle = trackNetwork(page);
  return { context, page, idle, errors };
}

async function gotoRoute(page, base, route) {
  await page.goto(`${base}/#/${route}`);
  await page.locator('header.h-top').waitFor({ state: 'visible' });
}

async function settle(page, idle) {
  await idle();
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: STILL_CSS });
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.mouse.move(0, 0);
  // Two frames so the style tag and blur are painted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const written = [];

async function shot(page, file, opts = {}) {
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', timeout: 120_000, ...opts });
  const kb = Math.round(statSync(file).size / 1024);
  written.push(file);
  console.log(`wrote ${relative(repo, file)} (${kb} KB)`);
}

async function capture(browser, base, name, opts, drive) {
  await resetDemo(base);
  const { context, page, idle, errors } = await newPage(browser, opts);
  try {
    await drive(page, idle);
    await settle(page, idle);
    if (errors.length) fail(`${name}: page errors: ${errors.join('; ')}`);
    await shot(page, join(IMAGES, name));
  } catch (err) {
    throw new Error(`${name}: ${err.message}`);
  } finally {
    await context.close();
  }
}

/* ---------- screens ---------- */

async function home(page, base) {
  await gotoRoute(page, base, 'home');
  await page.locator('section.h-home h1').waitFor({ state: 'visible' });
}

async function planRecommendation(page, base) {
  await gotoRoute(page, base, 'plan');
  // The first needs-you row on Plan, the same entry the rec specs use.
  const link = page.locator('.h-rows article.h-row.needs a[data-go="rec"][data-id]').first();
  await link.waitFor({ state: 'visible' });
  const id = await link.getAttribute('data-id');
  // Click from the top of Plan without scrolling the link into view, so the page behind the
  // dialog is the same on every run.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await link.evaluate((el) => el.click());
  await page.locator('.h-dlg[role="dialog"]').waitFor({ state: 'visible' });
  await page.waitForURL(new RegExp(`#/rec/${id}$`));
}

async function ask(page, base, idle) {
  await gotoRoute(page, base, 'ask');
  await page.evaluate(() => document.fonts.ready);
  const input = page.locator('form.h-askx-compose textarea[name="q"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(ASK_QUESTION);
  await input.press('Enter');
  await page.waitForURL(/#\/ask\/[a-f0-9]{12}$/);
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await answer.waitFor({ state: 'visible' });
  // The stream is over when the pending block is gone and the figures are sourced.
  await page.locator('.h-askx-pend').waitFor({ state: 'detached' });
  await answer.locator('.fx-fig, .fx-src').first().waitFor({ state: 'visible' });
  if (await page.locator('.fx-checking').count()) fail('ask: figures still checking after the stream ended');
  // Show where the figures came from.
  const sources = answer.locator('details.h-src');
  if (await sources.count()) await sources.first().evaluate((d) => { d.open = true; });
  // The reply's time is the wall clock at send time; hide it so reruns match.
  await page.addStyleTag({ content: '.h-msg-who time { visibility: hidden !important; }' });
  await idle();
}

async function money(page, base) {
  await gotoRoute(page, base, 'money');
  await page.locator('section.h-money').waitFor({ state: 'visible' });
  // Scroll the trend lines and the first accounts to just under the sticky header.
  const trend = page.locator('section.h-money').getByText('Trend', { exact: true }).first();
  await trend.waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await trend.evaluate((el) => {
    const head = document.querySelector('header.h-top');
    const offset = (head ? head.getBoundingClientRect().height : 0) + 20;
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset));
  });
}

async function briefEmail(browser, base) {
  await resetDemo(base);
  const { preview } = await api(base, '/api/email');
  if (!preview || !preview.html) fail('brief-email.png: GET /api/email has no preview.html');
  // The email on its own, the way a mail client shows it: no app chrome and no scripts.
  const context = await browser.newContext({ viewport: { width: 720, height: 400 }, deviceScaleFactor: 2, colorScheme: 'dark', javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.setContent(preview.html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await shot(page, join(IMAGES, 'brief-email.png'), { fullPage: true });
  } finally {
    await context.close();
  }
}

async function architecture(browser) {
  if (!existsSync(ARCH_HTML)) {
    console.log(`skipped ${relative(repo, ARCH_PNG)} (${relative(repo, ARCH_HTML)} not present)`);
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(ARCH_HTML).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: STILL_CSS });
    await shot(page, ARCH_PNG, { fullPage: true });
  } finally {
    await context.close();
  }
}

/* ---------- main ---------- */

async function main() {
  const port = parsePort(parseArgs(process.argv.slice(2), CLI).port, CLI);
  const base = await startDemo(port, DATA);

  const browser = await chromium.launch({ headless: true });
  try {
    await capture(browser, base, 'home.png', DESKTOP, (p) => home(p, base));
    await capture(browser, base, 'plan-recommendation.png', DESKTOP, (p) => planRecommendation(p, base));
    await capture(browser, base, 'money.png', DESKTOP, (p) => money(p, base));
    await capture(browser, base, 'ask.png', DESKTOP, (p, idle) => ask(p, base, idle));
    await capture(browser, base, 'home-phone.png', PHONE, (p) => home(p, base));
    await briefEmail(browser, base);
    await architecture(browser);
  } finally {
    await browser.close();
  }
  console.log(`${written.length} image${written.length === 1 ? '' : 's'} written; check each one before committing.`);
}

installCleanup('screenshots');

try {
  await main();
  await stopServer();
} catch (err) {
  console.error(`screenshots: ${err.message}`);
  await stopServer();
  process.exit(1);
}
