// Deterministic fake answer source for FATHOM_ENGINE=fake (the demo and the tests). It scripts
// the two rounds a live model would run: one tool round that reads the household summary, the
// figures its answer cites and the conversation's recommendation, then one text round.
//
// fakeAnswerScript({ scenario, key, questionId, text, whatIfPack, summary, propose }) -> [round1, round2]
// The text round is the canned demo answer for a suggested or rec question (by id or by exact
// free text), the pack's canned what-if answer, or a summary sentence whose number comes from the
// household_summary result. Numbers in the owner's free text are echoed back, so an invented
// amount reaches grounding the way a careless model would repeat it.
// When `propose` is set (the proposal tool is offered), free text that is an explicit command
// (it starts with accept, start, complete, dismiss, snooze or reopen, optionally after "please")
// naming a rec (the rec conversation's own rec, or in an Ask thread a visible rec's id or exact title) adds
// a propose_recommendation_action call, and the text round says the owner can confirm it below.
// In an Ask thread, free text "add a goal: <words>" adds a propose_goal call with those words as
// the title (a horizon phrase sets the horizon; the first amount the owner wrote is the target),
// and the text round says the owner can save it below. Its amounts are not echoed.

import { findQuestion, matchQuestion, recForKey, isThreadKey } from './questions.mjs';
import { resolveTokens } from '../shared/tokens.mjs';

const FIGURE_TOKEN = /\{(?:fk|f):([A-Za-z0-9_.-]+)\}/g;
const OWNER_NUMBER = /-?\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
const YEAR = /\b(?:19|20|21)\d{2}\b/g;
const COMMAND = /^(?:please\s+)?(accept|start|complete|dismiss|snooze|reopen)\b/i;
const CONFIRM = 'Nothing has changed yet. You can confirm this change below.';
const GOAL_COMMAND = /^(?:please\s+)?add (?:a |another |new |a new )?goal\s*[:,-]?\s*(\S[\s\S]*)$/i;
const GOAL_CONFIRM = 'Nothing is saved yet. You can save this goal below.';
const HORIZON_WORDS = [['1-3y', /next few years/i], ['3-10y', /long range|long term/i], ['now', /this year/i]];
const GOAL_AMOUNT = /\$(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/i;

// propose_goal args for an "add a goal" command in an Ask thread, else null.
function goalCommandOf(key, text) {
  if (!isThreadKey(key)) return null;
  const m = GOAL_COMMAND.exec(String(text ?? '').trim());
  if (!m) return null;
  const title = m[1].trim().slice(0, 120);
  const args = { title };
  const h = HORIZON_WORDS.find(([, re]) => re.test(title));
  if (h) args.horizon = h[0];
  const a = GOAL_AMOUNT.exec(title);
  if (a) args.target = Number(a[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[(a[2] || '').toLowerCase()] || 1);
  return args;
}

const stripTags = s => String(s ?? '').replace(/<[^>]*>/g, '').trim();
const list = v => (Array.isArray(v) ? v : []);

function whatIfParagraphs(scenario, pack) {
  const canned = list(pack.whatIf && pack.whatIf.a);
  if (canned.length) return canned;
  const name = resolveTokens(scenario, pack.name || pack.id, false);
  // Covers that carry a number other than a year are left out, so the sentence stays numberless.
  const covers = list(pack.covers).filter(c => typeof c === 'string' && !/\d/.test(c.replace(YEAR, '')));
  return [covers.length
    ? `The ${name} pack covers ${covers.join(', ')}. Ask about any of them for what it means for your household.`
    : `The ${name} pack has no scripted what-if answer. Ask a follow-up for what it means for your household.`];
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// { id, action } for an explicit command naming a rec, else null.
function commandOf(scenario, key, text) {
  const m = COMMAND.exec(String(text ?? '').trim());
  if (!m) return null;
  const action = m[1].toLowerCase();
  const own = recForKey(scenario, key);
  if (own) return { id: own.id, action };
  if (!isThreadKey(key)) return null;
  const lc = text.toLowerCase();
  const visible = list(scenario.recs).filter(r => r && r.status !== 'hidden');
  const hit = visible.find(r => new RegExp(`\\b${escapeRe(r.id.toLowerCase())}\\b`).test(lc))
    || visible.find(r => { const title = resolveTokens(scenario, r.title, false).trim().toLowerCase(); return title && lc.includes(title); });
  return hit ? { id: hit.id, action } : null;
}

export function fakeAnswerScript({ scenario, key, questionId, text, whatIfPack, summary, propose = false } = {}) {
  const command = propose && typeof text === 'string' ? commandOf(scenario, key, text) : null;
  const goal = propose && !command && typeof text === 'string' ? goalCommandOf(key, text) : null;
  let paragraphs;
  if (whatIfPack) {
    paragraphs = whatIfParagraphs(scenario, whatIfPack);
  } else if (questionId !== undefined && questionId !== null) {
    paragraphs = list(findQuestion(scenario, key, questionId)?.a);
  } else if (command) {
    paragraphs = [CONFIRM];
  } else if (goal) {
    paragraphs = [GOAL_CONFIRM];
  } else {
    paragraphs = list(matchQuestion(scenario, key, text)?.a);
  }
  if (!paragraphs.length) {
    const count = summary && Number.isFinite(summary.needsYouCount) ? summary.needsYouCount : null;
    paragraphs = [count === null
      ? 'From your household summary, the items that need you are on your plan.'
      : `From your household summary, ${count} items need you right now.`];
  }
  if (typeof text === 'string' && !goal) {
    const numbers = text.replace(YEAR, ' ').match(OWNER_NUMBER);
    if (numbers && numbers.length) paragraphs = [`You asked about ${[...new Set(numbers)].join(', ')}.`, ...paragraphs];
  }
  const body = paragraphs.map(stripTags).filter(Boolean).join('\n\n');
  const keys = [...new Set([...body.matchAll(FIGURE_TOKEN)].map(m => m[1]))];
  const toolCalls = [{ name: 'household_summary', args: {} }];
  if (keys.length) toolCalls.push({ name: 'get_figures', args: { keys } });
  if (recForKey(scenario, key)) toolCalls.push({ name: 'get_recommendation', args: { id: key } });
  if (command) toolCalls.push({ name: 'propose_recommendation_action', args: command });
  if (goal) toolCalls.push({ name: 'propose_goal', args: goal });
  return [{ toolCalls }, { text: body }];
}
