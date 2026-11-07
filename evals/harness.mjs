import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { createEngine, loadCredential, BudgetExceededError, ModelAccountingError } from '../src/engine/index.mjs';
import { createSpendLedger } from '../src/engine/runtime.mjs';
import { estimateUnknownCost, DEFAULT_MODEL } from '../src/engine/pricing.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { tools } from '../src/tools/index.mjs';
import { expectedFigures, validateCases } from './cases.mjs';
import { gradeRequiredTools, gradeFigures, gradeLength, gradeExpected, evidenceNumbers } from './graders.mjs';

export async function createEvalStore() {
  const dir = await mkdtemp(join(tmpdir(), 'fathom-ask-eval-'));
  let instance;
  try { instance = createInstance(dir, { mode: 'demo', init: seedDemo }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { ...instance, dataDir: dir, async close() {
    instance.db.close(); instance.platform.close(); await rm(dir, { recursive: true, force: true });
  } };
}
const byteLength = v => Buffer.byteLength(JSON.stringify(v));
export function createEvalLedger({ db, maxUsd }) {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new TypeError('Invalid eval budget');
  const start = db.prepare('SELECT coalesce(max(id),0) AS id FROM spend_ledger').get().id;
  const base = createSpendLedger(db);
  const state = { stopped: null };
  const reserves = [];
  let current = null;
  let growthBytes = 0;
  const cost = () => Number(db.prepare('SELECT coalesce(sum(cost_usd),0) AS v FROM spend_ledger WHERE id>?').get(start).v.toFixed(12));
  return {
    state, reserves,
    get costUsd() { return cost(); },
    begin(request) {
      growthBytes = 0;
      current = request;
      const wrappedTools = request.tools.map(tool => ({ ...tool, async handler(args, ctx) {
        const result = await tool.handler(args, ctx);
        growthBytes += byteLength({ name: tool.name, args, result }) * 6 + 1024;
        return result;
      } }));
      return { ...request, tools: wrappedTools };
    },
    monthSpendUsd() {
      const spent = cost();
      if (!current || state.stopped) return maxUsd;
      const messages = [...current.messages, { role: 'assistant', content: ' '.repeat(growthBytes) }];
      const reserve = estimateUnknownCost({ model: DEFAULT_MODEL, maxTokens: 1024,
        system: [current.system, current.systemDynamic].filter(Boolean).join('\n'), messages, tools: current.tools }).costUsd;
      reserves.push(reserve);
      if (spent + reserve > maxUsd) { state.stopped = 'budget'; return maxUsd; }
      return spent;
    },
    record(entry) {
      base.record(entry);
      // Include JSON escaping, long token spellings and tool-use envelopes before a continuation.
      growthBytes += 1024 * 16 * 6 + 4096;
      if (entry.tokens?.estimated) state.stopped = 'accounting';
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
    if (p.op === 'includes') (out[key] ??= []).push(p.value);
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
function plain(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
export async function runCases({ cases, live = false, maxUsd = 100, outDir, scripts } = {}) {
  validateCases(cases);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new TypeError('Invalid eval budget');
  if (live && process.env.CI) throw new TypeError('Live evals never run in CI');
  const credential = live ? await loadCredential(process.env.FATHOM_CLAUDE_CREDENTIAL_FILE) : undefined;
  const store = await createEvalStore();
  const { db } = store;
  try {
    const ledger = createEvalLedger({ db, maxUsd });
    const mode = live ? 'live' : 'fake';
    const inner = createEngine({ mode, ledger, capUsd: maxUsd, credential });
    const packs = createLivePacks(db, { dataDir: store.dataDir }); packs.refresh();
    const clock = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='clock'").get().value);
    const figures = Object.fromEntries(db.prepare('SELECT key,v FROM figures').all().map(r => [r.key, r.v]));
    const rows = [];
    let attempts = [], turn, missing = [], expected = [], requestLengths = [];
    const engine = { mode, isOn: () => true, async call(request) {
      const calls = turn.required.filter(r => tools.some(t => t.name === r.name)).map(r => ({ name: r.name, args: scriptArgs(r.predicates) }));
      const supplied = scripts ? scripts({ turn, expected, db, attempt: attempts.length }) : [
        ...(calls.length ? [{ toolCalls: calls, costUsd: 0 }] : []),
        { text: scriptedAnswer(turn, expected, missing), costUsd: 0 },
      ];
      const scripted = !live ? { fake: supplied } : {};
      const req = ledger.begin({ ...request, ...scripted });
      requestLengths.push(request.messages.length);
      try {
        const result = await inner.call(req);
        attempts.push(result);
        return result;
      } catch (error) {
        if (error instanceof BudgetExceededError) ledger.state.stopped ??= 'budget';
        if (error instanceof ModelAccountingError) ledger.state.stopped = 'accounting';
        attempts.push({ text: '', toolResults: error.toolResults ?? [], error: error.name });
        throw error;
      }
    } };
    const answerer = createLiveAnswerer({ engine, packs });
    for (const c of cases) {
      const goalId = `eval-${c.id}`;
      if (c.storedGoal) db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)")
        .run(goalId, JSON.stringify({ ...c.storedGoal, id: goalId, horizon: 'now', target: null, targetDate: null, track: null }), clock + 'T00:00:00.000Z');
      missing = (c.expectedFail?.missingTools ?? []).filter(name => !tools.some(t => t.name === name));
      const beforeCost = ledger.costUsd;
      const result = { id: c.id, family: c.family, status: 'pass', missingTools: missing, turns: [] };
      let key;
      for (turn of c.turns) {
        attempts = []; requestLengths = [];
        expected = expectedFigures(db, turn.expected);
        const ctx = { db, packs, answerer, config: { clock, engine: mode }, body: key ? { key, text: turn.question } : { text: turn.question } };
        const response = key ? await ask(ctx) : await threadCreate(ctx);
        key ??= response.thread.key;
        const delivered = plain(response.message?.text);
        const calls = attempts.flatMap(a => a.toolResults);
        const contextNumbers = evidenceNumbers([{ name: 'context', args: {}, result: { figures: Object.values(figures) } }]);
        const gradedAttempts = attempts.map((a, i) => ({ text: a.text, error: a.error ?? null,
          figures: gradeFigures(a.text, attempts.slice(0, i + 1).flatMap(r => r.toolResults), { figures, contextNumbers }),
          length: gradeLength(a.text, turn.maxWords) }));
        const required = gradeRequiredTools(turn.required, calls);
        const numeric = gradeFigures(delivered, calls, { figures, contextNumbers });
        const length = gradeLength(delivered, turn.maxWords);
        const expectedGrade = gradeExpected(delivered, expected, { figures });
        const refusal = !turn.refusal || /\b(?:don't|doesn't|do not|does not|cannot|can't|not available|not stored|not tracked|no access)\b/i.test(delivered);
        const existingToolsOk = required.checks.filter(r => !missing.includes(r.name)).every(r => r.ok);
        const safe = numeric.ok && length.ok && refusal && gradedAttempts.every(a => a.figures.ok && a.length.ok && !a.error);
        const ok = safe && required.ok && expectedGrade.ok && !response.message?.notice;
        const turnMissing = turn.required.some(r => missing.includes(r.name));
        const gapOnly = turnMissing && safe && existingToolsOk && !response.message?.notice;
        result.turns.push({ question: turn.question, rubric: turn.rubric, delivered, tools: calls, required,
          figures: numeric, expected: expectedGrade, length, refusal, attempts: gradedAttempts,
          grounding: response.message?.provenance?.grounding ?? null, historyMessages: Math.max(0, ...requestLengths), ok });
        if (ledger.state.stopped) { result.status = `${ledger.state.stopped}-stopped`; break; }
        if (!ok && !gapOnly) result.status = 'fail';
        else if (result.status !== 'fail' && gapOnly) result.status = 'xfail';
        else if (result.status !== 'fail' && c.expectedFail && !missing.length && ok) result.status = 'xpass';
      }
      result.costUsd = Number((ledger.costUsd - beforeCost).toFixed(12));
      rows.push(result);
      if (c.storedGoal) db.prepare('DELETE FROM goals WHERE id = ?').run(goalId);
      if (ledger.state.stopped) break;
    }
    const scorecard = { version: 1, live, generatedAt: new Date().toISOString(), maxUsd, costUsd: ledger.costUsd,
      stopped: ledger.state.stopped, selected: cases.length, completed: rows.length, cases: rows };
    if (outDir) await writeScorecard(outDir, scorecard);
    return scorecard;
  } finally { await store.close(); }
}
export async function writeScorecard(dir, scorecard) {
  await mkdir(dir, { recursive: true });
  const lines = ['# Ask evals', '', `Tier: ${scorecard.live ? 'live' : 'scripted'}. Cost: $${scorecard.costUsd.toFixed(6)}. Stop: ${scorecard.stopped ?? 'none'}.`, '',
    '| Case | Result | Tools called / required | Unsourced / self-computed | Words / budget | Cost |',
    '| --- | --- | --- | --- | --- | --- |'];
  for (const c of scorecard.cases) {
    const names = c.turns.flatMap(t => t.tools.map(r => r.name)).join(', ');
    const required = c.turns.flatMap(t => t.required.checks.map(r => `${r.name}:${r.ok ? 'ok' : 'missing'}`)).join(', ');
    const un = c.turns.reduce((s, t) => s + t.figures.unsourced.length + t.attempts.reduce((n, a) => n + a.figures.unsourced.length, 0), 0);
    const arithmetic = c.turns.reduce((s, t) => s + t.figures.selfComputed.length + t.attempts.reduce((n, a) => n + a.figures.selfComputed.length, 0), 0);
    lines.push(`| ${c.id} | ${c.status} | ${names || 'none'} / ${required} | ${un} / ${arithmetic} | ${c.turns.map(t => `${t.length.words}/${t.length.maxWords}`).join(', ')} | $${c.costUsd.toFixed(6)} |`);
  }
  await writeFile(join(dir, 'scorecard.json'), JSON.stringify(scorecard, null, 2) + '\n');
  await writeFile(join(dir, 'summary.md'), lines.join('\n') + '\n');
}
