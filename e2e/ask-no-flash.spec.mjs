// ST2: Ask never shows a draft that is later replaced. While an answer is in flight the pending
// block shows only the work block (steps, interim notes); no answer text streams into it. The
// delivered answer appears once, with a short fade-in (class h-reveal on its .h-msg-b, a CSS
// animation under 400 ms) that is off under prefers-reduced-motion. Stored draft notes from
// before regenerations stopped keeping the first attempt are not rendered, and the "Earlier
// draft" tag is gone.
//
// A recorder installed before navigation watches every mutation: the text of the newest answer
// body, its computed animation at first appearance, the steps the pending block showed, and
// whether streamed text or a draft tag ever existed. The demo's fake engine echoes the two
// invented amounts in INVENTED, so the first answer is regenerated once.

import { openScope } from '../src/storage/index.mjs';
import { test, expect, REMOTE, resetDemo, gotoRoute, ASK_THREAD_URL, askInput } from './helpers.mjs';
import { householdStoreFile, localDataDir } from './local-store.mjs';

const STORE = async () => await householdStoreFile(localDataDir());
const INVENTED = 'Is 4,321 or 5,432 the right amount for this?';
const QUICK = 'Give me a quick read on where the household stands right now';
const STEP_REVISED = 'Revised to remove 2 unchecked figures';
const DRAFT_NOTE = 'Synthetic earlier attempt that was replaced.';

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

async function installRecorder(page) {
  await page.addInitScript(() => {
    const log = { texts: [], first: null, stream: false, draftTag: false, liveAmounts: false, steps: [] };
    window.__nfLog = log;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const look = () => {
      const body = document.body;
      if (!body) return;
      if (body.querySelector('.h-askx-stream')) log.stream = true;
      if (/Earlier draft/.test(body.textContent)) log.draftTag = true;
      for (const live of body.querySelectorAll('.h-askx-pend .h-askx-live')) {
        if (/4,?321|5,?432/.test(live.textContent)) log.liveAmounts = true;
      }
      for (const li of body.querySelectorAll('.h-askx-pend .h-work-items li.step')) {
        const t = txt(li);
        if (t && !log.steps.includes(t)) log.steps.push(t);
      }
      const answers = body.querySelectorAll('.h-askx-msgs .h-msg.fathom .h-msg-b');
      const el = answers[answers.length - 1];
      const t = txt(el);
      if (!t) return;
      if (log.texts[log.texts.length - 1] !== t) log.texts.push(t);
      if (!log.first) {
        const cs = getComputedStyle(el);
        log.first = { animation: cs.animationName, duration: cs.animationDuration, opacity: cs.opacity, reveal: el.classList.contains('h-reveal') };
      }
    };
    const start = () => {
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-expanded'] });
      look();
    };
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', start, { once: true });
  });
}

const nfLog = (page) => page.evaluate(() => window.__nfLog);
const askMain = (page) => page.locator('section.h-askx-main');

async function askAndLand(page, text) {
  await page.evaluate(() => document.fonts.ready);
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
  await expect(page).toHaveURL(ASK_THREAD_URL, { timeout: 30_000 });
  const answer = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);
  await expect(askMain(page).locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);
  return answer;
}

// Seconds from a computed animation-duration ('0.3s' or '300ms').
const seconds = (d) => (String(d).endsWith('ms') ? parseFloat(d) / 1000 : parseFloat(d));

test('@mobile @st2 a corrected answer is set exactly once', async ({ page }) => {
  test.setTimeout(120_000);
  await installRecorder(page);
  await gotoRoute(page, 'ask');
  const answer = await askAndLand(page, INVENTED);
  const shown = (await answer.locator('.h-msg-b').textContent()).replace(/\s+/g, ' ').trim();

  const log = await nfLog(page);
  const ctx = JSON.stringify(log);
  expect(log.stream, `no streamed answer text ever showed: ${ctx}`).toBe(false);
  expect(log.draftTag, `"Earlier draft" never showed: ${ctx}`).toBe(false);
  expect(log.liveAmounts, `the draft amounts never showed in the pending block: ${ctx}`).toBe(false);
  expect(log.steps, ctx).toContain(STEP_REVISED);
  // The answer text was set once and never changed after it first appeared.
  expect(log.texts, ctx).toEqual([shown]);
  expect(shown).toMatch(/4,321/);
  // It arrived with the fade-in reveal, under 400 ms.
  expect(log.first, ctx).not.toBeNull();
  expect(log.first.reveal, ctx).toBe(true);
  expect(log.first.animation, ctx).not.toBe('none');
  expect(seconds(log.first.duration), ctx).toBeGreaterThan(0);
  expect(seconds(log.first.duration), ctx).toBeLessThanOrEqual(0.4);
  // The reveal settles to a fully visible answer.
  await expect.poll(() => answer.locator('.h-msg-b').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('@mobile @st2 reduced motion shows the final text without animation', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installRecorder(page);
  await gotoRoute(page, 'ask');
  const answer = await askAndLand(page, INVENTED);
  const shown = (await answer.locator('.h-msg-b').textContent()).replace(/\s+/g, ' ').trim();

  const log = await nfLog(page);
  const ctx = JSON.stringify(log);
  expect(log.stream, `no streamed answer text ever showed: ${ctx}`).toBe(false);
  expect(log.draftTag, ctx).toBe(false);
  expect(log.texts, ctx).toEqual([shown]);
  expect(log.first, ctx).not.toBeNull();
  expect(log.first.animation, ctx).toBe('none');
  expect(log.first.opacity, ctx).toBe('1');
});

test('@mobile @st2 a stored draft note is not rendered and no draft tag shows', async ({ page, request }) => {
  test.skip(REMOTE, 'edits the local demo store; BASE_URL targets a remote server');
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text: QUICK } });
  expect(res.status()).toBe(200);
  const { thread } = await res.json();
  const read = async () => {
    const r = await request.get(`/api/threads/${thread.id}`);
    expect(r.status()).toBe(200);
    return (await r.json()).messages.filter((m) => m.role === 'fathom').pop();
  };
  const stored = await read();
  const steps = stored.provenance.work.items.filter((x) => x.k === 'step').map((x) => x.label);
  // A message stored before regenerations stopped keeping the first attempt carries a draft note.
  const db = await openScope({ path: await STORE(), journal: null, busyTimeout: 5000 });
  try {
    const id = Number(String(stored.id).replace(/^m/, ''));
    const row = await db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id);
    const prov = JSON.parse(row.provenance);
    prov.work.items.splice(1, 0, { k: 'note', text: DRAFT_NOTE, draft: true });
    await db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify(prov), id);
  } finally {
    await db.close();
  }
  expect((await read()).provenance.work.items.some((x) => x.draft)).toBe(true);

  await gotoRoute(page, `ask/${thread.id}`);
  const msg = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(msg).toBeVisible();
  const row = msg.locator('.h-work button.h-work-row');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const items = msg.locator('.h-work-body .h-work-items');
  await expect(items).toHaveCount(1);
  await expect(items.locator('li.step span')).toHaveText(steps);
  await expect(items.locator('li.note')).toHaveCount(0);
  await expect(page.locator('li.note.draft, .h-work-tag')).toHaveCount(0);
  await expect(page.getByText('Earlier draft')).toHaveCount(0);
  await expect(page.getByText(DRAFT_NOTE)).toHaveCount(0);
});

// The panel's new conversation: the reveal must survive the thread being adopted after the send.
const PANEL = 'aside#h-askp.h-askp';

async function installPanelRecorder(page) {
  await page.addInitScript((sel) => {
    const log = { texts: [], first: [] };
    window.__npLog = log;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const look = () => {
      const els = document.querySelectorAll(sel);
      const el = els[els.length - 1];
      const t = txt(el);
      if (!t) return;
      if (log.texts[log.texts.length - 1] !== t) {
        log.texts.push(t);
        const cs = getComputedStyle(el);
        log.first.push({ text: t, className: el.className, animation: cs.animationName, reveal: el.classList.contains('h-reveal') });
      }
    };
    const start = () => {
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
      look();
    };
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', start, { once: true });
  }, `${PANEL} .h-msg.fathom .h-msg-b`);
}

test('@st2 a new conversation\'s first answer in the Ask panel fades in', async ({ page }) => {
  test.setTimeout(120_000);
  await installPanelRecorder(page);
  await gotoRoute(page, 'home');
  const launcher = page.locator('button.h-askp-launch');
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  const input = panel.locator('form.h-askx-compose textarea[name="q"]');
  await expect(input).toBeFocused();
  await page.evaluate(() => document.fonts.ready);
  await input.fill(QUICK);
  await input.press('Enter');
  const answer = panel.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.h-askx-pend')).toHaveCount(0);
  await expect(panel.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);
  const shown = (await answer.locator('.h-msg-b').textContent()).replace(/\s+/g, ' ').trim();

  const log = await page.evaluate(() => window.__npLog);
  const ctx = JSON.stringify(log);
  expect(log.texts, `answer text set exactly once: ${ctx}`).toEqual([shown]);
  expect(log.first, ctx).toHaveLength(1);
  expect(log.first[0].reveal, ctx).toBe(true);
  expect(log.first[0].animation, ctx).toBe('h-reveal');
});

test('@st2 an earlier pack answer never fades again when a new answer arrives', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const log = { armed: false, revealed: [] };
    window.__npk = log;
    const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    const look = () => {
      if (!log.armed) return;
      for (const el of document.querySelectorAll('.h-msg.fathom .h-msg-b.h-reveal')) {
        const t = txt(el);
        if (t && !log.revealed.includes(t)) log.revealed.push(t);
      }
    };
    const start = () => {
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    };
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', start, { once: true });
  });
  await gotoRoute(page, 'packs/giving');
  await page.getByRole('button', { name: 'What if', exact: true }).click();
  const packAnswer = page.locator('.h-thread .h-msg.fathom');
  await expect(packAnswer).toHaveCount(1);
  const packBody = packAnswer.first().locator('.h-msg-b');
  await expect(packBody).not.toHaveText('');
  await expect(packAnswer.first().locator('details.h-src')).toHaveCount(1);
  const packText = (await packBody.textContent()).replace(/\s+/g, ' ').trim();
  // Let the pack answer's own reveal window (400 ms) pass before the ask is recorded.
  await expect(packBody).not.toHaveClass(/\bh-reveal\b/, { timeout: 5_000 });
  await page.evaluate(() => { window.__npk.armed = true; });

  // Ask a new question in the panel beside the pack.
  await page.locator('button.h-askp-launch').click();
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  const input = panel.locator('form.h-askx-compose textarea[name="q"]');
  await expect(input).toBeFocused();
  await input.fill(QUICK);
  await input.press('Enter');
  const fresh = panel.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(fresh).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.h-askx-pend')).toHaveCount(0);
  const freshText = (await fresh.locator('.h-msg-b').textContent()).replace(/\s+/g, ' ').trim();
  expect(freshText).not.toBe(packText);
  // Let the reveal window close so every late re-render is recorded too.
  await page.waitForTimeout(700);

  const log = await page.evaluate(() => window.__npk);
  const ctx = JSON.stringify({ log, packText, freshText });
  expect(log.revealed, `only the new answer is ever revealed: ${ctx}`).toEqual([freshText]);
  expect(log.revealed, ctx).not.toContain(packText);
  await expect(packBody).not.toHaveClass(/\bh-reveal\b/);
});
