// Plain-language descriptions of Ask proposals. Every write operation in the tool registry has one
// describer here (test/proposal-describe.test.mjs iterates the registry), so a proposal card and its
// receipt never show an id, an enum code or an argument name.
//
// describeProposal(db, { tool, operation, args }) -> { text, details } where text is one sentence
// naming the action and its targets by their display names, read from stored data, and details
// is at most a few { label, value } lines in owner words that add information (a new value and the
// old one). Stored names keep their {n:key} demo tokens; the browser renders the text through its
// token-to-plain-text helper. Text the model supplied has its braces removed so it can never
// become a token. Amounts, dates and masks the model supplied are never repeated here: they have
// no provenance until the write's evidence guard accepts them, so they stay in the grounded answer
// above the card and in the receipt after confirming.

import { parseJson as parse } from '../store/db.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { OWNER_LABEL } from '../shared/rec-links.mjs';
import { horizonLabel, KIND_LABEL } from '../shared/goals.mjs';
import { OWNER_OPTIONS, KIND_OPTIONS } from '../ingest/confirm.mjs';
import { ANSWER_SHAPES } from '../jobs/triggers/common.mjs';
import { factName } from '../shared/event-labels.mjs';
import { normalizeMerchant } from '../categories/resolve.mjs';

// Rec statuses in the words the UI uses for them.
export const STATUS_WORDS = Object.freeze({ proposed: 'New', doing: 'Doing it', snoozed: 'Later', done: 'Done', dismissed: 'Not for us' });
const GOAL_STATUS = Object.freeze({ open: 'Open', done: 'Done', archived: 'Archived' });
const optionLabel = (options, id) => options.find(o => o.id === id)?.label ?? null;
const JOBS = Object.freeze({ plan: 'Rebuild your plan now.', 'simplefin-sync': 'Sync your connected bank accounts now.',
  freshness: 'Check how fresh your data is now.', 'confirm-guess': 'Look for Confirm questions Fathom can answer from your data now.' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Model-supplied text, braces removed (no token), whitespace collapsed; '' when absent.
const said = v => (typeof v === 'string' ? v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : '');
const q = s => `"${s}"`;
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const date = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
};
const list = names => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// Stored names, read lazily and once per description.
function lookups(db) {
  let naming = null;
  const row = (sql, ...a) => { try { return db.prepare(sql).get(...a) ?? null; } catch { return null; } };
  const def = r => (r ? parse(r.def, {}) ?? {} : {});
  const rec = id => def(row('SELECT def FROM recs WHERE id = ?', id));
  const goal = id => def(row('SELECT def FROM goals WHERE id = ?', id));
  return {
    // 'the recommendation "T"', or a plain phrase when the row is gone.
    rec: id => (rec(id).title ? `the recommendation ${q(rec(id).title)}` : 'this recommendation'),
    recTitle: id => (rec(id).title ? q(rec(id).title) : ''),
    recDef: rec,
    goal: id => (goal(id).title ? `the goal ${q(goal(id).title)}` : 'this goal'),
    goalTitle: id => (goal(id).title ? q(goal(id).title) : ''),
    goalDef: goal,
    account: id => {
      naming ??= accountNaming(db);
      const label = naming.byId.get(id)?.labelText;
      return label ? `the account ${q(label)}` : 'this account';
    },
    decision: id => { const t = row('SELECT title FROM decisions WHERE id = ?', id)?.title; return t ? `the decision ${q(t)}` : 'this decision'; },
    decisionFor: name => row('SELECT title FROM decisions WHERE wargame = ? ORDER BY sort LIMIT 1', name)?.title ?? null,
    file: id => { const name = row('SELECT name FROM files WHERE id = ?', id)?.name; return name ? `the imported file ${q(name)}` : 'the imported file'; },
    confirm: id => row('SELECT question, options FROM confirm_items WHERE id = ?', id),
    transaction: id => row('SELECT description, date FROM transactions WHERE id = ?', id),
    merchant: merchant => {
      const key = normalizeMerchant(merchant);
      try { return db.prepare('SELECT description FROM transactions ORDER BY id').all().find(t => normalizeMerchant(t.description) === key)?.description ?? null; } catch { return null; }
    },
    preference: id => row('SELECT text, definition_id FROM preferences WHERE id = ?', id),
    definition: id => row('SELECT name FROM spending_definitions WHERE id = ?', id)?.name ?? null,
    pack: id => { const d = def(row('SELECT def FROM packs_state WHERE id = ?', id)); return d.name || d.title || null; },
    review: id => row('SELECT title, rec_id FROM advisor_reviews WHERE id = ?', id),
    receipt: id => row('SELECT kind, entity_id, label FROM action_receipts WHERE id = ?', id),
  };
}

const category = c => cap(said(c)) || 'a new category';

// A fact's name: its event noun, else its Confirm question when that has no placeholder.
function factLabel(key) {
  const noun = factName(key);
  if (noun) return noun;
  const shape = Object.hasOwn(ANSWER_SHAPES, key) ? ANSWER_SHAPES[key] : null;
  return shape && typeof shape.label === 'string' && !shape.label.includes('{') ? shape.label : null;
}
// A fact value in owner words, or '' when it is a number, a date or a structure.
function factValue(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'string' || /\d/.test(value)) return '';
  const shape = Object.hasOwn(ANSWER_SHAPES, key) ? ANSWER_SHAPES[key] : null;
  const choice = Array.isArray(shape?.choices) ? shape.choices.find(c => c.value === value) : null;
  return choice ? choice.label : said(value);
}

// The goal fields an edit changes, in owner words. Amounts and dates are named, never repeated.
const GOAL_FIELDS = Object.freeze({ note: 'note', target: 'target amount', targetDate: 'target date', track: 'what it tracks',
  owner: 'whose goal it is', priority: 'priority', targetLow: 'low end of the range', targetHigh: 'high end of the range',
  floor: 'floor', taxYear: 'tax year', accounts: 'accounts', split: 'split', entered: 'amount entered' });
function goalDetails(args, before = {}) {
  const details = [];
  const title = said(args.title);
  if (title && title !== before.title) details.push({ label: 'New name', value: before.title ? `${q(title)} (was ${q(before.title)})` : q(title) });
  if (args.horizon) details.push({ label: 'Timeframe', value: before.horizon && before.horizon !== args.horizon ? `${horizonLabel(args.horizon)} (was ${horizonLabel(before.horizon)})` : horizonLabel(args.horizon) });
  if (args.kind && KIND_LABEL[args.kind]) details.push({ label: 'Kind', value: KIND_LABEL[args.kind] });
  const other = Object.keys(GOAL_FIELDS).filter(k => args[k] !== undefined).map(k => GOAL_FIELDS[k]);
  if (other.length) details.push({ label: before.title ? 'Also changes' : 'Also sets', value: list(other) });
  return details;
}

function statusText(args, L) {
  const t = L.rec(args.id);
  switch (args.status) {
    case 'dismissed': return `Set aside ${t} as Not for us.`;
    case 'snoozed': { const wake = said(args.wake); return `Move ${t} to Later${wake ? ` until ${wake}` : ''}.`; }
    case 'proposed': return `Reopen ${t} as New.`;
    default: return `Mark ${t} as ${STATUS_WORDS[args.status] || 'changed'}.`;
  }
}

function confirmAnswer(L, item) {
  const row = L.confirm(item.id);
  const options = Array.isArray(parse(row?.options, [])) ? parse(row?.options, []) : [];
  const answer = optionLabel(options, item.answer) ?? said(item.answer);
  return { question: row?.question ? said(row.question) : 'a Confirm question', answer };
}

// Undo names what the earlier change touched, when its row still exists.
function undoTarget(L, r) {
  if (!r) return '';
  if (['status', 'owner', 'step'].includes(r.kind)) return L.recTitle(r.entity_id);
  if (r.kind === 'goal') return L.goalTitle(r.entity_id);
  if (r.kind === 'fact') { const name = factLabel(r.entity_id); return name ? q(name) : ''; }
  if (r.kind === 'preference') { const p = L.preference(r.entity_id); return p ? q(p.text) : ''; }
  return '';
}

const merge = (args, L) => `Merge ${L.account(args.id)} and ${L.account(args.withId)} into one account. The imported one keeps its history.`;

export const DESCRIBERS = Object.freeze({
  'act_on_recommendation.status': statusText,
  'act_on_recommendation.owner': (a, L) => `Change who acts on ${L.rec(a.id)} to ${OWNER_LABEL[a.owner] || 'someone else'}.`,
  'act_on_recommendation.step': (a, L) => {
    const step = L.recDef(a.id).tasks?.[a.index];
    const name = step && typeof step.t === 'string' ? `the step ${q(step.t)}` : 'a step';
    return `Mark ${name} in ${L.rec(a.id)} as ${a.checked ? 'done' : 'not done'}.`;
  },
  'act_on_recommendation.start_over': (a, L) => `Start the conversation about ${L.rec(a.id)} over. Earlier conversations stay in Ask.`,
  'act_on_recommendation.decide': (a, L) => `Settle ${L.decision(a.decisionId)}${a.point === undefined ? ' with the option picked now' : ' with the option you chose'}.`,
  'act_on_recommendation.revisit': (a, L) => `Reopen ${L.decision(a.decisionId)} and remove the assumption it set.`,
  'act_on_recommendation.pick_point': (a, L) => {
    const title = L.decisionFor(a.name);
    return `Pick an option for ${title ? q(title) : `the ${a.name === 'salary' ? 'salary' : 'deferral'} choice`} without deciding yet.`;
  },
  'advisor_review.packet': () => 'Prepare a review packet for your advisor with every waiting review. Nothing leaves Fathom.',
  'advisor_review.checkin': () => 'Set the next check-in with your advisor.',
  'advisor_review.send': (a, L) => `Send ${L.rec(a.recId)} to your advisor for review.`,
  'advisor_review.verdict': (a, L) => {
    const r = L.review(a.reviewId);
    const name = r?.title ? `the recommendation ${q(r.title)}` : r?.rec_id ? L.rec(r.rec_id) : 'a recommendation';
    return a.verdict === 'vetoed'
      ? `Record that your advisor vetoed ${name}. The recommendation is set aside as Not for us.`
      : `Record that your advisor confirmed ${name}.`;
  },
  'answer.confirm': (a, L) => {
    const answers = (a.items ?? []).map(i => confirmAnswer(L, i));
    const verb = a.revise ? 'Change your answer to' : 'Answer';
    if (answers.length === 1) {
      const [{ question, answer }] = answers;
      return `${verb} ${q(question)}${answer ? ` with ${answer}` : ''}.`;
    }
    return { text: `${verb} ${answers.length} Confirm questions.`,
      details: answers.slice(0, 3).map(x => ({ label: x.question, value: x.answer || 'Answered' })) };
  },
  'answer.expected_transaction': a => {
    const subject = /\d/.test(said(a.subject)) ? '' : said(a.subject);
    return `Note an expected ${a.direction === 'inflow' ? 'incoming' : 'outgoing'} payment${subject ? ` for ${q(subject)}` : ''}. Nothing is recorded as paid.`;
  },
  'answer.fact': (a, L) => {
    if (a.key === 'business.entities' && Array.isArray(a.value)) {
      const tax = { s_corp: 'S corp', llc_single: 'single-member LLC taxed on Schedule C', sole_prop: 'sole proprietorship', partnership: 'partnership', c_corp: 'C corp', personal: 'personal summary', income_history: 'income history', inactive: 'inactive', not_mine: 'not mine' };
      return { text: 'Record household businesses.', details: a.value.slice(0, 4).map(e => ({ label: said(e.name),
        value: `${tax[e.type] || 'tax type pending'}, ${e.owner === 'spouse' ? 'your spouse' : 'you'}${e.status === 'final_year' ? '; final year, final K-1 expected' : '; active'}${e.accountId ? `; linked business account: ${L.account(e.accountId)}` : ''}`,
      })) };
    }
    const name = factLabel(a.key);
    const value = factValue(a.key, a.value);
    if (!name) return `Save a household detail you told Fathom${value ? `: ${value}` : ''}.`;
    return `Save ${q(name)}${value ? ` as ${value}` : ''}.`;
  },
  'answer.rec_questions': (a, L) => `Save your answers to the questions on ${L.rec(a.recId)}.`,
  'answer.reopen': (a, L) => {
    const ids = a.ids ?? [];
    if (ids.length === 1) { const row = L.confirm(ids[0]); return `Reopen the Confirm question ${row?.question ? q(said(row.question)) : 'you answered'}.`; }
    return `Reopen ${ids.length} Confirm questions you answered.`;
  },
  'answer.yearend_mark': a => (a.reason == null ? 'Clear your mark on an expected tax document so Fathom expects it again.'
    : 'Mark an expected tax document as not coming this year.'),
  'categorize.transaction': (a, L) => {
    const t = L.transaction(a.transactionId);
    const name = t ? `the transaction ${q(t.description)}${date(t.date) ? ` on ${date(t.date)}` : ''}` : 'a transaction';
    return `Categorize ${name} as ${category(a.category)}.`;
  },
  'categorize.merchant_rule': (a, L) => {
    const seen = L.merchant(a.merchant);
    const name = seen ?? (/\d/.test(said(a.merchant)) ? '' : said(a.merchant));
    return `Categorize every transaction from ${name ? q(name) : 'this merchant'} as ${category(a.category)}, now and in future imports.`;
  },
  'refresh.build_your_plans': () => 'Rebuild Your plans from your imported documents.',
  'refresh.import_file': a => { const name = said(a.name); return `Import ${name ? q(name) : 'the file you shared'}.`; },
  'refresh.retry_import': (a, L) => `Retry importing ${L.file(a.fileId)}.`,
  'refresh.review_import': a => a.decision === 'approve' ? 'Approve this import proposal.' : 'Correct this import proposal.',
  'refresh.run_job': a => JOBS[a.job] || 'Refresh your data now.',
  'sources.archive_account': (a, L) => (a.archived === false ? `Restore ${L.account(a.id)} from the archive.`
    : `Archive ${L.account(a.id)}. Its history is kept.`),
  'sources.merge_accounts': merge,
  'sources.remove_file': (a, L) => `Remove ${L.file(a.id)} and the rows it added.`,
  'undo.undo': (a, L) => {
    const r = L.receipt(a.id);
    const target = undoTarget(L, r);
    const what = r?.label ? q(said(r.label)) : '';
    return `Undo your earlier change${what ? ` ${what}` : ''}${target ? ` to ${target}` : ''}.`;
  },
  'update_account.kind': (a, L) => `Set the kind of ${L.account(a.id)} to ${optionLabel(KIND_OPTIONS, a.kind) || 'a new kind'}.`,
  'update_account.mask': (a, L) => `Save the last four digits for ${L.account(a.id)}.`,
  'update_account.merge': merge,
  'update_account.owner': (a, L) => `Set the owner of ${L.account(a.id)} to ${optionLabel(OWNER_OPTIONS, a.owner) || 'someone else'}.`,
  'update_account.rename': (a, L) => {
    const name = said(a.displayName);
    return name ? `Rename ${L.account(a.id)} to ${q(name)}.` : `Clear the custom name on ${L.account(a.id)}.`;
  },
  'update_goal.archive': (a, L) => `Archive ${L.goal(a.id)}. Its history is kept.`,
  'update_goal.create': a => {
    const title = said(a.title);
    return { text: title ? `Create the goal ${q(title)}.` : 'Create a new goal.', details: goalDetails({ ...a, title: undefined }) };
  },
  'update_goal.delete': (a, L) => `Delete ${L.goal(a.id)}. Undo can bring it back.`,
  'update_goal.edit': (a, L) => {
    const before = L.goalDef(a.id);
    const fields = Object.keys(a).filter(k => k !== 'id' && a[k] !== undefined);
    if (fields.length === 1 && a.status) {
      return a.status === 'done' ? `Mark ${L.goal(a.id)} as done.`
        : a.status === 'open' ? `Reopen ${L.goal(a.id)}.` : `Archive ${L.goal(a.id)}.`;
    }
    const details = goalDetails(a, before);
    if (a.status) details.push({ label: 'Status', value: GOAL_STATUS[a.status] || 'Changed' });
    return { text: `Update ${L.goal(a.id)}.`, details };
  },
  'update_goal.suggestion': (a, L) => `Undo the target Fathom set on ${L.goal(a.id)} and stop suggesting it.`,
  'update_preferences.curve': () => 'Change where you lean on your tradeoffs.',
  'update_preferences.delete_definition': (a, L) => { const n = L.definition(a.definitionId); return `Delete the saved spending selection${n ? ` ${q(n)}` : ''} and its linked preference.`; },
  'update_preferences.forget': (a, L) => { const p = L.preference(a.id); return `Forget the preference ${p ? q(p.text) : 'you chose'}.`; },
  'update_preferences.pack': (a, L) => { const n = L.pack(a.packId); return `Turn ${a.active ? 'on' : 'off'} the knowledge pack ${n ? q(n) : 'you chose'}.`; },
  'update_preferences.remember': (a, L) => {
    const text = said(a.text);
    const old = a.id ? L.preference(a.id) : null;
    return old ? `Change the preference ${q(old.text)} to ${q(text)}.` : `Remember the preference ${q(text)}.`;
  },
  'update_preferences.save_definition': a => { const n = said(a.name); return `Save the spending selection ${n ? q(n) : 'you described'} and remember it as a preference.`; },
});

const shape = out => (typeof out === 'string' ? { text: out, details: [] } : { text: out.text, details: (out.details ?? []).slice(0, 4) });

// The route label of an operation, for the fallback; proposals.mjs supplies the registry's.
let routeOf = () => null;
export function useRouteLabels(fn) { routeOf = fn; }

// The description of a proposal: its describer, else the operation's route label and the stored
// name its target resolves to (an operation with no describer, or one that fails on unexpected
// stored data). Never an argument line.
export function describeProposal(db, pending) {
  const key = `${pending?.tool}.${pending?.operation}`;
  const args = pending?.args && typeof pending.args === 'object' ? pending.args : {};
  const describer = Object.hasOwn(DESCRIBERS, key) ? DESCRIBERS[key] : null;
  if (describer) {
    try { return shape(describer(args, lookups(db))); } catch { /* fall back below */ }
  }
  let route = null;
  try { route = routeOf(pending?.tool, pending?.operation); } catch { route = null; }
  let name = '';
  try {
    const L = lookups(db);
    const id = args.id ?? args.recId;
    if (typeof id === 'string') name = [L.recTitle(id), L.goalTitle(id)].find(Boolean) ?? '';
  } catch { name = ''; }
  return { text: route ? `${route}${name ? `: ${name}` : ''}.` : `Make the change described above${name ? `: ${name}` : ''}.`, details: [] };
}

// The stored fields of a description on pendingAction: description (text) and details when any.
export const describedFields = ({ text, details }) => ({ description: text, ...(details.length ? { details } : {}) });

// Messages as served: a stored proposal from before descriptions existed gets one built from
// current names, so no card falls back to argument lines. Mutates and returns `messages`.
export function withDescriptions(db, messages) {
  for (const m of messages) {
    const pending = m?.provenance?.pendingAction;
    if (!pending || typeof pending !== 'object' || typeof pending.description === 'string') continue;
    m.provenance = { ...m.provenance, pendingAction: { ...pending, ...describedFields(describeProposal(db, pending)) } };
  }
  return messages;
}
