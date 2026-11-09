// AC4 (builder): src/scenario/build.mjs assembles the CONTRACT.md scenario from a seeded store.

import test from 'node:test';
import assert from 'node:assert/strict';
import demo from '../demo/scenario.mjs';
import { seedDemo, OPENS_ON } from '../demo/seed.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { setSetting } from '../src/store/db.mjs';
import { tempDb, recOf, paragraphs } from './helpers/server.mjs';

const CONTRACT_KEYS = [
  'meta', 'names', 'law', 'pct', 'src', 'fig', 'series', 'verdict', 'domains', 'events', 'deadlines', 'recs',
  'goals', 'curve', 'wargame', 'decisions', 'ask', 'accounts', 'advisor', 'yearend', 'connect', 'engine',
  'onboarding', 'email', 'packs',
];
const NOV_TO_JAN = 61; // 2026-11-05 to 2027-01-05

async function seeded() {
  const t = await tempDb();
  seedDemo(t.db);
  return t;
}

async function withSeeded(fn) {
  const t = await seeded();
  try { return await fn(t.db); } finally { t.close(); }
}

const decision = (sc, id) => sc.decisions.find(d => d.id === id);
const setRecStatus = (db, id, status) => db.prepare('UPDATE recs SET status = ? WHERE id = ?').run(status, id);
const novemberStatus = r => (r.statusByDemo && r.statusByDemo.november) || r.status;

test('build returns every CONTRACT top-level key plus live', () => withSeeded(db => {
  const sc = buildScenario(db);
  for (const k of CONTRACT_KEYS) assert.ok(k in sc, `missing ${k}`);
  for (const k of ['mode', 'demo', 'engine', 'onboardStep', 'picks', 'conversations', 'packs', 'clock']) {
    assert.ok(k in sc.live, `missing live.${k}`);
  }
  assert.equal(sc.live.mode, 'demo');
  assert.equal(sc.live.demo, 'november');
  assert.equal(sc.live.engine, true);
  assert.equal(sc.live.clock, '2026-11-05');
  assert.equal(sc.meta.clock, '2026-11-05');
  assert.equal(sc.meta.clockLabel, demo.meta.clockLabel);
  // The seeded label says Aug 30. The newest stored row is Aug 31, and the scenario reports that day.
  assert.equal(sc.meta.dataThrough, 'Aug 31, 2026');
  assert.equal(sc.meta.product, 'Fathom');
  const salaryDefault = demo.wargame.salary.points.findIndex(p => p.current || p.recommended);
  assert.deepEqual(sc.live.picks, { salary: Math.max(0, salaryDefault), deferral: 0 });
}));

test('recs carry live November status and no statusByDemo', () => withSeeded(db => {
  const sc = buildScenario(db);
  assert.ok(!JSON.stringify(sc).includes('statusByDemo'));
  for (const r of demo.recs) {
    const got = recOf(sc, r.id);
    if (r.status === 'hidden') { assert.ok(!got || got.status === 'hidden', r.id); continue; }
    assert.ok(got, r.id);
    assert.equal(got.status, novemberStatus(r), r.id);
    assert.deepEqual(got.tasks.map(x => x.done), r.tasks.map(x => !!x.done), `${r.id} tasks`);
  }
}));

test('window.days is computed from the clock', () => withSeeded(db => {
  const nov = buildScenario(db);
  const jan = buildScenario(db, { clock: '2027-01-05' });
  for (const r of demo.recs.filter(x => x.status !== 'hidden')) {
    assert.equal(recOf(nov, r.id).window.days, r.window.days, `${r.id} in November`);
    assert.equal(recOf(nov, r.id).window.label, r.window.label);
    assert.equal(recOf(jan, r.id).window.days, r.window.days - NOV_TO_JAN, `${r.id} in January`);
  }
  assert.equal(jan.meta.clock, '2027-01-05');
  assert.equal(jan.meta.clockLabel, 'Tue, Jan 5, 2027');
  assert.equal(jan.live.clock, '2027-01-05');

  setSetting(db, 'clock', '2026-12-01');
  const dec = buildScenario(db);
  assert.equal(recOf(dec, 'offcycle').window.days, 0, 'stored clock is used when no override');
  assert.equal(dec.meta.clock, '2026-12-01');
}));

test('the seed writes no rec-keyed conversation or opening summary message', () => withSeeded(db => {
  const sc = buildScenario(db);
  for (const r of demo.recs) assert.ok(!(r.id in sc.live.conversations), `${r.id} has no rec-keyed conversation`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM conversations WHERE key NOT LIKE 'pack:%'").get().n, 0, 'no conversation besides packs');
  assert.ok(!('ask' in sc.live.conversations), 'no bare ask conversation');
  assert.ok(!Object.keys(sc.live.conversations).some(k => k.startsWith('ask:')), 'the seed has no Ask threads');
  assert.deepEqual(sc.live.threads, []);
}));

test('Decide in November: salary decided, deferral open, later ones upcoming', () => withSeeded(db => {
  assert.deepEqual(OPENS_ON, { salary27: '2027-01-01' });
  const sc = buildScenario(db);
  const status = Object.fromEntries(sc.decisions.map(d => [d.id, d.status]));
  assert.deepEqual(status, {
    deferral: 'open', dcfsa: 'open', salary26: 'decided', salary27: 'upcoming', spouseentity: 'upcoming', backdoor: 'upcoming',
  });
  assert.equal(decision(sc, 'salary26').line, demo.wargame.salary.decided);
  assert.equal(sc.wargame.salary.status, 'decided');
  assert.equal(sc.wargame.salary.decided, demo.wargame.salary.decided);
  assert.equal(sc.wargame.deferral.status, 'open');
}));

test('Decide in January: the 2027 salary decision opens on its calendar date', () => withSeeded(db => {
  const jan = buildScenario(db, { clock: '2027-01-05' });
  assert.equal(decision(jan, 'salary27').status, 'open');
  assert.equal(decision(jan, 'salary26').status, 'decided');
  assert.equal(jan.wargame.salary.status, 'open');
  assert.equal(decision(jan, 'spouseentity').status, 'upcoming', 'dependency driven stays upcoming');
  assert.equal(decision(jan, 'backdoor').status, 'upcoming');

  assert.equal(decision(buildScenario(db, { clock: '2027-01-01' }), 'salary27').status, 'open', 'on the date');
  assert.equal(decision(buildScenario(db, { clock: '2026-12-31' }), 'salary27').status, 'upcoming', 'the day before');
  const far = buildScenario(db, { clock: '2030-01-01' });
  assert.equal(decision(far, 'spouseentity').status, 'upcoming');
  assert.equal(decision(far, 'backdoor').status, 'upcoming');
}));

test('a done or dismissed linked rec decides an open decision and its war game', () => withSeeded(db => {
  setRecStatus(db, 'deferral', 'done');
  let sc = buildScenario(db);
  assert.equal(decision(sc, 'deferral').status, 'decided');
  assert.equal(decision(sc, 'deferral').line, 'Marked done on your plan.');
  assert.equal(sc.wargame.deferral.status, 'decided');
  assert.equal(sc.wargame.deferral.decided, 'Marked done on your plan.');

  setRecStatus(db, 'deferral', 'dismissed');
  sc = buildScenario(db);
  assert.equal(decision(sc, 'deferral').status, 'decided');
  assert.equal(decision(sc, 'deferral').line, 'Set aside on your plan.');
  assert.equal(sc.wargame.deferral.decided, 'Set aside on your plan.');

  setRecStatus(db, 'deferral', 'doing');
  sc = buildScenario(db);
  assert.equal(decision(sc, 'deferral').status, 'open', 'an active rec leaves the decision open');
  assert.equal(sc.wargame.deferral.status, 'open');

  setRecStatus(db, 'spouseentity', 'done');
  assert.equal(decision(buildScenario(db), 'spouseentity').status, 'decided', 'applies to upcoming decisions too');
}));

test('a stored decided decision keeps its stored line whatever its rec does', () => withSeeded(db => {
  setRecStatus(db, 'compmemo', 'dismissed');
  const sc = buildScenario(db);
  assert.equal(decision(sc, 'salary26').status, 'decided');
  assert.equal(decision(sc, 'salary26').line, demo.wargame.salary.decided);

  db.prepare("UPDATE decisions SET status = 'decided' WHERE id = 'dcfsa'").run();
  const d = demo.decisions.find(x => x.id === 'dcfsa');
  assert.equal(decision(buildScenario(db), 'dcfsa').line, `${d.when}. ${d.note}`, 'no war game: "<when>. <note>"');
}));

test('figures carry v, src, kind and label, and every src is a known source', () => withSeeded(db => {
  const sc = buildScenario(db);
  for (const [key, f] of Object.entries(demo.fig)) {
    assert.deepEqual(
      { v: sc.fig[key].v, src: sc.fig[key].src, kind: sc.fig[key].kind, label: sc.fig[key].label },
      { v: f.v, src: f.src, kind: f.kind, label: f.label }, key);
  }
  for (const [key, f] of Object.entries(sc.fig)) {
    assert.equal(typeof f.v, 'number', `${key}.v`);
    assert.ok(['a', 'p', 'e', 'm', 't'].includes(f.kind), `${key}.kind`);
    assert.equal(typeof f.label, 'string', `${key}.label`);
    assert.ok(sc.src[f.src] && sc.src[f.src].label, `${key}.src ${f.src} is a known source`);
  }
}));

test('war-game figures are derived at build time with model provenance', () => withSeeded(db => {
  const sc = buildScenario(db);
  assert.equal(sc.src['wargame-model'].label, 'War-game model, from your plan');
  for (const p of demo.wargame.salary.points) {
    for (const axis of ['x', 'y']) {
      const f = sc.fig[`wg.salary.${p.id}.${axis}`];
      assert.ok(f, `wg.salary.${p.id}.${axis}`);
      assert.equal(f.v, p[axis]);
      assert.equal(f.kind, 'm');
      assert.equal(f.src, 'wargame-model');
    }
  }
  for (const o of demo.wargame.deferral.options) {
    const want = { amount: o.amount, tax2026: o.tax2026, tax2027: o.tax2027, net: o.net, decCash: o.decCash, need: o.need, gap: o.need - o.decCash };
    for (const [field, v] of Object.entries(want)) {
      const f = sc.fig[`wg.deferral.${o.id}.${field}`];
      assert.ok(f, `wg.deferral.${o.id}.${field}`);
      assert.equal(f.v, v);
      assert.equal(f.kind, 'm');
      assert.equal(f.src, 'wargame-model');
    }
  }
}));

test('series points are figures with their kind', () => withSeeded(db => {
  const sc = buildScenario(db);
  for (const [key, s] of Object.entries(demo.series)) {
    s.points.forEach((p, i) => {
      const f = sc.fig[`series.${key}.${i}`];
      assert.ok(f, `series.${key}.${i}`);
      assert.equal(f.v, p.v);
      assert.equal(f.kind, p.kind);
      assert.ok(sc.src[f.src], `series.${key}.${i} source`);
    });
  }
}));

test('engine budget comes from settings.cap and the spend ledger for the clock month', () => withSeeded(db => {
  let sc = buildScenario(db);
  // spend_ledger.yyyymm holds the month as 'YYYY-MM', the same form as pnl_lines.period.
  const month = db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = '2026-11'").get().s;
  assert.equal(sc.engine.budget.used, demo.engine.budget.used, 'demo shows the mock numbers');
  assert.equal(sc.engine.budget.used, Math.round(month * 100) / 100, 'used is the ledger sum for the month');
  assert.equal(sc.engine.budget.monthly, demo.engine.budget.monthly);
  assert.deepEqual(sc.engine.jobs.map(j => j.id), demo.engine.jobs.map(j => j.id));

  const used = sc.engine.budget.used;
  const add = db.prepare("INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, 'chat', ?, 'test', '{}')");
  add.run('2026-11-05T10:00:00Z', '2026-11', 1.25);
  add.run('2026-10-05T10:00:00Z', '2026-10', 99);
  setSetting(db, 'cap', { usd: 300 });
  sc = buildScenario(db);
  assert.equal(sc.engine.budget.used, Math.round((used + 1.25) * 100) / 100);
  assert.equal(sc.engine.budget.monthly, 300);

  assert.equal(sc.fig['engine.budget.used'].v, sc.engine.budget.used);
  assert.equal(sc.fig['engine.budget.used'].kind, 'a');
  assert.equal(sc.fig['engine.budget.used'].src, 'spend-ledger');
  assert.equal(sc.fig['engine.budget.monthly'].v, 300);
  assert.equal(sc.fig['engine.budget.monthly'].kind, 'p');
  assert.equal(sc.fig['engine.budget.monthly'].src, 'settings');
  assert.equal(sc.fig['engine.budget.left'].v, Math.max(0, Math.round((300 - sc.engine.budget.used) * 100) / 100));
  assert.equal(sc.fig['engine.budget.left'].kind, 'e');
  assert.equal(sc.src['job-estimates'].label, 'Per-run cost estimate');
  for (const j of demo.engine.jobs.filter(x => typeof x.cost === 'number')) {
    const f = sc.fig[`engine.job.${j.id}.cost`];
    assert.ok(f, `engine.job.${j.id}.cost`);
    assert.equal(f.v, j.cost);
    assert.equal(f.kind, 'e');
    assert.equal(f.src, 'job-estimates');
  }
}));

test('an empty store builds a valid empty scenario', async () => {
  const t = await tempDb();
  try {
    const sc = buildScenario(t.db);
    for (const k of CONTRACT_KEYS) assert.ok(k in sc, `missing ${k}`);
    assert.deepEqual(sc.recs, []);
    assert.equal(sc.meta.product, 'Fathom');
    assert.equal(sc.live.demo, 'fresh', 'onboarding is not done on an empty store');
    assert.match(sc.live.clock, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    t.close();
  }
});

test('ask threads keep token-bearing HTML as stored', () => withSeeded(db => {
  const q = demo.ask.suggested[0];
  const key = 'ask:0123456789ab';
  db.prepare('INSERT OR IGNORE INTO conversations (key, created_at, last_at) VALUES (?, ?, ?)').run(key, '2026-11-05T09:00:00Z', '2026-11-05T09:01:00Z');
  db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'fathom', ?, ?, 0, '2026-11-05T09:01:00Z')")
    .run(key, paragraphs(q.a), JSON.stringify(q.refs));
  const conv = buildScenario(db).live.conversations[key];
  assert.equal(conv.length, 1);
  assert.equal(conv[0].role, 'fathom');
  assert.equal(conv[0].text, paragraphs(q.a));
  assert.deepEqual(conv[0].refs, q.refs);
  assert.ok(!conv[0].notice);
  assert.ok(conv[0].id != null && conv[0].ts);
}));


test('war-game starters lead only for open and upcoming games', () => withSeeded(db => {
  const ids = sc => sc.live.askStarters.map(s => s.id);
  assert.deepEqual(ids(buildScenario(db)).slice(0, 1), ['wargame-deferral']);
  db.prepare("UPDATE decisions SET status = 'open', decided_line = NULL WHERE id = 'salary26'").run();
  assert.deepEqual(ids(buildScenario(db)).slice(0, 2), ['wargame-salary', 'wargame-deferral']);
  db.prepare("UPDATE decisions SET status = 'upcoming', opens_on = '2027-01-01' WHERE id = 'salary26'").run();
  assert.equal(ids(buildScenario(db))[0], 'wargame-salary');
  const raw = JSON.parse(db.prepare("SELECT value FROM content WHERE key = 'wargame'").get().value);
  raw.salary.unavailable = 'Changed inputs';
  db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify(raw));
  db.prepare("UPDATE decisions SET unavailable_reason = 'Changed inputs' WHERE wargame = 'salary'").run();
  assert.ok(!ids(buildScenario(db)).includes('wargame-salary'));
  db.prepare("UPDATE decisions SET status = 'decided' WHERE wargame = 'deferral'").run();
  assert.ok(!ids(buildScenario(db)).includes('wargame-deferral'));
}));
