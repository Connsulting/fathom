// Suggested goal targets without forms (SX3), on the demo build at desktop and phone width: Fathom
// sets the calculator's target by itself and says so with Undo; nothing asks the owner to Accept,
// Edit, Dismiss or type a withdrawal rate. Every state is built through the API on the demo store:
// reset, archive every seed goal (seed goals never get suggestions), then create owner goals.
// Amounts, dates and labels come from GET /api/scenario at test time and are never hard-coded.
//
// Demo facts the states rely on (see the plan's Interface contract): the cushion suggestion is a
// target above today's personal cash; the independence suggestion is already covered by the
// investments; there are no room figures, so a pay-less-tax goal is a question.
//
// Every test carries @mobile so both Playwright projects run it; assertions that differ by width
// branch on testInfo.project.name ('desktop': the div.h-due list; 'mobile': article.h-next plus
// div.h-after).

import {
  test, expect, resetDemo, gotoRoute, fetchScenario, expectPopoverSource, dataHealth, mainNav, HOME_VERDICT
} from './helpers.mjs';

/* ---------- fixtures ---------- */

const JSON_HEADERS = { 'content-type': 'application/json' };

// The onboarding starters (title, note, horizon as the Goals step saves them) plus a free-text goal.
const STARTERS = {
  cushion: { title: 'A cash cushion', note: 'Months of spending you never touch', horizon: 'now' },
  work: { title: 'Work less, on our terms', note: 'The year work becomes optional', horizon: '3-10y' },
  tax: { title: 'Pay less tax, without stress', note: 'Use every window before Dec 31', horizon: 'now' },
  free: { title: 'Work becomes optional because investments cover household spending', note: '', horizon: '3-10y' }
};

async function post(request, path, data) {
  const res = await request.post(path, { headers: JSON_HEADERS, data });
  expect(res.status(), `POST ${path}`).toBe(200);
  return res.json();
}

async function archiveSeedGoals(request) {
  const s = await fetchScenario(request);
  for (const g of s.goals.filter((x) => !x.archived)) await post(request, `/api/goals/${encodeURIComponent(g.id)}/archive`, {});
  expect((await fetchScenario(request)).goals.filter((g) => !g.archived), 'every seed goal is archived').toEqual([]);
}

const createGoal = async (request, body) => (await post(request, '/api/goals', body)).goal;

// Reset, archive the seed goals, and create the given owner goals. Returns {key: goal id}.
async function buildState(request, goals) {
  await resetDemo(request);
  await archiveSeedGoals(request);
  const ids = {};
  for (const [k, body] of Object.entries(goals)) ids[k] = (await createGoal(request, body)).id;
  return ids;
}

const zeroTargets = (request) => buildState(request, STARTERS);

// A body that gives a goal a target, a date and a tracked account. The amount is twice the
// account's stored value, read from the scenario.
function targeted(s, base, factor = 2) {
  const acct = s.accounts.find((a) => a.kind === 'checking' && a.fig && s.fig[a.fig] && Number.isFinite(s.fig[a.fig].v) && s.fig[a.fig].v > 0);
  expect(acct, 'the demo has a checking account with a stored balance').toBeTruthy();
  const year = Number(s.meta.clock.slice(0, 4));
  return { ...base, target: Math.round(s.fig[acct.fig].v * factor), targetDate: `${year + 1}-12-31`, track: { accounts: [acct.id] } };
}

const recordOf = (s, id) => (s.suggestions || []).find((r) => r.goalId === id);
const liveGoals = (s) => s.goals.filter((g) => !g.archived && g.status !== 'done');
const goalOf = (s, id) => s.goals.find((g) => g.id === id);

/* ---------- the due-list oracle (mirrors the contract's homeModel.due) ---------- */

const OPEN = ['proposed', 'doing'];
const daysOf = (r) => (r?.window?.days != null && Number.isFinite(Number(r.window.days)) ? Number(r.window.days) : Infinity);
function daysToYearEnd(clockIso) {
  return Math.round((Date.UTC(Number(clockIso.slice(0, 4)), 11, 31) - Date.parse(`${clockIso}T00:00:00Z`)) / 86400000);
}
function dueOf(s) {
  const end = daysToYearEnd(s.meta.clock);
  return s.recs.filter((r) => OPEN.includes(r.status) && r.housekeeping !== true && daysOf(r) <= end).sort((a, b) => daysOf(a) - daysOf(b));
}

/* ---------- locators ---------- */

const home = (page) => page.locator('section.h-home');
const h1 = (page) => page.locator('h1.h-home-h');
const homeCard = (page, id) => page.locator(`section.h-home article.h-gcard[data-goal-card="${id}"]`);
const goalsCard = (page, id) => page.locator(`article.h-goal[data-goal-id="${id}"]`);
const setLine = (scope, id) => scope.locator(`p.h-gset[data-goal-set="${id}"]`);
const posted = (page, path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST');

// Nothing on the page asks for a decision about a suggestion: no Accept, Dismiss, Accept all,
// withdrawal rate input or curve slider.
async function expectNoForms(page) {
  await expect(page.locator('[data-sugg-act="accept"], [data-sugg-act="dismiss"], button[data-sugg-all]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Accept( all)?$/ })).toHaveCount(0);
  await expect(page.locator('input[data-sugg-rate], input[data-curve], input[type="range"]')).toHaveCount(0);
}

async function press(locator, hasTouch) {
  if (hasTouch) await locator.tap();
  else await locator.click();
}

// Open the popover for a figure, retrying until it shows the expected source.
async function openSource(page, fig, label) {
  await page.waitForLoadState('networkidle');
  const source = page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v');
  await expect(async () => {
    if (!(await page.locator('.fx-pop').count())) await fig.click();
    await expect(source).toHaveText(label, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expectPopoverSource(page, label);
}

/* ---------- tests ---------- */

test.describe('suggested goal targets', () => {
  test('zero targets: Fathom sets every target it can, the tax goal asks, Home shows the verdict and the due list', { tag: ['@tg-ac2', '@tg-ac3', '@tg-ac4', '@mobile'] }, async ({ page, request }, testInfo) => {
    const ids = await zeroTargets(request);
    const s = await fetchScenario(request);
    const live = liveGoals(s);
    expect(live.map((g) => g.id).sort()).toEqual(Object.values(ids).sort());
    for (const k of ['cushion', 'work', 'free']) {
      const g = goalOf(s, ids[k]);
      expect(g.adopted, `${k}: Fathom set its target`).toBeTruthy();
      expect(s.fig[`goal.${g.id}.target`].src, `${k}: the target keeps calculator provenance`).toBe('calc:targets');
      expect(recordOf(s, g.id), `${k}: nothing left to accept`).toBeUndefined();
    }
    expect(recordOf(s, ids.tax), 'no room figures on the demo, so the tax goal asks').toMatchObject({ state: 'question', ask: 'What amount would make this real?' });
    const due = dueOf(s);
    expect(due.length, 'the demo has at least three goal actions before Dec 31 for these goals').toBeGreaterThanOrEqual(3);

    await gotoRoute(page, 'home');
    await expect(home(page).locator('article.h-gcard[data-goal-card]')).toHaveCount(live.length);
    await expect(h1(page)).toHaveText(HOME_VERDICT);
    await expect(homeCard(page, ids.cushion).locator('.h-pbar')).toHaveCount(1);
    await expect(homeCard(page, ids.cushion).locator('.h-sugg')).toHaveCount(0);
    const ask = homeCard(page, ids.tax).locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`);
    await expect(ask).toContainText('What amount would make this real?');
    await expectNoForms(page);

    // At least the next three goal actions show with owner and date, without expanding anything.
    const dueIds = due.map((r) => r.id);
    if (testInfo.project.name === 'mobile') {
      const next = page.locator('article.h-next');
      await expect(next).toBeVisible();
      const nid = await next.getAttribute('data-next-rec');
      expect(dueIds, 'the next card is a due goal action').toContain(nid);
      expect(daysOf(s.recs.find((r) => r.id === nid)), 'the next card is the earliest due action').toBe(daysOf(due[0]));
      await expect(next.locator('.h-who')).toBeVisible();
      await expect(next.locator('.h-next-cd')).toBeVisible();
      const rows = page.locator('div.h-after div.h-after-r[data-rec]');
      await expect(rows).toHaveCount(Math.min(3, due.length - 1));
      for (let i = 0; i < await rows.count(); i++) {
        const row = rows.nth(i);
        const id = await row.getAttribute('data-rec');
        expect(dueIds, `after row ${id} is a due goal action`).toContain(id);
        expect(id).not.toBe(nid);
        await expect(row.locator('.h-after-d')).toBeVisible();
        await expect(row.locator('.h-after-d')).toHaveText(/\S/);
        await expect(row.locator('.h-who')).toBeVisible();
      }
    } else {
      const list = page.locator('section.h-home div.h-due');
      await expect(list).toHaveCount(1);
      await expect(list).toContainText('Due before Dec 31');
      const rows = list.locator('div.h-due-r[data-rec]');
      await expect(rows).toHaveCount(Math.min(5, due.length));
      for (let i = 0; i < await rows.count(); i++) {
        const row = rows.nth(i);
        const id = await row.getAttribute('data-rec');
        expect(dueIds, `due row ${id} is a due goal action, not housekeeping`).toContain(id);
        await expect(row.locator('.h-due-d')).toBeVisible();
        await expect(row.locator('.h-due-d')).toHaveText(/\S/);
        await expect(row.locator(`a[data-go="rec"][data-id="${id}"]`)).toBeVisible();
        await expect(row.locator('.h-who')).toBeVisible();
      }
    }

    // Housekeeping stays one quiet row at most.
    expect(await page.locator('details.h-hk').count()).toBeLessThanOrEqual(1);

    // The rest of Home is unchanged: owner filter, data-health line, four tabs, the gear.
    await expect(page.locator('div.h-ownerf[role="group"][aria-label="Whose actions"] button[data-owner]')).toHaveCount(3);
    await expect(dataHealth(page)).toHaveCount(1);
    await expect(dataHealth(page)).toBeVisible();
    const tabs = testInfo.project.name === 'mobile' ? page.locator('nav.h-tabs[aria-label="Tabs"] a') : mainNav(page).locator('a');
    await expect(tabs).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(tabs.nth(i)).toBeVisible();
    await expect(page.locator('header.h-top a.h-gear')).toBeVisible();

    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(widths.doc, 'no horizontal page scroll on #/home').toBeLessThanOrEqual(widths.inner);
    await page.screenshot({ path: testInfo.outputPath(`home-zero-targets-${testInfo.project.name}.png`), fullPage: true });
  });

  test('Goals shows the target Fathom set with its Undo; Undo declines it for good', { tag: ['@tg-ac2', '@tg-ac4', '@mobile'] }, async ({ page, request }, testInfo) => {
    const ids = await zeroTargets(request);
    const id = ids.cushion;
    const s = await fetchScenario(request);
    const f = s.fig[`goal.${id}.target`];
    expect(f.src).toBe('calc:targets');
    expect(s.src['calc:targets']?.label).toBe('Suggested target calculator');

    await gotoRoute(page, 'goals');
    const card = goalsCard(page, id);
    await expect(setLine(card, id)).toHaveText('Fathom set this target. Undo');
    await expect(setLine(card, id).getByRole('button', { name: 'Undo' })).toBeVisible();
    await expectNoForms(page);
    await expect(page.getByRole('heading', { name: 'Where on the curve' })).toHaveCount(0);
    // The target opens its provenance: the calculator, saying Fathom set it, and the spending window.
    await openSource(page, card.locator(`.fx-fig[data-fig="goal.${id}.target"]`).first(), 'Suggested target calculator');
    const assumes = await page.locator('.fx-pop .fx-pop-row', { hasText: 'Assumes' }).locator('.fx-pop-v').allTextContents();
    expect(assumes[0]).toBe('Fathom set this target.');
    await page.keyboard.press('Escape');
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(widths.doc, 'no horizontal page scroll on #/goals').toBeLessThanOrEqual(widths.inner);
    await page.screenshot({ path: testInfo.outputPath(`goals-adopted-${testInfo.project.name}.png`), fullPage: true });

    const undo = posted(page, `/api/goals/${id}/suggestion`);
    await setLine(card, id).getByRole('button', { name: 'Undo' }).click();
    expect((await undo).request().postDataJSON()).toEqual({ action: 'undo' });
    await expect(setLine(card, id)).toHaveCount(0);
    await expect(card.locator('p.h-gnone')).toContainText('No target yet.');
    await page.reload();
    await expect(goalsCard(page, id).locator('p.h-gnone')).toContainText('No target yet.');
    const after = await fetchScenario(request);
    expect(recordOf(after, id).state).toBe('declined');
    expect(after.fig[`goal.${id}.target`]).toBeUndefined();
  });

  test('a remembered withdrawal rate moves the work-optional target Fathom set', { tag: ['@tg-ac2', '@mobile'] }, async ({ request }) => {
    const ids = await zeroTargets(request);
    const before = (await fetchScenario(request)).fig[`goal.${ids.work}.target`];
    expect(before.notes.join(' ')).toContain('Withdrawal rate: 4% a year, the default');
    await post(request, '/api/preferences', { text: 'Use a 3% withdrawal rate' });
    const s = await fetchScenario(request);
    const f = s.fig[`goal.${ids.work}.target`];
    expect(f.src).toBe('calc:targets');
    expect(f.notes.join(' ')).toContain('Withdrawal rate: 3% a year, your choice');
    expect(f.v, 'a lower rate needs more invested').toBeGreaterThan(before.v);
    expect(goalOf(s, ids.work).adopted).toBeTruthy();
  });

  test('mixed: an owner target and a Fathom target both show pace; the tax goal asks', { tag: ['@tg-ac3', '@tg-ac4', '@mobile'] }, async ({ page, request }, testInfo) => {
    await resetDemo(request);
    await archiveSeedGoals(request);
    const s0 = await fetchScenario(request);
    const ids = {
      cushion: (await createGoal(request, targeted(s0, STARTERS.cushion))).id,
      work: (await createGoal(request, STARTERS.work)).id,
      tax: (await createGoal(request, STARTERS.tax)).id
    };
    const s = await fetchScenario(request);
    expect(goalOf(s, ids.cushion).adopted, 'a typed target stays the owner\'s').toBeFalsy();
    expect(s.fig[`goal.${ids.cushion}.target`].src).toBe('goal-target');
    expect(goalOf(s, ids.work).adopted).toBeTruthy();
    expect(recordOf(s, ids.tax).state).toBe('question');

    await gotoRoute(page, 'home');
    await expect(h1(page)).toHaveText(HOME_VERDICT);
    await expect(home(page).locator('article.h-gcard[data-goal-card]')).toHaveCount(3);
    await expect(homeCard(page, ids.cushion).locator('.h-pbar')).toHaveCount(1);
    await expect(homeCard(page, ids.cushion).locator('.h-sugg')).toHaveCount(0);
    await expect(homeCard(page, ids.tax).locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`)).toContainText('What amount would make this real?');
    await expectNoForms(page);
    await gotoRoute(page, 'goals');
    await expect(setLine(goalsCard(page, ids.cushion), ids.cushion)).toHaveCount(0);
    await expect(setLine(goalsCard(page, ids.work), ids.work)).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`goals-mixed-${testInfo.project.name}.png`), fullPage: true });
  });

  test('onboarding starters get their targets right after saving', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request, hasTouch }) => {
    await resetDemo(request);
    await archiveSeedGoals(request);
    // No open goals: Home is the Goals step.
    await gotoRoute(page, 'home');
    const block = page.locator('[data-goals-start]');
    await expect(block).toBeVisible();
    await press(block.locator('button[data-goal-starter="cushion"]'), hasTouch);
    await press(block.locator('button[data-goal-starter="tax"]'), hasTouch);
    await press(block.getByRole('button', { name: 'Save goals' }), hasTouch);
    await expect(page.locator('[data-goals-start]')).toHaveCount(0);

    let s;
    await expect.poll(async () => {
      s = await fetchScenario(request);
      return liveGoals(s).length;
    }).toBe(2);
    const cushion = liveGoals(s).find((g) => g.title === STARTERS.cushion.title);
    const tax = liveGoals(s).find((g) => g.title === STARTERS.tax.title);
    expect(cushion && tax, 'both starters were saved').toBeTruthy();
    expect(cushion.adopted, 'Fathom set the cushion target').toBeTruthy();

    // Right after saving, without a reload.
    await expect(homeCard(page, cushion.id).locator('.h-pbar')).toHaveCount(1);
    await expect(homeCard(page, tax.id).locator(`div.h-sugg.ask[data-sugg="${tax.id}"]`)).toContainText('What amount would make this real?');
    await expectNoForms(page);
  });
});
