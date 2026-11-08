/* Horizon engine screen: on/off switch, monthly spend against an editable cap, the recent spend
   ledger and the scheduled jobs. Every amount is a figure; ledger rows carry time, purpose, model
   and cost only. */

let H = null;

export function bind(kit) { H = kit; }

const S = { cap: null, plan: { phase: 'idle', text: '' } }; // unsaved cap input text; the Run plan now state

/* ---------- Run plan now ---------- */

// Server refusals of POST /api/jobs/plan/run, in plain words. A demo household never plans.
const PLAN_REFUSED = [
  [/real stores only/, 'skipped', 'Planning runs on real households. This demo household skips it.'],
  [/already running/, 'failed', 'A plan is already running. Try again when it finishes.'],
  [/lock/, 'failed', 'Another process is running jobs right now. Try again in a minute.'],
  [/paused/, 'failed', 'Jobs are paused for this household, so the plan did not run.'],
];

// The phase and line for a finished request: `res` is the run response, or null with the server's
// message in `error`.
export function planOutcome(res, error) {
  if (res) {
    const status = res.run?.status;
    if (status === 'ok') return { phase: 'done', text: 'Plan finished. Recommendations and figures are up to date.' };
    if (status === 'skipped') return { phase: 'skipped', text: 'The plan had nothing to run.' };
    return { phase: 'failed', text: 'The plan run failed. The Jobs list below shows the last run.' };
  }
  const msg = String(error || '');
  for (const [re, phase, text] of PLAN_REFUSED) if (re.test(msg)) return { phase, text };
  return { phase: 'failed', text: `The plan did not run. ${msg}`.trim() };
}

export function setPlanState(p) { S.plan = { phase: p.phase, text: p.text || '' }; }

const PLAN_IDLE = 'Re-plans recommendations and deadlines from the latest data.';

// The Run plan now button and its status line, shown above the jobs table.
export function planControl() {
  const { esc } = H;
  const { phase, text } = S.plan;
  const running = phase === 'running';
  const line = running ? 'Running the plan.' : text || PLAN_IDLE;
  return `<div class="h-plan-run">
      <button type="button" class="h-btn" data-fx-plan-run${running ? ' disabled' : ''}>Run plan now</button>
      <p class="h-mute sm" role="status" aria-live="polite" data-plan-status data-plan-phase="${esc(phase)}">${esc(line)}</p>
    </div>`;
}

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

// Purpose labels are independent of provider configuration.
const PURPOSE_LABELS = { chat: 'Chat answers', job: 'Briefs and jobs', extract: 'Reading files', title: 'Thread names', confirm: 'Confirm guesses' };

function modelsHtml(en) {
  const { arr, esc } = H;
  const rows = arr(en.models).map((m) => `<li data-purpose="${esc(m.purpose)}"><span>${esc(PURPOSE_LABELS[m.purpose] || m.purpose)}</span><b class="mono">Configured</b></li>`).join('');
  return rows ? `<ul class="h-eng-models" aria-label="Model per purpose">${rows}</ul>` : '<b class="h-eng-v">Not configured</b>';
}

function ledgerHtml(en) {
  const { arr, esc, figHtml, section } = H;
  const rows = arr(en.ledger);
  const body = rows.length
    ? `<div class="h-ledger-h" role="row"><span role="columnheader">Time</span><span role="columnheader">Purpose</span><span role="columnheader">Model</span><span role="columnheader" class="r">Cost</span></div>`
      + rows.map((r) => `<div class="h-ledger-r" role="row">
        <div class="h-ledger-c mono" role="cell" data-l="Time">${esc(r.ts)}</div>
        <div class="h-ledger-c" role="cell" data-l="Purpose">${esc(r.purpose)}</div>
        <div class="h-ledger-c" role="cell" data-l="Model">Model service</div>
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
  // Engine on/off and the cap are admin controls on a real store (api.canAdmin is true on a demo store).
  const admin = api.canAdmin();
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
      <div class="h-eng-c"><span class="h-eng-l">Status</span><b class="h-eng-v${running ? ' acc' : ''}">${configOff ? 'Off in configuration' : on ? 'On' : 'Off'}</b><div class="h-eng-s">${admin ? `<button type="button" class="h-btn" data-fx-engine>${on ? 'Turn the engine off' : 'Turn the engine on'}</button>` : '<p class="h-mute sm" data-eng-admin-only>A household admin turns the engine on or off and sets the cap.</p>'}</div></div>
      <div class="h-eng-c"><span class="h-eng-l">Spent this month</span><b class="h-eng-v"><span class="mono">${figHtml('engine.budget.used', { cents: true })}</span> <em>of ${figHtml('engine.budget.monthly', { cents: true })}</em></b>
        <div class="h-eng-s col"><svg class="h-eng-meter" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${Math.round(p * 100)} percent of the monthly budget used"><rect class="bg" width="100" height="4" rx="2"/><rect class="fg" width="${p * 100}" height="4" rx="2"/></svg>
        <div class="h-eng-sub"><span class="mono">${figHtml('engine.budget.left', { cents: true })} left</span><span class="mono">${Math.round(p * 100)}% used</span></div>
        ${admin ? capForm(b) : ''}</div></div>
      <div class="h-eng-c"><span class="h-eng-l">Models</span>${modelsHtml(en)}${en.chat?.note ? `<div class="h-eng-s"><p>${T(en.chat.note)}</p></div>` : ''}</div>
    </div>`;
  const table = jobsList.length ? `<div class="h-card h-jt" role="table" aria-label="Scheduled jobs">
      <div class="h-jt-h" role="row"><span role="columnheader">Job</span><span role="columnheader">Cadence</span><span role="columnheader">Last run</span><span role="columnheader">Next run</span><span role="columnheader" class="r">Cost per run</span></div>${rows}</div>` : '<p class="h-mute">No jobs scheduled.</p>';
  return shell(`${pageHead('Engine', running ? 'Running' : 'Paused', configOff
    ? "The engine is off in this deployment's configuration, so jobs and answers are paused."
    : on ? 'Proactive jobs run on schedule and stay inside the monthly budget.' : 'Proactive jobs are paused. Chat answers only from what is on file. Turn it back on here.')}
    <div class="h-card">${summary}</div>
    ${ledgerHtml(en)}
    ${section('Jobs', planControl() + table, `${jobsList.length} scheduled`)}`);
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

export function onClick(e) {
  const t = e.target?.closest?.('[data-fx-plan-run]');
  if (!t || !H.root?.contains(t)) return false;
  e.preventDefault();
  if (S.plan.phase === 'running') return true;
  setPlanState({ phase: 'running' });
  H.draw();
  H.api.runPlan().then(({ res, error }) => {
    setPlanState(planOutcome(res, error));
    H.draw();
  });
  return true;
}

export function reset() { S.cap = null; S.plan = { phase: 'idle', text: '' }; }
