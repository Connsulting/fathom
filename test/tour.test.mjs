// The guided product tour's pure exports, from the Horizon tour screen module: the stop table,
// the callout placement geometry and the step count. The module is plain ESM with no DOM work at
// import, so node imports it directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_STOPS, placeCallout, tourCount } from '../web/horizon/screens/tour.js';

// Built from parts so this file does not match the hygiene checks.
const EM_DASH = String.fromCharCode(0x2014);
const EMOJI = /\p{Extended_Pictographic}/u;

const ROUTES = new Set(['home', 'plan', 'money', 'accounts', 'pnl', 'confirm', 'packs', 'ask', 'goals', 'pace',
  'wargame', 'yearend', 'advisor', 'add', 'settings']);
const FIELDS = ['id', 'route', 'anchor', 'title', 'body'];

const sentences = (s) => (String(s).match(/[.!?](?=\s|$)/g) || []).length;

/* ---------- TOUR_STOPS ---------- */

test('TOUR_STOPS holds 8 to 12 stops with unique ids and nonblank string fields', () => {
  assert.ok(Array.isArray(TOUR_STOPS));
  assert.ok(TOUR_STOPS.length >= 8 && TOUR_STOPS.length <= 12, `stop count ${TOUR_STOPS.length}`);
  const ids = new Set();
  for (const stop of TOUR_STOPS) {
    assert.equal(typeof stop, 'object');
    for (const f of FIELDS) {
      assert.equal(typeof stop[f], 'string', `${stop.id}: ${f} is a string`);
      assert.ok(stop[f].trim().length > 0, `${stop.id}: ${f} is not blank`);
    }
    assert.ok(!ids.has(stop.id), `duplicate id ${stop.id}`);
    ids.add(stop.id);
    assert.ok(!('optional' in stop) || typeof stop.optional === 'boolean', `${stop.id}: optional is absent or boolean`);
  }
});

test('every stop route is a known Horizon route', () => {
  for (const stop of TOUR_STOPS) assert.ok(ROUTES.has(stop.route), `${stop.id}: unknown route ${stop.route}`);
});

test('stop copy is short: at most two sentences, no em dash, no emoji', () => {
  for (const stop of TOUR_STOPS) {
    assert.ok(sentences(stop.body) <= 2, `${stop.id}: body has ${sentences(stop.body)} sentences`);
    assert.ok(sentences(stop.body) >= 1, `${stop.id}: body ends a sentence`);
    for (const f of ['title', 'body']) {
      assert.ok(!stop[f].includes(EM_DASH), `${stop.id}: ${f} has no em dash`);
      assert.ok(!EMOJI.test(stop[f]), `${stop.id}: ${f} has no emoji`);
    }
  }
});

test('the core stops are present: the main screens, the Ask launcher and the add-to-Ask button', () => {
  const routes = new Set(TOUR_STOPS.map((s) => s.route));
  for (const r of ['home', 'plan', 'money', 'pnl', 'accounts', 'confirm', 'packs']) {
    assert.ok(routes.has(r), `a stop on ${r}`);
  }
  const anchors = TOUR_STOPS.map((s) => s.anchor);
  assert.ok(anchors.some((a) => a.includes('.h-askp-launch')), 'a stop anchored on the Ask launcher');
  assert.ok(anchors.some((a) => a.includes('.h-add')), 'a stop anchored on an add-to-Ask button');
});

/* ---------- placeCallout ---------- */

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const BOX = { width: 340, height: 220 };
const MARGIN = 12;
const GAP = 12;

const bottomOf = (a) => a.top + a.height;
const rightOf = (a) => a.left + a.width;

// The callout rect as placed: the returned width and the box height.
const rectOf = (r, box) => ({ left: r.left, top: r.top, width: r.width, height: box.height });

function inside(r, view, label) {
  assert.ok(r.left >= 0, `${label}: left ${r.left} >= 0`);
  assert.ok(r.top >= 0, `${label}: top ${r.top} >= 0`);
  assert.ok(r.left + r.width <= view.width, `${label}: right ${r.left + r.width} <= ${view.width}`);
  assert.ok(r.top + r.height <= view.height, `${label}: bottom ${r.top + r.height} <= ${view.height}`);
}

function overlaps(a, b) {
  return a.left < rightOf(b) && b.left < rightOf(a) && a.top < bottomOf(b) && b.top < bottomOf(a);
}

// True when, by the plan's rule, some side holds the whole box inside [margin, view - margin].
function someSideFits(a, box, view) {
  const crossX = box.width <= view.width - 2 * MARGIN;
  const crossY = box.height <= view.height - 2 * MARGIN;
  const below = crossX && bottomOf(a) + GAP + box.height <= view.height - MARGIN;
  const above = crossX && a.top - GAP - box.height >= MARGIN;
  const right = crossY && rightOf(a) + GAP + box.width <= view.width - MARGIN;
  const left = crossY && a.left - GAP - box.width >= MARGIN;
  return below || above || right || left;
}

function anchorGrid(view) {
  const out = [];
  const sizes = [[40, 40], [300, 80], [600, 200], [view.width * 0.9, 120], [200, view.height * 0.8], [view.width, view.height]];
  for (const [w0, h0] of sizes) {
    const w = Math.min(w0, view.width);
    const h = Math.min(h0, view.height);
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
        out.push({ left: Math.round((view.width - w) * fx), top: Math.round((view.height - h) * fy), width: w, height: h });
      }
    }
  }
  return out;
}

test('placeCallout keeps the callout inside the viewport for a grid of anchors, desktop and phone', () => {
  for (const [view, phone, box] of [[DESK, false, BOX], [{ width: 800, height: 600 }, false, BOX], [PHONE, true, { width: PHONE.width, height: 260 }]]) {
    for (const anchor of anchorGrid(view)) {
      const r = placeCallout({ anchor, box, view, phone, margin: MARGIN, gap: GAP, topInset: phone ? 56 : 0 });
      const label = `${phone ? 'phone' : 'desktop'} ${view.width}x${view.height} anchor ${JSON.stringify(anchor)}`;
      assert.equal(r.mode, phone ? 'sheet' : 'pop', label);
      inside(rectOf(r, box), view, label);
      if (phone) {
        assert.equal(r.left, 0, `${label}: sheet left`);
        assert.equal(r.width, view.width, `${label}: sheet width`);
      } else {
        assert.equal(r.width, box.width, `${label}: pop width`);
        if (someSideFits(anchor, box, view)) {
          assert.ok(!overlaps(rectOf(r, box), anchor), `${label}: a side fits, so no overlap (got ${JSON.stringify(r)})`);
        }
      }
    }
  }
});

test('placeCallout puts the callout below an anchor with room below, aligned to its start', () => {
  const anchor = { top: 100, left: 200, width: 300, height: 80 };
  const r = placeCallout({ anchor, box: BOX, view: DESK, phone: false });
  assert.equal(r.mode, 'pop');
  assert.equal(r.side, 'bottom');
  assert.equal(r.top, bottomOf(anchor) + GAP);
  assert.equal(r.left, anchor.left);
  assert.equal(r.width, BOX.width);
  assert.ok(!overlaps(rectOf(r, BOX), anchor));
});

test('placeCallout puts the callout above an anchor near the bottom of the viewport', () => {
  const anchor = { top: 760, left: 200, width: 300, height: 80 };
  const r = placeCallout({ anchor, box: BOX, view: DESK, phone: false });
  assert.equal(r.mode, 'pop');
  assert.equal(r.side, 'top');
  assert.equal(r.top, anchor.top - GAP - BOX.height);
  assert.ok(!overlaps(rectOf(r, BOX), anchor));
  inside(rectOf(r, BOX), DESK, 'above');
});

test('placeCallout puts the callout right of a tall anchor with room to its right', () => {
  const anchor = { top: 20, left: 100, width: 400, height: 860 };
  const r = placeCallout({ anchor, box: BOX, view: DESK, phone: false });
  assert.equal(r.mode, 'pop');
  assert.equal(r.side, 'right');
  assert.ok(r.left >= rightOf(anchor), `left ${r.left} clears the anchor's right edge ${rightOf(anchor)}`);
  assert.ok(!overlaps(rectOf(r, BOX), anchor));
  inside(rectOf(r, BOX), DESK, 'right');
});

test('placeCallout clamps the cross axis into the viewport for an anchor at the right edge', () => {
  const anchor = { top: 100, left: 1300, width: 140, height: 40 };
  const r = placeCallout({ anchor, box: BOX, view: DESK, phone: false });
  assert.equal(r.side, 'bottom');
  assert.ok(r.left + r.width <= DESK.width - MARGIN, `right edge ${r.left + r.width} within the margin`);
  assert.ok(!overlaps(rectOf(r, BOX), anchor));
});

test('placeCallout on a phone gives a bottom sheet for an anchor in the top half', () => {
  const box = { width: PHONE.width, height: 240 };
  const anchor = { top: 100, left: 16, width: 343, height: 120 };
  const r = placeCallout({ anchor, box, view: PHONE, phone: true, topInset: 56 });
  assert.equal(r.mode, 'sheet');
  assert.equal(r.side, 'bottom');
  assert.equal(r.left, 0);
  assert.equal(r.width, PHONE.width);
  assert.equal(r.top, PHONE.height - box.height);
  assert.ok(!overlaps(rectOf(r, box), anchor));
});

test('placeCallout on a phone gives a top sheet below the header for an anchor in the bottom half', () => {
  const box = { width: PHONE.width, height: 240 };
  const anchor = { top: 730, left: 303, width: 56, height: 56 };
  const r = placeCallout({ anchor, box, view: PHONE, phone: true, topInset: 56 });
  assert.equal(r.mode, 'sheet');
  assert.equal(r.side, 'top');
  assert.equal(r.left, 0);
  assert.equal(r.width, PHONE.width);
  assert.equal(r.top, 56);
  assert.ok(!overlaps(rectOf(r, box), anchor));
});

/* ---------- tourCount ---------- */

test('tourCount reads 1 of 11 on the first stop of an 11-stop tour', () => {
  const c = tourCount(0, 11, 0);
  assert.equal(c.n, 1);
  assert.equal(c.of, 11);
  const all = tourCount(0, TOUR_STOPS.length, 0);
  assert.equal(all.n, 1);
  assert.equal(all.of, TOUR_STOPS.length);
});

test('tourCount: every skipped stop lowers the total by one', () => {
  for (let s = 0; s < 5; s++) {
    assert.equal(tourCount(0, 11, s + 1).of, tourCount(0, 11, s).of - 1, `skip ${s + 1}`);
  }
  assert.equal(tourCount(3, 11, 1).of, 10);
  assert.equal(tourCount(3, 11, 1).n, 4);
});

test('tourCount: the last shown stop reads n of n, and n never exceeds the total', () => {
  assert.deepEqual([tourCount(10, 11, 0).n, tourCount(10, 11, 0).of], [11, 11]);
  assert.deepEqual([tourCount(9, 11, 1).n, tourCount(9, 11, 1).of], [10, 10]);
  for (let total = 1; total <= 12; total++) {
    for (let skipped = 0; skipped < total; skipped++) {
      const shown = total - skipped;
      for (let i = 0; i < shown; i++) {
        const c = tourCount(i, total, skipped);
        assert.equal(c.n, i + 1, `n for ${i} of ${total} with ${skipped} skipped`);
        assert.ok(c.n <= c.of, `n ${c.n} <= of ${c.of}`);
      }
      assert.equal(tourCount(shown - 1, total, skipped).n, tourCount(shown - 1, total, skipped).of);
    }
  }
});
