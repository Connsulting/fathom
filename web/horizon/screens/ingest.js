/* Horizon ingest screens: Add files, per-file results, the Confirm queue, the pending banner,
   account freshness and the Sources list. Text from the server (file names, questions, option
   labels, source labels) is plain text and always goes through esc(), never token resolution. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS = {
  imported: 'Imported',
  duplicate: 'Already imported',
  needs_mapping: 'Needs a mapping',
  needs_extraction: 'Needs the engine to read it',
  unsupported: 'Not a supported file',
  too_large: 'Too large to read',
  failed: 'Could not import'
};

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
  employer_relation: 'Employer'
};

const arr = (a) => (Array.isArray(a) ? a : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// 'Nov 3, 2026' from an ISO date or timestamp; '' when there is none.
export function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
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

const cadenceText = (c) => (c && typeof c === 'object' ? String(c.label || '') : String(c || ''));

export function ingestScreens(h) {
  const { api, shell, section, pageHead, btn, icon, esc, draw } = h;
  // Module state survives scenario re-renders (the design redraws the whole page on every change).
  const st = { busy: 0, results: null, answering: {}, retrying: {}, open: {} };
  const ing = () => api.ingest();

  function chip(state) {
    if (state === 'fresh') return '<span class="h-fresh fresh">Fresh</span>';
    if (state === 'stale') return '<span class="h-fresh stale">Stale</span>';
    return '';
  }

  function pendingBanner() {
    const n = num(ing().pending);
    if (n <= 0) return '';
    return `<a class="h-ing-banner" href="#/confirm" data-go="confirm">${icon('clock')}<span class="h-ing-banner-t"><b>${plural(n, 'question')} to confirm</b><span>So imported files land in the right place.</span></span>${icon('arrow')}</a>`;
  }

  function fileRow(f) {
    const s = String(f.status || '');
    const summary = s === 'imported' || s === 'duplicate' ? countsText(f.counts) : '';
    return `<li class="${esc(s)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em>${esc(STATUS[s] || s)}</em></div>${summary ? `<p>${esc(summary)}</p>` : ''}</div></li>`;
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
    const lede = '<p class="h-mute sm">Exports from banks, cards, brokerages and payroll, profit and loss workbooks, statements and tax forms. Rows already imported are skipped.</p>';
    const wl = waitingList();
    return section('Add files', `<div class="h-ing-add">${lede}${control}${list}</div>`) + (wl ? section('Waiting files', wl) : '');
  }

  function accountMeta(a) {
    const g = (a && ing().accounts[a.id]) || {};
    const asOf = (a && a.asOf) || g.asOf || '';
    const fresh = (a && a.fresh) || g.fresh || 'unknown';
    const d = dateText(asOf);
    if (!d && fresh === 'unknown') return '';
    return `<div class="h-acc-f">${d ? `<span>Last data ${esc(d)}</span>` : ''}${chip(fresh)}</div>`;
  }

  function sourcesSection() {
    const g = ing();
    const srcs = g.sources.length
      ? `<ul class="h-srcs">${g.sources.map((s) => {
        const d = dateText(s.asOf);
        const cad = cadenceText(s.cadence);
        const meta = [d ? `Last data ${esc(d)}` : 'No dated rows', cad ? `Export ${esc(cad)}` : ''].filter(Boolean).join('<span class="h-dotsep"></span>');
        return `<li><div class="h-src-n"><b>${esc(s.label)}</b><span>${meta}</span></div>${chip(s.state)}</li>`;
      }).join('')}</ul>`
      : '<p class="h-mute">No files added yet.</p>';
    const fmts = g.formats.length
      ? section('How to export', `<div class="h-howto">${g.formats.map((f) => {
        const id = String(f.id ?? f.title ?? '');
        return `<details data-howto="${esc(id)}"${st.open[id] ? ' open' : ''}><summary>${icon('chev')}<span>${esc(f.title)}</span></summary>
          <ol>${arr(f.steps).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>${f.cadence ? `<p class="h-mute sm">How often: ${esc(cadenceText(f.cadence))}</p>` : ''}</details>`;
      }).join('')}</div>`)
      : '';
    return section('Sources', srcs, g.sources.length ? plural(g.sources.length, 'source') : '') + fmts;
  }

  // Files that need a mapping or the engine; '' when none. Shared by Confirm and Accounts.
  function waitingList() {
    const waiting = ing().waiting;
    if (!waiting.length) return '';
    return `<ul class="h-ing-files">${waiting.map((f) => `<li class="${esc(f.status)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em>${esc(STATUS[f.status] || f.status)}</em></div></div>${btn(st.retrying[f.id] ? 'Retrying' : 'Retry', `data-retry="${esc(f.id)}"${st.retrying[f.id] ? ' disabled' : ''}`, 'ghost')}</li>`).join('')}</ul>`;
  }

  function confirmPage() {
    const g = ing();
    const files = new Map(g.files.map((f) => [f.id, f]));
    const items = g.items.filter((i) => !i.status || i.status === 'pending');
    const cards = items.length
      ? `<div class="h-cfs">${items.map((i) => {
        const busy = !!st.answering[i.id];
        const from = files.get(i.fileId);
        const opts = arr(i.options).map((o) => btn(esc(o.label), `data-answer="${esc(i.id)}" data-option="${esc(o.id)}"${busy ? ' disabled' : ''}`, st.answering[i.id] === o.id ? 'pri' : '')).join('');
        return `<article class="h-cf"><div class="h-cf-k">${esc(KIND[i.kind] || 'Question')}${from ? `<span>${esc(from.name)}</span>` : ''}</div>
          <p class="h-cf-q">${esc(i.question)}</p><div class="h-acts">${opts}</div></article>`;
      }).join('')}</div>`
      : `<div class="h-empty"><i class="h-ok sm">${icon('check')}</i><div><b>Nothing to confirm.</b><p>New questions show up here when an import needs one.</p></div></div>`;
    const wait = waitingList() || '<p class="h-mute">No files are waiting.</p>';
    return shell(`${pageHead('Household', 'Confirm', 'A few short questions so imports land in the right place.')}
      <div class="h-cols"><div class="h-col-main">${section(items.length ? `Questions <em>${items.length}</em>` : 'Questions', cards)}</div>
      <div class="h-col-side">${section('Waiting files', wait)}</div></div>`, 'confirm');
  }

  function upload(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || st.busy) return;
    st.busy = files.length;
    draw();
    api.upload(files).then((res) => {
      st.busy = 0;
      if (res && Array.isArray(res.files)) st.results = res.files;
      draw();
    });
  }

  function handleClick(e) {
    const t = e.target.closest?.('[data-upload-open],[data-answer],[data-retry],details[data-howto] > summary');
    if (!t) return false;
    if (t.tagName === 'SUMMARY') {
      const d = t.parentElement;
      st.open[d.dataset.howto] = !d.open;
      return true;
    }
    e.preventDefault();
    const d = t.dataset;
    if (d.uploadOpen) {
      if (!st.busy) t.parentElement.querySelector('input[type=file][data-upload]')?.click();
      return true;
    }
    if (d.answer) {
      if (st.answering[d.answer]) return true;
      const id = d.answer;
      st.answering[id] = d.option;
      draw();
      api.answer(id, d.option).then(() => { delete st.answering[id]; draw(); });
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
    if (!t?.matches?.('input[type=file][data-upload]')) return false;
    if (e.type === 'change') upload(t);
    return true;
  }

  return { confirmPage, pendingBanner, addFiles, accountMeta, sourcesSection, handleClick, handleChange };
}
