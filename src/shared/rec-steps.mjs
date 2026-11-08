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

const CONFIRM_KINDS = Object.freeze({
  w2_recipient_unknown: ['employer_recipient', 'document_recipient'],
  payroll_recipient_conflict: ['document_recipient', 'employer_recipient'],
  employer_relation_pending: ['employer_relation'],
  w2_correction_pending: ['withholding_conflict'],
  w2_correction_conflicting: ['withholding_conflict'],
  withholding_recipient_unknown: ['employer_recipient', 'document_recipient'],
  withholding_conflict_pending: ['withholding_conflict'],
  tax_year_unconfirmed: ['tax_year'],
});

export function confirmItemFor(code = '', items = []) {
  const pending = items.filter(item => item.status === 'pending');
  if (code.startsWith('entity_unclassified:')) {
    return pending.find(item => item.kind === 'fact_check' && item.context?.src === 'ledger-confirm');
  }
  return pending.find(item => CONFIRM_KINDS[code]?.includes(item.kind));
}

export const isVerifiable = t => !!t && (typeof t.fact === 'string' || typeof t.code === 'string' || !!t.payment);
export const stepKey = t => (t.payment ? `payment:${t.t}:${JSON.stringify(t.payment)}` : typeof t.fact === 'string' ? `fact:${t.fact}` : typeof t.code === 'string' ? `code:${t.code}` : `t:${t.t}`);

function paymentEvidence(t, env) {
  if (!t.payment || !Number.isFinite(t.payment.amount) || t.payment.amount <= 0) return null;
  const j = value => /^(va|virginia|state)$/i.test(value) ? 'state' : value;
  const matches = (env.payments ?? []).filter(p => j(p.jurisdiction) === j(t.payment.jurisdiction)
    && p.taxYear === t.payment.taxYear && p.quarter === t.payment.quarter
    && Math.round(p.amount * 100) === Math.round(t.payment.amount * 100));
  return matches.length === 1 ? matches[0] : null;
}

export function checkCleared(t, env = {}) {
  const { facts = {}, accounts = [], open = null } = env;
  if (t.payment) return !!paymentEvidence(t, env);
  if (typeof t.fact === 'string') {
    try { return !!questionFor([t.fact], { accounts, facts }).answered; } catch { return false; }
  }
  if (typeof t.code === 'string') return Array.isArray(open) && !open.includes(t.code);
  return false;
}

export function deriveSteps(tasks, done, env = {}) {
  return (Array.isArray(tasks) ? tasks : []).map((t, i) => {
    const observed = paymentEvidence(t, env);
    if (observed) return { ...t, auto: true, done: true, doneAt: observed.date, evidence: observed.evidence };
    if (t.payment) {
      const { evidence: _evidence, doneAt: _doneAt, doneBy: _doneBy, ...rest } = t;
      const on = !!(Array.isArray(done) && done[i]);
      const mark = on ? env.marks?.get(t.t) : null;
      return { ...rest, auto: false, done: on, ...(mark?.action === 'step_did' ? { doneAt: mark.ts, doneBy: mark.actor } : {}) };
    }
    if (isVerifiable(t)) {
      if (t.kind === 'confirm') {
        const { confirmId: _stored, ...rest } = t;
        const target = t.confirmId == null
          ? confirmItemFor(t.code, env.confirm)
          : (env.confirm ?? []).find(item => item.id === t.confirmId && item.status === 'pending');
        const confirmId = target?.id;
        return { ...rest, ...(confirmId ? { confirmId } : {}), link: confirmId ? 'confirm' : 'ask', auto: true, done: checkCleared(t, env) };
      }
      return { ...t, auto: true, done: checkCleared(t, env) };
    }
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
