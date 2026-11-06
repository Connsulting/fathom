// The canned question catalog the UI offers as chips: a rec's own follow-ups (rec.qa) in a thread
// asked from a rec, the suggested Ask questions everywhere else. Used by the ask endpoint to word
// the owner's question, and by the fake answer source to script deterministic answers.

import { resolveTokens } from '../shared/tokens.mjs';
import { THREAD_KEY } from '../scenario/build.mjs';

const arr = v => (Array.isArray(v) ? v : []);
// A non-negative integer, or a string of digits.
export const isIndex = v => (Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));

// An Ask thread key ('ask:<12 hex>'); the only other conversation key is 'pack:<id>'.
export const isThreadKey = key => typeof key === 'string' && THREAD_KEY.test(key);

// The rec context of a conversation key: a rec id resolves to that rec (POST /api/threads with
// recId looks questions up before the thread exists); an Ask thread resolves to the rec its recId
// names in scenario.live.threads. Null for a thread with no rec or whose rec is gone, a pack
// conversation and an unknown key. The answerer, findQuestion, matchQuestion and the fake answer
// source all read rec context through this one lookup.
export function recForKey(scenario, key) {
  const recs = arr(scenario.recs);
  if (isThreadKey(key)) {
    const thread = arr(scenario.live && scenario.live.threads).find(t => t && t.key === key);
    const recId = thread && thread.recId;
    return recId ? recs.find(r => r.id === recId) || null : null;
  }
  return recs.find(r => r.id === key) || null;
}

// { q, a, refs } for a question id (or index, or exact question) in conversation `key`.
export function findQuestion(scenario, key, questionId) {
  const rec = recForKey(scenario, key);
  const qid = typeof questionId === 'number' ? questionId : String(questionId);
  if (rec) {
    const qa = arr(rec.qa);
    const hit = (isIndex(qid) ? qa[Number(qid)] : null) || qa.find(x => x && (x.id === qid || x.q === qid));
    return hit ? { q: hit.q, a: arr(hit.a), refs: [rec.id] } : null;
  }
  const sug = arr(scenario.ask && scenario.ask.suggested);
  const hit = sug.find(x => x && x.id === qid) || (isIndex(qid) ? sug[Number(qid)] : null);
  return hit ? { q: hit.q, a: arr(hit.a), refs: arr(hit.refs) } : null;
}

// Free text that exactly matches a canned question (tokens resolved, trimmed, case-insensitive):
// the rec's own follow-ups first, then the suggested Ask questions. Null when nothing matches.
export function matchQuestion(scenario, key, text) {
  const lc = String(text == null ? '' : text).trim().toLowerCase();
  if (!lc) return null;
  const same = x => x && resolveTokens(scenario, x.q, false).trim().toLowerCase() === lc;
  const rec = recForKey(scenario, key);
  if (rec) {
    const own = arr(rec.qa).find(same);
    if (own) return { q: own.q, a: arr(own.a), refs: [rec.id] };
  }
  const sug = arr(scenario.ask && scenario.ask.suggested).find(same);
  return sug ? { q: sug.q, a: arr(sug.a), refs: arr(sug.refs) } : null;
}
