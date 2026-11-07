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
    return cleanJoin(raw) || 'Account';
  }

  let imported = slug || (manual || generic || personal ? '' : stripToken(raw, repeated || mask));
  if (imported && mask && imported === mask) imported = '';
  if (inst || kind) {
    const label = [inst, kind].filter(Boolean).join(' ');
    if (label) return label;
  }
  if (imported) return stripToken(imported, mask) || 'Account';
  return 'Account';
}

// Institution and owner, with empty parts left out. No leading or dangling comma.
export function accountSubtitle(account) {
  const inst = cleanJoin(account?.inst);
  const owner = cleanJoin(account?.owner);
  return [inst, owner].filter(Boolean).join(', ');
}

// The label of an account: owner prefix, name, then the sure last 4, as "Alex's Everyday (1234)".
// The name is the owner's custom name if set, otherwise the default name. A name that already
// starts with the prefix is not prefixed twice, and one that already carries the digits does not
// get them twice.
export function accountLabel(account) {
  return composeLabel(labelPrefix(account), baseLabel(account), sureMask(account));
}

// The three parts of the label, for a screen that edits the name and previews the whole:
// {labelPrefix, baseName, labelMask}.
export function accountLabelParts(account) {
  return { labelPrefix: labelPrefix(account), baseName: baseLabel(account), labelMask: sureMask(account) };
}

// The name as the person edits it: custom if set, otherwise the default, with no prefix or last 4.
export function baseLabel(account) {
  const custom = String(account?.displayName ?? account?.display_name ?? '').trim();
  return custom || defaultAccountLabel(account);
}

const quotes = (s) => String(s ?? '').replace(/[\u2018\u2019]/g, "'").toLowerCase();

export function composeLabel(prefix, name, mask) {
  let out = String(name ?? '');
  const pre = String(prefix ?? '').trim();
  if (pre) {
    const have = quotes(out);
    const want = quotes(pre);
    if (!(have.startsWith(want) && (have.length === want.length || /\s/.test(have[want.length])))) out = `${pre} ${out}`;
  }
  const last4 = /^\d{4}$/.test(String(mask ?? '')) ? String(mask) : '';
  if (last4 && !new RegExp(`\\b${last4}\\b`).test(out)) out = `${out} (${last4})`;
  return out;
}

const OWNER_WORDS = {
  me: ['you', 'me', 'owner', 'yours', 'mine', 'myself'],
  spouse: ['your spouse', 'spouse', 'partner'],
  joint: ['joint', 'joint account', 'both', 'both of you', 'household', 'shared'],
};
const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0];
const possessive = (n) => (firstName(n) ? `${firstName(n)}'s` : '');

// The owner prefix: the person's first name, possessive, from the household names ("Alex's"),
// "Joint" for a joint account, the business's name for a business account when one is on file,
// and nothing when the owner is unknown. The demo's owner tokens ({n:me}) stay tokens, resolved
// where the label is shown. A caller that already worked the prefix out passes it as labelPrefix.
export function labelPrefix(account) {
  if (typeof account?.labelPrefix === 'string') return account.labelPrefix;
  const raw = String(account?.owner ?? '').trim();
  if (!raw) return '';
  const token = /^\{n:(\w+)\}$/.exec(raw);
  if (token) return token[1] === 'me' || token[1] === 'spouse' ? `${raw}'s` : token[1] === 'biz' ? raw : '';
  const key = norm(raw);
  const names = account?.householdNames && typeof account.householdNames === 'object' ? account.householdNames : {};
  const is = (n) => !!n && (norm(n) === key || norm(firstName(n)) === key);
  const business = String(account?.businessName ?? '').trim();
  if (OWNER_WORDS.me.includes(key) || is(names.me)) return possessive(names.me);
  if (OWNER_WORDS.spouse.includes(key) || is(names.spouse)) return possessive(names.spouse);
  if (OWNER_WORDS.joint.includes(key)) return 'Joint';
  if (key === 'business' || (business && key === norm(business))) return business;
  return '';
}

function sureMask(account) {
  const mask = String(account?.mask ?? '');
  if (!/^\d{4}$/.test(mask) || account?.maskSure === false) return '';
  return mask;
}

// Trend title: the shared label, markup stripped.
export function trendLabel(account) {
  // The demo's {n:key} name tokens keep their braces; everything else is plain text.
  return String(accountLabel(account)).split(/(\{n:\w+\})/).map((part, i) => (i % 2 ? part : part.replace(/[{}<>]/g, ''))).join('').replace(/\s+/g, ' ').trim();
}

// Planner source line for one account: the shared label.
export function sourceLabel(account) {
  return accountLabel(account);
}
