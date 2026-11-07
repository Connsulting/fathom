// One label for an account, shared by the server and the browser (served at /shared/account-label.mjs).
// displayName, when set, is the owner's name. Otherwise the label is composed from the imported
// fields, and a bad imported name is not shown as-is.

export const DISPLAY_NAME_LIMIT = 120;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const KIND_WORD = Object.freeze({
  checking: 'checking',
  cash: 'savings',
  card: 'card',
  taxable: 'brokerage',
  retirement: 'retirement',
  roth: 'Roth',
  hsa: 'HSA',
  529: '529',
  business: 'business',
  loan: 'loan',
});

export function validateDisplayName(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'display name must be text' };
  const clean = value.trim();
  if (!clean) return { ok: true, value: null };
  if (clean.length > DISPLAY_NAME_LIMIT) return { ok: false, error: `display name is over ${DISPLAY_NAME_LIMIT} characters` };
  if (CONTROL.test(clean) || /[\r\n]/.test(clean)) return { ok: false, error: 'display name has characters that are not allowed' };
  return { ok: true, value: clean };
}

// Drop empty comma-separated parts. Slashes stay: an imported name may contain them.
const cleanJoin = (s) => String(s ?? '')
  .replace(/(\s*,\s*)+/g, ', ')
  .replace(/^(,\s*)+|(\s*,\s*)+$/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

function kindWord(kind) {
  const k = String(kind ?? '').toLowerCase();
  return Object.hasOwn(KIND_WORD, k) ? KIND_WORD[k] : '';
}

function maskForLabel(account) {
  const mask = String(account?.mask ?? '');
  if (!/^\d{4}$/.test(mask)) return '';
  if (account.maskSure === false) return '';
  return mask;
}

function slugWords(name) {
  const s = String(name ?? '').trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(s)) return '';
  const parts = s.split(/[-_]+/).filter(Boolean);
  if (!parts.length) return '';
  const [first, ...rest] = parts;
  return first.charAt(0).toUpperCase() + first.slice(1) + (rest.length ? ` ${rest.join(' ')}` : '');
}

function genericBrokerage(name) {
  return /^individual\s*-\s+/i.test(String(name ?? '').trim());
}

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function holderList(account) {
  const names = account?.householdNames && typeof account.householdNames === 'object' ? account.householdNames : {};
  return [names.me, names.spouse, account?.holder]
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length >= 3);
}

function personalName(name, account) {
  const n = norm(name);
  if (!n || !kindWord(account?.kind)) return false;
  return holderList(account).some((h) => {
    const hn = norm(h);
    return hn && (n === hn || n.includes(hn));
  });
}

function repeatedDigit(name) {
  const hits = String(name ?? '').match(/\b(\d{4})\b/g) || [];
  const counts = new Map();
  for (const d of hits) counts.set(d, (counts.get(d) || 0) + 1);
  for (const [d, n] of counts) if (n >= 2) return d;
  return '';
}

function stripToken(name, token) {
  if (!token) return cleanJoin(name);
  return cleanJoin(String(name ?? '').replace(new RegExp(`\\b${token}\\b`, 'g'), ' '));
}

// The label used when the owner has not set one.
export function defaultAccountLabel(account) {
  const a = account || {};
  const inst = cleanJoin(a.inst);
  const kind = kindWord(a.kind);
  const mask = maskForLabel(a);
  const raw = String(a.name ?? '').trim();
  const slug = slugWords(raw);
  const repeated = repeatedDigit(raw);
  const manual = /^manual$/i.test(raw);
  const generic = genericBrokerage(raw);
  const personal = personalName(raw, a);
  const bad = !raw || manual || !!slug || generic || personal || !!repeated || /^[,.\s]|[,.\s]$/.test(raw);

  if (!bad) {
    const once = mask && new RegExp(`\\b${mask}\\b`).test(raw) ? raw : raw;
    return cleanJoin(once) || 'Account';
  }

  let imported = slug || (manual || generic || personal ? '' : stripToken(raw, repeated || mask));
  if (imported && mask && imported === mask) imported = '';
  const ending = mask ? `ending ${mask}` : '';
  if (inst || kind) {
    const head = [inst, kind].filter(Boolean).join(' ');
    const label = [head, ending].filter(Boolean).join(' ');
    if (label) return label;
  }
  if (imported) {
    const base = stripToken(imported, mask);
    return [base, ending].filter(Boolean).join(' ') || 'Account';
  }
  if (ending) return ending.charAt(0).toUpperCase() + ending.slice(1);
  return 'Account';
}

// Institution and owner, with empty parts left out. No leading or dangling comma.
export function accountSubtitle(account) {
  const inst = cleanJoin(account?.inst);
  const owner = cleanJoin(account?.owner);
  return [inst, owner].filter(Boolean).join(', ');
}

export function accountLabel(account) {
  const custom = String(account?.displayName ?? account?.display_name ?? '').trim();
  if (custom) return custom;
  return defaultAccountLabel(account);
}

function sureMask(account) {
  const mask = String(account?.mask ?? '');
  if (!/^\d{4}$/.test(mask) || account?.maskSure === false) return '';
  return mask;
}

// Trend title: the shared label, with braces and markup stripped, and the mask once.
export function trendLabel(account) {
  const plain = String(accountLabel(account)).replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim();
  const mask = sureMask(account);
  return mask && !plain.includes(mask) ? `${plain} ${mask}` : plain;
}

// Planner source line for one account. The mask is not repeated.
export function sourceLabel(account) {
  const shown = accountLabel(account);
  const mask = sureMask(account);
  return mask && !shown.includes(mask) ? `${shown} ...${mask}` : shown;
}
