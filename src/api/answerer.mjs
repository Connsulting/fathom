import { listPreferences } from '../actions/preferences.mjs';
// The live answerer: every Ask thread (including one asked from a rec), pack follow-up and What if goes through the
// runtime engine (live or fake), then through grounding and escaping before it is stored.
//
// createLiveAnswerer({ engine, packs }) (packs: the live pack view, src/packs/live.mjs) ->
//   answer({ db, key, questionId?, text?, clock?, refs? }) -> { paragraphs, refs, notice?, provenance? } | null
//   whatIf({ db, packId, clock? })                  -> { paragraphs, refs, notice?, provenance? }
// paragraphs are paragraph inner HTML (the handler wraps each in <p>); null means questionId
// names no question in that conversation. answer's `refs` input is the parsed request context
// ([{ kind, id }], src/api/context-refs.mjs): the ones the store knows go into the conversation
// context as `references` ([{ kind, id, use }], merged with a rec or pack context) and into
// provenance.references ([{ kind, id }], absent when none resolved). References are never grounding
// evidence: their ids and tool hints never ground a number.
//
// Prompt assembly (buildChatPrompt): the static product rules, then the answer style and the
// spending guide (a separate section), plus the active packs' context go in `system` (before the
// SDK dynamic boundary, prompt cached, no household data); the household summary, the
// conversation context and today go in `systemDynamic`.
//
// Model output is untrusted. groundAnswer validates every scenario token itself, masks it, and
// checks every remaining number against tool results and context data only (stored figures may
// appear only as tokens). A negative number in a tool result also grounds its unsigned form, so
// "$2,400" grounds on an outflow row of -2400. Each grounded literal names its source in plain
// words, never a tool name; a transaction amount names its row ("your transactions: <account>,
// <date>, <description>"), and a date in the prose matching a same-turn row date is a literal
// with that row's label (other unsourced dates are unchecked, see groundAnswer). An unchecked figure stays in place, wrapped
// in a neutral .fx-checking .fx-unchecked span titled "Not checked against your data". The answer
// is regenerated once, with a corrective turn, only when two or more of its figures and more than
// half of them are unchecked; what is still unchecked after that is neutralized the same way.
// renderAnswer escapes everything except valid tokens and the spans it adds.
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
// number as still being checked), { type: 'interim', text } (the text streamed so far in a tool
// round, sent before that round's tools: it is working text, not the answer, and moves into the
// work block) and { type: 'reset' } (drop the streamed text: the engine restreams after the SDK
// superseded refused frames, or the answer is being regenerated, in which case the progress label
// "Revised to remove N unchecked figures" comes first so the cleared text has a stated reason; a
// tool call does not reset it). The returned reply is the only grounded result; nothing streamed
// is stored. A throwing onEvent never fails the answer.
//
// Only the engine's final text (the round after the last tool round) is grounded, rendered and fed
// back in the corrective turn. provenance.work = { ms, items } records how the answer was reached,
// built after the fact so it is the same with or without onEvent: items are { k: 'step', label }
// and { k: 'note', text } in order: the start step; per tool round its notes and tool steps in
// content order (the live order); the grounding step; on a regeneration the revision step, the
// second call's rounds and the grounding step. The replaced first answer is never a note (stored
// items from before this rule may still carry { draft: true } notes). A step equal to the
// previous step collapses (notes in between too). Nothing is cut, so the stored list equals the
// live one; the engine already bounds it (8 rounds per call, each within its token limit). ms is
// the answer's wall time in whole milliseconds. A notice reply has no work.
//
// The model's text loses its Source, Reference or Citation lines and sentences (stripSources) before grounding,
// and the rendered blocks keep a minimal markdown subset (src/shared/answer-text.mjs): paragraphs,
// bullet and numbered lists and bold, over the escaped text. List blocks come back complete
// (<ul>/<ol>); every other block is paragraph inner HTML.
//
// Ask threads can write through scoped registry tools; receipts and Undo are durable product data.

import { callTool, tools as REGISTRY } from '../tools/index.mjs';
import { buildScenario, clockNow } from '../scenario/build.mjs';
import { findDates } from '../engine/grounding.mjs';
import { checkGrounding, numberPattern, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError, RoundLimitError } from '../engine/index.mjs';
import { packContext } from '../packs/index.mjs';
import { packStatus } from '../shared/rules.mjs';
import { escapeUserText, resolveTokens } from '../shared/tokens.mjs';
import { parseJson } from '../store/db.mjs';
import { findQuestion, matchQuestion, recForKey, isThreadKey } from './questions.mjs';
import { fakeAnswerScript } from './fake-answers.mjs';
import { stripSources, listMarkerSpans, markdownBlocks } from '../shared/answer-text.mjs';
import { resolveRefs } from './context-refs.mjs';

export const PRODUCT_RULES = [
  'You are Fathom, a year-round financial co-pilot for one household of independent professionals.',
  'You are advisory only: you explain and recommend. You never file taxes, never move money or change any account, and never select individual securities.',
  'Never state a number you did not take from a tool result, the household summary, the conversation context or a knowledge pack entry.',
  'Write stored figures as {f:key} tokens using the keys get_figures returns, never as typed amounts.',
  'Never write a Sources, References or Citations line and never cite sources in your prose: the app shows the sources it used under every answer.',
  'Call tools before you write the answer, and do not narrate tool use.',
  'Answer in short paragraphs separated by blank lines. You may use bullet lists (lines starting with "- "), numbered lists (lines starting with "1. ") and **bold**; use no other markdown (no headings, links or tables) and no HTML.',
  'The conversation context may list references: items the owner pointed at on screen, as kind and id, each with the tools that read it. Read them with those tools; never guess what they hold and never state a number about them that a tool did not return.',
].join('\n');

export const ASK_ACTION_RULES = [
  '## Ask actions',
  'In an Ask thread, act when the person explicitly asks you to record a fact, check a step, change a recommendation or create/edit a goal. Use the write tools. Confirm only when their request is ambiguous. Never change anything on your own initiative.',
  'Use only the person\'s typed words or stored data for fact values and goal targets. Never invent a figure or infer a date. A tool receipt shows exactly what changed and offers Undo. Sending to the advisor and email require the product button; never claim you sent anything.',
  'Remember a stated household preference or definition with remember_preference. Preferences guide wording and definitions, never override product boundaries, evidence requirements or tool permissions.',
].join('\n');

// ---------------------------------------------------------------- answer style and spending guide
// A separate system prompt section after PRODUCT_RULES: shape and length of the reply, and where
// spending data lives. PRODUCT_RULES stays the hard rules.

export const ANSWER_STYLE = [
  'Answer style:',
  'Lead with the direct answer in one or two sentences.',
  'Keep the whole reply under about 150 words unless the owner asks for more detail.',
  'Use at most one short list.',
  'Skip generic caveats the owner did not ask about.',
  'End with one offer of the next useful step.',
].join('\n');

export const SPENDING_GUIDE = [
  'Spending questions:',
  'Spending lives in the transactions of every card and cash account. Call list_accounts, then query_transactions per account or with no accountId for all accounts, and group the rows by their category; card rows carry the budgeting app category.',
  'A card payment from checking moves money to the card; it is not new spending.',
  'Use pnl_by_month for business income, expenses or profit.',
].join('\n');

export const NOTICES = Object.freeze({
  engineOff: 'Engine is off, so answers are paused. Switch it back on to get an answer.',
  configOff: "The engine is off in this deployment's configuration, so answers are paused.",
  overCap: "This month's engine budget of {f:engine.budget.monthly} is used up, so answers are paused. Raise the cap on the Engine screen or wait for next month.",
  modelError: 'The model could not answer just now, so nothing was made up. Try again in a moment.',
});

const UNCHECKED_OPEN = '<span class="fx-checking fx-unchecked" title="Not checked against your data">';
// Regenerate only when at least REGEN_MIN figures and more than REGEN_SHARE of all figures are unchecked.
const REGEN_MIN = 2;
const REGEN_SHARE = 0.5;
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
  const system = PRODUCT_RULES + '\n\n' + ASK_ACTION_RULES + '\n\n' + ANSWER_STYLE + '\n\n' + SPENDING_GUIDE + '\n\n<knowledge_packs>\n' + packContextText + '\n</knowledge_packs>';
  let systemDynamic = '<household_summary>\n' + JSON.stringify(summary ?? {}) + '\n</household_summary>';
  if (context) systemDynamic += '\n<conversation_context>\n' + JSON.stringify(context) + '\n</conversation_context>';
  if (today) systemDynamic += `\nToday is ${today}.`;
  const turns = (Array.isArray(history) ? history : []).filter(m => m && !m.notice).slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', content: plainText(m.text) }));
  return { system, systemDynamic, messages: [...turns, { role: 'user', content: String(question ?? '') }] };
}

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

// A query_transactions row's negative amount v becomes [v, -v], so an unsigned prose amount grounds
// on an outflow row. No other value is mirrored: a loss never grounds the same amount as a profit.
// It runs after scrub, so an identifier never grounds this way.
function unsigned(v, key = undefined) {
  if (typeof v === 'number') return key === 'amount' && v < 0 ? [v, -v] : v;
  if (Array.isArray(v)) return v.map(x => unsigned(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unsigned(x, k)]));
  return v;
}

// A tool result as grounding evidence: the evidence sanitizer plus argument echoes (see isEcho),
// then, for transactions, unsigned outflow amounts (see unsigned). Error results pass through
// (checkGrounding ignores them).
function groundingResult(r) {
  if (!r || typeof r !== 'object' || r.isError) return r;
  const result = scrub(r.result ?? null, argEchoes(r.args));
  return { name: r.name, result: r.name === 'query_transactions' ? unsigned(result) : result };
}

// ---------------------------------------------------------------- source labels

// Plain source labels by tool name, for literals a tool result grounds. Never the tool name itself.
const TOOL_SOURCES = Object.freeze({
  household_summary: 'your household summary',
  get_facts: 'your stored facts',
  list_accounts: 'your accounts',
  query_transactions: 'your transactions',
  list_positions: 'your holdings',
  pnl_by_month: 'your monthly income and spending',
  list_recommendations: 'your plan',
  get_recommendation: 'the recommendation',
  list_deadlines: 'your deadlines',
  list_goals: 'your goals',
  get_pace: 'your goal pace',
  get_figures: 'your stored figures',
  packs_status: 'your knowledge packs',
  advisor_status: 'your advisor status',
  list_packs: 'your knowledge packs',
  get_pack_entry: 'a knowledge pack entry',
  search_pack_entries: 'your knowledge packs',
});
const toolSource = name => (Object.hasOwn(TOOL_SOURCES, name) ? TOOL_SOURCES[name] : 'your data');

const ROW_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// The plain objects in a raw tool result, depth first: its rows (and the result itself).
function rowsOf(v, out = []) {
  if (Array.isArray(v)) for (const x of v) rowsOf(x, out);
  else if (v && typeof v === 'object') {
    out.push(v);
    for (const x of Object.values(v)) if (x && typeof x === 'object') rowsOf(x, out);
  }
  return out;
}

// The string leaves of a context datum under data keys (meta keys such as ids and titles skipped).
function dateStrings(v, key = undefined, out = []) {
  if (key !== undefined && isMetaKey(key)) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) dateStrings(x, key, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) dateStrings(x, k, out);
  return out;
}

// A row's source label: a transaction names its account, date and description; any other row
// takes its tool's label.
function rowSource(name, row, accountLabels) {
  if (name !== 'query_transactions' || !row || typeof row.date !== 'string') return toolSource(name);
  const account = accountLabels && row.accountId != null ? accountLabels.get(row.accountId) : undefined;
  const parts = [account, row.date, row.description].map(oneLine).filter(Boolean);
  return `${toolSource(name)}: ${parts.join(', ')}`;
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

// groundAnswer(text, { scenario, toolResults, data, dataLabels?, accountLabels? }) ->
//   { ok, violations: [{text, index, reason}], figureKeys, literals: [{text, index, source, date?}] }
// Every token is validated here and masked with equal-length spaces (invalid ones are recorded
// once as violations), then checkGrounding sees only tool results and context data, never the
// stored figures, so a stored value typed as a literal is a violation. Tool results and every
// datum go through the evidence sanitizer first, so identifiers and labels never ground. Each
// grounded literal is attributed to the first single source that grounds it: a tool result (a
// plain label, see TOOL_SOURCES; a query_transactions literal names the first row that grounds it,
// with the account label from accountLabels, a Map of account id to label), else a context datum
// (dataLabels[i], default "your data"). A date in the prose whose month and day (and year, when
// written) equal a date in a tool result row (date, asOf) is a literal too ({ date: true }) with that row's
// label, and one the context data states is a literal with that datum's label; any other date is a
// violation with { date: true } (neutralized, never counted toward a regeneration). Literals are in
// text order.
export function groundAnswer(text, { scenario, toolResults = [], data = [], dataLabels = [], accountLabels } = {}) {
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
  // Ordered-list markers ("1. ") are list numbering, not figures. The mask keeps the line a list
  // item (a bullet, then spaces of equal length) so grounding's structural count sees the list.
  let unlisted = masked;
  for (const m of listMarkerSpans(masked)) {
    unlisted = unlisted.slice(0, m.index) + '•' + ' '.repeat(m.length - 1) + unlisted.slice(m.index + m.length);
  }
  return groundMasked(unlisted, { scenario, toolResults, data, dataLabels, accountLabels, violations, figureKeys });
}

function groundMasked(masked, { scenario, toolResults, data, dataLabels, accountLabels, violations, figureKeys }) {
  const raws = Array.isArray(toolResults) ? toolResults : [];
  const results = raws.map(groundingResult);
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
      ...results.map(r => ({ label: toolSource(r && r.name), check: () => checkGrounding(masked, { toolResults: [r] }) })),
      ...values.map((d, i) => ({ label: String(dataLabels[i] || 'your data'), check: () => checkGrounding(masked, { data: [d] }) })),
    ];
    const misses = sources.map(() => null);
    // Per transaction result, its dated rows with the prose offsets each one leaves unsupported.
    const rowChecks = [];
    const sourceOf = (i, span) => {
      const raw = raws[i];
      if (!(i < results.length) || !raw || raw.isError || raw.name !== 'query_transactions') return sources[i].label;
      rowChecks[i] ??= rowsOf(raw.result).filter(row => typeof row.date === 'string').map(row => ({ row, misses: null }));
      const echoes = argEchoes(raw.args);
      for (const c of rowChecks[i]) {
        c.misses ??= new Set(checkGrounding(masked, { toolResults: [unsigned(scrub(c.row, echoes))] }).violations.map(v => v.index));
        if (!c.misses.has(span.index)) return rowSource(raw.name, c.row, accountLabels);
      }
      return sources[i].label;
    };
    for (const span of spans) {
      for (let i = 0; i < sources.length; i++) {
        misses[i] ??= new Set(sources[i].check().violations.map(v => v.index));
        if (!misses[i].has(span.index)) { literals.push({ text: span.text, index: span.index, source: sourceOf(i, span) }); break; }
      }
    }
  }

  // Dates are not checked figures; one matching a date in a same-turn row (a YYYY-MM-DD string
  // under any data key: date, asOf, dataThrough) is sourced to that row.
  // A date the context data states (an ISO string under a data key, or a date written in its prose:
  // the household summary's today, a pack entry's deadline) is sourced to that datum. Any other date
  // is a violation with { date: true }: neutralized in place, never counted toward a regeneration.
  const dates = findDates(masked);
  if (dates.length) {
    const isoParts = v => { const p = ROW_DATE.exec(v); return p ? { year: Number(p[1]), month: Number(p[2]), day: Number(p[3]) } : null; };
    const dated = raws.filter(r => r && !r.isError).flatMap(r => rowsOf(r.result)
      .flatMap(row => Object.entries(row)
        .filter(([k, v]) => typeof v === 'string' && !isMetaKey(k))
        .map(([, v]) => ({ source: () => rowSource(r.name, row, accountLabels), parts: isoParts(v) }))
        .filter(x => x.parts)));
    (Array.isArray(data) ? data : [data]).forEach((datum, i) => {
      const label = String(dataLabels[i] || 'your data');
      for (const v of dateStrings(datum)) {
        const parts = /\s/.test(v.trim()) ? findDates(v).map(d => ({ year: d.year, month: d.month, day: d.day })) : [isoParts(v)];
        for (const p of parts) if (p) dated.push({ source: () => label, parts: p });
      }
    });
    for (const d of dates) {
      const hit = dated.find(({ parts }) => parts.month === d.month && parts.day === d.day
        && (d.year === null || parts.year === d.year));
      if (hit) literals.push({ text: d.text, index: d.index, source: hit.source(), date: true });
      else violations.push({ text: d.text, index: d.index, reason: 'date absent from sources', date: true });
    }
    literals.sort((a, b) => a.index - b.index);
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
// Violations are neutralized in place: wrapped in .fx-checking .fx-unchecked, the neutral style
// streamed numbers use, titled "Not checked against your data" (an invalid token is escaped inside
// it, so it never resolves); bound literals in .fx-src with data-src the literal's index and a
// "From" title. Stored answers from before this rule keep their .fx-unverified spans.
export function renderAnswer(text, violations = [], literals = []) {
  const prose = String(text ?? '');
  const marks = [
    ...violations.map(v => ({ start: v.index, end: v.index + v.text.length, kind: 'unchecked' })),
    ...literals.map((l, n) => ({ start: l.index, end: l.index + l.text.length, kind: 'src', n, source: l.source })),
  ].filter(m => Number.isInteger(m.start) && m.start >= 0 && m.end <= prose.length && m.end > m.start)
    .sort((a, b) => a.start - b.start || (a.kind === 'unchecked' ? -1 : 1));
  let html = '';
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    html += escapeKeepingTokens(prose.slice(at, m.start));
    const inner = escapeUserText(prose.slice(m.start, m.end));
    html += m.kind === 'unchecked'
      ? `${UNCHECKED_OPEN}${inner}</span>`
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
  remember_preference: 'Remembering your preference',
  record_household_fact: 'Recording what you told Fathom',
  set_recommendation_step: 'Updating a recommendation step',
  set_recommendation_status: 'Updating a recommendation',
  set_recommendation_owner: 'Updating who acts',
  create_goal: 'Saving your goal',
  edit_goal: 'Updating your goal',
});
export const PROGRESS_START = 'Reading your household summary';
export const PROGRESS_GROUNDING = 'Checking every number against your data';
const PROGRESS_OTHER = 'Looking at your data';
// The one step a regeneration shows, before the replaced text clears.
const revisedLabel = n => `Revised to remove ${n} unchecked figure${n === 1 ? '' : 's'}`;

export const progressLabel = name => (Object.hasOwn(PROGRESS_LABELS, name) ? PROGRESS_LABELS[name] : PROGRESS_OTHER);

// A safe emitter: progress labels deduplicated in a row, a reset only after text, a throwing
// listener ignored. Engine events ({ type: 'tool', name } / { type: 'text', text } /
// { type: 'interim', text } / { type: 'reset' }) go through engineEvent. A tool call does not reset
// streamed text; an interim event moves it into the work block. A reset is always plain: the
// engine's restream after superseded frames, or a regeneration right after its revision step.
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
      if (e.type === 'tool') out.progress(progressLabel(String(e.name || '')));
      else if (e.type === 'text' && typeof e.text === 'string' && e.text) { texted = true; send({ type: 'text', text: e.text }); }
      else if (e.type === 'interim' && typeof e.text === 'string' && e.text) { texted = false; send({ type: 'interim', text: e.text }); }
      else if (e.type === 'reset') out.reset();
    },
  };
  return out;
}

// provenance.work: the steps and notes of one answer, built after the fact from the engine
// results, so a streamed and an unstreamed ask store the same list. A step equal to the previous
// step collapses, notes in between or not (as the live emitter dedupes progress labels); notes are
// trimmed. No note or item cap: the stored list equals the live one, and the engine bounds its
// size (8 rounds per call, each within the request's token limit).
function workList() {
  const items = [];
  let lastStep = null;
  const list = {
    items,
    // A step equal to the previous step collapses even with notes in between, as live progress does.
    step(label) {
      if (label !== lastStep) { lastStep = label; items.push({ k: 'step', label }); }
    },
    note(text) {
      const t = String(text ?? '').trim();
      if (t) items.push({ k: 'note', text: t });
    },
    // Each tool round of an engine result: its notes and tool steps in content order (parts), so
    // the stored order equals the live order.
    rounds(res) {
      for (const r of (res && Array.isArray(res.toolRounds) ? res.toolRounds : [])) {
        for (const p of Array.isArray(r.parts) ? r.parts : []) {
          if (p && typeof p.text === 'string') list.note(p.text);
          else if (p && p.tool !== undefined) list.step(progressLabel(String(p.tool || '')));
        }
      }
    },
  };
  return list;
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

  // One grounded model answer: call, ground, regenerate once with a corrective turn when most
  // figures are unchecked (needsRevision), render.
  async function run({ db, scenario, now, question, context, history, baseRefs, references = [], fakeArgs, actions = false, onEvent, actionContext = null }) {
    if (!engine.isOn()) return offNotice(engine);
    const t0 = performance.now();
    const stream = streamer(onEvent);
    const work = workList();
    stream.progress(PROGRESS_START);
    work.step(PROGRESS_START);
    const summary = await callTool('household_summary', {}, { db, now });
    const active = activeManifestPacks(db, packs);
    const packIds = active.map(a => a.pack.id).sort();
    const packContextText = packContext(active.map(({ pack }) => ({ pack, status: 'active' })));
    const prompt = buildChatPrompt({ packContextText, summary, context, history, question, today: scenario.meta && scenario.meta.clock });
    prompt.systemDynamic += '\n<household_preferences>\n' + JSON.stringify(listPreferences(db)) + '\n</household_preferences>';
    const offered = REGISTRY.filter(t => !t.mcpOnly && (t.scope === 'read' || actionContext?.actorId));
    const fake = engine.mode === 'fake' ? fakeAnswerScript({ scenario, summary, propose: actions, ...fakeArgs }) : undefined;
    const request = { purpose: 'chat', system: prompt.system, systemDynamic: prompt.systemDynamic, messages: prompt.messages,
      tools: offered, toolContext: { ...actionContext, db, now }, maxTokens: MAX_TOKENS, ...(fake ? { fake } : {}),
      ...(stream.engineEvent ? { onEvent: stream.engineEvent } : {}) };

    // groundAnswer sanitizes each datum (and context.entries bodies lose their metadata lines there).
    // References (ids and tool hints) are for the model only and never ground a number.
    const entryBodies = active.flatMap(({ pack }) => pack.entries.map(e => groundingBody(e.body)));
    const { references: _references, ...groundedContext } = context || {};
    const data = [summary, context ? groundedContext : null, entryBodies];
    const dataLabels = ['household summary', 'conversation context', 'knowledge pack entries'];
    const resultsOf = res => (res && Array.isArray(res.toolResults) ? res.toolResults : []);
    const textOf = res => stripSources(res.text);
    // Account labels for transaction literals, read the way list_accounts names them, once.
    let accountLabels;
    const labelsFor = async toolResults => {
      if (accountLabels || !toolResults.some(r => r && !r.isError && r.name === 'query_transactions')) return accountLabels;
      try {
        accountLabels = new Map((await callTool('list_accounts', {}, { db, now })).map(a => [a.id, a.name]));
      } catch { accountLabels = new Map(); }
      return accountLabels;
    };
    const ground = async (res, toolResults) => groundAnswer(textOf(res),
      { scenario, toolResults, data, dataLabels, accountLabels: await labelsFor(toolResults) });
    // Regenerate only when REGEN_MIN or more figures and more than REGEN_SHARE of all figures are
    // unchecked. Figures: violations, grounded number literals and valid figure tokens, dates excluded.
    const needsRevision = (res, g) => {
      const tokens = [...textOf(res).matchAll(TOKEN_LIKE)].filter(m => m[1] !== 'n' && tokenValid(scenario, m[1], m[2])).length;
      const unchecked = g.violations.filter(v => !v.date).length;
      const figures = unchecked + g.literals.filter(l => !l.date).length + tokens;
      return unchecked >= REGEN_MIN && unchecked / figures > REGEN_SHARE;
    };

    const actionReply = reply => actionContext?.turnId ? { ...reply, provenance: { ...reply.provenance, actionTurn: actionContext.turnId } } : reply;
    let first;
    try { first = await engine.call(request); } catch (e) { return actionReply(noticeFor(e, engine)); }
    stream.progress(PROGRESS_GROUNDING);
    work.rounds(first);
    work.step(PROGRESS_GROUNDING);
    let chosen = first;
    let toolResults = resultsOf(first);
    let grounding = await ground(first, toolResults);
    let revised = 0;
    let costUsd = first.costUsd || 0;
    if (needsRevision(first, grounding)) {
      // The step streams before the reset, so the cleared text has a stated reason.
      revised = grounding.violations.filter(v => !v.date).length;
      stream.progress(revisedLabel(revised));
      stream.reset();
      work.step(revisedLabel(revised));
      const list = grounding.violations.map(v => v.text).join(', ');
      const earlier = resultsOf(first).map(r => ({ name: r.name, args: r.args ?? {}, result: r.result ?? null,
        ...(r.isError ? { isError: true } : {}) }));
      const evidence = earlier.length ? `\n\nTool results from your first attempt (still available as evidence):\n${JSON.stringify(earlier)}` : '';
      const retry = { ...request, tools: request.tools.filter(t => t.scope === 'read'), messages: [...request.messages, { role: 'assistant', content: first.text },
        { role: 'user', content: CORRECTIVE.replace('{list}', () => list) + evidence }] };
      try {
        const second = await engine.call(retry);
        stream.progress(PROGRESS_GROUNDING);
        work.rounds(second);
        work.step(PROGRESS_GROUNDING);
        costUsd += second.costUsd || 0;
        chosen = second;
        toolResults = [...resultsOf(first), ...resultsOf(second)];
        grounding = await ground(second, toolResults);
      } catch (e) {
        // Never the first, ungrounded answer: the engine recorded each completed round's spend.
        return actionReply(noticeFor(e, engine));
      }
    }

    const recReads = toolResults.filter(r => !r.isError && r.name === 'get_recommendation').map(r => r.args && r.args.id);
    const text = textOf(chosen);
    const paragraphs = renderAnswer(text, grounding.violations, grounding.literals);
    if (!paragraphs.length) return noticeReply(NOTICES.modelError);
    const lower = text.toLowerCase();
    return {
      paragraphs,
      refs: unique([...baseRefs, ...recReads]),
      provenance: {
        ...(actionContext?.turnId ? { actionTurn: actionContext.turnId } : {}),
        engine: engine.mode,
        model: chosen.model,
        tools: toolResults.map(r => ({ name: r.name, args: r.args ?? {} })),
        figures: grounding.figureKeys,
        packIds,
        packEntries: unique([...active.flatMap(({ pack }) => pack.entries.map(e => e.title)),
          ...(context && Array.isArray(context.entries) ? context.entries.map(e => e.title) : [])]
          .filter(title => lower.includes(title.toLowerCase()))),
        literals: grounding.literals.map(l => ({ text: l.text, source: l.source })),
        grounding: { ok: grounding.ok, retried: revised > 0, unverified: grounding.violations.map(v => v.text),
          ...(revised ? { revised } : {}) },
        costUsd: Number(costUsd.toFixed(6)),
        ...(references.length ? { references: references.map(({ kind, id }) => ({ kind, id })) } : {}),
        work: { ms: Math.max(0, Math.round(performance.now() - t0)), items: work.items },
      },
    };
  }

  return {
    async answer({ db, key, questionId, text, clock, refs, onEvent, actorId, ownerText, turnId, replan, queuePlan } = {}) {
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
      const references = resolveRefs(db, scenario, refs);
      if (references.length) context = { ...(context || {}), references };
      return run({ db, scenario, now, question, context, history: scenario.live.conversations[key] || [], baseRefs, references,
        actions: isThreadKey(key), onEvent,
        actionContext: isThreadKey(key) && actorId ? { actorId, ownerText, turnId, replan, queuePlan, conversationKey: key, recId: rec?.id } : null,
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
