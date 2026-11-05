// Deterministic fake answer source for FATHOM_ENGINE=fake (the demo and the tests). It scripts
// the two rounds a live model would run: one tool round that reads the household summary, the
// figures its answer cites and the conversation's recommendation, then one text round.
//
// fakeAnswerScript({ scenario, key, questionId, text, whatIfPack, summary }) -> [round1, round2]
// The text round is the canned demo answer for a suggested or rec question (by id or by exact
// free text), the pack's canned what-if answer, or a summary sentence whose number comes from the
// household_summary result. Numbers in the owner's free text are echoed back, so an invented
// amount reaches grounding the way a careless model would repeat it.

import { findQuestion, matchQuestion, recForKey } from './questions.mjs';
import { resolveTokens } from '../shared/tokens.mjs';

const FIGURE_TOKEN = /\{(?:fk|f):([A-Za-z0-9_.-]+)\}/g;
const OWNER_NUMBER = /-?\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
const YEAR = /\b(?:19|20|21)\d{2}\b/g;

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

export function fakeAnswerScript({ scenario, key = 'ask', questionId, text, whatIfPack, summary } = {}) {
  let paragraphs;
  if (whatIfPack) {
    paragraphs = whatIfParagraphs(scenario, whatIfPack);
  } else if (questionId !== undefined && questionId !== null) {
    paragraphs = list(findQuestion(scenario, key, questionId)?.a);
  } else {
    paragraphs = list(matchQuestion(scenario, key, text)?.a);
  }
  if (!paragraphs.length) {
    const count = summary && Number.isFinite(summary.needsYouCount) ? summary.needsYouCount : null;
    paragraphs = [count === null
      ? 'From your household summary, the items that need you are on your plan.'
      : `From your household summary, ${count} items need you right now.`];
  }
  if (typeof text === 'string') {
    const numbers = text.replace(YEAR, ' ').match(OWNER_NUMBER);
    if (numbers && numbers.length) paragraphs = [`You asked about ${[...new Set(numbers)].join(', ')}.`, ...paragraphs];
  }
  const body = paragraphs.map(stripTags).filter(Boolean).join('\n\n');
  const keys = [...new Set([...body.matchAll(FIGURE_TOKEN)].map(m => m[1]))];
  const toolCalls = [{ name: 'household_summary', args: {} }];
  if (keys.length) toolCalls.push({ name: 'get_figures', args: { keys } });
  if (recForKey(scenario, key)) toolCalls.push({ name: 'get_recommendation', args: { id: key } });
  return [{ toolCalls }, { text: body }];
}
