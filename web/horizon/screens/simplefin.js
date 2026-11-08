/* SimpleFIN Bridge connection: the setup token form, then "Connected to SimpleFIN, N accounts,
   last sync <time>" with Sync now and Disconnect, and a reconnect prompt when the bridge refused
   access. State comes from live.simplefin in the scenario, which never holds the access URL. The
   pasted token lives only in the form field and this module's memory until it is sent; it is
   cleared on success and never written to storage, the URL or the console. Rendered on the
   Accounts screen and the onboarding Tell us step; design.js delegates events here. */

import { statusHtml } from './service-status.js';

let H = null;
export function bind(kit) { H = kit; }

const S = { token: '', busy: '', notice: '' };
export function reset() { S.token = ''; S.busy = ''; S.notice = ''; }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return 'not yet';
  const h = d.getHours();
  return `${MON[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const PROBLEM = {
  revoked: 'SimpleFIN refused access. Reconnect with a new setup token.',
  payment_required: 'SimpleFIN says the subscription needs payment. Renew it, then reconnect.',
  auth: 'SimpleFIN reports a sign-in problem with a connected institution. Fix it on the SimpleFIN Bridge site, or reconnect.',
  bad_access: 'The stored connection cannot be used. Reconnect with a new setup token.',
  bad_response: 'The last sync got a reply Fathom could not read. It tries again on the next sync.'
};

// SimpleFIN sync waits on the household's jobs flag and its SimpleFIN flag (`services` is
// scenario.live.services).
// Controls this block already shows (Sync now, and the reconnect form), so the status card does
// not repeat them.
const BLOCK_CONTROLS = new Set(['sync_now', 'reconnect']);

const syncPaused = (services) => services?.simplefin?.state === 'paused' || services?.jobs?.['simplefin-sync']?.state === 'paused';

// The warning line for a failed last sync. A network failure names the next scheduled sync, taken
// from the Engine job list (`jobs` is api.s.engine.jobs), unless sync is paused.
export function problemText(code, jobs, services) {
  if (code === 'network') {
    if (syncPaused(services)) return 'The SimpleFIN bridge did not answer in time. Sync is paused, so Fathom will not retry until it is resumed.';
    const next = (Array.isArray(jobs) ? jobs : []).find((j) => j && j.id === 'simplefin-sync')?.next;
    return `The SimpleFIN bridge did not answer in time. Fathom tries again on the next scheduled sync${next ? `, ${next}` : ''}.`;
  }
  return PROBLEM[code] || 'The last sync failed. It tries again on the next sync.';
}

const state = () => H.api.s?.live?.simplefin || { connected: false };

// What a sync in flight and its last result look like, for other screens that offer Sync now.
export const status = () => ({ busy: S.busy, notice: S.notice });

function form(sf, reconnect) {
  const { esc, btn } = H;
  return `<form class="h-sf-form" data-sf-form novalidate>
      <label for="h-sf-token">${reconnect ? 'New SimpleFIN setup token' : 'SimpleFIN setup token'}</label>
      <textarea id="h-sf-token" name="token" rows="3" data-sf-token autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the token here">${esc(S.token)}</textarea>
      <p class="h-mute sm">Create a setup token on the SimpleFIN Bridge site (bridge.simplefin.org) and paste it here. Each token works once. Fathom keeps the access encrypted and only reads.</p>
      <div class="h-sf-act">${sf.demo && sf.demoToken ? btn('Use the demo token', 'type="button" data-sf="demo"', 'ghost') : ''}<button type="submit" class="h-btn pri"${S.busy ? ' disabled' : ''}>${S.busy === 'connect' ? 'Syncing' : reconnect ? 'Reconnect' : 'Connect'}</button></div>
      ${sf.demo ? '<p class="h-mute sm">Demo: this uses a synthetic SimpleFIN bridge with made up accounts. Nothing leaves this machine.</p>' : ''}
    </form>`;
}

// The connection block: the form, or the connected status with its actions.
export function block() {
  const { esc, btn, icon, plural, goA } = H;
  const sf = state();
  if (!sf.connected) return `<div class="h-sf" data-sf-box>${form(sf, false)}</div>`;
  const services = H.api.s?.live?.services || null;
  // The status block, when shown, says what the warning line would, with its control. The
  // connection comes first; with a healthy connection, a sync job that is not healthy shows.
  const unwell = (x) => (x && x.state !== 'healthy' ? x : null);
  const svc = unwell(services?.simplefin) || unwell(services?.jobs?.['simplefin-sync']);
  const problem = !svc && sf.errorCode ? problemText(sf.errorCode, H.api.s?.engine?.jobs, services) : '';
  const msgs = Array.isArray(sf.messages) ? sf.messages : [];
  return `<div class="h-sf on" data-sf-box data-sf-connected>
      <p class="h-sf-st">${icon('check')}<span><b>Connected to SimpleFIN</b>, ${plural(Number(sf.accounts) || 0, 'account')}, last sync ${esc(when(sf.lastSyncAt))}</span></p>
      ${S.notice ? `<p class="h-sf-sync" data-sf-sync>${esc(S.notice)}</p>` : ''}
      ${svc ? statusHtml(svc, { control: !BLOCK_CONTROLS.has(svc.control?.id) }) : ''}
      ${problem ? `<p class="h-sf-warn" role="alert">${esc(problem)}</p>` : ''}
      ${msgs.length ? `<ul class="h-sf-msgs">${msgs.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${sf.pendingMatches ? `<p class="h-mute sm">${plural(sf.pendingMatches, 'connected account')} ${sf.pendingMatches === 1 ? 'needs' : 'need'} an answer first: is it an account you already imported? ${goA('confirm', 'Answer in Confirm')}</p>` : ''}
      <div class="h-sf-act">${btn(S.busy === 'sync' ? 'Syncing' : 'Sync now', `type="button" data-sf="sync"${S.busy ? ' disabled' : ''}`, '')}${btn('Disconnect', `type="button" data-sf="disconnect"${S.busy ? ' disabled' : ''}`, 'ghost')}</div>
      ${sf.reconnect ? form(sf, true) : ''}
    </div>`;
}

// A failed or skipped run still returns HTTP 200 with run.status set. Only an ok run gets the
// success line. Connect and Sync now both put that run on the response.
export function syncNotice(res) {
  const run = res && res.run;
  if (!run || run.status !== 'ok') return '';
  const sc = res.scenario;
  const through = sc && sc.meta && sc.meta.dataThrough;
  if (!through) return '';
  const n = Number(sc.live && sc.live.simplefin && sc.live.simplefin.accounts) || 0;
  return `Synced ${n} accounts, data through ${through}`;
}

function run(kind, p) {
  S.busy = kind;
  S.notice = '';
  H.draw();
  return p.then((res) => {
    S.busy = '';
    if (kind === 'connect' || kind === 'sync') {
      if (res) S.token = '';
      S.notice = syncNotice(res);
    }
    H.draw();
    return res;
  });
}

export function onClick(e) {
  const t = e.target.closest?.('[data-sf]');
  if (!t || !H.root?.contains(t)) return false;
  e.preventDefault();
  if (S.busy) return true;
  const sf = state();
  const a = t.dataset.sf;
  if (a === 'demo' && sf.demoToken) { S.token = sf.demoToken; H.draw(); return true; }
  if (a === 'sync') { run('sync', H.api.simplefinSync()); return true; }
  if (a === 'disconnect') { run('disconnect', H.api.simplefinDisconnect()); return true; }
  return true;
}

export function onSubmit(e) {
  const f = e.target;
  if (!f?.matches?.('form[data-sf-form]')) return false;
  e.preventDefault();
  if (S.busy) return true;
  const token = String(f.token?.value ?? S.token).trim();
  S.token = token;
  if (!token) { H.api.showError?.('Paste the SimpleFIN setup token first.'); return true; }
  run('connect', H.api.simplefinConnect(token));
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (!t?.matches?.('textarea[data-sf-token]')) return false;
  S.token = t.value;
  return true;
}
