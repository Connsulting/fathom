// Goal model v2 on the demo build, at desktop (1440) and phone (390) width: the goal form creates a
// contribution goal (whose goal, priority, amount, tax year, deadline, a destination account, both
// shares, then per-person amounts that appear without reopening the form) and a floor tracking an
// account; Home shows both cards with whose-goal and priority tags, the kind lines and chips that
// follow the API pace entries, in priority order, with no bare dollar amount and no horizontal
// overflow; Mark done takes a goal off Home and shows it as Done on Goals, and Reopen brings it
// back; a Plan row lists served goals by priority with a priority tag. Expected values come from
// GET /api/scenario at test time; names come from the scenario, never from code.

import { test, expect, resetDemo, gotoRoute, expectH1, money, fetchScenario, bareDollarNodes } from './helpers.mjs';

const TAGS = { tag: ['@mobile'] };
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const RANK = { high: 0, medium: 1, low: 2 };
const rank = (p) => RANK[p] ?? 3;

// Whose-goal label from the scenario names, with the plan's neutral fallbacks.
function personLabel(id, names = {}) {
  if (id === 'owner') return names.me || 'You';
  if (id === 'spouse') return names.spouse || 'Your spouse';
  if (id === 'joint') return 'Joint';
  if (/^kid\d{0,2}$/.test(id || '')) return names[id] || 'Your child';
  return '';
}

// The Home chip for a pace entry, per kind (plan S3 item 1.2 on top of the balance mapping).
function chipFor(p) {
  if (p?.kind === 'floor' && p.floor?.state === 'breached') return 'Below floor';
  if (p?.kind === 'floor' && p.status === 'on pace') return 'Holding';
  if (p?.kind === 'range' && ['ahead', 'on pace'].includes(p.status) && p.range?.position === 'in') return 'In range';
  if (p?.kind === 'range' && ['ahead', 'on pace'].includes(p.status) && p.range?.position === 'above') return 'Above range';
  if (!p || p.status === 'no target') return 'No target';
  const gap = p.timeGap && p.timeGap !== 'On pace' ? p.timeGap : null;
  if (p.status === 'ahead') return gap || 'Ahead';
  if (p.status === 'on pace') return 'On pace';
  if (p.status === 'behind') return gap || 'Behind';
  return p.reason === 'stale_data' ? 'Data stale' : 'Pace unknown';
}

const form = (page) => page.locator('form.h-gform');
const gf = (page, name) => form(page).locator(`[data-gf="${name}"]`);
const homeCard = (page, id) => page.locator(`section.h-home article.h-gcard[data-goal-card="${id}"]`);
const goalsCard = (page, id) => page.locator(`article.h-goal[data-goal-id="${id}"]`);
const posted = (page, path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST' && r.status() === 200);

async function gotoGoals(page) {
  await gotoRoute(page, 'goals');
  await expectH1(page, 'Where you are headed');
}

async function openNewGoal(page) {
  await page.getByRole('button', { name: 'Goal', exact: true }).click();
  await expect(form(page)).toBeVisible();
}

async function noHorizontalOverflow(page, what) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${what} has no horizontal overflow`).toBeLessThanOrEqual(0);
}

async function attach(page, info, name) {
  const width = page.viewportSize()?.width ?? 0;
  await info.attach(`${name}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

// Fill a field and leave it, so its change event fires (the form redraws on change, not on input).
async function enter(page, name, value) {
  const el = gf(page, name);
  await el.fill(value);
  await el.press('Tab');
}

test.describe('goal kinds', TAGS, () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  test('create a contribution goal and a floor in the editor and see them on Home, then mark one done', async ({ page, request }, info) => {
    const before = await fetchScenario(request);
    const names = before.names || {};
    await gotoGoals(page);

    // Contribution: kind first (the form redraws its kind block), then the common and kind fields.
    await openNewGoal(page);
    await gf(page, 'kind').selectOption('contribution');
    await expect(form(page).getByLabel(/Amount to contribute/)).toBeVisible();
    await expect(form(page).getByLabel(/Target amount/)).toHaveCount(0, { timeout: 2000 });
    await gf(page, 'title').fill('Synthetic HSA top up');
    await gf(page, 'owner').selectOption('joint');
    await gf(page, 'priority').selectOption('high');
    await expect(gf(page, 'owner').locator('option')).toContainText([personLabel('owner', names), personLabel('spouse', names), 'Joint']);
    await enter(page, 'target', '6000');
    await enter(page, 'taxYear', '2026');
    await enter(page, 'targetDate', '2027-04-15');
    const dest = before.accounts.find((a) => a.kind === 'roth') || before.accounts[0];
    await form(page).locator(`input[data-gf="dest"][value="${dest.id}"]`).check();
    await expect(gf(page, 'enteredOwner')).toHaveCount(0);
    await enter(page, 'shareOwner', '3000');
    await enter(page, 'shareSpouse', '3000');
    // The per-person amounts appear in the same open form once a share is set.
    await expect(gf(page, 'enteredOwner')).toBeVisible();
    await expect(gf(page, 'enteredSpouse')).toBeVisible();
    await expect(gf(page, 'shareOwner')).toHaveValue('3000', { timeout: 2000 });
    await enter(page, 'enteredOwner', '1500');
    await enter(page, 'enteredSpouse', '1000');
    await enter(page, 'enteredAsOf', '2026-11-01');
    await expect(gf(page, 'title')).toHaveValue('Synthetic HSA top up');
    await expect(gf(page, 'priority')).toHaveValue('high');
    await noHorizontalOverflow(page, 'the goal editor');
    await attach(page, info, 'editor-contribution');
    let post = posted(page, '/api/goals');
    await form(page).getByRole('button', { name: 'Save goal' }).click();
    const contrib = (await (await post).json()).goal;
    await expect(form(page)).toHaveCount(0);
    expect(contrib).toMatchObject({ kind: 'contribution', owner: 'joint', priority: 'high', status: 'open', target: 6000, taxYear: 2026,
      targetDate: '2027-04-15', accounts: [dest.id] });
    expect(contrib.split).toEqual([{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 3000 }]);
    expect(contrib.entered).toEqual({ asOf: '2026-11-01', people: [{ person: 'owner', amount: 1500 }, { person: 'spouse', amount: 1000 }] });

    // Floor tracking the household checking account.
    await openNewGoal(page);
    await gf(page, 'kind').selectOption('floor');
    await expect(form(page).getByLabel(/Floor amount/)).toBeVisible();
    await gf(page, 'title').fill('Personal checking floor');
    await enter(page, 'floor', '3000');
    await gf(page, 'track').selectOption('accounts');
    await expect(gf(page, 'track').locator('option', { hasText: 'Nothing yet' })).toHaveCount(0);
    await form(page).locator('input[data-gf="acct"][value="a_personal"]').check();
    await gf(page, 'owner').selectOption('owner');
    await gf(page, 'priority').selectOption('medium');
    await attach(page, info, 'editor-floor');
    post = posted(page, '/api/goals');
    await form(page).getByRole('button', { name: 'Save goal' }).click();
    const floor = (await (await post).json()).goal;
    expect(floor).toMatchObject({ kind: 'floor', owner: 'owner', priority: 'medium', floor: 3000, track: { accounts: ['a_personal'] } });

    // Home: both cards, tags, chips and kind lines from the API pace entries.
    const s = await fetchScenario(request);
    const entry = (id) => ({ p: s.pace.goals.find((x) => x.id === id), i: s.pace.goals.findIndex((x) => x.id === id) });
    await gotoRoute(page, 'home');
    for (const [g, ownerId, pri] of [[contrib, 'joint', 'high'], [floor, 'owner', 'medium']]) {
      const card = homeCard(page, g.id);
      await expect(card).toHaveCount(1);
      await expect(card.locator('[data-goal-owner]')).toHaveText(personLabel(ownerId, s.names));
      await expect(card.locator('[data-goal-priority]')).toHaveText(PRIORITY_LABEL[pri]);
      const { p } = entry(g.id);
      expect(p, `${g.id} has a pace entry`).toBeTruthy();
      await expect(card.locator('span.h-pchip')).toHaveText(chipFor(p));
    }
    const f = entry(floor.id);
    expect(f.p.kind).toBe('floor');
    expect(f.p.target.v).toBe(3000);
    const floorLine = homeCard(page, floor.id).locator('.h-gkind');
    await expect(floorLine.locator(`.fx-fig[data-fig="pace.goals.${f.i}.target"]`)).toHaveText(money(3000, { k: true }));
    await expect(floorLine).toContainText(f.p.floor.state === 'breached' ? 'below floor' : 'holding');

    const c = entry(contrib.id);
    expect(c.p.kind).toBe('contribution');
    expect(c.p.contribution.basis).toBe('entered');
    expect(c.p.actual.v).toBe(2500);
    const cc = homeCard(page, contrib.id);
    await expect(cc.locator(`.fx-fig[data-fig="pace.goals.${c.i}.actual"]`).first()).toHaveText(money(2500, { k: true }));
    await expect(cc.locator(`.fx-fig[data-fig="pace.goals.${c.i}.target"]`).first()).toHaveText(money(6000, { k: true }));
    await expect(cc.locator('.h-gkind')).toContainText('For 2026');
    await expect(cc.locator('.h-gkind')).toContainText('As you entered');
    const people = cc.locator('.h-gpeople');
    await expect(people).toContainText(personLabel('owner', s.names));
    await expect(people).toContainText(personLabel('spouse', s.names));
    await expect(people.locator(`.fx-fig[data-fig="pace.goals.${c.i}.contribution.people.0.actual"]`)).toHaveText(money(1500, { k: true }));
    await expect(people.locator(`.fx-fig[data-fig="pace.goals.${c.i}.contribution.people.1.target"]`)).toHaveText(money(3000, { k: true }));

    // Priority order: every high card before every medium, low and unset card.
    const order = await page.locator('section.h-home article.h-gcard[data-goal-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-goal-card')));
    const prio = (id) => rank(s.goals.find((g) => g.id === id)?.priority);
    expect(order.map(prio), `cards ${order.join(', ')}`).toEqual([...order.map(prio)].sort((a, b) => a - b));
    expect(order.indexOf(contrib.id)).toBeLessThan(order.indexOf(floor.id));

    expect(await bareDollarNodes(page)).toEqual([]);
    await noHorizontalOverflow(page, 'Home');
    await attach(page, info, 'home');

    // Mark done on the Goals card: it leaves Home and reads Done on Goals.
    await gotoGoals(page);
    post = posted(page, `/api/goals/${contrib.id}`);
    await goalsCard(page, contrib.id).getByRole('button', { name: 'Mark done' }).click();
    await post;
    await expect(goalsCard(page, contrib.id).locator('.h-goal-h span')).toHaveText('Done');
    await expect(goalsCard(page, contrib.id).getByRole('button', { name: 'Reopen' })).toBeVisible();
    await gotoRoute(page, 'home');
    await expect(homeCard(page, floor.id)).toHaveCount(1);
    await expect(homeCard(page, contrib.id)).toHaveCount(0);
    const after = await fetchScenario(request);
    expect(after.goals.find((g) => g.id === contrib.id)?.status).toBe('done');
    expect(after.pace.goals.some((p) => p.id === contrib.id)).toBe(false);
  });

  test('mark done from the editor takes a goal off Home; Reopen on Goals brings it back', async ({ page, request }, info) => {
    const res = await request.post('/api/goals', { headers: { 'content-type': 'application/json' }, data: { title: 'Synthetic boat fund', priority: 'low' } });
    expect(res.status()).toBe(200);
    const id = (await res.json()).goal.id;
    await gotoRoute(page, 'home');
    await expect(homeCard(page, id)).toHaveCount(1);
    await expect(homeCard(page, id).locator('[data-goal-priority]')).toHaveText('Low');
    await expect(homeCard(page, id).locator('[data-goal-owner]')).toHaveCount(0);

    await gotoGoals(page);
    await goalsCard(page, id).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form(page)).toBeVisible();
    await attach(page, info, 'editor-edit');
    let post = posted(page, `/api/goals/${id}`);
    await form(page).getByRole('button', { name: 'Mark done' }).click();
    await post;
    await expect(form(page)).toHaveCount(0);
    await expect(goalsCard(page, id).locator('.h-goal-h span')).toHaveText('Done');
    await expect(goalsCard(page, id).getByRole('button', { name: 'Mark done' })).toHaveCount(0);
    await gotoRoute(page, 'home');
    await expect(homeCard(page, id)).toHaveCount(0);

    await gotoGoals(page);
    post = posted(page, `/api/goals/${id}`);
    await goalsCard(page, id).getByRole('button', { name: 'Reopen' }).click();
    await post;
    await expect(goalsCard(page, id).locator('.h-goal-h span')).not.toHaveText('Done');
    await gotoRoute(page, 'home');
    await expect(homeCard(page, id)).toHaveCount(1);
  });

  test('a Plan row lists the goals it serves by priority with a priority tag', async ({ page, request }, info) => {
    const s = await fetchScenario(request);
    const goalOf = (id) => s.goals.find((g) => g.id === id);
    // The demo floor goal (high priority) tracks business cash, so a cash rec serves it.
    const r = s.recs.find((x) => ['proposed', 'doing'].includes(x.status) && x.serves.some((g) => goalOf(g.id)?.priority));
    if (!r) {
      // No open demo rec serves a prioritized goal, so there is no Serves tag to check.
      test.skip(true, 'no open demo rec serves a prioritized goal');
      return;
    }
    const best = [...r.serves].sort((a, b) => rank(goalOf(a.id)?.priority) - rank(goalOf(b.id)?.priority))[0];
    await gotoRoute(page, 'plan');
    const row = page.locator('article.h-row', { has: page.locator(`a[data-id="${r.id}"]`) }).first();
    const serves = row.locator('.h-serves');
    await expect(serves).toContainText('Serves:');
    await expect(serves.locator('a[data-go="goals"]').first()).toHaveText(new RegExp(goalOf(best.id).title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{n:[a-z]+\\\}/g, '.+')));
    await expect(serves.locator('[data-serve-priority]').first()).toHaveText(PRIORITY_LABEL[goalOf(best.id).priority]);
    await expect(serves.locator('[data-serve-priority]')).toHaveCount(r.serves.filter((g) => goalOf(g.id)?.priority).length);
    expect(await bareDollarNodes(page)).toEqual([]);
    await noHorizontalOverflow(page, 'Plan');
    await attach(page, info, 'plan-serves');
  });
});
