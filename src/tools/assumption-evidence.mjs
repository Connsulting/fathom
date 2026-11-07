// Named assumptions (section 3, Provenance and Figure references rules 5 and 6). A literal number
// enters a calculation only as an Assumption with a source, and checkAssumption proves the source:
// a stored fact holds the value, a saved preference states it, the operation documents it as its
// default, or the owner said it. Owner words are checked with assumptionStated, which normalizes
// by unit (so "4 percent" states a rate of 0.04), not with requireEvidence's bare-number match.
import { parseJson } from '../store/db.mjs';
import { statedAmounts } from '../actions/evidence.mjs';
import { quoteFor, UNITS } from '../calc/figure.mjs';
import { ToolError } from './errors.mjs';

export const SOURCES = Object.freeze(['owner', 'preference', 'fact', 'default']);
const MONEY = new Set(['usd', 'usd_per_month', 'usd_per_year']);
const KEYS = new Set(['value', 'source', 'evidence', 'factKey', 'preferenceId', 'note']);

// A number standing on its own: not glued to a word, a decimal point, a comma group or a currency
// sign, so "$1,000" never yields 000 and "3-4 percent" never yields minus 4.
const RATIO = /(?<![\w.,$-])(minus\s+|-)?(\d+(?:\.\d+)?|\.\d+)(?![\d.])\s*(%|percent\b|per\s*cent\b|pct\b)?/gi;
const AGE = /(?<![\w.,$-])(\d+(?:\.\d+)?)(?![\d.])(\s+and\s+a\s+half\b)?/gi;
const ISO = /\b\d{4}-\d{2}-\d{2}\b/g;

// The values a text states in `unit`, deterministic:
// ratio: a number followed by %, percent, per cent or pct (optional space) is that number over 100;
//   a bare decimal below 1 ("0.04") is itself; any other bare number states no rate.
// usd, usd_per_month, usd_per_year, months, days, count: statedAmounts ($, commas, k, thousand, m,
//   million), to the cent.
// age, years: a whole or half number ("59 and a half", "59.5").
// date: the ISO dates in the text.
export function statedValues(text, unit) {
  const s = String(text ?? '');
  if (unit === 'ratio') {
    const out = [];
    for (const m of s.matchAll(RATIO)) {
      const n = (m[1] ? -1 : 1) * Number(m[2]);
      if (m[3]) out.push(n / 100);
      else if (Math.abs(n) < 1) out.push(n);
    }
    return out;
  }
  if (unit === 'age' || unit === 'years') {
    return [...s.matchAll(AGE)].map(m => Number(m[1]) + (m[2] ? 0.5 : 0)).filter(n => Number.isInteger(n * 2));
  }
  if (unit === 'date') return [...s.matchAll(ISO)].map(m => m[0]);
  return statedAmounts(s);
}

function same(stated, value, unit) {
  if (unit === 'ratio') return Math.abs(stated - value) <= 1e-9;
  if (MONEY.has(unit)) return Math.round(stated * 100) === Math.round(value * 100);
  return stated === value;
}

// True when any statement states `value` in `unit` (see statedValues).
export function assumptionStated(value, unit, statements) {
  if (unit === 'age' || unit === 'years') { if (!Number.isInteger(value * 2)) return false; }
  return (statements || []).some(text => statedValues(text, unit).some(stated => same(stated, value, unit)));
}

// The assumption as text, so it can ground: "4%", "$1,000 a month", "10 years". Money keeps its sign.
export function statedText(value, unit) {
  const quote = quoteFor(value, unit);
  return MONEY.has(unit) && value < 0 ? `-${quote}` : quote;
}

const squash = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

function ownerWords(assumption, path, ctx) {
  const { value, evidence } = assumption;
  if (typeof evidence !== 'string' || !evidence.trim()) {
    throw new ToolError('bad_input', `${path}: source owner needs evidence, the owner's own words that state the value.`);
  }
  if (evidence.length > 500) throw new ToolError('bad_input', `${path}.evidence is too long`);
  if (ctx?.channel !== 'mcp') {
    // Ask: the evidence must be the owner's words in this conversation. Without the conversation's
    // statements there is nothing to check against, so the owner source is refused.
    if (typeof ctx?.ownerStatements !== 'function') {
      throw new ToolError('bad_input', `${path}: an owner assumption needs the owner's messages in this conversation, which are not available here. Ask the owner, or use a fact, preference or default.`);
    }
    const statements = ctx.ownerStatements() || [];
    if (!statements.some(text => squash(text).includes(squash(evidence)))) {
      throw new ToolError('bad_input', `${path}: the evidence is not in the owner's messages of this conversation. Quote the owner's exact words.`);
    }
  }
  return evidence;
}

// Validate one Assumption passed for parameter `name` in `unit` and return its provenance record
// { name, value, unit, source, stated, note?, evidence?, factKey?, preferenceId? }.
// spec: { name, unit, default?, min?, max?, path? }. Every refusal is bad_input naming the path.
export function checkAssumption(assumption, { name, unit, default: fallback, min, max, path = name }, ctx) {
  if (!UNITS.includes(unit)) throw new ToolError('bad_input', `${path}: unknown unit ${unit}`);
  if (!assumption || typeof assumption !== 'object' || Array.isArray(assumption)) throw new ToolError('bad_input', `${path} must be an assumption object`);
  for (const key of Object.keys(assumption)) if (!KEYS.has(key)) throw new ToolError('bad_input', `${path}.${key} is not a known assumption field`);
  const { value, source, note } = assumption;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolError('bad_input', `${path}.value must be a finite number`);
  if (!SOURCES.includes(source)) throw new ToolError('bad_input', `${path}.source must be one of ${SOURCES.join(', ')}`);
  if (note !== undefined && (typeof note !== 'string' || note.length > 200)) throw new ToolError('bad_input', `${path}.note must be text of at most 200 characters`);
  if (min !== undefined && value < min) throw new ToolError('bad_input', `${path}.value must be at least ${min}`);
  if (max !== undefined && value > max) throw new ToolError('bad_input', `${path}.value must be at most ${max}`);
  for (const [key, needed] of [['evidence', 'owner'], ['factKey', 'fact'], ['preferenceId', 'preference']]) {
    if (assumption[key] !== undefined && source !== needed) throw new ToolError('bad_input', `${path}.${key} applies only to source ${needed}`);
  }
  const record = { name, value, unit, source, stated: statedText(value, unit), ...(note === undefined ? {} : { note }) };

  if (source === 'owner') {
    record.evidence = ownerWords(assumption, path, ctx);
    if (!assumptionStated(value, unit, [record.evidence])) {
      throw new ToolError('bad_input', `${path}: the owner's words "${record.evidence}" do not state ${record.stated}.`);
    }
  } else if (source === 'fact') {
    const { factKey } = assumption;
    if (typeof factKey !== 'string' || !factKey) throw new ToolError('bad_input', `${path}: source fact needs factKey`);
    const row = ctx?.db?.prepare('SELECT value FROM facts WHERE key = ?').get(factKey);
    if (!row) throw new ToolError('bad_input', `${path}: no stored fact ${factKey}`);
    const stored = Number(parseJson(row.value, row.value));
    if (!Number.isFinite(stored) || !same(stored, value, unit)) {
      throw new ToolError('bad_input', `${path}: the stored fact ${factKey} does not hold ${record.stated}`);
    }
    record.factKey = factKey;
  } else if (source === 'preference') {
    const { preferenceId } = assumption;
    if (typeof preferenceId !== 'string' || !preferenceId) throw new ToolError('bad_input', `${path}: source preference needs preferenceId`);
    const row = ctx?.db?.prepare('SELECT text FROM preferences WHERE id = ?').get(preferenceId);
    if (!row) throw new ToolError('bad_input', `${path}: no saved preference ${preferenceId}`);
    if (!assumptionStated(value, unit, [row.text])) throw new ToolError('bad_input', `${path}: the saved preference ${preferenceId} does not state ${record.stated}`);
    record.preferenceId = preferenceId;
  } else if (fallback === undefined) {
    throw new ToolError('bad_input', `${path}: this value has no documented default; pass it with source owner, fact or preference`);
  } else if (!same(value, fallback, unit)) {
    throw new ToolError('bad_input', `${path}: source default needs the documented default ${statedText(fallback, unit)}; omit the argument to use it`);
  }
  return record;
}
