// Pure helpers of scripts/demo-gif.mjs: the GIF walker, the ffmpeg -i parser, the screencast concat
// list and the output thresholds. Nothing here starts a server or a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { parseGif, parseFfmpegInfo, concatList, checkMeasures, gifArgs, mp4Args, LIMITS } from '../scripts/demo-gif.mjs';

// A hand-built GIF89a: 4x3 logical screen, a 2-color global table, a looping application
// extension, a comment extension, and frames with the given delays (centiseconds), the second one
// with a local color table.
function tinyGif(delays) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  push(...Buffer.from('GIF89a', 'latin1'));
  push(4, 0, 3, 0, 0x80, 0, 0); // 4x3, global table of 2 colors
  push(0, 0, 0, 255, 255, 255);
  push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0);
  push(0x21, 0xfe, 5, ...Buffer.from('hello', 'latin1'), 0);
  delays.forEach((d, i) => {
    push(0x21, 0xf9, 4, 0, d & 0xff, d >> 8, 0, 0);
    const local = i === 1 ? 0x80 : 0;
    push(0x2c, 0, 0, 0, 0, 4, 0, 3, 0, local);
    if (local) push(10, 20, 30, 40, 50, 60);
    push(2, 3, 0x8c, 0x2d, 0x99, 1, 0x01, 0);
  });
  push(0x3b);
  return Buffer.from(bytes);
}

test('parseGif reads the screen size, frame count and summed delays of a hand-built GIF', () => {
  const g = parseGif(tinyGif([7, 6, 7, 300]));
  assert.equal(g.width, 4);
  assert.equal(g.height, 3);
  assert.equal(g.frames, 4);
  assert.equal(g.delayCs, 320);
  assert.equal(g.seconds, 3.2);
  assert.equal(g.fps, 4 / 3.2);
});

test('parseGif rejects a non-GIF and a truncated GIF', () => {
  assert.throws(() => parseGif(Buffer.from('PNG not a gif at all')), /not a GIF/);
  const full = tinyGif([10, 10]);
  assert.throws(() => parseGif(full.subarray(0, full.length - 8)), /truncated/);
});

test('parseGif agrees with a GIF ffmpeg encodes, and ffmpeg -i parsing reads the MP4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-gif-test-'));
  try {
    const gif = join(dir, 't.gif');
    execFileSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=15:duration=2', '-loop', '0', gif]);
    const g = parseGif(readFileSync(gif));
    assert.equal(g.width, 64);
    assert.equal(g.height, 36);
    assert.equal(g.frames, 30);
    assert.ok(Math.abs(g.seconds - 2) < 0.05, `about 2 s, got ${g.seconds}`);
    assert.ok(Math.abs(g.fps - 15) < 0.1, `about 15 fps, got ${g.fps}`);

    const mp4 = join(dir, 't.mp4');
    execFileSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    let err = '';
    try {
      execFileSync(ffmpeg.path, ['-hide_banner', '-i', mp4], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      err = e.stderr.toString();
    }
    const info = parseFfmpegInfo(err);
    assert.equal(info.codec, 'h264');
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.ok(Math.abs(info.seconds - 1.5) < 0.05, `about 1.5 s, got ${info.seconds}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFfmpegInfo reads a typical stderr block and reports unknowns as null', () => {
  const info = parseFfmpegInfo([
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'demo.mp4':",
    '  Duration: 00:00:41.27, start: 0.000000, bitrate: 1234 kb/s',
    '    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 1200 kb/s, 30 fps, 30 tbr, 15360 tbn, 60 tbc (default)'
  ].join('\n'));
  assert.deepEqual(info, { seconds: 41.27, codec: 'h264', width: 1920, height: 1080 });
  assert.deepEqual(parseFfmpegInfo('nothing useful'), { seconds: null, codec: null, width: null, height: null });
});

test('concatList holds each frame until the next and the last until the stop time', () => {
  const frames = [
    { file: 'f000002.png', ts: 100.5 },
    { file: 'f000000.png', ts: 100.0 },
    { file: 'f000001.png', ts: 100.1 }
  ];
  const { text, seconds, frames: kept } = concatList(frames, 102.0);
  assert.equal(kept, 3);
  assert.ok(Math.abs(seconds - 2.0) < 1e-9);
  assert.equal(text, [
    'ffconcat version 1.0',
    "file 'f000000.png'", 'duration 0.100000',
    "file 'f000001.png'", 'duration 0.400000',
    "file 'f000002.png'", 'duration 1.500000',
    "file 'f000002.png'",
    ''
  ].join('\n'));
});

test('concatList keeps only the later of two frames with one timestamp and floors the last hold', () => {
  const { text, frames, seconds } = concatList([
    { file: 'a.png', ts: 5 },
    { file: 'b.png', ts: 5 },
    { file: 'c.png', ts: 6 }
  ], 6);
  assert.equal(frames, 2);
  assert.ok(!text.includes("'a.png'"));
  assert.match(text, /file 'c\.png'\nduration 0\.033333\nfile 'c\.png'\n$/);
  assert.ok(Math.abs(seconds - (1 + 1 / 30)) < 1e-9);
  assert.throws(() => concatList([], 1), /no frames/);
});

test('the ffmpeg arg builders carry the encode settings', () => {
  const mp4 = mp4Args('list.ffconcat', 'out.mp4').join(' ');
  for (const part of ['-f concat', '-c:v libx264', '-preset slow', '-crf 18', '-pix_fmt yuv420p', '-movflags +faststart', '-r 30', '-an', 'scale=1920:1080']) {
    assert.ok(mp4.includes(part), `mp4 args include ${part}`);
  }
  const gif = gifArgs('list.ffconcat', 'out.gif', 12).join(' ');
  for (const part of ['fps=12', 'scale=1280:-1:flags=lanczos', 'palettegen=max_colors=256:stats_mode=diff', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop 0']) {
    assert.ok(gif.includes(part), `gif args include ${part}`);
  }
});

const good = () => ({
  gif: { bytes: 4 * 1048576, width: 1280, height: 720, seconds: 40, fps: 15 },
  mp4: { seconds: 40, codec: 'h264', width: 1920, height: 1080 }
});

test('checkMeasures passes a good pair and names each failing threshold', () => {
  assert.deepEqual(checkMeasures(good()), []);
  const cases = [
    [(m) => { m.gif.bytes = LIMITS.gif.maxBytes; }, /GIF is 10\.00 MB/],
    [(m) => { m.gif.width = 1100; m.gif.height = 619; }, /GIF width 1100/],
    [(m) => { m.gif.height = 800; }, /aspect/],
    [(m) => { m.gif.seconds = 29.9; }, /GIF duration 29\.90/],
    [(m) => { m.gif.seconds = 45.2; }, /GIF duration 45\.20/],
    [(m) => { m.gif.fps = 10; }, /average fps 10\.00/],
    [(m) => { m.gif.fps = 20; }, /average fps 20\.00/],
    [(m) => { m.mp4.seconds = 50; }, /MP4 duration 50\.00/],
    [(m) => { m.mp4.seconds = null; }, /MP4 duration unknown/],
    [(m) => { m.mp4.codec = 'hevc'; }, /MP4 codec is hevc/],
    [(m) => { m.mp4.width = 1280; m.mp4.height = 720; }, /MP4 is 1280x720/]
  ];
  for (const [mutate, re] of cases) {
    const m = good();
    mutate(m);
    const problems = checkMeasures(m);
    assert.equal(problems.length, 1, `one problem for ${re}: ${problems.join('; ')}`);
    assert.match(problems[0], re);
  }
});

test('checkMeasures allows centisecond rounding around the fps bounds and the 16:9 tolerance', () => {
  const m = good();
  m.gif.fps = 15.05;
  m.gif.width = 1200;
  m.gif.height = 700; // 1.714, within 5 percent of 1.778
  assert.deepEqual(checkMeasures(m), []);
});
