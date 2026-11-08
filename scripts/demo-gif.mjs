// README demo recording for Fathom.
//
// Starts the demo build through scripts/demo-server.mjs (a wiped .e2e-data-gif data directory, the
// real server in demo mode, the fake engine, the scenario's own November clock), drives it with
// headless Chromium from @playwright/test while the Chrome screencast records every repaint, and
// writes one 30 to 45 second cut in two forms:
//
//   docs/images/demo.gif   1280x720, 12 to 15 fps, palette optimized, under 10 MB
//   docs/images/demo.mp4   1920x1080, H.264, yuv420p, faststart, no audio
//
// The story: Home, a recommendation, Ask with a sourced figure, and one Confirm card answered with
// Fathom's best guess. No war game or decision card: the demo build never runs the planner, so
// their figures would not be calculator output. A drawn cursor and caption pills are annotation
// injected for the recording; they are not product UI.
//
// Run:   node scripts/demo-gif.mjs --port <n> [--out <dir>]     (or DEMO_GIF_PORT=<n>)
// A port is required and must be free; pick your own, one no other agent or test run is using.
// --out defaults to docs/images. Frames go to a temp directory that is removed at the end.
// Check: node scripts/demo-gif.mjs --check [--out <dir>]   starts nothing and validates the two
// files (GIF size, width, aspect, duration and fps; MP4 duration and codec). The record path runs
// the same check and exits nonzero on failure.
// Needs Chromium for Playwright (npx playwright install chromium) and the pinned
// @ffmpeg-installer/ffmpeg devDependency.
//
// Only synthetic demo data is shown (demo/ scenario). Still look at frames from the MP4 before
// committing: right screen per beat, legible text, nothing non-synthetic, no real time of day.

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA = '.e2e-data-gif';
const USAGE = 'node scripts/demo-gif.mjs --port <n> [--out <dir>] | --check [--out <dir>]';
const CLI = { portEnv: 'DEMO_GIF_PORT', usage: USAGE, values: ['out'], flags: ['check'] };

export const VIEWPORT = { width: 1280, height: 720 };
export const SCALE = 1.5; // 1920x1080 screencast frames
export const MP4_FPS = 30;
export const GIF_FPS = [15, 12]; // first try, then the fallback when the first is too big

export const LIMITS = {
  gif: { minWidth: 1200, maxWidth: 1280, aspect: 16 / 9, aspectTolerance: 0.05, maxBytes: 10 * 1024 * 1024, minSeconds: 30, maxSeconds: 45, minFps: 12, maxFps: 15 },
  mp4: { minSeconds: 30, maxSeconds: 45, codec: 'h264', width: 1920, height: 1080 },
  // GIF delays are whole centiseconds, so a 15 fps encode averages a hair off 15.
  fpsSlack: 0.1
};

/* ---------- pure helpers (exported for test/demo-gif.test.mjs) ---------- */

// Walks a GIF: the logical screen size from the header, one frame per image descriptor, and the
// duration as the sum of the Graphic Control Extension delays (centiseconds).
export function parseGif(buf) {
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error(`not a GIF (signature ${JSON.stringify(sig)})`);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  const need = (n) => { if (p + n > buf.length) throw new Error(`GIF truncated at byte ${p}`); };
  const skipSubBlocks = () => {
    for (;;) {
      need(1);
      const len = buf[p++];
      if (len === 0) return;
      need(len);
      p += len;
    }
  };
  let frames = 0;
  let delayCs = 0;
  for (;;) {
    need(1);
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      need(1);
      const label = buf[p++];
      if (label === 0xf9) {
        need(6);
        delayCs += buf.readUInt16LE(p + 2);
        p += 1 + buf[p];
      }
      skipSubBlocks();
    } else if (b === 0x2c) {
      need(9);
      const local = buf[p + 8];
      p += 9;
      if (local & 0x80) p += 3 * (1 << ((local & 0x07) + 1));
      need(1);
      p += 1; // LZW minimum code size
      skipSubBlocks();
      frames++;
    } else {
      throw new Error(`unexpected GIF block 0x${b.toString(16)} at byte ${p - 1}`);
    }
  }
  const seconds = delayCs / 100;
  return { width, height, frames, delayCs, seconds, fps: seconds > 0 ? frames / seconds : 0 };
}

// Reads duration, codec and size from `ffmpeg -i <file>` stderr.
export function parseFfmpegInfo(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const v = /Stream #\S+.*?Video:\s*(\w+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  return {
    seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    codec: v ? v[1] : null,
    width: v ? Number(v[2]) : null,
    height: v ? Number(v[3]) : null
  };
}

// Problems with the measured outputs against LIMITS; empty when both pass.
export function checkMeasures({ gif, mp4 }, limits = LIMITS) {
  const out = [];
  const g = limits.gif;
  const m = limits.mp4;
  const s = (n) => n.toFixed(2);
  if (gif.bytes >= g.maxBytes) out.push(`GIF is ${(gif.bytes / 1048576).toFixed(2)} MB, must be under ${g.maxBytes / 1048576} MB`);
  if (gif.width < g.minWidth || gif.width > g.maxWidth) out.push(`GIF width ${gif.width} is outside ${g.minWidth} to ${g.maxWidth}`);
  const aspect = gif.height ? gif.width / gif.height : 0;
  if (Math.abs(aspect / g.aspect - 1) > g.aspectTolerance) out.push(`GIF aspect ${gif.width}x${gif.height} is not within 5 percent of 16:9`);
  if (gif.seconds < g.minSeconds || gif.seconds > g.maxSeconds) out.push(`GIF duration ${s(gif.seconds)} s is outside ${g.minSeconds} to ${g.maxSeconds} s`);
  if (gif.fps < g.minFps - limits.fpsSlack || gif.fps > g.maxFps + limits.fpsSlack) out.push(`GIF average fps ${s(gif.fps)} is outside ${g.minFps} to ${g.maxFps}`);
  if (mp4.seconds == null || mp4.seconds < m.minSeconds || mp4.seconds > m.maxSeconds) out.push(`MP4 duration ${mp4.seconds == null ? 'unknown' : s(mp4.seconds)} s is outside ${m.minSeconds} to ${m.maxSeconds} s`);
  if (mp4.codec !== m.codec) out.push(`MP4 codec is ${mp4.codec}, expected ${m.codec}`);
  if (mp4.width !== m.width || mp4.height !== m.height) out.push(`MP4 is ${mp4.width}x${mp4.height}, expected ${m.width}x${m.height}`);
  return out;
}

// An ffconcat list from screencast frames ({ file, ts } with ts in seconds). The screencast only
// emits on repaint, so each frame lasts until the next one and the last is held until `stopTs`.
// Frames that share a timestamp keep only the later one. The last file is listed twice because the
// concat demuxer ignores the final duration otherwise.
export function concatList(frames, stopTs, minLast = 1 / MP4_FPS) {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const kept = sorted.filter((f, i) => i === sorted.length - 1 || sorted[i + 1].ts > f.ts);
  if (!kept.length) throw new Error('no frames were captured');
  const q = (f) => `file '${f.replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  kept.forEach((f, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].ts : Math.max(stopTs, f.ts + minLast);
    lines.push(q(f.file), `duration ${(next - f.ts).toFixed(6)}`);
  });
  lines.push(q(kept[kept.length - 1].file));
  const total = Math.max(stopTs, kept[kept.length - 1].ts + minLast) - kept[0].ts;
  return { text: lines.join('\n') + '\n', seconds: total, frames: kept.length };
}

export function mp4Args(list, out) {
  return [
    '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${MP4_FPS},scale=${VIEWPORT.width * SCALE}:${VIEWPORT.height * SCALE}:flags=lanczos`,
    '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(MP4_FPS),
    out
  ];
}

export function gifArgs(list, out, fps) {
  return [
    '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${fps},scale=${VIEWPORT.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0',
    out
  ];
}

/* ---------- ffmpeg ---------- */

async function ffmpegPath() {
  return (await import('@ffmpeg-installer/ffmpeg')).default.path;
}

function run(bin, args, { allowFail = false } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-20000); });
    child.on('error', rej);
    child.on('exit', (code) => {
      if (code !== 0 && !allowFail) rej(new Error(`ffmpeg exited ${code}:\n${err.slice(-2000)}`));
      else res(err);
    });
  });
}

async function measure(dir) {
  const gifFile = join(dir, 'demo.gif');
  const mp4File = join(dir, 'demo.mp4');
  const gif = { ...parseGif(readFileSync(gifFile)), bytes: statSync(gifFile).size };
  statSync(mp4File);
  const mp4 = parseFfmpegInfo(await run(await ffmpegPath(), ['-hide_banner', '-i', mp4File], { allowFail: true }));
  return { gif, mp4 };
}

async function check(dir) {
  const m = await measure(dir);
  console.log(`demo.gif ${m.gif.width}x${m.gif.height}, ${(m.gif.bytes / 1048576).toFixed(2)} MB, ${m.gif.seconds.toFixed(2)} s, ${m.gif.frames} frames, ${m.gif.fps.toFixed(2)} fps`);
  console.log(`demo.mp4 ${m.mp4.width}x${m.mp4.height}, ${m.mp4.codec}, ${m.mp4.seconds?.toFixed(2)} s`);
  const problems = checkMeasures(m);
  if (problems.length) throw new Error(`check failed:\n  ${problems.join('\n  ')}`);
  console.log('check passed');
  return m;
}

/* ---------- recording overlay ---------- */

// Runs in every document before the app: a drawn cursor that follows mousemove, a click ring on
// mousedown, a caption pill, and the reply clock hidden. Annotation only; nothing touches the app.
function overlayInit() {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; z-index: 2147483647;
        transform: translate(-100px, -100px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.55)); }
      #demo-ring { position: fixed; left: 0; top: 0; width: 38px; height: 38px; margin: -19px 0 0 -19px; border-radius: 50%;
        border: 2px solid #3ecfaa; background: rgba(62,207,170,.18); pointer-events: none; z-index: 2147483646; opacity: 0; }
      #demo-ring.on { animation: demo-ring .5s ease-out forwards; }
      @keyframes demo-ring { from { opacity: .95; transform: scale(.3); } to { opacity: 0; transform: scale(1.35); } }
      #demo-caption { position: fixed; left: 20px; bottom: 20px; max-width: calc(100vw - 140px); pointer-events: none; z-index: 2147483645;
        display: flex; align-items: center; gap: 9px; padding: 8px 15px 8px 12px; border-radius: 999px;
        background: rgba(12,14,16,.88); border: 1px solid rgba(62,207,170,.38); color: #e9edf0;
        font: 500 15px/1.25 'Instrument Sans', system-ui, sans-serif; letter-spacing: .005em;
        box-shadow: 0 6px 20px rgba(0,0,0,.45); opacity: 0; transform: translateY(6px);
        transition: opacity .32s ease, transform .32s ease; white-space: nowrap; }
      #demo-caption::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #3ecfaa; flex: none; }
      #demo-caption.on { opacity: 1; transform: none; }
      .h-msg-who time { visibility: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 2v16.2l4.4-4.1 3.1 6.6 2.9-1.3-3.1-6.5h6.2z" fill="#fff" stroke="#0b0d0f" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.id = 'demo-ring';
    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    document.documentElement.append(ring, cursor, caption);
    // The arrow tip is at (3, 2) in the SVG.
    addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      ring.classList.remove('on');
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      void ring.offsetWidth;
      ring.classList.add('on');
    }, true);
    let timer = null;
    window.__demoCaption = (text) => {
      clearTimeout(timer);
      const show = () => {
        if (!text) return;
        caption.textContent = text;
        caption.classList.add('on');
      };
      if (caption.classList.contains('on')) {
        caption.classList.remove('on');
        timer = setTimeout(show, 340);
      } else show();
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

/* ---------- screencast ---------- */

async function startScreencast(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  let last = null;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const local = Date.now() / 1000;
    const ts = typeof metadata?.timestamp === 'number' ? metadata.timestamp : local;
    const file = `f${String(frames.length).padStart(6, '0')}.png`;
    frames.push({ file, ts });
    last = { ts, local };
    writes.push(writeFile(join(dir, file), Buffer.from(data, 'base64')));
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE });
  return {
    async stop() {
      const stopLocal = Date.now() / 1000;
      await cdp.send('Page.stopScreencast');
      await Promise.all(writes);
      await cdp.detach().catch(() => {});
      if (!last) throw new Error('the screencast produced no frames');
      // The frame clock may not be the wall clock; carry the stop time over through the last frame.
      return { frames, stopTs: last.ts + (stopLocal - last.local) };
    }
  };
}

/* ---------- driving ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function driver(page, errors) {
  const pos = { x: 0, y: 0 };
  let t0 = null;
  const d = {
    beats: [],
    hold: (ms) => sleep(ms),
    // Marks the start of a beat, in seconds from the first beat, for picking review frames.
    beat(name) {
      if (t0 == null) t0 = Date.now();
      d.beats.push({ name, at: (Date.now() - t0) / 1000 });
    },
    assertClean(where) {
      if (errors.length) throw new Error(`${where}: page error: ${errors.join('; ')}`);
    },
    async caption(text) {
      await page.evaluate((t) => window.__demoCaption(t), text);
    },
    // Eased glide with a slight arc, about 30 mouse events; never a jump.
    async glide(x, y, ms = 750) {
      const x0 = pos.x;
      const y0 = pos.y;
      const dist = Math.hypot(x - x0, y - y0);
      const steps = Math.max(10, Math.round(ms / 25));
      const bow = Math.min(60, dist * 0.08);
      const nx = dist ? -(y - y0) / dist : 0;
      const ny = dist ? (x - x0) / dist : 0;
      const t0 = Date.now();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = ease(t);
        const arc = Math.sin(Math.PI * t) * bow;
        await page.mouse.move(x0 + (x - x0) * e + nx * arc, y0 + (y - y0) * e + ny * arc);
        const wait = t0 + (ms * i) / steps - Date.now();
        if (wait > 0) await sleep(wait);
      }
      pos.x = x;
      pos.y = y;
    },
    async place(x, y) {
      await page.mouse.move(x, y);
      pos.x = x;
      pos.y = y;
    },
    async boxOf(locator, what) {
      await locator.waitFor({ state: 'visible' });
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${what}: no bounding box`);
      if (box.y + box.height / 2 < 0 || box.y + box.height / 2 > VIEWPORT.height) throw new Error(`${what}: off screen at y=${Math.round(box.y)}`);
      return box;
    },
    async hover(locator, what, ms = 750, dx = 0.5) {
      const b = await d.boxOf(locator, what);
      await d.glide(b.x + b.width * dx, b.y + b.height / 2, ms);
    },
    async click(locator, what, ms = 750, dx = 0.5) {
      await d.hover(locator, what, ms, dx);
      await sleep(140);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
    },
    // Eased scroll of the window (selector null) or an element, over `ms`, to `top` px.
    async scrollTo(selector, top, ms = 750) {
      const ok = await page.evaluate(async ({ selector, top, ms }) => {
        const el = selector ? document.querySelector(selector) : document.scrollingElement;
        if (!el) return false;
        const from = el.scrollTop;
        const to = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
        const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const t0 = performance.now();
        await new Promise((done) => {
          const step = (now) => {
            const t = Math.min(1, (now - t0) / ms);
            el.scrollTop = from + (to - from) * e(t);
            if (t < 1) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        });
        return true;
      }, { selector, top, ms });
      if (!ok) throw new Error(`scroll target ${selector} not found`);
    },
    async scrollBy(selector, dy, ms = 750) {
      const top = await page.evaluate((s) => (s ? document.querySelector(s) : document.scrollingElement)?.scrollTop ?? 0, selector);
      await d.scrollTo(selector, top + dy, ms);
    }
  };
  return d;
}

const CAPTIONS = {
  home: 'Home: what needs you, by when, and who',
  rec: 'A recommendation: why now, the window, your figures, the steps',
  ask: 'Ask in plain language. Every figure is sourced.',
  confirm: 'Confirm what Fathom inferred in one tap',
  end: 'Fathom, on a synthetic demo household'
};

// Answers, through the API, every pending card except the transaction cards carrying Fathom's
// guess, so the deck opens on one of those and moves on to another or to All answered. The account
// cards are answered too: in the demo build they show the source's raw name tokens. Returns the id
// of the first card the deck will show.
async function prepareConfirm(base, api, postJson) {
  const { items } = await api(base, '/api/confirm');
  const { live } = await api(base, '/api/scenario');
  const order = live.ingest.items.map((i) => i.id);
  const guessed = new Set(live.ingest.items.filter((i) => i.guess).map((i) => i.id));
  const pending = [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const target = pending.find((i) => i.kind === 'transaction_category' && guessed.has(i.id));
  if (!target) throw new Error('confirm: no pending transaction card with a Fathom guess');
  for (const it of pending) {
    if (it.kind === 'transaction_category' && guessed.has(it.id)) continue;
    const opt = it.options.find((o) => !o.id.startsWith('always:'));
    if (!opt) throw new Error(`confirm: item ${it.id} has no plain option`);
    await postJson(base, `/api/confirm/${it.id}/answer`, { answer: opt.id });
  }
  return target.id;
}

async function story(page, d) {
  const nav = (name) => page.locator(`header.h-top nav.h-nav a[data-go="${name}"]`);

  // Beat 1: Home.
  d.beat('home');
  await d.caption(CAPTIONS.home);
  await d.hold(1000);
  const rows = page.locator('section.h-home a[data-go="rec"][data-id]');
  const n = Math.min(3, await rows.count());
  if (n < 2) throw new Error('home: fewer than 2 due rows');
  for (let i = 0; i < n; i++) await d.hover(rows.nth(i), `home row ${i + 1}`, i ? 480 : 750, 0.35);
  await d.hold(400);
  await d.glide(640, 520, 500);
  await d.scrollBy(null, 330, 850);
  await d.hold(2200);
  await d.scrollTo(null, 0, 750);
  d.assertClean('home');

  // Beat 2: a recommendation.
  d.beat('rec');
  await d.click(page.locator('section.h-home a[data-go="rec"][data-id="offcycle"]'), 'home offcycle row', 700, 0.3);
  const dlg = page.locator('.h-dlg[role="dialog"]');
  await dlg.waitFor({ state: 'visible' });
  await page.waitForURL(/#\/rec\/offcycle$/);
  await d.caption(CAPTIONS.rec);
  await d.hold(400);
  // The dialog's right padding: nothing under the cursor changes while the body scrolls.
  await d.glide(1152, 420, 600);
  await d.hold(1700);
  await d.scrollBy('.h-dlg-body', 330, 850);
  await d.hold(2200);
  await d.click(dlg.locator('button.h-dlg-x'), 'dialog close', 700);
  await dlg.waitFor({ state: 'detached' });
  d.assertClean('recommendation');

  // Beat 3: Ask.
  d.beat('ask');
  await d.click(nav('ask'), 'Ask nav', 700);
  const input = page.locator('form.h-askx-compose textarea[name="q"]');
  await input.waitFor({ state: 'visible' });
  await d.caption(CAPTIONS.ask);
  await d.click(input, 'ask input', 650, 0.3);
  await input.pressSequentially('Can we push the fixed-fee invoices into January?', { delay: 45 });
  await d.hold(250);
  await input.press('Enter');
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await page.locator('.h-askx-pend').waitFor({ state: 'detached' });
  const fig = answer.locator('.fx-fig').first();
  await fig.waitFor({ state: 'visible' });
  await d.hold(1100);
  await d.click(fig, 'answer figure', 700);
  await page.locator('.fx-pop').waitFor({ state: 'visible' });
  await d.hold(2800);
  await page.keyboard.press('Escape');
  await page.locator('.fx-pop').waitFor({ state: 'hidden' });
  d.assertClean('ask');

  // Beat 4: Confirm.
  d.beat('confirm');
  await d.click(nav('home'), 'Home nav', 700);
  await page.locator('section.h-home h1').waitFor({ state: 'visible' });
  await d.caption(CAPTIONS.confirm);
  await d.hold(300);
  await d.click(page.locator('section.h-home a.h-dh-link[data-go="confirm"]'), 'confirm link', 650);
  const card = page.locator('article.h-deck-card.cur');
  await card.waitFor({ state: 'visible' });
  const take = card.locator('button[data-take-guess]');
  await take.waitFor({ state: 'visible' });
  await d.hold(1600);
  const progress = await page.locator('[data-deck-progress]').textContent();
  await d.click(take, 'Use best guess', 650);
  await page.waitForFunction((p) => document.querySelector('[data-deck-progress]')?.textContent !== p, progress);
  await d.hold(2000);
  d.assertClean('confirm');

  // End: Home.
  d.beat('end');
  await d.click(page.locator('header.h-top a.h-mark'), 'Fathom wordmark', 700);
  await page.locator('section.h-home h1').waitFor({ state: 'visible' });
  await d.caption(CAPTIONS.end);
  await d.glide(900, 470, 700);
  await d.hold(1800);
  d.assertClean('end');
}

async function record(port, outDir) {
  const { chromium } = await import('@playwright/test');
  const srv = await import('./demo-server.mjs');
  const ffmpeg = await ffmpegPath();
  const work = mkdtempSync(join(tmpdir(), 'fathom-demo-gif-'));
  process.on('exit', () => rmSync(work, { recursive: true, force: true }));
  srv.installCleanup('demo-gif');
  const frameDir = join(work, 'frames');
  mkdirSync(frameDir);
  try {
    const base = await srv.startDemo(port, DATA);
    await srv.resetDemo(base);
    await prepareConfirm(base, srv.api, srv.postJson);

    const browser = await chromium.launch({ headless: true });
    let shot;
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: 'dark', reducedMotion: 'no-preference',
        timezoneId: 'UTC', locale: 'en-US', bypassCSP: true
      });
      context.setDefaultTimeout(15_000);
      await context.addInitScript(overlayInit);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const d = driver(page, errors);

      await page.goto(`${base}/#/home`);
      await page.locator('section.h-home h1').waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await d.place(820, 470);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      d.assertClean('home load');

      const cast = await startScreencast(page, frameDir);
      await story(page, d);
      shot = await cast.stop();
      console.log(`beats: ${d.beats.map((b) => `${b.name} ${b.at.toFixed(1)}s`).join(', ')}`);
      await context.close();
    } finally {
      await browser.close();
    }
    await srv.stopServer();

    const list = concatList(shot.frames, shot.stopTs);
    console.log(`captured ${shot.frames.length} frames over ${list.seconds.toFixed(2)} s (${(shot.frames.length / list.seconds).toFixed(1)} fps average)`);
    const listFile = join(frameDir, 'list.ffconcat');
    await writeFile(listFile, list.text);

    const mp4 = join(work, 'demo.mp4');
    await run(ffmpeg, mp4Args(listFile, mp4));
    let gif = null;
    for (const fps of GIF_FPS) {
      gif = join(work, 'demo.gif');
      await run(ffmpeg, gifArgs(listFile, gif, fps));
      const size = statSync(gif).size;
      console.log(`gif at ${fps} fps: ${(size / 1048576).toFixed(2)} MB`);
      if (size < LIMITS.gif.maxBytes) break;
      if (fps === GIF_FPS[GIF_FPS.length - 1]) throw new Error(`the GIF is ${(size / 1048576).toFixed(2)} MB at ${fps} fps, over the 10 MB limit`);
    }

    mkdirSync(outDir, { recursive: true });
    copyFileSync(mp4, join(outDir, 'demo.mp4'));
    copyFileSync(gif, join(outDir, 'demo.gif'));
    const shown = (f) => (relative(process.cwd(), f).startsWith('..') ? f : relative(process.cwd(), f));
    console.log(`wrote ${shown(join(outDir, 'demo.gif'))} and ${shown(join(outDir, 'demo.mp4'))}`);
    await check(outDir);
    console.log('look at frames from the MP4 before committing.');
  } finally {
    await srv.stopServer();
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { fail, parseArgs, parsePort, repo } = await import('./demo-server.mjs');
  const args = parseArgs(process.argv.slice(2), CLI);
  if (args.out === '') fail(`--out needs a directory; usage: ${USAGE}`);
  const outDir = args.out ? resolve(args.out) : join(repo, 'docs', 'images');
  if (args.check) {
    await check(outDir);
    return;
  }
  await record(parsePort(args.port, CLI), outDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    console.error(`demo-gif: ${err.message}`);
    process.exit(1);
  }
}
