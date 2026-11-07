// Suggested goal targets and a Home that is never empty, on the demo build at desktop and phone
// width. Every state is built through the API on the demo store: reset, archive every seed goal
// (seed goals never get suggestions), then create owner goals. Amounts, dates, windows and labels
// come from GET /api/scenario (scenario.suggestions, scenario.fig, scenario.pace) at test time and
// are never hard-coded.
//
// Demo facts the states rely on (see the plan's Interface contract): the cushion suggestion is a
// target above today's personal cash; the independence suggestion is already covered by the
// investments; there are no room figures, so a pay-less-tax goal is a question.
//
// Every test carries @mobile so both Playwright projects run it; assertions that differ by width
// branch on testInfo.project.name ('desktop': the div.h-due list; 'mobile': article.h-next plus
// div.h-after).

import {
  test, expect, resetDemo, gotoRoute, fetchScenario, money, expectPopoverSource, dataHealth, mainNav
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
const pendingOf = (s) => (s.suggestions || []).filter((r) => r.state === 'suggested' && liveGoals(s).some((g) => g.id === r.goalId));

/* ---------- formatting, as the client renders it ---------- */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthAbbr = (ym) => MON[Number(ym.slice(5, 7)) - 1];
const longDate = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

// 'Feb to Jul 2026' within one year, else 'Nov 2025 to Jul 2026'.
function windowText(w) {
  const [fy, ty] = [w.from.slice(0, 4), w.to.slice(0, 4)];
  return fy === ty ? `${monthAbbr(w.from)} to ${monthAbbr(w.to)} ${ty}` : `${monthAbbr(w.from)} ${fy} to ${monthAbbr(w.to)} ${ty}`;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The suggested amount renders through figHtml: full dollars or the short K/M form.
const amountRe = (v) => new RegExp(`^(${escRe(money(v))}|${escRe(money(v, { k: true }))})$`);

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
const sugg = (scope, id) => scope.locator(`div.h-sugg[data-sugg="${id}"]`);
const line = (scope, id) => sugg(scope, id).locator('p.h-sugg-l');
const act = (scope, id, a) => scope.locator(`[data-sugg-act="${a}"][data-id="${id}"]`);
const acceptAll = (page) => page.locator('button[data-sugg-all]');
const reviewTargets = (page) => home(page).locator('a[data-go="goals"]', { hasText: /^Review targets$/ });

const posted = (page, path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST');

async function press(locator, hasTouch) {
  if (hasTouch) await locator.tap();
  else await locator.click();
}

// The cushion suggestion line: "Suggested: <amount> by <Mon D, YYYY>..., tracks <label>".
async function expectCushionLine(scope, s, rec) {
  const l = line(scope, rec.goalId);
  await expect(l).toHaveText(/^Suggested:/);
  await expect(l).toContainText(' by ');
  await expect(l).toContainText(longDate(rec.targetDate));
  await expect(l).toContainText('tracks');
  if (rec.trackLabel && !/[{}]/.test(rec.trackLabel)) await expect(l).toContainText(rec.trackLabel);
  const amount = l.locator(`.fx-fig[data-fig="${rec.figures.target}"]`);
  await expect(amount).toHaveCount(1);
  await expect(amount).toHaveText(amountRe(s.fig[rec.figures.target].v));
}

async function expectControls(scope, id) {
  await expect(act(scope, id, 'accept')).toHaveText('Accept');
  await expect(act(scope, id, 'edit')).toHaveText('Edit');
  await expect(act(scope, id, 'dismiss')).toHaveText('Dismiss');
}

/* ---------- tests ---------- */

test.describe('suggested goal targets', () => {
  test('zero targets: one card per goal, suggestions and a question, a headline, bulk actions and the due list', { tag: ['@tg-ac2', '@tg-ac3', '@tg-ac4', '@mobile'] }, async ({ page, request }, testInfo) => {
    const ids = await zeroTargets(request);
    const s = await fetchScenario(request);
    const live = liveGoals(s);
    expect(live.map((g) => g.id).sort()).toEqual(Object.values(ids).sort());
    const cushion = recordOf(s, ids.cushion);
    expect(cushion, 'the cushion goal has a record').toMatchObject({ kind: 'cushion', state: 'suggested' });
    expect(recordOf(s, ids.tax), 'no room figures on the demo, so the tax goal asks').toMatchObject({ state: 'question', ask: 'What amount would make this real?' });
    const pending = pendingOf(s);
    expect(pending.length, 'at least two goals have a suggested target').toBeGreaterThanOrEqual(2);
    const due = dueOf(s);
    expect(due.length, 'the demo has at least three goal actions before Dec 31 for these goals').toBeGreaterThanOrEqual(3);

    await gotoRoute(page, 'home');

    // One card per goal, no quiet row, no comma list, no sad headline.
    await expect(home(page).locator('article.h-gcard[data-goal-card]')).toHaveCount(live.length);
    for (const g of live) {
      await expect(homeCard(page, g.id)).toHaveCount(1);
      await expect(homeCard(page, g.id)).toContainText(g.title);
    }
    await expect(page.locator('details.h-quiet')).toHaveCount(0);
    await expect(page.locator('[data-quiet-goal]')).toHaveCount(0);
    await expect(home(page)).not.toContainText('No goals with targets');

    // Headline and bulk actions.
    await expect(h1(page)).toHaveText(`Suggested targets for ${pending.length} goal${pending.length === 1 ? '' : 's'}`);
    await expect(acceptAll(page)).toBeVisible();
    await expect(acceptAll(page)).toHaveText('Accept all');
    await expect(reviewTargets(page)).toBeVisible();

    // The cushion card: the suggestion line, why, basis with the window, and the three controls.
    const cc = homeCard(page, ids.cushion);
    await expectCushionLine(cc, s, cushion);
    await expect(sugg(cc, ids.cushion).locator('p.h-sugg-why')).toHaveText(/\S/);
    await expect(sugg(cc, ids.cushion).locator('p.h-sugg-src')).toContainText(windowText(cushion.window));
    await expectControls(cc, ids.cushion);
    await expect(cc.locator('.h-pbar')).toHaveCount(0);

    // The tax card asks, with an Edit goal control and nothing to accept.
    const tc = homeCard(page, ids.tax);
    const ask = tc.locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`);
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('What amount would make this real?');
    await expect(act(tc, ids.tax, 'edit')).toHaveText('Edit goal');
    await expect(act(tc, ids.tax, 'accept')).toHaveCount(0);

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

  test('Accept on the cushion card saves the suggested target and the card shows a pace bar', { tag: ['@tg-ac2', '@tg-ac4', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const s = await fetchScenario(request);
    const rec = recordOf(s, ids.cushion);
    expect(rec.accept, 'the cushion record carries its accept body').toBeTruthy();
    await gotoRoute(page, 'home');
    const res = posted(page, `/api/goals/${ids.cushion}`);
    await act(homeCard(page, ids.cushion), ids.cushion, 'accept').click();
    const r = await res;
    expect(r.status()).toBe(200);
    expect(r.request().postDataJSON(), 'Accept posts the record accept body').toEqual(rec.accept);

    await page.reload();
    const card = homeCard(page, ids.cushion);
    await expect(card).toHaveCount(1);
    await expect(card.locator('.h-pbar')).toHaveCount(1);
    await expect(card.locator('.h-sugg')).toHaveCount(0);

    const after = await fetchScenario(request);
    const g = after.goals.find((x) => x.id === ids.cushion);
    expect(g.target).toBe(rec.accept.target);
    expect(g.targetDate).toBe(rec.accept.targetDate);
    expect(g.track).toEqual(rec.accept.track);
    expect(recordOf(after, ids.cushion), 'a goal with a target gets no record').toBeUndefined();
    // A goal with a target now exists, so Home is headed by the pace headline.
    await expect(h1(page)).toHaveText(after.pace.rollup.headline);
  });

  test('Accept all saves every pending suggestion and leaves the question', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const s = await fetchScenario(request);
    const pending = pendingOf(s);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const bodies = {};
    page.on('request', (req) => {
      const p = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /^\/api\/goals\/[^/]+$/.test(p)) bodies[decodeURIComponent(p.split('/').pop())] = req.postDataJSON();
    });
    await gotoRoute(page, 'home');
    await acceptAll(page).click();
    await expect.poll(async () => {
      const now = await fetchScenario(request);
      return pending.filter((r) => now.goals.find((g) => g.id === r.goalId)?.target === r.accept.target).length;
    }, { message: 'every pending goal has its suggested target' }).toBe(pending.length);
    expect(Object.keys(bodies).sort()).toEqual(pending.map((r) => r.goalId).sort());
    for (const r of pending) expect(bodies[r.goalId], r.goalId).toEqual(r.accept);

    await page.reload();
    for (const r of pending) await expect(homeCard(page, r.goalId).locator('.h-sugg')).toHaveCount(0);
    await expect(homeCard(page, ids.tax).locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`)).toBeVisible();
    await expect(acceptAll(page)).toHaveCount(0);
  });

  test('Dismiss hides the suggestion across a reload, and editing the goal brings it back', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.cushion;
    await gotoRoute(page, 'home');
    const card = homeCard(page, id);
    await expect(line(card, id)).toHaveText(/^Suggested:/);
    const res = posted(page, `/api/goals/${id}/suggestion`);
    await act(card, id, 'dismiss').click();
    const r = await res;
    expect(r.status()).toBe(200);
    expect(r.request().postDataJSON()).toEqual({ action: 'dismiss' });

    const expectDismissed = async () => {
      await expect(card.locator('p.h-sugg-l')).toHaveCount(0);
      await expect(act(card, id, 'accept')).toHaveCount(0);
      await expect(card).toContainText('No target yet.');
      await expect(card.locator('button, a').filter({ hasText: /^Add one$/ })).toBeVisible();
    };
    await expectDismissed();
    expect(recordOf(await fetchScenario(request), id).state).toBe('dismissed');
    await page.reload();
    await expectDismissed();

    // A changed goal text changes the fingerprint, so the suggestion returns.
    await post(request, `/api/goals/${id}`, { title: 'A cash cushion for the two of us' });
    const s = await fetchScenario(request);
    expect(recordOf(s, id).state).toBe('suggested');
    await page.reload();
    await expectCushionLine(card, s, recordOf(s, id));
    await expectControls(card, id);
  });

  test('Edit opens the goal editor prefilled with the suggestion and saves nothing until Save', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.cushion;
    const rec = recordOf(await fetchScenario(request), id);
    expect(rec.accept.track && rec.accept.track.accounts.length, 'the cushion tracks accounts').toBeTruthy();
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname.startsWith('/api/goals')) posts.push(new URL(req.url()).pathname);
    });
    await gotoRoute(page, 'home');
    await act(homeCard(page, id), id, 'edit').click();
    await expect(page).toHaveURL(/#\/goals(\?.*)?$/);
    const form = page.locator('form.h-gform');
    await expect(form).toBeVisible();
    await expect(form.locator('[data-gf="title"]')).toHaveValue(STARTERS.cushion.title);
    await expect(form.locator('[data-gf="target"]')).toHaveValue(String(rec.accept.target));
    await expect(form.locator('[data-gf="targetDate"]')).toHaveValue(rec.accept.targetDate);
    await expect(form.locator('select[data-gf="track"]')).toHaveValue('accounts');
    for (const a of rec.accept.track.accounts) await expect(form.locator(`input[data-gf="acct"][value="${a}"]`)).toBeChecked();
    const checked = await form.locator('input[data-gf="acct"]:checked').evaluateAll((els) => els.map((e) => e.value));
    expect(checked.sort()).toEqual([...rec.accept.track.accounts].sort());

    // Nothing saved yet.
    expect(posts).toEqual([]);
    expect((await fetchScenario(request)).goals.find((g) => g.id === id).target).toBeNull();

    // Save writes the prefilled values.
    const res = posted(page, `/api/goals/${id}`);
    await form.getByRole('button', { name: 'Save changes' }).click();
    expect((await res).status()).toBe(200);
    await expect(form).toHaveCount(0);
    const g = (await fetchScenario(request)).goals.find((x) => x.id === id);
    expect(g.target).toBe(rec.accept.target);
    expect(g.targetDate).toBe(rec.accept.targetDate);
    expect([...g.track.accounts].sort()).toEqual([...rec.accept.track.accounts].sort());
  });

  test('changing the withdrawal rate changes the independence target and the amount shown', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.free;
    const s = await fetchScenario(request);
    const before = recordOf(s, id);
    expect(before).toMatchObject({ kind: 'independence', state: 'suggested' });
    expect(before.editable).toContain('withdrawalRate');
    const oldV = s.fig[before.figures.target].v;

    await gotoRoute(page, 'home');
    const card = homeCard(page, id);
    const rate = card.locator(`input[data-sugg-rate="${id}"]`);
    await expect(rate).toHaveValue('4');
    await expect(rate).toHaveAttribute('min', '2');
    await expect(rate).toHaveAttribute('max', '6');
    await expect(rate).toHaveAttribute('step', '0.25');
    await expect(sugg(card, id)).toContainText('Withdrawal rate');

    const res = posted(page, `/api/goals/${id}/suggestion`);
    await rate.fill('3.5');
    await rate.blur(); // the input commits on change
    const r = await res;
    expect(r.status()).toBe(200);
    const body = r.request().postDataJSON();
    expect(Object.keys(body)).toEqual(['withdrawalRate']);
    expect(body.withdrawalRate).toBeCloseTo(0.035, 9);

    const after = await fetchScenario(request);
    const rec = recordOf(after, id);
    expect(rec.params.withdrawalRate).toBeCloseTo(0.035, 9);
    const newV = after.fig[rec.figures.target].v;
    expect(newV, 'a lower withdrawal rate needs a larger target').toBeGreaterThan(oldV);
    // Target = annual spending / rate, rounded up to the next thousand (cents rounding aside).
    const annual = after.fig[rec.figures.annualSpend].v;
    expect(newV - annual / 0.035).toBeGreaterThanOrEqual(-1);
    expect(newV - annual / 0.035).toBeLessThan(1001);

    const amount = line(card, id).locator(`.fx-fig[data-fig="${rec.figures.target}"]`);
    await expect(amount).toHaveText(amountRe(newV));
    await expect(card.locator(`input[data-sugg-rate="${id}"]`)).toHaveValue('3.5');
  });

  test('an already covered goal says so, and accepting it shows as reached with a pace chart', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.free;
    const s = await fetchScenario(request);
    const rec = recordOf(s, id);
    expect(rec, 'investments exceed annual spending / 4% on the demo').toMatchObject({ kind: 'independence', state: 'suggested', covered: true });

    await gotoRoute(page, 'home');
    const card = homeCard(page, id);
    await expect(line(card, id)).toHaveText(/^Already covered:/);
    await expect(line(card, id).locator(`.fx-fig[data-fig="${rec.figures.target}"]`)).toHaveCount(1);
    const res = posted(page, `/api/goals/${id}`);
    await act(card, id, 'accept').click();
    expect((await res).status()).toBe(200);

    const after = await fetchScenario(request);
    const p = after.pace.goals.find((g) => g.id === id);
    expect(p, 'the accepted goal has a pace entry').toBeTruthy();
    // The reached path: plan today is the target, whatever the data state.
    expect(p.expected.v).toBe(p.target.v);
    await page.reload();
    const chip = card.locator('span.h-pchip');
    // Revision 1 item 8 keeps stale data unknown even on a reached path. The demo's investment
    // positions may be past their monthly cadence at the demo clock; when they are, the chip must
    // say Data stale (never On pace), and Reached is asserted whenever the data is current.
    if (p.stale) {
      expect(p.status).toBe('unknown');
      await expect(chip).toHaveText('Data stale');
    } else {
      expect(p.status).toBe('ahead');
      expect(p.timeGap).toBe('Reached');
      await expect(chip).toHaveText('Reached');
    }
    await expect(card.locator('.h-sugg')).toHaveCount(0);

    // A chart for the goal on the pace board (household savings replaces goal charts when it exists).
    expect(Array.isArray(after.pace.series.goals[id]?.series), 'the goal has a monthly pace series').toBe(true);
    if (!Array.isArray(after.pace.series.householdSavings?.series)) {
      await gotoRoute(page, 'pace');
      await expect(page.locator(`figure.h-pchart[data-chart="${id}"]`)).toHaveCount(1);
    }
  });

  test('the Goals tab shows the same suggestion block, and Accept there saves it', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.cushion;
    const s = await fetchScenario(request);
    const rec = recordOf(s, id);
    await gotoRoute(page, 'goals');
    const gc = goalsCard(page, id);
    await expect(gc).toHaveCount(1);
    await expectCushionLine(gc, s, rec);
    await expectControls(gc, id);
    // The question on Goals: the ask with an Edit goal control.
    const tc = goalsCard(page, ids.tax);
    await expect(tc.locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`)).toContainText('What amount would make this real?');
    await expect(act(tc, ids.tax, 'edit')).toHaveText('Edit goal');

    const res = posted(page, `/api/goals/${id}`);
    await act(gc, id, 'accept').click();
    const r = await res;
    expect(r.status()).toBe(200);
    expect(r.request().postDataJSON()).toEqual(rec.accept);
    await expect(gc.locator('.h-sugg')).toHaveCount(0);
    await page.reload();
    await expect(goalsCard(page, id).locator('.h-sugg')).toHaveCount(0);
    expect((await fetchScenario(request)).goals.find((g) => g.id === id).target).toBe(rec.accept.target);
  });

  test('the suggested amount opens its provenance: the calculator, the window and the parameters', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request }) => {
    const ids = await zeroTargets(request);
    const id = ids.cushion;
    const s = await fetchScenario(request);
    const rec = recordOf(s, id);
    expect(s.src['calc:targets']?.label).toBe('Suggested target calculator');
    const f = s.fig[rec.figures.target];
    expect(f.src).toBe('calc:targets');
    expect(Array.isArray(f.notes) && f.notes.length > 0, 'the target figure carries notes').toBe(true);

    await gotoRoute(page, 'home');
    await page.waitForLoadState('networkidle');
    const amount = line(homeCard(page, id), id).locator(`.fx-fig[data-fig="${rec.figures.target}"]`);
    const source = page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v');
    await expect(async () => {
      if (!(await page.locator('.fx-pop').count())) await amount.click();
      await expect(source).toHaveText('Suggested target calculator', { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expectPopoverSource(page, 'Suggested target calculator');

    // An Assumes row names the spending window's months (abbreviated or full month names, or YYYY-MM).
    const assumes = await page.locator('.fx-pop .fx-pop-row', { hasText: 'Assumes' }).locator('.fx-pop-v').allTextContents();
    expect(assumes.length, 'the popover lists the notes as Assumes rows').toBe(f.notes.length);
    const names = (ym) => [monthAbbr(ym), ym];
    const namesWindow = (t) => names(rec.window.from).some((x) => t.includes(x)) && names(rec.window.to).some((x) => t.includes(x));
    expect(assumes.some(namesWindow), `an Assumes row names the window ${rec.window.from} to ${rec.window.to}: ${JSON.stringify(assumes)}`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fx-pop')).toHaveCount(0);
  });

  test('mixed: one targeted goal keeps the pace headline and bar; the others show their blocks', { tag: ['@tg-ac3', '@tg-ac4', '@mobile'] }, async ({ page, request }, testInfo) => {
    await resetDemo(request);
    await archiveSeedGoals(request);
    const s0 = await fetchScenario(request);
    const ids = {
      cushion: (await createGoal(request, targeted(s0, STARTERS.cushion))).id,
      work: (await createGoal(request, STARTERS.work)).id,
      tax: (await createGoal(request, STARTERS.tax)).id
    };
    const s = await fetchScenario(request);
    expect(recordOf(s, ids.cushion), 'a targeted goal gets no record').toBeUndefined();
    expect(recordOf(s, ids.work).state).toBe('suggested');
    expect(recordOf(s, ids.tax).state).toBe('question');

    await gotoRoute(page, 'home');
    await expect(h1(page)).toHaveText(s.pace.rollup.headline);
    await expect(home(page).locator('article.h-gcard[data-goal-card]')).toHaveCount(3);
    const tc = homeCard(page, ids.cushion);
    await expect(tc.locator('.h-pbar')).toHaveCount(1);
    await expect(tc.locator('.h-sugg')).toHaveCount(0);
    await expect(line(homeCard(page, ids.work), ids.work)).toHaveText(/^(Suggested|Already covered):/);
    await expectControls(homeCard(page, ids.work), ids.work);
    await expect(homeCard(page, ids.tax).locator(`div.h-sugg.ask[data-sugg="${ids.tax}"]`)).toContainText('What amount would make this real?');
    // One pending suggestion: no bulk actions.
    await expect(acceptAll(page)).toHaveCount(0);
    await expect(home(page)).not.toContainText('No goals with targets');
    await page.screenshot({ path: testInfo.outputPath(`home-mixed-${testInfo.project.name}.png`), fullPage: true });
  });

  test('all targeted: no suggestion blocks, no bulk actions, the pace headline', { tag: ['@tg-ac3', '@tg-ac4', '@mobile'] }, async ({ page, request }) => {
    await resetDemo(request);
    await archiveSeedGoals(request);
    const s0 = await fetchScenario(request);
    const ids = {
      cushion: (await createGoal(request, targeted(s0, STARTERS.cushion, 2))).id,
      work: (await createGoal(request, targeted(s0, STARTERS.work, 20))).id,
      tax: (await createGoal(request, targeted(s0, STARTERS.tax, 1.5))).id
    };
    const s = await fetchScenario(request);
    for (const id of Object.values(ids)) expect(recordOf(s, id), `${id} has a target, so no record`).toBeUndefined();

    await gotoRoute(page, 'home');
    await expect(h1(page)).toHaveText(s.pace.rollup.headline);
    await expect(home(page).locator('article.h-gcard[data-goal-card]')).toHaveCount(3);
    for (const id of Object.values(ids)) await expect(homeCard(page, id).locator('.h-pbar')).toHaveCount(1);
    await expect(home(page).locator('.h-sugg')).toHaveCount(0);
    await expect(acceptAll(page)).toHaveCount(0);
    await expect(reviewTargets(page)).toHaveCount(0);

    await gotoRoute(page, 'goals');
    await expect(page.locator('.h-sugg')).toHaveCount(0);
  });

  test('onboarding starters show their suggestion or question on Home right after saving', { tag: ['@tg-ac2', '@mobile'] }, async ({ page, request, hasTouch }) => {
    await resetDemo(request);
    await archiveSeedGoals(request);
    // No open goals: Home is the Goals step.
    await gotoRoute(page, 'home');
    const block = page.locator('[data-goals-start]');
    await expect(block).toBeVisible();
    await press(block.locator('button[data-goal-starter="cushion"]'), hasTouch);
    await press(block.locator('button[data-goal-starter="tax"]'), hasTouch);
    await expect(block.locator('button[data-goal-starter="cushion"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(block.locator('button[data-goal-starter="tax"]')).toHaveAttribute('aria-pressed', 'true');
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
    const rec = recordOf(s, cushion.id);
    expect(rec.state).toBe('suggested');

    // Right after saving, without a reload.
    await expect(homeCard(page, cushion.id)).toHaveCount(1);
    await expectCushionLine(homeCard(page, cushion.id), s, rec);
    await expectControls(homeCard(page, cushion.id), cushion.id);
    const ask = homeCard(page, tax.id).locator(`div.h-sugg.ask[data-sugg="${tax.id}"]`);
    await expect(ask).toContainText('What amount would make this real?');
    await expect(act(homeCard(page, tax.id), tax.id, 'edit')).toHaveText('Edit goal');
    await expect(home(page)).not.toContainText('No goals with targets');
  });
});
