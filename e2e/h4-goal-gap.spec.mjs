// H4 AC3: a goal gap shows with its working control. An owner goal with a target and a target date
// and nothing tracking it shows "Nothing tracks this goal yet." on its Home card beside a "Choose
// what tracks it" button; the button opens the goal's edit form on Goals with the "Track with" field
// focused. The target date comes from the scenario clock read at test time. Desktop width only.

import { test, expect, resetDemo, gotoRoute, fetchScenario } from './helpers.mjs';

test.describe('H4 goal gap', () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  test('a goal with nothing tracking it offers a control that opens its editor on the track field', async ({ page, request }) => {
    const scenario = await fetchScenario(request);
    const year = Number(scenario.meta.clock.slice(0, 4));
    const res = await request.post('/api/goals', { headers: { 'content-type': 'application/json' },
      data: { title: 'Synthetic boat fund', target: 20000, targetDate: `${year + 2}-12-31` } });
    expect(res.status(), 'POST /api/goals').toBe(200);
    const { goal } = await res.json();
    expect(goal.track ?? null, 'the goal tracks nothing').toBeNull();

    await gotoRoute(page, 'home');
    const card = page.locator(`section.h-home article.h-gcard[data-goal-card="${goal.id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Nothing tracks this goal yet.');
    const fix = card.getByRole('button', { name: 'Choose what tracks it', exact: true });
    await expect(fix).toHaveCount(1);
    await expect(fix).toBeVisible();

    await fix.click();
    await expect(page).toHaveURL(/#\/goals(?:[/?]|$)/);
    const form = page.locator('form[aria-label="Edit goal"]');
    await expect(form).toBeVisible();
    await expect(form.locator('[data-gf="title"]')).toHaveValue('Synthetic boat fund');
    await expect(form.locator('[data-gf="track"]')).toBeFocused();
  });
});
