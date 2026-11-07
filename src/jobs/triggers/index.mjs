// The trigger catalog, in order. A trigger with needsYear does not apply without a planning tax
// year. A trigger hits when its gate holds over the facts, its window has
// not closed, and evaluate(ctx) returns hit vars. evaluate may also return {blocked: reason} when a
// figure it needs could not be computed, and a null evaluation after one of the trigger's
// calculators threw is blocked as calc_failed; missing-data runs last and lists those reasons.
//
// evaluateCatalog(ctx) -> [{trigger, state: 'hit'|'blocked'|'none', hit?, reason?, closed?}]
// evaluateTriggers(ctx) -> hits only: [{trigger, rec, window, grounding, packId, vars}]

import { evaluate as evaluateRule } from '../../packs/index.mjs';
import { kbExcerpt } from '../planner/kb.mjs';
import * as fedQ4 from './fed-q4-estimate.mjs';
import * as vaQ4 from './va-q4-estimate.mjs';
import * as yearEndRetirement from './year-end-retirement.mjs';
import * as solo401kSetup from './solo401k-setup.mjs';
import * as scorpSalary from './scorp-salary.mjs';
import * as invoiceDeferral from './invoice-deferral.mjs';
import * as hsaRoom from './hsa-room.mjs';
import * as va529 from './va529.mjs';
import * as charitableBunching from './charitable-bunching.mjs';
import * as backdoorRoth from './backdoor-roth.mjs';
import * as dependentCareFsa from './dependent-care-fsa.mjs';
import * as newChild from './new-child.mjs';
import * as missingData from './missing-data.mjs';
import { questionFor, dataText } from './common.mjs';

export const triggers = Object.freeze([
  fedQ4, vaQ4, yearEndRetirement, solo401kSetup, scorpSalary, invoiceDeferral, hsaRoom, va529,
  charitableBunching, backdoorRoth, dependentCareFsa, newChild, missingData,
]);

export function triggerText(t, window) {
  if (!window) return t.trigger === 'life' ? 'Life event' : 'Ongoing';
  return window.hard ? `Hard deadline: ${window.label}` : `Before ${window.label}`;
}

function excerpts(ctx, t) {
  const loaded = new Set((ctx.packs || []).map(p => p.id));
  return t.kb.filter(k => loaded.has(k.pack)).map(k => kbExcerpt(ctx.packs, k.pack, k.entry)).filter(Boolean);
}

// The CONTRACT rec without prose (summary, why, qa come from prose.mjs), plus the trigger's goal
// kinds and default action owner (ownerFor when the owner depends on the household). Both are
// stored in recs columns, not in the def.
function recOf(ctx, t, hit, window) {
  const b = t.build(ctx, hit);
  const rec = {
    id: t.id, title: b.title, trigger: t.trigger, triggerText: b.triggerText || triggerText(t, window), domain: t.domain,
    effort: b.effort, advisor: null, value: b.value, mine: b.mine, kb: excerpts(ctx, t), cross: (b.cross || []).slice(0, 2), tasks: b.tasks,
    goalKinds: [...t.goalKinds], owner: typeof t.ownerFor === 'function' ? t.ownerFor(ctx, hit) : t.owner,
  };
  if (b.scenario) rec.scenario = b.scenario;
  const questions = hit.confirm || hit.questions || (hit.catchUpPending ? [hit.catchUpPending] : []);
  if (questions.length) {
    const primary = !!hit.confirm?.length;
    const people = ['year-end-retirement', 'scorp-salary'].includes(t.id) && ctx.info.solo?.person ? [ctx.info.solo.person] : undefined;
    rec.question = { ...questionFor(questions, { accounts: ctx.data?.accounts || [], facts: ctx.facts, names: ctx.names, people }), primary };
    if (primary) {
      rec.title = dataText(rec.question.title);
      rec.tasks = [];
    }
  }
  return rec;
}

export function evaluateCatalog(ctx) {
  ctx.blockedReasons = [];
  ctx.questionKeys = new Set();
  const failed = new Set((ctx.info && ctx.info.calcFailed) || []);
  const results = [];
  for (const t of triggers) {
    if (!evaluateRule(t.gate, ctx.facts)) { results.push({ trigger: t, state: 'none' }); continue; }
    // A trigger that needs the planning tax year does not apply without one (R10).
    if (t.needsYear && !ctx.year) { results.push({ trigger: t, state: 'none' }); continue; }
    const window = t.window(ctx);
    if (window && window.close < ctx.clock) { results.push({ trigger: t, state: 'none', closed: true }); continue; }
    const out = t.evaluate(ctx);
    // A calculator that threw is missing data, not a closed condition (R14, S12).
    if (!out && t.calcs.some(c => failed.has(c))) {
      ctx.blockedReasons.push({ id: t.id, reason: 'calc_failed' });
      results.push({ trigger: t, state: 'blocked', reason: 'calc_failed', blocker: missingData.blockerOf(ctx, 'calc_failed') });
      continue;
    }
    if (!out) { results.push({ trigger: t, state: 'none' }); continue; }
    if (out.blocked) {
      ctx.blockedReasons.push({ id: t.id, reason: out.blocked });
      results.push({ trigger: t, state: 'blocked', reason: out.blocked, blocker: missingData.blockerOf(ctx, out.blocked) });
      continue;
    }
    const { grounding = [], ...vars } = out;
    const hit = { grounding: grounding.filter(k => k && ctx.fig[k]), ...vars };
    const rec = recOf(ctx, t, hit, window);
    for (const key of rec.question?.keys || []) ctx.questionKeys.add(key);
    const packId = t.packs.find(p => ctx.packStatus[p] === 'active') || null;
    results.push({ trigger: t, state: 'hit', hit: { trigger: t, rec, window, grounding: hit.grounding, packId, vars: hit } });
  }
  return results;
}

export function evaluateTriggers(ctx) {
  return evaluateCatalog(ctx).filter(r => r.state === 'hit').map(r => r.hit);
}
