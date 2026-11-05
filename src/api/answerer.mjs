// Ask seam: the canned answerer. The ask endpoint calls answer() only while the engine is on;
// a later item swaps this for the live engine with the same interface.
//
// answer({ db, key, questionId?, text? }) -> { paragraphs: [token-bearing strings], refs: [recId], notice? }
// or null when questionId names no canned question.

import { buildScenario } from '../scenario/build.mjs';
import { findQuestion, matchQuestion } from './questions.mjs';

const DEFAULT_FALLBACK = ['I do not have an answer for that yet.'];

export function createCannedAnswerer() {
  return {
    answer({ db, key = 'ask', questionId, text }) {
      const scenario = buildScenario(db);
      if (questionId !== undefined && questionId !== null) {
        const q = findQuestion(scenario, key, questionId);
        return q ? { paragraphs: q.a, refs: q.refs } : null;
      }
      const hit = matchQuestion(scenario, key, text);
      if (hit) return { paragraphs: hit.a, refs: hit.refs };
      const fallback = scenario.ask && Array.isArray(scenario.ask.fallback) && scenario.ask.fallback.length
        ? scenario.ask.fallback : DEFAULT_FALLBACK;
      return { paragraphs: fallback, refs: [] };
    },
  };
}
