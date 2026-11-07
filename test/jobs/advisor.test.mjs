// Item 24: the advisor review workflow. Marking a rec for review, recording verdicts (a veto
// dismisses through the rec action path), the check-in, the planner keeping vetoed and confirmed
// recs across a rerun (and lifting a veto when the rec's inputs changed), the review packet
// (every figure with provenance, all text escaped, stored encrypted and downloadable), the demo
// seed writing the same tables, and the read-only recommendations.advisor tool.

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.mjs';
import { openMigrated, openDb, listMigrations, migrate } from '../../src/store/db.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { buildPacketHtml, contentSources } from '../../src/advisor/packet.mjs';
import { MAX_NOTE } from '../../src/advisor/index.mjs';
import { callTool, getTool } from '../../src/tools/index.mjs';
import { request, serveAppFixture } from '../helpers/server.mjs';
import { scratch, keyFileOf } from '../helpers/real-store.mjs';
import { planRun } from '../helpers/plan.mjs';

const NOW = '2026-11-05';
const REC = 'fed-q4-estimate';
const S = scratch();
after(() => S.cleanup());

const configFor = dir => ({ ...loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: NOW, FATHOM_DATA_KEY_FILE: keyFileOf(dir) }) });

async function serve(db, config) {
  return serveAppFixture({ authenticated: true, db, config });
}

// A planned real store behind the in-process router.
async function planned() {
  const dir = S.dir();
  const { buildRealStore } = await import('../helpers/real-store.mjs');
  const db = S.track(await buildRealStore(dir, { clock: NOW }));
  const res = await planRun(db, { now: NOW });
  assert.equal(res.status, 'ok');
  const srv = await serve(db, configFor(dir));
  return { db, dir, srv };
}

const scen = async srv => (await srv.request({ path: '/api/scenario' })).json;
const recOf = (s, id) => s.recs.find(r => r.id === id);
const status = (db, id) => db.prepare('SELECT status FROM recs WHERE id = ?').get(id).status;

describe('advisor workflow, real store', () => {
  test('send marks the rec for review with a timestamp, idempotently, and lists it as waiting', async () => {
    const { db, srv } = await planned();
    try {
      let s = await scen(srv);
      assert.equal(recOf(s, REC).advisor, null, 'planner recs start unsent');
      const r1 = await srv.postJson('/api/advisor/reviews', { recId: REC });
      assert.equal(r1.status, 200, r1.text);
      const r2 = await srv.postJson('/api/advisor/reviews', { recId: REC });
      assert.equal(r2.json.reviewId, r1.json.reviewId, 'sending twice keeps one waiting review');
      s = r2.json.scenario;
      assert.equal(recOf(s, REC).advisor.verdict, 'pending');
      assert.deepEqual(s.advisor.pending, [REC]);
      assert.equal(s.advisor.waiting[0].sentOn, NOW);
      const row = db.prepare('SELECT * FROM advisor_reviews WHERE rec_id = ?').get(REC);
      assert.match(row.sent_at, /^2026-11-05T/);
      assert.equal((await srv.postJson('/api/advisor/reviews', { recId: 'nope' })).status, 404);
      assert.equal((await srv.postJson('/api/advisor/reviews', {})).status, 400);
    } finally { await srv.close(); }
  });

  test('a veto dismisses through the rec action path, survives a rerun, and lifts when inputs change', async () => {
    const { db, srv } = await planned();
    try {
      const { json } = await srv.postJson('/api/advisor/reviews', { recId: REC });
      const note = '<img src=x onerror=alert(1)> {f:agi.est} & more';
      const v = await srv.postJson(`/api/advisor/reviews/${json.reviewId}/verdict`, { verdict: 'vetoed', note, date: '2026-11-04' });
      assert.equal(v.status, 200, v.text);
      assert.equal(status(db, REC), 'dismissed');
      const ev = db.prepare("SELECT * FROM rec_events WHERE rec_id = ? AND action = 'dismiss' ORDER BY id DESC").get(REC);
      assert.equal(ev.arg, 'advisor vetoed');
      assert.equal(ev.actor, 'ui');
      const a = recOf(v.json.scenario, REC).advisor;
      assert.equal(a.verdict, 'vetoed');
      assert.ok(!a.note.includes('<img') && !a.note.includes('{f:'), 'the note is stored escaped, braces included');
      assert.equal(a.date, 'Nov 4, 2026');
      assert.equal(v.json.scenario.advisor.reviewed[0].recId, REC);
      // A second verdict on the same review is refused.
      assert.equal((await srv.postJson(`/api/advisor/reviews/${json.reviewId}/verdict`, { verdict: 'confirmed', note: '', date: NOW })).status, 409);

      await planRun(db, { now: NOW });
      assert.equal(status(db, REC), 'dismissed', 'the planner keeps a vetoed rec dismissed');
      assert.equal(recOf(await scen(srv), REC).advisor.verdict, 'vetoed');

      // The rec's inputs changed since the verdict: the next run lifts the veto.
      db.prepare("UPDATE advisor_reviews SET grounding_hash = 'older-inputs' WHERE id = ?").run(json.reviewId);
      await planRun(db, { now: NOW });
      assert.equal(status(db, REC), 'proposed');
      const lifted = db.prepare("SELECT * FROM rec_events WHERE rec_id = ? ORDER BY id DESC").get(REC);
      assert.deepEqual([lifted.action, lifted.actor], ['advisor_veto_lifted', 'planner']);
      assert.equal(recOf(await scen(srv), REC).advisor, null);
      assert.equal(db.prepare('SELECT closed_reason FROM advisor_reviews WHERE id = ?').get(json.reviewId).closed_reason, 'inputs changed');
    } finally { await srv.close(); }
  });

  test('a confirmed verdict keeps its status and badge across reruns', async () => {
    const { db, srv } = await planned();
    try {
      await srv.postJson('/api/recs/' + REC + '/action', { action: 'start' });
      const { json } = await srv.postJson('/api/advisor/reviews', { recId: REC });
      const v = await srv.postJson(`/api/advisor/reviews/${json.reviewId}/verdict`, { verdict: 'confirmed', note: 'Fine as written.', date: NOW });
      assert.equal(v.status, 200);
      assert.equal(status(db, REC), 'doing', 'a confirmation does not change the owner status');
      await planRun(db, { now: NOW });
      await planRun(db, { now: NOW });
      const s = await scen(srv);
      assert.equal(recOf(s, REC).status, 'doing');
      assert.equal(recOf(s, REC).advisor.verdict, 'confirmed');
      assert.equal(recOf(s, REC).advisor.note, 'Fine as written.');
    } finally { await srv.close(); }
  });

  test('verdict validation: verdict, note length and date', async () => {
    const { srv } = await planned();
    try {
      const { json } = await srv.postJson('/api/advisor/reviews', { recId: REC });
      const url = `/api/advisor/reviews/${json.reviewId}/verdict`;
      assert.equal((await srv.postJson(url, { verdict: 'maybe', note: '', date: NOW })).status, 400);
      assert.equal((await srv.postJson(url, { verdict: 'confirmed', note: 'x'.repeat(MAX_NOTE + 1), date: NOW })).status, 400);
      assert.equal((await srv.postJson(url, { verdict: 'confirmed', note: '', date: '2026-02-30' })).status, 400);
      assert.equal((await srv.postJson('/api/advisor/reviews/999/verdict', { verdict: 'confirmed', note: '', date: NOW })).status, 404);
    } finally { await srv.close(); }
  });

  test('the check-in persists with its date and length', async () => {
    const { db, srv } = await planned();
    try {
      const r = await srv.postJson('/api/advisor/checkin', { date: '2026-12-10', time: '14:00', lengthMin: 45 });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.scenario.advisor.next, { when: 'Thu, Dec 10, 2026, 2:00 PM', length: '45 min', date: '2026-12-10', time: '14:00', lengthMin: 45 });
      assert.equal(db.prepare('SELECT length_min FROM advisor_checkin').get().length_min, 45);
      assert.equal((await srv.postJson('/api/advisor/checkin', { date: 'soon', lengthMin: 30 })).status, 400);
      assert.equal((await srv.postJson('/api/advisor/checkin', { date: '2026-12-10', lengthMin: 2 })).status, 400);
      assert.equal((await srv.postJson('/api/advisor/checkin', { date: '2026-12-10', time: '25:00', lengthMin: 30 })).status, 400);
    } finally { await srv.close(); }
  });

  test('the packet is stored encrypted, listed with its date and downloads as an HTML attachment', async () => {
    const { db, dir, srv } = await planned();
    try {
      assert.equal((await srv.postJson('/api/advisor/packets', {})).status, 409, 'nothing waiting');
      await srv.postJson('/api/advisor/reviews', { recId: REC });
      const p = await srv.postJson('/api/advisor/packets', {});
      assert.equal(p.status, 200, p.text);
      const id = p.json.packetId;
      assert.match(id, /^advpkt-[a-f0-9]{16}$/);
      assert.deepEqual(p.json.scenario.advisor.packets.map(x => [x.id, x.date, x.recIds]), [[id, 'Nov 5, 2026', [REC]]]);
      const stored = readFileSync(join(dir, 'files', `${id}.bin`));
      assert.ok(!stored.includes(Buffer.from('Advisor review packet')), 'stored ciphertext, not HTML');
      assert.ok(readdirSync(join(dir, 'files')).includes(`${id}.bin`));
      const d = await srv.request({ path: `/api/advisor/packets/${id}` });
      assert.equal(d.status, 200);
      assert.match(d.headers['content-type'], /^text\/html/);
      assert.match(d.headers['content-disposition'], /^attachment; filename="advisor-packet-2026-11-05\.html"$/);
      assert.match(d.text, /Advisor review packet/);
      assert.ok(d.text.includes(db.prepare('SELECT def FROM recs WHERE id = ?').get(REC).def.match(/"title":"([^"]+)"/)[1].replace(/&/g, '&amp;')));
      assert.equal((await srv.request({ path: '/api/advisor/packets/advpkt-0000000000000000' })).status, 404);
      assert.equal((await srv.request({ path: '/api/advisor/packets/..%2Fx' })).status, 404);
      assert.equal((await request(srv.baseUrl, { path: `/api/advisor/packets/${id}` })).status, 401, 'session gate');
    } finally { await srv.close(); }
  });
});

describe('advisor packet content', () => {
  const demo = () => {
    const db = openMigrated(':memory:');
    seedDemo(db);
    return db;
  };

  test('every money figure in the packet carries a provenance note, and the notes name a source', () => {
    const db = demo();
    const s = buildScenario(db);
    const html = buildPacketHtml(s, { generatedOn: s.meta.clock });
    const body = html.split('<h2>Where each figure comes from</h2>')[0];
    const amounts = [...body.matchAll(/\$[\d,.]+[KM]?/g)];
    assert.ok(amounts.length > 3, 'the demo packet shows figures');
    for (const m of amounts) {
      const after = body.slice(m.index + m[0].length, m.index + m[0].length + 40);
      assert.match(after, /^<sup><a href="#n\d+">\d+<\/a><\/sup>/, `figure ${m[0]} has a footnote`);
    }
    const notes = [...html.matchAll(/<li id="n(\d+)"><b>[^<]+<\/b>, [^<]*Source: ([^<]+)<\/li>/g)];
    assert.ok(notes.length > 0);
    for (const n of notes) assert.ok(n[2].trim().length > 1, `note ${n[1]} names a source`);
    const refs = new Set([...body.matchAll(/href="#n(\d+)"/g)].map(m => m[1]));
    for (const r of refs) assert.ok(html.includes(`<li id="n${r}">`), `footnote ${r} exists`);
    for (const id of s.advisor.pending) assert.ok(html.includes(`id="rec-${id}"`), `pending ${id} is in the packet`);
    assert.ok(!/<script/i.test(html), 'no scripts');
    assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), 'no external resources');
    db.close();
  });

  test('every percentage and statutory amount carries a note naming its source (review fix)', () => {
    const db = demo();
    const s = buildScenario(db);
    const sources = contentSources(db);
    assert.ok(sources.pct && sources.law, 'the demo law and pct rows have a source');
    const html = buildPacketHtml(s, { generatedOn: s.meta.clock, sources });
    const body = html.split('<h2>Where each figure comes from</h2>')[0];
    const pcts = [...body.matchAll(/\d+(\.\d+)?%/g)];
    assert.ok(pcts.length > 0, 'the demo packet shows a percentage');
    for (const m of pcts) assert.match(body.slice(m.index + m[0].length, m.index + m[0].length + 40), /^<sup><a href="#n\d+">/, `${m[0]} has a footnote`);
    assert.match(html, /<li id="n\d+"><b>\d+%<\/b>, [^<]*Rate\. Source: Imported file: demo scenario/);
    // Without a known source for the rows, no percentage or statutory number is printed.
    const bare = buildPacketHtml(s, { generatedOn: s.meta.clock });
    assert.ok(!/\d%/.test(bare.split('<h2>Where each figure comes from</h2>')[0]));
    assert.ok(bare.includes('[figure unavailable]'));
    db.prepare("UPDATE content SET src = 'planner' WHERE key = 'pct'").run();
    assert.equal(contentSources(db).pct.label, 'Tax parameters for the year, from the tax calculator');
    db.close();
  });

  test('a figure with no source is shown as unavailable, never as a number', () => {
    const db = demo();
    const s = buildScenario(db);
    const rec = s.recs.find(r => r.id === s.advisor.pending[0]);
    rec.summary = 'Orphan {f:orphan.fig} and sourced.';
    s.fig['orphan.fig'] = { v: 123456, kind: 'e', label: 'Orphan', src: 'no-such-source' };
    const html = buildPacketHtml(s, {});
    assert.ok(html.includes('Orphan <span class="nofig">[figure unavailable]</span>'));
    assert.ok(!html.includes('123,456'));
    db.close();
  });

  test('titles, notes and names are escaped and markup is stripped', () => {
    const db = demo();
    const s = buildScenario(db);
    const rec = s.recs.find(r => r.id === s.advisor.pending[0]);
    rec.title = '<script>alert(1)</script> & "quoted"';
    rec.why = ['<img src=x onerror=alert(2)>Plain &amp; simple'];
    rec.qa = [{ q: '<b>bold</b> question?', a: [] }];
    s.meta.household = '<i>House</i>';
    const html = buildPacketHtml(s, {});
    assert.ok(!html.includes('<script>'), 'no raw script');
    assert.ok(!html.includes('<img'), 'no raw img');
    assert.ok(html.includes('alert(1) &amp; &quot;quoted&quot;'));
    assert.ok(html.includes('Plain &amp; simple'));
    assert.ok(html.includes('<li>bold question?</li>'));
    assert.ok(!html.includes('<i>House</i>'));
    db.close();
  });
});

describe('upgrade from migration 010 (review fix)', () => {
  test('existing review state in rec defs and the content row carries over', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of listMigrations().filter(m => m.id <= 10)) {
      db.exec(readFileSync(m.file, 'utf8'));
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, '2026-11-01T00:00:00.000Z');
    }
    const rec = db.prepare("INSERT INTO recs (id, def, status, sort, updated_at) VALUES (?, ?, ?, ?, '2026-10-20T09:00:00.000Z')");
    rec.run('a', JSON.stringify({ id: 'a', title: 'Waiting one', advisor: { verdict: 'pending', note: 'On the agenda' } }), 'proposed', 0);
    rec.run('b', JSON.stringify({ id: 'b', title: 'Confirmed one', advisor: { verdict: 'confirmed', note: 'Agree.' } }), 'doing', 1);
    rec.run('c', JSON.stringify({ id: 'c', title: 'Vetoed one', advisor: { verdict: 'vetoed', note: 'Not for you.' } }), 'dismissed', 2);
    rec.run('d', JSON.stringify({ id: 'd', title: 'Never sent', advisor: null }), 'proposed', 3);
    db.prepare("INSERT INTO content (key, value, src, updated_at) VALUES ('advisor', ?, 'x', '2026-10-21T09:00:00.000Z')").run(JSON.stringify({
      name: 'Advisor', next: { when: 'Thu, Dec 10, 2:00 PM', length: '30 min' }, pending: ['a'],
      reviewed: [{ recId: 'b', title: 'Confirmed one', verdict: 'confirmed', note: 'dup' }, { title: 'Outside the plan', verdict: 'confirmed', note: 'Hold.' }],
    }));
    migrate(db);
    const s = buildScenario(db, { clock: '2026-11-05' });
    const by = id => s.recs.find(r => r.id === id).advisor;
    assert.equal(by('a').verdict, 'pending');
    assert.deepEqual([by('b').verdict, by('b').note], ['confirmed', 'Agree.']);
    assert.deepEqual([by('c').verdict, by('c').note], ['vetoed', 'Not for you.']);
    assert.equal(by('d'), null);
    assert.deepEqual(s.advisor.pending, ['a']);
    assert.deepEqual(s.advisor.reviewed.map(v => v.title).sort(), ['Confirmed one', 'Outside the plan', 'Vetoed one']);
    assert.deepEqual([s.advisor.next.when, s.advisor.next.length], ['Thu, Dec 10, 2:00 PM', '30 min']);
    db.close();
  });
});

describe('demo seed and recommendations.advisor', () => {
  test('the demo seeds the advisor tables and the scenario reads them', () => {
    const db = openMigrated(':memory:');
    seedDemo(db);
    const s = buildScenario(db);
    assert.ok(db.prepare('SELECT count(*) AS n FROM advisor_reviews').get().n > 5);
    assert.deepEqual(s.advisor.pending, ['deferral', 'dcfsa', 'backdoor', 'spouseentity', 'filingplan']);
    assert.equal(s.advisor.next.length, '30 min');
    assert.ok(s.advisor.reviewed.some(v => v.verdict === 'vetoed' && v.recId === 'megabackdoor'));
    assert.ok(s.advisor.reviewed.some(v => !v.recId), 'a reviewed item outside the plan');
    const content = JSON.parse(db.prepare("SELECT value FROM content WHERE key = 'advisor'").get().value);
    assert.ok(!('pending' in content) && !('reviewed' in content) && !('next' in content), 'review state is not narrative content');
    for (const r of db.prepare('SELECT def FROM recs').all()) assert.ok(!('advisor' in JSON.parse(r.def)), 'no advisor in rec defs');
    db.close();
  });

  test('recommendations.advisor is a read tool that reports who reviewed what, when', async () => {
    const db = openMigrated(':memory:');
    seedDemo(db);
    const tool = getTool('recommendations');
    assert.equal(tool.kind, 'read');
    const out = await callTool('recommendations', { operation: 'advisor', }, { db, now: new Date('2026-11-05T12:00:00Z') });
    assert.equal(typeof out.advisor, 'string');
    assert.ok(!out.advisor.includes('{n:'), 'names resolved');
    assert.deepEqual(out.waiting.map(w => w.recId), ['deferral', 'dcfsa', 'backdoor', 'spouseentity', 'filingplan']);
    const veto = out.reviewed.find(v => v.recId === 'megabackdoor');
    assert.equal(veto.verdict, 'vetoed');
    assert.match(veto.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(veto.sentOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(out.nextCheckin, { date: '2026-12-10', time: '14:00', lengthMin: 30, label: 'Thu, Dec 10, 2026, 2:00 PM' });
    const rec = await callTool('recommendations', { operation: 'detail',  id: 'megabackdoor' }, { db, now: new Date('2026-11-05T12:00:00Z') });
    assert.equal(rec.advisor.verdict, 'vetoed');
    await assert.rejects(callTool('recommendations', { operation: 'advisor',  extra: 1 }, { db }), /not a known argument/);
    db.close();
  });
});
