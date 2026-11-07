// Rec prose: the deterministic template, or model prose accepted only when it is JSON of the right
// shape, uses only the hit's allowed tokens, states no literal number (R15), passes the engine's
// grounding guard and passes the planner's stricter literal check (MG13, K5): outside tokens, a
// digit may appear only in a full date, "tax year YYYY" or an allowlisted plan identifier. Stored
// prose is reused while the grounding hash is unchanged and it still passes the same checks.
//
// groundingHash(hit, ctx) -> sha256 hex
// writeProse(hit, ctx, {engine, stored}) -> {fields: {summary, why, qa}, src, kept, hash, costUsd}
// checkProse(fields, allowed) -> {ok, reason?}

import { createHash } from 'node:crypto';
import { checkGrounding, EngineOffError, BudgetExceededError } from '../../engine/index.mjs';
import { esc, TOKEN } from '../../shared/tokens.mjs';
import { lawContent, pctContent } from './law.mjs';

export const TEMPLATE_VERSION = 1;

export const PROSE_SYSTEM = [
  'You rewrite one recommendation for a household financial co-pilot. Advisory only: never tell the household to file, move money automatically or buy a specific security.',
  'Write every amount, percent and name only as the tokens given in the input ({f:key}, {fk:key}, {l:key}, {p:key}, {n:key}). Never write a digit or a number word.',
  'The only digits you may write are in a full date (a month name or abbreviation and a day, optionally followed by a comma and a four-digit year, as in Jan 15, 2027), in "tax year" followed by a four-digit year, and in the plan names 401(k), 403(b), 457(b), 529 plan and Virginia529. Never write a year on its own or after any other word.',
  'Keep the facts of the draft; you may reword, reorder and clarify, but add no new claims.',
  'Return JSON only, with this shape: {"summary": string, "why": [1 to 4 strings], "qa": [0 to 4 {"q": string, "a": [1 to 3 strings]}]}.',
].join('\n');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const hitFigureKeys = hit => [...new Set([...hit.grounding, ...hit.rec.mine.map(m => m.fig)])].sort();

export function groundingHash(hit, ctx) {
  const figs = Object.fromEntries(hitFigureKeys(hit).map(k => [k, ctx.fig[k] ? ctx.fig[k].v : null]));
  const { grounding, ...vars } = hit.vars || {};
  void grounding;
  return createHash('sha256').update(stable({
    trigger: hit.trigger.id, version: TEMPLATE_VERSION, window: hit.window ? hit.window.close : null, figs, vars,
  })).digest('hex');
}

// Token scopes a hit's prose may use.
export function allowedFor(hit, ctx) {
  return {
    fig: Object.fromEntries(hitFigureKeys(hit).filter(k => ctx.fig[k]).map(k => [k, ctx.fig[k].v])),
    law: lawContent(),
    pct: pctContent(),
    names: { ...(ctx.names || {}) },
  };
}

const strings = fields => [fields.summary, ...fields.why, ...fields.qa.flatMap(x => [x.q, ...x.a])];

function shapeOk(f) {
  const str = s => typeof s === 'string' && s.trim().length > 0;
  return !!f && typeof f === 'object' && str(f.summary)
    && Array.isArray(f.why) && f.why.length >= 1 && f.why.length <= 4 && f.why.every(str)
    && Array.isArray(f.qa) && f.qa.length <= 4
    && f.qa.every(x => x && typeof x === 'object' && str(x.q) && Array.isArray(x.a) && x.a.length >= 1 && x.a.length <= 3 && x.a.every(str));
}

// The planner-side literal check (R2-7, R3-8, D5, K5) is an allowlist. After tokens are removed,
// only these forms are blanked: a full date (month name or abbreviation, a day with an optional
// ordinal suffix, then an optional comma and four-digit year), "tax year YYYY", and the plan
// identifiers 401(k), 403(b), 457(b), "529 plan" and Virginia529. Any digit left fails, so a year
// outside those forms (for example "in 2026") never passes, whatever words surround it.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const YEAR = '20\\d{2}';
const ALLOWED_FORMS = [
  new RegExp(`\\b${MONTH}\\.? (?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,? ${YEAR})?(?![\\d\\w])`, 'gi'),
  new RegExp(`\\btax year ${YEAR}(?![\\d\\w])`, 'gi'),
  /\b(?:401\(k\)|403\(b\)|457\(b\))(?![\d\w])/gi,
  /\b529 plan(?![\d\w])/gi,
  /\bVirginia529(?![\d\w])/gi,
];

export function plannerLiteralFree(text) {
  let s = String(text).replace(TOKEN, m => ' '.repeat(m.length));
  for (const re of ALLOWED_FORMS) s = s.replace(re, m => ' '.repeat(m.length));
  return !/\d/.test(s);
}

export function checkProse(fields, allowed) {
  if (!shapeOk(fields)) return { ok: false, reason: 'shape' };
  const scope = { f: allowed.fig, fk: allowed.fig, l: allowed.law, p: allowed.pct, n: allowed.names };
  const tokenOnly = {};
  for (const s of Object.values(scope)) for (const k of Object.keys(s || {})) tokenOnly[k] = 'token';
  for (const text of strings(fields)) {
    for (const [, type, key] of text.matchAll(TOKEN)) {
      if (!scope[type] || !Object.hasOwn(scope[type], key)) return { ok: false, reason: 'token' };
    }
    if (/\{(?:f|fk|l|p|n):/.test(text.replace(TOKEN, ''))) return { ok: false, reason: 'token' };
    if (!checkGrounding(text, { figures: tokenOnly }).ok) return { ok: false, reason: 'literal' };
    if (!plannerLiteralFree(text)) return { ok: false, reason: 'literal' };
  }
  return { ok: true };
}

const escapeFields = f => ({
  summary: esc(f.summary),
  why: f.why.map(esc),
  qa: f.qa.map(x => ({ q: esc(x.q), a: x.a.map(esc) })),
});

const pickFields = f => ({ summary: f.summary, why: f.why, qa: f.qa });

// Stored prose back to the plain text the checks read (model prose is stored escaped once).
const unescapeText = v => String(v).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const storedFields = def => ({
  summary: unescapeText(def.summary),
  why: Array.isArray(def.why) ? def.why.map(unescapeText) : [],
  qa: Array.isArray(def.qa) ? def.qa.map(x => ({ q: unescapeText(x && x.q), a: Array.isArray(x && x.a) ? x.a.map(unescapeText) : [] })) : [],
});

export async function writeProse(hit, ctx, { engine = null, stored = null } = {}) {
  const hash = groundingHash(hit, ctx);
  if (hit.rec.question?.primary) {
    const draft = hit.trigger.template(ctx, hit.vars);
    const fields = { ...draft, summary: hit.rec.question.summary };
    const kept = stored?.hash === hash && stored.src === 'template' && stable(pickFields(stored.def)) === stable(fields);
    return { fields, src: 'template', kept, hash, costUsd: 0 };
  }
  // R2-7: stored prose is reused only while it still passes today's checks, whatever its source.
  if (stored && stored.hash === hash && stored.def && typeof stored.def.summary === 'string'
    && checkProse(storedFields(stored.def), allowedFor(hit, ctx)).ok) {
    return { fields: { summary: stored.def.summary, why: stored.def.why || [], qa: stored.def.qa || [] }, src: stored.src, kept: true, hash, costUsd: 0 };
  }
  const draft = hit.trigger.template(ctx, hit.vars);
  let costUsd = 0;
  if (engine && typeof engine.call === 'function' && !ctx.engineStopped) {
    const allowed = allowedFor(hit, ctx);
    const figures = Object.fromEntries(Object.keys(allowed.fig).map(k => [k, { label: ctx.fig[k].label, kind: ctx.fig[k].kind, v: ctx.fig[k].v }]));
    const grounding = { ...allowed.fig, ...allowed.law, ...allowed.pct, ...allowed.names };
    try {
      const response = await engine.call({
        purpose: 'job',
        system: PROSE_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({
          rec: { title: hit.rec.title, triggerText: hit.rec.triggerText, window: hit.window ? hit.window.label : null, domain: hit.rec.domain },
          figures, law: allowed.law, pct: allowed.pct, names: allowed.names, draft,
        }) }],
        maxTokens: 1500,
        grounding: { figures: grounding },
      });
      if (response && Number.isFinite(response.costUsd)) costUsd += response.costUsd;
      let parsed = null;
      try { parsed = JSON.parse(String(response.text ?? '').trim()); } catch { parsed = null; }
      if (parsed && response.grounding && response.grounding.ok && checkProse(parsed, allowed).ok) {
        return { fields: escapeFields(pickFields(parsed)), src: 'model', kept: false, hash, costUsd };
      }
    } catch (e) {
      if (e instanceof EngineOffError || e instanceof BudgetExceededError) ctx.engineStopped = true;
    }
  }
  return { fields: pickFields(draft), src: 'template', kept: false, hash, costUsd };
}
