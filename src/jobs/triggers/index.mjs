// The trigger catalog, in order. A trigger hits when its gate holds over the facts, its window has
// not closed, and evaluate(ctx) returns hit vars. evaluate may also return {blocked: reason} when a
// figure it needs could not be computed; missing-data runs last and lists those reasons.
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

// The CONTRACT rec without prose (summary, why, qa come from prose.mjs).
function recOf(ctx, t, hit, window) {
  const b = t.build(ctx, hit);
  const rec = {
    id: t.id, title: b.title, trigger: t.trigger, triggerText: b.triggerText || triggerText(t, window), domain: t.domain,
    effort: b.effort, advisor: null, value: b.value, mine: b.mine, kb: excerpts(ctx, t), cross: (b.cross || []).slice(0, 2), tasks: b.tasks,
  };
  if (b.scenario) rec.scenario = b.scenario;
  return rec;
}

export function evaluateCatalog(ctx) {
  ctx.blockedReasons = [];
  const results = [];
  for (const t of triggers) {
    if (!evaluateRule(t.gate, ctx.facts)) { results.push({ trigger: t, state: 'none' }); continue; }
    const window = t.window(ctx);
    if (window && window.close < ctx.clock) { results.push({ trigger: t, state: 'none', closed: true }); continue; }
    const out = t.evaluate(ctx);
    if (!out) { results.push({ trigger: t, state: 'none' }); continue; }
    if (out.blocked) {
      ctx.blockedReasons.push({ id: t.id, reason: out.blocked });
      results.push({ trigger: t, state: 'blocked', reason: out.blocked });
      continue;
    }
    const { grounding = [], ...vars } = out;
    const hit = { grounding: grounding.filter(k => k && ctx.fig[k]), ...vars };
    const rec = recOf(ctx, t, hit, window);
    const packId = t.packs.find(p => ctx.packStatus[p] === 'active') || null;
    results.push({ trigger: t, state: 'hit', hit: { trigger: t, rec, window, grounding: hit.grounding, packId, vars: hit } });
  }
  return results;
}

export function evaluateTriggers(ctx) {
  return evaluateCatalog(ctx).filter(r => r.state === 'hit').map(r => r.hit);
}
