import { ownerStatements } from '../actions/evidence.mjs';
import { listPreferences } from '../actions/preferences.mjs';
// The live answerer: every Ask thread (including one asked from a rec), pack follow-up and What if goes through the
// runtime engine (live or fake), then through grounding and escaping before it is stored.
//
// createLiveAnswerer({ engine, packs, root, services }) (one per household: packs is its live pack view,
// src/packs/live.mjs, and root its household root, which every tool call gets as ctx.dataDir) ->
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
// is regenerated once for any answer-discipline violation; what is still unchecked after that
// is neutralized the same way, and remaining discipline kinds are recorded in provenance.
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
// runs, and only progress: { type: 'progress', label } (a fixed plain label per tool, never
// arguments or values; a regeneration adds "Revised to remove N unchecked figures") and
// { type: 'interim', text } (a tool round's text, sent before that round's tools: working text,
// not the answer, shown as a note in the work block). Answer text is never streamed, so a draft
// the corrective round replaces never reaches the page; the engine's text and reset events stop
// here. The returned reply is the only answer and the only grounded result, delivered once;
// nothing streamed is stored. A throwing onEvent never fails the answer.
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
// provenance.blocks: blocks drawn by show carry origin 'model'. When none was drawn and the final text
// does not lead with a refusal, up to two automatic blocks (origin 'auto') come from the turn's reads.
// provenance.leftOut (absent when empty) names what the turn's reads left out (src/api/left-out.mjs);
// an open-ended transactions search reads on to CONTINUE_CAP rows before the model sees it.
// Ask threads can write through scoped registry tools; receipts and Undo are durable product data.
// With a signed-in owner every offered write tool also takes propose: true (src/actions/proposals.mjs):
// the operation is recorded, not run, and the reply carries it as provenance.pendingAction (never
// on a notice reply). answer's `scopes` limits what may be proposed; `staleNote` is a note from
// Fathom given to the model with the question and shown as the reply's first paragraph.

import { droppedBlock } from '../tools/catalog/show.mjs';
import { placeBlocks } from '../shared/answer-text.mjs';
import { autoBlocks } from '../blocks/auto.mjs';
import { callTool, tools as REGISTRY, getTool, instructions, ToolError } from '../tools/index.mjs';
import { proposalTools } from '../actions/proposals.mjs';
import { buildScenario, clockNow } from '../scenario/build.mjs';
import { findDates } from '../engine/grounding.mjs';
import { checkGrounding, numberPattern, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError, RoundLimitError } from '../engine/index.mjs';
import { packContext } from '../packs/index.mjs';
import { packStatus } from '../shared/rules.mjs';
import { escapeUserText, resolveTokens } from '../shared/tokens.mjs';
import { parseJson } from '../store/db.mjs';
import { findQuestion, matchQuestion, recForKey, isThreadKey } from './questions.mjs';
import { fakeAnswerScript } from './fake-answers.mjs';
import { stripSources, listMarkerSpans, markdownBlocks, wrapBlocks, plainAnswerText } from '../shared/answer-text.mjs';
import { resolveRefs } from './context-refs.mjs';
import { DEMO_LIMIT_MESSAGE } from '../public-demo/control.mjs';
import { ANSWER_MAX_WORDS } from '../shared/answer-contract.mjs';
import { checkAnswerDiscipline } from '../shared/answer-discipline.mjs';
import { leftOutOf, continueRead } from './left-out.mjs';

// A final text that leads with a refusal gets no automatic block.
const REFUSAL = /^[\s*_#>"'“]*(?:(?:sorry|unfortunately|i['’]m sorry|i am sorry)[,.!]?\s+)?(?:I|Fathom)(?:\s+|['’])(?:can['’]?t|cannot|can not|won['’]?t|will not|(?:am|m|is) (?:not able|unable)|(?:don['’]?t|do not|doesn['’]?t|does not) have)\b/i;

export const PRODUCT_RULES = [
  'You are Fathom, a year-round financial co-pilot for one household of independent professionals.',
  'You are advisory only: explain and recommend. Never file taxes, move money, change accounts or select individual securities.',
  'For stored figures, call household.figures and write its returned {f:key} token, never numbers from the summary.',
  'Never write a Sources, References or Citations line or cite sources in prose; the app shows them under each answer.',
  'Call tools before you write the answer; do not narrate tool use.',
  'Do all needed read-only lookups before replying, including every relevant account, all 529s and checking for transfers. Never ask permission to read household data.',
  'Use short paragraphs with blank lines. You may use bullet lists ("- "), numbered lists ("1. ") and **bold**; no other markdown, headings, links, tables or HTML.',
  'The context may list references as screen item kinds, ids and reading tools. Read them with those tools; never guess their contents.',
].join('\n');

// ---------------------------------------------------------------- answer style and spending guide
// A separate system prompt section after PRODUCT_RULES: shape and length of the reply, and where
// spending data lives. PRODUCT_RULES stays the hard rules.

export const ANSWER_STYLE = [
  'Answer style:',
  'Lead with the direct answer in one or two sentences.',
  `Keep the whole reply under ${ANSWER_MAX_WORDS} words unless the owner asks for more detail.`,
  'Use at most one short list.',
  'Skip generic caveats the owner did not ask about.',
  'End with one offer of the next useful step.',
].join('\n');

export const NOTICES = Object.freeze({
  engineOff: 'Engine is off, so answers are paused. Switch it back on to get an answer.',
  configOff: "The engine is off in this deployment's configuration, so answers are paused.",
  overCap: "This month's engine budget of {f:engine.budget.monthly} is used up, so answers are paused. Raise the cap on the Engine screen or wait for next month.",
  modelError: 'The model could not answer just now, so nothing was made up. Try again in a moment.',
});

// Added to the chat rules when write tools are offered (an Ask thread with a signed-in owner).
export const PROPOSE_RULE = 'When you suggest a change the owner has not asked for, call the write tool with propose: true in the same turn instead of asking them to reply yes. Nothing is saved until they confirm.';

const UNCHECKED_OPEN = '<span class="fx-checking fx-unchecked" title="Not checked against your data">';
const HISTORY_LIMIT = 20;
const MAX_TOKENS = 1024;
// Any brace pair that looks like a scenario token; valid ones also need a safe key.
const TOKEN_LIKE = /\{(fk|f|l|p|n|b):([^{}]*)\}/g;
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;
function correctiveTurn(kinds) {
  const corrections = [];
  if (kinds.includes('length')) corrections.push(`Shorten the whole reply to ${ANSWER_MAX_WORDS} words or fewer.`);
  if (kinds.includes('figures.spelled_out')) corrections.push('Write every figure as digits.');
  if (kinds.includes('figures.self-computed')) corrections.push('Get every derived figure from the calculate tool.');
  if (kinds.includes('figures.rounded')) corrections.push('Use the exact figure returned by a tool, without rounding it yourself.');
  if (kinds.some(k => k === 'figures.unsourced' || k === 'figures.context-only'))
    corrections.push('Drop any figure no tool returned, or call a tool to source it.');
  return 'Answer again to correct these violations: ' + corrections.join(' ') +
    ' Write stored figures as {f:key} tokens from household.figures. Keep any proposal sentence and its confirmation offer in the answer.';
}

const PROPOSAL_SUBJECTS = {
  update_goal: /\bgoals?\b/i,
  update_preferences: /\b(?:preferences?|memor(?:y|ies)|remember)\b/i,
  answer: /\b(?:facts?|answers?|dates?|assumptions?)\b/i,
  act_on_recommendation: /\b(?:recommendations?|decisions?|plan items?)\b/i,
  update_account: /\baccounts?\b/i,
  categorize: /\b(?:categor(?:y|ies|ize)|merchant|rules?)\b/i,
  advisor_review: /\b(?:advisor|review)\b/i,
  refresh: /\b(?:refresh|sync|imports?|jobs?|data)\b/i,
  undo: /\b(?:undo|revert|changes?)\b/i,
};
function proposalStillOffered(text, pending) {
  const plain = plainAnswerText(text);
  if (/^(?:please )?(?:confirm|approve)(?: (?:it|this|the proposal|the change))? below[.!]?$/i.test(plain)) return true;
  const title = pending.args?.title;
  const refers = /\bproposal\b/i.test(plain) || PROPOSAL_SUBJECTS[pending.tool]?.test(plain)
    || (typeof title === 'string' && title.trim() && plain.toLowerCase().includes(title.toLowerCase()));
  return !!refers && /\b(?:confirm|approve|propose|proposed)\b|\b(?:I can|Would you like me to|Shall I)\b[^.!?\n]*\b(?:create|save|add|edit|update|change|set|remember|mark|start|complete|dismiss|snooze|reopen|rename|categorize|review|send|sync|refresh|undo|revert)\b/i.test(plain);
}

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
  const system = PRODUCT_RULES + '\n\n' + instructions + '\n\n' + ANSWER_STYLE + '\n\n<knowledge_packs>\n' + packContextText + '\n</knowledge_packs>';
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

// A transactions.search row's negative amount v becomes [v, -v], so an unsigned prose amount grounds
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
  return { name: r.name, result: r.name === 'transactions' ? unsigned(result) : result };
}

// ---------------------------------------------------------------- source labels

// Plain source labels by tool name, for literals a tool result grounds. Never the tool name itself.
const toolSource = name => getTool(name)?.source || 'your data';
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
  if (name !== 'transactions' || !row || typeof row.date !== 'string') return toolSource(name);
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
// plain label, see the tool headers; a transactions.search literal names the first row that grounds it,
// with the account label from accountLabels, a Map of account id to label), else a context datum
// (dataLabels[i], default "your data"). A date in the prose whose month and day (and year, when
// written) equal a date in a tool result row (date, asOf) is a literal too ({ date: true }) with that row's
// label, and one the context data states is a literal with that datum's label; any other date is a
// violation with { date: true } (neutralized, never counted toward a regeneration). Literals are in
// text order.
export async function groundAnswer(text, { scenario, toolResults = [], data = [], dataLabels = [], accountLabels } = {}) {
  const prose = String(text ?? '');
  const violations = [];
  const figureKeys = new Set();
  const masked = prose.replace(TOKEN_LIKE, (token, kind, key, index) => {
    if (kind === 'b') return ' '.repeat(token.length);
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
  const masks = new Set(toolResults.filter(r => !r.isError && r.name === 'accounts')
    .flatMap(r => rowsOf(r.result).map(row => String(row.mask ?? ''))));
  unlisted = unlisted.replace(/\b(?:account|card)\s+(?:ending|ends)(?:\s+(?:in|with))?\s+(\d{4})\b(?!\s*(?:%|percent\b|dollars?\b))/gi,
    (match, mask) => masks.has(mask) ? match.slice(0, -mask.length) + ' '.repeat(mask.length) : match);
  for (const m of listMarkerSpans(masked)) {
    unlisted = unlisted.slice(0, m.index) + '•' + ' '.repeat(m.length - 1) + unlisted.slice(m.index + m.length);
  }
  return await groundMasked(unlisted, { scenario, toolResults, data, dataLabels, accountLabels, violations, figureKeys });
}

async function groundMasked(masked, { scenario, toolResults, data, dataLabels, accountLabels, violations, figureKeys }) {
  const check = (text, options = {}) => checkGrounding(text, { ...options, allowCounts: true });
  const raws = Array.isArray(toolResults) ? toolResults : [];
  const results = raws.map(groundingResult);
  const values = (Array.isArray(data) ? data : [data]).map(evidence);
  const unsupported = check(masked, { toolResults: results, data: values }).violations;
  if (unsupported.length) {
    const figureValues = Object.values((scenario && scenario.fig) || {}).map(f => f && f.v).filter(Number.isFinite);
    const notFigures = new Set(check(masked, { data: [figureValues] }).violations.map(v => v.index));
    for (const v of unsupported) {
      violations.push(notFigures.has(v.index) ? v : { ...v, reason: 'stored figure written as a literal' });
    }
  }

  const literals = [];
  const unsupportedAt = new Set(unsupported.map(v => v.index));
  const spans = checkGrounding(masked).violations.filter(v => !unsupportedAt.has(v.index));
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
      if (!(i < results.length) || !raw || raw.isError || raw.name !== 'transactions') return sources[i].label;
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
        misses[i] ??= new Set((await sources[i].check()).violations.map(v => v.index));
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

export function checkAnswerForDelivery(text, { scenario, toolResults = [], data = [], grounding, moreDetail = false }) {
  const figures = Object.fromEntries(Object.entries(scenario.fig || {}).map(([key, f]) => [key, f.v]));
  const contextReads = data.map(result => ({ name: 'context', args: {}, result: evidence(result) }));
  return checkAnswerDiscipline(text, [...toolResults, ...contextReads], { figures,
    contextNumbers: Object.values(figures).filter(Number.isFinite), moreDetail, grounding,
    renderedHtml: wrapBlocks(renderAnswer(text, grounding.violations, grounding.literals)) });
}

// ---------------------------------------------------------------- progress labels

// Plain progress labels by tool name. Labels never carry arguments, values or model text.
export const PROGRESS_START = getTool('household').progress;
export const PROGRESS_GROUNDING = 'Checking every number against your data';
const PROGRESS_OTHER = 'Looking at your data';
// The one step a regeneration shows.
const revisedLabel = n => n ? `Revised to remove ${n} unchecked figure${n === 1 ? '' : 's'}` : 'Revised to follow the answer rules';

export const progressLabel = name => (getTool(name)?.progress || PROGRESS_OTHER);

// A safe emitter of progress and interim events only: progress labels deduplicated in a row, a
// throwing listener ignored. Engine events go through engineEvent: { type: 'tool', name } becomes
// a progress label, { type: 'interim', text } is forwarded as a work note, and the engine's
// { type: 'text' } deltas and { type: 'reset' } are dropped (the reply carries the answer).
function streamer(onEvent) {
  if (typeof onEvent !== 'function') return { progress() {}, engineEvent: undefined };
  let lastLabel = null;
  const send = e => { try { onEvent(e); } catch { /* the stream never fails an answer */ } };
  const out = {
    progress(label) { if (label !== lastLabel) { lastLabel = label; send({ type: 'progress', label }); } },
    engineEvent(e) {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'tool') out.progress(progressLabel(String(e.name || '')));
      else if (e.type === 'interim' && typeof e.text === 'string' && e.text) send({ type: 'interim', text: e.text });
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
const orderedArgs = value => Array.isArray(value) ? value.map(orderedArgs)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedArgs(value[key])])) : value;
const readIdentity = ({ name, args }) => JSON.stringify([name, orderedArgs(args ?? {})]);

function noticeReply(text) {
  return { paragraphs: [text], refs: [], notice: true };
}

const offNotice = engine => noticeReply(engine.mode === 'off' ? NOTICES.configOff : NOTICES.engineOff);

function noticeFor(error, engine) {
  if (error instanceof EngineOffError) return offNotice(engine);
  if (error instanceof BudgetExceededError) return noticeReply(error.demoLimit ? DEMO_LIMIT_MESSAGE : NOTICES.overCap);
  if (!(error instanceof ModelCallError || error instanceof ModelAccountingError || error instanceof RoundLimitError)) {
    console.error(`fathom: answer failed (${error && error.name ? error.name : 'error'})`);
  }
  return noticeReply(NOTICES.modelError);
}

// The manifest packs effectively active now (base status plus overrides), with their rows.
async function activeManifestPacks(db, packs) {
  const out = [];
  if (!packs) return out;
  for (const row of await db.prepare('SELECT id, def, active, exploring FROM packs_state ORDER BY sort, id').all()) {
    const def = parseJson(row.def, null);
    if (!def) continue;
    const pack = await packs.backing(row.id, def);
    const status = packStatus(def.status, { active: row.active == null ? null : !!row.active, exploring: !!row.exploring });
    if (status === 'active' && pack && !out.some(x => x.pack.id === pack.id)) out.push({ rowId: row.id, pack });
  }
  return out;
}

async function packConversationContext(db, packs, rowId) {
  const row = await db.prepare('SELECT def FROM packs_state WHERE id = ?').get(rowId);
  const raw = row ? parseJson(row.def, {}) : {};
  const def = packs ? await packs.view(rowId, raw) : raw;
  const pack = packs ? await packs.backing(rowId, raw) : null;
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

export function knowledgeCoverageDisclosure(scenario, context) {
  const plans = scenario.packs.find(p => p.id === 'your-plans' || p.manifest === 'your-plans');
  const override = plans ? scenario.live.packs[plans.id] : null;
  if (context?.pack?.id !== 'your-plans' && plans && packStatus(plans.status, override) !== 'active') return [];
  const lines = [...new Set((scenario.live.yourPlans?.coverage || []).map(issue => issue.disclosure))];
  return lines.length ? [lines.join(' ')] : [];
}

export function createLiveAnswerer({ engine, packs, root, services, onRead } = {}) {
  if (!engine || typeof engine.call !== 'function') throw new TypeError('createLiveAnswerer needs an engine');
  if (typeof root !== 'string' || !root) throw new TypeError('createLiveAnswerer needs the household root');
  if (!services || typeof services !== 'object') throw new TypeError('createLiveAnswerer needs household services');
  // The tool context of every call this answerer makes: its household's db and root.
  const toolCtx = (db, now) => ({ db, now, dataDir: root, services, household: services.household });
  const read = async (name, args, ctx) => {
    const result = await callTool(name, args, ctx);
    onRead?.({ name, args, result });
    return result;
  };

  // One grounded model answer with at most one corrective call through the same engine.
  async function run({ db, scenario, now, question, context, history, baseRefs, references = [], fakeArgs, actions = false, onEvent, actionContext = null }) {
    if (!engine.isOn()) return offNotice(engine);
    const t0 = performance.now();
    const stream = streamer(onEvent);
    const work = workList();
    stream.progress(PROGRESS_START);
    work.step(PROGRESS_START);
    const summary = await read('household', { operation: 'summary' }, toolCtx(db, now));
    const sourceReads = [{ name: 'household', args: { operation: 'summary' }, result: summary },
      ...(context?.recommendation ? [{ name: 'recommendations', args: { operation: 'detail', id: context.recommendation.id }, result: context.recommendation }] : [])];
    const active = await activeManifestPacks(db, packs);
    const packIds = active.map(a => a.pack.id).sort();
    const packContextText = packContext(active.map(({ pack }) => ({ pack, status: 'active' })));
    const prompt = buildChatPrompt({ packContextText, summary, context, history, question, today: scenario.meta && scenario.meta.clock });
    prompt.systemDynamic += '\n<household_preferences>\n' + JSON.stringify(await listPreferences(db)) + '\n</household_preferences>';
    const writes = !!actionContext?.actorId;
    const available = writes ? proposalTools(REGISTRY.filter(t => !t.mcpOnly)) : REGISTRY.filter(t => !t.mcpOnly && t.kind === 'read');
    const offered = available.map(tool => tool.kind !== 'read' ? tool : { ...tool, async handler(args, ctx) {
      const cached = sourceReads.find(r => readIdentity(r) === readIdentity({ name: tool.name, args }));
      return cached ? structuredClone(cached.result) : continueRead(tool.name, args, await tool.handler(args, ctx), a => tool.handler(a, ctx));
    } });
    if (writes) prompt.system += '\n\n' + PROPOSE_RULE;
    // The one operation this turn may propose (provenance.pendingAction), recorded by a propose call.
    let pendingAction = null;
    const onProposal = proposal => {
      if (pendingAction) throw new ToolError('conflict', 'Only one change can be proposed per answer.');
      pendingAction = structuredClone(proposal);
    };
    const fake = engine.mode === 'fake' ? fakeAnswerScript({ scenario, summary, propose: actions, ...fakeArgs }) : undefined;
    const turnResults = [];
    const blocks = [];
    const toolContext = { turnResults: () => turnResults, onBlock: block => blocks.push(block), ...actionContext, ...toolCtx(db, now), channel: 'ask', ...(writes ? { onProposal } : {}) };
    toolContext.ownerStatements = async () => await ownerStatements(toolContext);
    const request = { purpose: 'chat', system: prompt.system, systemDynamic: prompt.systemDynamic, messages: prompt.messages,
      tools: offered, toolContext, maxTokens: MAX_TOKENS, ...(fake ? { fake } : {}),
      ...(stream.engineEvent ? { onEvent: stream.engineEvent } : {}) };

    // groundAnswer sanitizes each datum (and context.entries bodies lose their metadata lines there).
    // References (ids and tool hints) are for the model only and never ground a number.
    const entryBodies = active.flatMap(({ pack }) => pack.entries.map(e => groundingBody(e.body)));
    const { references: _references, ...groundedContext } = context || {};
    const data = [summary, context ? groundedContext : null, entryBodies, question];
    const dataLabels = ['household summary', 'conversation context', 'knowledge pack entries', 'what you told Fathom'];
    const resultsOf = res => (res && Array.isArray(res.toolResults) ? res.toolResults : []);
    const textOf = res => placeBlocks(stripSources(res.text), blocks).text;
    // Account labels for transaction literals, read the way accounts.list names them, once.
    let accountLabels;
    const labelsFor = async toolResults => {
      if (accountLabels || !toolResults.some(r => r && !r.isError && r.name === 'transactions')) return accountLabels;
      try {
        accountLabels = new Map((await read('accounts', { operation: 'list' }, toolCtx(db, now))).map(a => [a.id, a.name]));
      } catch { accountLabels = new Map(); }
      return accountLabels;
    };
    const ground = async (res, toolResults) => await groundAnswer(textOf(res),
      { scenario, toolResults, data, dataLabels, accountLabels: await labelsFor(toolResults) });
    const moreDetail = /\b(?:(?:more|greater) detail|in detail|detailed (?:answer|explanation|breakdown)|(?:explain|walk me through) (?:it |this )?(?:fully|thoroughly|step by step))\b/i.test(question);
    const disciplineOf = (res, toolResults, grounding) => checkAnswerForDelivery(textOf(res),
      { scenario, toolResults: [...sourceReads, ...toolResults], data, grounding, moreDetail });

    const actionReply = reply => actionContext?.turnId ? { ...reply, provenance: { ...reply.provenance, actionTurn: actionContext.turnId } } : reply;
    let first;
    try { first = await engine.call(request); } catch (e) { return actionReply(noticeFor(e, engine)); }
    stream.progress(PROGRESS_GROUNDING);
    work.rounds(first);
    work.step(PROGRESS_GROUNDING);
    let chosen = first;
    let toolResults = resultsOf(first);
    let grounding = await ground(first, toolResults);
    let discipline = disciplineOf(first, toolResults, grounding);
    const triggeredBy = [...discipline.violations];
    let revised = 0;
    let retried = false;
    let costUsd = first.costUsd || 0;
    if (discipline.violations.length) {
      revised = grounding.violations.filter(v => !v.date).length;
      retried = true;
      stream.progress(revisedLabel(revised));
      work.step(revisedLabel(revised));
      const earlier = resultsOf(first).map(r => ({ name: r.name, args: r.args ?? {}, result: r.result ?? null,
        ...(r.isError ? { isError: true } : {}) }));
      const evidence = earlier.length ? `\n\nTool results from your first attempt (still available as evidence):\n${JSON.stringify(earlier)}` : '';
      const retry = { ...request, tools: request.tools.filter(t => t.kind === 'read'), messages: [...request.messages, { role: 'assistant', content: first.text },
        { role: 'user', content: correctiveTurn(discipline.violations) + evidence }] };
      try {
        const second = await engine.call(retry);
        stream.progress(PROGRESS_GROUNDING);
        work.rounds(second);
        work.step(PROGRESS_GROUNDING);
        costUsd += second.costUsd || 0;
        chosen = second;
        toolResults = [...resultsOf(first), ...resultsOf(second)];
        grounding = await ground(second, toolResults);
        discipline = disciplineOf(second, toolResults, grounding);
      } catch (e) {
        // Never the first, ungrounded answer: the engine recorded each completed round's spend.
        return actionReply({ ...noticeFor(e, engine), provenance: { discipline: { violations: discipline.violations, triggeredBy } } });
      }
    }

    const recReads = toolResults.filter(r => !r.isError && r.name === 'recommendations' && r.args?.operation === 'detail').map(r => r.args && r.args.id);
    // No drawn block and no refusal: Fathom draws from this turn's reads itself (src/blocks/auto.mjs).
    if (!blocks.length && !REFUSAL.test(stripSources(chosen.text))) blocks.push(...autoBlocks(turnResults,
      { now, ids: [...String(chosen.text ?? '').matchAll(/\{b:([^{}]*)\}/g)].map(m => m[1]) }));
    const placement = placeBlocks(stripSources(chosen.text), blocks);
    const text = placement.text;
    const blockNotes = toolResults.filter(r => r.name === 'show' && (r.isError || r.result?.status === 'dropped'))
      .map(r => droppedBlock(r.args?.operation, r.isError ? 'bad_input' : r.result.reason, { spec: r.args, results: toolResults }));
    if (retried && pendingAction && !proposalStillOffered(text, pendingAction))
      pendingAction = null;
    const queuedImport = toolResults.find(r => !r.isError && r.name === 'refresh' && r.result?.status === 'queued' && r.result.message);
    const paragraphs = renderAnswer(text, grounding.violations, grounding.literals);
    if (queuedImport && !text.includes(queuedImport.result.message)) paragraphs.unshift(escapeUserText(queuedImport.result.message));
    if (!paragraphs.length && !placement.blocks.length && !blockNotes.length) return actionReply({ ...noticeReply(NOTICES.modelError),
      provenance: { discipline: { violations: discipline.violations, triggeredBy } } });
    paragraphs.push(...knowledgeCoverageDisclosure(scenario, context).map(escapeUserText));
    const lower = text.toLowerCase();
    const leftOut = leftOutOf(toolResults);
    const seenReads = new Set();
    const sources = [...sourceReads, ...toolResults].filter(r => {
      if (getTool(r.name)?.kind !== 'read') return true;
      const key = JSON.stringify([readIdentity(r), !!r.isError]);
      if (seenReads.has(key)) return false;
      seenReads.add(key);
      return true;
    });
    return {
      paragraphs,
      refs: unique([...baseRefs, ...recReads]),
      provenance: {
        ...(actionContext?.turnId ? { actionTurn: actionContext.turnId } : {}),
        engine: engine.mode,
        model: chosen.model,
        tools: sources.map(r => ({ name: r.name, args: r.args ?? {}, ...(r.isError ? { isError: true, result: r.result } : {}) })),
        figures: grounding.figureKeys,
        packIds,
        packEntries: unique([...active.flatMap(({ pack }) => pack.entries.map(e => e.title)),
          ...(context && Array.isArray(context.entries) ? context.entries.map(e => e.title) : [])]
          .filter(title => lower.includes(title.toLowerCase()))),
        literals: grounding.literals.map(l => ({ text: l.text, source: l.source })),
        grounding: { ok: grounding.ok, retried, unverified: grounding.violations.map(v => v.text),
          ...(revised ? { revised } : {}) },
        discipline: { violations: discipline.violations, triggeredBy },
        costUsd: Number(costUsd.toFixed(6)),
        ...(references.length ? { references: references.map(({ kind, id }) => ({ kind, id })) } : {}),
        ...(pendingAction ? { pendingAction } : {}),
        blocks: placement.blocks, blockNotes,
        ...(leftOut.length ? { leftOut } : {}),
        work: { ms: Math.max(0, Math.round(performance.now() - t0)), items: work.items },
      },
    };
  }

  return {
    async answer({ db, key, questionId, text, clock, refs, onEvent, actorId, ownerText, turnId, replan, queuePlan, scopes, staleNote } = {}) {
      if (typeof key !== 'string' || !key) throw new TypeError('answer needs a conversation key');
      const scenario = await buildScenario(db, { clock, packs });
      const now = await clockNow(db, clock);
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
        context = { recommendation: await read('recommendations', { operation: 'detail', id: rec.id }, toolCtx(db, now)) };
        baseRefs = [...baseRefs, rec.id];
      } else if (key.startsWith('pack:')) {
        context = (await packConversationContext(db, packs, key.slice(5))).context;
      }
      const references = await resolveRefs(db, scenario, refs);
      if (references.length) context = { ...(context || {}), references };
      // A note from Fathom (a refused or out-of-date proposal) goes to the model with the question
      // and leads the reply; the stored owner message stays the owner's own words.
      const note = typeof staleNote === 'string' && staleNote.trim() ? staleNote.trim() : null;
      const asked = note ? `${question}\n\n[Note from Fathom: ${note} Re-check the current data and propose the change again if it still fits.]` : question;
      const reply = await run({ db, scenario, now, question: asked, context, history: scenario.live.conversations[key] || [], baseRefs, references,
        actions: isThreadKey(key), onEvent,
        actionContext: isThreadKey(key) && actorId ? { actorId, ownerText, turnId, replan, queuePlan, conversationKey: key, recId: rec?.id,
          ...(Array.isArray(scopes) ? { scopes } : {}) } : null,
        fakeArgs: { key, questionId: hasQ ? questionId : undefined, text: hasQ ? undefined : question } });
      return note ? { ...reply, paragraphs: [escapeUserText(note), ...reply.paragraphs] } : reply;
    },

    async whatIf({ db, packId, clock, onEvent } = {}) {
      const scenario = await buildScenario(db, { clock, packs });
      const { def, context } = await packConversationContext(db, packs, packId);
      const prompt = def.whatIf && def.whatIf.prompt ? def.whatIf.prompt : '';
      const key = 'pack:' + packId;
      // The prompt opens the conversation; drop an earlier copy of it (a prior notice round).
      const stored = whatIfOwnerText(def);
      const history = (scenario.live.conversations[key] || []).filter(m => !(m.role === 'me' && m.text === stored));
      const baseRefs = (def.whatIf && Array.isArray(def.whatIf.unlocks) ? def.whatIf.unlocks : []).map(u => u && u.recId);
      // A manifest prompt is literal text; an illustrative demo prompt may carry scenario tokens.
      const question = typeof def.manifest === 'string' ? prompt : plain(scenario, prompt);
      return run({ db, scenario, now: await clockNow(db, clock), question, context, history, baseRefs, onEvent, fakeArgs: { key, whatIfPack: def } });
    },
  };
}
