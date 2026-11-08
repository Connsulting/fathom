/* Background service status, shared by Home, Engine, Email and the SimpleFIN block. The server
   builds the model (src/jobs/service-status.mjs) into scenario.live.services and GET /api/jobs;
   these helpers only render it and dispatch its one control per service. design.js binds this
   module and delegates clicks here. */

let H = null;
export function bind(kit) { H = kit; }

export const STATE_LABEL = Object.freeze({ healthy: 'Healthy', retrying: 'Retrying', paused: 'Paused', needs_you: 'Needs you' });

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${MON[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function controlHtml(c) {
  if (!c || typeof c !== 'object' || !c.id) return '';
  const { esc } = H;
  const arg = c.arg != null ? ` data-svc-arg="${esc(c.arg)}"` : '';
  return `<button type="button" class="h-btn" data-svc-act="${esc(c.id)}"${arg}>${esc(c.label || 'Check again')}</button>`;
}

// One service: its state, the cause, Last success, Next attempt and its one control.
export function statusHtml(svc) {
  if (!svc || typeof svc !== 'object') return '';
  const { esc } = H;
  const state = Object.hasOwn(STATE_LABEL, svc.state) ? svc.state : 'healthy';
  const next = when(svc.nextAttemptAt) || (state === 'paused' ? 'Not until resumed' : 'None scheduled');
  return `<div class="h-svc ${esc(state)}" data-svc="${esc(svc.key)}" data-svc-state="${esc(state)}">
      <div class="h-svc-h"><b>${esc(svc.label)}</b><span class="h-svc-st">${esc(STATE_LABEL[state])}</span></div>
      ${svc.cause ? `<p class="h-svc-c">${esc(svc.cause)}</p>` : ''}
      <dl class="h-svc-dl"><div><dt>Last success</dt><dd>${esc(when(svc.lastSuccessAt) || 'None yet')}</dd></div><div><dt>Next attempt</dt><dd>${esc(next)}</dd></div></dl>
      ${controlHtml(svc.control)}
    </div>`;
}

// The one Home line: the service the server picked as needing attention, or null.
export function attentionLine(services) {
  const a = services && typeof services === 'object' ? services.attention : null;
  if (!a || typeof a !== 'object' || !a.go) return null;
  const text = a.cause ? `${a.label}: ${a.cause}` : `${a.label} needs a look.`;
  return { text, go: a.go, key: a.key };
}

export function homeServiceHtml(services) {
  const line = attentionLine(services);
  if (!line) return '';
  const { esc } = H;
  const href = typeof H.href === 'function' ? H.href(line.go) : `#/${line.go}`;
  return `<div class="h-svc-line" data-service-line><a href="${esc(href)}" data-go="${esc(line.go)}">${esc(line.text)}</a></div>`;
}

// Focus a field on this page, else open the screen that has it and focus it there.
function focusOr(selector, route) {
  const el = H.root?.querySelector(selector);
  if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); return; }
  H.api.go(route, {});
  setTimeout(() => H.root?.querySelector(selector)?.focus(), 50);
}

export function onClick(e) {
  const t = e.target?.closest?.('[data-svc-act]');
  if (!t || !H.root?.contains(t)) return false;
  e.preventDefault();
  const { api } = H;
  const arg = t.dataset.svcArg;
  const after = (p) => { t.disabled = true; Promise.resolve(p).then(() => { H.serviceChanged?.(); H.draw(); }); };
  switch (t.dataset.svcAct) {
    case 'run_job': if (arg) after(api.runJob(arg)); break;
    case 'resume': if (arg) after(api.setOutbound({ [arg]: true })); break;
    case 'engine_on': after(api.setEngine(true)); break;
    case 'cap': focusOr('#h-cap-usd', 'engine'); break;
    case 'reconnect': focusOr('textarea[data-sf-token]', 'money'); break;
    case 'sync_now': after(api.simplefinSync()); break;
    case 'test_email': {
      const b = H.root.querySelector('[data-email-send="test"]');
      if (b) b.click(); else api.go('email', {});
      break;
    }
    case 'refresh': after(api.refresh()); break;
    default: break;
  }
  return true;
}
