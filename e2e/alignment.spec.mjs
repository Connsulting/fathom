// Layout polish checks: narrow single-column pages sit centered in the page frame, no route overflows
// a phone, the rec dialog's window strip and the Plan timeline never draw two text labels on top of
// each other, and quick switcher rows are vertically centered. Demo data only. Everything runs in
// the desktop project and sets its own viewport.
//
// @al-ac1  narrow pages are centered at 1440px (left and right gaps equal within 2px)
// @al-ac2  nothing overflows horizontally at 375px
// @al-ac3  no two timeline text labels intersect
// @al-ac4  switcher rows center their contents and share one height
// @al-ac5  an optional marker sits on its label's line, to the right of the label text

import { test, expect, gotoRoute, resetDemo, REMOTE } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Every main route of the demo, plus a pack and a what-if. Ask is its own full-bleed layout.
const ROUTES = [
  'home', 'plan', 'ask', 'wargame', 'wargame/salary', 'wargame/deferral', 'goals', 'money', 'accounts', 'add',
  'confirm', 'advisor', 'packs', 'packs/scorp', 'yearend', 'connect', 'engine', 'email', 'settings'
];

test.beforeEach(async ({ request }) => {
  if (!REMOTE) await resetDemo(request);
});

/* ---------- AC1: narrow pages are centered ---------- */

// The page column is the union of the direct children of .h-main other than the sub-nav. A page
// whose column is narrower than .h-main's content box must sit centered in it.
async function columnOf(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main.h-main');
    const cs = getComputedStyle(main);
    const mr = main.getBoundingClientRect();
    const L = mr.left + parseFloat(cs.paddingLeft);
    const R = mr.right - parseFloat(cs.paddingRight);
    const kids = [...main.children].filter((c) => !c.classList.contains('h-subnav'));
    const rects = kids.map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const h1 = main.querySelector('h1');
    return { L, R, left, right, h1: h1 ? h1.getBoundingClientRect().left : null };
  });
}

test.describe('narrow pages are centered', { tag: '@al-ac1' }, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize(DESKTOP); });

  for (const route of ROUTES.filter((r) => r !== 'ask')) {
    test(`#/${route} has equal gaps`, async ({ page }) => {
      await gotoRoute(page, route);
      await expect(page.locator('main.h-main h1').first()).toBeVisible();
      const c = await columnOf(page);
      const left = c.left - c.L;
      const right = c.R - c.right;
      expect(Math.abs(left - right), `${route}: left gap ${left}, right gap ${right}`).toBeLessThanOrEqual(2);
    });
  }

  test('Settings is a narrow column, centered, with its title on the column edge', async ({ page }) => {
    await gotoRoute(page, 'settings');
    const c = await columnOf(page);
    expect(c.R - c.L - (c.right - c.left), 'the column is narrower than the frame').toBeGreaterThan(100);
    expect(c.left - c.L).toBeGreaterThan(50);
    expect(Math.abs(c.left - c.L - (c.R - c.right))).toBeLessThanOrEqual(2);
    expect(Math.abs(c.h1 - c.left), 'the title starts on the column edge').toBeLessThanOrEqual(2);
  });

  test('Settings stays flush at phone width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoRoute(page, 'settings');
    const c = await columnOf(page);
    expect(c.left).toBeCloseTo(c.L, 0);
    expect(c.right).toBeCloseTo(c.R, 0);
  });
});

test.describe('account pages are centered', { tag: '@al-ac1' }, () => {
  test.skip(REMOTE, 'needs a local enrolled server');
  test.describe.configure({ mode: 'serial' });
  let dir = null;
  let app = null;

  test.beforeAll(async () => {
    dir = createLocalData('alignment');
    app = await startEnrolledServer({ dataDir: dir, clock: '2026-11-05' });
  });
  test.afterAll(async () => {
    if (app) await app.close();
    app = null;
    removeLocalData(dir);
  });
  test.beforeEach(async ({ page, context }) => {
    await page.setViewportSize(DESKTOP);
    await app.authenticate(context);
  });

  // The column is what the page body draws: its children's union must sit centered on the page and
  // its left edge must be the left edge of the title and of the section rules.
  async function authColumn(page) {
    return page.evaluate(() => {
      const main = document.querySelector('main.au-main');
      const rects = [...main.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      const h1 = main.querySelector('h1').getBoundingClientRect().left;
      const bar = document.querySelector('.au-top-in .au-mark').getBoundingClientRect().left;
      return { left, right, h1, bar, vw: document.documentElement.clientWidth };
    });
  }

  for (const path of ['/account', '/admin/users']) {
    test(`${path} is a centered column`, async ({ page }) => {
      await page.goto(`${app.url}${path}`);
      await expect(page.locator('main.au-main h1')).toBeVisible();
      const c = await authColumn(page);
      expect(Math.abs(c.left - (c.vw - c.right)), `left ${c.left}, right gap ${c.vw - c.right}`).toBeLessThanOrEqual(2);
      expect(Math.abs(c.h1 - c.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(c.bar - c.left), 'the brand mark starts on the column edge').toBeLessThanOrEqual(2);
    });
  }

  test('sign-in is a centered card', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    try {
      const page = await ctx.newPage();
      await page.goto(`${app.url}/signin`);
      const card = page.locator('.au-card');
      await expect(card).toBeVisible();
      const b = await card.boundingBox();
      expect(Math.abs(b.x - (DESKTOP.width - b.x - b.width))).toBeLessThanOrEqual(2);
    } finally {
      await ctx.close();
    }
  });

  test('account pages do not overflow at 375px', { tag: '@al-ac2' }, async ({ page }) => {
    await page.setViewportSize(PHONE);
    for (const path of ['/account', '/admin/users']) {
      await page.goto(`${app.url}${path}`);
      await expect(page.locator('main.au-main h1')).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(0);
    }
  });
});

/* ---------- AC2: no horizontal overflow at 375px ---------- */

test.describe('no horizontal overflow at 375px', { tag: '@al-ac2' }, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize(PHONE); });

  for (const route of [...ROUTES, 'rec/offcycle']) {
    test(`#/${route}`, async ({ page }) => {
      await gotoRoute(page, route);
      await expect(page.locator('main.h-main h1, .h-dlg h1').first()).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${route} overflows by ${over}px`).toBeLessThanOrEqual(0);
      // The document width alone can be hidden by a clipping ancestor, so also look at elements:
      // none may stick out past the viewport unless a narrower box (a scroller or an inner clip)
      // around it contains them. A page-wide clip does not count.
      const stray = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= innerWidth + 1) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'visible') continue;
          // A box that clips the whole page (the app root) hides overflow; it is not a scroller.
          const pr = p.getBoundingClientRect();
          if (pr.left > 1 || pr.right < innerWidth - 1) return false;
        }
        return getComputedStyle(el).position !== 'fixed';
      }).map((el) => `${el.tagName.toLowerCase()}.${el.className} right ${Math.round(el.getBoundingClientRect().right)}`).slice(0, 5));
      expect(stray, `${route} has elements past the right edge`).toEqual([]);
    });
  }

  test('the quick switcher fits', async ({ page }) => {
    await gotoRoute(page, 'home');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
  });
});

/* ---------- AC3: timeline labels never collide ---------- */

const iso = (d) => d.toISOString().slice(0, 10);
const shortDate = (d) => `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;

// Serve the scenario with edits applied, so the date math follows the clock the app reads.
async function editScenario(page, edit) {
  await page.route('**/api/scenario', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    const today = new Date(`${j.meta.clock}T00:00:00Z`);
    edit(j, (n) => new Date(today.getTime() + n * 86400000));
    await route.fulfill({ response: res, json: j });
  });
}

// Every text node under `sel` as a box. Text clipped by an overflow:hidden parent is cut to it.
async function textBoxes(page, sel) {
  return page.evaluate((s) => {
    const out = [];
    for (const root of document.querySelectorAll(s)) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = n.textContent.trim();
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        let { left, right, top, bottom } = range.getBoundingClientRect();
        if (!(right > left)) continue;
        const p = n.parentElement;
        if (getComputedStyle(p).overflowX !== 'visible') {
          const pr = p.getBoundingClientRect();
          left = Math.max(left, pr.left); right = Math.min(right, pr.right);
        }
        if (!(right > left)) continue;
        out.push({ text, left, right, top, bottom });
      }
    }
    return out;
  }, sel);
}

// Pairs of boxes closer than `gap` px in both directions.
function collisions(boxes, gap = 0) {
  const bad = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap) {
        bad.push(`"${a.text}" and "${b.text}"`);
      }
    }
  }
  return bad;
}

test.describe('timeline labels never collide', { tag: '@al-ac3' }, () => {
  // Items due today, soon, in two months, late and far out; with a short date label and with a
  // long text label, which is what the demo rec windows carry.
  for (const vp of [DESKTOP, PHONE]) {
    for (const days of [0, 3, 9, 36, 60, -2, 520]) {
      for (const long of [false, true]) {
        if (days === 0 && long) continue;
        test(`rec dialog strip, due in ${days} days, ${long ? 'long' : 'short'} label, at ${vp.width}px`, async ({ page }) => {
          await page.setViewportSize(vp);
          await editScenario(page, (j, at) => {
            const r = j.recs.find((x) => x.id === 'offcycle');
            r.window = { ...r.window, days, label: long ? `Schedule by ${shortDate(at(days))}` : shortDate(at(days)) };
          });
          await gotoRoute(page, 'rec/offcycle');
          await expect(page.locator('.h-strip-wrap')).toBeVisible();
          const boxes = await textBoxes(page, '.h-strip-wrap');
          expect(boxes.length).toBeGreaterThanOrEqual(3);
          // The countdown stacks its figure over its unit by design; the plot labels must be apart.
          expect(collisions(await textBoxes(page, '.h-strip-plot'), 3), 'plot labels are 3px apart at least').toEqual([]);
          const wrap = await page.locator('.h-strip-wrap').boundingBox();
          for (const b of boxes) {
            expect(b.left, `"${b.text}" starts inside the strip`).toBeGreaterThanOrEqual(wrap.x - 0.5);
            expect(b.right, `"${b.text}" ends inside the strip`).toBeLessThanOrEqual(wrap.x + wrap.width + 0.5);
          }
          const labels = (await page.locator('.h-strip-labs span:not(.mon)').allTextContents()).map((t) => t.trim());
          if (days === 0) {
            expect(labels, 'one merged label when the dates coincide').toHaveLength(1);
            expect(labels[0]).toMatch(/^Today/);
          } else {
            expect(labels).toHaveLength(2);
          }
        });
      }
    }
  }

  for (const vp of [DESKTOP, PHONE]) {
    test(`Plan timeline with items crowded around today, at ${vp.width}px`, async ({ page }) => {
      await page.setViewportSize(vp);
      await editScenario(page, (j, at) => {
        const open = j.recs.filter((r) => r.status !== 'hidden' && r.status !== 'dismissed');
        open.slice(0, 8).forEach((r, i) => {
          const n = i % 4;
          r.window = { ...r.window, days: n, label: shortDate(at(n)) };
        });
        j.deadlines.slice(0, 4).forEach((d, i) => { d.date = iso(at(i)); d.label = shortDate(at(i)); });
      });
      await gotoRoute(page, 'plan');
      await expect(page.locator('.h-tl-track')).toBeVisible();
      const boxes = await textBoxes(page, '.h-tl-track');
      expect(boxes.length).toBeGreaterThan(8);
      expect(collisions(boxes), 'Plan timeline text boxes').toEqual([]);
    });
  }

  test('the stock Plan timeline has no colliding labels', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoRoute(page, 'plan');
    await expect(page.locator('.h-tl-track')).toBeVisible();
    expect(collisions(await textBoxes(page, '.h-tl-track'))).toEqual([]);
  });
});

/* ---------- AC4: switcher rows ---------- */

test.describe('switcher rows are vertically centered', { tag: '@al-ac4' }, () => {
  for (const vp of [DESKTOP, PHONE]) {
    test(`every row type at ${vp.width}px`, async ({ page }) => {
      await page.setViewportSize(vp);
      await gotoRoute(page, 'home');
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toBeVisible();
      const rows = await page.evaluate(() => [...document.querySelectorAll('#h-qs-list li.h-qs-o')].map((li) => {
        const r = li.getBoundingClientRect();
        const mid = (a, b) => (a + b) / 2;
        const parts = {};
        const text = (el) => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect(); };
        const box = (el) => el.getBoundingClientRect();
        const t = li.querySelector('.h-qs-t'), s = li.querySelector('.h-qs-s'), k = li.querySelector('.h-qs-k'), ic = li.querySelector('.h-qs-ic svg');
        parts.title = mid(text(t).top, text(t).bottom);
        if (s && s.getBoundingClientRect().width > 0 && s.textContent.trim()) parts.kind = mid(text(s).top, text(s).bottom);
        if (k) parts.chip = mid(box(k).top, box(k).bottom);
        if (ic) parts.icon = mid(box(ic).top, box(ic).bottom);
        return { group: li.dataset.qsKey.split(':')[0], height: r.height, center: mid(r.top, r.bottom), parts, title: t.textContent.trim() };
      }));
      expect(rows.length).toBeGreaterThan(10);
      const groups = new Set(rows.map((r) => r.group));
      expect(groups.size, `row types: ${[...groups].join(', ')}`).toBeGreaterThanOrEqual(4);
      const h0 = rows[0].height;
      for (const r of rows) {
        expect(Math.abs(r.height - h0), `row height of "${r.title}" (${r.group})`).toBeLessThanOrEqual(1);
        for (const [name, y] of Object.entries(r.parts)) {
          expect(Math.abs(y - r.center), `${name} of "${r.title}" (${r.group}) is ${y - r.center}px off center`).toBeLessThanOrEqual(1.5);
        }
      }
    });
  }
});

/* ---------- AC5: optional markers share the label line ---------- */

test.describe('optional markers sit on the label line', { tag: '@al-ac5' }, () => {
  for (const vp of [DESKTOP, PHONE]) {
    test(`Goal edit form at ${vp.width}px`, async ({ page }) => {
      await page.setViewportSize(vp);
      // A new goal is one sentence; the optional fields live in a goal's edit view.
      const res = await page.request.post('/api/goals', { headers: { 'content-type': 'application/json' }, data: { title: 'A synthetic alignment goal' } });
      expect(res.status()).toBe(200);
      const { goal } = await res.json();
      await gotoRoute(page, 'goals');
      await page.locator(`article.h-goal[data-goal-id="${goal.id}"]`).getByRole('button', { name: 'Edit', exact: true }).click();
      const form = page.locator('form.h-gform');
      await expect(form).toBeVisible();
      const marks = await form.locator('.h-opt').count();
      expect(marks, 'the form has optional fields').toBeGreaterThanOrEqual(4);
      const rows = await page.evaluate(() => [...document.querySelectorAll('form.h-gform .h-opt')].map((m) => {
        const label = m.closest('.h-gl');
        const text = label.firstChild;
        const range = document.createRange();
        range.selectNodeContents(text);
        const t = range.getBoundingClientRect();
        const o = m.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        const field = label.nextElementSibling.getBoundingClientRect();
        return {
          name: text.textContent,
          sameLine: Math.abs((t.top + t.bottom) / 2 - (o.top + o.bottom) / 2) <= 4,
          rightOf: o.left >= t.right,
          lineHeight: l.height,
          gapToField: field.top - l.bottom,
          fontText: parseFloat(getComputedStyle(text.parentElement).fontSize),
          fontMark: parseFloat(getComputedStyle(m).fontSize),
        };
      }));
      for (const r of rows) {
        expect(r.sameLine, `"${r.name}" marker is on the label line`).toBe(true);
        expect(r.rightOf, `"${r.name}" marker is right of the label text`).toBe(true);
        expect(r.lineHeight, `"${r.name}" label is one line`).toBeLessThan(26);
        expect(r.fontMark, `"${r.name}" marker is smaller`).toBeLessThan(r.fontText);
        expect(r.gapToField, `"${r.name}" no extra gap before its field`).toBeLessThanOrEqual(8);
      }
    });
  }
});
