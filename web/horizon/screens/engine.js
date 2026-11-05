/* Horizon engine screen: on/off switch, monthly spend against an editable cap, the recent spend
   ledger and the scheduled jobs. Every amount is a figure; ledger rows carry time, purpose, model
   and cost only. */

let H = null;

export function bind(kit) { H = kit; }

const S = { cap: null }; // unsaved cap input text

function capForm(b) {
  const { esc } = H;
  const v = S.cap != null ? S.cap : (Number.isFinite(Number(b.monthly)) ? String(Number(b.monthly)) : '');
  return `<form class="h-cap" novalidate>
      <label for="h-cap-usd">Monthly cap</label>
      <div class="h-cap-row"><span class="h-cap-in"><input id="h-cap-usd" name="usd" type="number" inputmode="decimal" step="0.01" min="0" max="10000" value="${esc(v)}" data-cap autocomplete="off"></span>
      <button type="submit" class="h-btn">Save cap</button></div>
      <p class="h-mute sm">Answers pause when the month's spend reaches the cap.</p>
    </form>`;
}

function ledgerHtml(en) {
  const { arr, esc, figHtml, section } = H;
  const rows = arr(en.ledger);
  const body = rows.length
    ? `<div class="h-ledger-h" role="row"><span role="columnheader">Time</span><span role="columnheader">Purpose</span><span role="columnheader">Model</span><span role="columnheader" class="r">Cost</span></div>`
      + rows.map((r) => `<div class="h-ledger-r" role="row">
        <div class="h-ledger-c mono" role="cell" data-l="Time">${esc(r.ts)}</div>
        <div class="h-ledger-c" role="cell" data-l="Purpose">${esc(r.purpose)}</div>
        <div class="h-ledger-c" role="cell" data-l="Model">${esc(r.model)}</div>
        <div class="h-ledger-c r mono" role="cell" data-l="Cost">${figHtml(`engine.ledger.${r.id}.cost`, { cents: true })}</div>
      </div>`).join('')
    : '<p class="h-ledger-e h-mute">No model calls yet this month.</p>';
  return section('Recent spend', `<div class="h-card h-ledger" role="table" aria-label="Recent model calls">${body}</div>`, 'Prompts and answers are never kept here');
}

export function render() {
  const { api, arr, T, figHtml, shell, section, pageHead } = H;
  const en = api.s.engine || {};
  const b = en.budget || {};
  const on = api.engineOn();
  // FATHOM_ENGINE=off pauses everything whatever the switch says.
  const configOff = en.mode === 'off';
  const running = on && !configOff;
  const used = Number(b.used) || 0, mo = Number(b.monthly) || 0;
  const p = mo ? Math.min(1, used / mo) : 0;
  const jobsList = arr(en.jobs);
  const cost = (j) => (typeof j.cost === 'number' ? figHtml(`engine.job.${j.id}.cost`, { cents: true }) : T(j.cost));
  const rows = jobsList.map((j) => `<div class="h-jt-r" role="row">
      <div class="h-jt-n" role="cell"><b>${T(j.name)}</b><p>${T(j.does)}</p></div>
      <div class="h-jt-c" role="cell" data-l="Cadence">${T(j.cadence)}</div>
      <div class="h-jt-c" role="cell" data-l="Last run">${T(j.last)}</div>
      <div class="h-jt-c${running ? '' : ' off'}" role="cell" data-l="Next run">${running ? T(j.next) : 'Paused'}</div>
      <div class="h-jt-c r mono" role="cell" data-l="Cost per run">${cost(j)}</div>
    </div>`).join('');
  const summary = `<div class="h-eng-sum">
      <div class="h-eng-c"><span class="h-eng-l">Status</span><b class="h-eng-v${running ? ' acc' : ''}">${configOff ? 'Off in configuration' : on ? 'On' : 'Off'}</b><div class="h-eng-s"><button type="button" class="h-btn" data-fx-engine>${on ? 'Turn the engine off' : 'Turn the engine on'}</button></div></div>
      <div class="h-eng-c"><span class="h-eng-l">Spent this month</span><b class="h-eng-v"><span class="mono">${figHtml('engine.budget.used', { cents: true })}</span> <em>of ${figHtml('engine.budget.monthly', { cents: true })}</em></b>
        <div class="h-eng-s col"><svg class="h-eng-meter" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${Math.round(p * 100)} percent of the monthly budget used"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${p * 100}" height="4" rx="2"/></svg>
        <div class="h-eng-sub"><span class="mono">${figHtml('engine.budget.left', { cents: true })} left</span><span class="mono">${Math.round(p * 100)}% used</span></div>
        ${capForm(b)}</div></div>
      <div class="h-eng-c"><span class="h-eng-l">Chat engine</span><b class="h-eng-v">${T(en.chat?.model)}</b>${en.chat?.note ? `<div class="h-eng-s"><p>${T(en.chat.note)}</p></div>` : ''}</div>
    </div>`;
  const table = jobsList.length ? `<div class="h-card h-jt" role="table" aria-label="Scheduled jobs">
      <div class="h-jt-h" role="row"><span role="columnheader">Job</span><span role="columnheader">Cadence</span><span role="columnheader">Last run</span><span role="columnheader">Next run</span><span role="columnheader" class="r">Cost per run</span></div>${rows}</div>` : '<p class="h-mute">No jobs scheduled.</p>';
  return shell(`${pageHead('Engine', running ? 'Running' : 'Paused', configOff
    ? "The engine is off in this deployment's configuration, so jobs and answers are paused."
    : on ? 'Proactive jobs run on schedule and stay inside the monthly budget.' : 'Proactive jobs are paused. Chat answers only from what is on file. Turn it back on here.')}
    <div class="h-card">${summary}</div>
    ${ledgerHtml(en)}
    ${section('Jobs', table, `${jobsList.length} scheduled`)}`, 'engine');
}

/* ---------- events ---------- */

// Returns true when the submit was handled here. The form has novalidate; api.setCap checks the
// range itself and shows the error toast, and the server validates again.
export function onSubmit(e) {
  const f = e.target;
  if (!f || !f.matches || !f.matches('form.h-cap')) return false;
  e.preventDefault();
  const raw = String(f.usd?.value ?? '').trim();
  const usd = raw === '' ? null : Number(raw);
  H.api.setCap(usd).then((res) => {
    if (res) { S.cap = null; H.draw(); }
  });
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (!t || !t.matches || !t.matches('input[data-cap]')) return false;
  S.cap = t.value;
  return true;
}

export function reset() { S.cap = null; }
