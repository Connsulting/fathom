// Goals-first Home (#/home, with #/brief as an alias) on the demo build: the pace rollup headline
// with its health chip, one card per live goal with its pace bar and next action (no quiet row),
// the desktop list of goal actions due before Dec 31, the housekeeping row, the owner filter, the
// data-health line that replaced the Year banner and the Confirm badge, and the phone next-thing
// card with Done, Later, Ask and swipes. Domain cards, What changed and the timeline live on Plan.
// Suggested targets have their own spec (e2e/goal-targets.spec.mjs); the demo's seed goals never
// get suggestions, so this spec sees none.
// Expected values come from GET /api/scenario (its pace block) at test time; amounts are never
// hard-coded. A small oracle below mirrors the contract's card order, due list and owner rules over
// the stored rec shape: owner, housekeeping and serves ([{ id, title, origin }]) on every rec.

import {
  test, expect, S, resetDemo, gotoRoute, plain, money, fetchScenario, recDialog, openRecFromPage,
  expectPopoverSource, bareDollarNodes, dataHealth, healthConfirm, questionsToConfirm
} from './helpers.mjs';

/* ---------- oracle ---------- */

const OPEN = ['proposed', 'doing'];
const CLOSED = ['hidden', 'done', 'dismissed'];
const WHO = { you: 'You', spouse: 'Spouse', both: 'Both', advisor: 'Advisor', automatic: 'Auto' };
const FILTER_OK = {
  both: () => true,
  me: (o) => o === 'you' || o === 'both',
  spouse: (o) => o === 'spouse' || o === 'both'
};
const servedIds = (r) => r.serves.map((g) => g.id);
// Counted like the server's live.housekeeping: housekeeping and not hidden, done or dismissed.
const isHousekeepingItem = (r) => r.housekeeping === true && !CLOSED.includes(r.status);
const daysOf = (r) => (r.window?.days != null && Number.isFinite(Number(r.window.days)) ? Number(r.window.days) : Infinity);
const byWindow = (a, b) => daysOf(a) - daysOf(b) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));

function fmtDay(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function daysToYearEnd(s) {
  const c = Date.parse(s.meta.clock + 'T00:00:00Z');
  return Math.round((Date.UTC(Number(s.meta.clock.slice(0, 4)), 11, 31) - c) / 86400000);
}
const thingsLabel = (n) => `${n} thing${n === 1 ? '' : 's'} before Dec 31`;
// The header sub line counts the due list. With nothing due it may read either "0 things before
// Dec 31" or "Nothing due before Dec 31" (the plan's wording for an empty queue).
async function expectSub(page, n) {
  const sub = page.locator('p.h-home-sub');
  if (n === 0) await expect(sub).toContainText(/(0 things|Nothing due) before Dec 31/);
  else await expect(sub).toContainText(thingsLabel(n));
}

function goalChip(p) {
  if (!p || p.status === 'no target') return { tone: 'mute', label: 'No target' };
  if (p.status === 'on pace') return { tone: 'ok', label: 'On pace' };
  if (p.status === 'ahead') return { tone: 'ok', label: p.timeGap || 'Ahead' };
  if (p.status === 'behind') return { tone: 'warn', label: p.timeGap || 'Behind' };
  return p.reason === 'stale_data' ? { tone: 'bad', label: 'Data stale' } : { tone: 'mute', label: 'Pace unknown' };
}

function healthChip(pace) {
  const n = (k) => Number(pace.rollup.counts[k]?.v ?? 0);
  if (n('behind') > 0) return { tone: 'warn', label: `${n('behind')} goal${n('behind') === 1 ? '' : 's'} behind` };
  if (n('unknown') > 0) {
    const stale = pace.goals.some((g) => g.status !== 'no target' && g.stale);
    return stale ? { tone: 'bad', label: 'Data stale' } : { tone: 'mute', label: 'Pace unknown' };
  }
  if (Number(pace.rollup.total?.v ?? 0) === 0) return { tone: 'mute', label: 'No targets yet' };
  return { tone: 'ok', label: 'On pace' };
}

const finiteV = (f) => f && typeof f.v === 'number' && Number.isFinite(f.v);
// A pace bar is drawn when target, actual and expected are finite and the target is positive.
const hasBar = (p) => !!p && finiteV(p.target) && finiteV(p.actual) && finiteV(p.expected) && p.target.v > 0;

function model(s, filter = 'both') {
  const recs = s.recs.filter((r) => OPEN.includes(r.status) && FILTER_OK[filter](r.owner)).sort(byWindow);
  const goals = s.goals.filter((g) => !g.archived && g.status !== 'done');
  const inPace = s.pace.goals.map((p) => goals.find((g) => g.id === p.id)).filter(Boolean);
  const order = [...inPace, ...goals.filter((g) => !inPace.includes(g))];
  const cards = order.map((g) => {
    const paceIndex = s.pace.goals.findIndex((p) => p.id === g.id);
    const pace = paceIndex < 0 ? null : s.pace.goals[paceIndex];
    const actions = recs.filter((r) => servedIds(r).includes(g.id));
    return { id: g.id, goal: g, pace, paceIndex, actions, next: actions[0] || null, bar: hasBar(pace) };
  });
  const counts = Object.fromEntries(Object.keys(FILTER_OK).map((f) => [f, s.recs.filter((r) => OPEN.includes(r.status) && FILTER_OK[f](r.owner)).length]));
  const yearEnd = daysToYearEnd(s);
  // Due: open goal actions (not housekeeping) for this filter with a window up to Dec 31.
  const due = recs.filter((r) => r.housekeeping !== true && daysOf(r) <= yearEnd);
  const nextThing = due[0] || recs.find((r) => r.housekeeping !== true) || null;
  const at = due.indexOf(nextThing);
  return {
    cards, counts, queue: recs, due, nextThing,
    afterThat: at >= 0 ? due.slice(at + 1, at + 4) : [],
    housekeeping: s.recs.filter((r) => isHousekeepingItem(r) && FILTER_OK[filter](r.owner)).sort(byWindow)
  };
}

/* ---------- page helpers ---------- */

const home = (page) => page.locator('section.h-home');
const h1 = (page) => page.locator('h1.h-home-h');
const chip = (page) => page.locator('a.h-hchip');
const fullCards = (page) => page.locator('section.h-home article.h-gcard[data-goal-card]');
const card = (page, id) => page.locator(`section.h-home article.h-gcard[data-goal-card="${id}"]`);
const ownerBtn = (page, f) => page.locator(`div.h-ownerf[role="group"][aria-label="Whose actions"] button[data-owner="${f}"]`);
const hk = (page) => page.locator('details.h-hk[data-det="home-hk"]');
const nextCard = (page) => page.locator('article.h-next');

async function openDetails(det) {
  await expect(det).toHaveCount(1);
  if ((await det.getAttribute('open')) == null) await det.locator('summary').click();
  await expect(det).toHaveAttribute('open', '');
}

async function statusOf(request, id) {
  return (await fetchScenario(request)).recs.find((r) => r.id === id)?.status;
}

async function setOwner(request, id, owner) {
  const res = await request.post(`/api/recs/${encodeURIComponent(id)}/action`, { headers: { 'content-type': 'application/json' }, data: { action: 'owner', arg: owner } });
  expect(res.status(), `owner ${id} -> ${owner}`).toBe(200);
}

/* ---------- desktop ---------- */

test.describe('Home', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('the default route is Home, headed by the pace rollup headline, with no next-thing card on desktop', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    await page.goto('/');
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(home(page)).toBeVisible();
    await expect(h1(page)).toHaveText(s.pace.rollup.headline);
    await expect(page).toHaveURL(/\/(#\/home)?$/);
    await expect(nextCard(page)).toHaveCount(0);
    await expect(page.locator('div.h-after')).toHaveCount(0);
  });

  test('#/brief is an alias that resolves to #/home', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    await page.goto('/#/brief');
    await expect(page).toHaveURL(/#\/home$/);
    await expect(h1(page)).toBeVisible();
    await expect(h1(page)).toHaveText(s.pace.rollup.headline);
  });

  test('the header shows the health chip linking to #/pace and the count of things before Dec 31', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const want = healthChip(s.pace);
    await gotoRoute(page, 'home');
    await expect(chip(page)).toHaveCount(1);
    await expect(chip(page)).toHaveAttribute('data-go', 'pace');
    await expect(chip(page)).toHaveAttribute('href', '#/pace');
    await expect(chip(page)).toHaveClass(new RegExp(`\\b${want.tone}\\b`));
    await expect(chip(page)).toContainText(want.label);
    await expectSub(page, model(s).due.length);
  });

  test('the health chip opens the pace board', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    await gotoRoute(page, 'home');
    await chip(page).click();
    await expect(page).toHaveURL(/#\/pace$/);
    await expect(page.getByRole('heading', { level: 1, name: s.pace.rollup.headline, exact: true })).toBeVisible();
    await expect(page.locator('p.h-pace-why')).toBeVisible();
  });

  test('goal cards carry a pace chip, a pace bar when the goal has a target, and the next action', { tag: ['@ac1', '@ac6'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const m = model(s);
    expect(m.cards.filter((c) => c.bar).length, 'the demo has goals with a pace bar').toBeGreaterThan(0);
    await gotoRoute(page, 'home');
    await expect(fullCards(page)).toHaveCount(m.cards.length);
    expect(await fullCards(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-goal-card')))).toEqual(m.cards.map((c) => c.id));

    // The goal cards come before the housekeeping row.
    const firstCard = await fullCards(page).first().boundingBox();
    const hkBox = await hk(page).boundingBox();
    expect(firstCard.y).toBeLessThan(hkBox.y);

    for (const c of m.cards) {
      const el = card(page, c.id);
      const p = c.pace;
      const want = goalChip(p);
      await expect(el.locator('a[data-go="goals"]').first()).toHaveText(plain(c.goal.title));
      const pchip = el.locator('span.h-pchip');
      await expect(pchip).toHaveText(want.label);
      await expect(pchip).toHaveClass(new RegExp(`\\b${want.tone}\\b`));
      // Seed goals never get a suggested target.
      await expect(el.locator('.h-sugg')).toHaveCount(0);

      // The bar draws actual and plan today over the target, muted when pace is not current.
      const bar = el.locator('div.h-pbar');
      if (!c.bar) {
        await expect(bar, `${c.id} has no target, so no bar`).toHaveCount(0);
      } else {
        await expect(bar).toHaveCount(1);
        const current = ['ahead', 'on pace', 'behind'].includes(p.status);
        if (current) await expect(bar).not.toHaveClass(/\bmuted\b/);
        else await expect(bar).toHaveClass(/\bmuted\b/);
        const clamp = (v) => Math.max(0, Math.min(1, v));
        const fill = clamp(p.actual.v / p.target.v);
        const tick = clamp(p.expected.v / p.target.v);
        const bb = await bar.boundingBox();
        const fb = await bar.locator('i.fill').boundingBox();
        const tb = await bar.locator('i.tick').boundingBox();
        expect(Math.abs(fb.width / bb.width - fill), `${c.id} fill ${fb.width}/${bb.width} vs ${fill}`).toBeLessThan(0.03);
        expect(Math.abs((tb.x + tb.width / 2 - bb.x) / bb.width - tick), `${c.id} tick vs ${tick}`).toBeLessThan(0.03);

        // Labels: actual of target, plan today, and the data date when stale. Figures are pace figures.
        const labels = el.locator('div.h-pbar-l');
        const i = c.paceIndex;
        for (const [k, f] of [['actual', p.actual], ['target', p.target], ['expected', p.expected]]) {
          const fig = labels.locator(`.fx-fig[data-fig="pace.goals.${i}.${k}"]`);
          await expect(fig, `${c.id} ${k}`).toHaveCount(1);
          await expect(fig).toHaveText(money(f.v, { k: true }));
        }
        await expect(labels).toContainText(' of ');
        await expect(labels).toContainText('plan today');
        if (p.stale) await expect(labels).toContainText(`as of ${fmtDay(p.dataThrough)}`);
      }

      // The next action: countdown, title link, owner tag.
      if (c.next) {
        const row = el.locator(`div.h-gnext[data-rec="${c.next.id}"]`);
        await expect(row).toHaveCount(1);
        await expect(row.locator('b').first()).toHaveText(String(Math.abs(daysOf(c.next))));
        await expect(row.locator(`a[data-go="rec"][data-id="${c.next.id}"]`)).toHaveText(plain(S.recs.find((r) => r.id === c.next.id)?.title ?? c.next.title));
        await expect(row.locator('span.h-who')).toHaveText(WHO[c.next.owner]);
      } else {
        await expect(el.locator('p.h-gnext-none')).toContainText('Nothing due for');
      }
    }
  });

  test('stale goals say Data stale and never On pace', { tag: ['@ac6'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const stale = model(s).cards.filter((c) => c.pace && c.pace.stale);
    expect(stale.length, 'the demo has stale goals').toBeGreaterThan(0);
    await gotoRoute(page, 'home');
    for (const c of stale) {
      await expect(card(page, c.id).locator('span.h-pchip')).toHaveText('Data stale');
      await expect(card(page, c.id).locator('span.h-pchip')).toHaveClass(/\bbad\b/);
      await expect(card(page, c.id)).not.toContainText('On pace');
    }
    if (healthChip(s.pace).label !== 'On pace') await expect(chip(page)).not.toContainText('On pace');
  });

  test('Home dollar figures are pace figures and open the provenance popover', { tag: ['@ac6'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    await gotoRoute(page, 'home');
    expect(await bareDollarNodes(page)).toEqual([]);
    // Every figure outside a rec title is a pace.* figure.
    const figs = home(page).locator('.fx-fig:not(a[data-go="rec"] .fx-fig)');
    expect(await figs.count()).toBeGreaterThan(0);
    const keys = await figs.evaluateAll((els) => els.map((e) => e.getAttribute('data-fig')));
    for (const k of keys) expect(k, 'figure key').toMatch(/^pace\./);
    await figs.first().click();
    await expectPopoverSource(page, s.src['calc:pace'].label);
  });

  test('a goal card next action opens its rec', { tag: ['@ac1'] }, async ({ page, request }) => {
    const c = model(await fetchScenario(request)).cards.find((x) => x.next);
    expect(c, 'a goal card with a next action').toBeTruthy();
    await gotoRoute(page, 'home');
    await openRecFromPage(page, c.next.id, `article.h-gcard[data-goal-card="${c.id}"] .h-gnext`);
  });

  test('every live goal has its own card, with no quiet row and no comma list of goals', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const m = model(s);
    const noTarget = s.pace.goals.filter((p) => p.status === 'no target').map((p) => p.id);
    expect(noTarget.length, 'the demo has goals without a target').toBeGreaterThan(0);
    for (const id of noTarget) {
      if (s.goals.some((g) => g.id === id && !g.archived && g.status !== 'done')) expect(m.cards.map((c) => c.id)).toContain(id);
    }
    await gotoRoute(page, 'home');
    await expect(page.locator('details.h-quiet')).toHaveCount(0);
    await expect(page.locator('[data-quiet-goal]')).toHaveCount(0);
    await expect(page.locator('.h-qi')).toHaveCount(0);
    await expect(fullCards(page)).toHaveCount(m.cards.length);
    for (const c of m.cards) {
      const el = card(page, c.id);
      await expect(el, `${c.id} has exactly one card`).toHaveCount(1);
      // Each card names exactly one goal.
      await expect(el.locator('a.h-gcard-t')).toHaveCount(1);
      await expect(el.locator('a.h-gcard-t')).toHaveText(plain(c.goal.title));
    }
    await expect(home(page)).not.toContainText('No goals with targets');
  });

  test('the due list shows the next goal actions before Dec 31 with date and owner, never housekeeping', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const m = model(s);
    expect(m.due.length, 'the demo has goal actions due before Dec 31').toBeGreaterThan(0);
    await gotoRoute(page, 'home');
    const list = home(page).locator('div.h-due');
    await expect(list).toHaveCount(1);
    await expect(list).toContainText('Due before Dec 31');
    const rows = list.locator('div.h-due-r[data-rec]');
    await expect(rows).toHaveCount(Math.min(5, m.due.length));
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-rec')));
    const dueIds = m.due.map((r) => r.id);
    const hkIds = m.housekeeping.map((r) => r.id);
    for (const id of ids) {
      expect(dueIds, `${id} is a due goal action`).toContain(id);
      expect(hkIds, `${id} is not housekeeping`).not.toContain(id);
      const r = m.due.find((x) => x.id === id);
      const row = list.locator(`div.h-due-r[data-rec="${id}"]`);
      await expect(row.locator('.h-due-d')).toBeVisible();
      await expect(row.locator('.h-due-d')).toHaveText(/\S/);
      await expect(row.locator(`a[data-go="rec"][data-id="${id}"]`)).toBeVisible();
      await expect(row.locator('.h-who')).toHaveText(WHO[r.owner]);
    }
    // Window order: no row is due later than the one after it.
    const days = ids.map((id) => daysOf(m.due.find((x) => x.id === id)));
    for (let i = 1; i < days.length; i++) expect(days[i], `row ${i} is not due before row ${i - 1}`).toBeGreaterThanOrEqual(days[i - 1]);
  });

  test('the housekeeping row counts the actions that serve no goal and expands to list them', { tag: ['@ac1'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const m = model(s);
    expect(m.housekeeping.length, 'the demo has housekeeping actions').toBeGreaterThan(0);
    expect(m.housekeeping.length, 'the oracle agrees with the server count').toBe(s.live.housekeeping);
    await gotoRoute(page, 'home');
    await expect(hk(page).locator('summary'), 'the Both count is the server count').toContainText(`Housekeeping, serves no goal: ${s.live.housekeeping}`);
    await openDetails(hk(page));
    const rows = hk(page).locator('.h-gnext[data-rec]');
    await expect(rows).toHaveCount(m.housekeeping.length);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-rec')))).toEqual(m.housekeeping.map((r) => r.id));
    for (const r of m.housekeeping) {
      const row = hk(page).locator(`.h-gnext[data-rec="${r.id}"]`);
      await expect(row.locator('b').first()).toHaveText(String(Math.abs(daysOf(r))));
      await expect(row.locator(`a[data-go="rec"][data-id="${r.id}"]`)).toBeVisible();
      await expect(row.locator('span.h-who')).toHaveText(WHO[r.owner]);
    }
  });

  test('the owner filter: Me hides the spouse-only action, Spouse hides the you-only one, counts match', { tag: ['@ac1'] }, async ({ page, request }) => {
    // Real owner writes: one open goal-linked rec goes to the spouse, another serving a different goal to you.
    const before = await fetchScenario(request);
    const linked = before.recs.filter((r) => OPEN.includes(r.status) && servedIds(r).length).sort(byWindow);
    const spouseRec = linked[0];
    const youRec = linked.find((r) => !servedIds(r).some((g) => servedIds(spouseRec).includes(g)));
    expect(spouseRec && youRec, 'two open recs serving different goals').toBeTruthy();
    try {
      await setOwner(request, spouseRec.id, 'spouse');
      await setOwner(request, youRec.id, 'you');
      const s = await fetchScenario(request);
      expect(s.recs.find((r) => r.id === spouseRec.id).owner).toBe('spouse');
      expect(s.recs.find((r) => r.id === youRec.id).owner).toBe('you');
      const mm = { both: model(s, 'both'), me: model(s, 'me'), spouse: model(s, 'spouse') };
      expect(mm.both.counts.both).toBe(model(before).counts.both);
      expect(mm.me.queue.map((r) => r.id)).not.toContain(spouseRec.id);
      expect(mm.spouse.queue.map((r) => r.id)).not.toContain(youRec.id);

      await gotoRoute(page, 'home');
      for (const f of ['both', 'me', 'spouse']) {
        await expect(ownerBtn(page, f)).toContainText({ both: 'Both', me: 'Me', spouse: 'Spouse' }[f]);
        await expect(ownerBtn(page, f).locator('span')).toHaveText(String(mm.both.counts[f]));
      }
      await expect(ownerBtn(page, 'both')).toHaveAttribute('aria-pressed', 'true');
      await expect(ownerBtn(page, 'me')).toHaveAttribute('aria-pressed', 'false');

      const shown = async (id) => {
        await openDetails(hk(page));
        return home(page).locator(`.h-gnext[data-rec="${id}"], .h-due-r[data-rec="${id}"]`).count();
      };
      const spouseGoal = servedIds(spouseRec)[0];
      expect(await shown(spouseRec.id), 'Both shows the spouse action').toBeGreaterThan(0);
      expect(await shown(youRec.id), 'Both shows your action').toBeGreaterThan(0);
      await expectSub(page, mm.both.due.length);

      await ownerBtn(page, 'me').click();
      await expect(ownerBtn(page, 'me')).toHaveAttribute('aria-pressed', 'true');
      await expect(ownerBtn(page, 'both')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => shown(spouseRec.id), 'Me hides the spouse-only action').toBe(0);
      expect(await shown(youRec.id), 'Me keeps your action').toBeGreaterThan(0);
      await expectSub(page, mm.me.due.length);
      const spouseCard = mm.me.cards.find((c) => c.id === spouseGoal);
      if (spouseCard && !spouseCard.next) await expect(card(page, spouseGoal).locator('p.h-gnext-none')).toContainText('Nothing due for');
      // Counts stay the same whichever filter is active.
      for (const f of ['both', 'me', 'spouse']) await expect(ownerBtn(page, f).locator('span')).toHaveText(String(mm.both.counts[f]));

      await ownerBtn(page, 'spouse').click();
      await expect(ownerBtn(page, 'spouse')).toHaveAttribute('aria-pressed', 'true');
      await expect(ownerBtn(page, 'me')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => shown(youRec.id), 'Spouse hides the you-only action').toBe(0);
      expect(await shown(spouseRec.id), 'Spouse keeps the spouse action').toBeGreaterThan(0);
      await expectSub(page, mm.spouse.due.length);

      await ownerBtn(page, 'both').click();
      await expect(ownerBtn(page, 'both')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => shown(youRec.id)).toBeGreaterThan(0);
    } finally {
      await resetDemo(request);
    }
  });

  test('the data-health line states the data date and staleness, with Confirm and Files links', { tag: ['@ac4'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const pending = (await (await request.get('/api/confirm')).json()).items.length;
    expect(pending, 'the demo seeds pending questions').toBeGreaterThan(0);
    const staleAccounts = s.accounts.filter((a) => a.fresh === 'stale').length;
    const staleGoals = s.pace.goals.filter((g) => g.stale).length;
    await gotoRoute(page, 'home');
    const line = dataHealth(page);
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('Data through');
    if (s.pace.rollup.dataThrough) await expect(line).toContainText(`Data through ${fmtDay(s.pace.rollup.dataThrough)}`);
    if (staleAccounts) await expect(line).toContainText(`${staleAccounts} account${staleAccounts === 1 ? '' : 's'} stale`);
    else if (staleGoals) await expect(line).toContainText(`pace data stale for ${staleGoals} goal${staleGoals === 1 ? '' : 's'}`);
    if (staleAccounts + staleGoals > 0) await expect(line).toHaveClass(/\bstale\b/);
    await expect(line).toContainText(questionsToConfirm(pending));
    await expect(line.locator('a[data-go="accounts"]')).toHaveText('Accounts');

    // It replaces the Year banner and the Confirm badge.
    await expect(page.locator('.h-ing-banner')).toHaveCount(0);
    await expect(page.locator('.h-nav-n')).toHaveCount(0);

    await expect(healthConfirm(page)).toHaveText('Confirm');
    await healthConfirm(page).click();
    await expect(page).toHaveURL(/#\/confirm$/);
    await expect(page.locator('.h-deck')).toBeVisible();
    await expect(page.locator('.h-nav-n')).toHaveCount(0);

    await gotoRoute(page, 'home');
    const files = dataHealth(page).locator('a[data-go="add"]');
    await expect(files).toHaveText('Files');
    await files.click();
    await expect(page).toHaveURL(/#\/add$/);
    await expect(page.locator('.h-nav-n')).toHaveCount(0);
  });

  test('domain cards, What changed and the timeline are on Plan, not Home', { tag: ['@ac5'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    await gotoRoute(page, 'home');
    await expect(home(page)).toBeVisible();
    for (const sel of ['.h-tl', '.h-doms', '.h-dom', '.h-evs', '.h-mailnote']) await expect(page.locator(sel), `${sel} on Home`).toHaveCount(0);

    await gotoRoute(page, 'plan');
    expect(s.domains.length).toBeGreaterThan(0);
    await expect(page.locator('.h-doms .h-dom')).toHaveCount(s.domains.length);
    for (const d of s.domains) await expect(page.locator('.h-doms .h-dom b', { hasText: plain(d.name) }).first()).toBeVisible();
    expect(s.events.length).toBeGreaterThan(0);
    await expect(page.locator('.h-evs li')).toHaveCount(s.events.length);
    expect((await page.locator('.h-evs li b').allTextContents()).map((t) => t.trim())).toEqual(s.events.map((e) => plain(e.title)));
    await expect(page.locator('.h-mailnote a[data-go="email"]')).toBeVisible();
    const tl = page.locator('.h-tl[data-tl="plan"]');
    await expect(tl).toBeVisible();
    expect(await tl.locator('circle.h-tl-ev').count(), 'past What changed events are dots on the Plan timeline').toBeGreaterThan(0);
  });
});

/* ---------- phone ---------- */

test.describe('Home on a phone', { tag: ['@mobile', '@mobile-only'] }, () => {
  test.beforeEach(async ({ request, page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await resetDemo(request);
  });

  const transformOf = (page) => nextCard(page).evaluate((el) => getComputedStyle(el).transform);
  const RESTING = /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/;

  // A one-finger horizontal drag on the next-thing card through CDP touch events, started on a
  // paragraph with no link or button in it (the why-now text). With `follow`, it waits before
  // lifting the finger until the card is visibly displaced.
  async function drag(page, cdp, dx, { follow = false, steps = 10 } = {}) {
    const why = nextCard(page).locator('p').filter({ hasNot: page.locator('a, button') }).first();
    await why.scrollIntoViewIfNeeded();
    const qb = await why.boundingBox();
    const x = Math.round(qb.x + Math.min(qb.width / 2, 120));
    const y = Math.round(qb.y + qb.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x + (dx * i) / steps), y, id: 1 }] });
    }
    if (follow) {
      await expect.poll(() => transformOf(page), { message: 'the card follows the finger' }).not.toMatch(RESTING);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  // The next card is the first due goal action, else the first goal action at all; never housekeeping.
  async function expectNext(page, request) {
    const m = model(await fetchScenario(request));
    expect(m.nextThing, 'a goal action is open').toBeTruthy();
    await expect(nextCard(page)).toHaveAttribute('data-next-rec', m.nextThing.id);
    return m;
  }

  test('the next-thing card shows the most urgent goal action with Done, Later and Ask, then After that', { tag: ['@ac2'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const m = model(s);
    const r = m.nextThing;
    expect(r, 'a goal action is open').toBeTruthy();
    expect(r.housekeeping, 'the next card is never housekeeping').not.toBe(true);
    await gotoRoute(page, 'home');
    await expect(nextCard(page)).toHaveCount(1);
    await expect(nextCard(page)).toHaveAttribute('data-next-rec', r.id);
    const demo = S.recs.find((x) => x.id === r.id);
    await expect(nextCard(page).locator('h2')).toHaveText(plain(demo.title));
    await expect(nextCard(page).locator('h2 a')).toHaveCount(1);
    await expect(nextCard(page)).toContainText(String(Math.abs(daysOf(r))));
    const serves = nextCard(page).locator('p.h-serves-l');
    if (servedIds(r).length) {
      await expect(serves).toContainText('Serves');
      await expect(serves.locator('a[data-go="goals"]')).toHaveCount(servedIds(r).length);
    } else {
      await expect(serves).toHaveText('Housekeeping, serves no goal');
    }
    await expect(nextCard(page).locator(`button[data-act="complete"][data-rec="${r.id}"]`)).toHaveText('Done');
    const later = nextCard(page).locator(`button[data-act="snooze"][data-rec="${r.id}"]`);
    await expect(later).toHaveText('Later');
    await expect(later).toHaveAttribute('data-arg', /\S/);
    await expect(nextCard(page).locator(`button[data-ask-next="${r.id}"]`)).toHaveText('Ask');
    await expect(home(page)).toContainText('Swipe left for later, right for done');

    const after = page.locator('div.h-after');
    await expect(after).toContainText('After that');
    const ids = await after.locator('a[data-go="rec"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(ids).toEqual(m.afterThat.map((x) => x.id));
    expect(ids.length, 'at least the next three actions show with the next card').toBe(Math.min(3, Math.max(0, m.due.length - 1)));
    for (const x of m.afterThat) {
      const row = after.locator(`div.h-after-r[data-rec="${x.id}"]`);
      await expect(row.locator('.h-after-d')).toHaveText(/\S/);
      await expect(row.locator('span.h-who')).toHaveText(WHO[x.owner]);
    }

    // Phone order: owner filter, headline, next thing, After that, data-health line, goal cards.
    const tops = [];
    for (const loc of [page.locator('div.h-ownerf'), h1(page), nextCard(page), after, dataHealth(page), fullCards(page).first()]) {
      tops.push((await loc.boundingBox()).y);
    }
    for (let i = 1; i < tops.length; i++) expect(tops[i], `element ${i} sits below element ${i - 1}: ${tops.join(', ')}`).toBeGreaterThan(tops[i - 1]);
  });

  test('Done completes the next thing and the card moves to the next action', { tag: ['@ac2'] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const m = await expectNext(page, request);
    const id = m.nextThing.id;
    await nextCard(page).locator(`button[data-act="complete"][data-rec="${id}"]`).click();
    await expect.poll(() => statusOf(request, id)).toBe('done');
    await expect(nextCard(page)).not.toHaveAttribute('data-next-rec', id);
    await expectNext(page, request);
  });

  test('Later snoozes the next thing and the card moves to the next action', { tag: ['@ac2'] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const m = await expectNext(page, request);
    const id = m.nextThing.id;
    await nextCard(page).locator(`button[data-act="snooze"][data-rec="${id}"]`).click();
    await expect.poll(() => statusOf(request, id)).toBe('snoozed');
    await expect(nextCard(page)).not.toHaveAttribute('data-next-rec', id);
    await expectNext(page, request);
  });

  test('Ask on the next thing opens its conversation, or the rec with its composer focused', { tag: ['@ac2'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    const id = model(s).nextThing.id;
    const thread = (s.live.threads || []).find((t) => t && t.recId === id && !t.trashedAt && !t.recDetachedAt);
    await gotoRoute(page, 'home');
    await nextCard(page).locator(`button[data-ask-next="${id}"]`).click();
    if (thread) {
      await expect(page).toHaveURL(new RegExp(`#/ask/${thread.id}$`));
    } else {
      await expect(recDialog(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/rec/${id}$`));
      await expect(page.locator(`[data-draft="rec:${id}"]`)).toBeFocused();
    }
  });

  test('swipe right marks the next thing done', { tag: ['@ac2'] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const id = (await expectNext(page, request)).nextThing.id;
    const cdp = await page.context().newCDPSession(page);
    await drag(page, cdp, 160, { follow: true });
    await expect.poll(() => statusOf(request, id)).toBe('done');
    await expect(nextCard(page)).not.toHaveAttribute('data-next-rec', id);
  });

  test('swipe left puts the next thing off until later', { tag: ['@ac2'] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const id = (await expectNext(page, request)).nextThing.id;
    const cdp = await page.context().newCDPSession(page);
    await drag(page, cdp, -160, { follow: true });
    await expect.poll(() => statusOf(request, id)).toBe('snoozed');
    await expect(nextCard(page)).not.toHaveAttribute('data-next-rec', id);
  });

  test('a short drag springs back and changes nothing', { tag: ['@ac2'] }, async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const id = (await expectNext(page, request)).nextThing.id;
    const posts = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/recs/')) posts.push(new URL(r.url()).pathname);
    });
    const cdp = await page.context().newCDPSession(page);
    await drag(page, cdp, 20);
    await expect.poll(() => transformOf(page), { message: 'the card springs back' }).toMatch(RESTING);
    await page.waitForTimeout(300);
    await expect(nextCard(page)).toHaveAttribute('data-next-rec', id);
    expect(posts).toEqual([]);
    expect(OPEN, 'the rec is still open').toContain(await statusOf(request, id));
  });

  test('at most one card per goal above the fold, and no horizontal scroll', { tag: ['@ac2'] }, async ({ page }) => {
    await gotoRoute(page, 'home');
    await expect(nextCard(page)).toBeVisible();
    const above = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('[data-goal-card]')) {
        if (!el.checkVisibility()) continue;
        if (el.getBoundingClientRect().top >= window.innerHeight) continue;
        const id = el.getAttribute('data-goal-card');
        out[id] = (out[id] || 0) + 1;
      }
      return out;
    });
    for (const [id, n] of Object.entries(above)) expect(n, `cards for ${id} above the fold`).toBeLessThanOrEqual(1);
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
    expect(widths.doc, 'no horizontal page scroll on #/home').toBeLessThanOrEqual(widths.inner);
    expect(widths.body).toBeLessThanOrEqual(widths.inner);
    await expect(page.locator('.h-nav-n')).toHaveCount(0);
  });

  test('with nothing open the next-thing card says so', { tag: ['@ac2'] }, async ({ page, request }) => {
    const s = await fetchScenario(request);
    for (const r of s.recs.filter((x) => OPEN.includes(x.status))) {
      const res = await request.post(`/api/recs/${encodeURIComponent(r.id)}/action`, { headers: { 'content-type': 'application/json' }, data: { action: 'complete' } });
      expect(res.status(), `complete ${r.id}`).toBe(200);
    }
    await gotoRoute(page, 'home');
    await expect(nextCard(page)).toHaveCount(0);
    await expect(page.locator('div.h-next-empty')).toContainText('Nothing open for');
    await expectSub(page, 0);
  });
});
