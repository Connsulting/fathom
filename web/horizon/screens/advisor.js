/* Horizon advisor workflow (item 24): the Advisor screen (next check-in, waiting on review,
   reviewed, review packets), the rec detail's Advisor box and the Plan row's Send to advisor
   button. The owner runs the workflow; there are no advisor accounts. Notes arrive escaped from
   the server and render through T like every stored text. */

let H = null;

export function bind(kit) { H = kit; }

const S = { open: null, checkin: false, busy: false, packetOk: '', packetErr: '' };

export function reset() { S.open = null; S.checkin = false; S.busy = false; S.packetOk = ''; S.packetErr = ''; }

const MAX_NOTE = 1000;
const today = () => H.api.s.meta?.clock || new Date().toISOString().slice(0, 10);

function verdictForm(reviewId) {
  const { esc } = H;
  const id = esc(reviewId);
  return `<form class="h-advf" data-adv-form="${id}" novalidate>
    <fieldset><legend>The advisor's verdict</legend>
      <label class="h-advf-r"><input type="radio" name="verdict" value="confirmed"> Confirmed</label>
      <label class="h-advf-r"><input type="radio" name="verdict" value="vetoed"> Vetoed</label>
    </fieldset>
    <label class="h-advf-l" for="h-advf-note-${id}">The advisor's note</label>
    <textarea id="h-advf-note-${id}" name="note" rows="3" maxlength="${MAX_NOTE}" placeholder="What the advisor said"></textarea>
    <label class="h-advf-l" for="h-advf-date-${id}">Date of the review</label>
    <input id="h-advf-date-${id}" name="date" type="date" value="${esc(today())}">
    <p class="h-advf-err h-mute sm" role="alert" hidden></p>
    <div class="h-advf-b"><button type="submit" class="h-btn pri">Save verdict</button><button type="button" class="h-btn ghost" data-adv-cancel>Cancel</button></div>
  </form>`;
}

const verdictBtn = (reviewId) => H.btn('Record verdict', `data-adv-verdict="${H.esc(reviewId)}"`, '');
const verdictOrForm = (reviewId) => (S.open === String(reviewId) ? verdictForm(reviewId) : verdictBtn(reviewId));

// The rec detail's Advisor box.
export function recBox(r) {
  const { icon, esc, T, btn, goA } = H;
  const a = r.advisor;
  if (!a) {
    if (r.status === 'hidden') return '';
    return `<div class="h-advbox"><div class="h-adv">${icon('clock')}Not sent to your advisor</div>
      <p class="h-mute">Send it to put it on the review list and in the next packet.</p>
      <div class="h-advbox-b">${btn('Send to advisor', `data-adv-send="${esc(r.id)}"`, '')}</div></div>`;
  }
  if (a.verdict === 'pending') {
    return `<div class="h-advbox"><div class="h-adv">${icon('clock')}Waiting on advisor review</div>
      <p class="h-mute">Sent ${esc(a.date)}. ${goA('advisor', 'Check-in')}</p>
      <div class="h-advbox-b">${verdictOrForm(a.reviewId)}</div></div>`;
  }
  const label = a.verdict === 'vetoed' ? `${icon('x')}Advisor vetoed` : `${icon('check')}Advisor confirmed`;
  return `<div class="h-advbox ${a.verdict}"><div class="h-adv ${a.verdict}">${label}</div>${a.note ? `<p>${T(a.note)}</p>` : ''}
    <p class="h-mute sm">${esc(a.date)}</p>
    <div class="h-advbox-b">${btn('Send again', `data-adv-send="${esc(r.id)}"`, 'ghost')}</div></div>`;
}

// The Plan row's button, for open recs not yet sent.
export function rowAction(r) {
  if (r.advisor || ['done', 'dismissed', 'hidden'].includes(r.status)) return '';
  return H.btn('Send to advisor', `data-adv-send="${H.esc(r.id)}"`, 'ghost');
}

function checkinForm(n) {
  const { esc } = H;
  return `<form class="h-advf h-advci" data-adv-checkin novalidate>
    <div class="h-advci-row">
      <div><label class="h-advf-l" for="h-advci-date">Date</label><input id="h-advci-date" name="date" type="date" value="${esc(n.date || '')}"></div>
      <div><label class="h-advf-l" for="h-advci-time">Time</label><input id="h-advci-time" name="time" type="time" value="${esc(n.time || '')}"></div>
      <div><label class="h-advf-l" for="h-advci-len">Length, minutes</label><input id="h-advci-len" name="lengthMin" type="number" min="5" max="480" step="5" value="${esc(n.lengthMin || 60)}"></div>
    </div>
    <p class="h-advf-err h-mute sm" role="alert" hidden></p>
    <div class="h-advf-b"><button type="submit" class="h-btn pri">Save check-in</button><button type="button" class="h-btn ghost" data-adv-checkin-cancel>Cancel</button></div>
  </form>`;
}

export function render() {
  const { api, arr, esc, T, icon, shell, section, pageHead, goA, href, recById, statusText, btn } = H;
  const a = api.s.advisor || {};
  const n = a.next || {};
  const recLink = (id, title) => {
    const r = id ? recById(id) : null;
    return r ? goA('rec', T(r.title), { id: r.id }) : T(title || '');
  };
  const waiting = arr(a.waiting).map((w) => {
    const r = recById(w.recId);
    return `<li class="h-advw" data-review="${esc(w.reviewId)}"><div class="h-advw-t"><a href="${href('rec', { id: w.recId })}" data-go="rec" data-id="${esc(w.recId)}"><span>${T(w.title)}</span>${r ? `<em>${statusText(r)}</em>` : ''}</a><p class="h-mute sm">Sent ${esc(w.sent)}</p></div>
      <div class="h-advw-b">${verdictOrForm(w.reviewId)}</div></li>`;
  }).join('');
  const reviewed = arr(a.reviewed).map((v) => `<li class="h-rv ${v.verdict}"><div class="h-adv ${v.verdict}">${v.verdict === 'vetoed' ? icon('x') + 'Vetoed' : icon('check') + 'Confirmed'}</div><div><b>${recLink(v.recId, v.title)}</b>${v.note ? `<p>${T(v.note)}</p>` : ''}<p class="h-rv-d">${esc(v.date)}</p></div></li>`).join('');
  const conf = arr(a.reviewed).filter((v) => v.verdict === 'confirmed').length;
  const vet = arr(a.reviewed).filter((v) => v.verdict === 'vetoed').length;
  const packets = arr(a.packets).map((p) => {
    const label = S.packetOk && p.id === S.packetOk ? 'Download again' : `Packet, ${p.date}`;
    return `<li><a href="${esc(H.api.downloadHref(`/api/advisor/packets/${encodeURIComponent(p.id)}`))}" download data-adv-dl>${icon('arrow')}<span>${esc(label)}</span></a><span class="h-mute sm">${arr(p.recIds).length} for review</span></li>`;
  }).join('');
  const notAsk = arr(a.notAsking).map((q) => `<li><b>${T(q.q)}</b><p>${T(q.why)}</p></li>`).join('');
  const shared = arr(a.shared).map((s) => `<li><span>${T(s.title)}</span><time>${T(s.when)}</time></li>`).join('');
  const experts = arr(a.experts).map((e) => `<li><b>${T(e.name)}</b><span>${T(e.role)}</span><p>${T(e.when)}</p></li>`).join('');
  const nWait = arr(a.waiting).length;
  const nextBox = S.checkin ? checkinForm(n)
    : `<div class="h-next"><div><span>Next check-in</span><b>${n.when ? esc(n.when) : 'Not set'}</b></div><div><span>Length</span><b>${n.length ? esc(n.length) : 'Not set'}</b></div><div><span>Reviewed</span><b>${conf} confirmed, ${vet} vetoed</b></div><div><span>Waiting on review</span><b>${nWait}</b></div></div>
      <div class="h-acts">${btn(n.when ? 'Change check-in' : 'Set check-in', 'data-adv-checkin-edit', 'ghost')}</div>`;
  const canPrepare = nWait > 0 && !S.busy;
  const prepLabel = S.busy ? '<span class="h-spin" aria-hidden="true"></span>Preparing' : 'Prepare packet';
  const prepAttrs = `data-adv-packet${canPrepare ? '' : ' disabled'}${S.busy ? ' aria-busy="true"' : ''}`;
  const emptyHint = nWait ? '' : `<p class="h-adv-hint" data-adv-empty>Send a recommendation to your advisor first; it lands here for review. <a href="${href('plan')}" data-go="plan">Plan</a></p>`;
  const packetStatus = S.packetErr
    ? `<p class="h-adv-status err" role="alert">${esc(S.packetErr)}</p>`
    : (S.packetOk ? '<p class="h-adv-status" role="status">Packet ready.</p>' : '');
  const packetSec = section('Review packet', `<p class="h-mute">A printable summary of everything waiting on review, with each figure's source. Download it, then print to PDF from your browser.</p>
      <div class="h-acts">${btn(prepLabel, prepAttrs, canPrepare ? 'pri h-adv-prep' : 'h-adv-prep')}</div>
      ${emptyHint}${packetStatus}
      ${packets ? `<ul class="h-advpk">${packets}</ul>` : ''}`);
  return shell(`${pageHead('Advisor', a.name ? T(a.name) : esc(api.s.names?.advisor || 'Your advisor'), T(a.role))}
    ${nextBox}
    <div class="h-cols"><div class="h-col-main">
      ${a.agenda ? section('Agenda', `<div class="h-prose"><p>${T(a.agenda)}</p></div>`) : ''}
      ${section('Waiting on review', waiting ? `<ul class="h-advws">${waiting}</ul>` : '<p class="h-mute">Nothing is waiting. Send a recommendation from its page or the Plan.</p>')}
      ${section('Reviewed', reviewed ? `<ul class="h-rvs">${reviewed}</ul>` : '<p class="h-mute">No verdicts recorded yet.</p>')}
    </div><div class="h-col-side">
      ${packetSec}
      ${notAsk ? section('Not asking you', `<ul class="h-advq">${notAsk}</ul>`) : ''}
      ${shared ? section('Shared with the advisor', `<ul class="h-kv">${shared}</ul>`) : ''}
      ${experts ? section('Specialists', `<ul class="h-experts">${experts}</ul>`) : ''}
    </div></div>`);
}

function showErr(form, text) {
  const el = form.querySelector('.h-advf-err');
  if (el) { el.textContent = text; el.hidden = false; }
}

export function onClick(e) {
  const t = e.target.closest('[data-adv-send],[data-adv-verdict],[data-adv-cancel],[data-adv-checkin-edit],[data-adv-checkin-cancel],[data-adv-packet]');
  if (!t || !H.root.contains(t)) return false;
  e.preventDefault();
  const d = t.dataset;
  if (d.advSend != null) { H.api.sendToAdvisor(d.advSend); return true; }
  if (d.advVerdict != null) {
    S.open = d.advVerdict; H.draw();
    H.root.querySelector(`[data-adv-form="${CSS.escape(S.open)}"] input[name="verdict"]`)?.focus();
    return true;
  }
  if (d.advCancel != null) { S.open = null; H.draw(); return true; }
  if (d.advCheckinEdit != null) { S.checkin = true; H.draw(); H.root.querySelector('#h-advci-date')?.focus(); return true; }
  if (d.advCheckinCancel != null) { S.checkin = false; H.draw(); return true; }
  if (d.advPacket != null) {
    if (S.busy || t.disabled) return true;
    S.busy = true;
    S.packetErr = '';
    H.draw();
    H.api.advisorPacket().then((id) => {
      S.busy = false;
      if (id) {
        S.packetOk = id;
        S.packetErr = '';
        H.draw();
        const a = document.createElement('a');
        a.href = H.api.downloadHref(`/api/advisor/packets/${encodeURIComponent(id)}`);
        a.setAttribute('download', '');
        document.body.appendChild(a); a.click(); a.remove();
      } else {
        S.packetOk = '';
        S.packetErr = H.api.lastError() || 'The packet was not prepared.';
        H.draw();
      }
    });
    return true;
  }
  return false;
}

export function onSubmit(e) {
  const f = e.target;
  if (f.dataset.advForm != null) {
    e.preventDefault();
    const verdict = f.querySelector('input[name="verdict"]:checked')?.value;
    const note = f.note.value.trim();
    const date = f.date.value;
    if (!verdict) { showErr(f, 'Pick confirmed or vetoed.'); return true; }
    if (note.length > MAX_NOTE) { showErr(f, `Keep the note under ${MAX_NOTE} characters.`); return true; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showErr(f, 'Enter the date of the review.'); return true; }
    const id = f.dataset.advForm;
    H.api.advisorVerdict(id, verdict, note, date).then((ok) => {
      if (ok) { S.open = null; H.draw(); return; }
      const live = H.root.querySelector(`[data-adv-form="${CSS.escape(id)}"]`);
      if (live) showErr(live, H.api.lastError() || 'The verdict was not saved.');
    });
    return true;
  }
  if (f.dataset.advCheckin != null) {
    e.preventDefault();
    const date = f.date.value;
    const time = f.time.value;
    const lengthMin = Number(f.lengthMin.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showErr(f, 'Enter the date of the check-in.'); return true; }
    if (!Number.isInteger(lengthMin) || lengthMin < 5 || lengthMin > 480) { showErr(f, 'Length must be 5 to 480 minutes.'); return true; }
    H.api.advisorCheckin(date, time || null, lengthMin).then((ok) => {
      if (ok) { S.checkin = false; H.draw(); return; }
      const live = H.root.querySelector('[data-adv-checkin]');
      if (live) showErr(live, H.api.lastError() || 'The check-in was not saved.');
    });
    return true;
  }
  return false;
}
