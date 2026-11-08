import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { createHouseholdContext } from '../src/platform/runtime.mjs';
import { createInstanceSecrets } from '../src/platform/secrets.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { createEngine, loadCredential, BudgetExceededError, ModelAccountingError } from '../src/engine/index.mjs';
import { createSpendLedger } from '../src/engine/runtime.mjs';
import { modelFor } from '../src/engine/pricing.mjs';
import { figureViolationKinds as figureCheckNames } from '../src/shared/answer-discipline.mjs';
import { ANSWER_MAX_WORDS } from '../src/shared/answer-contract.mjs';
import { plainAnswerText as plain, placeBlocks } from '../src/shared/answer-text.mjs';
import { estimateEvalCost } from './reservation.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { fallbackTitle } from '../src/api/threads.mjs';
import { tokenScope } from '../src/scenario/build.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { tools, CAPABILITIES } from '../src/tools/index.mjs';
import { expectedFigures, validateCases } from './cases.mjs';
import { gradeBlocks, gradeRequiredTools, gradeFigures, gradeLength, gradeExpected, gradeProhibited, evidenceNumbers, gradeThreadTitle } from './graders.mjs';

export async function createEvalStore() {
  const dir = await mkdtemp(join(tmpdir(), 'fathom-ask-eval-'));
  let instance;
  try { instance = createInstance(dir, { mode: 'demo', init: seedDemo }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { ...instance, dataDir: dir, async close() {
    instance.db.close(); instance.platform.close(); await rm(dir, { recursive: true, force: true });
  } };
}
const rounded = value => Number(value.toFixed(12));
export function createEvalLedger({ db, maxUsd, onRound }) {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new TypeError('Invalid eval budget');
  const start = db.prepare('SELECT coalesce(max(id),0) AS id FROM spend_ledger').get().id;
  const base = createSpendLedger(db);
  const state = { stopped: null, reason: null };
  const reserves = [];
  let current = null, roundIndex = 0, outstanding = 0, reserved = 0;
  const cost = () => rounded(db.prepare('SELECT coalesce(sum(cost_usd),0) AS v FROM spend_ledger WHERE id>?').get(start).v);
  return {
    state, reserves,
    get costUsd() { return cost(); },
    get reservedUsd() { return rounded(reserved); },
    get outstandingReservedUsd() { return outstanding; },
    begin(request) { current = request; roundIndex = 0; return request; },
    end() { outstanding = 0; current = null; },
    continueBudget() {
      if (state.stopped === 'budget' && cost() < maxUsd) { state.stopped = null; state.reason = null; }
    },
    monthSpendUsd() { return state.stopped ? maxUsd : cost(); },
    admitRound(request) {
      const estimate = estimateEvalCost({ model: modelFor(request.purpose), maxTokens: request.maxTokens,
        system: [request.system, request.systemDynamic].filter(Boolean).join('\n'),
        messages: request.messages, tools: request.tools });
      const scripted = current?.fake?.[roundIndex++];
      const known = scripted && Object.hasOwn(scripted, 'costUsd') ? scripted.costUsd : undefined;
      const reserve = scripted && !scripted.accountingUnknown && Number.isFinite(known) && known >= 0 ? known
        : Math.max(Number.isFinite(known) && known >= 0 ? known : 0, estimate.costUsd);
      reserves.push(reserve);
      if (rounded(cost() + reserve) > maxUsd) {
        state.stopped = 'budget';
        state.reason = `budget: next ${request.purpose} round needs $${reserve.toFixed(6)}; $${rounded(maxUsd - cost()).toFixed(6)} remains`;
        onRound?.({ round: reserves.length, purpose: request.purpose, estimateUsd: reserve, actualUsd: 0,
          remainingUsd: rounded(maxUsd - cost()), admitted: false });
        throw new BudgetExceededError();
      }
      outstanding = reserve;
      reserved = rounded(reserved + reserve);
    },
    record(entry) {
      base.record(entry);
      onRound?.({ round: reserves.length, purpose: entry.purpose, estimateUsd: outstanding,
        actualUsd: entry.costUsd, remainingUsd: rounded(maxUsd - cost()), admitted: true });
      outstanding = 0;
      if (entry.tokens?.estimated) {
        state.stopped = 'accounting';
        state.reason = 'accounting: model usage was unavailable; conservative cost recorded';
      }
    },
  };
}
function scriptArgs(predicates) {
  const args = {};
  for (const p of predicates) {
    const parts = p.path.split('.');
    let out = args;
    for (const part of parts.slice(0, -1)) out = out[part] ??= {};
    const key = parts.at(-1);
    if (p.op === 'includes' || p.op === 'includes_or_absent') (out[key] ??= []).push(p.value);
    else if (p.op !== 'exists') out[key] = p.value;
  }
  return args;
}
function scriptedAnswer(turn, expected, missing) {
  if (turn.refusal || missing.length) return "Fathom doesn't have that.";
  if (turn.scriptedReply) return turn.scriptedReply;
  if (expected.length) return 'The stored result is ' + turn.expected.map((e, i) => e.kind === 'figure' ? `{f:${e.key}}` : String(expected[i])).join(', ') + '.';
  return 'The requested information is available in the returned tool data.';
}
export async function runCases({ cases, live = false, maxUsd = 100, outDir, scripts, onRound } = {}) {
  validateCases(cases);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new TypeError('Invalid eval budget');
  if (live && process.env.CI) throw new TypeError('Live evals never run in CI');
  const credential = live ? await loadCredential(process.env.FATHOM_CLAUDE_CREDENTIAL_FILE) : undefined;
  const store = await createEvalStore();
  const { db } = store;
  try {
    const ledger = createEvalLedger({ db, maxUsd, onRound });
    const mode = live ? 'live' : 'fake';
    const inner = createEngine({ mode, ledger, capUsd: maxUsd, credential, admitRound: request => ledger.admitRound(request) });
    const packs = createLivePacks(db, { dataDir: store.root }); packs.refresh();
    const clock = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='clock'").get().value);
    const figures = Object.fromEntries(db.prepare('SELECT key,v FROM figures').all().map(r => [r.key, r.v]));
    const rows = [];
    let attempts = [], reads = [], turn, missing = [], expected = [], requestLengths = [], caseScript = null, scriptMissing = false, capabilitiesMissing = false;
    const engine = { mode, isOn: () => true, async call(request) {
      const calls = scriptMissing || capabilitiesMissing ? [] : turn.required.filter(r => tools.some(t => t.name === r.name && t.operations.some(o => o.name === r.operation))).map(r => ({ name: r.name, args: { operation: r.operation, ...scriptArgs(r.predicates) } }));
      const supplied = scripts ? await scripts({ turn, expected, db, purpose: request.purpose, attempt: attempts.length }) : caseScript ? await caseScript({ turn, expected, db, purpose: request.purpose, attempt: attempts.length, clock, tools }) : [
        ...(calls.length ? [{ toolCalls: calls, costUsd: 0 }] : []),
        { text: scriptedAnswer(turn, expected, missing), costUsd: 0 },
      ];
      const scripted = !live ? { fake: request.purpose === 'title' && !scripts
        ? [{ text: JSON.stringify({ title: '529 education savings' }), costUsd: 0 }] : supplied } : {};
      const req = ledger.begin({ ...request, ...scripted });
      requestLengths.push(request.messages.length);
      try {
        const result = await inner.call(req);
        if (request.purpose !== 'title') attempts.push(result);
        return result;
      } catch (error) {
        if (error instanceof BudgetExceededError) ledger.state.stopped ??= 'budget';
        if (error instanceof ModelAccountingError) ledger.state.stopped = 'accounting';
        if (request.purpose !== 'title') attempts.push({ text: '', toolResults: error.toolResults ?? [], error: error.name });
        throw error;
      } finally { ledger.end(); }
    } };
    const config = { dataDir: store.dataDir, clock };
    const household = createHouseholdContext({ householdId: store.householdId, mode: 'demo', db, platform: store.platform,
      config, secrets: createInstanceSecrets({ config, mode: 'demo' }), engine, packs,
      answererFactory: options => createLiveAnswerer({ ...options, onRead: call => reads.push(call) }) });
    const answerer = household.answerer;
    for (const c of cases) {
      ledger.continueBudget();
      if (ledger.state.stopped) {
        rows.push({ id: c.id, family: c.family, status: 'unrun', turns: [], costUsd: 0, reservedUsd: 0,
          reason: `${ledger.state.reason ?? ledger.state.stopped}; run stopped before this case` });
        continue;
      }
      const goalId = `eval-${c.id}`;
      if (c.storedGoal) db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)")
        .run(goalId, JSON.stringify({ ...c.storedGoal, id: goalId, horizon: 'now', target: null, targetDate: null, track: null }), clock + 'T00:00:00.000Z');
      missing = c.expectedFail?.missingOperations ?? [];
      scriptMissing = Boolean(c.expectedFail?.missingScript);
      const scriptModule = c.requires?.script && !scriptMissing ? await import(new URL(`./scripts/${c.id}.mjs`, import.meta.url)) : null;
      await scriptModule?.setup?.({ db, clock });
      caseScript = !live ? scriptModule?.script ?? null : null;
      if (caseScript !== null && typeof caseScript !== 'function') throw new TypeError(`Invalid eval script ${c.id}`);
      const missingCapabilities = (c.expectedFail?.missingCapabilities ?? []).filter(name => !CAPABILITIES.includes(name));
      capabilitiesMissing = missingCapabilities.length > 0;
      const beforeCost = ledger.costUsd;
      const beforeReserved = ledger.reservedUsd;
      const result = { id: c.id, family: c.family, status: 'pass', missingOperations: missing, missingCapabilities, ...(scriptMissing ? { missingScript: c.expectedFail.missingScript } : {}), turns: [] };
      let key;
      for (turn of c.turns) {
        attempts = []; reads = []; requestLengths = [];
        expected = expectedFigures(db, turn.expected);
        const ctx = { db, packs, answerer, ...(c.checkTitle ? { engine } : {}), config: { clock, engine: mode }, body: key ? { key, text: turn.question } : { text: turn.question } };
        const response = key ? await ask(ctx) : await threadCreate(ctx);
        key ??= response.thread.key;
        const delivered = plain(response.message?.text);
        // A confirmed stored proposal runs without the model; its recorded execution is graded too.
        const confirmed = response.message?.provenance?.confirmedProposal ? response.message.provenance.tools ?? [] : [];
        const calls = [...reads, ...attempts.flatMap(a => a.toolResults), ...confirmed];
        const contextNumbers = evidenceNumbers([{ name: 'context', args: {}, result: { figures: Object.values(figures) } }]);
        const gradedAttempts = attempts.map((a, i) => ({ text: a.text, error: a.error ?? null,
          figures: gradeFigures(placeBlocks(a.text).text, [...reads, ...attempts.slice(0, i + 1).flatMap(r => r.toolResults)], { figures, contextNumbers }),
          length: gradeLength(placeBlocks(a.text).text, turn.maxWords ?? ANSWER_MAX_WORDS),
          prohibited: gradeProhibited(turn.prohibit, { text: a.text ?? '', writeCalls: 0 }) }));
        const blocks = gradeBlocks(response.message?.provenance, calls, c.blocks);
        const required = gradeRequiredTools(turn.required, calls);
        const numeric = gradeFigures(delivered, calls, { figures, contextNumbers });
        const length = gradeLength(delivered, turn.maxWords ?? ANSWER_MAX_WORDS);
        const expectedGrade = gradeExpected(delivered, expected, { figures });
        const refusal = !turn.refusal || /\b(?:don't|doesn't|do not|does not|cannot|can't|not available|not stored|not tracked|no access)\b/i.test(delivered);
        const prohibited = gradeProhibited(turn.prohibit, { text: delivered, writeCalls: calls.filter(c => tools.some(t => t.name === c.name && t.kind !== 'read')).length });
        const scriptForTurn = (scriptMissing || capabilitiesMissing) && turn.required.some(r => c.requires?.operations?.includes(`${r.name}.${r.operation}`));
        const existingToolsOk = required.checks.filter(r => !missing.includes(`${r.name}.${r.operation}`))
          .every(r => r.ok || (scriptForTurn && r.status === 'missing'));
        const safe = numeric.ok && length.ok && refusal && prohibited.ok;
        const ok = safe && blocks.ok && required.ok && expectedGrade.ok && !response.message?.notice;
        const turnMissing = scriptForTurn || turn.required.some(r => missing.includes(`${r.name}.${r.operation}`));
        const gapOnly = turnMissing && safe && existingToolsOk && !response.message?.notice;
        const failingChecks = [
          ...required.checks.filter(r => !r.ok).map(r => `required.${r.name}.${r.operation}`),
          ...figureCheckNames(numeric), ...blocks.violations.map(v => v.kind),
          ...(!length.ok ? ['length'] : []),
          ...expectedGrade.checks.flatMap((e, i) => e.ok ? [] : [`expected[${i}]`]),
          ...(!refusal ? ['refusal'] : []), ...(!prohibited.ok ? ['prohibited'] : []),
          ...(response.message?.notice ? ['notice'] : []),
        ];
        const failedDrafts = gradedAttempts.slice(0, -1).filter(a => !a.figures.ok || !a.length.ok || !a.prohibited.ok || a.error).length;
        result.turns.push({ question: turn.question, rubric: turn.rubric, delivered, tools: calls, required,
          blocks, figures: numeric, expected: expectedGrade, length, refusal, prohibited, failingChecks, failedDrafts, attempts: gradedAttempts,
          blockedBy: gapOnly ? missing.filter(pair => turn.required.some(r => `${r.name}.${r.operation}` === pair)) : [],
          grounding: response.message?.provenance?.grounding ?? null, discipline: response.message?.provenance?.discipline ?? null, historyMessages: Math.max(0, ...requestLengths), ok });
        if (ledger.state.stopped) { result.status = `${ledger.state.stopped}-stopped`; break; }
        if (!ok && !gapOnly) result.status = 'fail';
        else if (result.status !== 'fail' && gapOnly) result.status = 'xfail';
        else if (result.status !== 'fail' && c.expectedFail && !missing.length && ok) result.status = 'xpass';
      }
      if (c.checkTitle && !ledger.state.stopped) {
        const row = db.prepare('SELECT title, title_source FROM conversations WHERE key=?').get(key);
        const first = db.prepare("SELECT text FROM messages WHERE conversation_key=? AND role='me' ORDER BY id LIMIT 1").get(key);
        result.title = gradeThreadTitle(row, fallbackTitle(tokenScope(db), first?.text));
        if (!result.title.ok) result.status = 'fail';
      }
      result.costUsd = rounded(ledger.costUsd - beforeCost);
      result.reservedUsd = rounded(ledger.reservedUsd - beforeReserved);
      if (ledger.state.stopped) result.reason = ledger.state.reason ?? `${ledger.state.stopped}: no remaining budget for another round`;
      result.failingChecks = [...new Set([...result.turns.flatMap(t => t.failingChecks), ...(result.title && !result.title.ok ? ['title'] : [])])];
      result.failedDrafts = result.turns.reduce((sum, t) => sum + t.failedDrafts, 0);
      rows.push(result);
      if (c.storedGoal) db.prepare('DELETE FROM goals WHERE id = ?').run(goalId);
    }
    const correctionTriggers = {};
    for (const row of rows) for (const turn of row.turns) {
      for (const kind of new Set(turn.discipline?.triggeredBy ?? []))
        correctionTriggers[kind] = (correctionTriggers[kind] ?? 0) + 1;
    }
    const scorecard = { correctionTriggers, version: 2, live, generatedAt: new Date().toISOString(), maxUsd, costUsd: ledger.costUsd,
      reservedUsd: ledger.reservedUsd, outstandingReservedUsd: ledger.outstandingReservedUsd,
      releasedUsd: rounded(ledger.reservedUsd - ledger.costUsd),
      stopped: ledger.state.stopped ?? (rows.some(r => r.status === 'budget-stopped') ? 'budget' : null), selected: cases.length,
      failedDrafts: rows.reduce((sum, c) => sum + (c.failedDrafts ?? 0), 0),
      attempted: rows.filter(r => r.status !== 'unrun').length,
      completed: rows.filter(r => !['unrun', 'budget-stopped', 'accounting-stopped'].includes(r.status)).length, cases: rows };
    if (outDir) await writeScorecard(outDir, scorecard);
    return scorecard;
  } finally { await store.close(); }
}
export async function writeScorecard(dir, scorecard) {
  await mkdir(dir, { recursive: true });
  const lines = ['# Ask evals', '', `Tier: ${scorecard.live ? 'live' : 'scripted'}. Cost: $${scorecard.costUsd.toFixed(6)}. Stop: ${scorecard.stopped ?? 'none'}.`, '', `Reserved (cumulative, reused after each round): $${scorecard.reservedUsd.toFixed(6)}. Spent: $${scorecard.costUsd.toFixed(6)}. Outstanding: $${scorecard.outstandingReservedUsd.toFixed(6)}.`, '',
    `Failed superseded drafts (report only): ${scorecard.failedDrafts ?? 0}.`, '',
    `Correction triggers (answers per kind): ${Object.entries(scorecard.correctionTriggers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'none'}.`, '',
    '| Case | Result | Tools called / required | unsourced / self-computed / rounded / spelled_out / context-only | Words / budget | Actual cost | Reserved | Missing operations | Failing checks | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const kindCount = (grade, kind) => (grade?.[kind === 'self-computed' ? 'selfComputed' : kind === 'spelled_out' ? 'spelledOut' : kind === 'context-only' ? 'contextOnly' : kind] ?? []).length;
  for (const c of scorecard.cases) {
    const names = c.turns.flatMap(t => t.tools.map(r => r.name)).join(', ');
    const required = c.turns.flatMap(t => t.required.checks.map(r => `${r.name}.${r.operation}:${r.status}`)).join(', ');
    const grades = c.turns.map(t => t.figures);
    const counts = ['unsourced', 'self-computed', 'rounded', 'spelled_out', 'context-only']
      .map(kind => grades.reduce((s, grade) => s + kindCount(grade, kind), 0));
    lines.push(`| ${c.id} | ${c.status} | ${names || 'none'} / ${required} | ${counts.join(' / ')} | ${c.turns.map(t => `${t.length.words}/${t.length.maxWords}`).join(', ')} | $${c.costUsd.toFixed(6)} | $${c.reservedUsd.toFixed(6)} | ${(c.missingOperations ?? []).join(', ')} | ${(c.failingChecks ?? []).join(', ')} | ${(c.reason ?? '').replaceAll('|', '/')} |`);
  }
  await writeFile(join(dir, 'scorecard.json'), JSON.stringify(scorecard, null, 2) + '\n');
  await writeFile(join(dir, 'summary.md'), lines.join('\n') + '\n');
}
