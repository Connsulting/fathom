// The planning run over a real-mode store: derive facts, compute figures and war-game models,
// evaluate the trigger catalog, write prose (model when accepted, else template), then write
// everything in one transaction. Runs are serialized per db handle and idempotent: a second run
// over the same data changes no row.
//
// runPlanning(db, engine, {now, packDirs}) -> {runId, status, counts, warnings, costUsd}

import { getSetting, tx, parseJson } from '../store/db.mjs';
import { upsertFact } from '../store/facts.mjs';
import { loadPacks, activePacks } from '../packs/index.mjs';
import { refreshPackStateIn, defaultPackDirs } from '../packs/state.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { TOKEN } from '../shared/tokens.mjs';
import { loadPlanningData, isoDateOf, resolveEntities } from './planner/data.mjs';
import { deriveFacts, deriveFigureFacts, mergeFacts, factProvenance, ownerFactsOf, PLANNER_SRC } from './planner/facts.mjs';
import { computeFigures } from './planner/figures.mjs';
import { writeProse } from './planner/prose.mjs';
import { applyRecs } from './planner/recs.mjs';
import { writeBrief, namesOf } from './planner/brief.mjs';
import { evaluateCatalog } from './triggers/index.mjs';
import { wargameFigurePrefixes } from './planner/wargame.mjs';

export const PLAN_JOB_ID = 'plan';

export class PlannerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PlannerError';
    this.code = code;
  }
}

const JOB = {
  id: PLAN_JOB_ID, name: 'Planning run', cadence: 'On demand',
  does: 'Derives facts and figures from your data, then refreshes your plan and brief.', cost: 0,
};

// One promise chain per db handle.
const chains = new WeakMap();

export function runPlanning(db, engine = null, opts = {}) {
  const prior = chains.get(db) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => run(db, engine, opts));
  chains.set(db, next.catch(() => {}));
  return next;
}

function storedFacts(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value, src, confirmed FROM facts').all()) {
    out[r.key] = { value: parseJson(r.value, null), src: r.src, confirmed: !!r.confirmed };
  }
  return out;
}

async function run(db, engine, { now, packDirs } = {}) {
  if (getSetting(db, 'mode', null) === 'demo') throw new PlannerError('demo_store', 'planning runs on real stores only');
  const clock = resolveClock(db, isoDateOf(now));
  db.prepare(`INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, (SELECT coalesce(max(sort) + 1, 0) FROM jobs))`)
    .run(JOB.id, JOB.name, JOB.cadence, JOB.does, JOB.cost);
  const runId = Number(db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES (?, ?, 'running')").run(PLAN_JOB_ID, new Date().toISOString()).lastInsertRowid);
  try {
    const result = await plan(db, engine, { clock, runId, packDirs: packDirs ?? defaultPackDirs() });
    db.prepare("UPDATE job_runs SET status = 'ok', finished_at = ?, cost_usd = ?, note = ? WHERE id = ?")
      .run(new Date().toISOString(), result.costUsd, JSON.stringify(result.counts), runId);
    return result;
  } catch (err) {
    const name = err && err.constructor && err.constructor.name ? err.constructor.name : 'Error';
    db.prepare("UPDATE job_runs SET status = 'error', finished_at = ?, note = ? WHERE id = ?")
      .run(new Date().toISOString(), JSON.stringify({ error: name, code: err instanceof PlannerError ? err.code : null }), runId);
    throw err;
  }
}

async function plan(db, engine, { clock, runId, packDirs }) {
  const packs = loadPacks(packDirs);
  const data = loadPlanningData(db, clock);
  const stored = storedFacts(db);
  const owner = ownerFactsOf(stored);
  const storedValues = Object.fromEntries(Object.entries(stored).map(([k, r]) => [k, r.value]));
  const entities = resolveEntities(data, storedValues);

  // Facts from the data, then figures over the merged facts, then the facts read off figures.
  const dataFacts = deriveFacts(data, { entities });
  const merged1 = mergeFacts(stored, dataFacts);
  const computed = computeFigures(data, merged1.values, { clock, entities, owner });
  const figFacts = deriveFigureFacts(computed.figures, merged1.values);
  const derived = { ...dataFacts, ...figFacts };
  // A blocked tax computation is not evidence of absence: keep the figure-derived facts (R14).
  const keep = computed.info.blocked.length ? ['income.agiEstimate', 'retirement.backdoorRothCandidate'] : [];
  const merged = mergeFacts(stored, derived, { keep });
  const warnings = new Set(computed.warnings);

  const activation = activePacks(packs, merged.values);
  const packStatus = Object.fromEntries(activation.map(a => [a.pack.id, a.status]));
  const overrides = Object.fromEntries(db.prepare('SELECT id, active FROM packs_state').all().map(r => [r.id, r.active]));
  const names = namesOf(merged.values);
  const fig = Object.fromEntries(Object.entries(computed.figures).map(([k, f]) => [k, { v: f.v, kind: f.kind, label: f.label, src: f.src }]));

  const ctx = {
    clock, year: data.taxYear, facts: merged.values, owner, fig,
    names, model: computed.model, data, packs, packStatus,
    info: computed.info, freshness: data.freshness, warnings: [...warnings], entities,
  };
  const results = evaluateCatalog(ctx);

  // Prose, outside the write transaction (it may call the engine).
  const recRows = new Map(db.prepare('SELECT id, def FROM recs').all().map(r => [r.id, r]));
  const prRows = new Map(db.prepare('SELECT rec_id, grounding_hash, prose_src FROM planner_recs').all().map(r => [r.rec_id, r]));
  const prose = {};
  const proseCounts = { model: 0, template: 0, kept: 0 };
  let costUsd = 0;
  for (const r of results) {
    if (r.state !== 'hit') continue;
    const id = r.trigger.id;
    if (recRows.has(id) && !prRows.has(id)) continue;
    const pr = prRows.get(id);
    const stored = pr ? { hash: pr.grounding_hash, src: pr.prose_src, def: parseJson(recRows.get(id).def, {}) } : null;
    const p = await writeProse(r.hit, ctx, { engine, stored });
    prose[id] = p;
    costUsd += p.costUsd;
    proseCounts[p.kept ? 'kept' : p.src] += 1;
  }
  costUsd = Math.round(costUsd * 1e6) / 1e6;

  const now = new Date().toISOString();
  const out = tx(db, () => {
    let factsWritten = 0;
    for (const w of merged.writes) {
      const res = upsertFact(db, { key: w.key, value: w.value, src: PLANNER_SRC, asOf: clock, confirmed: false, provenance: factProvenance(w) });
      if (res.written) factsWritten += 1;
    }
    const delFact = db.prepare('DELETE FROM facts WHERE key = ? AND src = ? AND confirmed = 0');
    for (const key of merged.deletes) {
      delFact.run(key, PLANNER_SRC);
      factsWritten += 1;
    }
    writeSources(db, computed.sources);
    writeFigures(db, computed.figures, now);
    const changes = applyRecs(db, results, {
      clock, now, runId, prose, packOverride: id => overrides[id] ?? null, warn: code => warnings.add(code),
    });
    refreshPackStateIn(db, { packDirs });
    const hits = results.filter(r => r.state === 'hit' && prose[r.trigger.id]).map(r => r.hit);
    writeBrief(db, { ...ctx, now }, { hits, changes });
    pruneFigures(db, computed.figures);
    return { factsWritten, changes };
  });

  const active = db.prepare('SELECT count(*) AS n FROM planner_recs WHERE retired_at IS NULL').get().n;
  const warningList = [...warnings].sort();
  const counts = {
    factsDerived: Object.keys(derived).length,
    factsWritten: out.factsWritten,
    figures: Object.keys(computed.figures).length,
    recs: { active, ...out.changes.counts },
    byTrigger: out.changes.byTrigger,
    prose: proseCounts,
    warnings: warningList.length,
  };
  return { runId, status: 'ok', counts, warnings: warningList, costUsd };
}

function writeSources(db, sources) {
  const get = db.prepare('SELECT label, as_of, kind FROM sources WHERE id = ?');
  const put = db.prepare(`INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES (?, ?, ?, ?, NULL, '')
                          ON CONFLICT(id) DO UPDATE SET label = excluded.label, as_of = excluded.as_of, kind = excluded.kind`);
  for (const [id, s] of Object.entries(sources)) {
    const row = get.get(id);
    if (row && row.label === s.label && row.as_of === s.asOf && row.kind === s.kind) continue;
    put.run(id, s.label, s.asOf, s.kind);
  }
}

function writeFigures(db, figures, now) {
  const get = db.prepare('SELECT v, src, kind, label, file_id, parser, locator FROM figures WHERE key = ?');
  const put = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(key) DO UPDATE SET v = excluded.v, src = excluded.src, kind = excluded.kind, label = excluded.label,
                            file_id = excluded.file_id, parser = excluded.parser, locator = excluded.locator, updated_at = excluded.updated_at`);
  for (const f of Object.values(figures)) {
    const locator = JSON.stringify(f.locator);
    const row = get.get(f.key);
    if (row && row.v === f.v && row.src === f.src && row.kind === f.kind && row.label === f.label
      && row.file_id === (f.fileId ?? null) && row.parser === PLANNER_SRC && row.locator === locator) continue;
    put.run(f.key, f.v, f.src, f.kind, f.label, f.fileId ?? null, PLANNER_SRC, locator, now);
  }
}

// S11, R14, T7: a planner figure not produced this run stays while a rec def (including mine),
// message, decision note or content row references it, or while a kept war-game entry names its
// point or option; otherwise it is deleted.
function pruneFigures(db, produced) {
  const stale = db.prepare('SELECT key FROM figures WHERE parser = ?').all(PLANNER_SRC).map(r => r.key).filter(k => !produced[k]);
  if (!stale.length) return;
  const refs = new Set();
  const scan = text => { for (const [, , key] of String(text ?? '').matchAll(TOKEN)) refs.add(key); };
  for (const r of db.prepare('SELECT def FROM recs').all()) {
    scan(r.def);
    const def = parseJson(r.def, {});
    for (const m of Array.isArray(def.mine) ? def.mine : []) if (m && m.fig) refs.add(m.fig);
  }
  for (const r of db.prepare('SELECT text FROM messages').all()) scan(r.text);
  for (const r of db.prepare('SELECT note FROM decisions').all()) scan(r.note);
  const prefixes = [];
  for (const r of db.prepare('SELECT key, value FROM content').all()) {
    scan(r.value);
    if (r.key === 'wargame') prefixes.push(...wargameFigurePrefixes(parseJson(r.value, {})));
  }
  const del = db.prepare('DELETE FROM figures WHERE key = ? AND parser = ?');
  for (const key of stale) {
    if (refs.has(key) || prefixes.some(p => key.startsWith(p))) continue;
    del.run(key, PLANNER_SRC);
  }
}
