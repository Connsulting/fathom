// Four-tab navigation: Home, Plan, Ask and Money as the only tabs, the gear for the Settings
// page, sub-navs on the Plan, Ask and Money groups, active marking derived from the current
// route, the switcher and G sequences, and the phone bottom bar. Runs in both projects (desktop
// 1440px, mobile 390px) unless a test says otherwise: tests tagged @mobile run on both, tests
// without it are desktop only, and @mobile-only tests run on the phone only.
// Headings come from helpers.mainRoutes() and demo/scenario.mjs; nothing is hard-coded beyond the
// pinned nav copy. #/onboarding is not in the route map below: on the demo store it falls back to
// Home (Setup is real-store only and is covered by the onboarding spec).

import {
  test, expect, S, resetDemo, mainRoutes, headingFor, needsYouIds, plain, gotoRoute, expectH1,
  openRecFromPage, recDialog, fetchScenario, healthConfirm
} from './helpers.mjs';

const BOTH = '@mobile';
const PHONE_ONLY = ['@mobile', '@mobile-only'];

/* ---------- the pinned route map ---------- */

const TABS = [['home', 'Home'], ['plan', 'Plan'], ['ask', 'Ask'], ['money', 'Money']];
const PACK = S.packs[0];
const HEAD = new Map(mainRoutes());

// [route, tab, h1]. h1 undefined takes the heading from mainRoutes(); null accepts any non-empty h1.
const ROUTE_MAP = [
  ['home', 'home'], ['pace', 'home'], ['goals', 'home'], ['confirm', 'home', 'Confirm'],
  ['plan', 'plan'], ['yearend', 'plan'], ['advisor', 'plan'],
  ['ask', 'ask'], ['wargame', 'ask'], ['wargame/salary', 'ask'], ['wargame/deferral', 'ask'],
  ['packs', 'ask'], [`packs/${PACK.id}`, 'ask', plain(PACK.name)],
  ['money', 'money', null], ['accounts', 'money'], ['add', 'money', 'Add more files'],
  ['settings', 'settings', 'Settings'], ['connect', 'settings'], ['engine', 'settings'], ['email', 'settings']
].map(([route, tab, h]) => {
  const heading = h !== undefined ? h : HEAD.get(route);
  if (heading === undefined) throw new Error(`no heading for #/${route}`);
  return { route, tab, heading };
});

// Sub-navs: tab -> [aria-label, [[route, label]]].
const SUBNAV = {
  plan: ['Plan views', [['plan', 'Plan'], ['yearend', 'Year end'], ['advisor', 'Advisor']]],
  ask: ['Ask views', [['ask', 'Conversations'], ['wargame', 'What-if'], ['packs', 'Packs']]],
  money: ['Money views', [['money', 'Overview'], ['accounts', 'Accounts'], ['add', 'Files']]]
};

// Every Go to destination in the quick switcher (pinned decision 10).
const GO_TITLES = ['Home', 'Plan', 'Decide', 'Ask', 'Confirm', 'Packs', 'Files', 'Engine', 'Email', 'Connect',
  'Money', 'Settings', 'Goals', 'Accounts', 'Advisor', 'Year end'];
const G = [['h', 'home'], ['p', 'plan'], ['d', 'wargame'], ['a', 'ask'], ['c', 'confirm'], ['k', 'packs'],
  ['f', 'add'], ['e', 'engine'], ['m', 'email'], ['n', 'connect'], ['o', 'money'], ['s', 'settings']];

/* ---------- page helpers ---------- */

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPhone = (page) => page.viewportSize().width <= 720;
const header = (page) => page.locator('header.h-top');
const mainNavEl = (page) => page.locator('header.h-top nav.h-nav[aria-label="Main"]');
const tabBarEl = (page) => page.locator('nav.h-tabs[aria-label="Tabs"]');
// The tab strip the user sees: the header nav on desktop, the bottom bar on a phone.
const tabNav = (page) => (isPhone(page) ? tabBarEl(page) : mainNavEl(page));
const tabLink = (page, k) => tabNav(page).locator(`a[data-go="${k}"]`);
const gear = (page) => page.locator('header.h-top a.h-gear');
const searchBtn = (page) => page.locator('header.h-top button.h-search-btn');
const subnav = (page, tab) => page.locator(`main.h-main nav.h-subnav[aria-label="${SUBNAV[tab][0]}"]`);
const switcher = (page) => page.getByRole('dialog', { name: 'Quick switcher' });
const sheet = (page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });
const goOption = (page, route) => page.locator(`#h-qs-list li.h-qs-o[data-qs-key="go:${route}"]`);
const nextCard = (page) => page.locator('article.h-next');

async function blur(page) {
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
}

async function expectHeading(page, request, heading) {
  if (heading === null) {
    const h1 = page.getByRole('heading', { level: 1 }).first();
    await expect(h1).toBeVisible();
    await expect(h1).not.toHaveText(/^\s*$/);
    return;
  }
  await expectH1(page, await headingFor(heading, request));
}

async function expectOn(page, route) {
  await expect(page).toHaveURL(new RegExp(`#/${reEsc(route)}$`));
}

// Exactly the expected tab is lit (class on and aria-current="page"); for the settings group the
// gear is lit and no tab is.
async function expectLit(page, tab) {
  const nav = tabNav(page);
  if (tab === 'settings') {
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(0);
    await expect(nav.locator('a.on')).toHaveCount(0);
    await expect(gear(page)).toHaveAttribute('aria-current', 'page');
    await expect(gear(page)).toHaveClass(/\bon\b/);
    return;
  }
  const current = nav.locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-go', tab);
  await expect(nav.locator('a.on')).toHaveCount(1);
  await expect(tabLink(page, tab)).toHaveClass(/\bon\b/);
  await expect(gear(page)).not.toHaveAttribute('aria-current', 'page');
  await expect(gear(page)).not.toHaveClass(/\bon\b/);
}

// The sub-nav for the route's tab lists its three views and lights the current one; Home-group
// and settings-group routes have none.
async function expectSubnav(page, route, tab) {
  if (!SUBNAV[tab]) {
    await expect(page.locator('nav.h-subnav')).toHaveCount(0);
    return;
  }
  const [, views] = SUBNAV[tab];
  const nav = subnav(page, tab);
  await expect(nav).toBeVisible();
  const links = nav.locator('a[data-go]');
  await expect(links).toHaveCount(views.length);
  await expect(links).toHaveText(views.map(([, l]) => l));
  for (const [i, [k]] of views.entries()) await expect(links.nth(i)).toHaveAttribute('data-go', k);
  const current = nav.locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-go', route.split('/')[0]);
  await expect(current).toHaveClass(/\bon\b/);
}

async function noMoreMenu(page) {
  await expect(page.locator('.h-more-btn')).toHaveCount(0);
  await expect(page.locator('#h-more-p')).toHaveCount(0);
  await expect(page.locator('[data-more]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/* ---------- AC1: four tabs and a gear, no More menu ---------- */

test.describe('four tabs', () => {
  test('the nav shows exactly Home, Plan, Ask and Money, a gear, and no More menu', { tag: ['@nav-ac1', BOTH] }, async ({ page }) => {
    for (const route of ['home', 'plan', 'money', 'settings']) {
      await gotoRoute(page, route);
      const links = tabNav(page).locator('a[data-go]');
      await expect(tabNav(page)).toBeVisible();
      await expect(links).toHaveCount(TABS.length);
      for (const [i, [k, l]] of TABS.entries()) {
        await expect(links.nth(i)).toHaveAttribute('data-go', k);
        await expect(links.nth(i)).toBeVisible();
        if (isPhone(page)) await expect(links.nth(i).locator('> span')).toHaveText(l);
        else await expect(links.nth(i)).toHaveText(l);
      }
      if (isPhone(page)) await expect(mainNavEl(page)).toBeHidden();
      else await expect(tabBarEl(page)).toBeHidden();

      const g = gear(page);
      await expect(g).toHaveCount(1);
      await expect(g).toBeVisible();
      await expect(g).toHaveAttribute('data-go', 'settings');
      await expect(g).toHaveAttribute('href', '#/settings');
      await expect(g).toHaveAccessibleName('Settings');
      await expect(g.locator('svg')).toHaveCount(1);
      expect((await g.innerText()).trim(), 'the gear has no visible text').toBe('');
      await noMoreMenu(page);
    }
  });
});

/* ---------- AC2: every destination reachable ---------- */

test.describe('reachable destinations', () => {
  for (const { route, heading } of ROUTE_MAP) {
    test(`#/${route} is reachable by URL`, { tag: ['@nav-ac2', BOTH] }, async ({ page, request }) => {
      await gotoRoute(page, route);
      await expectOn(page, route);
      await expectHeading(page, request, heading);
      await expect(recDialog(page)).toHaveCount(0);
    });
  }

  test('Home reaches Goals from its goal cards and Confirm from the data-health line', { tag: ['@nav-ac2', BOTH] }, async ({ page, request }) => {
    const pending = (await (await request.get('/api/confirm')).json()).items.length;
    expect(pending, 'the demo seeds pending questions').toBeGreaterThan(0);

    await gotoRoute(page, 'plan');
    await tabLink(page, 'home').click();
    await expectOn(page, 'home');
    await page.locator('section.h-home').getByRole('link', { name: 'All goals', exact: true }).click();
    await expectOn(page, 'goals');
    await expectH1(page, HEAD.get('goals'));

    await gotoRoute(page, 'plan');
    await tabLink(page, 'home').click();
    await expectOn(page, 'home');
    await healthConfirm(page).click();
    await expectOn(page, 'confirm');
    await expectH1(page, 'Confirm');
  });

  const CLICKS = [];
  for (const [tab, [, views]] of Object.entries(SUBNAV)) {
    for (const [route, label] of views.slice(1)) CLICKS.push({ tab, route, label });
  }
  for (const { tab, route, label } of CLICKS) {
    test(`the ${SUBNAV[tab][0]} sub-nav reaches ${label}`, { tag: ['@nav-ac2', BOTH] }, async ({ page, request }) => {
      await gotoRoute(page, 'home');
      await tabLink(page, tab).click();
      await expectOn(page, tab);
      await subnav(page, tab).getByRole('link', { name: label, exact: true }).click();
      await expectOn(page, route);
      await expectH1(page, await headingFor(ROUTE_MAP.find((r) => r.route === route).heading, request));
      await expectLit(page, tab);
    });
  }

  for (const [route, label] of [['connect', 'Connect'], ['engine', 'Engine'], ['email', 'Email']]) {
    test(`the gear opens Settings, which reaches ${label}`, { tag: ['@nav-ac2', BOTH] }, async ({ page }) => {
      await gotoRoute(page, 'home');
      await gear(page).click();
      await expectOn(page, 'settings');
      await expectH1(page, 'Settings');
      await page.locator('section.h-settings').getByRole('link', { name: label, exact: true }).click();
      await expectOn(page, route);
      await expectH1(page, HEAD.get(route));
      await expectLit(page, 'settings');
    });
  }

  test('Money shows the data-health detail, the accounts and the add-files block', { tag: ['@nav-ac2', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'home');
    await tabLink(page, 'money').click();
    await expectOn(page, 'money');
    const money = page.locator('section.h-money');
    await expect(money).toBeVisible();
    await expect(money.getByRole('heading', { level: 1 })).toBeVisible();
    const health = money.locator('.h-money-health');
    await expect(health).toBeVisible();
    for (const k of ['confirm', 'add', 'accounts']) await expect(health.locator(`a[data-go="${k}"]`).first(), k).toBeVisible();
    await expect(money.locator('.h-accs').first()).toBeVisible();
    await expect(money.getByRole('button', { name: 'Add files', exact: true })).toBeVisible();
    await expect(money.locator('input[type=file][data-upload]')).toHaveCount(1);
  });

  test('Settings on the demo lists Connect, Engine and Email only, with no signed-in line', { tag: ['@nav-ac2', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'settings');
    const settings = page.locator('section.h-settings');
    await expect(settings).toBeVisible();
    await expectH1(page, 'Settings');
    for (const name of ['Connect', 'Engine', 'Email']) {
      await expect(settings.getByRole('link', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Setup', 'Account', 'Household']) {
      await expect(settings.getByRole('link', { name, exact: true }), `${name} is real-store only`).toHaveCount(0);
    }
    await expect(settings).not.toContainText('Signed in as');
  });
});

/* ---------- AC3: active marking ---------- */

test.describe('active marking', () => {
  for (const { route, tab, heading } of ROUTE_MAP) {
    test(`#/${route} lights ${tab === 'settings' ? 'the gear' : `the ${tab} tab`}`, { tag: ['@nav-ac3', BOTH] }, async ({ page, request }) => {
      await gotoRoute(page, route);
      await expectHeading(page, request, heading);
      await expectLit(page, tab);
      await expectSubnav(page, route, tab);
    });
  }

  test('#/brief resolves to Home and lights the Home tab', { tag: ['@nav-ac3', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'brief');
    await expectOn(page, 'home');
    await expectLit(page, 'home');
  });

  test('a rec opened from Plan keeps the Plan tab lit', { tag: ['@nav-ac3', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'plan');
    await openRecFromPage(page, needsYouIds()[0]);
    await expectLit(page, 'plan');
  });
});

/* ---------- AC4: switcher, G sequences, hints, swipes ---------- */

test.describe('keyboard and switcher', () => {
  test('the switcher lists every destination and goes to Money and Settings', { tag: ['@nav-ac4', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'home');
    await searchBtn(page).click();
    await expect(switcher(page)).toBeVisible();
    const titles = (await page.locator('#h-qs-list li.h-qs-o[data-qs-key^="go:"] .h-qs-t').allTextContents()).map((t) => t.trim());
    for (const t of GO_TITLES) expect(titles, `Go to ${t}`).toContain(t);

    await goOption(page, 'money').click();
    await expectOn(page, 'money');
    await expect(switcher(page)).toBeHidden();

    await searchBtn(page).click();
    await expect(switcher(page)).toBeVisible();
    await goOption(page, 'settings').click();
    await expectOn(page, 'settings');
    await expect(switcher(page)).toBeHidden();
    await expectH1(page, 'Settings');
  });

  test('every G sequence, including G O and G S, reaches its route', { tag: '@nav-ac4' }, async ({ page }) => {
    for (const [k, route] of G) {
      await gotoRoute(page, 'goals');
      await expectOn(page, 'goals');
      await blur(page);
      await page.keyboard.press('g');
      await page.keyboard.press(k);
      await expect(page, `g ${k}`).toHaveURL(new RegExp(`#/${route}$`));
    }
  });

  test('tab and gear titles carry their G hints', { tag: ['@nav-ac4', BOTH] }, async ({ page }) => {
    await gotoRoute(page, 'home');
    const hint = (label, letter) => new RegExp(`^${reEsc(label)} \\(G( then)? ${letter}\\)$`);
    for (const [k, l, letter] of [['home', 'Home', 'H'], ['plan', 'Plan', 'P'], ['ask', 'Ask', 'A'], ['money', 'Money', 'O']]) {
      await expect(mainNavEl(page).locator(`a[data-go="${k}"]`)).toHaveAttribute('title', hint(l, letter));
    }
    await expect(gear(page)).toHaveAttribute('title', hint('Settings', 'S'));
  });

  test('the shortcut sheet lists Money and Settings under Go to', { tag: '@nav-ac4' }, async ({ page }) => {
    await gotoRoute(page, 'home');
    await blur(page);
    await page.keyboard.press('?');
    await expect(sheet(page)).toBeVisible();
    const goTo = sheet(page).locator('section.h-ks-g', { has: page.locator('h3', { hasText: /^Go to$/ }) });
    const labels = (await goTo.locator('.h-ks-l').allTextContents()).map((t) => t.trim());
    expect(labels).toContain('Money');
    expect(labels).toContain('Settings');
  });

  test('swiping the Home next card right still marks it done', { tag: ['@nav-ac4', ...PHONE_ONLY] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    await expect(nextCard(page)).toBeVisible();
    const id = await nextCard(page).getAttribute('data-next-rec');
    expect(id, 'the next card names its rec').toBeTruthy();
    const why = nextCard(page).locator('p').filter({ hasNot: page.locator('a, button') }).first();
    await why.scrollIntoViewIfNeeded();
    const box = await why.boundingBox();
    const x = Math.round(box.x + Math.min(box.width / 2, 120));
    const y = Math.round(box.y + box.height / 2);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x + (160 * i) / 10), y, id: 1 }] });
    }
    await expect.poll(() => nextCard(page).evaluate((el) => getComputedStyle(el).transform), { message: 'the card follows the finger' })
      .not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await fetchScenario(request)).recs.find((r) => r.id === id)?.status).toBe('done');
    await expect(nextCard(page)).not.toHaveAttribute('data-next-rec', id);
  });
});

/* ---------- AC5: layout ---------- */

test.describe('layout', () => {
  test('desktop: the four tabs sit in the header and the gear is its rightmost control', { tag: '@nav-ac5' }, async ({ page }) => {
    await gotoRoute(page, 'home');
    const links = header(page).locator('nav.h-nav a[data-go]');
    await expect(links).toHaveCount(TABS.length);
    for (let i = 0; i < TABS.length; i++) await expect(links.nth(i)).toBeVisible();
    await expect(tabBarEl(page)).toBeHidden();
    await expect(gear(page)).toBeVisible();
    const boxes = await header(page).locator('a, button').evaluateAll((els) => els
      .filter((e) => e.checkVisibility())
      .map((e) => ({ gear: e.classList.contains('h-gear'), left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, what: e.outerHTML.slice(0, 80) })));
    const g = boxes.find((b) => b.gear);
    expect(g, 'a visible gear').toBeTruthy();
    for (const b of boxes.filter((x) => !x.gear)) {
      expect(b.right, `${b.what} sits left of the gear`).toBeLessThanOrEqual(g.left + 1);
    }
  });

  test('phone: the bottom bar holds the four tabs, the gear stays in the header, targets are 44px', { tag: ['@nav-ac5', ...PHONE_ONLY] }, async ({ page }) => {
    await gotoRoute(page, 'home');
    const bar = tabBarEl(page);
    await expect(bar).toBeVisible();
    const tabs = bar.locator('a[data-go]');
    await expect(tabs).toHaveCount(TABS.length);
    for (const [i, [k, l]] of TABS.entries()) {
      await expect(tabs.nth(i)).toHaveAttribute('data-go', k);
      await expect(tabs.nth(i).locator('> span')).toHaveText(l);
    }
    const vh = page.viewportSize().height;
    const barBox = await bar.boundingBox();
    expect(Math.round(barBox.y + barBox.height), 'the tab bar sits at the bottom').toBe(vh);
    await expect(mainNavEl(page)).toBeHidden();
    await expect(gear(page)).toBeVisible();
    await expect(searchBtn(page)).toBeVisible();
    const targets = [
      ...(await tabs.evaluateAll((els) => els.map((e) => ({ what: e.getAttribute('data-go'), ...e.getBoundingClientRect().toJSON() })))),
      { what: 'gear', ...(await gear(page).boundingBox()) },
      { what: 'search', ...(await searchBtn(page).boundingBox()) }
    ];
    for (const t of targets) {
      expect(t.width, `${t.what} width`).toBeGreaterThanOrEqual(44);
      expect(t.height, `${t.what} height`).toBeGreaterThanOrEqual(44);
    }
    for (const tab of Object.keys(SUBNAV)) {
      await gotoRoute(page, tab);
      const heights = await subnav(page, tab).locator('a[data-go]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(heights.length, `${tab} sub-nav links`).toBe(SUBNAV[tab][1].length);
      for (const h of heights) expect(h, `${tab} sub-nav link height`).toBeGreaterThanOrEqual(44);
    }
  });

  for (const { route, heading } of ROUTE_MAP) {
    test(`phone: #/${route} has no horizontal page scroll`, { tag: ['@nav-ac5', ...PHONE_ONLY] }, async ({ page, request }) => {
      await gotoRoute(page, route);
      await expectHeading(page, request, heading);
      const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      expect(w.doc, `documentElement.scrollWidth on #/${route}`).toBeLessThanOrEqual(w.inner);
      expect(w.body, `body.scrollWidth on #/${route}`).toBeLessThanOrEqual(w.inner);
    });
  }
});
