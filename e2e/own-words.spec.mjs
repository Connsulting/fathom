// DMW-T5 on the demo build: every Confirm card carries one free-text box, "Or tell Fathom in your
// own words". Typing a sentence and pressing Tell Fathom opens Ask with that sentence as the owner's
// message, so the model can record it through answer.fact with a receipt and Undo. The sentence is
// synthetic.

import { test, expect, resetDemo, gotoRoute, deckCard } from './helpers.mjs';

const OWN_WORDS = 'Or tell Fathom in your own words';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('@ax-confirm a Confirm card sends the owner\'s own words to Ask', async ({ page, request }) => {
  const { items } = await (await request.get('/api/confirm')).json();
  expect(items.length, 'the demo seeds pending Confirm items').toBeGreaterThan(0);
  await gotoRoute(page, 'confirm');
  const card = deckCard(page);
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-item');
  const box = card.getByRole('textbox', { name: OWN_WORDS });
  await expect(box).toBeVisible();
  await expect(card.locator(`[data-own-words="confirm:${id}"]`)).toHaveCount(1);
  const send = card.getByRole('button', { name: 'Tell Fathom', exact: true });
  await expect(send).toBeVisible();

  const sentence = 'This account belongs to the spouse, Avery Example, and holds our everyday spending.';
  await box.fill(sentence);
  await send.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/ask/);
  await expect(page.locator('.h-msg.me', { hasText: sentence }).first()).toBeVisible();
});
