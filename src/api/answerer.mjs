// The live answerer: every Ask, rec conversation, pack follow-up and What if goes through the
// runtime engine (live or fake), then through grounding and escaping before it is stored.
//
// createLiveAnswerer({ engine, packs }) ->
//   answer({ db, key, questionId?, text?, clock? }) -> { paragraphs, refs, notice?, provenance? } | null
//   whatIf({ db, packId, clock? })                  -> { paragraphs, refs, notice?, provenance? }
// paragraphs are paragraph inner HTML (the handler wraps each in <p>); null means questionId
// names no question in that conversation.
//
// Prompt assembly (buildChatPrompt): the static product rules plus the active packs' context go
// in `system` (before the SDK dynamic boundary, prompt cached, no household data); the household
// summary, the conversation context and today go in `systemDynamic`.
//
// Model output is untrusted. groundAnswer validates every scenario token itself, masks it, and
// checks every remaining number against tool results and context data only (stored figures may
// appear only as tokens). One corrective retry; what is still ungrounded is stored wrapped in
// .fx-unverified. renderAnswer escapes everything except valid tokens and the spans it adds.

import { callTool, tools as REGISTRY } from '../tools/index.mjs';
import { buildScenario } from '../scenario/build.mjs';
import { checkGrounding, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError, RoundLimitError } from '../engine/index.mjs';
import { packContext } from '../packs/index.mjs';
import { packStatus } from '../shared/rules.mjs';
import { escapeUserText, resolveTokens } from '../shared/tokens.mjs';
import { parseJson } from '../store/db.mjs';
import { findQuestion, matchQuestion, recForKey } from './questions.mjs';
import { fakeAnswerScript } from './fake-answers.mjs';

export const PRODUCT_RULES = [
  'You are Fathom, a year-round financial co-pilot for one household of independent professionals.',
  'You are advisory only: you explain and recommend. You never file taxes, never move money or change any account, and never select individual securities.',
  'Never state a number you did not take from a tool result, the household summary, the conversation context or a knowledge pack entry.',
  'Write stored figures as {f:key} tokens using the keys get_figures returns, never as typed amounts.',
  'Cite a knowledge pack entry by its title when you use it.',
  'Answer in plain text paragraphs separated by blank lines, with no markdown and no HTML.',
  'Use set_recommendation_status only when the owner explicitly asks to change a recommendation status, never on your own initiative.',
].join('\n');

export const NOTICES = Object.freeze({
  engineOff: 'Engine is off, so answers are paused. Switch it back on to get an answer.',
  configOff: "The engine is off in this deployment's configuration, so answers are paused.",
  overCap: "This month's engine budget of {f:engine.budget.monthly} is used up, so answers are paused. Raise the cap on the Engine screen or wait for next month.",
  modelError: 'The model could not answer just now, so nothing was made up. Try again in a moment.',
});

const UNVERIFIED_OPEN = '<span class="fx-unverified" title="Not found in your data or tool results">';
const STATUS_INTENT = /\b(accept|start|snooze|dismiss|set aside|mark|done|complete|reopen|wake)\b/i;
const HISTORY_LIMIT = 20;
const MAX_TOKENS = 1024;
// Any brace pair that looks like a scenario token; valid ones also need a safe key.
const TOKEN_LIKE = /\{(fk|f|l|p|n):([^{}]*)\}/g;
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;
const CORRECTIVE = 'Some numbers in that answer are not in the tool results or the household data: {list}. ' +
  'Answer again using only numbers from tool results or the provided data, and write stored figures as {f:key} tokens from get_figures.';

// ---------------------------------------------------------------- prompt assembly

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#123;': '{', '&#125;': '}' };

// Stored message HTML to plain text: paragraphs become blank lines, tags go, entities decode.
function plainText(html) {
  return String(html ?? '')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|#123|#125);/g, m => ENTITIES[m])
    .trim();
}

export function buildChatPrompt({ packContextText = '', summary = {}, context = null, history = [], question, today } = {}) {
  const system = PRODUCT_RULES + '\n\n<knowledge_packs>\n' + packContextText + '\n</knowledge_packs>';
  let systemDynamic = '<household_summary>\n' + JSON.stringify(summary ?? {}) + '\n</household_summary>';
  if (context) systemDynamic += '\n<conversation_context>\n' + JSON.stringify(context) + '\n</conversation_context>';
  if (today) systemDynamic += `\nToday is ${today}.`;
  const turns = (Array.isArray(history) ? history : []).filter(m => m && !m.notice).slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', content: plainText(m.text) }));
  return { system, systemDynamic, messages: [...turns, { role: 'user', content: String(question ?? '') }] };
}

// ---------------------------------------------------------------- grounding

function tokenValid(scenario, kind, key) {
  if (!SAFE_KEY.test(key)) return false;
  const S = scenario || {};
  if (kind === 'f' || kind === 'fk') return !!(S.fig && S.fig[key] && typeof S.fig[key].v === 'number');
  if (kind === 'l') return !!S.law && typeof S.law[key] === 'number';
  if (kind === 'p') return !!S.pct && typeof S.pct[key] === 'number';
  return !!S.names && S.names[key] != null;
}

const KIND_NAMES = { f: 'figure', fk: 'figure', l: 'law', p: 'percent', n: 'name' };

// groundAnswer(text, { scenario, toolResults, data, dataLabels? }) ->
//   { ok, violations: [{text, index, reason}], figureKeys, literals: [{text, index, source}] }
// Every token is validated here and masked with equal-length spaces (invalid ones are recorded
// once as violations), then checkGrounding sees only tool results and context data, never the
// stored figures, so a stored value typed as a literal is a violation. Each grounded literal is
// attributed to the first single source that grounds it: a tool result (by tool name), else a
// context datum (dataLabels[i], default "your data").
export function groundAnswer(text, { scenario, toolResults = [], data = [], dataLabels = [] } = {}) {
  const prose = String(text ?? '');
  const violations = [];
  const figureKeys = new Set();
  const masked = prose.replace(TOKEN_LIKE, (token, kind, key, index) => {
    if (tokenValid(scenario, kind, key)) {
      if (kind === 'f' || kind === 'fk') figureKeys.add(key);
    } else {
      violations.push({ text: token, index, reason: `unknown ${KIND_NAMES[kind]} token` });
    }
    return ' '.repeat(token.length);
  });

  const results = Array.isArray(toolResults) ? toolResults : [];
  const values = Array.isArray(data) ? data : [data];
  const unsupported = checkGrounding(masked, { toolResults: results, data: values }).violations;
  if (unsupported.length) {
    const figureValues = Object.values((scenario && scenario.fig) || {}).map(f => f && f.v).filter(Number.isFinite);
    const notFigures = new Set(checkGrounding(masked, { data: [figureValues] }).violations.map(v => v.index));
    for (const v of unsupported) {
      violations.push(notFigures.has(v.index) ? v : { ...v, reason: 'stored figure written as a literal' });
    }
  }

  const literals = [];
  const unsupportedAt = new Set(unsupported.map(v => v.index));
  const spans = checkGrounding(masked, {}).violations.filter(v => !unsupportedAt.has(v.index));
  if (spans.length) {
    const sources = [
      ...results.map(r => ({ label: String((r && r.name) || 'a tool'), check: () => checkGrounding(masked, { toolResults: [r] }) })),
      ...values.map((d, i) => ({ label: String(dataLabels[i] || 'your data'), check: () => checkGrounding(masked, { data: [d] }) })),
    ];
    const misses = sources.map(() => null);
    for (const span of spans) {
      for (let i = 0; i < sources.length; i++) {
        misses[i] ??= new Set(sources[i].check().violations.map(v => v.index));
        if (!misses[i].has(span.index)) { literals.push({ text: span.text, index: span.index, source: sources[i].label }); break; }
      }
    }
  }

  const seen = new Set();
  const unique = violations.sort((a, b) => a.index - b.index).filter(v => (seen.has(v.index) ? false : seen.add(v.index)));
  return { ok: unique.length === 0, violations: unique, figureKeys: [...figureKeys], literals };
}

// ---------------------------------------------------------------- rendering

// Escape untrusted text, keeping only well-formed tokens with safe keys raw for the UI to resolve.
function escapeKeepingTokens(segment) {
  let out = '';
  let last = 0;
  for (const m of segment.matchAll(TOKEN_LIKE)) {
    if (!SAFE_KEY.test(m[2])) continue;
    out += escapeUserText(segment.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeUserText(segment.slice(last));
}

// renderAnswer(text, violations, literals = []) -> [paragraph inner HTML]
// Violations are wrapped in .fx-unverified (an invalid token is escaped inside it, so it never
// resolves); bound literals in .fx-src with data-src the literal's index and a "From" title.
export function renderAnswer(text, violations = [], literals = []) {
  const prose = String(text ?? '');
  const marks = [
    ...violations.map(v => ({ start: v.index, end: v.index + v.text.length, kind: 'unverified' })),
    ...literals.map((l, n) => ({ start: l.index, end: l.index + l.text.length, kind: 'src', n, source: l.source })),
  ].filter(m => Number.isInteger(m.start) && m.start >= 0 && m.end <= prose.length && m.end > m.start)
    .sort((a, b) => a.start - b.start || (a.kind === 'unverified' ? -1 : 1));
  let html = '';
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    html += escapeKeepingTokens(prose.slice(at, m.start));
    const inner = escapeUserText(prose.slice(m.start, m.end));
    html += m.kind === 'unverified'
      ? `${UNVERIFIED_OPEN}${inner}</span>`
      : `<span class="fx-src" data-src="${m.n}" title="From ${escapeUserText(m.source)}">${inner}</span>`;
    at = m.end;
  }
  html += escapeKeepingTokens(prose.slice(at));
  return html.split(/\n[ \t]*\n\s*/).map(p => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- the live answerer

const unique = list => [...new Set(list.filter(Boolean))];
const plain = (scenario, s) => resolveTokens(scenario, s, false);

function noticeReply(text) {
  return { paragraphs: [text], refs: [], notice: true };
}

function noticeFor(error, engine) {
  if (error instanceof EngineOffError) return noticeReply(engine.mode === 'off' ? NOTICES.configOff : NOTICES.engineOff);
  if (error instanceof BudgetExceededError) return noticeReply(NOTICES.overCap);
  if (!(error instanceof ModelCallError || error instanceof ModelAccountingError || error instanceof RoundLimitError)) {
    console.error(`fathom: answer failed (${error && error.name ? error.name : 'error'})`);
  }
  return noticeReply(NOTICES.modelError);
}

// The manifest packs effectively active now (base status plus overrides), with their rows.
function activeManifestPacks(db, packs) {
  const loaded = packs ? packs.loaded() : [];
  const out = [];
  for (const row of db.prepare('SELECT id, def, active, exploring FROM packs_state ORDER BY sort, id').all()) {
    const def = parseJson(row.def, null);
    if (!def || typeof def.manifest !== 'string') continue;
    const status = packStatus(def.status, { active: row.active == null ? null : !!row.active, exploring: !!row.exploring });
    const pack = loaded.find(p => p.id === def.manifest);
    if (status === 'active' && pack && !out.some(x => x.pack.id === pack.id)) out.push({ rowId: row.id, pack });
  }
  return out;
}

function packConversationContext(db, packs, rowId) {
  const row = db.prepare('SELECT def FROM packs_state WHERE id = ?').get(rowId);
  const def = row ? parseJson(row.def, {}) : {};
  const pack = def.manifest && packs ? packs.loaded().find(p => p.id === def.manifest) : null;
  const context = { pack: {
    id: rowId, name: def.name, status: def.status, why: def.why, covers: def.covers,
    curator: def.curator, version: def.version, taxYear: def.taxYear, reviewed: def.reviewed,
  } };
  if (pack) context.entries = pack.entries.map(e => ({ title: e.title, body: e.body }));
  return { def, context };
}

export function createLiveAnswerer({ engine, packs } = {}) {
  if (!engine || typeof engine.call !== 'function') throw new TypeError('createLiveAnswerer needs an engine');

  // One grounded model answer: call, ground, retry once with a corrective turn, render.
  async function run({ db, scenario, key, question, context, history, baseRefs, fakeArgs }) {
    if (!engine.isOn()) return noticeReply(engine.mode === 'off' ? NOTICES.configOff : NOTICES.engineOff);
    if (packs) packs.refreshIfFactsChanged();
    const summary = await callTool('household_summary', {}, { db, now: engine.now() });
    const active = activeManifestPacks(db, packs);
    const packIds = active.map(a => a.pack.id).sort();
    const packContextText = packContext(active.map(({ pack }) => ({ pack, status: 'active' })));
    const prompt = buildChatPrompt({ packContextText, summary, context, history, question, today: scenario.meta && scenario.meta.clock });
    const statusIntent = STATUS_INTENT.test(question) && !question.trim().endsWith('?');
    const offered = REGISTRY.filter(t => t.scope === 'read' || (statusIntent && t.name === 'set_recommendation_status'));
    const fake = engine.mode === 'fake' ? fakeAnswerScript({ scenario, summary, ...fakeArgs }) : undefined;
    const request = { purpose: 'chat', system: prompt.system, systemDynamic: prompt.systemDynamic, messages: prompt.messages,
      tools: offered, maxTokens: MAX_TOKENS, ...(fake ? { fake } : {}) };

    const entryBodies = active.flatMap(({ pack }) => pack.entries.map(e => e.body));
    const data = [summary, context, entryBodies];
    const dataLabels = ['household summary', 'conversation context', 'knowledge pack entries'];
    const resultsOf = res => (res && Array.isArray(res.toolResults) ? res.toolResults : []);
    const ground = (res, toolResults) => groundAnswer(res.text, { scenario, toolResults, data, dataLabels });

    let first;
    try { first = await engine.call(request); } catch (e) { return noticeFor(e, engine); }
    let chosen = first;
    let toolResults = resultsOf(first);
    let grounding = ground(first, toolResults);
    let retried = false;
    let costUsd = first.costUsd || 0;
    if (!grounding.ok) {
      retried = true;
      const list = grounding.violations.map(v => v.text).join(', ');
      const earlier = resultsOf(first).map(r => ({ name: r.name, args: r.args ?? {}, result: r.result ?? null,
        ...(r.isError ? { isError: true } : {}) }));
      const evidence = earlier.length ? `\n\nTool results from your first attempt (still available as evidence):\n${JSON.stringify(earlier)}` : '';
      const retry = { ...request, messages: [...request.messages, { role: 'assistant', content: first.text },
        { role: 'user', content: CORRECTIVE.replace('{list}', () => list) + evidence }] };
      try {
        const second = await engine.call(retry);
        costUsd += second.costUsd || 0;
        chosen = second;
        toolResults = [...resultsOf(first), ...resultsOf(second)];
        grounding = ground(second, toolResults);
      } catch {
        // Keep the first answer, marked; the failed retry stored nothing.
      }
    }

    const recReads = toolResults.filter(r => !r.isError && ['get_recommendation', 'set_recommendation_status'].includes(r.name))
      .map(r => r.args && r.args.id);
    const paragraphs = renderAnswer(chosen.text, grounding.violations, grounding.literals);
    if (!paragraphs.length) return noticeReply(NOTICES.modelError);
    const lower = chosen.text.toLowerCase();
    return {
      paragraphs,
      refs: unique([...baseRefs, ...recReads]),
      provenance: {
        engine: engine.mode,
        model: chosen.model,
        tools: toolResults.map(r => ({ name: r.name, args: r.args ?? {} })),
        figures: grounding.figureKeys,
        packIds,
        packEntries: unique(active.flatMap(({ pack }) => pack.entries.map(e => e.title))
          .filter(title => lower.includes(title.toLowerCase()))),
        literals: grounding.literals.map(l => ({ text: l.text, source: l.source })),
        grounding: { ok: grounding.ok, retried, unverified: grounding.violations.map(v => v.text) },
        costUsd: Number(costUsd.toFixed(6)),
      },
    };
  }

  return {
    async answer({ db, key = 'ask', questionId, text, clock } = {}) {
      const scenario = buildScenario(db, { clock });
      const hasQ = questionId !== undefined && questionId !== null;
      let question;
      let baseRefs = [];
      if (hasQ) {
        const q = findQuestion(scenario, key, questionId);
        if (!q) return null;
        question = plain(scenario, q.q);
        baseRefs = q.refs || [];
      } else {
        question = String(text ?? '').trim();
        const hit = matchQuestion(scenario, key, question);
        if (hit) baseRefs = hit.refs || [];
      }
      const rec = recForKey(scenario, key);
      let context = null;
      if (rec) {
        context = { recommendation: await callTool('get_recommendation', { id: rec.id }, { db, now: engine.now() }) };
        baseRefs = [...baseRefs, rec.id];
      } else if (key.startsWith('pack:')) {
        context = packConversationContext(db, packs, key.slice(5)).context;
      }
      return run({ db, scenario, key, question, context, history: scenario.live.conversations[key] || [], baseRefs,
        fakeArgs: { key, questionId: hasQ ? questionId : undefined, text: hasQ ? undefined : question } });
    },

    async whatIf({ db, packId, clock } = {}) {
      const scenario = buildScenario(db, { clock });
      const { def, context } = packConversationContext(db, packs, packId);
      const prompt = def.whatIf && def.whatIf.prompt ? def.whatIf.prompt : '';
      const key = 'pack:' + packId;
      // The prompt opens the conversation; drop an earlier copy of it (a prior notice round).
      const history = (scenario.live.conversations[key] || []).filter(m => !(m.role === 'me' && m.text === prompt));
      const baseRefs = (def.whatIf && Array.isArray(def.whatIf.unlocks) ? def.whatIf.unlocks : []).map(u => u && u.recId);
      return run({ db, scenario, key, question: plain(scenario, prompt), context, history, baseRefs,
        fakeArgs: { key, whatIfPack: def } });
    },
  };
}
