// Rec steps. A step the product can verify names what it checks: `fact` (done once that fact is
// answered) or `code` (done once the missing-data item with that code is no longer open in the
// planner's latest run). Its state is derived from stored data on read, never from a checkbox.
// Every other step is one the owner reports with "I did this": a flag in recs.tasks_done, with its
// time and actor in rec_events ('step_did' and 'step_undo', arg the step text), undone the same way.
//
// isVerifiable(task) -> boolean
// stepKey(task) -> a stable identity for a step across planner runs
// checkCleared(task, env) -> whether a verifiable step's condition has cleared
// deriveSteps(tasks, done, env) -> [{...task, kind, auto, done, doneAt?, doneBy?}]
//   env: {facts, accounts, open: codes still open or null when no run stored them, marks: Map of
//   step text -> latest {action, ts, actor}}

import { questionFor } from '../jobs/triggers/common.mjs';

export const isVerifiable = t => !!t && (typeof t.fact === 'string' || typeof t.code === 'string');
export const stepKey = t => (typeof t.fact === 'string' ? `fact:${t.fact}` : typeof t.code === 'string' ? `code:${t.code}` : `t:${t.t}`);

export function checkCleared(t, { facts = {}, accounts = [], open = null } = {}) {
  if (typeof t.fact === 'string') {
    try { return !!questionFor([t.fact], { accounts, facts }).answered; } catch { return false; }
  }
  if (typeof t.code === 'string') return Array.isArray(open) && !open.includes(t.code);
  return false;
}

export function deriveSteps(tasks, done, env = {}) {
  return (Array.isArray(tasks) ? tasks : []).map((t, i) => {
    if (isVerifiable(t)) return { ...t, auto: true, done: checkCleared(t, env) };
    const { done: _seed, ...rest } = t;
    const on = !!(Array.isArray(done) && done[i]);
    const mark = on ? env.marks?.get(t.t) : null;
    return { ...rest, kind: 'manual', auto: false, done: on, ...(mark?.action === 'step_did' ? { doneAt: mark.ts, doneBy: mark.actor } : {}) };
  });
}

// Verifiable steps a planner run dropped because their condition cleared, kept after the current
// ones so the owner sees them done until the rec itself retires.
export function withClearedSteps(tasks, oldTasks, env) {
  const keys = new Set(tasks.map(stepKey));
  const kept = (Array.isArray(oldTasks) ? oldTasks : []).filter(t => isVerifiable(t) && !keys.has(stepKey(t)) && checkCleared(t, env));
  return kept.length ? [...tasks, ...kept] : tasks;
}
