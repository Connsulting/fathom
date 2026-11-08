import { parseJson as parse } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { checkGrounding } from '../engine/grounding.mjs';

const AMOUNT = /\$?(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/gi;
export function statedAmounts(text) {
  return [...String(text ?? '').matchAll(AMOUNT)].map(m => Math.round(Number(m[1].replace(/,/g, ''))
    * ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[(m[2] || '').toLowerCase()] || 1) * 100) / 100);
}

export function ownerStatements(ctx) {
  const out = ctx.ownerText ? [ctx.ownerText] : [];
  if (!ctx.conversationKey || !ctx.actorId) return out;
  for (const row of ctx.db.prepare("SELECT text, provenance FROM messages WHERE conversation_key = ? AND role = 'me'").all(ctx.conversationKey)) {
    const input = parse(row.provenance, null)?.ownerInput;
    if (input?.actorId === ctx.actorId) {
      const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#123;': '{', '&#125;': '}' };
      out.push(row.text.replace(/&(?:amp|lt|gt|quot|#39|#123|#125);/g, m => entities[m]));
    }
  }
  return out;
}

function dates(text) {
  const out = [...String(text).matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m => m[0]);
  for (const m of String(text).matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\b/gi)) {
    const t = Date.parse(m[0].replace(/(\d)(st|nd|rd|th)/i, '$1') + ' UTC');
    if (Number.isFinite(t)) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function stated(value, text, shape) {
  if (value === null) return /\b(clear|remove|unset|no target|no date)\b/i.test(text);
  if (typeof value === 'number') return statedAmounts(text).includes(value);
  if (typeof value === 'boolean') {
    if (new RegExp(`\\b${value}\\b`, 'i').test(text)) return true;
    const yes = /\byes\b/i.test(text), no = /\bno\b/i.test(text);
    return value ? yes && !no : no && !yes;
  }
  if (shape?.type === 'choice') {
    if (shape.ownerInterpreted === true && typeof value === 'string') return shape.choices.some(c => c.value === value);
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = shape.choices.filter(c => [c.value, c.label].some(label => new RegExp(`\\b${escape(label)}\\b`, 'i').test(text)));
    return matches.length === 1 && matches[0].value === value;
  }
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? dates(text).includes(value) : text.toLowerCase().includes(value.toLowerCase());
  if (shape?.type === 'map' && value && typeof value === 'object') return Object.entries(value).every(([k, v]) => text.toLowerCase().includes(k.toLowerCase()) && stated(v, text, shape.values));
  if (value && typeof value === 'object') return Object.entries(value).every(([k, v]) => stated(v, text, shape?.fields?.[k]));
  return false;
}

function householdValues(db) {
  const values = [];
  const add = value => {
    if (value == null) return;
    values.push(value);
    if (typeof value === 'object') Object.values(value).forEach(add);
  };
  db.prepare('SELECT value FROM facts').all().forEach(r => add(parse(r.value, null)));
  values.push(...db.prepare('SELECT v FROM figures WHERE unavailable_reason IS NULL').all().map(r => r.v));
  for (const row of db.prepare('SELECT def FROM goals').all()) {
    const def = parse(row.def, {});
    for (const k of ['title', 'note', 'target', 'targetLow', 'targetHigh', 'floor', 'taxYear', 'targetDate', 'split', 'entered']) add(def[k]);
  }
  return values;
}

const goalTextStates = (value, text, shape) => typeof value === 'number'
  ? statedAmounts(text).includes(value) && checkGrounding(`$${value}`, { data: [text] }).ok : stated(value, text, shape);

const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|do it|go ahead|absolutely|correct|confirmed)\b/i;
const HEDGE = /\b(?:no|not|don't|wait|hold|later|maybe|except|but|however|unless|instead|change)\b/i;

// A short, unhedged confirmation such as "yes" or "go ahead" (re-exported by proposals.mjs).
export function isExplicitYes(text) {
  const t = String(text ?? '').trim();
  return t.length <= 160 && YES.test(t) && !HEDGE.test(t);
}

function confirmedProposal(ctx, value, shape) {
  if (!ctx.conversationKey || !ctx.actorId) return false;
  const rows = ctx.db.prepare(`SELECT role, text, provenance FROM messages WHERE conversation_key = ? AND id <= ? ORDER BY id DESC LIMIT 2`)
    .all(ctx.conversationKey, ctx.evidenceMessageId ?? Number.MAX_SAFE_INTEGER);
  let reply = ctx.ownerText;
  let previous = rows[0];
  if (reply == null) {
    if (previous?.role !== 'me' || parse(previous.provenance, null)?.ownerInput?.actorId !== ctx.actorId) return false;
    reply = previous.text;
    previous = rows[1];
  }
  if (!isExplicitYes(reply)) return false;
  if (previous?.role !== 'fathom') return false;
  const provenance = parse(previous.provenance, null);
  return (provenance?.literals ?? []).some(l => typeof l.source === 'string' && l.source.trim()
    && typeof l.text === 'string' && previous.text.includes(l.text) && goalTextStates(value, l.text, shape));
}

export function requireEvidence(ctx, value, { evidence, stored = [], shape, argument = 'value', household = false } = {}) {
  const statements = ownerStatements(ctx);
  const words = evidence ? statements.filter(s => s.includes(evidence)).map(() => evidence) : statements;
  const same = v => JSON.stringify(v) === JSON.stringify(value);
  if (stored.some(same) || words.some(text => stated(value, text, shape))) return;
  const quantity = typeof value === 'number' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (household && quantity && (householdValues(ctx.db).some(v => same(v) || (typeof v === 'string' && goalTextStates(value, v, shape)))
    || confirmedProposal(ctx, value, shape))) return;
  const reason = household ? 'Use a value you stated, a stored household value, or a value from a sourced earlier proposal you explicitly confirmed.'
    : 'Use a value you stated in this conversation or a stored value. Include the exact words as evidence.';
  throw new ToolError('bad_input', `${argument}: ${reason}`);
}
