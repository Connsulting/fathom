// Engine screen (item 6): the monthly cap is editable and stored, invalid caps are refused with
// the error toast, and the Recent spend ledger lists real model calls (purpose, model, cost as a
// figure) without any prompt contents.

import { test, expect, S, resetDemo, usd, plain, gotoRoute, expectH1, askOnAsk } from './helpers.mjs';

const TOO_HIGH = 20000; // above the 10000 ceiling the cap API accepts

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

function monthly(page) {
  return page.locator('.h-eng-sum .fx-fig[data-fig="engine.budget.monthly"]');
}

async function saveCap(page, value) {
  const form = page.locator('form.h-cap');
  await expect(form).toBeVisible();
  await form.locator('input[name="usd"]').fill(String(value));
  await form.getByRole('button', { name: 'Save cap', exact: true }).click();
}

test('editing the cap persists across reload and changes the monthly figure', async ({ page }) => {
  const before = Number(S.engine.budget.monthly);
  const next = Math.round((before + 75.5) * 100) / 100;

  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  await expect(monthly(page)).toHaveText(usd(before));
  const input = page.locator('form.h-cap input[name="usd"]');
  await expect(input).toHaveAttribute('type', 'number');
  await expect(input).toHaveAttribute('step', '0.01');
  await expect(input).toHaveAttribute('min', '0');
  await expect(input).toHaveAttribute('max', '10000');

  await saveCap(page, next);
  await expect(monthly(page)).toHaveText(usd(next));
  await expect(page.locator('.fx-err')).toHaveCount(0);

  await page.reload();
  await expectH1(page, 'Running');
  await expect(monthly(page)).toHaveText(usd(next));
});

test('an invalid cap shows the error toast and leaves the cap unchanged', async ({ page }) => {
  const before = Number(S.engine.budget.monthly);

  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  await saveCap(page, TOO_HIGH);
  await expect(page.locator('.fx-err')).toBeVisible();
  await expect(monthly(page)).toHaveText(usd(before));

  await page.reload();
  await expect(monthly(page)).toHaveText(usd(before));
});

test('after an Ask, Recent spend lists a chat row with a cost figure and no prompt text', async ({ page }) => {
  const q = S.ask.suggested[0];

  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  await expect(page.getByRole('heading', { level: 2, name: 'Recent spend', exact: true })).toBeVisible();
  const rows = page.locator('.h-ledger .h-ledger-r');
  const before = await rows.count();

  await gotoRoute(page, 'ask');
  await askOnAsk(page, plain(q.q));
  const answer = page.locator('.h-thread .h-msg.fathom').last();
  await expect(answer).toBeVisible();
  await expect(answer).not.toHaveClass(/\bnotice\b/);
  const answerText = (await answer.locator('.h-msg-b').innerText()).trim();

  await gotoRoute(page, 'engine');
  await expect(page.getByRole('heading', { level: 2, name: 'Recent spend', exact: true })).toBeVisible();
  await expect.poll(() => rows.count()).toBeGreaterThan(before);

  const chat = rows.filter({ hasText: /\bchat\b/ }).first();
  await expect(chat).toBeVisible();
  const cost = chat.locator('.fx-fig');
  await expect(cost).toHaveCount(1);
  await expect(cost).toHaveAttribute('data-fig', /^engine\.ledger\.[^.]+\.cost$/);

  // Rows carry time, purpose, model and cost only, never what was asked or answered.
  const text = (await page.locator('.h-ledger').innerText());
  expect(text).not.toContain(plain(q.q));
  expect(text).not.toContain(answerText.slice(0, 40));
  for (const marker of ['household_summary', 'knowledge_packs', 'conversation_context', '<', '{']) {
    expect(text, `ledger text contains ${marker}`).not.toContain(marker);
  }
});
