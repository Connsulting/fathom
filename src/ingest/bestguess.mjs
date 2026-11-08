import { jevEvidence } from '../categories/policy.mjs';
import { JEV_MODEL } from '../categories/jev.mjs';
import { categoryGuess } from '../categories/store.mjs';
// Best guess for a pending confirm question, with evidence that names a field or a document and
// quotes stored values. Rule guesses come from stored rows (account kind from the account name,
// same for a near duplicate on the same date with the same amount, joint for a holder naming both
// household members); otherwise the stored engine guess, whose fixed reason code is rendered from
// the card's own detail. The fixed reason sentence is never the evidence. The resolver can apply a grounded choice.
// bestGuess(db, item, detail) -> {option, label, evidence, source: 'rule' | 'engine'} | null

import { parseJson } from '../store/db.mjs';
import { REASON_TEXT } from './guess.mjs';
import { kindOf } from './pipeline.mjs';
import { multiHolder } from './auto.mjs';
import { fileInfo, parserLabel } from './context.mjs';

const BASIS_OF = new Map(Object.entries(REASON_TEXT).map(([code, text]) => [text, code]));

function money(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return '';
  const n = Number(amount);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const quote = (value) => `"${String(value)}"`;
const optionOf = (item, id) => item.options?.find((o) => o.id === id) ?? null;
const words = (text) => String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];

// ---------------------------------------------------------------- rule guesses

// The kind the account name says and the shortest run of its words that says it.
function kindFromName(name) {
  const kind = kindOf(name);
  if (!kind) return null;
  const parts = String(name).match(/[A-Za-z0-9]+/g) ?? [];
  for (let len = 1; len <= parts.length; len++) {
    for (let i = 0; i + len <= parts.length; i++) {
      const run = parts.slice(i, i + len).join(' ');
      if (kindOf(run) === kind) return { kind, word: run };
    }
  }
  return { kind, word: String(name) };
}

function kindRule(item, detail) {
  const name = detail?.account?.name;
  const found = name ? kindFromName(name) : null;
  const option = found && optionOf(item, found.kind);
  if (!option) return null;
  return { option: option.id, label: option.label, evidence: `The account name ${quote(name)} says ${quote(found.word)}.`, source: 'rule' };
}

function nearRule(item, detail) {
  const [a, b] = detail?.entries ?? [];
  if (!a || !b || !a.date || a.amount == null || a.date !== b.date || a.amount !== b.amount) return null;
  const option = optionOf(item, 'same');
  if (!option) return null;
  const on = a.account ? ` on ${a.account}` : '';
  const what = (e) => `${quote(e.description ?? '')}${e.file ? ` (${e.file})` : ''}`;
  const rest = a.description === b.description ? 'the descriptions match too' : `only the description differs: ${what(a)} and ${what(b)}`;
  return { option: option.id, label: option.label, evidence: `Both rows are dated ${a.date} for ${money(a.amount)}${on}; ${rest}.`, source: 'rule' };
}

// The stored household names {me, spouse}, each a non-empty string, or null.
async function householdNames(db) {
  const row = await db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get();
  const v = parseJson(row?.value, null);
  const name = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return v && name(v.me) && name(v.spouse) ? { me: name(v.me), spouse: name(v.spouse) } : null;
}
// Every word of the stored name is among the holder's words.
const namesHolder = (name, holder) => { const have = new Set(words(holder)); const need = words(name); return need.length > 0 && need.every((w) => have.has(w)); };

async function jointRule(db, item, detail) {
  const holder = detail?.account?.holder;
  if (!holder || !multiHolder(holder)) return null;
  const names = await householdNames(db);
  if (!names || !namesHolder(names.me, holder) || !namesHolder(names.spouse, holder)) return null;
  const option = optionOf(item, 'joint');
  if (!option) return null;
  return {
    option: option.id, label: option.label, source: 'rule',
    evidence: `The source names the holder ${quote(holder)}, which includes both ${names.me} and ${names.spouse}.`,
  };
}

export async function deterministicGuess(db, item, detail) {
  switch (item.kind) {
    case 'account_kind': return kindRule(item, detail);
    case 'near_duplicate': return nearRule(item, detail);
    case 'account_owner': return await jointRule(db, item, detail);
    default: return null;
  }
}

// ---------------------------------------------------------------- engine evidence

const accountOf = (detail) => (detail?.type === 'account' ? detail.account : null);
const ending = (inst, mask) => (inst && mask ? `${inst}, last 4 ${mask}` : inst || (mask ? `Last 4 ${mask}` : ''));
const entryText = (detail, e) => detail.fields.filter((f) => e[f] != null && e[f] !== '')
  .map((f) => (f === 'amount' || f === 'balance' ? money(e[f]) : f === 'description' ? quote(e[f]) : String(e[f]))).join(' ');
const plain = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
const valuesText = (detail) => detail.values.filter((v) => v.value != null && v.value !== '').map((v) => `${v.label}: ${plain(v.value)}`).join('; ');

// The subject of the card in stored values: the account, the entries or the listed values.
function subjectText(detail) {
  const a = accountOf(detail);
  if (a) return quote(a.label || a.name || 'this account');
  if (detail?.type === 'compare') return detail.entries.map((e) => entryText(detail, e)).filter(Boolean).join('; ');
  if (detail?.type === 'values') return valuesText(detail);
  return '';
}

// The imported values the card shows.
function importedText(detail) {
  const a = accountOf(detail);
  if (a) {
    const parts = [];
    if (a.balance) parts.push(`latest ${a.balance.basis === 'holdings' ? 'holdings total' : 'balance'} ${money(a.balance.amount)} on ${a.balance.date}${a.balance.fileName ? ` from ${a.balance.fileName}` : ''}`);
    for (const r of a.recent) parts.push(`${r.date} ${money(r.amount)} ${quote(r.description)}${r.fileName ? ` (${r.fileName})` : ''}`);
    return parts.join('; ');
  }
  return subjectText(detail);
}

async function engineEvidence(db, item, detail, basis) {
  const a = accountOf(detail);
  const file = await fileInfo(db, item.fileId);
  const entryFiles = detail?.type === 'compare' ? [...new Set(detail.entries.map((e) => e.file).filter(Boolean))] : [];
  const fileNames = file ? [file.name] : a ? a.files.map((f) => f.name) : detail?.file ? [detail.file.name] : entryFiles;
  switch (basis) {
    case 'account_name': {
      const names = a ? [a.name] : detail?.type === 'compare' ? [...new Set(detail.entries.map((e) => e.account ?? e.name))] : [];
      const list = names.filter(Boolean);
      return list.length ? `Account name ${list.map(quote).join(' and ')}.` : null;
    }
    case 'institution': {
      if (a) { const text = ending(a.institution, a.mask); return text ? `${text}.` : null; }
      if (detail?.type === 'compare') {
        const list = [...new Set(detail.entries.map((e) => ending(e.institution, e.mask)).filter(Boolean))];
        return list.length ? `${list.join(' and ')}.` : null;
      }
      return null;
    }
    case 'source_file':
      return fileNames.length ? `Source file ${fileNames.join(' and ')}.` : null;
    case 'document_type': {
      const info = file ?? await fileInfo(db, a?.files[0]?.id ?? detail?.file?.id);
      const label = parserLabel(info?.parser);
      return label ? `Document type ${quote(label)} (${info.name}).` : null;
    }
    case 'imported_values': {
      const text = importedText(detail);
      return text ? `Imported values: ${text}.` : null;
    }
    case 'question':
    default: {
      const text = subjectText(detail);
      return text ? `The question is about ${text}.` : null;
    }
  }
}

async function engineGuess(db, item, detail) {
  const row = await db.prepare('SELECT option_id, reason, model FROM confirm_guesses WHERE item_id = ?').get(item.id);
  const option = row?.option_id != null ? optionOf(item, row.option_id) : null;
  if (!option) return null;
  const proposal=parseJson(row.reason,null);
  if(row.model===JEV_MODEL || proposal?.modelPort===true) {
    const confidence=proposal?.confidence;
    if(!Number.isFinite(confidence)) return null;
    return {option:option.id,label:option.label,source:'engine',confidence,evidence:jevEvidence(confidence)};
  }
  const basis = BASIS_OF.get(row.reason) ?? 'question';
  const evidence = await engineEvidence(db, item, detail, basis) ?? await engineEvidence(db, item, detail, 'question') ?? `The question reads ${quote(item.question)}.`;
  return { option: option.id, label: option.label, evidence, source: 'engine' };
}

export async function bestGuess(db, item, detail) {
  if (!item || item.status === 'answered') return null;
  if (item.kind === 'transaction_category') return categoryGuess(item);
  if (item.kind === 'category_mapping') return null;
  return await deterministicGuess(db, item, detail) ?? await engineGuess(db, item, detail);
}
