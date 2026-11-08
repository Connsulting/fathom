/* Horizon Email screen: transport status with the masked recipient, Send test email and Send brief
   now, the brief preview in a sandboxed iframe (srcdoc only, never a URL), the send history and
   the scheduled jobs with Run now. Data comes from GET /api/email and GET /api/jobs, not the
   scenario. Server text is plain text and always goes through esc(), never token resolution. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND = { test: 'Test', brief: 'Brief', alert: 'Alert' };
const SEND = { sent: 'Sent', failed: 'Failed' };
const RUN = { running: 'Running', ok: 'Done', skipped: 'Skipped', error: 'Failed' };
const STATE = { dev: 'Development', configured: 'Configured', missing_config: 'Not configured', missing_credential: 'Credential missing' };
const TRIGGER = { scheduled: 'scheduled', manual: 'manual', ingest: 'after an import' };
const FAIL = {
  missing_config: 'sender or recipient not configured',
  missing_credential: 'credential missing',
  auth: 'credential rejected',
  not_found: 'sender not found',
  rate_limited: 'rate limited',
  invalid: 'request rejected as invalid',
  rejected: 'message rejected',
  network: 'provider unreachable',
  other: 'send failed'
};

const arr = (a) => (Array.isArray(a) ? a : []);

// 'Nov 5, 3:04 PM' in the viewer's zone from an ISO timestamp; '' when there is none.
function when(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${MON[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `The server answered ${res.status}.`);
  if (!data || typeof data !== 'object') throw new Error('The server sent an unexpected reply.');
  return data;
}

async function getJson(path) {
  let res;
  try {
    res = await window.Fathom.api.fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new Error('The server could not be reached.');
  }
  return readJson(res);
}

async function postJson(path) {
  let res;
  try {
    res = await window.Fathom.api.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      credentials: 'same-origin'
    });
  } catch {
    throw new Error('The server could not be reached.');
  }
  return readJson(res);
}

export function emailScreen(h) {
  const { shell, section, pageHead, btn, esc, draw } = h;
  // Module state survives re-renders (the design redraws the whole page on every change).
  const st = { email: null, jobs: null, loading: false, error: '', notice: '', busy: '', running: {} };

  function load() {
    if (st.loading) return Promise.resolve();
    st.loading = true;
    return Promise.all([getJson('/api/email'), getJson('/api/jobs')]).then(
      ([email, jobs]) => { st.email = email; st.jobs = jobs; st.error = ''; },
      (err) => { st.error = `Could not load email settings. ${err.message}`; }
    ).then(() => { st.loading = false; draw(); });
  }

  // The latest run of a job: its lastRun object when the server sends one, else the newest run row.
  function lastRunOf(job) {
    const lr = job.lastRun;
    if (lr && typeof lr === 'object') return lr;
    const runs = arr(st.jobs?.runs).filter((r) => r.jobId === job.id);
    return runs.reduce((a, r) => (a == null || Number(r.id) > Number(a.id) ? r : a), null);
  }

  function statusBlock() {
    const s = st.email?.status;
    if (!s) return '';
    const more = Number(s.recipients) > 1 ? ` and ${Number(s.recipients) - 1} more` : '';
    const recipient = s.recipient ? `<span class="mono">${esc(s.recipient)}</span>${esc(more)}` : '<span class="h-mute">None set</span>';
    const busy = !!st.busy;
    const acts = `<div class="h-acts">${btn(st.busy === 'test' ? 'Sending' : 'Send test email', `data-email-send="test"${busy ? ' disabled' : ''}`)}${btn(st.busy === 'brief' ? 'Sending' : 'Send brief now', `data-email-send="brief"${busy ? ' disabled' : ''}`, 'pri')}</div>`;
    return `<div class="h-card h-em-st" data-email-status>
      <dl class="h-em-dl">
        <div><dt>Transport</dt><dd class="mono">${esc(s.transport)}</dd></div>
        <div><dt>State</dt><dd class="h-em-state ${esc(s.state)}">${esc(STATE[s.state] || s.state)}</dd></div>
        <div><dt>Recipient</dt><dd>${recipient}</dd></div>
      </dl>
      ${s.detail ? `<p class="h-em-detail">${esc(s.detail)}</p>` : ''}
      <div class="h-em-ctl">${acts}${st.notice ? `<p class="h-em-note" role="status">${esc(st.notice)}</p>` : ''}</div>
    </div>`;
  }

  function preview() {
    const p = st.email?.preview;
    if (!p) return '';
    // The page CSP allows inline style attributes but not a <style> element, and srcdoc inherits it.
    // The email's head style only sets color-scheme and a mobile gutter; every surface carries inline
    // colors, so the preview drops the element and looks the same.
    const html = String(p.html || '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const src = p.summarySrc === 'model' ? 'Summary written by the engine' : 'Summary from the template';
    return section('Preview', `<div class="h-card h-em-pv">
      <div class="h-em-pv-h" data-email-subject><span>Subject</span><b>${esc(p.subject)}</b></div>
      <iframe class="h-em-frame" title="Brief preview" sandbox="" srcdoc="${esc(html)}"></iframe>
    </div>`, esc(src));
  }

  function historyTable() {
    const rows = arr(st.email?.history);
    if (!rows.length) return section('Sent', '<p class="h-mute">Nothing sent yet.</p>');
    const body = rows.map((r) => {
      const failed = r.status === 'failed';
      const why = failed && r.errorCode ? `<span>${esc(FAIL[r.errorCode] || r.errorCode)}</span>` : '';
      return `<tr><td class="h-em-kind">${esc(KIND[r.kind] || r.kind)}</td><td class="h-em-subj"><b>${esc(r.subject)}</b><span>${esc(when(r.ts))}</span></td>
        <td class="h-em-res ${failed ? 'fail' : 'ok'}"><b>${esc(SEND[r.status] || r.status)}</b>${why}</td></tr>`;
    }).join('');
    return section('Sent', `<div class="h-card h-em-tw"><table class="h-em-t" data-email-history>
      <thead><tr><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Result</th></tr></thead>
      <tbody>${body}</tbody></table></div>`, `${rows.length} recent`);
  }

  function jobsTable() {
    const jobs = arr(st.jobs?.jobs);
    if (!jobs.length) return section('Jobs', '<p class="h-mute">No jobs scheduled.</p>');
    const body = jobs.map((j) => {
      const last = lastRunOf(j);
      const lastId = last && last.id != null ? String(last.id) : '';
      const lastText = last
        ? `<b>${esc(RUN[last.status] || last.status || '')}</b><span>${esc([when(last.finishedAt ?? last.startedAt), TRIGGER[last.trigger] || ''].filter(Boolean).join(', '))}</span>`
        : '<span class="h-mute">Not run yet</span>';
      const busy = !!st.running[j.id];
      return `<tr data-job="${esc(j.id)}" data-last-run="${esc(lastId)}">
        <td class="h-em-job"><b>${esc(j.name)}</b><p>${esc(j.does)}</p></td>
        <td data-l="Cadence">${esc(j.cadence)}</td>
        <td class="h-em-last" data-l="Last run" data-job-last>${lastText}</td>
        <td data-l="Next run">${esc(j.next)}</td>
        <td class="r">${btn(busy ? 'Running' : 'Run now', `data-job-run="${esc(j.id)}"${busy ? ' disabled' : ''}`, 'ghost')}</td>
      </tr>`;
    }).join('');
    const tz = st.jobs?.timezone ? `Times in ${esc(st.jobs.timezone)}` : '';
    return section('Jobs', `<div class="h-card h-em-tw"><table class="h-em-t jobs" aria-label="Scheduled jobs">
      <thead><tr><th scope="col">Job</th><th scope="col">Cadence</th><th scope="col">Last run</th><th scope="col">Next run</th><th scope="col"><span class="h-em-sr">Actions</span></th></tr></thead>
      <tbody>${body}</tbody></table></div>`, tz);
  }

  // fresh: the route was just entered, so reload the data.
  function page(fresh) {
    if ((fresh || (!st.email && !st.error)) && !st.loading) load();
    let inner;
    if (st.email) inner = `${statusBlock()}${st.error ? `<p class="h-em-err" role="alert">${esc(st.error)}</p>` : ''}
      <div class="h-cols"><div class="h-col-main">${preview()}</div><div class="h-col-side">${historyTable()}</div></div>${jobsTable()}`;
    else if (st.error) inner = `<p class="h-em-err" role="alert">${esc(st.error)}</p>${btn('Try again', 'data-email-reload="1"')}`;
    else inner = '<p class="h-mute">Loading.</p>';
    return shell(`${pageHead('Email', 'Monthly digest', 'What lands in your inbox on brief day. One email a month, nothing in between unless a window is about to close.')}${inner}`);
  }

  function act(kind) {
    if (st.busy) return;
    st.busy = kind;
    st.notice = '';
    draw();
    postJson(`/api/email/${kind}`).then(
      (d) => {
        const s = d.send || {};
        const what = kind === 'test' ? 'Test email' : 'Brief';
        st.notice = s.status === 'sent' ? `${what} sent.` : `${what} not sent: ${FAIL[s.errorCode] || 'send failed'}.`;
        if (st.email && Array.isArray(d.history)) st.email.history = d.history;
      },
      (err) => { st.notice = `Could not send. ${err.message}`; }
    ).then(() => { st.busy = ''; return load(); });
  }

  function runJob(id) {
    if (st.running[id]) return;
    st.running[id] = true;
    st.notice = '';
    draw();
    postJson(`/api/jobs/${encodeURIComponent(id)}/run`).then(
      () => {},
      (err) => { st.notice = `Could not run that job. ${err.message}`; }
    ).then(() => { delete st.running[id]; return load(); });
  }

  function handleClick(e) {
    const t = e.target.closest?.('[data-email-send],[data-job-run],[data-email-reload]');
    if (!t) return false;
    e.preventDefault();
    const d = t.dataset;
    if (d.emailSend) act(d.emailSend);
    else if (d.jobRun) runJob(d.jobRun);
    else if (d.emailReload) { st.error = ''; load(); }
    return true;
  }

  return { page, handleClick };
}
