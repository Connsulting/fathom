/* Horizon ingest screens: Add files, per-file results, the Confirm deck (item and group cards with
   their context), Decided for you, the pending banner, account freshness and the Sources list.
   Text from the server (file names, questions, option labels, guess evidence, account names,
   holders, descriptions, source labels) is plain text and always goes through esc(), never token
   resolution. */

import { createSwipe } from './swipe.js';

// The household's fixed category order for a category card. Number key N names the same category
// on every card; the best guess is highlighted where it already sits, never moved up. A category
// outside this list (a guess the household has not used yet) goes after it.
export const CATEGORY_ORDER = ['Shopping', 'Business', 'Income', 'Internal Transfers', 'Taxes', 'Investment', 'Ignore'];
const categoryRank = (id) => {
  const at = CATEGORY_ORDER.indexOf(String(id));
  return at < 0 ? CATEGORY_ORDER.length : at;
};
export function visibleOptions(item) {
  const options = Array.isArray(item?.options) ? item.options : [];
  if (item?.kind !== 'transaction_category') return options;
  return options.filter(o => !String(o.id).startsWith('always:')).sort((a, b) => categoryRank(a.id) - categoryRank(b.id));
}
export function categoryAnswerOption(item, option, always) {
  if (!visibleOptions(item).some(o => o.id === option)) return null;
  const id = item.kind === 'transaction_category' && always ? 'always:' + option : option;
  return item.options.some(o => o.id === id) ? id : null;
}

// Decided for you shows this many rows until the person asks for all of them.
export const DECIDED_VISIBLE = 5;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS = {
  imported: 'Imported',
  duplicate: 'Already imported',
  waiting_for_engine: 'Waiting for the engine',
  budget_exhausted: 'Interpretation budget reached',
  needs_confirmation: 'Ready for review',
  needs_clarification: 'Needs clarification',
  needs_source_text: 'Needs readable text',
  needs_mapping: 'Columns not matched yet',
  needs_extraction: 'Not read yet',
  pending: 'Finishing import',
  unsupported: 'Not a file Fathom reads',
  too_large: 'Too large to read',
  failed: 'Could not import'
};

// A waiting file's status: its label, the plain cause, and the one control that moves it on.
export const PROPOSAL_STATES = Object.freeze({
  waiting_for_engine: { label: STATUS.waiting_for_engine, cause: 'File saved. Waiting for the engine to interpret it.', control: 'engine' },
  budget_exhausted: { label: STATUS.budget_exhausted, cause: 'File saved. Interpretation stopped at the budget limit.', control: 'engine' },
  needs_confirmation: { label: STATUS.needs_confirmation, cause: 'Nothing is imported until you approve.', control: 'approve' },
  needs_clarification: { label: STATUS.needs_clarification, cause: 'Fathom needs one answer before it can import this.', control: 'answer' },
  needs_source_text: { label: STATUS.needs_source_text, cause: 'File saved. It has no readable text; add a text export or a PDF with selectable text.', control: 'upload' },
  needs_mapping: { label: STATUS.needs_mapping, cause: "Fathom has not matched this file's columns yet. Retry reads it again.", control: 'retry' },
  needs_extraction: { label: STATUS.needs_extraction, cause: 'Fathom has not read this document yet. Retry reads it again.', control: 'retry' }
});
// Unresolved file statuses no proposal carries. `replace` adds a new file, then removes this one.
export const FILE_STATES = Object.freeze({
  pending: { label: STATUS.pending, cause: 'File saved. Fathom finishes importing it automatically.', control: 'retry' },
  failed: { label: STATUS.failed, cause: 'File saved. Something went wrong while reading it. Retry reads the saved file again.', control: 'retry' },
  unsupported: { label: STATUS.unsupported, cause: 'Fathom cannot read this kind of file. Add a CSV, Excel workbook, PDF or text export instead.', control: 'replace' },
  too_large: { label: STATUS.too_large, cause: 'This file is too large to read at once. Add a smaller export, such as one year at a time.', control: 'replace' }
});
// Causes that depend on the stored reason (or, for an empty file, its warning code).
const RETRYING_CAUSE = 'File saved. Something went wrong while reading it; Fathom tries once more automatically.';
const EMPTY_CAUSE = 'The file is empty. Export it again and add the new copy.';
const PDF_UNREADABLE_CAUSE = 'Fathom could not read the text in this PDF. Add a text export or a PDF with selectable text.';
const stateOf = (status) => (Object.hasOwn(PROPOSAL_STATES, String(status)) ? PROPOSAL_STATES[status] : null);
const fileStateOf = (status) => stateOf(status) ?? (Object.hasOwn(FILE_STATES, String(status)) ? FILE_STATES[status] : null);
// Statuses whose file was not read at all: a replacement in one of them keeps the file it replaces.
const UNREAD = new Set(['failed', 'unsupported', 'too_large']);

// The status a waiting file shows: its proposal's when that is a waiting state, else the file's.
export const proposalStatus = (file) => (stateOf(file?.proposal?.status) ? file.proposal.status : String(file?.status ?? ''));

// The stored reason behind a waiting status: the proposal's when there is one, else the file's.
export const proposalReason = (file) => (file?.proposal ? file.proposal.reasonCode : file?.reasonCode) ?? null;
// Budget reasons that mean the file's own allowance is spent, so only a smaller file helps.
const FILE_LIMIT = new Set(['file_limit', 'output_limit', 'request_does_not_fit']);

// With the engine on, Retry is the working control for a file waiting on it (or on a budget that is
// not the file's own). A file over its own allowance needs a smaller file. Unknown is Retry.
export function proposalControl(status, { engineOn = false, reasonCode = null } = {}) {
  if (status === 'budget_exhausted' && FILE_LIMIT.has(reasonCode)) return 'upload';
  if ((status === 'waiting_for_engine' || status === 'budget_exhausted') && engineOn) return 'retry';
  if (status === 'needs_extraction' && reasonCode === 'pdf_unreadable') return 'replace';
  return fileStateOf(status)?.control ?? 'retry';
}

export function proposalCause(file) {
  const s = proposalStatus(file), reason = proposalReason(file);
  if (s === 'waiting_for_engine' && reason === 'owner_correction') return 'Your correction is saved. Waiting for the engine to read the file again.';
  if (s === 'waiting_for_engine' && reason === 'model_transient') return 'File saved. The engine did not answer in time; Fathom tries once more automatically.';
  if (s === 'budget_exhausted' && FILE_LIMIT.has(reason)) return 'File saved. This file needs more interpretation than one file is allowed; add a smaller file or split it.';
  if (s === 'failed' && String(reason ?? '').startsWith('retry:')) return RETRYING_CAUSE;
  if (s === 'unsupported' && (reason === 'empty_file' || num(file?.counts?.warningCodes?.empty_file) > 0)) return EMPTY_CAUSE;
  if (s === 'needs_extraction' && reason === 'pdf_unreadable') return PDF_UNREADABLE_CAUSE;
  return fileStateOf(s)?.cause ?? '';
}

// Parse warnings in plain words: one sentence per code, naming its rows when the file recorded them
// (counts.warningRows, at most five, plus counts.warningMore). [singular, plural] verb phrases.
const ROW_WARNING = {
  invalid_transaction: ['had no readable date or amount and was skipped', 'had no readable date or amount and were skipped'],
  missing_account_mask: ['has no account number', 'have no account number'],
  invalid_balance: ['has a balance Fathom could not read', 'have a balance Fathom could not read'],
  invalid_position: ['has a holding Fathom could not read', 'have a holding Fathom could not read'],
  truncated_position: ['was cut off', 'were cut off'],
  pending_activity: ['is pending activity and was skipped', 'are pending activity and were skipped'],
  invalid_cost_basis: ['has a cost basis Fathom could not read', 'have a cost basis Fathom could not read']
};
const ROW_UNKNOWN = ['could not be read', 'could not be read'];
const FILE_WARNING = {
  missing_headers: 'The file has no header row Fathom recognizes.',
  missing_as_of: 'The file has no as-of date.',
  malformed_csv: 'The file is not a well-formed CSV.',
  limit_exceeded: 'The file is larger than Fathom reads at once.',
  empty_file: 'The file is empty.',
  unsupported_format: 'The file is not in a format Fathom reads.'
};
// Codes that set the file's own status: its cause already says them.
const STATUS_WARNINGS = new Set(['limit_exceeded', 'empty_file', 'unsupported_format']);
const listText = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function warningText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const codes = c.warningCodes && typeof c.warningCodes === 'object' ? c.warningCodes : {};
  const out = [];
  for (const code of Object.keys(codes)) {
    if (!(num(codes[code]) > 0)) continue;
    if (Object.hasOwn(FILE_WARNING, code)) { out.push(FILE_WARNING[code]); continue; }
    const phrase = Object.hasOwn(ROW_WARNING, code) ? ROW_WARNING[code] : ROW_UNKNOWN;
    const rows = arr(c.warningRows?.[code]).filter((r) => Number.isInteger(r) && r >= 1);
    if (!rows.length) { out.push(Object.hasOwn(ROW_WARNING, code) ? `Some rows ${phrase[1]}.` : 'The file has parts Fathom could not read.'); continue; }
    const more = num(c.warningMore?.[code]);
    const many = rows.length + more > 1;
    out.push(`${many ? 'Rows' : 'Row'} ${listText(rows.map(String))}${more > 0 ? `, and ${more} more` : ''} ${phrase[many ? 1 : 0]}.`);
  }
  return out;
}

// What changed since the approved layout, in plain phrases; '' when nothing did. A filled-area
// change is named only when no header change already explains it.
export function deltaText(delta) {
  const out = [];
  let filled = false, header = false;
  for (const d of Array.isArray(delta) ? delta : []) {
    const f = String(d?.field ?? '');
    const column = /^headers\.\d+\.columns\.\d+$/.test(f);
    const phrase = column && d.before == null && d.after?.label != null ? `a new column appeared: ${d.after.label}`
      : column && d.after == null && d.before?.label != null ? `the ${d.before.label} column is gone`
        : /^headers\.\d+\.columns\.\d+\.label$/.test(f) ? `the ${d.before} column is now ${d.after}` : '';
    if (phrase) { out.push(phrase); header = true; }
    else if (f === 'layout' && d.reason === 'no_unique_approved_layout') out.push('more than one saved layout fits this file');
    else if (/^bindings(\.|$)/.test(f)) out.push('an account in the file changed');
    else if (/^structure(\.|$)/.test(f)) filled = true;
  }
  if (filled && !header) out.push('the file has a new filled area');
  return [...new Set(out)].join('; ');
}

const ROWS = [
  ['transaction', 'transaction'],
  ['balance', 'balance'],
  ['position', 'position'],
  ['pnl_line', 'profit and loss line'],
  ['tax_payment', 'tax payment'],
  ['document', 'document'],
  ['fact', 'fact']
];

const KIND = {
  account_owner: 'Account owner',
  account_kind: 'Account type',
  entity_alias: 'Business name',
  tax_year: 'Tax year',
  fact_check: 'Check a value',
  near_duplicate: 'Possible duplicate',
  account_match: 'Same account?',
  employer_relation: 'Employer',
  employer_recipient: 'Who is paid',
  document_recipient: 'Whose document',
  withholding_conflict: 'Withholding', transaction_category: 'Check these', category_mapping: 'Check these'
};

// Confirm deck keys. One plain table; the handler in ingestScreens reads it.
export const DECK_KEYS = [
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => ({ key, label: `Answer with option ${key}`, action: 'pick' })),
  { key: 'Enter', label: "Take Fathom's guess", action: 'guess' },
  { key: 'j', label: 'Next card', action: 'next' },
  { key: 'ArrowRight', label: 'Next card', action: 'next' },
  { key: 'k', label: 'Previous card', action: 'prev' },
  { key: 'ArrowLeft', label: 'Previous card', action: 'prev' },
  { key: 'z', label: 'Undo the last answer', action: 'undo' },
  { key: 'u', label: 'Undo the last answer', action: 'undo' },
  { key: 'Escape', label: 'Back to Home', action: 'leave' }
];

// The deck keys as keyboard registry rows (web/horizon/keys.js), one row per action in DECK_KEYS
// order, keys in normalizeKey form. run(actionName, event) does the work.
const DECK_LABEL = {
  pick: 'Answer with that option', guess: "Take Fathom's guess", next: 'Next card',
  prev: 'Previous card', undo: 'Undo the last answer', leave: 'Back to Home'
};
const active = () => (typeof document === 'undefined' ? null : document.activeElement);
const typing = (el) => !!el && (el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(String(el.tagName || '').toUpperCase()));
const DECK_WHEN = {
  // Enter on a focused button or link is its native activation.
  guess: { when: () => !active()?.closest?.('button,a[href]'), sheetWhen: () => true },
  // Escape never leaves from a text field.
  leave: {
    when: () => !typing(active()),
    sheetWhen: () => true
  }
};
export function deckBindings(run) {
  const rows = new Map();
  for (const { key, action } of DECK_KEYS) {
    if (!rows.has(action)) rows.set(action, { keys: [], label: DECK_LABEL[action], group: 'Confirm', ...DECK_WHEN[action], action: (e) => run(action, e) });
    rows.get(action).keys.push(key.length === 1 ? key : key.toLowerCase());
  }
  return [...rows.values()];
}

// Year banner copy: about five seconds per check, at least a minute.
export const quickCheckMinutes = (n) => Math.max(1, Math.ceil((n * 5) / 60));
export const quickChecksText = (n) => `${n} quick check${n === 1 ? '' : 's'}`;
export function minutesText(n) {
  const k = quickCheckMinutes(n);
  return `About ${k} minute${k === 1 ? '' : 's'}`;
}

const arr = (a) => (Array.isArray(a) ? a : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// 'Nov 3, 2026' from an ISO date or timestamp; '' when there is none.
export function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// 'Mar 2019' from an ISO date; '' when there is none.
export function monthYearText(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return `${MON[+m[2] - 1]} ${m[1]}`;
}

// A source's date range as 'Mar 2019 to Jun 2025', one month when both ends share it, '' when unknown.
export function sourceRangeText(range) {
  const a = monthYearText(range && range.from);
  const b = monthYearText(range && range.to);
  if (a && b) return a === b ? a : `${a} to ${b}`;
  return a || b;
}

// '2 transactions, 1 duplicate skipped' from a file result's counts; 'No new rows' when nothing landed.
export function countsText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const rows = c.rows && typeof c.rows === 'object' ? c.rows : {};
  const parts = ROWS.filter(([k]) => num(rows[k]) > 0).map(([k, w]) => plural(num(rows[k]), w));
  if (!parts.length) parts.push('No new rows');
  if (num(c.duplicates) > 0) parts.push(`${plural(num(c.duplicates), 'duplicate')} skipped`);
  if (num(c.revised) > 0) parts.push(`${num(c.revised)} revised`);
  if (num(c.superseded) > 0) parts.push(`${num(c.superseded)} superseded`);
  if (num(c.warnings) > 0) parts.push(plural(num(c.warnings), 'warning'));
  if (num(c.queued) > 0) parts.push(`${plural(num(c.queued), 'question')} to confirm`);
  return parts.join(', ');
}

const freshDeck = () => ({ units: [], members: {}, data: {}, answers: {}, hist: [], final: {}, cur: null, busy: null, busyIds: [], busyOpt: null, rowBusy: {}, demo: null, notice: '' });

// The group footer button that takes the best guesses of the rows still unanswered.
export const acceptLabel = (n) => `Accept ${n} best guess${n === 1 ? '' : 'es'}`;

// Screens Confirm can be opened from, as the Back button names them. Any other screen reads "Back".
const ORIGIN_LABEL = { home: 'Home', money: 'Money', accounts: 'Accounts', add: 'Files', plan: 'Plan', pace: 'Pace', goals: 'Goals' };

// Labels for stored account owner and type values (the confirm options' ids).
const OWNER_LABEL = { owner: 'You', spouse: 'Your spouse', joint: 'Joint', business: 'Business' };
const KIND_LABEL = {
  checking: 'Checking', cash: 'Savings or cash', card: 'Credit card', taxable: 'Taxable brokerage', retirement: 'Retirement',
  roth: 'Roth', hsa: 'HSA', 529: '529 plan', business: 'Business', loan: 'Loan'
};
// The question a group card asks of every row.
const GROUP_Q = {
  account_owner: 'Whose account is each of these?',
  account_kind: 'What type of account is each of these?'
};
// Why an answer Fathom recorded can no longer be undone, by finalReason code.
const FINAL_TEXT = {
  no_undo: 'This answer was recorded before answers could be changed, so it is final.',
  imported_since: 'A file was imported after this answer, so it is final.',
  changed_since: 'A later change builds on this answer, so it is final.',
  used_since: 'A later import used this answer, so it is final.',
  stale: 'A later import replaced this question, so it is final.'
};

// '$1,234.56' (cents only when the value has them, like the Engine screen), '-$12' for negatives;
// '' for a missing or non-numeric value.
export function cash(v) {
  if (v == null || v === '' || typeof v === 'boolean') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const [w, f] = (Number.isInteger(a) ? a.toFixed(0) : a.toFixed(2)).split('.');
  return `${n < 0 && a >= 0.005 ? '-' : ''}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

// One sentence for a waiting proposal from server values only (validated counts and totals, or a
// note's actions); '' when the server sent none.
export function proposalSummary(file) {
  const p = file?.proposal;
  if (!p || typeof p !== 'object') return '';
  if (p.kind === 'actions') {
    const acts = arr(p.actions).map((a) => (a?.kind === 'expected' ? expectedText(a) : String(a?.text ?? ''))).filter(Boolean);
    if (!acts.length) return '';
    const n = num(p.notes);
    return `From your note: ${acts.join('; ')}.${n > 0 ? ` ${plural(n, 'line')} kept as a note.` : ''}`;
  }
  const s = p.summary;
  if (!s || typeof s !== 'object' || !p.counts) return '';
  const total = typeof s.amount === 'number' && Number.isFinite(s.amount) ? `, ${cash(s.amount)} in total` : '';
  return `${countsText(p.counts)}${total}.${s.totalMessage ? ` ${s.totalMessage}.` : ''}`;
}

// An expected payment as the note states it: direction, date at its stated precision, the relative
// phrase it was resolved from (with the owner's timezone), and the amount or 'amount unknown'.
export function expectedText(a) {
  const who = a.direction === 'outflow' ? `expected outgoing payment to ${a.subject}`
    : `expected ${a.direction === 'inflow' ? 'incoming ' : ''}payment from ${a.subject}`;
  const date = { day: dateText, month: monthYearText, year: (d) => /^\d{4}/.exec(String(d ?? ''))?.[0] ?? '' }[a.datePrecision]?.(a.dueDate) ?? '';
  const when = date ? ` ${a.datePrecision === 'day' ? 'on' : 'in'} ${date}` : ', date unknown';
  const from = a.phrase ? ` (from "${a.phrase}"${a.timezone ? `, ${a.timezone}` : ''})` : '';
  return `${who}${when}${from}, ${cash(a.amount) || 'amount unknown'}`;
}

// The status line after a review: imported row counts, or applied note changes.
function reviewedText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  if (!c.rows && Number.isFinite(Number(c.actions))) return `Applied ${plural(num(c.actions), 'change')}.`;
  return `Imported ${countsText(c)}.`;
}

// A stored value as plain text: lists joined, objects as JSON, booleans as Yes or No.
function valueText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Decided evidence is {text, basis, ancestors} or plain text.
const evidenceText = (e) => (typeof e === 'string' ? e : String((e && e.text) ?? ''));

const cadenceText = (c) => (c && typeof c === 'object' ? String(c.label || '') : String(c || ''));

export function ingestScreens(h) {
  const { api, shell, section, pageHead, btn, icon, esc, draw, getUi, addBtn } = h;
  // Module state survives scenario re-renders (the design redraws the whole page on every change).
  const st = { busy: 0, results: null, retrying: {}, open: {}, rowOpen: {}, undoing: {}, decidedFinal: {}, deck: freshDeck(), origin: null, decidedAll: false, bankOpen: {},
    // Sources: open Manage panels by source id, the action in flight, and the status line of the
    // last action ({ text, receiptId }) with its Undo.
    srcOpen: {}, srcBusy: null, srcNote: null,
    // Import review: correction drafts by proposal id, open Source panels by file id, the review or
    // Undo in flight, the status line ({ text, receiptId }) and receipts already undone.
    drafts: {}, proposalOpen: {}, reviewBusy: null, reviewNote: null, undone: {} };
  const ing = () => api.ingest();

  function chip(state) {
    if (state === 'fresh') return '<span class="h-fresh fresh">Fresh</span>';
    if (state === 'stale') return '<span class="h-fresh stale">Stale</span>';
    if (state === 'history') return '<span class="h-fresh history">History</span>';
    return '';
  }

  function pendingBanner() {
    const n = num(ing().pending);
    if (n <= 0) return '';
    return `<div class="h-ing-banner">${icon('clock')}<span class="h-ing-banner-t"><b>${quickChecksText(n)}</b><span>${minutesText(n)}, so imported files land in the right place.</span></span><a class="h-btn pri h-ing-start" href="#/confirm" data-go="confirm">Start</a></div>`;
  }

  function accountRepairs() {
    syncDeck(false);
    const dk = st.deck;
    const repairs = pendingNow().filter(i => i.context?.repair);
    const recent = dk.hist.flat().filter(id => dk.data[id]?.context?.repair);
    if (!repairs.length && !recent.length) return '';
    const warning = repairs.length ? `<div class="h-ing-banner" role="status" data-account-duplicates><span>Some accounts may be counted twice.</span><a class="h-btn ghost" href="#/confirm" data-go="confirm">Review accounts</a></div>` : '';
    const cards = repairs.map(i => cardHtml(dk, String(i.id), '')).join('');
    const canUndo = dk.busy == null && recent.some(id => !dk.final[id]);
    const undoButton = recent.length ? btn('Undo', `data-deck="undo"${canUndo ? '' : ' disabled'}`, 'ghost') : '';
    return warning + section('Same account?', `${cards}${undoButton}${dk.notice ? `<p role="status">${esc(dk.notice)}</p>` : ''}`, 'Merge keeps your imported account and its history.');
  }

  // The "Same account?" question for one account, the same card and answers as on Accounts, for
  // the account dialog. '' when no pending repair names this account.
  function accountRepairsFor(accountId) {
    syncDeck(false);
    const mine = pendingNow().filter(i => i.context?.repair && (i.context.candidateId === accountId || i.context.ownId === accountId));
    if (!mine.length) return '';
    const cards = mine.map(i => cardHtml(st.deck, String(i.id), '')).join('');
    return section('Same account?', `${cards}${st.deck.notice ? `<p role="status">${esc(st.deck.notice)}</p>` : ''}`, 'Merge keeps your imported account and its history.');
  }

  // One upload result. Another unresolved status shows the same cause as Waiting files.
  function fileRow(f) {
    const s = String(f.status || '');
    const summary = f.restored ? 'Restored this previously removed file.' : s === 'imported' || s === 'duplicate' ? countsText(f.counts)
      : s === 'needs_confirmation' || s === 'needs_clarification' ? 'Review it under Waiting files.' : proposalCause(f);
    const rid = s === 'imported' && f.receipt?.id && !st.undone[f.receipt.id] ? String(f.receipt.id) : '';
    return `<li class="${esc(s)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em>${esc(STATUS[s] || s)}</em></div>${summary ? `<p>${esc(summary)}</p>` : ''}${warningLines(f.counts)}</div>${rid ? undoBtn(rid) : ''}</li>`;
  }

  // Warning sentences under a file, minus the codes its status cause already explains.
  function warningLines(counts) {
    const codes = counts?.warningCodes && typeof counts.warningCodes === 'object' ? counts.warningCodes : {};
    const kept = Object.fromEntries(Object.entries(codes).filter(([k]) => !STATUS_WARNINGS.has(k)));
    return warningText({ ...counts, warningCodes: kept }).map((line) => `<p class="h-mute sm" data-warning>${esc(line)}</p>`).join('');
  }

  const undoBtn = (rid) => btn(st.reviewBusy === 'undo' ? 'Undoing' : 'Undo', `data-review-undo="${esc(rid)}"${st.reviewBusy != null ? ' disabled' : ''}`, 'ghost');

  // The status line of the last review or Undo; '' when there is none.
  function reviewNote() {
    const n = st.reviewNote;
    if (!n) return '';
    return `<div class="h-src-undo" role="status" data-review-note><span>${esc(n.text)}</span>${n.receiptId ? undoBtn(n.receiptId) : ''}</div>`;
  }

  // Waiting files with the status line above them; '' when there is neither.
  function waitingSection() {
    const body = reviewNote() + waitingList();
    return body ? section('Waiting files', body) : '';
  }

  function addFiles(context) {
    const onboarding = context === 'onboarding';
    const busy = st.busy > 0;
    const label = busy ? `Adding ${plural(st.busy, 'file')}` : `${icon('plus')}Add files`;
    let list = '';
    if (st.results) list = `<ul class="h-ing-files" aria-live="polite">${st.results.map(fileRow).join('')}</ul>`;
    else if (onboarding) {
      const files = arr(api.s?.onboarding?.files);
      if (files.length) list = `<ul class="h-files">${files.map((f) => `<li>${icon('doc')}<span>${esc(f.name)}</span><em>${esc(STATUS[f.status] || f.status)}</em></li>`).join('')}</ul>`;
    }
    const control = `<div class="h-ing-ctl">${btn(label, `data-upload-open="1"${busy ? ' disabled aria-busy="true"' : ''}`, onboarding ? 'ghost' : '')}
      <input type="file" multiple data-upload="1" hidden tabindex="-1"></div>`;
    if (onboarding) return `<div class="h-ing-add ob">${list}${control}</div>`;
    const selected = st.gapKind;
    const format = ing().formats.find(f => f.id === selected);
    const type = format ? `<p class="h-mute sm" data-upload-kind="${esc(format.id)}">Selected document: ${esc(format.title)}</p>` : '';
    const lede = type + '<p class="h-mute sm">Exports from banks, cards, brokerages and payroll, profit and loss workbooks, statements and tax forms. Rows already imported are skipped.</p>';
    return section('Add files', `<div class="h-ing-add">${lede}${control}${list}</div>`) + waitingSection();
  }

  function accountMeta(a) {
    const g = (a && ing().accounts[a.id]) || {};
    const asOf = (a && a.asOf) || g.asOf || '';
    const fresh = (a && a.fresh) || g.fresh || 'unknown';
    const d = dateText(asOf);
    if (!d && fresh === 'unknown') return '';
    return `<div class="h-acc-f">${d ? `<span>Last data ${esc(d)}</span>` : ''}${chip(fresh)}</div>`;
  }

  function sourceManage(s) {
    const busy = st.srcBusy != null;
    const accounts = arr(s.accounts).map((a) => {
      const archived = !!a.archived;
      const act = btn(archived ? 'Restore' : 'Archive', `data-src-archive="${esc(a.id)}" data-archived="${archived ? '0' : '1'}"${busy ? ' disabled' : ''}`, 'ghost');
      const merge = archived ? '' : `<a class="h-src-merge" href="#/account/${encodeURIComponent(a.id)}" data-src-merge="${esc(a.id)}">Merge</a>`;
      return `<li class="${archived ? 'archived' : ''}"><span class="h-src-it">${esc(a.label)}${archived ? '<em>Archived</em>' : ''}</span><span class="h-src-acts">${merge}${act}</span></li>`;
    }).join('');
    const files = arr(s.files).map((f) => `<li><span class="h-src-it">${icon('doc')}${esc(f.name)}</span><span class="h-src-acts">${btn('Remove', `data-src-remove="${esc(f.id)}"${busy ? ' disabled' : ''}`, 'ghost')}</span></li>`).join('');
    if (!accounts && !files) return '';
    const id = String(s.id);
    return `<details class="h-src-m" data-src-manage="${esc(id)}"${st.srcOpen[id] ? ' open' : ''}><summary>${icon('chev')}<span>Manage</span></summary>
      ${accounts ? `<ul class="h-src-items" aria-label="Accounts">${accounts}</ul>` : ''}${files ? `<ul class="h-src-items" aria-label="Files">${files}</ul>` : ''}</details>`;
  }

  function sourceNote() {
    const n = st.srcNote;
    if (!n) return '';
    const undo = n.receiptId ? btn(st.srcBusy === 'undo' ? 'Undoing' : 'Undo', `data-src-undo="${esc(n.receiptId)}"${st.srcBusy != null ? ' disabled' : ''}`, 'ghost') : '';
    return `<div class="h-src-undo" role="status"><span>${esc(n.text)}</span>${undo}</div>`;
  }

  function sourcesSection() {
    const g = ing();
    const srcs = g.sources.length
      ? `<ul class="h-srcs h-src-list">${g.sources.map((s) => {
        const range = sourceRangeText(s.range);
        const d = dateText((s.range && s.range.to) || s.asOf);
        const meta = [range ? esc(range) : '', d ? `Last data ${esc(d)}` : 'No dated rows'].filter(Boolean).join('<span class="h-dotsep"></span>');
        return `<li><div class="h-src-top"><div class="h-src-n"><b>${esc(s.name || s.label)}</b><span>${meta}</span></div>${chip(s.state)}</div>${sourceManage(s)}</li>`;
      }).join('')}</ul>`
      : '<p class="h-mute">No files added yet.</p>';
    const fmts = g.formats.length
      ? section('How to export', `<div class="h-howto">${g.formats.map((f) => {
        const id = String(f.id ?? f.title ?? '');
        return `<details data-howto="${esc(id)}"${st.open[id] ? ' open' : ''}><summary>${icon('chev')}<span>${esc(f.title)}</span></summary>
          <ol>${arr(f.steps).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>${f.cadence ? `<p class="h-mute sm">How often: ${esc(cadenceText(f.cadence))}</p>` : ''}</details>`;
      }).join('')}</div>`)
      : '';
    return section('Sources', sourceNote() + srcs, g.sources.length ? plural(g.sources.length, 'source') : '') + fmts;
  }

  // Files that need a review, an answer, readable text or the engine; '' when none. Shared by
  // Files and Confirm.
  function waitingList() {
    const waiting = ing().waiting;
    if (!waiting.length) return '';
    return `<ul class="h-ing-files">${waiting.map(proposalRow).join('')}</ul>`;
  }

  // One waiting file: status, plain cause, then the single control its state needs. Counts and
  // amounts come only from the server's validated summary.
  function proposalRow(f) {
    const p = f.proposal && typeof f.proposal === 'object' ? f.proposal : {};
    const s = proposalStatus(f);
    let ctl = proposalControl(s, { engineOn: !!api.engineOn?.(), reasonCode: proposalReason(f) });
    if ((ctl === 'approve' || ctl === 'answer') && (p.id == null || p.id === '')) ctl = 'retry';
    const summary = proposalSummary(f);
    const sum = summary ? `<p data-proposal-summary>${esc(summary)}</p>` : '';
    const delta = deltaText(p.delta);
    const changed = delta ? `Only this changed since you approved this layout: ${delta}.` : '';
    let body = '';
    let side = '';
    if (ctl === 'approve') body = `${changed ? `<p data-proposal-delta>${esc(changed)}</p>` : ''}${sum}${proposalSource(f)}${reviewBlock(p, true, f.id)}`;
    else if (ctl === 'answer') {
      const q = p.question || changed || 'The file did not check out against its interpretation. Say what the columns mean.';
      body = `<p data-proposal-question>${esc(q)}</p>${sum}${proposalSource(f)}${reviewBlock(p, false, f.id)}`;
    }
    else if (ctl === 'engine') body = `<a class="h-btn ghost" href="#/engine" data-go="engine" data-proposal-engine>${s === 'budget_exhausted' ? 'Check the engine budget' : 'Turn on the engine'}</a>`;
    // Add files here replaces this file: a different file that was read removes it.
    else if (ctl === 'upload') body = `<div class="h-ing-ctl">${btn(`${icon('plus')}Add files`, `data-upload-open="1"${st.busy ? ' disabled' : ''}`, 'ghost')}<input type="file" multiple data-upload="1" hidden tabindex="-1" data-replace-for="${esc(f.id)}"></div>`;
    else if (ctl === 'replace') body = `<div class="h-ing-ctl">${btn(`${icon('plus')}Add files`, `data-replace="${esc(f.id)}"${st.busy ? ' disabled' : ''}`, 'ghost')}<input type="file" multiple data-upload="1" data-replace-for="${esc(f.id)}" hidden tabindex="-1"></div>`;
    else side = btn(st.retrying[f.id] ? 'Retrying' : 'Retry', `data-retry="${esc(f.id)}"${st.retrying[f.id] ? ' disabled' : ''}`, 'ghost');
    const label = fileStateOf(s)?.label ?? STATUS[s] ?? s;
    return `<li class="${esc(s)}" data-proposal-file="${esc(f.id)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em data-proposal-status>${esc(label)}</em></div><p data-proposal-cause>${esc(proposalCause(f))}</p>${warningLines(f.counts)}${body}</div>${side}</li>`;
  }

  // Looks right (approve only) and a correction in the owner's own words. No per-column inputs.
  function reviewBlock(p, approve, fileId) {
    const id = esc(p.id);
    const attrs = `data-version="${esc(p.version)}" data-file="${esc(fileId)}"${st.reviewBusy != null ? ' disabled' : ''}`;
    return `<div class="h-ing-review">${approve ? btn('Looks right', `data-proposal-approve="${id}" ${attrs}`, 'pri') : ''}
      <textarea data-proposal-text="${id}" rows="2" placeholder="Not quite: column C is the spouse's income" aria-label="Correction in your own words">${esc(st.drafts[p.id] ?? '')}</textarea>
      ${btn('Send correction', `data-proposal-correct="${id}" ${attrs}`, 'ghost')}</div>`;
  }

  const fieldText = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

  // Where the summary came from: the file, and for imports each header column and what reads it.
  function proposalSource(f) {
    const p = f.proposal;
    const key = String(f.id);
    let inner = '';
    if (p.kind === 'actions') {
      inner = `<p>From the note ${esc(f.name)}.</p>${num(p.notes) > 0 ? `<p>${esc(plural(num(p.notes), 'line'))} kept as a note.</p>` : ''}`;
    } else {
      const cols = arr(p.columns).map((c) => `<li>Column ${esc(c.ordinal)}, ${esc(c.label)}: ${esc(c.field ? fieldText(c.field) : 'not used')}</li>`).join('');
      inner = `<p>From ${esc(f.name)}. Every count and amount above comes from cells in this file.</p>${cols ? `<ul class="h-ing-cols" aria-label="Columns">${cols}</ul>` : ''}`;
    }
    return `<details class="h-src-m" data-proposal-source="${esc(key)}"${st.proposalOpen[key] ? ' open' : ''}><summary>${icon('chev')}<span>Source</span></summary>${inner}</details>`;
  }

  /* ---------- Confirm deck ----------
     The deck walks units in server order (impact rank, then id). A unit is one item, keyed by its
     id, or a group card keyed 'g:<group>' when two or more pending items share a group. Session
     state lives in st.deck: units in session order, the item ids of each group card, item data
     cached so answered cards can be revisited, answers {id: optionId}, the undo history (each entry an array of item ids, so a group apply undoes as
     one) and final notices {id: message}. cur is the current unit key, or null for the All answered
     end state. busy is the unit key in flight and busyIds the item ids it carries. */

  const STALE_LINE = 'This one changed while you were answering; refreshed.';
  const pendingNow = () => ing().items.filter((i) => !i.status || i.status === 'pending');
  const pendingIds = () => new Set(pendingNow().map((i) => String(i.id)));
  const isGroup = (key) => String(key).startsWith('g:');
  const itemsOf = (dk, key) => (isGroup(key) ? (dk.members[key] || []) : [key]);
  const inFlight = (dk, id) => dk.busyIds.includes(id) || id in dk.rowBusy;
  const unanswered = (dk, id) => dk.answers[id] == null && dk.busy !== id;
  const unitOpen = (dk, key) => (isGroup(key) ? dk.busy !== key && itemsOf(dk, key).some((id) => dk.answers[id] == null) : unanswered(dk, key));
  const unitDone = (dk, key) => itemsOf(dk, key).every((id) => dk.answers[id] != null);
  const unitOf = (dk, id) => Object.keys(dk.members).find((g) => dk.members[g].includes(id)) ?? id;
  const known = (dk, id) => dk.units.includes(id) || Object.values(dk.members).some((m) => m.includes(id));

  function syncDeck(entering) {
    let dk = st.deck;
    const pend = pendingNow();
    const pset = new Set(pend.map((i) => String(i.id)));
    if (dk.demo !== api.demo() || (entering && !pend.some((i) => known(dk, String(i.id))))) {
      dk = st.deck = freshDeck();
      dk.demo = api.demo();
    }
    pend.forEach((i) => { dk.data[String(i.id)] = i; });
    // Pending again after an answer from this session (reopened elsewhere): forget that answer.
    for (const id of pset) if (known(dk, id) && dk.answers[id] != null && !inFlight(dk, id)) dropAnswer(dk, id);
    // New items in server order. A group gets one card when two or more of its items are open:
    // the new ones plus a lone open card of that group already in the session.
    const fresh = pend.filter((i) => !known(dk, String(i.id)));
    const added = [];
    for (const i of fresh) {
      const id = String(i.id);
      const g = i.group ? `g:${i.group}` : null;
      if (g && dk.units.includes(g)) {
        dk.members[g].push(id);
        added.push(g);
        continue;
      }
      if (g) {
        const loners = dk.units.filter((k) => !isGroup(k) && dk.data[k]?.group === i.group && pset.has(k) && unanswered(dk, k));
        const peers = fresh.filter((x) => x.group === i.group);
        if (loners.length + peers.length >= 2) {
          const at = loners.length ? dk.units.indexOf(loners[0]) : dk.units.length;
          dk.units = dk.units.filter((k) => !loners.includes(k));
          dk.units.splice(Math.min(at, dk.units.length), 0, g);
          dk.members[g] = [...loners, id];
          if (loners.includes(dk.cur)) dk.cur = g;
          added.push(g);
          continue;
        }
      }
      dk.units.push(id);
      added.push(id);
    }
    // Drop items that left the queue without an answer from this session (answered elsewhere or
    // by Fathom), and group cards with no rows left.
    const keep = (id) => pset.has(id) || dk.answers[id] != null || inFlight(dk, id);
    const old = dk.units.slice();
    for (const g of Object.keys(dk.members)) dk.members[g] = dk.members[g].filter(keep);
    dk.units = dk.units.filter((k) => (isGroup(k) ? dk.members[k].length > 0 : keep(k)));
    for (const g of Object.keys(dk.members)) if (!dk.units.includes(g)) delete dk.members[g];
    // A group card needs two or more items in the session; a lone one becomes an ordinary item card.
    for (const g of Object.keys(dk.members)) {
      if (dk.members[g].length !== 1 || dk.busy === g) continue;
      const only = dk.members[g][0];
      dk.units[dk.units.indexOf(g)] = only;
      if (dk.cur === g) dk.cur = only;
      old[old.indexOf(g)] = only;
      delete dk.members[g];
    }
    if (dk.cur != null && !dk.units.includes(dk.cur)) {
      const after = old.slice(old.indexOf(dk.cur) + 1).find((k) => dk.units.includes(k));
      dk.cur = after ?? null;
      if (dk.cur != null && !unitOpen(dk, dk.cur)) dk.cur = nextOpen(dk, dk.cur);
    }
    if (dk.cur == null && added.length) dk.cur = added[0];
    const target = String(api.route?.params?.id ?? '');
    if (entering && pset.has(target)) dk.cur = unitOf(dk, target);
    return dk;
  }

  // The undo history without the given item ids, dropping entries left empty.
  const histWithout = (dk, ids) => dk.hist.map((e) => e.filter((x) => !ids.includes(x))).filter((e) => e.length);

  function dropAnswer(dk, id) {
    delete dk.answers[id];
    delete dk.final[id];
    dk.hist = histWithout(dk, [id]);
  }

  // The next open unit after `key` in session order, wrapping; null when every unit is answered.
  function nextOpen(dk, key) {
    const at = dk.units.indexOf(key);
    const order = [...dk.units.slice(at + 1), ...dk.units.slice(0, Math.max(0, at))];
    return order.find((x) => unitOpen(dk, x)) ?? null;
  }

  const undoTarget = (dk) => [...dk.hist].reverse().find((e) => e.some((id) => !dk.final[id])) ?? null;

  function guessOf(it) {
    const g = it && it.guess;
    if (!g || g.option == null) return null;
    const o = visibleOptions(it).find((x) => String(x.id) === String(g.option));
    return o ? { option: String(o.id), label: o.label, evidence: String(g.evidence ?? g.reason ?? '') } : null;
  }

  /* ---------- card context: account view, compare table, values list ---------- */

  const none = '<span class="h-cf-none">Not given</span>';
  const guessTag = '<span class="h-cf-best">Best guess</span>';
  const guessLine = (g) => `Best guess: <b>${esc(g.label)}</b>.${g.evidence ? ` <span class="h-cf-why">${esc(g.evidence)}</span>` : ''}`;
  const CAT_LABEL = "Fathom's categorization";
  const categorizationLine = (g) => `<span class="h-cf-lab">${CAT_LABEL}</span> <b>${esc(g.label)}</b>${g.evidence ? ` <span class="h-cf-why">${esc(g.evidence)}</span>` : ''}`;

  // The transaction a category card asks about: the clean merchant name, signed amount, short date,
  // account and current category, with the bank's own text behind a toggle.
  function txnHead(it, id) {
    const t = it.txn;
    if (!t) return '';
    const amount = cash(t.amount);
    const now = it.context?.category ? `Currently ${it.context.category}` : '';
    const meta = [dateText(t.date), t.account, now].filter(Boolean).map(esc).join('<span class="h-dotsep"></span>');
    const bank = t.raw
      ? `<details class="h-cf-bank" data-bank-details="${esc(id)}"${st.bankOpen[id] ? ' open' : ''}><summary>${icon('chev')}<span>Bank details</span></summary><p>${esc(t.raw)}</p></details>`
      : '';
    return `<div class="h-cf-txn"><div class="h-cf-txn-h"><h3 class="h-cf-merch">${esc(t.name || t.raw)}</h3>${amount ? `<span class="h-cf-amt">${esc(amount)}</span>` : ''}</div>${meta ? `<p class="h-cf-txn-m">${meta}</p>` : ''}${bank}</div>`;
  }

  function rangeText(from, to) {
    const a = dateText(from) || (from ? String(from) : '');
    const b = dateText(to) || (to ? String(to) : '');
    if (a && b) return a === b ? a : `${a} to ${b}`;
    return a || b;
  }

  function rowsText(r) {
    const c = r && typeof r === 'object' ? r : {};
    const parts = [['transactions', 'transaction'], ['balances', 'balance'], ['positions', 'position']]
      .filter(([k]) => num(c[k]) > 0).map(([k, w]) => plural(num(c[k]), w));
    return parts.length ? parts.join(', ') : 'No rows yet';
  }

  // '$1,234.56 on Oct 31, 2026, from file.csv' with the amount in <b>; '' when there is none.
  // fileName names every contributing file.
  function balanceHtml(b, split) {
    if (!b || typeof b !== 'object' || cash(b.amount) === '') return '';
    const when = [dateText(b.date), b.fileName ? `from ${esc(b.fileName)}` : ''].filter(Boolean);
    const basis = b.basis === 'holdings' ? ' (sum of holdings)' : '';
    if (split) return `<b>${esc(cash(b.amount))}</b>${basis}${when.length ? `<span>${when.join(', ')}</span>` : ''}`;
    return `<b>${esc(cash(b.amount))}</b>${basis}${when.length ? ` on ${when.join(', ')}` : ''}`;
  }

  const filesHtml = (files) => (arr(files).length
    ? arr(files).map((f) => `<span class="h-cf-file">${esc(f && typeof f === 'object' ? f.name : f)}</span>`).join('')
    : none);

  // A View field as cell HTML; '' when it has no value.
  function viewCell(v, f) {
    switch (f) {
      case 'institution': return v.institution ? esc(v.institution) : '';
      case 'name': {
        const text = v.label || v.name;
        if (!text) return '';
        if (!v.id) return esc(text);
        const editing = getUi?.()?.accEdit;
        if (editing && editing.id === v.id) {
          return `<input class="h-acc-edit" data-acc-name="${esc(v.id)}" value="${esc(editing.value)}" maxlength="120" aria-label="Account name" autocomplete="off">`;
        }
        return `<button type="button" class="h-acc-name" data-acc-rename="${esc(v.id)}">${esc(text)}</button><button type="button" class="h-acc-pen" data-acc-rename="${esc(v.id)}" aria-label="Rename account">${icon('pen')}</button>`;
      }
      case 'mask': return v.mask ? esc(v.mask) : '';
      case 'holder': return v.holder ? esc(v.holder) : '';
      case 'owner': return v.owner ? esc(OWNER_LABEL[v.owner] || v.owner) : '';
      case 'kind': return v.kind ? esc(KIND_LABEL[v.kind] || v.kind) : '';
      case 'balance': return balanceHtml(v.balance);
      case 'range': return esc(rangeText(v.from, v.to));
      case 'rows': return esc(rowsText(v.rows));
      case 'files': return arr(v.files).length ? filesHtml(v.files) : '';
      default: return '';
    }
  }

  const ACCT_FIELDS = [
    ['name', 'Account'], ['institution', 'Institution'], ['mask', 'Ends in'], ['holder', 'Holder in the source'],
    ['owner', 'Owner'], ['kind', 'Type'], ['balance', 'Latest balance'], ['range', 'Dates'], ['rows', 'Rows'], ['files', 'Files']
  ];
  // differs names View fields; the range cell covers from and to.
  const differsSet = (d) => {
    const s = new Set(arr(d && d.differs).map(String));
    if (s.has('from') || s.has('to')) s.add('range');
    return s;
  };
  const mark = (s, f) => (s.has(f) ? ' data-differs="1"' : '');

  function acctPanel(v, d) {
    if (!v) return '';
    const diff = differsSet(d);
    const cells = ACCT_FIELDS.map(([f, label]) => {
      const html = viewCell(v, f);
      // Owner and type show only once they are known; every other field always shows.
      if (!html && (f === 'owner' || f === 'kind')) return '';
      const val = html || (f === 'holder' ? 'Not in the source' : f === 'balance' ? 'No balance yet' : 'Not given');
      return `<div data-field="${f}"${mark(diff, f)}><dt>${label}</dt>
<dd>${html ? val : `<span class="h-cf-none">${val}</span>`}</dd></div>`;
    }).join('');
    const recent = recentList(v.recent, 'Recent transactions');
    return `<div class="h-cf-acct"><dl>${cells}</dl>${recent}</div>`;
  }

  // Newest rows as a list, each with its file; fileName overrides a row's own (SimpleFIN rows).
  function recentList(rows, label, fileName) {
    if (!arr(rows).length) return '';
    return `<p class="h-cf-sub">${esc(label)}</p><ul class="h-cf-recent">${arr(rows).map((r) => `<li><span class="d">${esc(dateText(r.date) || r.date || '')}</span>${r.name && r.description && r.name !== r.description ? `<span class="t" title="${esc(r.description)}">${esc(r.name)}</span>` : `<span class="t">${esc(r.description || '')}</span>`}<span class="a">${esc(cash(r.amount))}</span><span class="f">${esc(fileName || r.fileName || '')}</span></li>`).join('')}</ul>`;
  }

  const SAME_COLS = [
    ['institution', 'Institution'], ['mask', 'Ends in'], ['holder', 'Holder'], ['owner', 'Owner'], ['kind', 'Type'],
    ['balance', 'Latest balance'], ['range', 'Dates'], ['files', 'Files']
  ];

  // The account and its same-named accounts side by side, one row each; differing cells marked.
  function sameTable(v, d) {
    const others = arr(d && d.sameName);
    if (!v || !others.length) return '';
    const diff = differsSet(d);
    const all = [v, ...others];
    const cols = SAME_COLS.filter(([f]) => diff.has(f) || all.some((x) => viewCell(x, f)));
    const head = `<tr><th scope="col">Account</th>${cols.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr>`;
    const rows = all.map((x, i) => `<tr data-account="${esc(x.id)}"${i ? '' : ' class="me"'}><th scope="row">${i ? 'Other' : 'This one'}</th>${cols.map(([f]) => {
      const html = viewCell(x, f);
      return `<td data-field="${f}"${mark(diff, f)}>${html || none}</td>`;
    }).join('')}</tr>`).join('');
    const n = others.length;
    return `<p class="h-cf-sub">${plural(n, 'other account')} named ${esc(v.name || 'the same')}.${diff.size ? ' Marked cells differ.' : ''}</p>
      <div class="h-cf-scroll"><table class="h-cf-same"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }

  const COMPARE_LABEL = {
    date: 'Date', amount: 'Amount', description: 'Description', account: 'Account', file: 'File', payer: 'Payer',
    jurisdiction: 'Jurisdiction', taxYear: 'Tax year', recipient: 'Recipient', institution: 'Institution', name: 'Name',
    mask: 'Ends in', balance: 'Balance', balanceDate: 'Balance date', from: 'First date', to: 'Last date', count: 'Transactions'
  };

  function compareCell(f, v, e) {
    if (v == null || v === '') return none;
    // A bank description reads by its name; the raw text stays on hover.
    if (f === 'description' && e && typeof e.name === 'string' && e.name && e.name !== v) return `<span title="${esc(valueText(v))}">${esc(e.name)}</span>`;
    if (f === 'amount' || f === 'balance') return esc(cash(v) || String(v));
    if (f === 'date' || f === 'balanceDate' || f === 'from' || f === 'to') return esc(dateText(v) || String(v));
    return esc(valueText(v));
  }

  function compareTable(d, it) {
    const entries = arr(d.entries);
    if (!entries.length) return '';
    const diff = new Set(arr(d.differs).map(String));
    const heads = entries.map((_, i) => (it.kind === 'account_match' ? (i === 0 ? 'Imported' : 'SimpleFIN') : `Entry ${i + 1}`));
    const head = `<tr><th scope="col"><span class="h-cf-sr">Field</span></th>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr>`;
    const rows = arr(d.fields).map((f) => `<tr data-field="${esc(f)}"${diff.has(String(f)) ? ' data-differs="1"' : ''}><th scope="row">${esc(COMPARE_LABEL[f] || f)}</th>${entries.map((e) => `<td>${compareCell(f, e && e[f], e)}</td>`).join('')}</tr>`).join('');
    return `<div class="h-cf-scroll"><table class="h-cf-compare"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${diff.size ? '<p class="h-cf-sub">Marked rows differ.</p>' : ''}`;
  }

  // account_match: the imported candidate's own panel and same-named accounts (no differs marks:
  // the card's differs belong to the compare table), then the SimpleFIN snapshot's newest rows.
  function matchContext(d, it) {
    if (it.kind !== 'account_match') return '';
    const v = d.account && typeof d.account === 'object' ? d.account : null;
    const same = { sameName: d.sameName };
    const panel = v ? `<p class="h-cf-sub">Imported account</p>${acctPanel(v, same)}${sameTable(v, same)}` : '';
    const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {};
    return panel + recentList(snap.recent, 'Recent transactions in SimpleFIN', 'SimpleFIN');
  }

  function valuesList(d) {
    const rows = arr(d.values).map((v) => `<div><dt>${esc(v.label)}</dt>
<dd>${v.value == null || v.value === '' ? none : esc(valueText(v.value))}</dd></div>`);
    if (d.file && d.file.name) rows.push(`<div data-field="file"><dt>File</dt>
<dd>${esc(d.file.name)}</dd></div>`);
    return rows.length ? `<dl class="h-cf-values">${rows.join('')}</dl>` : '';
  }

  function detailHtml(it) {
    const d = it && it.detail;
    if (!d || typeof d !== 'object') return '';
    let body = '';
    if (d.type === 'account') body = acctPanel(d.account, d) + sameTable(d.account, d);
    else if (d.type === 'compare') body = compareTable(d, it) + matchContext(d, it);
    else if (d.type === 'values') body = valuesList(d);
    return body ? `<div class="h-cf-detail">${body}</div>` : '';
  }

  /* ---------- cards ---------- */

  function cardHtml(dk, id, fileName) {
    const it = dk.data[id];
    const fin = dk.final[id];
    const busy = dk.busy === id;
    const chosen = busy && dk.busyOpt != null ? dk.busyOpt : dk.answers[id];
    const g = guessOf(it);
    const opts = visibleOptions(it).map((o, n) => {
      const on = chosen != null && String(chosen).replace(/^always:/,'') === String(o.id);
      const isG = !!g && g.option === String(o.id);
      const attrs = `data-answer="${esc(id)}" data-option="${esc(o.id)}" aria-pressed="${on}"${isG ? ' data-guess="1"' : ''}${busy || fin ? ' disabled' : ''}`;
      return btn(`<span class="h-deck-n">${n + 1}</span> · ${esc(o.label)}${isG ? guessTag : ''}`, attrs, on ? 'pri' : (isG && chosen == null ? 'guess' : ''));
    }).join('');
    const short = visibleOptions(it).every((o) => String(o.label ?? '').length <= 24);
    const name = it.fileName || fileName || '';
    const take = g && !fin && String(chosen ?? '') !== g.option
      ? btn('Use best guess', `data-take-guess="${esc(id)}"${busy ? ' disabled' : ''}`, 'pri h-cf-take')
      : '';
    const cat = !!it.txn;
    const guess = g ? `<div class="h-cf-gl"><p class="h-cf-guess">${cat ? categorizationLine(g) : guessLine(g)}</p>${take}</div>` : '';
    const state = fin
      ? `<p class="h-cf-final" role="status">${esc(fin)}</p>`
      : (dk.answers[id] != null && !busy ? '<p class="h-deck-state">Answered. Pick another option to change it.</p>' : '');
    return `<article class="h-deck-card cur${fin ? ' final' : ''}" data-item="${esc(id)}">
      <div class="h-cf-k">${esc(KIND[it.kind] || 'Question')}${name ? `<span>${esc(name)}</span>` : ''}${addBtn('confirm', id, KIND[it.kind] || 'Question')}</div>
      ${cat ? txnHead(it, id) : `<p class="h-cf-q">${esc(it.question)}</p>${detailHtml(it)}`}${guess}${it.kind === 'transaction_category' && it.context?.merchant ? `<label class="h-cf-sub"><input type="checkbox" data-category-always="${esc(id)}"${dk.categoryAlways?.[id] !== false ? ' checked' : ''}${busy || fin ? ' disabled' : ''}> Apply to all from ${esc(it.txn?.name || it.context.merchant)}</label>` : ''}<div class="h-deck-opts${short ? ' short' : ''}">${opts}</div>${state}</article>`;
  }

  function rowHtml(dk, key, id) {
    const it = dk.data[id];
    const d = (it && it.detail) || {};
    const v = d.type === 'account' && d.account ? d.account : null;
    const busy = dk.busy === key;
    const saving = id in dk.rowBusy;
    const mine = saving || (busy && dk.busyIds.includes(id));
    const answered = dk.answers[id] != null;
    const fin = dk.final[id];
    const chosen = saving ? dk.rowBusy[id] : (mine && dk.busyOpt != null ? dk.busyOpt : dk.answers[id]);
    const g = guessOf(it);
    const opts = visibleOptions(it).map((o) => {
      const on = chosen != null && String(chosen) === String(o.id);
      const isG = !!g && g.option === String(o.id);
      const attrs = `data-row-answer="${esc(id)}" data-option="${esc(o.id)}" aria-pressed="${on}"${isG ? ' data-guess="1"' : ''}${busy || saving || fin ? ' disabled' : ''}`;
      return btn(`${esc(o.label)}${isG ? guessTag : ''}`, attrs, on ? 'pri' : (isG && chosen == null ? 'guess' : ''));
    }).join('');
    const others = arr(d.sameName).length;
    const flag = others ? `<span class="h-cf-flag">Same name as ${plural(others, 'other account')}</span>` : '';
    const where = v && v.institution ? esc(v.institution) : '';
    const acct = `<td data-col="account"><b>${esc(v ? (v.label || v.name || 'Unnamed account') : it.question)}</b>${addBtn('confirm', id, v ? (v.label || v.name || 'Unnamed account') : (KIND[it.kind] || 'Question'))}${flag}${where ? `<span>${where}</span>` : ''}</td>`;
    const holder = `<td data-col="holder" data-l="Holder">${v && v.holder ? esc(v.holder) : '<span class="h-cf-none">Not in the source</span>'}</td>`;
    const bal = `<td data-col="balance" data-l="Latest balance">${(v && balanceHtml(v.balance, true)) || '<span class="h-cf-none">No balance yet</span>'}</td>`;
    const range = `<td data-col="range" data-l="Dates">${(v && esc(rangeText(v.from, v.to))) || '<span class="h-cf-none">No dated rows</span>'}</td>`;
    const why = g && !answered ? `<p class="h-cf-rwhy">${guessLine(g)}</p>` : '';
    const state = fin
      ? `<p class="h-cf-rstate">${esc(fin)}</p>`
      : (answered && !mine ? `<p class="h-cf-rstate">Saved ${btn('Undo', `data-row-undo="${esc(id)}"${busy ? ' disabled' : ''}`, 'ghost')}</p>` : '');
    const ans = `<td class="h-cf-ans"><div class="h-cf-ropts" role="group" aria-label="${esc(v ? v.name || 'Account' : 'Answer')}">${opts}</div>${why}${state}</td>`;
    const det = v
      ? `<td class="h-cf-gx"><details data-row-detail="${esc(id)}"${st.rowOpen[id] ? ' open' : ''}><summary>${icon('chev')}<span>Account detail</span></summary>${acctPanel(v, d)}${sameTable(v, d)}</details></td>`
      : '';
    return `<tr data-row="${esc(id)}"${others ? ' data-same="1"' : ''}${answered ? ' class="done"' : ''}>${acct}${holder}${bal}${range}${ans}${det}</tr>`;
  }

  function groupHtml(dk, key) {
    const kind = key.slice(2);
    const ids = itemsOf(dk, key);
    const busy = dk.busy === key;
    const take = guessRows(dk, key);
    const head = '<thead><tr><th scope="col">Account</th><th scope="col">Holder</th><th scope="col">Latest balance</th><th scope="col">Dates</th><th scope="col"><span class="h-cf-sr">Answer</span></th></tr></thead>';
    const rows = ids.map((id) => rowHtml(dk, key, id)).join('');
    const finals = [...new Set(ids.map((id) => dk.final[id]).filter(Boolean))];
    const note = `${ids.filter((id) => dk.answers[id] != null).length} of ${ids.length} answered.`;
    const accept = take.length ? btn(acceptLabel(take.length), `data-group-apply="${esc(key)}"${busy ? ' disabled' : ''}`, 'pri') : '';
    const foot = `<div class="h-cf-gfoot"><p>${note}</p>${accept}</div>`;
    const state = finals.map((f) => `<p class="h-cf-final" role="status">${esc(f)}</p>`).join('');
    return `<article class="h-deck-card cur group" data-group="${esc(kind)}">
      <div class="h-cf-k">${esc(KIND[kind] || 'Questions')}<span>${plural(ids.length, 'account')}</span>${addBtn('confirm', `group:${kind}`, KIND[kind] || 'Questions')}</div>
      <p class="h-cf-q">${esc(GROUP_Q[kind] || 'Answer each row.')}</p>
      <table class="h-cf-group">${head}<tbody>${rows}</tbody></table>${foot}${state}</article>`;
  }

  // The unanswered rows of group card `key` that have a best guess: [{id, answer}].
  function guessRows(dk, key) {
    const pend = pendingIds();
    return itemsOf(dk, key)
      .filter((id) => dk.answers[id] == null && !dk.final[id] && pend.has(id) && !(id in dk.rowBusy))
      .map((id) => ({ id, answer: guessOf(dk.data[id])?.option ?? null }))
      .filter((x) => x.answer != null);
  }

  function decidedRow(d) {
    const id = String(d.id);
    const t = d.txn;
    const fin = d.final ? (FINAL_TEXT[d.final] || String(d.final)) : st.decidedFinal[id];
    const ctl = fin
      ? `<p class="h-decided-final">${esc(fin)}</p>`
      : btn('Undo', `data-decided-undo="${esc(id)}"${st.undoing[id] ? ' disabled' : ''}`, 'ghost');
    const ev = evidenceText(d.evidence).trim();
    const repeatsLabel = ev.replace(/[.!?]+$/, '').trim().toLowerCase() === CAT_LABEL.toLowerCase();
    const reason = ev.replace(new RegExp(`^${CAT_LABEL}[:.]`, 'i'), '').trim();
    const detail = reason !== ev ? reason.charAt(0).toUpperCase() + reason.slice(1) : reason;
    const why = t ? `${CAT_LABEL}.${detail && !repeatsLabel ? ` ${detail}` : ''}` : ev;
    const amount = t ? cash(t.amount) : '';
    const when = t ? dateText(t.date) : '';
    const side = amount || when ? `<div class="h-decided-s">${amount ? `<span class="h-decided-amt">${esc(amount)}</span>` : ''}${when ? `<span>${esc(when)}</span>` : ''}</div>` : '';
    return `<li data-decided="${esc(id)}"><div class="h-decided-b"><div class="h-decided-t"><span class="h-decided-n"${t && t.raw && t.name && t.raw !== t.name ? ` title="${esc(t.raw)}"` : ''}>${esc(t ? (t.name || t.raw) : (d.question || KIND[d.kind] || 'Question'))}</span><span class="h-decided-cat">${esc(d.answerLabel || d.answer || '')}</span></div>${why ? `<p class="h-decided-e">${esc(why)}</p>` : ''}</div>${side}${ctl}</li>`;
  }

  function decidedSection() {
    const list = ing().decided;
    if (!list.length) return '';
    const more = list.length > DECIDED_VISIBLE;
    const rows = (more && !st.decidedAll ? list.slice(0, DECIDED_VISIBLE) : list).map(decidedRow).join('');
    const toggle = more ? `<p class="h-decided-more">${btn(st.decidedAll ? 'Show fewer' : `Show all ${list.length}`, 'data-decided-more="1"', 'ghost')}</p>` : '';
    const selected = st.gapKind;
    const format = ing().formats.find(f => f.id === selected);
    const type = format ? `<p class="h-mute sm" data-upload-kind="${esc(format.id)}">Selected document: ${esc(format.title)}</p>` : '';
    const lede = type + '<p class="h-mute sm">Fathom answered these from your files and your own answers. Undo puts one back in the deck, and Fathom will not answer it again.</p>';
    return section('Decided for you', `${lede}<ul class="h-decided-l">${rows}</ul>${toggle}`, plural(list.length, 'answer'), 'h-cf-decided');
  }

  // Items answered and items in all, across the deck's cards.
  function tally(dk) {
    const ids = dk.units.flatMap((k) => itemsOf(dk, k));
    return { done: ids.filter((id) => dk.answers[id] != null).length, total: ids.length };
  }

  const backText = () => {
    const l = st.origin && ORIGIN_LABEL[st.origin.name];
    if (!st.origin) return 'Back to Home';
    return l ? `Back to ${l}` : 'Back';
  };

  function confirmPage(entering) {
    const dk = syncDeck(entering);
    const files = new Map(ing().files.map((f) => [String(f.id), f.name]));
    const n = dk.units.length;
    const caught = (title, line) => `<div class="h-empty"><i class="h-ok sm">${icon('check')}</i><div><b>${title}</b><p>${line}</p><p>${btn(backText(), 'data-deck-home="1"', 'pri')}</p></div></div>`;
    let deck;
    if (!n) deck = `<div class="h-deck">${caught('All caught up', 'New questions show up here when an import needs one.')}</div>`;
    else {
      const at = dk.cur == null ? n : dk.units.indexOf(dk.cur);
      const { done, total } = tally(dk);
      const canUndo = dk.busy == null && undoTarget(dk) != null;
      const note = dk.notice ? `<p class="h-deck-notice" role="status">${esc(dk.notice)}</p>` : '';
      const top = `<div class="h-deck-top"><span class="h-deck-pos" data-deck-progress>${Math.min(at + 1, n)} of ${n}</span>
        <span class="h-deck-ans" data-deck-answered>${done} of ${total} answered</span>
        <div class="h-deck-bar" role="progressbar" aria-label="Answered" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
        ${btn('Undo', `data-deck="undo"${canUndo ? '' : ' disabled'}`, 'ghost')}</div>`;
      let stack;
      if (dk.cur == null) {
        const left = dk.units.flatMap((k) => itemsOf(dk, k)).filter((id) => dk.answers[id] == null).length;
        stack = left
          ? caught(`${plural(left, 'question')} still open.`, 'Prev goes back to them.')
          : caught('All answered', 'Every question here is answered. Prev goes back to the last card.');
      }
      else {
        const peeks = dk.units.slice(at + 1, at + 3).map((_, i) => `<div class="h-deck-peek p${i + 1}" aria-hidden="true"></div>`).reverse().join('');
        const card = isGroup(dk.cur) ? groupHtml(dk, dk.cur) : cardHtml(dk, dk.cur, files.get(String(dk.data[dk.cur].fileId)));
        stack = `<div class="h-deck-stack${peeks ? ` n${Math.min(2, n - at - 1)}` : ''}">${peeks}${card}</div>`;
      }
      const mode = forwardMode(dk);
      let fwd = '<span></span>';
      if (mode === 'done') fwd = btn('Done', 'data-deck="done"', 'pri');
      else if (mode === 'open') fwd = btn('Next open →', 'data-deck="next"', 'ghost');
      else if (mode === 'next') fwd = btn('Next →', 'data-deck="next"', 'ghost');
      const hint = '<p class="h-deck-hint"><span class="kb">1 to 9 answer, Enter takes the best guess, J and K move, Z undoes, Esc goes to Year, ? for all shortcuts</span><span class="tch">Swipe right for the next card, left for the previous one</span></p>';
      const nav = `<div class="h-deck-nav">${btn('← Prev', `data-deck="prev"${at > 0 ? '' : ' disabled'}`, 'ghost')}${hint}${fwd}</div>`;
      deck = `<div class="h-deck">${top}${note}${stack}${nav}</div>`;
    }
    const wait = reviewNote() + (waitingList() || '<p class="h-mute">No files are waiting.</p>');
    return shell(`${pageHead('Household', 'Confirm', 'A few short questions so imports land in the right place.')}
      <div class="h-cols"><div class="h-col-main">${deck}${decidedSection()}</div>
      <div class="h-col-side">${section('Waiting files', wait)}</div></div>`);
  }

  // What forward does from the current card, which is also what the button says:
  // 'done' ends on the finished block (nothing open anywhere, or this last card is the only open
  // one), 'open' wraps from the last card to the first open one, 'next' goes to the next card.
  function forwardMode(dk) {
    if (dk.cur == null || !dk.units.length) return null;
    if (!dk.units.some((k) => unitOpen(dk, k))) return 'done';
    if (dk.units.indexOf(dk.cur) < dk.units.length - 1) return 'next';
    return nextOpen(dk, dk.cur) != null ? 'open' : 'done';
  }

  // Go forward per forwardMode().
  function forward() {
    const dk = st.deck;
    const mode = forwardMode(dk);
    if (mode == null) return false;
    dk.cur = mode === 'done' ? null : (mode === 'open' ? nextOpen(dk, dk.cur) : dk.units[dk.units.indexOf(dk.cur) + 1]);
    draw();
    return true;
  }

  // Move by d units: forward per forward(), back one card at a time (from All answered to the last).
  function move(d) {
    if (d > 0) return forward();
    const dk = st.deck;
    const n = dk.units.length;
    if (!n) return false;
    const at = dk.cur == null ? n : dk.units.indexOf(dk.cur);
    if (at + d < 0) return false;
    dk.cur = dk.units[at + d];
    draw();
    return true;
  }

  // Answer (or revise) item `id` with `opt`. A single card moves on to the next open unit; with
  // `stay` (a group row) the card stays and only that row is in flight, tracked in dk.rowBusy so
  // other rows can be saved while it is.
  function pick(id, opt, stay = false) {
    const dk = st.deck;
    const it = dk.data[id];
    if (dk.busy != null || (stay && id in dk.rowBusy) || isGroup(id) || dk.final[id] || !it || !visibleOptions(it).some((o) => String(o.id) === String(opt))) return false;
    if (dk.answers[id] != null && String(dk.answers[id]) === String(opt)) {
      if (!stay && dk.cur === id) { dk.cur = nextOpen(dk, id); draw(); }
      return true;
    }
    opt = categoryAnswerOption(it,opt,dk.categoryAlways?.[id] !== false);
    if (opt == null) return false;
    const revise = !pendingNow().some((i) => String(i.id) === id);
    if (stay) dk.rowBusy[id] = String(opt);
    else {
      dk.busy = id;
      dk.busyIds = [id];
      dk.busyOpt = String(opt);
    }
    draw();
    dk.notice = '';
    const req = revise ? api.reviseAnswer(id, opt) : api.answer(id, opt);
    req.then((r) => {
      if (stay) delete dk.rowBusy[id];
      else {
        dk.busy = null;
        dk.busyIds = [];
        dk.busyOpt = null;
      }
      if (st.deck === dk && r) {
        if (r.stale) {
          // The question changed while it was being answered: the scenario was refetched, so move on.
          dk.notice = STALE_LINE;
          if (!stay && dk.cur === id) dk.cur = nextOpen(dk, id);
          syncDeck(false);
        } else if (r.final) {
          dk.final[id] = r.final;
          dk.hist = histWithout(dk, [id]);
        } else {
          dk.answers[id] = String(opt);
          dk.hist = [...histWithout(dk, [id]), [id]];
          if (!stay && dk.cur === id) dk.cur = nextOpen(dk, id);
        }
      }
      draw();
    });
    return true;
  }

  // Take the best guess of every unanswered row of group card `key` that has one, in one request.
  // The card stays; rows without a guess are left for the person.
  function apply(key) {
    const dk = st.deck;
    if (dk.busy != null || !isGroup(key) || !dk.units.includes(key)) return false;
    const list = guessRows(dk, key);
    if (!list.length) return false;
    const ids = list.map((x) => x.id);
    dk.busy = key;
    dk.busyIds = ids;
    dk.notice = '';
    draw();
    api.answerMany(list).then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      if (st.deck === dk && r) {
        if (r.stale) {
          dk.notice = STALE_LINE;
          syncDeck(false);
        } else if (r.final) {
          dk.notice = r.final;
        } else {
          list.forEach((x) => { dk.answers[x.id] = String(x.answer); });
          dk.hist = [...histWithout(dk, ids), ids];
          syncDeck(false);
        }
      }
      draw();
    });
    return true;
  }

  // Reopen the most recent non-final answer entry of this session (one card, or a whole group
  // apply) and move to its card.
  function undo() {
    const dk = st.deck;
    const entry = dk.busy == null ? undoTarget(dk) : null;
    if (entry == null) return false;
    const key = unitOf(dk, entry[0]);
    dk.busy = key;
    dk.busyIds = [...entry];
    draw();
    const req = isGroup(key) ? api.reopenMany(entry) : api.reopenAnswer(entry[0]);
    req.then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      if (st.deck === dk && r) {
        if (r.final) {
          entry.forEach((id) => { dk.final[id] = r.final; });
          dk.hist = dk.hist.filter((e) => e !== entry);
        } else if (r.stale) {
          dk.notice = STALE_LINE;
        } else entry.forEach((id) => dropAnswer(dk, id));
        syncDeck(false);
        if (dk.units.includes(key)) dk.cur = key;
      }
      draw();
    });
    return true;
  }

  // Put one saved group row back, leaving the rest of the card as it is.
  function undoRow(id) {
    const dk = st.deck;
    if (dk.busy != null || id in dk.rowBusy || dk.answers[id] == null || !known(dk, id)) return false;
    dk.busy = unitOf(dk, id);
    dk.busyIds = [id];
    draw();
    api.reopenAnswer(id).then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      if (st.deck === dk && r) {
        if (r.final) {
          dk.final[id] = r.final;
          dk.hist = histWithout(dk, [id]);
        } else if (r.stale) {
          dk.notice = STALE_LINE;
        } else dropAnswer(dk, id);
        syncDeck(false);
      }
      draw();
    });
    return true;
  }

  // Undo an answer Fathom recorded itself (the Decided for you list).
  function undoDecided(id) {
    if (st.undoing[id]) return;
    st.undoing[id] = true;
    draw();
    api.reopenAnswer(id).then((r) => {
      delete st.undoing[id];
      if (r && r.final) st.decidedFinal[id] = r.final;
      draw();
    });
  }

  // Runs a deck action from the key registry (rows from deckBindings). Held keys never repeat an answer or an undo.
  function deckAction(action, e) {
    if (api.route?.name !== 'confirm') return false;
    const dk = st.deck;
    const group = dk.cur != null && isGroup(dk.cur);
    const cur = dk.cur != null && !group ? dk.data[dk.cur] : null;
    if (e?.repeat && ['pick', 'guess', 'undo'].includes(action)) return true;
    switch (action) {
      case 'pick': {
        const o = cur && visibleOptions(cur)[Number(e?.key) - 1];
        return o ? pick(dk.cur, o.id) : false;
      }
      case 'guess': {
        if (group) return apply(dk.cur);
        const g = guessOf(cur);
        return g ? pick(dk.cur, g.option) : false;
      }
      case 'next': return forward() || true;
      case 'prev': return move(-1) || true;
      case 'undo': return undo() || true;
      case 'leave': api.go('home'); return true;
      default: return false;
    }
  }

  // Touch and pen swipes on the current card: it follows the finger, swipe right goes to the next
  // card, left to the previous one, and a short drag springs back. A swipe never answers, and a drag
  // that starts on a control, a detail toggle or a scrolling table is left to it.
  const handlePointer = createSwipe({
    when: () => api.route?.name === 'confirm',
    card: 'article.h-deck-card.cur',
    ignore: 'button,a,input,textarea,select,summary,.h-cf-scroll',
    onSwipe: (dir) => move(dir)
  });

  function openUpload(kind) {
    const format = ing().formats.find(f => f.id === kind);
    if (!format) return;
    st.gapKind = kind;
    draw();
    const input = document.querySelector('input[type=file][data-upload]:not([data-replace-for])');
    if (input) { input.accept = ['pnl', 'estimates'].includes(kind) ? '.xlsx,.csv' : kind === 'paystub' || kind === 'taxforms' ? '.pdf,.txt' : '.csv,.pdf,.xlsx'; input.click(); }
  }

  // A replacement upload (data-replace-for) removes the file it replaces once every new file was read
  // and none is that file itself (identical bytes answer the same file id).
  function upload(input) {
    const files = Array.from(input.files || []);
    const replaces = String(input.dataset?.replaceFor ?? '');
    input.value = '';
    if (!files.length || st.busy) return;
    st.busy = files.length;
    draw();
    api.upload(files).then((res) => {
      st.busy = 0;
      const out = res && Array.isArray(res.files) ? res.files : null;
      if (out) st.results = out;
      if (!replaces || !out?.length || out.some((f) => String(f?.fileId ?? '') === replaces || UNREAD.has(String(f?.status ?? '')))) return draw();
      return Promise.resolve(api.removeFile(replaces)).then(() => draw());
    });
  }

  // One tap source actions: no confirm step, a status line with Undo after each.
  function sourceAction(kind, run, text) {
    if (st.srcBusy != null) return;
    st.srcBusy = kind;
    draw();
    Promise.resolve(run()).then((r) => {
      st.srcBusy = null;
      if (r) st.srcNote = r.receipt ? { text, receiptId: r.receipt.id } : { text, receiptId: null };
      draw();
    });
  }

  // One review or Undo in flight at a time; the status line reports the result.
  // A stale proposal is restaged by the client and redrawn with its current summary.
  function review(id, version, decision, evidence, fileId) {
    if (st.reviewBusy != null) return;
    st.reviewBusy = id;
    draw();
    Promise.resolve(api.reviewImport(id, version, decision, evidence, fileId)).then((r) => {
      st.reviewBusy = null;
      if (r?.stale) st.reviewNote = { text: 'This file changed since its summary was written. Here is the current one.', receiptId: null };
      else if (r && decision === 'correct') {
        delete st.drafts[id];
        st.reviewNote = { text: 'Correction saved. Fathom reads the file again with it when the engine runs.', receiptId: null };
      } else if (r) st.reviewNote = { text: reviewedText(r.counts), receiptId: r.receipt?.id ?? null };
      draw();
    });
  }

  function undoReview(receiptId) {
    if (st.reviewBusy != null) return;
    st.reviewBusy = 'undo';
    draw();
    Promise.resolve(api.actionUndo(receiptId)).then((r) => {
      st.reviewBusy = null;
      if (r) {
        st.undone[receiptId] = true;
        st.reviewNote = { text: 'Undone.', receiptId: null };
      }
      draw();
    });
  }

  function accountLabelOf(id) {
    for (const s of arr(ing().sources)) for (const a of arr(s.accounts)) if (a.id === id) return String(a.label || '');
    return '';
  }

  function fileNameOf(id) {
    for (const s of arr(ing().sources)) for (const f of arr(s.files)) if (f.id === id) return String(f.name || '');
    return '';
  }

  function undoSource(receiptId) {
    if (st.srcBusy != null) return;
    st.srcBusy = 'undo';
    draw();
    Promise.resolve(api.actionUndo(receiptId)).then((r) => {
      st.srcBusy = null;
      if (r) st.srcNote = { text: 'Undone.', receiptId: null };
      draw();
    });
  }

  function handleClick(e) {
    const t = e.target.closest?.('[data-upload-open],[data-replace],[data-answer],[data-row-answer],[data-row-undo],[data-group-apply],[data-take-guess],[data-decided-undo],[data-decided-more],[data-deck],[data-deck-home],[data-retry],[data-src-archive],[data-src-remove],[data-src-undo],[data-src-merge],[data-proposal-approve],[data-proposal-correct],[data-review-undo],details[data-howto] > summary,details[data-row-detail] > summary,details[data-bank-details] > summary,details[data-src-manage] > summary,details[data-proposal-source] > summary');
    if (!t) return false;
    if (t.tagName === 'SUMMARY') {
      // The native toggle runs; the open state is kept so a redraw does not close it.
      const d = t.parentElement;
      if (d.dataset.rowDetail) st.rowOpen[d.dataset.rowDetail] = !d.open;
      else if (d.dataset.bankDetails) st.bankOpen[d.dataset.bankDetails] = !d.open;
      else if (d.dataset.srcManage) st.srcOpen[d.dataset.srcManage] = !d.open;
      else if (d.dataset.proposalSource) st.proposalOpen[d.dataset.proposalSource] = !d.open;
      else st.open[d.dataset.howto] = !d.open;
      return true;
    }
    e.preventDefault();
    const d = t.dataset;
    if (d.uploadOpen || d.replace) {
      if (!st.busy) t.parentElement.querySelector('input[type=file][data-upload]')?.click();
      return true;
    }
    if (d.answer) {
      pick(d.answer, d.option);
      return true;
    }
    if (d.rowAnswer) {
      if (pick(d.rowAnswer, d.option, true)) {
        t.ownerDocument.querySelector(`[data-row-answer="${CSS.escape(d.rowAnswer)}"][data-option="${CSS.escape(d.option)}"]`)?.focus();
      }
      return true;
    }
    if (d.rowUndo) {
      undoRow(d.rowUndo);
      return true;
    }
    if (d.groupApply) {
      apply(d.groupApply);
      return true;
    }
    if (d.takeGuess) {
      const g = guessOf(st.deck.data[d.takeGuess]);
      if (g) pick(d.takeGuess, g.option);
      return true;
    }
    if (d.decidedUndo) {
      undoDecided(d.decidedUndo);
      return true;
    }
    if (d.decidedMore) {
      st.decidedAll = !st.decidedAll;
      draw();
      return true;
    }
    if (d.deckHome) {
      const o = st.origin;
      if (o) api.go(o.name, o.params);
      else api.go('home');
      return true;
    }
    if (d.deck) {
      if (d.deck === 'undo') undo();
      else if (d.deck === 'done') forward();
      else move(d.deck === 'next' ? 1 : -1);
      t.ownerDocument.querySelector(`[data-deck="${d.deck}"]:not([disabled])`)?.focus();
      return true;
    }
    if (d.srcArchive) {
      const id = d.srcArchive;
      const archive = d.archived === '1';
      const label = accountLabelOf(id) || 'Account';
      sourceAction('archive', () => api.archiveAccount(id, archive), `${label} ${archive ? 'archived' : 'restored'}.`);
      return true;
    }
    if (d.srcRemove) {
      const id = d.srcRemove;
      sourceAction('remove', () => api.removeFile(id), `${fileNameOf(id) || 'File'} removed.`);
      return true;
    }
    if (d.srcUndo) {
      undoSource(d.srcUndo);
      return true;
    }
    if (d.srcMerge) {
      if (h.openAccountMerge) h.openAccountMerge(d.srcMerge, t);
      else api.go('account', { id: d.srcMerge });
      return true;
    }
    if (d.proposalApprove) {
      review(d.proposalApprove, Number(d.version), 'approve', 'Looks right', d.file);
      return true;
    }
    if (d.proposalCorrect) {
      const text = String(st.drafts[d.proposalCorrect] ?? '').trim();
      if (text) review(d.proposalCorrect, Number(d.version), 'correct', text, d.file);
      return true;
    }
    if (d.reviewUndo) {
      undoReview(d.reviewUndo);
      return true;
    }
    if (d.retry) {
      if (st.retrying[d.retry]) return true;
      const id = d.retry;
      st.retrying[id] = true;
      draw();
      api.retryFile(id).then(() => { delete st.retrying[id]; draw(); });
      return true;
    }
    return false;
  }

  // The file input fires both input and change; only change uploads, input is swallowed.
  function handleChange(e) {
    const t = e.target;
    // A correction draft is kept without a redraw so the caret stays.
    if (t?.matches?.('textarea[data-proposal-text]')) {
      st.drafts[t.dataset.proposalText] = String(t.value ?? '');
      return true;
    }
    if (t?.matches?.('input[data-category-always]')) {
      if (e.type === 'change') {
        st.deck.categoryAlways ??= {};
        st.deck.categoryAlways[t.dataset.categoryAlways] = t.checked;
      }
      return true;
    }
    if (!t?.matches?.('input[type=file][data-upload]')) return false;
    if (e.type === 'change') upload(t);
    return true;
  }

  // Where Confirm was opened from ({name, params}), or null for a direct load.
  function setOrigin(o) {
    st.origin = o && o.name ? { name: o.name, params: o.params } : null;
  }

  return { openUpload, setOrigin, confirmPage, pendingBanner, accountRepairs, accountRepairsFor, addFiles, accountMeta, sourcesSection, decidedSection, handleClick, handleChange, deckAction, handlePointer };
}
