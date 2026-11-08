import { ownWordsHtml } from '../own-words.js';

let H;
let drafts = new Map();
const busy = new Set();
// Recs whose answered questions the owner opened for editing.
const editing = new Set();
const INFERENCE_KEY = 'accounts.va529Inference';

export const bind = kit => { H = kit; };
export const reset = () => { drafts = new Map(); busy.clear(); editing.clear(); };

function draftFor(r) {
  let draft = drafts.get(r.id);
  if (!draft) { draft = new Map(); drafts.set(r.id, draft); }
  for (const f of r.question.fields) if (!draft.has(f.id) && f.value !== undefined) draft.set(f.id, f.value);
  return draft;
}

// A saved answer in words: Yes or No, a choice by its label, years as plain numbers.
function answerText(f) {
  const v = f.value;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f.type === 'choice') return (f.choices || []).find(c => c.value === v)?.label ?? String(v);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number' && f.unit && f.unit !== 'year') return `${v} ${f.unit}`;
  return String(v);
}

function active(field, draft) {
  return !field.when || draft.get(JSON.stringify([field.key, ...field.when.path])) === field.when.value;
}

export function html(r, surface) {
  const { esc } = H;
  const assumptions = (r.assumptions || []).map((a, i) => `<div class="h-answer-inferred"><p>${esc(a.evidence)}</p><button type="button" class="h-btn ghost" data-default-undo="${i}" data-rec="${esc(r.id)}"${busy.has(r.id) ? ' disabled' : ''}>Undo</button></div>`).join('');
  if (!r.question) return assumptions;
  // Every answer is saved: say so, show what was answered, and keep the questions out of the way
  // (Edit answers reopens them; Undo drops the answer through its receipts and asks again).
  if (r.question.answered && !editing.has(r.id)) {
    const fields = r.question.fields;
    const byId = new Map(fields.map(f => [f.id, f]));
    const shown = fields.filter(f => f.value !== undefined && (!f.when || byId.get(JSON.stringify([f.key, ...f.when.path]))?.value === f.when.value));
    const list = shown.length ? `<dl class="h-answered-l">${shown.map(f => `<div><dt>${f.group ? `${esc(f.group)}: ` : ''}${esc(f.label)}</dt><dd>${esc(answerText(f))}</dd></div>`).join('')}</dl>` : '';
    const undo = r.answerReceipts?.length ? `<button type="button" class="h-btn ghost" data-answer-undo="${esc(r.id)}"${busy.has(r.id) ? ' disabled' : ''}>Undo</button>` : '';
    return assumptions + `<div class="h-answered" data-rec-answered="${esc(r.id)}"><span class="h-answered-t">Answered</span>${list}<button type="button" class="h-btn ghost" data-qr-edit="${esc(r.id)}">Edit answers</button>${undo}</div>`;
  }
  const draft = draftFor(r);
  const pending = busy.has(r.id);
  const fields = r.question.fields.map((f, i) => {
    const value = draft.get(f.id);
    const id = `qr-${surface}-${r.id}-${i}`;
    const on = active(f, draft);
    const group = f.group ? `<span class="h-answer-for">${esc(f.group)}</span>` : '';
    // An answer inferred from stored data is shown with its evidence, not asked; Undo asks instead.
    if (f.inferred && on) {
      return `<fieldset class="h-answer-field h-answer-inferred" data-qr-wrap="${esc(f.id)}"><legend>${group}${esc(f.label)}</legend><p><b>${value ? 'Yes' : 'No'}.</b> ${esc(f.inferred.evidence)}</p><button type="button" class="h-btn ghost" data-qr-undo="${esc(f.inferred.accountId)}" data-rec="${esc(r.id)}"${pending ? ' disabled' : ''}>Undo</button></fieldset>`;
    }
    const attrs = `data-qr-field="${esc(f.id)}"${on ? ' required' : ' disabled'}${pending && on ? ' disabled' : ''}`;
    let control;
    if (f.type === 'boolean') {
      control = `<div class="h-answer-toggle">${[[true, 'Yes'], [false, 'No']].map(([v, label]) => `<label><input type="radio" name="${esc(id)}" value="${v}" ${attrs}${value === v ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
    } else if (f.type === 'choice') {
      control = `<select id="${esc(id)}" ${attrs}><option value="">Choose an answer</option>${(f.choices || []).map(c => `<option value="${esc(c.value)}"${value === c.value ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
    } else {
      const limits = f.type === 'number' ? ` min="${f.exclusiveMin != null ? f.exclusiveMin + 0.01 : f.min ?? 0}"${f.max != null ? ` max="${f.max}"` : ''} step="${f.integer ? '1' : '0.01'}" inputmode="${f.integer ? 'numeric' : 'decimal'}"` : '';
      control = `<div class="h-answer-value"><input id="${esc(id)}" type="${esc(f.type)}" value="${esc(value ?? '')}" ${attrs}${limits}>${f.unit ? `<span class="h-answer-unit">${esc(f.unit)}</span>` : ''}</div>`;
    }
    return `<fieldset class="h-answer-field" data-qr-wrap="${esc(f.id)}"${on ? '' : ' hidden'}><legend>${group}${esc(f.label)}</legend>${f.type === 'boolean' ? '' : `<label class="sr-only" for="${esc(id)}">${esc(f.label)}${f.unit ? ` (${esc(f.unit)})` : ''}</label>`}${control}</fieldset>`;
  }).join('');
  return assumptions + `<form class="h-answers" data-rec-answers="${esc(r.id)}" aria-label="Answer questions for your plan" aria-busy="${pending}">${fields}<p class="h-answer-note">Your answers update the plan automatically.</p><div class="h-answer-acts"><button type="submit" class="h-btn pri"${pending ? ' disabled' : ''}>${pending ? 'Saving...' : r.question.primary ? 'Save' : 'Save answers'}</button>${r.question.primary ? `<button type="button" class="h-btn" data-act="snooze" data-rec="${esc(r.id)}" data-arg="${esc(H.snoozeLabel())}"${pending ? ' disabled' : ''}>Not now</button><button type="button" class="h-btn" data-ask-next="${esc(r.id)}">Ask</button>` : ''}</div></form>${ownWordsHtml(esc, `rec:${r.id}`, surface)}`;
}

export function onChange(e) {
  const input = e.target.closest?.('[data-qr-field]');
  const form = input?.closest('[data-rec-answers]');
  if (!form) return false;
  const r = H.recById(form.dataset.recAnswers);
  if (!r?.question) return true;
  const field = r.question.fields.find(f => f.id === input.dataset.qrField);
  const draft = draftFor(r);
  if (input.value === '') draft.delete(field.id);
  else draft.set(field.id, field.type === 'boolean' ? input.value === 'true' : field.type === 'number' ? Number(input.value) : input.value);
  for (const f of r.question.fields) {
    const wrap = [...form.querySelectorAll('[data-qr-wrap]')].find(el => el.dataset.qrWrap === f.id);
    const on = active(f, draft);
    wrap.hidden = !on;
    wrap.querySelectorAll('input,select').forEach(el => { el.disabled = !on; el.required = on; });
  }
  return true;
}

export function onSubmit(e) {
  const form = e.target;
  if (!form.matches?.('[data-rec-answers]')) return false;
  e.preventDefault();
  const r = H.recById(form.dataset.recAnswers);
  if (!r?.question || busy.has(r.id) || !form.reportValidity()) return true;
  const draft = draftFor(r);
  const values = new Map();
  for (const f of r.question.fields) {
    if (!active(f, draft)) continue;
    if (!draft.has(f.id)) return true;
    if (!f.path.length) values.set(f.key, draft.get(f.id));
    else {
      if (!values.has(f.key)) values.set(f.key, Object.create(null));
      let node = values.get(f.key);
      f.path.slice(0, -1).forEach(p => { node[p] ??= Object.create(null); node = node[p]; });
      node[f.path.at(-1)] = draft.get(f.id);
    }
  }
  busy.add(r.id);
  H.draw();
  Promise.resolve(H.api.answerRec(r.id, [...values].map(([key, value]) => ({ key, value })))).then(result => {
    busy.delete(r.id);
    if (result) { drafts.delete(r.id); editing.delete(r.id); }
    H.draw();
  });
  return true;
}

// Edit answers opens the saved questions; Undo of an answer undoes its receipts, newest first, so
// the rec asks again; Undo of an inferred Virginia plan answer asks about the account. Returns true
// when the click was one of these.
export function onClick(e) {
  const defaultUndo = e.target.closest?.('[data-default-undo]');
  if (defaultUndo) {
    e.preventDefault();
    const id = defaultUndo.dataset.rec;
    if (busy.has(id)) return true;
    const a = H.recById(id)?.assumptions?.[Number(defaultUndo.dataset.defaultUndo)];
    if (!a) return true;
    busy.add(id);
    H.draw();
    const value = a.path.length ? { [a.path[0]]: { undone: true } } : true;
    Promise.resolve(H.api.answerRec(id, [{ key: a.undoKey, value }])).finally(() => {
      busy.delete(id); drafts.delete(id); H.draw();
    });
    return true;
  }
  const answerUndo = e.target.closest?.('[data-answer-undo]');
  if (answerUndo) {
    e.preventDefault();
    const id = answerUndo.dataset.answerUndo;
    const ids = [...(H.recById(id)?.answerReceipts || [])].reverse();
    if (busy.has(id) || !ids.length) return true;
    busy.add(id);
    H.draw();
    (async () => {
      for (const receipt of ids) if (!(await H.api.actionUndo(receipt))) break;
    })().finally(() => {
      busy.delete(id); drafts.delete(id); editing.delete(id); H.draw();
    });
    return true;
  }
  const edit = e.target.closest?.('[data-qr-edit]');
  if (edit) {
    e.preventDefault();
    editing.add(edit.dataset.qrEdit);
    H.draw();
    return true;
  }
  const undo = e.target.closest?.('[data-qr-undo]');
  if (!undo) return false;
  e.preventDefault();
  const id = undo.dataset.rec;
  if (busy.has(id)) return true;
  busy.add(id);
  H.draw();
  Promise.resolve(H.api.answerRec(id, [{ key: INFERENCE_KEY, value: { [undo.dataset.qrUndo]: { undone: true } } }])).then(result => {
    busy.delete(id);
    if (result) drafts.delete(id);
    H.draw();
  });
  return true;
}
