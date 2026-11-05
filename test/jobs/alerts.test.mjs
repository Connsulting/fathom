// Deadline alerts (src/jobs/alerts.mjs): thresholds 14, 7 and 1 with the tightest-threshold rule,
// at most one send per (key, threshold), skipped statuses, deadline plus rec window merging,
// alert identity (Revision r2 item 5), one combined email per run, dedupe rows only after a
// successful send, and hostile stored titles escaped and never token-resolved.
// Synthetic rows inserted directly into a temp migrated store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import { addDays } from '../../src/scenario/build.mjs';
import { THRESHOLDS, dueAlerts, renderAlerts, runDeadlineAlerts } from '../../src/jobs/alerts.mjs';
import { EmailError } from '../../src/email/transport.mjs';

const CLOCK = '2032-06-01';
const NOW = '2032-06-01T11:00:00.000Z';

async function store() {
  const t = await tempDb();
  return { ...t, done() { try { t.db.close(); } catch { /* closed */ } rmSync(t.dataDir, { recursive: true, force: true }); } };
}

function addDeadline(db, { date, title, recId = null, hard = 0 }) {
  return db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, ?, ?)').run(date, date, title, recId, hard).lastInsertRowid;
}

function addRec(db, { id, status = 'proposed', close = null, title = `Synthetic rec ${id}` }) {
  db.prepare(`INSERT INTO recs (id, def, status, tasks_done, window_close, window_label, sort, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?, 0, ?)`).run(id, JSON.stringify({ id, title }), status, close, close ? `By ${close}` : null, NOW);
}

function captureTransport() {
  const sent = [];
  return { name: 'capture', sent, async send(msg) { sent.push(msg); return { id: `m-${sent.length}` }; } };
}

function failingTransport(code = 'network') {
  let calls = 0;
  return { name: 'failing', get calls() { return calls; }, async send() { calls += 1; throw new EmailError(code); } };
}

const run = (db, clock, transport) => runDeadlineAlerts(db, { clock, transport, publicUrl: null, now: `${clock}T11:00:00.000Z`, jobRunId: null });
const recorded = (db) => db.prepare('SELECT key, threshold FROM deadline_alerts ORDER BY key, threshold').all().map((r) => ({ key: r.key, threshold: r.threshold }));
const titleKey = (date, title) => `deadline:${date}:${createHash('sha256').update(title.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;

test('THRESHOLDS are 14, 7 and 1', () => {
  assert.deepEqual([...THRESHOLDS], [14, 7, 1]);
});

test('threshold is the smallest of 14, 7, 1 that covers the days left; outside 0 to 14 nothing is due', async () => {
  const t = await store();
  try {
    const cases = { 15: null, 14: 14, 10: 14, 8: 14, 7: 7, 3: 7, 2: 7, 1: 1, 0: 1, [-1]: null };
    for (const d of Object.keys(cases)) addDeadline(t.db, { date: addDays(CLOCK, Number(d)), title: `Synthetic day ${d}` });
    const due = dueAlerts(t.db, { clock: CLOCK });
    for (const [d, want] of Object.entries(cases)) {
      const key = titleKey(addDays(CLOCK, Number(d)), `Synthetic day ${d}`);
      const hit = due.filter((a) => a.key === key);
      if (want == null) assert.equal(hit.length, 0, `${d} days: not due`);
      else assert.deepEqual(hit.map((a) => a.threshold), [want], `${d} days: threshold ${want}`);
    }
  } finally { t.done(); }
});

test('a pair is sent at most once; the next threshold sends once more; a missed day sends only the tightest', async () => {
  const t = await store();
  try {
    const date = addDays(CLOCK, 10);
    addDeadline(t.db, { date, title: 'Synthetic filing day' });
    const tr = captureTransport();
    const day = (n) => addDays(date, -n);

    assert.equal((await run(t.db, day(10), tr)).alerts, 1);
    assert.equal((await run(t.db, day(9), tr)).alerts, 0, '14 already sent');
    assert.equal((await run(t.db, day(8), tr)).alerts, 0);
    // Days 7 to 3 missed: at 2 days left the tightest applicable threshold is 7, sent once.
    assert.equal((await run(t.db, day(2), tr)).alerts, 1);
    assert.equal((await run(t.db, day(2), tr)).alerts, 0);
    assert.equal((await run(t.db, day(1), tr)).alerts, 1);
    assert.equal((await run(t.db, day(0), tr)).alerts, 0, '1 already sent');
    assert.equal(tr.sent.length, 3);
    assert.deepEqual(recorded(t.db).map((r) => r.threshold).sort((a, b) => a - b), [1, 7, 14]);
  } finally { t.done(); }
});

test('a first run inside the 7 day band sends threshold 7 only, not 14 as well', async () => {
  const t = await store();
  try {
    addDeadline(t.db, { date: addDays(CLOCK, 3), title: 'Synthetic late start' });
    const due = dueAlerts(t.db, { clock: CLOCK });
    assert.deepEqual(due.map((a) => a.threshold), [7]);
  } finally { t.done(); }
});

test('nothing due sends nothing; several alerts on one day produce exactly one email', async () => {
  const t = await store();
  try {
    const tr = captureTransport();
    addDeadline(t.db, { date: addDays(CLOCK, 40), title: 'Synthetic far away' });
    const none = await run(t.db, CLOCK, tr);
    assert.equal(none.alerts, 0);
    assert.ok(!none.send, 'no send row');
    assert.equal(tr.sent.length, 0);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM email_sends').get().n, 0);

    addDeadline(t.db, { date: addDays(CLOCK, 1), title: 'Synthetic alpha' });
    addDeadline(t.db, { date: addDays(CLOCK, 5), title: 'Synthetic beta' });
    addRec(t.db, { id: 'syn-gamma', close: addDays(CLOCK, 12), title: 'Synthetic gamma' });
    const out = await run(t.db, CLOCK, tr);
    assert.equal(out.alerts, 3);
    assert.equal(tr.sent.length, 1, 'one combined email');
    assert.equal(out.send.status, 'sent');
    assert.equal(out.send.kind, 'alert');
    for (const s of ['Synthetic alpha', 'Synthetic beta', 'Synthetic gamma']) assert.ok(tr.sent[0].text.includes(s), `${s} in the email`);
    assert.equal(recorded(t.db).length, 3);
  } finally { t.done(); }
});

test('deadlines whose rec is done, dismissed or hidden are skipped, and so are recs in those statuses', async () => {
  const t = await store();
  try {
    for (const status of ['done', 'dismissed', 'hidden']) {
      addRec(t.db, { id: `syn-${status}`, status, close: addDays(CLOCK, 4) });
      addDeadline(t.db, { date: addDays(CLOCK, 6), title: `Synthetic ${status} deadline`, recId: `syn-${status}` });
    }
    assert.deepEqual(dueAlerts(t.db, { clock: CLOCK }), []);
    // Liveness: the same shapes with an open status alert.
    for (const status of ['proposed', 'accepted', 'doing', 'waiting', 'snoozed']) {
      addRec(t.db, { id: `syn-${status}`, status, close: addDays(CLOCK, 4) });
    }
    addDeadline(t.db, { date: addDays(CLOCK, 6), title: 'Synthetic open deadline', recId: 'syn-proposed' });
    const keys = dueAlerts(t.db, { clock: CLOCK }).map((a) => a.key).sort();
    assert.deepEqual(keys, [
      `rec:syn-accepted:${addDays(CLOCK, 4)}`, `rec:syn-doing:${addDays(CLOCK, 4)}`,
      `rec:syn-proposed:${addDays(CLOCK, 4)}`, `rec:syn-proposed:${addDays(CLOCK, 6)}`,
      `rec:syn-snoozed:${addDays(CLOCK, 4)}`, `rec:syn-waiting:${addDays(CLOCK, 4)}`,
    ].sort());
  } finally { t.done(); }
});

test('a deadline and its rec window on the same date are one alert', async () => {
  const t = await store();
  try {
    const date = addDays(CLOCK, 5);
    addRec(t.db, { id: 'syn-merge', close: date });
    addDeadline(t.db, { date, title: 'Synthetic merged deadline', recId: 'syn-merge' });
    const due = dueAlerts(t.db, { clock: CLOCK });
    assert.equal(due.length, 1);
    assert.equal(due[0].key, `rec:syn-merge:${date}`);
    assert.equal(due[0].threshold, 7);
  } finally { t.done(); }
});

test('identity: unlinked deadlines with the same date and normalized title alert once; a rename is a new deadline', async () => {
  const t = await store();
  try {
    const date = addDays(CLOCK, 6);
    addDeadline(t.db, { date, title: 'Synthetic Quarterly Filing' });
    addDeadline(t.db, { date, title: 'synthetic   quarterly filing' });
    const due = dueAlerts(t.db, { clock: CLOCK });
    assert.equal(due.length, 1);
    assert.equal(due[0].key, titleKey(date, 'Synthetic Quarterly Filing'));
    const tr = captureTransport();
    assert.equal((await run(t.db, CLOCK, tr)).alerts, 1);
    addDeadline(t.db, { date, title: 'Synthetic Quarterly Filing, renamed' });
    const after = dueAlerts(t.db, { clock: CLOCK });
    assert.deepEqual(after.map((a) => a.key), [titleKey(date, 'Synthetic Quarterly Filing, renamed')]);
  } finally { t.done(); }
});

test('identity: deleting and reinserting a rec-linked deadline row (planner refresh) does not realert', async () => {
  const t = await store();
  try {
    const date = addDays(CLOCK, 9);
    addRec(t.db, { id: 'syn-linked' });
    const id = addDeadline(t.db, { date, title: 'Synthetic linked deadline', recId: 'syn-linked' });
    const tr = captureTransport();
    assert.equal((await run(t.db, CLOCK, tr)).alerts, 1);
    t.db.prepare('DELETE FROM deadlines WHERE id = ?').run(id);
    addDeadline(t.db, { date, title: 'Synthetic linked deadline, reworded', recId: 'syn-linked' });
    assert.equal((await run(t.db, addDays(CLOCK, 1), tr)).alerts, 0);
    assert.equal(tr.sent.length, 1);
    assert.deepEqual(recorded(t.db), [{ key: `rec:syn-linked:${date}`, threshold: 14 }]);
  } finally { t.done(); }
});

test('dedupe rows are written only when the send succeeds; a later run sends', async () => {
  const t = await store();
  try {
    addDeadline(t.db, { date: addDays(CLOCK, 2), title: 'Synthetic retry deadline' });
    const bad = failingTransport('network');
    const failed = await run(t.db, CLOCK, bad);
    assert.equal(bad.calls, 1);
    assert.equal(failed.alerts, 1);
    assert.equal(failed.send.status, 'failed');
    assert.equal(failed.send.errorCode, 'network');
    assert.deepEqual(recorded(t.db), []);
    const good = captureTransport();
    const ok = await run(t.db, CLOCK, good);
    assert.equal(ok.send.status, 'sent');
    assert.equal(good.sent.length, 1);
    assert.equal(recorded(t.db).length, 1);
  } finally { t.done(); }
});

test('hostile stored titles are escaped in the HTML and never token-resolved', async () => {
  const t = await store();
  try {
    const hostile = '<img src=x onerror=alert(1)> {f:secret} <script>alert(2)</script>';
    addDeadline(t.db, { date: addDays(CLOCK, 3), title: hostile });
    addRec(t.db, { id: 'syn-hostile', close: addDays(CLOCK, 4), title: '<b>Synthetic</b> rec title' });
    const due = dueAlerts(t.db, { clock: CLOCK });
    assert.equal(due.length, 2);
    const mail = renderAlerts(due, { clock: CLOCK, publicUrl: null });
    for (const k of ['subject', 'text', 'html']) assert.equal(typeof mail[k], 'string', k);
    assert.ok(!/<img/i.test(mail.html), 'no raw img tag');
    assert.ok(!/<script/i.test(mail.html), 'no raw script tag');
    assert.ok(!/<b>Synthetic/.test(mail.html), 'no raw b tag from stored text');
    assert.ok(!/<[^>]*onerror=/i.test(mail.html), 'no tag carries onerror');
    assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'title shown escaped');
    assert.ok(mail.text.includes(hostile), 'plain text keeps the title as typed');
    for (const part of [mail.text, mail.html]) {
      assert.ok(part.includes('{f:secret}'), 'token text kept literally');
      assert.ok(!part.includes('[?secret'), 'not token-resolved');
    }
    assert.ok(!/[\r\n]/.test(mail.subject));
    assert.ok(!/<style[\s>]/i.test(mail.html) && !/<script[\s>]/i.test(mail.html), 'inline styles only, no script');
  } finally { t.done(); }
});

test('renderAlerts links to the app only when publicUrl is set', async () => {
  const t = await store();
  try {
    addDeadline(t.db, { date: addDays(CLOCK, 3), title: 'Synthetic link deadline' });
    const due = dueAlerts(t.db, { clock: CLOCK });
    const none = renderAlerts(due, { clock: CLOCK, publicUrl: null });
    assert.ok(!/https?:\/\//.test(none.text) && !/href=/.test(none.html));
    const linked = renderAlerts(due, { clock: CLOCK, publicUrl: 'https://fathom.example.invalid' });
    assert.ok(linked.text.includes('https://fathom.example.invalid/#/'));
    assert.ok(linked.html.includes('href="https://fathom.example.invalid/#/'));
  } finally { t.done(); }
});
