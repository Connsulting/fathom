// Rich Ask answers, B3: the 4-step series ramp for blocks (docs/plans/rich-ask-answers.md
// section 2, Theme). web/horizon/screens/ask.css declares --blk-s1 .. --blk-s4 and the panel
// background they sit on (--blk-bg) twice: under .d-horizon (dark, Horizon's theme today, where
// --blk-bg is var(--bg) from web/horizon/design.css) and under .d-horizon[data-theme="light"].
// Every ramp color must reach 3:1 contrast against that background in both themes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const askCss = read('web/horizon/screens/ask.css');
const designCss = read('web/horizon/design.css');

// The custom properties declared in the first rule whose selector list is exactly `selector`.
function props(css, selector) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1].trim() !== selector) continue;
    const out = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) out[d[1]] = d[2].trim();
    if (Object.keys(out).some((k) => k.startsWith('--blk-'))) return out;
  }
  return null;
}

function hex(v) {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  assert.ok(m, `${v} is a 6-digit hex color`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const designBg = /\.d-horizon\s*\{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(designCss);
assert.ok(designBg, 'design.css declares --bg on .d-horizon');

function resolve(v, scope) {
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (!m) return v;
  if (scope[m[1]]) return resolve(scope[m[1]], scope);
  if (m[1] === '--bg') return designBg[1];
  throw new Error(`unresolved ${v}`);
}

for (const [theme, selector] of [['dark', '.d-horizon'], ['light', '.d-horizon[data-theme="light"]']]) {
  test(`every series ramp color reaches 3:1 against the panel background (${theme})`, () => {
    const p = props(askCss, selector);
    assert.ok(p, `ask.css declares the ramp under ${selector}`);
    assert.ok(p['--blk-bg'], `${theme} declares --blk-bg`);
    const bg = resolve(p['--blk-bg'], p);
    const ramp = ['--blk-s1', '--blk-s2', '--blk-s3', '--blk-s4'].map((k) => {
      assert.ok(p[k], `${theme} declares ${k}`);
      return resolve(p[k], p);
    });
    assert.equal(new Set(ramp.map((c) => c.toLowerCase())).size, 4, 'four distinct colors');
    for (const c of ramp) assert.ok(contrast(c, bg) >= 3, `${theme} ${c} on ${bg} is ${contrast(c, bg).toFixed(2)}:1`);
  });
}

test('the light and dark backgrounds differ, so each ramp is checked against its own theme', () => {
  const dark = props(askCss, '.d-horizon');
  const light = props(askCss, '.d-horizon[data-theme="light"]');
  assert.notEqual(resolve(dark['--blk-bg'], dark).toLowerCase(), resolve(light['--blk-bg'], light).toLowerCase());
});
