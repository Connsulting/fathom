// Fathom account pages: sign in, enrollment, account and household admin. The server serves
// web/auth/index.html at /signin, /enroll, /account and /admin/users with only this script,
// auth.css and the favicon, so these pages never load the household app or its scenario.
//
// WebAuthn runs through navigator.credentials directly, with no browser library. The server sends
// options as JSON with base64url binary fields; this file turns them into ArrayBuffers and turns
// each credential back into JSON, including getClientExtensionResults so credProps reaches the
// server.
//
// An enrollment, recovery or add-a-device token arrives only in the fragment of /enroll. It is read into this
// module's memory and removed from history before anything else runs. It is never stored, logged,
// shown or put in a request URL; it travels only in the JSON body of the two register requests.

const PATH = window.location.pathname;

let enrollToken = null;
if (PATH === '/enroll') {
  const raw = window.location.hash.replace(/^#/, '');
  if (window.location.hash) {
    try { window.history.replaceState(null, '', '/enroll'); } catch { /* the token still lives only in memory */ }
  }
  enrollToken = /^[A-Za-z0-9_-]{16,512}$/.test(raw) ? raw : null;
}

const root = document.getElementById('auth') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'auth', className: 'au' }));

// One short code the main app or these pages leave for the sign-in page to explain why it opened.
const NOTICE_KEY = 'fathom.auth.notice';
const NOTICES = {
  signedout: { text: 'You are signed out of this browser. Your other devices stay signed in.' },
  expired: { text: 'Your session ended. Sign in again to continue.' },
  revoked: { text: 'Passkey revoked. Every session for your account was signed out, including this one. Sign in with one of your other passkeys.' },
  'revoked-last': { warn: true, text: 'You revoked your last passkey, so every session was signed out. To get back in, enter your email below and choose Email recovery link, then create a new passkey from the link.' },
  removed: { text: 'You removed yourself from this household, and every session was signed out.' },
};

// A conditional (autofill) request is refreshed before the server's five-minute challenge expires,
// a few times while the page is visible, then waits for the person to come back to the page.
const CONDITIONAL_TTL_MS = 270000;
const CONDITIONAL_REFRESHES = 6;

let me = null;          // the signed-in identity on /account and /admin/users
let busy = '';          // the action in flight, so a second click does nothing
let leaving = false;    // set once a navigation away has started

/* ---------- small helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const sentence = (s) => { const t = String(s || '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; };

const MARK = '<svg class="au-mark-g" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15a7 7 0 0114 0"/><path d="M2 15h20"/><path d="M7 19h10"/></svg>';
const ICONS = {
  key: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3L13 3M11 5l1.6 1.6M9.4 6.6L11 8.2"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.6 4.6L8 9l5.4-4.4"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.4v3.6M8 5.1v.1"/>',
  warn: '<path d="M8 2.6l5.9 10.4H2.1z"/><path d="M8 6.6v3.1M8 11.2v.1"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
};
const icon = (name) => `<svg class="au-i" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const note = (kind, html) => `<div class="au-note${kind === 'warn' ? ' warn' : ''}">${icon(kind === 'warn' ? 'warn' : 'info')}<p>${html}</p></div>`;

function fmtDate(v) {
  if (v == null || v === '') return '';
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const TRANSPORT = { internal: 'Built into a device', hybrid: 'Phone nearby', usb: 'USB security key', nfc: 'NFC security key', ble: 'Bluetooth security key', 'smart-card': 'Smart card' };
function transportText(list) {
  const words = (Array.isArray(list) ? list : []).map((t) => TRANSPORT[t]).filter(Boolean);
  return [...new Set(words)].join(', ');
}

// A default passkey name, so the list tells devices apart without typing.
function deviceGuess() {
  const ua = navigator.userAgent || '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br && os ? `${br} on ${os}` : os || br || 'Passkey';
}

function takeNotice() {
  try {
    const code = window.sessionStorage.getItem(NOTICE_KEY);
    window.sessionStorage.removeItem(NOTICE_KEY);
    return code;
  } catch { return null; }
}

function leave(path, code) {
  leaving = true;
  stopConditional();
  if (code) { try { window.sessionStorage.setItem(NOTICE_KEY, code); } catch { /* the page still explains itself */ } }
  window.location.assign(path);
}

function say(slot, kind, text) {
  const el = root.querySelector(`[data-msg="${slot}"]`);
  if (!el) return;
  el.className = `au-msg${kind ? ` ${kind}` : ''}`;
  el.textContent = text || '';
}

function setBusy(el, on) {
  if (!el) return;
  el.disabled = !!on;
  if (on) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}

/* ---------- requests ---------- */

// Same-origin JSON. A browser sends Origin on every POST, which the server requires on a real
// store. Resolves the body; rejects with err.status (0 when the server could not be reached).
async function call(method, path, body) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body || {});
  }
  let res;
  try { res = await fetch(path, init); } catch {
    const err = new Error('');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(data && typeof data.error === 'string' ? data.error : '');
    err.status = res.status;
    if (data && typeof data.code === 'string') err.code = data.code;
    throw err;
  }
  return data && typeof data === 'object' ? data : {};
}

async function loadSession() {
  const d = await call('GET', '/api/auth/session');
  const i = d.identity && typeof d.identity === 'object' ? d.identity : null;
  return { demo: d.demo === true, identity: i ? { ...i, email: String(i.email || i.login || '') } : null };
}

/* ---------- WebAuthn JSON ---------- */

function webauthnSupported() {
  return typeof window.PublicKeyCredential === 'function' && !!navigator.credentials
    && typeof navigator.credentials.create === 'function' && typeof navigator.credentials.get === 'function';
}

function toBuffer(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Extension results are plain objects, but some extensions return binary; send those as base64url.
function jsonSafe(v) {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return toB64url(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return v;
}

const withIds = (list) => (Array.isArray(list) ? list.map((c) => ({ ...c, id: toBuffer(c.id) })) : undefined);

function creationOptions(o) {
  const out = { ...o, challenge: toBuffer(o.challenge), user: { ...o.user, id: toBuffer(o.user.id) } };
  if (Array.isArray(o.excludeCredentials)) out.excludeCredentials = withIds(o.excludeCredentials);
  return out;
}

function requestOptions(o) {
  const out = { ...o, challenge: toBuffer(o.challenge) };
  if (Array.isArray(o.allowCredentials)) out.allowCredentials = withIds(o.allowCredentials);
  return out;
}

function extensionResults(cred) {
  try { return jsonSafe(cred.getClientExtensionResults() || {}); } catch { return {}; }
}

function registrationJSON(cred) {
  const r = cred.response;
  const response = { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject) };
  try { if (typeof r.getTransports === 'function') response.transports = r.getTransports(); } catch { /* optional */ }
  try { if (typeof r.getPublicKeyAlgorithm === 'function') response.publicKeyAlgorithm = r.getPublicKeyAlgorithm(); } catch { /* optional */ }
  try { if (typeof r.getPublicKey === 'function') { const k = r.getPublicKey(); if (k) response.publicKey = toB64url(k); } } catch { /* optional */ }
  try { if (typeof r.getAuthenticatorData === 'function') response.authenticatorData = toB64url(r.getAuthenticatorData()); } catch { /* optional */ }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response,
    clientExtensionResults: extensionResults(cred),
  };
}

function authenticationJSON(cred) {
  const r = cred.response;
  const response = {
    clientDataJSON: toB64url(r.clientDataJSON),
    authenticatorData: toB64url(r.authenticatorData),
    signature: toB64url(r.signature),
  };
  if (r.userHandle && r.userHandle.byteLength) response.userHandle = toB64url(r.userHandle);
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response,
    clientExtensionResults: extensionResults(cred),
  };
}

function ceremonyError(err) {
  const out = new Error('');
  out.ceremony = true;
  out.name = (err && err.name) || 'Error';
  return out;
}

// Registration for both enrollment (with the link token) and adding a passkey (live session).
async function registerPasskey(extra, name) {
  let options;
  try {
    ({ options } = await call('POST', '/api/auth/register/options', { ...extra, name }));
  } catch (err) {
    err.stage = 'options';
    throw err;
  }
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (err) {
    throw ceremonyError(err);
  }
  if (!cred) throw ceremonyError(null);
  return call('POST', '/api/auth/register/verify', { ...extra, response: registrationJSON(cred), name });
}

/* ---------- messages for failures ---------- */

function ceremonyText(name, ctx) {
  const creating = ctx === 'register';
  if (name === 'NotAllowedError') {
    return creating
      ? 'Passkey setup was cancelled or timed out. Try again when you are ready.'
      : 'Sign-in was cancelled or timed out, or no passkey for Fathom was found here. Try again, or email yourself a recovery link.';
  }
  if (name === 'InvalidStateError') return 'This device or password manager already holds a passkey for your account. Sign in with it, or save the new passkey somewhere else.';
  if (name === 'SecurityError') return 'The browser would not use passkeys at this address. Open Fathom at its configured address and try again.';
  if (name === 'NotSupportedError') return 'This browser or password manager cannot make the kind of passkey Fathom needs. Try another browser or passkey provider.';
  if (name === 'unsupported') return 'This browser cannot use passkeys. Open this page in a current browser that supports them.';
  return creating ? 'Passkey setup failed. Try again.' : 'The passkey request failed. Try again.';
}

function explain(err, ctx) {
  if (err && err.ceremony) return ceremonyText(err.name, ctx);
  const s = err ? err.status : undefined;
  if (s === 0) return 'Fathom could not be reached. Check the connection and try again.';
  if (s === 400) {
    if (ctx === 'signin') return 'That passkey was not accepted. It may have been revoked, or it belongs to another account. Try another passkey, or email yourself a recovery link.';
    if (ctx === 'register' && err.stage !== 'options') {
      return 'Fathom could not accept that passkey. It needs a passkey saved for sign-in without typing an email (a discoverable passkey), confirmed by the browser, that checks it is you with a fingerprint, face or screen lock. Try another browser or passkey provider.';
    }
    return sentence(err.message) || 'Check the details and try again.';
  }
  if (s === 401) return 'Your session ended. Sign in again.';
  if (s === 403) return 'Only household admins can do that.';
  if (s === 404) return 'That is not available here.';
  if (s === 409) return ctx === 'admin' ? 'A household needs at least one enrolled admin. Make someone else an admin first.' : (sentence(err.message) || 'That conflicts with the current state. Reload and try again.');
  if (s === 410) return 'This link has expired or was already used.';
  if (s === 429) return 'Too many attempts. Wait a few minutes, then try again.';
  return `Something went wrong (the server answered ${s}). Try again.`;
}

/* ---------- page frames ---------- */

function narrow(body, foot = '') {
  return `<main class="au-narrow"><div class="au-brand"><span class="au-mark">${MARK}<span>Fathom</span></span></div>
    <section class="au-card">${body}</section>${foot ? `<p class="au-foot">${foot}</p>` : ''}</main>`;
}

function frame(active, body) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  const admin = me && me.role === 'admin';
  return `<header class="au-top"><div class="au-top-in"><a class="au-mark" href="/">${MARK}<span>Fathom</span></a>
    <nav class="au-nav" aria-label="Account pages">${link('/', 'Back to Fathom', 'app')}${link('/account', 'Account', 'account')}${admin ? link('/admin/users', 'Household', 'admin') : ''}</nav></div></header>
    <main class="au-main">${body}</main>`;
}

function noticeHtml(code) {
  const n = NOTICES[code];
  return n ? note(n.warn ? 'warn' : 'info', esc(n.text)) : '';
}

function loadingView() {
  root.innerHTML = narrow('<p class="au-lede" role="status">Loading.</p>');
}

function failView(err) {
  document.title = 'Fathom';
  root.innerHTML = narrow(`<h1>This page did not load</h1><p class="au-lede">${esc(explain(err, 'load'))}</p>
    <div class="au-form"><button type="button" class="au-btn pri wide" data-act="reload">Try again</button></div>`);
}

function demoView() {
  document.title = 'Fathom demo';
  root.innerHTML = narrow(`<h1>This is the demo</h1>
    <p class="au-lede">The demo has no accounts or passkeys. Anyone who can open it sees the same synthetic household.</p>
    <div class="au-form"><a class="au-btn pri wide" href="/">Open the demo</a></div>`);
}

function unknownView() {
  document.title = 'Fathom';
  root.innerHTML = narrow(`<h1>Page not found</h1><p class="au-lede">There is nothing at this address.</p>
    <div class="au-form"><a class="au-btn pri wide" href="/signin">Go to sign in</a></div>`);
}

/* ---------- sign in ---------- */

const cond = { enabled: false, ctrl: null, timer: 0, refreshes: 0, waiting: false };

function stopConditional() {
  clearTimeout(cond.timer);
  cond.timer = 0;
  if (cond.ctrl) {
    const ctrl = cond.ctrl;
    cond.ctrl = null;
    try { ctrl.abort(); } catch { /* already settled */ }
  }
}

// Passive: one options request, then a conditional get the browser may offer from the Email
// field's autofill. Any failure ends quietly and is not retried; the button always works.
async function armConditional() {
  if (!cond.enabled || cond.ctrl || busy || leaving) return;
  cond.waiting = false;
  const ctrl = new AbortController();
  cond.ctrl = ctrl;
  let options;
  try {
    ({ options } = await call('POST', '/api/auth/signin/options', {}));
  } catch {
    if (cond.ctrl === ctrl) { cond.ctrl = null; cond.waiting = true; }
    return;
  }
  if (cond.ctrl !== ctrl || ctrl.signal.aborted) return;
  clearTimeout(cond.timer);
  cond.timer = setTimeout(() => expireConditional(ctrl), CONDITIONAL_TTL_MS);
  let cred = null;
  try {
    cred = await navigator.credentials.get({ mediation: 'conditional', publicKey: requestOptions(options), signal: ctrl.signal });
  } catch {
    // Aborted for the button or a refresh, or declined by the browser: nothing to show.
    if (cond.ctrl === ctrl) { clearTimeout(cond.timer); cond.ctrl = null; cond.waiting = true; }
    return;
  }
  if (cond.ctrl !== ctrl) return;
  clearTimeout(cond.timer);
  cond.ctrl = null;
  if (!cred || busy || leaving) return;
  busy = 'conditional';
  const btn = root.querySelector('[data-act="passkey"]');
  setBusy(btn, true);
  say('signin', '', 'Checking your passkey.');
  try {
    await finishSignin(cred);
  } catch (err) {
    say('signin', 'err', explain(err, 'signin'));
    cond.waiting = true;
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

function expireConditional(ctrl) {
  if (cond.ctrl !== ctrl) return;
  stopConditional();
  if (document.visibilityState === 'visible' && cond.refreshes < CONDITIONAL_REFRESHES) {
    cond.refreshes += 1;
    armConditional();
  } else {
    cond.waiting = true;
  }
}

function resumeConditional() {
  if (!cond.waiting || cond.ctrl) return;
  cond.refreshes = 0;
  armConditional();
}

async function startConditional() {
  if (!webauthnSupported()) return;
  let available = false;
  try {
    available = typeof window.PublicKeyCredential.isConditionalMediationAvailable === 'function'
      && (await window.PublicKeyCredential.isConditionalMediationAvailable()) === true;
  } catch { available = false; }
  if (!available || leaving) return;
  cond.enabled = true;
  armConditional();
}

async function finishSignin(cred) {
  await call('POST', '/api/auth/signin/verify', { response: authenticationJSON(cred) });
  say('signin', 'ok', 'Signed in. Opening Fathom.');
  leave('/');
}

// The button: abort any pending conditional request first, then a normal (modal) request with
// fresh options.
async function explicitSignin(btn) {
  if (busy) return;
  if (!webauthnSupported()) { say('signin', 'err', ceremonyText('unsupported')); return; }
  busy = 'passkey';
  stopConditional();
  setBusy(btn, true);
  say('signin', '', 'Waiting for your passkey.');
  try {
    const { options } = await call('POST', '/api/auth/signin/options', {});
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
    } catch (err) {
      throw ceremonyError(err);
    }
    if (!cred) throw ceremonyError(null);
    await finishSignin(cred);
  } catch (err) {
    say('signin', 'err', explain(err, 'signin'));
  } finally {
    busy = '';
    if (!leaving) {
      setBusy(btn, false);
      cond.waiting = true;
      resumeConditional();
    }
  }
}

async function recover(btn) {
  if (busy) return;
  const input = root.querySelector('#au-email');
  const value = input ? input.value.trim() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    say('recover', 'err', 'Enter the email address on your account, then choose Email recovery link.');
    return;
  }
  input.removeAttribute('aria-invalid');
  busy = 'recover';
  setBusy(btn, true);
  say('recover', '', 'Sending.');
  try {
    await call('POST', '/api/auth/recover', { email: value });
    say('recover', 'ok', `If ${value} belongs to an account here, a recovery link is on its way. It works once, for 20 minutes. Open it on the device that should hold your new passkey.`);
  } catch (err) {
    say('recover', 'err', explain(err, 'recover'));
  } finally {
    busy = '';
    setBusy(btn, false);
  }
}

function signinView() {
  document.title = 'Sign in | Fathom';
  const notice = takeNotice();
  const supported = webauthnSupported();
  root.innerHTML = narrow(`
    <h1>Sign in</h1>
    <p class="au-lede">Use the passkey on this device, on a phone nearby or in your password manager.</p>
    <div data-slot="notice">${noticeHtml(notice)}${supported ? '' : note('warn', esc(ceremonyText('unsupported')))}</div>
    <form class="au-form" data-form="signin" novalidate>
      <div class="au-field">
        <label for="au-email">Email</label>
        <input class="au-in" id="au-email" name="username" type="email" autocomplete="username webauthn" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" aria-describedby="au-email-hint">
        <p class="au-hint" id="au-email-hint">Your passkey may be offered here. Signing in with a passkey does not need the address; a recovery link does.</p>
      </div>
      <button type="submit" class="au-btn pri wide" data-act="passkey">${icon('key')}Sign in with a passkey</button>
      <p class="au-msg" data-msg="signin" role="status" aria-live="polite"></p>
      <div class="au-or">Lost your passkey?</div>
      <button type="button" class="au-btn wide" data-act="recover">${icon('mail')}Email recovery link</button>
      <p class="au-msg" data-msg="recover" role="status" aria-live="polite"></p>
      <p class="au-hint">If the address has an account here, a single-use link arrives by email. It works for 20 minutes and sets up a new passkey; your old passkeys stop working once the new one is saved.</p>
    </form>`, 'Fathom is by invitation. A household admin adds people from the Household page.');
  const email = root.querySelector('#au-email');
  email.addEventListener('focus', resumeConditional);
  startConditional();
  loadSession().then((s) => {
    if (leaving) return;
    if (s.demo) { stopConditional(); cond.enabled = false; demoView(); return; }
    const slot = root.querySelector('[data-slot="notice"]');
    if (s.identity && slot) slot.insertAdjacentHTML('afterbegin', note('info', `You are signed in as <b>${esc(s.identity.email)}</b>. <a href="/">Open Fathom</a>`));
  }).catch(() => { /* the form works without it */ });
}

/* ---------- enroll ---------- */

function deadLinkView() {
  root.innerHTML = narrow(`<h1>This link no longer works</h1>
    <p class="au-lede">It has expired or was already used. Invitation, recovery and add-a-device links work once, for 20 minutes.</p>
    ${note('info', 'New to this household: ask a household admin to send a new invitation. Already have an account: request a recovery link from the sign-in page. Add-a-device link: request a new one from Account on a signed-in device.')}
    <div class="au-form"><a class="au-btn pri wide" href="/signin">Go to sign in</a></div>`);
}

function enrollView() {
  document.title = 'Create a passkey | Fathom';
  if (!enrollToken) {
    root.innerHTML = narrow(`<h1>Open the link from your email</h1>
      <p class="au-lede">This page needs the full link from an invitation, recovery or add-a-device email. If you already opened it here and reloaded, open it from the email again. An add-a-device link that no longer works: request a new one from Account on a signed-in device.</p>
      <div class="au-form"><a class="au-btn pri wide" href="/signin">Go to sign in</a></div>`);
    return;
  }
  const supported = webauthnSupported();
  root.innerHTML = narrow(`
    <h1>Create your passkey</h1>
    <p class="au-lede">This link sets up a passkey for your Fathom account. Your device checks it is you with a fingerprint, face or screen lock. There is no password.</p>
    ${supported ? '' : note('warn', esc(ceremonyText('unsupported')))}
    <form class="au-form" data-form="enroll" novalidate>
      <div class="au-field">
        <label for="au-pk-name">Passkey name</label>
        <input class="au-in" id="au-pk-name" type="text" maxlength="64" autocomplete="off" spellcheck="false" value="${esc(deviceGuess())}" aria-describedby="au-pk-hint">
        <p class="au-hint" id="au-pk-hint">Helps you tell devices apart later, for example Laptop or Phone.</p>
      </div>
      <button type="submit" class="au-btn pri wide">${icon('key')}Create passkey</button>
      <p class="au-msg" data-msg="enroll" role="status" aria-live="polite"></p>
    </form>`, 'The link works once, within 20 minutes of being sent. Keep this tab open until the passkey is saved.');
}

async function enroll(form) {
  if (busy || !enrollToken) return;
  const input = form.querySelector('#au-pk-name');
  const btn = form.querySelector('button[type="submit"]');
  const name = input.value.trim();
  if (!name) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    say('enroll', 'err', 'Name the passkey first, for example Laptop or Phone.');
    return;
  }
  if (!webauthnSupported()) { say('enroll', 'err', ceremonyText('unsupported')); return; }
  input.removeAttribute('aria-invalid');
  busy = 'enroll';
  setBusy(btn, true);
  say('enroll', '', 'Waiting for your device to save the passkey.');
  try {
    await registerPasskey({ token: enrollToken }, name);
    enrollToken = null;
    say('enroll', 'ok', 'Passkey saved. Opening Fathom.');
    leave('/');
  } catch (err) {
    if (err && err.status === 410) { enrollToken = null; deadLinkView(); return; }
    say('enroll', 'err', explain(err, 'register'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

/* ---------- account ---------- */

let keys = [];

function keysHtml() {
  if (!keys.length) return '<p class="au-empty">No passkeys. Add one below now, or the next sign-in needs an email recovery link.</p>';
  const rows = keys.map((k, i) => {
    const added = fmtDate(k.createdAt);
    const how = transportText(k.transports);
    return `<li>
      <div><div class="au-row-t"><b id="au-pk-${i}">${esc(k.name || 'Passkey')}</b></div>
        <div class="au-meta">${added ? `<span>Added ${esc(added)}</span>` : ''}${how ? `<span>${esc(how)}</span>` : ''}</div></div>
      <div class="au-row-a"><button type="button" class="au-btn danger sm" data-act="revoke" data-i="${i}" aria-describedby="au-pk-${i}">Revoke passkey</button></div>
    </li>`;
  }).join('');
  const only = keys.length === 1
    ? note('warn', `This is your only passkey. If you lose it, choose Email recovery link on the sign-in page; the link goes to <b>${esc(me.email)}</b>. Adding a second passkey avoids that.`)
    : '';
  return `<ul class="au-rows" aria-label="Passkeys">${rows}</ul>${only}`;
}

function drawKeys() {
  const box = root.querySelector('[data-keys]');
  if (box) box.innerHTML = keysHtml();
  const count = root.querySelector('[data-count="keys"]');
  if (count) count.textContent = String(keys.length);
}

async function loadKeys() {
  try {
    const d = await call('GET', '/api/auth/passkeys');
    keys = Array.isArray(d.passkeys) ? d.passkeys.filter((k) => k && k.id != null) : [];
    drawKeys();
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    const box = root.querySelector('[data-keys]');
    if (box) box.innerHTML = `<p class="au-empty">${esc(explain(err, 'load'))}</p>`;
  }
}

async function accountView() {
  document.title = 'Account | Fathom';
  loadingView();
  let s;
  try { s = await loadSession(); } catch (err) { failView(err); return; }
  if (s.demo) { demoView(); return; }
  if (!s.identity) { leave('/signin', 'expired'); return; }
  me = s.identity;
  const role = me.role === 'admin' ? 'a household admin' : 'a household member';
  root.innerHTML = frame('account', `
    <div class="au-ph"><h1>Your account</h1>
      <p class="au-lede">Signed in as <b>${esc(me.email)}</b>, ${role}. Passkeys are the only way in; there is no password.</p></div>
    <section class="au-sec" aria-labelledby="au-keys-h">
      <div class="au-sec-h"><h2 id="au-keys-h">Passkeys<em data-count="keys"></em></h2><span>Revoking a passkey signs out every session</span></div>
      <div data-keys><p class="au-empty">Loading passkeys.</p></div>
      <p class="au-msg" data-msg="keys" role="status" aria-live="polite"></p>
    </section>
    <section class="au-sec" aria-labelledby="au-add-h">
      <div class="au-sec-h"><h2 id="au-add-h">Add a passkey</h2></div>
      <p class="au-hint">Add one for each device or password manager you sign in from. Your other passkeys keep working.</p>
      <form class="au-form" data-form="add" novalidate>
        <div class="au-row-in">
          <div class="au-field"><label for="au-pk-name">Passkey name</label>
            <input class="au-in" id="au-pk-name" type="text" maxlength="64" autocomplete="off" spellcheck="false" value="${esc(deviceGuess())}"></div>
          <button type="submit" class="au-btn pri tall">${icon('plus')}Add passkey</button>
        </div>
        <p class="au-msg" data-msg="add" role="status" aria-live="polite"></p>
      </form>
    </section>
    <section class="au-sec" aria-labelledby="au-dev-h">
      <div class="au-sec-h"><h2 id="au-dev-h">Add a passkey on another device</h2></div>
      <p class="au-hint">We email you a link. Open it on the other device within 20 minutes; it works once. Nothing here changes until the new passkey is saved.</p>
      <div class="au-form"><div><button type="button" class="au-btn" data-act="device-link">${icon('mail')}Email me a link to add a passkey on another device</button></div>
        <p class="au-msg" data-msg="device" role="status" aria-live="polite"></p></div>
    </section>
    <section class="au-sec" aria-labelledby="au-out-h">
      <div class="au-sec-h"><h2 id="au-out-h">Sign out</h2></div>
      <p class="au-hint">Ends the session in this browser. Your other devices stay signed in.</p>
      <div class="au-form"><div><button type="button" class="au-btn" data-act="signout">Sign out</button></div>
        <p class="au-msg" data-msg="out" role="status" aria-live="polite"></p></div>
    </section>`);
  await loadKeys();
}

async function addPasskey(form) {
  if (busy) return;
  const input = form.querySelector('#au-pk-name');
  const btn = form.querySelector('button[type="submit"]');
  const name = input.value.trim();
  if (!name) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    say('add', 'err', 'Name the passkey first, for example Laptop or Phone.');
    return;
  }
  if (!webauthnSupported()) { say('add', 'err', ceremonyText('unsupported')); return; }
  input.removeAttribute('aria-invalid');
  busy = 'add';
  setBusy(btn, true);
  say('add', '', 'Waiting for your device to save the passkey.');
  try {
    await registerPasskey({}, name);
    input.value = '';
    say('add', 'ok', `Added ${name}. Your other passkeys still work.`);
    await loadKeys();
  } catch (err) {
    if (err && err.status === 401) { leave('/signin', 'expired'); return; }
    if (err && err.status === 403 && err.code === 'recent_signin_required') { sayRecentSignin('add'); return; }
    say('add', 'err', explain(err, 'register'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

// Adding a passkey with only a session needs a sign-in from the last 10 minutes. The session stays
// as it is; /signin already accepts a new sign-in from a signed-in browser.
function sayRecentSignin(slot) {
  say(slot, 'err', 'Adding a passkey needs a sign-in from the last 10 minutes. ');
  const el = root.querySelector(`[data-msg="${slot}"]`);
  if (!el) return;
  const link = document.createElement('a');
  link.href = '/signin';
  link.textContent = 'Sign in again';
  el.append(link, ', then come back to Account to add it.');
}

// The link goes to the signed-in account's own address; the server ignores any body.
async function requestDeviceLink(btn) {
  if (busy) return;
  busy = 'device';
  setBusy(btn, true);
  say('device', '', 'Sending the link.');
  try {
    await call('POST', '/api/auth/passkeys/link', {});
    say('device', 'ok', `A link is on its way to ${me.email}. Open it on the other device within 20 minutes; it works once.`);
  } catch (err) {
    if (err && err.status === 401) { leave('/signin', 'expired'); return; }
    if (err && err.status === 403 && err.code === 'recent_signin_required') { sayRecentSignin('device'); return; }
    if (err && err.status === 503) { say('device', 'err', 'Fathom could not send the email. Try again later.'); return; }
    say('device', 'err', explain(err, 'account'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

async function revokeOwn(btn) {
  const k = keys[Number(btn.dataset.i)];
  if (!k || busy) return;
  const last = keys.length === 1;
  const ask = last
    ? `Revoke "${k.name}"? It is your only passkey. Every session signs out, including this one, and you will need an email recovery link to sign in again.`
    : `Revoke "${k.name}"? Every session for your account signs out, including this one. Sign in again with another passkey.`;
  if (!window.confirm(ask)) return;
  busy = 'revoke';
  setBusy(btn, true);
  try {
    await call('POST', `/api/auth/passkeys/${encodeURIComponent(k.id)}/revoke`, {});
    leave('/signin', last ? 'revoked-last' : 'revoked');
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    say('keys', 'err', explain(err, 'account'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

async function signOut(btn) {
  if (busy) return;
  busy = 'signout';
  setBusy(btn, true);
  try {
    await call('POST', '/api/auth/signout', {});
    leave('/signin', 'signedout');
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'signedout'); return; }
    say('out', 'err', explain(err, 'account'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

/* ---------- household (admins) ---------- */

let users = [];

const enrolled = (u) => (Object.prototype.hasOwnProperty.call(u, 'enrolledAt') ? !!u.enrolledAt : true);
const lastAdmin = (u) => u.role === 'admin' && enrolled(u) && users.filter((x) => x.role === 'admin' && enrolled(x)).length <= 1;

function userHtml(u, i) {
  const self = me && u.id === me.id;
  const joined = enrolled(u);
  const last = lastAdmin(u);
  const id = `au-u-${i}`;
  const status = joined ? (fmtDate(u.enrolledAt) ? `Joined ${fmtDate(u.enrolledAt)}` : 'Enrolled') : 'Invitation pending';
  const pks = Array.isArray(u.passkeys) ? u.passkeys.filter((k) => k && k.id != null) : null;
  const chips = pks && pks.length
    ? `<div class="au-keys" role="group" aria-label="Passkeys of ${esc(u.email)}">${pks.map((k, j) => `<span class="au-key"><span id="${id}-k${j}">${esc(k.name || 'Passkey')}</span><button type="button" class="au-btn ghost sm" data-act="ukey" data-i="${i}" data-j="${j}" aria-describedby="${id}-k${j} ${id}">Revoke passkey</button></span>`).join('')}</div>`
    : '';
  const why = last ? `${id}-why ` : '';
  return `<li>
    <div><div class="au-row-t"><b id="${id}">${esc(u.email)}</b>${self ? '<span class="au-tag ac">You</span>' : ''}${joined ? '' : '<span class="au-tag">Pending</span>'}</div>
      <div class="au-meta"><span>${esc(status)}</span>${pks ? `<span>${plural(pks.length, 'passkey')}</span>` : ''}</div></div>
    <div class="au-row-a">
      <span class="au-role"><label class="au-lab" for="${id}-role">Role</label><select class="au-sel" id="${id}-role" data-role="${i}"${last ? ` disabled aria-describedby="${id}-why"` : ''}>
        <option value="member"${u.role === 'admin' ? '' : ' selected'}>Member</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select></span>
      ${joined ? '' : `<button type="button" class="au-btn sm" data-act="resend" data-i="${i}" aria-describedby="${id}">Resend invitation</button>`}
      <button type="button" class="au-btn danger sm" data-act="remove" data-i="${i}" aria-describedby="${why}${id}"${last ? ' disabled' : ''}>Remove user</button>
    </div>
    ${chips}
    ${last ? `<p class="au-why" id="${id}-why">The only enrolled admin. Make someone else an admin before changing this role or removing this person.</p>` : ''}
  </li>`;
}

function drawUsers() {
  const box = root.querySelector('[data-users]');
  if (box) box.innerHTML = users.length ? `<ul class="au-rows" aria-label="People">${users.map(userHtml).join('')}</ul>` : '<p class="au-empty">No one yet.</p>';
  const count = root.querySelector('[data-count="users"]');
  if (count) count.textContent = String(users.length);
}

function deniedView() {
  document.title = 'Household | Fathom';
  root.innerHTML = frame('admin', `<div class="au-ph"><h1>Household</h1>
    <p class="au-lede">Only household admins can invite people, change roles or remove access. Ask an admin if you need a change.</p></div>`);
}

// Resolves true when the list loaded; handles 401 and 403 itself.
async function loadUsers() {
  try {
    const d = await call('GET', '/api/admin/users');
    users = Array.isArray(d.users) ? d.users.filter((u) => u && u.id != null) : [];
    drawUsers();
    return true;
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return false; }
    if (err.status === 403) { deniedView(); return false; }
    const box = root.querySelector('[data-users]');
    if (box) box.innerHTML = `<p class="au-empty">${esc(explain(err, 'load'))}</p>`;
    return false;
  }
}

async function adminView() {
  document.title = 'Household | Fathom';
  loadingView();
  let s;
  try { s = await loadSession(); } catch (err) { failView(err); return; }
  if (s.demo) { demoView(); return; }
  if (!s.identity) { leave('/signin', 'expired'); return; }
  me = s.identity;
  if (me.role !== 'admin') { deniedView(); return; }
  root.innerHTML = frame('admin', `
    <div class="au-ph"><h1>Household</h1>
      <p class="au-lede">Everyone here shares one household: the same accounts, plan, files and recommendations. Admins also invite people, change roles and remove access.</p></div>
    <section class="au-sec" aria-labelledby="au-inv-h">
      <div class="au-sec-h"><h2 id="au-inv-h">Invite someone</h2></div>
      <form class="au-form" data-form="invite" novalidate>
        <div class="au-row-in">
          <div class="au-field"><label for="au-inv-email">Email</label>
            <input class="au-in" id="au-inv-email" type="email" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email"></div>
          <div class="au-field role"><label for="au-inv-role">Role</label>
            <select class="au-sel" id="au-inv-role"><option value="member" selected>Member</option><option value="admin">Admin</option></select></div>
          <button type="submit" class="au-btn pri tall">Invite user</button>
        </div>
        <p class="au-hint">The enrollment link goes only to that address. It works once, for 20 minutes, and is never shown here. Members can use everything in the household except this page.</p>
        <p class="au-msg" data-msg="invite" role="status" aria-live="polite"></p>
      </form>
    </section>
    <section class="au-sec" aria-labelledby="au-ppl-h">
      <div class="au-sec-h"><h2 id="au-ppl-h">People<em data-count="users"></em></h2><span>At least one enrolled admin stays</span></div>
      <div data-users><p class="au-empty">Loading people.</p></div>
      <p class="au-msg" data-msg="users" role="status" aria-live="polite"></p>
      <p class="au-hint">Removing someone deletes their passkeys and sessions and stops the MCP keys they created. Household data stays. A role change keeps their keys.</p>
    </section>`);
  await loadUsers();
}

async function invite(form) {
  if (busy) return;
  const input = form.querySelector('#au-inv-email');
  const role = form.querySelector('#au-inv-role').value === 'admin' ? 'admin' : 'member';
  const btn = form.querySelector('button[type="submit"]');
  const email = input.value.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    say('invite', 'err', 'Enter the email address to invite.');
    return;
  }
  input.removeAttribute('aria-invalid');
  busy = 'invite';
  setBusy(btn, true);
  say('invite', '', 'Sending the invitation.');
  try {
    await call('POST', '/api/admin/users/invite', { email, role });
    input.value = '';
    say('invite', 'ok', `Invitation sent to ${email} as ${role === 'admin' ? 'an admin' : 'a member'}. The link works once, for 20 minutes.`);
    await loadUsers();
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    if (err.status === 403) { deniedView(); return; }
    say('invite', 'err', explain(err, 'admin'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

async function resend(btn) {
  const u = users[Number(btn.dataset.i)];
  if (!u || busy) return;
  busy = 'resend';
  setBusy(btn, true);
  try {
    await call('POST', '/api/admin/users/invite', { email: u.email, role: u.role === 'admin' ? 'admin' : 'member' });
    say('users', 'ok', `A new invitation went to ${u.email}. Earlier links for it no longer work.`);
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    if (err.status === 403) { deniedView(); return; }
    say('users', 'err', explain(err, 'admin'));
  } finally {
    busy = '';
    if (!leaving) setBusy(btn, false);
  }
}

async function changeRole(sel) {
  const u = users[Number(sel.dataset.role)];
  if (!u) return;
  const role = sel.value === 'admin' ? 'admin' : 'member';
  const before = u.role === 'admin' ? 'admin' : 'member';
  if (role === before) return;
  const self = me && u.id === me.id;
  if (busy || (self && role === 'member' && !window.confirm('Make yourself a member? You will lose access to this page, invitations and role changes.'))) {
    sel.value = before;
    return;
  }
  busy = 'role';
  sel.disabled = true;
  try {
    await call('POST', `/api/admin/users/${encodeURIComponent(u.id)}/role`, { role });
    if (self && role === 'member') { leave('/account'); return; }
    say('users', 'ok', `${u.email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
    await loadUsers();
  } catch (err) {
    sel.value = before;
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    if (err.status === 403) { deniedView(); return; }
    say('users', 'err', explain(err, 'admin'));
  } finally {
    busy = '';
    if (!leaving && sel.isConnected) sel.disabled = lastAdmin(u);
  }
}

async function removeUser(btn) {
  const u = users[Number(btn.dataset.i)];
  if (!u || busy) return;
  const self = me && u.id === me.id;
  const ask = self
    ? 'Remove yourself from the household? Your passkeys, every session and the MCP keys you created stop working now. Household data stays.'
    : `Remove ${u.email} from the household? Their passkeys, sessions and the MCP keys they created stop working now. Household data stays.`;
  if (!window.confirm(ask)) return;
  busy = 'remove';
  setBusy(btn, true);
  try {
    await call('POST', `/api/admin/users/${encodeURIComponent(u.id)}/remove`, {});
    if (self) { leave('/signin', 'removed'); return; }
    say('users', 'ok', `Removed ${u.email}.`);
    await loadUsers();
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    if (err.status === 403) { deniedView(); return; }
    say('users', 'err', explain(err, 'admin'));
  } finally {
    busy = '';
    if (!leaving && btn.isConnected) setBusy(btn, false);
  }
}

async function revokeUserKey(btn) {
  const u = users[Number(btn.dataset.i)];
  const k = u && Array.isArray(u.passkeys) ? u.passkeys.filter((x) => x && x.id != null)[Number(btn.dataset.j)] : null;
  if (!u || !k || busy) return;
  const self = me && u.id === me.id;
  const lastKey = u.passkeys.length === 1;
  const ask = `Revoke "${k.name}" for ${self ? 'yourself' : u.email}? Every session for ${self ? 'your account, including this one,' : 'that account'} signs out.${lastKey ? ' It is the only passkey, so the next sign-in needs an email recovery link.' : ''}`;
  if (!window.confirm(ask)) return;
  busy = 'ukey';
  setBusy(btn, true);
  try {
    await call('POST', `/api/admin/users/${encodeURIComponent(u.id)}/passkeys/${encodeURIComponent(k.id)}/revoke`, {});
    if (self) { leave('/signin', lastKey ? 'revoked-last' : 'revoked'); return; }
    say('users', 'ok', `Revoked ${k.name} for ${u.email}, and signed that account out everywhere.`);
    await loadUsers();
  } catch (err) {
    if (err.status === 401) { leave('/signin', 'expired'); return; }
    if (err.status === 403) { deniedView(); return; }
    say('users', 'err', explain(err, 'admin'));
  } finally {
    busy = '';
    if (!leaving && btn.isConnected) setBusy(btn, false);
  }
}

/* ---------- events ---------- */

root.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !root.contains(form)) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'signin') explicitSignin(form.querySelector('[data-act="passkey"]'));
  else if (kind === 'enroll') enroll(form);
  else if (kind === 'add') addPasskey(form);
  else if (kind === 'invite') invite(form);
});

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el) || el.type === 'submit') return;
  const act = el.dataset.act;
  if (act === 'recover') recover(el);
  else if (act === 'reload') window.location.reload();
  else if (act === 'revoke') revokeOwn(el);
  else if (act === 'signout') signOut(el);
  else if (act === 'device-link') requestDeviceLink(el);
  else if (act === 'resend') resend(el);
  else if (act === 'remove') removeUser(el);
  else if (act === 'ukey') revokeUserKey(el);
});

root.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-role]');
  if (sel && root.contains(sel)) changeRole(sel);
});

root.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('[aria-invalid="true"]')) e.target.removeAttribute('aria-invalid');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeConditional();
});
window.addEventListener('pagehide', stopConditional);

/* ---------- route ---------- */

const VIEWS = { '/signin': signinView, '/enroll': enrollView, '/account': accountView, '/admin/users': adminView };
(VIEWS[PATH] || unknownView)();
