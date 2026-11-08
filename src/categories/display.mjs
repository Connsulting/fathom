// Display text for the Confirm screen's category cards and Decided for you rows. Pure functions;
// the server applies them before the scenario is built, so the page only renders what it is given.

import { normalizeMerchant } from './resolve.mjs';

// Words that never start a merchant name: bank rails, card rails and payment kinds.
const RAIL = '(?:ach|pos|web|recurring|debit\\s+card|debit|credit|purchase|ppd|ccd)';
const KIND = '(?:debit|credit|payment|pmt|purchase|withdrawal|deposit|card)';
const LEADING = [
  /^purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*/i,
  /^checkcard(?:\s+\d{4})?\s+/i,
  new RegExp(`^${RAIL}(?:\\s+${KIND})*\\b[\\s:*-]*`, 'i'),
  /^(?:sq|tst|pp|paypal|sp|gglpay|google|apl\s?pay|aplpay)\s*\*\s*/i,
];
const INSIDE = [
  /\s+(?:ppd|ccd)\b.*$/i,
  /\bid:\s*[a-z0-9-]+/gi,
  /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g,
  /\b(?:store|str|no)\.?\s*#?\s*\d+\b/gi,
  /#\s*\d+/g,
  /\bcard\s+\d{2,4}\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\*[a-z0-9]{5,}(?=\s|$)/gi,
];
const KEEP_UPPER = new Set(['LLC', 'LLP', 'USA', 'US']);

// A trailing token that is a reference, not a name: a run of digits, or a long letters-and-digits id.
const idToken = (w) => /^\d{3,}$/.test(w) || (w.length >= 6 && /\d/.test(w) && /[a-z]/i.test(w) && /^[a-z0-9]+$/i.test(w));

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s/(&-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b[a-z]+\b/gi, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w));
}
const cased = (s) => (/[a-z]/.test(s) && /[A-Z]/.test(s) ? s : titleCase(s));
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// The name a person would say for a raw bank description: rails, processor prefixes, store
// numbers and trailing reference ids removed, and sentence case when the bank shouted or whispered.
// '' for a missing or non-text value; a description that is only noise falls back to itself.
export function merchantDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  const original = squash(raw);
  if (!original) return '';
  let s = original;
  for (let again = true; again;) {
    again = false;
    for (const re of LEADING) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; again = true; }
    }
  }
  for (const re of INSIDE) s = s.replace(re, ' ');
  const words = squash(s).split(' ').filter(Boolean);
  while (words.length > 1 && idToken(words.at(-1))) words.pop();
  if (words.length === 1 && idToken(words[0])) words.length = 0;
  const name = squash(words.join(' ')).replace(/^[\s*#:,.\-_/]+|[\s*#:,.\-_/]+$/g, '');
  return cased(name || original);
}

// Structured bank text (ACH addenda, wire memos, online transfers) read as what happened, for
// transaction lists. The raw text stays the record; this is only the label people read.
const PAYROLL = ['gusto', 'adp', 'paychex', 'paylocity', 'rippling', 'intuit payroll', 'quickbooks payroll'];
const isPayroll = (name) => {
  const n = ` ${normalizeMerchant(name)} `;
  return PAYROLL.some((p) => n.includes(` ${p} `));
};

// Splits `KEY:value KEY:value` text on the given keys; a value ends where the next key begins.
// Keys come back upper case without spaces, so `CO ENTRY DESCR` and `coentrydescr` read alike.
function fields(text, keys) {
  const re = new RegExp(`(?:^|\\s)(${keys.join('|')})\\s*:`, 'gi');
  const hits = [...text.matchAll(re)];
  const out = new Map();
  hits.forEach((m, i) => {
    const key = m[1].toUpperCase().replace(/\s+/g, '');
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    if (!out.has(key)) out.set(key, squash(text.slice(m.index + m[0].length, end)));
  });
  return out;
}

// An originator name as people write it: a short all-caps acronym (ADP, IRS) stays upper.
const orgName = (raw) => {
  const s = squash(raw);
  return /^[A-Z]{2,4}$/.test(s) ? s : merchantDisplayName(s);
};

const ACH_KEYS = ['ORIG CO NAME', 'ORIG ID', 'DESC DATE', 'CO ENTRY DESCR', 'SEC', 'TRACE#', 'EED', 'IND ID', 'IND NAME', 'TRN'];
function achName(text) {
  const f = fields(text, ACH_KEYS.map((k) => k.replace(/ /g, '\\s*').replace('#', '#?')));
  const rawName = f.get('ORIGCONAME');
  if (!rawName) return '';
  const payroll = isPayroll(rawName);
  // A payroll processor's name often goes on with PAYROLL; the label adds that word itself.
  const name = orgName(payroll ? rawName.replace(/\s+payroll\b.*$/i, '') || rawName : rawName);
  const descr = squash((f.get('COENTRYDESCR') || '').split(' ').filter((w) => !idToken(w)).join(' '));
  const d = descr.toUpperCase();
  if (/TAX/.test(d)) return payroll ? `${name} payroll tax` : `${name} tax payment`;
  if (payroll && /^(?:NET|PAYROLL|DIR\s*DEP)\b/.test(d)) return /^NET\b/.test(d) ? `${name} payroll (net)` : `${name} payroll`;
  if (/^(?:FEES?|INVOICE)\b/.test(d)) return `${name} fee`;
  if (/^(?:TRANSFER|XFER|PAYOUTS?|TRNSFR)\b/.test(d)) return `${name} transfer`;
  return squash(`${name} ${descr.toLowerCase()}`);
}

const WIRE_KEYS = ['A/C', 'BNF', 'B/O', 'ORG', 'REF', 'IMAD', 'OMAD', 'TRN', 'OBI', 'SSN', 'ID', 'VIA', 'BBI', 'BBK', 'RFB', 'FED ID', 'SND BK', 'RCV BK'];
const CORP = /^(?:LLC|INC|CORP|CO|LTD|NA|N\.A\.?|LP|LLP|PLLC)[.,]?$/i;
// The party in a wire memo: account numbers before it and the address after it removed.
function wireParty(raw) {
  const words = squash(raw).split(' ').filter(Boolean);
  while (words.length && /^\/?[\d-]+$/.test(words[0])) words.shift();
  // A suffix ends the legal name; CO before a ZIP is Colorado, not a company.
  let cut = -1;
  words.forEach((w, i) => { if (i > 0 && CORP.test(w) && !/^\d{5}/.test(words[i + 1] || '')) cut = i; });
  if (cut > 0) words.length = cut;
  else {
    if (words.length > 1 && /^(?:US|USA)$/i.test(words.at(-1))) words.pop();
    if (words.length > 1 && /^\d{5}(?:-\d{4})?$/.test(words.at(-1))) words.pop();
    if (words.length > 2 && /^[A-Z]{2}$/.test(words.at(-1))) words.length -= 2;
  }
  const name = words.join(' ').replace(/[\s,.]+$/, '');
  return name && /[a-z]/i.test(name) ? titleCase(name) : '';
}

function wireName(text) {
  if (!/\b(?:fed)?wire\b/i.test(text)) return '';
  const f = fields(text, WIRE_KEYS.map((k) => k.replace('/', '\\/').replace(/ /g, '\\s+')));
  // Incoming wording wins: an incoming memo can still say WIRE TRANSFER VIA its bank.
  const inc = /\bfedwire\s+credit\b|\bincoming\s+wire\b|\bwire\s+(?:transfer\s+)?(?:from|in)\b|\bwire\s+credit\b/i.test(text);
  const out = !inc && /\boutgoing\s+wire\b|\bwire\s+(?:transfer\s+)?(?:to|out|via)\b|\bwire\s+debit\b/i.test(text);
  const to = wireParty(f.get('A/C') || f.get('BNF') || '');
  const from = wireParty(f.get('B/O') || f.get('ORG') || '');
  if (!inc && to) return `Wire to ${to}`;
  if (!out && from) return `Wire from ${from}`;
  // A wire fee is a fee, named by the general rule.
  if (/\bfees?\b/i.test(text)) return '';
  if (!to && !from) {
    // `WIRE TRANSFER FROM ACME CORP` with no keyed fields names the party in the sentence.
    const m = /\bwire\s+(?:transfer\s+)?(to|from)\s+(.+)$/i.exec(text);
    const party = m ? wireParty(m[2].split(/\s+\S+:/)[0]) : '';
    if (party) return `Wire ${m[1].toLowerCase()} ${party}`;
  }
  return out ? 'Outgoing wire' : inc ? 'Incoming wire' : 'Wire transfer';
}

const ACCOUNT_KIND = { CHK: 'checking', CHECKING: 'checking', SAV: 'savings', SAVINGS: 'savings', MMA: 'money market', BRK: 'brokerage', CC: 'card', CRD: 'card', CARD: 'card' };
function transferName(text) {
  const m = /^online\s+transfer\s+(to|from)\s+([a-z]+)?\s*(?:(?:\.{2,}|x+|#)\s*(\d{2,}))?/i.exec(text);
  if (!m || !m[2]) return '';
  const kind = ACCOUNT_KIND[m[2].toUpperCase()] || m[2].toLowerCase();
  return `Transfer ${m[1].toLowerCase()} ${kind}${m[3] ? ` ${m[3].slice(-4)}` : ''}`;
}

// The label for a transaction's bank description: structured ACH, wire and online transfer text
// read first, anything else through merchantDisplayName. '' for a missing or non-text value.
export function transactionDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  const text = squash(raw);
  if (!text) return '';
  return achName(text) || wireName(text) || transferName(text) || merchantDisplayName(text);
}

// Evidence text for people. A vendor name, a model id or a percentage is machine provenance, not
// evidence: any sentence carrying one is dropped and the rest is kept as the server wrote it.
const MACHINE = /\bjev\b|\bjev-\d|typesafe|%|\bpercent\b/i;
export function plainEvidence(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  return t.split(/(?<=[.!?])\s+/).filter((sentence) => !MACHINE.test(sentence)).join(' ').trim();
}
