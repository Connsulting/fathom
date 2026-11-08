// A rec's Steps: product-managed, never free checkboxes. A step the product verifies (an upload, an
// answer, a classification, a Confirm question) carries its inline control and completes itself
// when the scenario reports its condition cleared. Any other step is one "I did this" control that
// records when and by whom, with Undo. Pure markup: clicks go to the existing handlers (data-act,
// data-upload-open, data-ask-next, data-go) and to design.js for data-step-answer.

let H;
export const bind = kit => { H = kit; };

// What clears a verifiable step while it is open, by kind.
const PENDING = Object.freeze({
  upload: 'Checks off when the file arrives',
  answer: 'Checks off when you answer',
  classify: 'Checks off once we know how it is taxed',
  confirm: 'Checks off when you answer it in Confirm',
  review: 'Checks off when the data clears',
});

const when = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

function control(r, t, i) {
  const { esc } = H;
  const rid = esc(r.id);
  if (!t.auto) {
    return t.done
      ? `<button type="button" class="h-step-undo" data-act="task" data-rec="${rid}" data-arg="${i}">Undo</button>`
      : `${t.link ? goLink(r, t.link) : ''}<button type="button" class="h-btn sm" data-act="task" data-rec="${rid}" data-arg="${i}">I did this</button>`;
  }
  if (t.done) return '';
  if (t.kind === 'upload') {
    return `<span class="h-ing-ctl"><button type="button" class="h-btn sm" data-upload-open="1" aria-label="${esc(`Upload ${t.noun || 'a file'}`)}">Upload</button><input type="file" multiple data-upload="1" hidden tabindex="-1"></span>`;
  }
  if (t.fact) return `<button type="button" class="h-btn sm" data-step-answer="${rid}" data-fact="${esc(t.fact)}">Answer</button>`;
  return goLink(r, t.link || 'ask');
}

function goLink(r, link) {
  const { esc } = H;
  if (link === 'ask') return `<button type="button" class="h-btn sm" data-ask-next="${esc(r.id)}">Ask about it</button>`;
  const page = { upload: ['add', 'Open Files'], confirm: ['confirm', 'Open Confirm'], accounts: ['accounts', 'Open Accounts'] }[link];
  return page ? `<a class="h-btn sm" href="#/${page[0]}" data-go="${page[0]}">${page[1]}</a>` : '';
}

function note(t) {
  if (t.auto) return t.done ? 'Done automatically' : PENDING[t.kind] || PENDING.review;
  if (!t.done) return '';
  const day = t.doneAt ? when(t.doneAt) : '';
  const who = t.doneBy && t.doneBy !== 'ui' ? ' from Ask' : '';
  return `You did this${day ? ` ${day}` : ''}${who}`;
}

export function html(r) {
  const { esc, T, icon, addBtn, api } = H;
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  if (!tasks.length) return '<p class="h-mute">No steps.</p>';
  const doneN = tasks.filter(t => t.done).length;
  const pct = doneN / tasks.length;
  const prog = `<div class="h-prog"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${pct * 100}" height="4" rx="2"/></svg><span>${doneN} of ${tasks.length}</span></div>`;
  const rows = tasks.map((t, i) => {
    const n = note(t);
    const cls = `h-step${t.done ? ' done' : ''}${t.auto ? ' auto' : ''}`;
    return `<li class="${cls}" data-step="${i}" data-kind="${esc(t.kind || 'manual')}"><i class="h-step-mark" aria-hidden="true">${t.done ? icon('check') : ''}</i>`
      + `<div class="h-step-b"><span class="h-step-t">${T(t.t)}</span>${n ? `<em class="h-step-n">${esc(n)}</em>` : ''}</div>`
      + `<div class="h-step-c">${control(r, t, i)}${addBtn('step', `${r.id}:${i}`, api.txt(t.t))}</div></li>`;
  }).join('');
  return `${prog}<ul class="h-steps" aria-label="Steps">${rows}</ul>`;
}
