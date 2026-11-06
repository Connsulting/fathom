// The live answerer: every Ask, rec conversation, pack follow-up and What if goes through the
// runtime engine (live or fake), then through grounding and escaping before it is stored.
//
// createLiveAnswerer({ engine, packs }) (packs: the live pack view, src/packs/live.mjs) ->
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
// Every grounding source (the household summary, the conversation context, pack entry bodies and
// each tool result) goes through one evidence sanitizer: identifier, label and citation keys are
// dropped (ids, keys, names, titles, versions, curators, account masks and numbers, figure
// references, urls, sources, pages), so is every single-token string leaf that is not one whole
// numeric expression (plan529, 2026-11, a URL) under any key, and entry bodies lose their citation
// and metadata lines, so none of them grounds a number. In prose (any string with whitespace) URLs
// and link destinations are removed, and only whole-word, quantity-marked numeric expressions
// ground: a currency sign, a percent sign or the word percent, or a magnitude (k, thousand,
// million, billion); bare numbers (Publication 560, age 50) never do. JSON number fields stay evidence. Tool results also drop
// argument echoes: a leaf under an argument's key with an equal value, or a string containing an
// argument string of 3 or more characters with a digit. Other values that merely equal an argument
// (a computed total) stay. The model still sees everything.
// Stored figures should appear only as tokens, but a stored figure that a tool returns as plain
// text grounds when the model read it through that tool: the tool result is the evidence.
//
// Streaming: answer({ ..., onEvent }) and whatIf({ ..., onEvent }) report progress while the model
// runs: { type: 'progress', label } (a fixed plain label per tool, never arguments or values),
// { type: 'text', text } (raw model text deltas, untrusted: the client escapes them and shows every
// number as still being checked) and { type: 'reset' } (drop the streamed text: it was a tool round
// preamble or the answer is being redone after a failed grounding check). The returned reply is the
// only grounded result; nothing streamed is stored. A throwing onEvent never fails the answer.
//
// The model's text loses a trailing Sources paragraph or sentence (stripSources) before grounding,
// and the rendered blocks keep a minimal markdown subset (src/shared/answer-text.mjs): paragraphs,
// bullet and numbered lists and bold, over the escaped text. List blocks come back complete
// (<ul>/<ol>); every other block is paragraph inner HTML.
//
// Chat never writes. In Ask threads ('ask:<id>') and rec conversations the model is offered one local, non-writing
// tool, propose_recommendation_action; the last successful call becomes provenance.proposal
// ({recId, action, wake?}) and the owner confirms it through the ordinary rec action endpoint.
// Ask threads also get propose_goal: the last successful call becomes provenance.goalProposal
// ({title, note, horizon, target, targetDate}) and the owner saves it through POST /api/goals. A
// proposed target survives only when the owner's own message states that amount.

import { callTool, tools as REGISTRY } from '../tools/index.mjs';
import { buildScenario, clockNow } from '../scenario/build.mjs';
import { checkGrounding, numberPattern, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError, RoundLimitError } from '../engine/index.mjs';
import { packContext } from '../packs/index.mjs';
import { packStatus, ACTION_STATUS } from '../shared/rules.mjs';
import { escapeUserText, resolveTokens } from '../shared/tokens.mjs';
import { parseJson } from '../store/db.mjs';
import { findQuestion, matchQuestion, recForKey, isThreadKey } from './questions.mjs';
import { fakeAnswerScript } from './fake-answers.mjs';
import { HORIZON_IDS, LIMITS, validateGoal } from '../shared/goals.mjs';
import { stripSources, listMarkerSpans, markdownBlocks } from '../shared/answer-text.mjs';

export const PRODUCT_RULES = [
  'You are Fathom, a year-round financial co-pilot for one household of independent professionals.',
  'You are advisory only: you explain and recommend. You never file taxes, never move money or change any account, and never select individual securities.',
  'Never state a number you did not take from a tool result, the household summary, the conversation context or a knowledge pack entry.',
  'Write stored figures as {f:key} tokens using the keys get_figures returns, never as typed amounts.',
  'Never write a Sources, References or Citations line and never cite sources in your prose: the app shows the sources it used under every answer.',
  'Answer in short paragraphs separated by blank lines. You may use bullet lists (lines starting with "- "), numbered lists (lines starting with "1. ") and **bold**; use no other markdown (no headings, links or tables) and no HTML.',
  'You never change a recommendation yourself. When the owner explicitly asks to change one, call propose_recommendation_action so the owner can confirm it; never propose on your own initiative.',
  'You never add a goal yourself. When the owner explicitly asks to add one, call propose_goal with the goal in their own words so the owner can save it; include a target amount only when the owner stated it.',
].join('\n');

export const NOTICES = Object.freeze({
  engineOff: 'Engine is off, so answers are paused. Switch it back on to get an answer.',
  configOff: "The engine is off in this deployment's configuration, so answers are paused.",
  overCap: "This month's engine budget of {f:engine.budget.monthly} is used up, so answers are paused. Raise the cap on the Engine screen or wait for next month.",
  modelError: 'The model could not answer just now, so nothing was made up. Try again in a moment.',
});

const UNVERIFIED_OPEN = '<span class="fx-unverified" title="Not found in your data or tool results">';
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
    .replace(/<\/li>\s*<li>/g, '\n- ')
    .replace(/<\/(?:p|ul|ol)>\s*<(?:p|ul|ol)(?:\s[^>]*)?>/g, '\n\n')
    .replace(/<li>/g, '- ')
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

// ---------------------------------------------------------------- the proposal tool

export const PROPOSE_TOOL = Object.freeze({
  name: 'propose_recommendation_action',
  description: 'Propose a change to one recommendation (start = the owner is doing it, complete, dismiss = not for us, snooze = later, with an optional wake label, reopen) ' +
    'for the owner to confirm. Nothing changes until the owner confirms. Use it only when the owner explicitly asks for that change.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      action: { type: 'string', enum: Object.keys(ACTION_STATUS) },
      wake: { type: 'string', maxLength: 200 },
    },
    required: ['id', 'action'],
    additionalProperties: false,
  },
  scope: 'read',
  handler(args, ctx) {
    const row = ctx.db.prepare('SELECT status FROM recs WHERE id = ?').get(args.id);
    if (!row || row.status === 'hidden') throw new Error('no such recommendation');
    if (!Object.hasOwn(ACTION_STATUS, args.action)) throw new Error('unknown action');
    return { proposed: true };
  },
});

export const PROPOSE_GOAL_TOOL = Object.freeze({
  name: 'propose_goal',
  description: 'Propose a new household goal for the owner to save: the goal in the owner\'s own words, a horizon ' +
    '(now = this year, 1-3y = next few years, 3-10y = long range), and a target amount or date only when the owner stated one. ' +
    'Nothing is saved until the owner taps Save. Use it only when the owner explicitly asks to add a goal.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: LIMITS.title },
      note: { type: 'string', maxLength: LIMITS.note },
      horizon: { type: 'string', enum: HORIZON_IDS },
      target: { type: 'number' },
      targetDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  scope: 'read',
  handler(args) {
    const res = validateGoal({ title: args.title, note: args.note, horizon: args.horizon, target: args.target, targetDate: args.targetDate });
    if (!res.ok) throw new Error(res.error);
    return { proposed: true };
  },
});

// Amounts the owner's text states: 50000, $50,000, 50k, 1.5 million.
const OWNER_AMOUNT = /\$?(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/gi;
export function ownerAmounts(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(OWNER_AMOUNT)) {
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[(m[2] || '').toLowerCase()] || 1;
    out.add(Math.round(base * mult * 100) / 100);
  }
  return out;
}

// The goal proposal from the last successful propose_goal call, validated, with a target the
// owner did not state dropped.
function goalProposalOf(toolResults, question) {
  const hit = toolResults.filter(r => !r.isError && r.name === PROPOSE_GOAL_TOOL.name && r.args).at(-1);
  if (!hit) return null;
  const a = hit.args;
  const res = validateGoal({ title: a.title, note: a.note, horizon: a.horizon, target: a.target, targetDate: a.targetDate });
  if (!res.ok) return null;
  const g = res.value;
  if (g.target != null && !ownerAmounts(question).has(g.target)) g.target = null;
  return { title: g.title, note: g.note || '', horizon: g.horizon, target: g.target, targetDate: g.targetDate };
}

// ---------------------------------------------------------------- grounding

// Evidence keys that identify, label or cite rather than state a value: ids and keys, names,
// titles, labels, versions, curators, account masks, institutions and owners, ticker symbols,
// figure references, citations, urls, files and pages. Any key ending in Id, Ids, _id, Mask or
// Number (accountId, recId, accountMask, accountNumber) names an identifier too. A plain `number`
// stays a value.
const META_KEYS = new Set(['id', 'ids', 'key', 'keys', 'ref', 'refs', 'manifest', 'slug', 'fig',
  'name', 'names', 'title', 'titles', 'label', 'labels', 'covers', 'version', 'versions', 'curator', 'curators',
  'mask', 'masks', 'inst', 'institution', 'owner', 'owners', 'symbol', 'symbols',
  'url', 'urls', 'href', 'cite', 'cites', 'citation', 'citations', 'src', 'source', 'sources',
  'file', 'files', 'fileName', 'path', 'page', 'pages']);
const isMetaKey = k => META_KEYS.has(k) || /(?:Id|Ids|_id|_ids|Mask|Masks|_mask|Number|Numbers|_number)$/.test(k);

// Single-token evidence is an allowlist too. A string leaf with no whitespace grounds only when the
// whole token is one numeric expression ($4,821, 12%, 1500, 20k); every other token (plan529,
// acct-4821k, a month period 2026-11, a date or timestamp, a URL) is dropped whole.
const NUMERIC_TOKEN = new RegExp(`^(?:${numberPattern.source})$`, 'u');

// Prose evidence is an allowlist. Markdown link destinations, autolinks and bare URLs are removed
// first (link text stays). A destination runs to its matching closing parenthesis, so nested and
// repeated parenthesized segments (a(b(c))/d(e)) are removed whole; an unclosed one runs to the
// next whitespace. A bare URL runs to the next whitespace, parentheses included. Then each whole
// numeric expression (the engine's numberPattern, so 1e3, 4.50, 12.5% and 8.7 million are judged
// as one unit, never as a bare coefficient) is kept only when it stands as its own word, with no
// letter, digit, underscore or period glued in front, no letter- or underscore-hyphen prefix
// (acct-4821k) and no letter, digit or underscore glued after, and when it is marked as a quantity:
// a currency sign before it, or a percent sign, the word percent or a magnitude (k, thousand,
// million, billion) ending it. Every other numeric expression (Section 125, age 50, a year, a date
// part) is blanked to spaces as a unit.
const LINK_OPEN = /\[([^\]]*)\]\(/g;
const AUTOLINK = /<[a-z][a-z\d+.-]*:[^\s<>]*>/gi;
const BARE_URL = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)\S*/gi;
const GLUED_BEFORE = /(?:[\p{L}\p{N}_.]|[\p{L}_]-)$/u;
const GLUED_AFTER = /^(?:[\p{L}\p{N}_]|[.,]\p{N})/u;
const CURRENCY_BEFORE = /\p{Sc}\s*$/u;
const MARKED = /(?:^[-+]?\s*\$|(?:%|percent|k|thousand|million|billion)$)/i;

// [text](destination) -> " text ", the destination ending at its balanced closing parenthesis.
function withoutMarkdownLinks(s) {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(LINK_OPEN)) {
    if (m.index < at) continue;
    let end = m.index + m[0].length;
    let depth = 1;
    while (end < s.length && depth > 0) {
      if (s[end] === '(') depth++;
      else if (s[end] === ')') depth--;
      end++;
    }
    if (depth > 0) end = m.index + m[0].length + (/^\S*/.exec(s.slice(m.index + m[0].length))[0].length);
    out += `${s.slice(at, m.index)} ${m[1]} `;
    at = end;
  }
  return out + s.slice(at);
}

const withoutLinks = s => withoutMarkdownLinks(s).replace(AUTOLINK, ' ').replace(BARE_URL, ' ');
function proseEvidence(text) {
  const s = withoutLinks(text);
  return s.replace(new RegExp(numberPattern.source, numberPattern.flags), (match, index) => {
    const n = match.trimEnd();
    const before = s.slice(0, index);
    const after = s.slice(index + n.length);
    const marked = !GLUED_BEFORE.test(before) && !GLUED_AFTER.test(after)
      && (MARKED.test(n) || CURRENCY_BEFORE.test(before));
    return marked ? match : ' '.repeat(match.length);
  });
}

// Pack entry text as grounding data: citation and metadata lines never ground a number.
const META_LINE = /^\s*(?:sources?|tax year|reviewed)\s*:/i;
const groundingBody = body => String(body ?? '').split(/\r?\n/).filter(line => !META_LINE.test(line)).join('\n');

const norm = v => String(v).trim().toLowerCase();

// The argument leaves of one tool call: each leaf by the key it sits under (array elements take
// their parent key), and the argument strings of 3 or more characters with a digit that no result
// string may contain.
function argEchoes(args) {
  const byKey = new Map();
  const strings = [];
  const walk = (v, key) => {
    if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'string') strings.push(norm(v));
      if (key === undefined) return;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(norm(v));
    }
  };
  walk(args, undefined);
  return { byKey, contained: strings.filter(a => a.length >= 3 && /\d/.test(a)) };
}

const NO_ECHOES = Object.freeze({ byKey: new Map(), contained: [] });

// An argument echo in a tool result: a leaf under the same key as an argument with an equal value,
// or a string containing an argument string. A value under any other key (a computed total, a
// matching row's amount) is evidence even when it equals an argument.
function isEcho(v, key, echoes) {
  if (key !== undefined && echoes.byKey.get(key)?.has(norm(v))) return true;
  return typeof v === 'string' && echoes.contained.some(a => norm(v).includes(a));
}

// Drop identifier, label and citation keys at any depth, single-token string leaves that are not
// one numeric expression, metadata lines from `body` strings, and (for a tool result) argument
// echoes; prose keeps only whole-word, quantity-marked numbers outside URLs.
function scrub(v, echoes = NO_ECHOES, key = undefined) {
  if (typeof v === 'number') return isEcho(v, key, echoes) ? undefined : v;
  if (typeof v === 'string') {
    if (isEcho(v, key, echoes)) return undefined;
    const token = v.trim();
    if (!/\s/.test(token)) return NUMERIC_TOKEN.test(token) ? v : undefined;
    return proseEvidence(v);
  }
  if (Array.isArray(v)) return v.map(x => scrub(x, echoes, key)).filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (isMetaKey(k)) continue;
      const y = scrub(k === 'body' && typeof x === 'string' ? groundingBody(x) : x, echoes, k);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}

// Any grounding datum (household summary, conversation context, pack entry bodies) as evidence.
const evidence = v => scrub(v);

// A tool result as grounding evidence: the evidence sanitizer plus argument echoes (see isEcho).
// Error results pass through (checkGrounding ignores them).
function groundingResult(r) {
  if (!r || typeof r !== 'object' || r.isError) return r;
  return { name: r.name, result: scrub(r.result ?? null, argEchoes(r.args)) };
}

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
// stored figures, so a stored value typed as a literal is a violation. Tool results and every
// datum go through the evidence sanitizer first, so identifiers and labels never ground. Each grounded literal is
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
  // Ordered-list markers ("1. ") are list numbering, not figures.
  let unlisted = masked;
  for (const m of listMarkerSpans(masked)) {
    unlisted = unlisted.slice(0, m.index) + ' '.repeat(m.length) + unlisted.slice(m.index + m.length);
  }
  return groundMasked(unlisted, { scenario, toolResults, data, dataLabels, violations, figureKeys });
}

function groundMasked(masked, { scenario, toolResults, data, dataLabels, violations, figureKeys }) {
  const results = (Array.isArray(toolResults) ? toolResults : []).map(groundingResult);
  const values = (Array.isArray(data) ? data : [data]).map(evidence);
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

// renderAnswer(text, violations, literals = []) -> [block]: paragraph inner HTML, or a complete
// <ul>/<ol> list block (markdownBlocks).
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
  return markdownBlocks(html);
}

// ---------------------------------------------------------------- progress labels

// Plain progress labels by tool name. Labels never carry arguments, values or model text.
export const PROGRESS_LABELS = Object.freeze({
  household_summary: 'Reading your household summary',
  get_facts: 'Looking at your stored facts',
  list_accounts: 'Looking at your accounts',
  query_transactions: 'Looking through your transactions',
  list_positions: 'Looking at your holdings',
  pnl_by_month: 'Looking at your monthly income and spending',
  list_recommendations: 'Looking at your plan',
  get_recommendation: 'Reading the recommendation',
  list_deadlines: 'Checking your deadlines',
  list_goals: 'Looking at your goals',
  get_figures: 'Pulling the figures',
  packs_status: 'Checking your knowledge packs',
  list_packs: 'Checking your knowledge packs',
  get_pack_entry: 'Reading a knowledge pack entry',
  search_pack_entries: 'Searching your knowledge packs',
  propose_recommendation_action: 'Preparing a change for you to confirm',
});
export const PROGRESS_START = 'Reading your household summary';
export const PROGRESS_GROUNDING = 'Checking every number against your data';
export const PROGRESS_RETRY = 'Rechecking the numbers';
const PROGRESS_OTHER = 'Looking at your data';

export const progressLabel = name => (Object.hasOwn(PROGRESS_LABELS, name) ? PROGRESS_LABELS[name] : PROGRESS_OTHER);

// A safe emitter: progress labels deduplicated in a row, a reset only after text, a throwing
// listener ignored. Engine events ({ type: 'tool', name } / { type: 'text', text }) go through
// engineEvent, which resets streamed text when a tool round follows it.
function streamer(onEvent) {
  if (typeof onEvent !== 'function') return { progress() {}, reset() {}, engineEvent: undefined };
  let lastLabel = null;
  let texted = false;
  const send = e => { try { onEvent(e); } catch { /* the stream never fails an answer */ } };
  const out = {
    progress(label) { if (label !== lastLabel) { lastLabel = label; send({ type: 'progress', label }); } },
    reset() { if (texted) { texted = false; send({ type: 'reset' }); } },
    engineEvent(e) {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'tool') { out.reset(); out.progress(progressLabel(String(e.name || ''))); }
      else if (e.type === 'text' && typeof e.text === 'string' && e.text) { texted = true; send({ type: 'text', text: e.text }); }
    },
  };
  return out;
}

// ---------------------------------------------------------------- the live answerer

const unique = list => [...new Set(list.filter(Boolean))];
const plain = (scenario, s) => resolveTokens(scenario, s, false);

function noticeReply(text) {
  return { paragraphs: [text], refs: [], notice: true };
}

const offNotice = engine => noticeReply(engine.mode === 'off' ? NOTICES.configOff : NOTICES.engineOff);

function noticeFor(error, engine) {
  if (error instanceof EngineOffError) return offNotice(engine);
  if (error instanceof BudgetExceededError) return noticeReply(NOTICES.overCap);
  if (!(error instanceof ModelCallError || error instanceof ModelAccountingError || error instanceof RoundLimitError)) {
    console.error(`fathom: answer failed (${error && error.name ? error.name : 'error'})`);
  }
  return noticeReply(NOTICES.modelError);
}

// The manifest packs effectively active now (base status plus overrides), with their rows.
function activeManifestPacks(db, packs) {
  const out = [];
  if (!packs) return out;
  for (const row of db.prepare('SELECT id, def, active, exploring FROM packs_state ORDER BY sort, id').all()) {
    const def = parseJson(row.def, null);
    if (!def) continue;
    const pack = packs.backing(row.id, def);
    const status = packStatus(def.status, { active: row.active == null ? null : !!row.active, exploring: !!row.exploring });
    if (status === 'active' && pack && !out.some(x => x.pack.id === pack.id)) out.push({ rowId: row.id, pack });
  }
  return out;
}

function packConversationContext(db, packs, rowId) {
  const row = db.prepare('SELECT def FROM packs_state WHERE id = ?').get(rowId);
  const raw = row ? parseJson(row.def, {}) : {};
  const def = packs ? packs.view(rowId, raw) : raw;
  const pack = packs ? packs.backing(rowId, raw) : null;
  const context = { pack: {
    id: rowId, name: def.name, status: def.status, why: def.why, covers: def.covers,
    curator: def.curator, version: def.version, taxYear: def.taxYear, reviewed: def.reviewed,
  } };
  if (pack) context.entries = pack.entries.map(e => ({ title: e.title, body: e.body }));
  return { def, context };
}

// The stored owner message that opens a What if: a manifest-backed prompt is literal text, stored
// escaped like free text; an illustrative demo prompt keeps its token form.
export function whatIfOwnerText(def) {
  const prompt = def && def.whatIf && def.whatIf.prompt ? def.whatIf.prompt : '';
  return typeof def.manifest === 'string' ? escapeUserText(prompt) : prompt;
}

export function createLiveAnswerer({ engine, packs } = {}) {
  if (!engine || typeof engine.call !== 'function') throw new TypeError('createLiveAnswerer needs an engine');

  // One grounded model answer: call, ground, retry once with a corrective turn, render.
  // proposeFor: null (no proposal tool), '*' (any visible rec, an Ask thread) or the rec id
  // of a rec conversation (proposals for any other rec are ignored).
  async function run({ db, scenario, now, question, context, history, baseRefs, fakeArgs, proposeFor = null, onEvent }) {
    if (!engine.isOn()) return offNotice(engine);
    const stream = streamer(onEvent);
    stream.progress(PROGRESS_START);
    const summary = await callTool('household_summary', {}, { db, now });
    const active = activeManifestPacks(db, packs);
    const packIds = active.map(a => a.pack.id).sort();
    const packContextText = packContext(active.map(({ pack }) => ({ pack, status: 'active' })));
    const prompt = buildChatPrompt({ packContextText, summary, context, history, question, today: scenario.meta && scenario.meta.clock });
    const offered = [...REGISTRY.filter(t => t.scope === 'read'), ...(proposeFor ? [PROPOSE_TOOL] : []), ...(proposeFor === '*' ? [PROPOSE_GOAL_TOOL] : [])];
    const fake = engine.mode === 'fake' ? fakeAnswerScript({ scenario, summary, propose: !!proposeFor, ...fakeArgs }) : undefined;
    const request = { purpose: 'chat', system: prompt.system, systemDynamic: prompt.systemDynamic, messages: prompt.messages,
      tools: offered, toolContext: { db, now }, maxTokens: MAX_TOKENS, ...(fake ? { fake } : {}),
      ...(stream.engineEvent ? { onEvent: stream.engineEvent } : {}) };

    // groundAnswer sanitizes each datum (and context.entries bodies lose their metadata lines there).
    const entryBodies = active.flatMap(({ pack }) => pack.entries.map(e => groundingBody(e.body)));
    const data = [summary, context, entryBodies];
    const dataLabels = ['household summary', 'conversation context', 'knowledge pack entries'];
    const resultsOf = res => (res && Array.isArray(res.toolResults) ? res.toolResults : []);
    const textOf = res => stripSources(res.text);
    const ground = (res, toolResults) => groundAnswer(textOf(res), { scenario, toolResults, data, dataLabels });

    let first;
    try { first = await engine.call(request); } catch (e) { return noticeFor(e, engine); }
    stream.progress(PROGRESS_GROUNDING);
    let chosen = first;
    let toolResults = resultsOf(first);
    let grounding = ground(first, toolResults);
    let retried = false;
    let costUsd = first.costUsd || 0;
    if (!grounding.ok) {
      retried = true;
      stream.reset();
      stream.progress(PROGRESS_RETRY);
      const list = grounding.violations.map(v => v.text).join(', ');
      const earlier = resultsOf(first).map(r => ({ name: r.name, args: r.args ?? {}, result: r.result ?? null,
        ...(r.isError ? { isError: true } : {}) }));
      const evidence = earlier.length ? `\n\nTool results from your first attempt (still available as evidence):\n${JSON.stringify(earlier)}` : '';
      const retry = { ...request, messages: [...request.messages, { role: 'assistant', content: first.text },
        { role: 'user', content: CORRECTIVE.replace('{list}', () => list) + evidence }] };
      try {
        const second = await engine.call(retry);
        stream.progress(PROGRESS_GROUNDING);
        costUsd += second.costUsd || 0;
        chosen = second;
        toolResults = [...resultsOf(first), ...resultsOf(second)];
        grounding = ground(second, toolResults);
      } catch (e) {
        // Never the first, ungrounded answer: the engine recorded each completed round's spend.
        return noticeFor(e, engine);
      }
    }

    const proposed = toolResults.filter(r => !r.isError && r.name === PROPOSE_TOOL.name && r.args
      && (proposeFor === '*' || r.args.id === proposeFor)).at(-1);
    const proposal = proposed
      ? { recId: proposed.args.id, action: proposed.args.action, ...(proposed.args.wake ? { wake: proposed.args.wake } : {}) }
      : null;
    const goalProposal = proposeFor === '*' ? goalProposalOf(toolResults, question) : null;
    const recReads = toolResults.filter(r => !r.isError && r.name === 'get_recommendation').map(r => r.args && r.args.id);
    const text = textOf(chosen);
    const paragraphs = renderAnswer(text, grounding.violations, grounding.literals);
    if (!paragraphs.length) return noticeReply(NOTICES.modelError);
    const lower = text.toLowerCase();
    return {
      paragraphs,
      refs: unique([...baseRefs, ...recReads, proposal && proposal.recId]),
      provenance: {
        engine: engine.mode,
        model: chosen.model,
        tools: toolResults.map(r => ({ name: r.name, args: r.args ?? {} })),
        figures: grounding.figureKeys,
        packIds,
        packEntries: unique([...active.flatMap(({ pack }) => pack.entries.map(e => e.title)),
          ...(context && Array.isArray(context.entries) ? context.entries.map(e => e.title) : [])]
          .filter(title => lower.includes(title.toLowerCase()))),
        literals: grounding.literals.map(l => ({ text: l.text, source: l.source })),
        grounding: { ok: grounding.ok, retried, unverified: grounding.violations.map(v => v.text) },
        costUsd: Number(costUsd.toFixed(6)),
        ...(proposal ? { proposal } : {}),
        ...(goalProposal ? { goalProposal } : {}),
      },
    };
  }

  return {
    async answer({ db, key, questionId, text, clock, onEvent } = {}) {
      if (typeof key !== 'string' || !key) throw new TypeError('answer needs a conversation key');
      const scenario = buildScenario(db, { clock, packs });
      const now = clockNow(db, clock);
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
        context = { recommendation: await callTool('get_recommendation', { id: rec.id }, { db, now }) };
        baseRefs = [...baseRefs, rec.id];
      } else if (key.startsWith('pack:')) {
        context = packConversationContext(db, packs, key.slice(5)).context;
      }
      return run({ db, scenario, now, question, context, history: scenario.live.conversations[key] || [], baseRefs,
        proposeFor: rec ? rec.id : isThreadKey(key) ? '*' : null, onEvent,
        fakeArgs: { key, questionId: hasQ ? questionId : undefined, text: hasQ ? undefined : question } });
    },

    async whatIf({ db, packId, clock, onEvent } = {}) {
      const scenario = buildScenario(db, { clock, packs });
      const { def, context } = packConversationContext(db, packs, packId);
      const prompt = def.whatIf && def.whatIf.prompt ? def.whatIf.prompt : '';
      const key = 'pack:' + packId;
      // The prompt opens the conversation; drop an earlier copy of it (a prior notice round).
      const stored = whatIfOwnerText(def);
      const history = (scenario.live.conversations[key] || []).filter(m => !(m.role === 'me' && m.text === stored));
      const baseRefs = (def.whatIf && Array.isArray(def.whatIf.unlocks) ? def.whatIf.unlocks : []).map(u => u && u.recId);
      // A manifest prompt is literal text; an illustrative demo prompt may carry scenario tokens.
      const question = typeof def.manifest === 'string' ? prompt : plain(scenario, prompt);
      return run({ db, scenario, now: clockNow(db, clock), question, context, history, baseRefs, onEvent, fakeArgs: { key, whatIfPack: def } });
    },
  };
}
