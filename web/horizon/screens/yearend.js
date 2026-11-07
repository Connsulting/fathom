/* Horizon year end screen: the expected tax documents for the year (received with the stored file,
   or missing with where it comes from and when it arrives), "not needed this year" marks with a
   reason, received documents that matched nothing, the year-end decisions, and the accountant
   packet download with its past generations. Document and file text comes from stored data and
   imports, so it is escaped, never resolved as tokens. */

let H = null;

export function bind(kit) { H = kit; }

const S = { marking: null, reason: '' };

export function reset() { S.marking = null; S.reason = ''; }

const GROUPS = [['missing', 'Missing'], ['expected', 'Not yet due'], ['have', 'Received'], ['skipped', 'Not needed this year']];

function dateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
  if (!m) return '';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return `${mon} ${Number(m[3])}, ${m[1]}${m[4] ? ` ${m[4]}:${m[5]} UTC` : ''}`;
}

function docItem(d) {
  const { esc, icon, btn } = H;
  const files = H.arr(d.files);
  let detail;
  if (d.status === 'have') detail = files.map((f) => `<span class="h-ye-file">${icon('doc')}${esc(f.name)}<em>${f.pnl ? 'ledger, ' : ''}stored ${esc(dateLabel(f.date))}</em></span>`).join('');
  else if (d.status === 'skipped') detail = `<p>Not needed: ${esc(d.skip?.reason || '')}</p>`;
  else detail = `<p>${esc(d.src)}. ${esc(d.note)}</p>`;
  let acts = '';
  if (d.status === 'missing' || d.status === 'expected') {
    acts = S.marking === d.key
      ? `<form class="h-ye-mark" data-ye-form="${esc(d.key)}" novalidate><label for="h-ye-r">Why is it not needed?</label><div><input id="h-ye-r" name="reason" maxlength="300" autocomplete="off" value="${esc(S.reason)}" placeholder="For example: account closed in March"><button type="submit" class="h-btn pri">Save</button>${btn('Cancel', 'data-ye-cancel', 'ghost')}</div></form>`
      : btn('Not needed', `data-ye-skip="${esc(d.key)}"`, 'sm');
  } else if (d.status === 'skipped') {
    acts = btn('Needed after all', `data-ye-unskip="${esc(d.key)}"`, 'sm');
  }
  return `<li class="${esc(d.status)}" data-ye-item="${esc(d.key)}"><i>${d.status === 'have' ? icon('check') : ''}</i><div><b>${esc(d.t)}</b>${detail}${acts ? `<div class="h-ye-acts">${acts}</div>` : ''}</div></li>`;
}

export function render() {
  const { api, arr, esc, T, shell, section, pageHead, goA, icon, plural, statusText, recById } = H;
  const ye = api.s.yearend || {};
  const year = ye.year;
  const docs = arr(ye.docs);
  const needed = docs.filter((d) => d.status !== 'skipped');
  const have = needed.filter((d) => d.status === 'have').length;
  const skipped = docs.length - needed.length;
  const decs = arr(ye.decisions);
  const decDone = decs.filter((d) => d.done).length;
  const W = 100;
  const meter = (n, t) => `<svg viewBox="0 0 ${W} 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="${W}" height="4" rx="2"/><rect class="fg" width="${t ? (n / t) * W : 0}" height="4" rx="2"/></svg>`;
  const docsHtml = GROUPS.map(([s, label]) => {
    const list = docs.filter((d) => d.status === s);
    if (!list.length) return '';
    return `<div class="h-docgrp" data-ye-group="${s}"><div class="h-sub-h">${label} <span>${list.length}</span></div><ul class="h-docs">${list.map(docItem).join('')}</ul></div>`;
  }).join('');
  const unmatched = arr(ye.unmatched);
  const unHtml = unmatched.length
    ? `<ul class="h-docs">${unmatched.map((u) => `<li class="have"><i>${icon('check')}</i><div><b>${esc(u.t)}</b><span class="h-ye-file">${icon('doc')}${esc(u.name)}<em>stored ${esc(dateLabel(u.date))}</em></span></div></li>`).join('')}</ul>`
    : '';
  const decHtml = decs.length ? `<ul class="h-docs">${decs.map((d) => {
    const r = d.kind === 'rec' ? recById(d.id) : null;
    const link = d.kind === 'rec' ? (r ? goA('rec', T(d.t), { id: d.id }) : T(d.t)) : goA('wargame', T(d.t));
    const st = r ? statusText(r) : d.done ? 'Decided' : d.status === 'open' ? 'Open' : 'Upcoming';
    return `<li class="${d.done ? 'have' : 'expected'}"><i>${d.done ? icon('check') : ''}</i><div><b>${link}</b><p>${st}${d.when && !d.done ? `, ${T(d.when)}` : ''}</p></div></li>`;
  }).join('')}</ul>` : '<p class="h-mute">No year-end decisions.</p>';
  const href = `/api/yearend/packet?year=${encodeURIComponent(year)}`;
  const packets = arr(ye.packets);
  const last = packets[0];
  const packetBox = `<div class="h-packet">${icon('doc')}<div><b>${last ? `Last assembled ${esc(dateLabel(last.at))}` : 'Packet for your accountant'}</b><p>${last
    ? `${last.counts?.received ?? 0} of ${last.counts?.expected ?? 0} expected documents, ${plural(last.counts?.files ?? 0, 'file')}. Assembling again rebuilds it from what is stored now.`
    : 'A zip with every received document and a printable index of what is in, what is missing, tax payments and key figures.'}</p></div>
    <a class="h-btn pri" href="${esc(href)}" download data-ye-download>${last ? 'Assemble again' : 'Assemble packet'}</a></div>`;
  const history = packets.length > 1
    ? `<ul class="h-kv h-ye-hist">${packets.map((p) => `<li><div><b>${esc(dateLabel(p.at))}</b><span>${p.counts?.received ?? 0} of ${p.counts?.expected ?? 0} received, ${plural(p.counts?.files ?? 0, 'file')}</span></div></li>`).join('')}</ul>`
    : '';
  return shell(`${pageHead('Year end', 'The packet for your accountant', `Tax year ${esc(year)}. Documents and decisions in one place, so nothing gets rebuilt in March.`)}
    <div class="h-next"><div><span>Documents in hand</span><b>${have} of ${needed.length}</b>${meter(have, needed.length)}</div><div><span>Not needed</span><b>${skipped}</b></div><div><span>Decisions made</span><b>${decDone} of ${decs.length}</b>${meter(decDone, decs.length)}</div></div>
    ${packetBox}
    <div class="h-cols"><div class="h-col-main">${section('Documents', docsHtml || '<p class="h-mute">Nothing is expected from the facts and accounts stored so far.</p>')}
    ${unHtml ? section('Received, not on the list', unHtml, 'Goes in the packet too') : ''}</div>
    <div class="h-col-side">${section('Decisions', decHtml)}${history ? section('Packets assembled', history) : ''}</div></div>`);
}

export function onClick(e) {
  const t = e.target.closest('[data-ye-skip],[data-ye-unskip],[data-ye-cancel],[data-ye-download]');
  if (!t || !H.root.contains(t)) return false;
  const { api, draw } = H;
  if (t.dataset.yeDownload != null) {
    // The browser downloads the zip; reread the scenario afterwards for the new generation row.
    setTimeout(() => api.refresh(), 1500);
    return true;
  }
  e.preventDefault();
  if (t.dataset.yeSkip) { S.marking = t.dataset.yeSkip; S.reason = ''; draw(); H.root.querySelector('#h-ye-r')?.focus(); return true; }
  if (t.dataset.yeCancel != null) { S.marking = null; draw(); return true; }
  if (t.dataset.yeUnskip) { api.yearendMark(api.s.yearend?.year, t.dataset.yeUnskip, null); return true; }
  return false;
}

export function onInput(e) {
  if (e.target.id !== 'h-ye-r') return false;
  S.reason = e.target.value;
  return true;
}

export function onSubmit(e) {
  const f = e.target;
  if (!f.dataset || !f.dataset.yeForm) return false;
  e.preventDefault();
  const reason = (f.reason?.value || '').trim();
  if (!reason) { f.reason?.focus(); return true; }
  const key = f.dataset.yeForm;
  const { api } = H;
  api.yearendMark(api.s.yearend?.year, key, reason).then((ok) => { if (ok) { S.marking = null; S.reason = ''; H.draw(); } });
  return true;
}
