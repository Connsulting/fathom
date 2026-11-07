import { parseJson as parse } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';

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

function stated(value, text) {
  if (value === null) return /\b(clear|remove|unset|no target|no date)\b/i.test(text);
  if (typeof value === 'number') return statedAmounts(text).includes(value);
  if (typeof value === 'boolean') return new RegExp(`\\b${value}\\b`, 'i').test(text);
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? dates(text).includes(value) : text.toLowerCase().includes(value.toLowerCase());
  if (value && typeof value === 'object') return Object.values(value).every(v => stated(v, text));
  return false;
}

export function requireEvidence(ctx, value, { evidence, stored = [] } = {}) {
  const statements = ownerStatements(ctx);
  const words = evidence ? statements.filter(s => s.includes(evidence)).map(() => evidence) : statements;
  const same = v => JSON.stringify(v) === JSON.stringify(value);
  if (stored.some(same) || words.some(text => stated(value, text))) return;
  throw new ToolError('bad_input', 'Use a value you stated in this conversation or a stored value. Include the exact words as evidence.');
}
