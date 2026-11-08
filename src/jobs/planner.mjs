import { retryIncompletePaystubs } from '../ingest/pipeline.mjs';
import { planningYear } from './planner/data.mjs';
// The planning run over a real-mode store: derive facts, compute figures and war-game models,
// evaluate the trigger catalog, write prose (model when accepted, else template), then write
// everything in one transaction. Runs are serialized per db handle and idempotent: a second run
// over the same data changes no row. The scheduler's plan job (src/jobs/scheduler.mjs) is the only
// caller: it claims the job_runs row, passes its id as runId and records status, timing, cost and
// the counts note. planner_recs first_run and last_run reference that row.
//
// runPlanning(db, engine, {now, packDirs, runId}) -> {runId, status, counts, warnings, costUsd}

import { getSetting, tx, parseJson } from '../store/db.mjs';
import { withLabelHints } from '../accounts/naming.mjs';
import { upsertFact } from '../store/facts.mjs';
import { withholdingRecipient, ask, canonicalJson, FACT_CHECK_OPTIONS } from '../ingest/confirm.mjs';
import { loadPacks, activePacks } from '../packs/index.mjs';
import { refreshPackState, defaultPackDirs } from '../packs/state.mjs';
import { resolveClock, loadGoals, loadCurve, loadContent } from '../scenario/build.mjs';
import { TOKEN } from '../shared/tokens.mjs';
import { loadPlanningData, isoDateOf, resolveEntities } from './planner/data.mjs';
import { deriveFacts, deriveFigureFacts, mergeFacts, factProvenance, ownerFactsOf, PLANNER_SRC } from './planner/facts.mjs';
import { computeFigures } from './planner/figures.mjs';
import { writeProse } from './planner/prose.mjs';
import { applyRecs } from './planner/recs.mjs';
import { writeBrief, namesOf, upsertContent } from './planner/brief.mjs';
import { adoptSuggestions } from '../goals/write.mjs';
import { evaluateCatalog } from './triggers/index.mjs';
import { reasonText, fixForCode, items as missingItems } from './triggers/missing-data.mjs';
import { wargameFigurePrefixes } from './planner/wargame.mjs';
import { notBuiltReason } from './planner/unlocks.mjs';
import { prepareRecFacts } from '../facts/derive.mjs';
import { sendToAdvisor } from '../advisor/index.mjs';
import { liftStaleVetoes } from '../advisor/index.mjs';
import { autoResolve } from '../ingest/auto.mjs';
import { autoDecideCategories } from '../categories/guess.mjs';
import { refreshDependencies } from '../ingest/coverage.mjs';
import { reconcileTransactionPayments, observedPayments } from '../ingest/transaction-payments.mjs';

export const PLAN_JOB_ID = 'plan';

export class PlannerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PlannerError';
    this.code = code;
  }
}

// One promise chain per db handle.
const chains = new WeakMap();

export function runPlanning(db, engine = null, opts = {}) {
  if (!opts || !Number.isInteger(opts.runId)) throw new TypeError('runPlanning needs runId, the id of the job_runs row the scheduler claimed');
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

async function run(db, engine, { now, packDirs, runId, household }) {
  if (getSetting(db, 'mode', null) === 'demo') throw new PlannerError('demo_store', 'planning runs on real stores only');
  const claim = db.prepare('SELECT job_id, status FROM job_runs WHERE id = ?').get(runId);
  if (claim?.job_id !== PLAN_JOB_ID || claim.status !== 'running') throw new PlannerError('invalid_run', 'runId must identify a running local plan claim');
  const clock = resolveClock(db, isoDateOf(now));
  await retryIncompletePaystubs(db, { household, engine, now: clock, taxYear: planningYear(clock) });
  return plan(db, engine, { clock, runId, packDirs: packDirs ?? defaultPackDirs() });
}

async function plan(db, engine, { clock, runId, packDirs }) {
  reconcileTransactionPayments(db, { now: clock });
  autoResolve(db, { now: clock });
  autoDecideCategories(db,{now:clock});
  const packs = loadPacks(packDirs);
  const data = loadPlanningData(db, clock);
  const recFacts = prepareRecFacts(db, data);
  const stored = storedFacts(db);
  for (const key of recFacts.deletes) delete stored[key];
  for (const [key, value] of Object.entries(recFacts.values)) {
    if (!stored[key] || recFacts.writes.some(w => w.key === key)) stored[key] = { value, src: `derived:${clock}`, confirmed: false };
    else stored[key] = { ...stored[key], value };
  }
  const owner = ownerFactsOf(stored);
  const entities = resolveEntities(data, recFacts.values);

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

  // The owner's goals and tradeoff curve positions rank recs that tie on their window.
  const accountRows = withLabelHints(db, db.prepare('SELECT * FROM accounts').all());
  const prefs = {
    goals: loadGoals(db, { fig: { ...fig }, accounts: accountRows }),
    accounts: accountRows,
    curve: Object.fromEntries(loadCurve(db, loadContent(db)).map(c => [c.id, c.value])),
  };
  const ctx = {
    clock, year: data.taxYear, facts: merged.values, owner, fig,
    names, model: computed.model, data, packs, packStatus, mortgage: recFacts.mortgage,
    refreshNeeds: refreshDependencies(db, computed.figures, clock),
    assumptions: recFacts.assumptions, info: computed.info, freshness: data.freshness, warnings: [...warnings], entities, goals: prefs.goals, curve: prefs.curve,
  };
  const results = evaluateCatalog(ctx);
  // The data codes still open after this run: every missing-data item and every verifiable step a
  // trigger emitted (a trigger emits one only while its gap holds). A step naming a code no longer
  // here reads done.
  const openData = [...new Set([...missingItems(ctx).map(i => i.code), ...computed.info.blocked.filter(code => code.startsWith('entity_unclassified:')),
    ...results.filter(r => r.state === 'hit').flatMap(r => r.hit.rec.tasks || []).map(t => t.code).filter(c => typeof c === 'string')])];

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
    if (r.hit.rec.advisorQuestions?.length) {
      p.fields = { summary: 'Your advisor will confirm the plan terms and any reasonable salary range. Planning uses the salary of record as an assumption while you wait.',
        why: ['These professional judgments are included in the advisor packet.'], qa: [] };
      p.src = 'template';
    }
    prose[id] = p;
    costUsd += p.costUsd;
    proseCounts[p.kept ? 'kept' : p.src] += 1;
  }
  costUsd = Math.round(costUsd * 1e6) / 1e6;

  const now = new Date().toISOString();
  const out = tx(db, () => {
    let factsWritten = recFacts.write();
    for (const w of merged.writes) {
      const res = upsertFact(db, { key: w.key, value: w.value, src: PLANNER_SRC, asOf: clock, confirmed: false, provenance: factProvenance(w) });
      if (res.written && res.changed) factsWritten += 1;
    }
    // D9: a payroll document nobody has said is whose gets ingest's own recipient question (an
    // existing or answered question is left as it is).
    for (const q of computed.info.ask || []) withholdingRecipient(db, { ...q, now });
    askFactChecks(db, merged.checks, { clock, now });
    const delFact = db.prepare('DELETE FROM facts WHERE key = ? AND src = ? AND confirmed = 0');
    for (const key of merged.deletes) {
      delFact.run(key, PLANNER_SRC);
      factsWritten += 1;
    }
    writeSources(db, computed.sources);
    writeFigures(db, computed.figures, now);
    const changes = applyRecs(db, results, {
      clock, now, runId, prose, packOverride: id => overrides[id] ?? null, warn: code => warnings.add(code), prefs,
      stepEnv: { facts: merged.values, accounts: accountRows, open: openData, mortgage: recFacts.mortgage, payments: observedPayments(db) },
    });
    for (const r of results.filter(r => r.state === 'hit')) {
      const id = r.trigger.id;
      const row = db.prepare('SELECT status, waiting_on FROM recs WHERE id = ?').get(id);
      if (!row) continue;
      if (r.hit.rec.advisorQuestions?.length) {
        if (!['proposed', 'doing', 'waiting'].includes(row.status)) continue;
        if (row.status !== 'waiting') {
          db.prepare("UPDATE recs SET status = 'waiting', waiting_on = 'advisor', updated_at = ? WHERE id = ?").run(now, id);
          db.prepare("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, 'advisor_wait', ?, ?, 'waiting', 'planner')")
            .run(id, now, row.status, row.status);
        }
        if (!db.prepare('SELECT id FROM advisor_reviews WHERE rec_id = ? AND closed_at IS NULL').get(id)) sendToAdvisor(db, id, { now });
      } else if (row.status === 'waiting' && row.waiting_on === 'advisor') {
        const last = db.prepare('SELECT action, arg, actor FROM rec_events WHERE rec_id = ? AND from_status IS NOT to_status ORDER BY id DESC LIMIT 1').get(id);
        if (last?.actor !== 'planner' || last.action !== 'advisor_wait') continue;
        const status = last.arg === 'doing' ? 'doing' : 'proposed';
        db.prepare('UPDATE recs SET status = ?, waiting_on = NULL, updated_at = ? WHERE id = ?').run(status, now, id);
        db.prepare("INSERT INTO rec_events (rec_id, ts, action, from_status, to_status, actor) VALUES (?, ?, 'advisor_ready', 'waiting', ?, 'planner')")
          .run(id, now, status);
        db.prepare("UPDATE advisor_reviews SET closed_at = ?, closed_reason = 'questions answered' WHERE rec_id = ? AND closed_at IS NULL AND verdict IS NULL").run(now, id);
      }
    }
    // What each blocked rec is waiting on (plain reason, the task that clears it, where it is done),
    // read back by the scenario for recs in the waiting status.
    upsertContent(db, 'rec.openData', openData, now);
    upsertContent(db, 'rec.blockers', Object.fromEntries(results.filter(r => r.state === 'blocked' && r.blocker).map(r => [r.trigger.id, r.blocker])), now);
    // A vetoed rec stays dismissed (applyRecs keeps the owner's status) unless its inputs changed.
    liftStaleVetoes(db, { now });
    refreshPackState(db, { packDirs });
    linkPackRecs(db, now);
    const hits = results.filter(r => r.state === 'hit' && prose[r.trigger.id]).map(r => r.hit);
    writeBrief(db, { ...ctx, now }, { hits, changes });
    pruneFigures(db, computed.figures, ctx);
    return { factsWritten, changes };
  });

  // Fathom sets the calculator's target on every goal that has none and has not declined it.
  adoptSuggestions(db, { now, clock });
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

// D13: a derived value that disagrees with an owner's notes fact is asked about with ingest's own
// fact_check question (subject <source>|<key>|<canonical JSON value>, as recordFact builds it), never
// written. The context records the notes value it is asked against (stored), so the question goes
// stale only when the notes fact changes. A pending planner question for another value of the key,
// or for a key with no disagreement left, is closed as superseded, so a rerun with the same value
// asks nothing new. A question for this value that is pending against another notes value (or one
// asked before stored was recorded), or was closed as superseded, is asked again in place with the
// current context (the (kind, subject) pair is unique).
function askFactChecks(db, checks, { clock, now }) {
  const close = db.prepare("UPDATE confirm_items SET status = 'answered', answer = 'superseded', answered_at = ? WHERE id = ?");
  const reask = db.prepare("UPDATE confirm_items SET status = 'pending', answer = NULL, answered_at = NULL, question = ?, context = ?, file_id = ? WHERE id = ?");
  const bySubject = db.prepare("SELECT id, status, answer, context FROM confirm_items WHERE kind = 'fact_check' AND subject = ?");
  const pending = db.prepare("SELECT id, subject, context FROM confirm_items WHERE kind = 'fact_check' AND status = 'pending'").all()
    .map(r => ({ ...r, context: parseJson(r.context, {}) || {} })).filter(r => [PLANNER_SRC, 'ledger-confirm'].includes(r.context.src));
  const keys = new Set(checks.map(c => c.key));
  for (const p of pending) if (!keys.has(p.context.key)) close.run(now, p.id);
  for (const c of checks) {
    const json = canonicalJson(c.value);
    const src = c.src || PLANNER_SRC;
    const subject = `${src}|${c.key}|${json}`;
    for (const p of pending) if (p.context.key === c.key && p.subject !== subject) close.run(now, p.id);
    const { fileId, parser, locator } = factProvenance(c);
    const question = c.question || `Your data says ${c.key} is ${json}, but your notes say ${canonicalJson(c.stored)}. Is the data right?`;
    const context = { key: c.key, value: c.value, stored: c.stored, src, asOf: clock, fileId, parser, locator, confidence: c.src === 'ledger-confirm' ? null : 1 };
    const prior = bySubject.get(subject);
    if (prior) {
      const was = parseJson(prior.context, {}) || {};
      const askedAgainst = Object.hasOwn(was, 'stored') ? canonicalJson(was.stored) : null;
      const outdated = prior.status === 'pending' && askedAgainst !== canonicalJson(c.stored);
      if (outdated || (prior.status === 'answered' && prior.answer === 'superseded')) {
        reask.run(question, JSON.stringify(context), fileId ?? null, prior.id);
        continue;
      }
    }
    ask(db, { kind: 'fact_check', subject, question, options: FACT_CHECK_OPTIONS, context, fileId, now });
  }
}

// Pack defs list their recs (R12): recIds are the recs whose pack_id is the pack, sorted.
// refreshPackState keeps recIds as stored, so the planner sets them after it writes recs.
function linkPackRecs(db, now) {
  const recIdsOf = db.prepare('SELECT id FROM recs WHERE pack_id = ? ORDER BY id');
  const update = db.prepare('UPDATE packs_state SET def = ?, updated_at = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, def FROM packs_state').all()) {
    const def = parseJson(row.def, null);
    if (!def || typeof def !== 'object') continue;
    const text = JSON.stringify({ ...def, recIds: recIdsOf.all(row.id).map(r => r.id) });
    if (text !== row.def) update.run(text, now, row.id);
  }
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

// A produced figure is current: its unavailable_reason is cleared (R2-9).
function writeFigures(db, figures, now) {
  const get = db.prepare('SELECT v, src, kind, label, file_id, parser, locator, unavailable_reason FROM figures WHERE key = ?');
  const put = db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at, unavailable_reason)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                          ON CONFLICT(key) DO UPDATE SET v = excluded.v, src = excluded.src, kind = excluded.kind, label = excluded.label,
                            file_id = excluded.file_id, parser = excluded.parser, locator = excluded.locator, updated_at = excluded.updated_at,
                            unavailable_reason = NULL`);
  for (const f of Object.values(figures)) {
    const locator = JSON.stringify(f.locator);
    const row = get.get(f.key);
    if (row && row.v === f.v && row.src === f.src && row.kind === f.kind && row.label === f.label
      && row.file_id === (f.fileId ?? null) && row.parser === PLANNER_SRC && row.locator === locator && row.unavailable_reason == null) continue;
    put.run(f.key, f.v, f.src, f.kind, f.label, f.fileId ?? null, PLANNER_SRC, locator, now);
  }
}

// S11, R14, T7: a planner figure not produced this run stays while a rec def (including mine),
// message, decision note or content row references it, or while a kept war-game entry names its
// point or option; otherwise it is deleted. A kept figure is marked unavailable with the readable
// reason it was not produced (R2-9): the withheld code, else the run's first block, else a generic
// "no longer computed" line. Triggers never read it: they see only this run's figures.
const fixOrNull = code => { try { return fixForCode(code); } catch { return null; } };

function pruneFigures(db, produced, ctx) {
  const stale = db.prepare('SELECT key, unavailable_reason, locator FROM figures WHERE parser = ?').all(PLANNER_SRC).filter(r => !produced[r.key]);
  if (!stale.length) return;
  const refs = new Set();
  const scan = text => { for (const [, , key] of String(text ?? '').matchAll(TOKEN)) refs.add(key); };
  for (const r of db.prepare('SELECT def FROM recs').all()) {
    scan(r.def);
    const def = parseJson(r.def, {});
    for (const m of Array.isArray(def.mine) ? def.mine : []) if (m && m.fig) refs.add(m.fig);
  }
  for (const r of db.prepare('SELECT text FROM messages').all()) scan(r.text);
  for (const r of db.prepare('SELECT note, decided_line FROM decisions').all()) { scan(r.note); scan(r.decided_line); }
  const prefixes = [];
  // H3: a point or option left out of a current game gives its own figures its reason and fix.
  const excluded = [];
  for (const r of db.prepare('SELECT key, value FROM content').all()) {
    scan(r.value);
    if (r.key !== 'wargame') continue;
    const wg = parseJson(r.value, {}) || {};
    prefixes.push(...wargameFigurePrefixes(wg));
    for (const name of ['salary', 'deferral']) for (const e of Array.isArray(wg[name]?.excluded) ? wg[name].excluded : []) {
      if (e && typeof e.invalid === 'string') excluded.push({ prefix: `wg.${name}.${e.id}.`, text: e.invalid, fix: e.fix || null });
    }
  }
  const info = ctx.info || {};
  const withheld = info.withheld || {};
  const del = db.prepare('DELETE FROM figures WHERE key = ? AND parser = ?');
  const mark = db.prepare('UPDATE figures SET unavailable_reason = ?, locator = ? WHERE key = ? AND parser = ?');
  for (const { key, unavailable_reason: was, locator } of stale) {
    if (refs.has(key) || prefixes.some(p => key.startsWith(p))) {
      // H3: the reason's fix rides in the locator, so the figure shows it beside the reason. A
      // war-game figure takes its game's reason.
      const game = ['salary', 'deferral'].find(n => key.startsWith(`wg.${n}.`) && info.wargameInvalid?.[n]);
      const code = withheld[key] || (info.blocked || [])[0] || null;
      const why = game ? notBuiltReason(game, info.wargameInvalid[game]) : excluded.find(e => key.startsWith(e.prefix)) || null;
      const reason = why ? why.text : reasonText(ctx, code);
      const fix = why ? why.fix : code ? fixOrNull(code) : null;
      const { unavailableFix, ...loc } = parseJson(locator, {}) || {};
      void unavailableFix;
      const next = JSON.stringify(fix ? { ...loc, unavailableFix: fix } : loc);
      if (was !== reason || next !== locator) mark.run(reason, next, key, PLANNER_SRC);
      continue;
    }
    del.run(key, PLANNER_SRC);
  }
}
