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

function active(field, draft) {
  return !field.when || draft.get(JSON.stringify([field.key, ...field.when.path])) === field.when.value;
}

export function html(r, surface) {
  if (!r.question) return '';
  const { esc } = H;
  // Every answer is saved: say so and keep the questions out of the way (Edit answers reopens them).
  if (r.question.answered && !editing.has(r.id)) {
    return `<div class="h-answered" data-rec-answered="${esc(r.id)}"><span class="h-answered-t">Answered</span><button type="button" class="h-btn ghost" data-qr-edit="${esc(r.id)}">Edit answers</button></div>`;
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
      return `<fieldset class="h-answer-field h-answer-inferred" data-qr-wrap="${esc(f.id)}">${group}<legend>${esc(f.label)}</legend><p><b>${value ? 'Yes' : 'No'}.</b> ${esc(f.inferred.evidence)}</p><button type="button" class="h-btn ghost" data-qr-undo="${esc(f.inferred.accountId)}" data-rec="${esc(r.id)}"${pending ? ' disabled' : ''}>Undo</button></fieldset>`;
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
    return `<fieldset class="h-answer-field" data-qr-wrap="${esc(f.id)}"${on ? '' : ' hidden'}>${group}<legend>${esc(f.label)}</legend>${f.type === 'boolean' ? '' : `<label class="sr-only" for="${esc(id)}">${esc(f.label)}${f.unit ? ` (${esc(f.unit)})` : ''}</label>`}${control}</fieldset>`;
  }).join('');
  return `<form class="h-answers" data-rec-answers="${esc(r.id)}" aria-label="Answer questions for your plan" aria-busy="${pending}">${fields}<p class="h-answer-note">Your answers update the plan automatically.</p><div class="h-answer-acts"><button type="submit" class="h-btn pri"${pending ? ' disabled' : ''}>${pending ? 'Saving...' : r.question.primary ? 'Save' : 'Save answers'}</button>${r.question.primary ? `<button type="button" class="h-btn" data-act="snooze" data-rec="${esc(r.id)}" data-arg="${esc(H.snoozeLabel())}"${pending ? ' disabled' : ''}>Not now</button><button type="button" class="h-btn" data-ask-next="${esc(r.id)}">Ask</button>` : ''}</div></form>`;
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

// Edit answers opens the saved questions; Undo drops an inferred Virginia plan answer so the
// account is asked. Returns true when the click was one of these.
export function onClick(e) {
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
