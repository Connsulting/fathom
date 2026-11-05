/* Connect: bring your own AI. Shows the MCP URL, issues and revokes app API keys, and gives client
   config snippets. A new key lives only in this module's memory while it is revealed: it is never
   written to storage, the URL, history or the console, and Done or leaving the screen drops it.
   design.js owns the shell and the event delegation; it forwards [data-conn] clicks,
   [data-conn-form] submits and [data-conn-input] input here. */

const PLACEHOLDER = '<your-key>';
const SCOPE_TEXT = (scopes) => (Array.isArray(scopes) && scopes.includes('write:recs') ? 'Read and write recs' : 'Read only');

let st = blank();
let gen = 0;

function blank() {
  return {
    loading: false, loadError: '', mcp: null, keys: [],
    draft: '', write: false, busy: false, formError: '',
    revealed: null, confirming: null, revoking: null, listError: '',
    copied: '', copyTimer: 0
  };
}

/* ---------- data ---------- */

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `The server answered ${res.status}.`);
  return data || {};
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch {
    throw new Error('The server could not be reached.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `The server answered ${res.status}.`);
  return data || {};
}

const keyList = (d) => (Array.isArray(d?.keys) ? d.keys : null);

/* ---------- lifecycle ---------- */

export function enter(h) {
  clearSecret();
  const keep = { draft: st.draft };
  clearTimeout(st.copyTimer);
  st = { ...blank(), ...keep, loading: true };
  const my = ++gen;
  Promise.allSettled([getJson('/api/mcp'), getJson('/api/keys')]).then(([m, k]) => {
    if (my !== gen) return;
    st.loading = false;
    if (m.status === 'fulfilled') st.mcp = m.value;
    if (k.status === 'fulfilled') st.keys = keyList(k.value) || [];
    const errs = [m, k].filter((x) => x.status === 'rejected').map((x) => x.reason?.message || 'Could not load.');
    st.loadError = errs.length ? errs[0] : '';
    h.redraw();
  });
}

export function leave() {
  gen += 1;
  clearSecret();
  st.confirming = null;
  st.formError = '';
  clearTimeout(st.copyTimer);
  st.copied = '';
}

function clearSecret() {
  st.revealed = null;
}

/* ---------- rendering ---------- */

function fmtDate(iso, withTime) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString('en-US', opts);
}

function snippets(url) {
  const k = st.revealed ? st.revealed.key : PLACEHOLDER;
  const u = url || 'http://<fathom-host>/mcp';
  const claude = `claude mcp add --transport http fathom ${u} --header "Authorization: Bearer ${k}"`;
  const json = JSON.stringify({ mcpServers: { fathom: { type: 'http', url: u, headers: { Authorization: `Bearer ${k}` } } } }, null, 2);
  return { claude, json };
}

function copyBtn(h, which, label, attrs = '') {
  const done = st.copied === which;
  return h.btn(done ? 'Copied' : label, `data-conn="copy" data-which="${which}" ${attrs}`, done ? '' : 'ghost');
}

function urlBlock(h) {
  const m = st.mcp;
  if (!m) {
    return `<div class="h-url cn-url"><code class="cn-dim">${st.loading ? 'Loading the address' : 'Address unavailable'}</code></div>`;
  }
  const note = m.publicUrlSet
    ? ''
    : '<p class="h-mute sm cn-urlnote">Taken from the address this page was opened on. Set FATHOM_PUBLIC_URL on the server to pin it.</p>';
  return `<div class="h-url cn-url"><code data-testid="mcp-url">${h.esc(m.url)}</code>${copyBtn(h, 'url', 'Copy', 'aria-label="Copy the MCP address"')}</div>${note}`;
}

function createForm(h) {
  const err = st.formError;
  return `<form class="cn-form" data-conn-form="create" novalidate>
    <div class="cn-field">
      <label for="key-name-input">Key name</label>
      <div class="cn-inrow">
        <input id="key-name-input" name="name" type="text" maxlength="80" autocomplete="off" spellcheck="false"
          placeholder="For example, laptop Claude Code" value="${h.esc(st.draft)}" data-conn-input="name"
          ${err ? 'aria-invalid="true" ' : ''}aria-describedby="key-name-err">
        <button type="submit" class="h-btn pri" data-testid="create-key"${st.busy ? ' disabled aria-busy="true"' : ''}>${st.busy ? 'Creating' : 'Create key'}</button>
      </div>
      <div id="key-name-err" class="cn-err-slot">${err ? `<p class="cn-err" role="alert">${h.esc(err)}</p>` : ''}</div>
    </div>
    <ul class="h-scopes cn-scopes">
      <li><button type="button" class="h-toggle on" role="switch" aria-checked="true" aria-disabled="true" disabled aria-labelledby="cn-scope-read"><i></i></button>
        <div><b id="cn-scope-read">Read your plan, data and packs</b><span>Always on</span></div></li>
      <li><button type="button" class="h-toggle${st.write ? ' on' : ''}" role="switch" aria-checked="${st.write}" data-conn="write-toggle" data-testid="key-write-toggle" aria-labelledby="cn-scope-write"><i></i></button>
        <div><b id="cn-scope-write">Can change recommendation status</b><span>Write: accept, start, finish, snooze or dismiss items</span></div></li>
    </ul>
  </form>`;
}

function revealPanel(h) {
  const r = st.revealed;
  if (!r) return '';
  return `<div class="cn-reveal" role="region" aria-labelledby="cn-reveal-t">
    <div class="cn-reveal-h"><h3 id="cn-reveal-t" tabindex="-1">New key for ${h.esc(r.name)}</h3><span>${h.esc(SCOPE_TEXT(r.scopes))}</span></div>
    <p class="cn-reveal-note">${h.icon('lock')}This key is shown once. Copy it now; Fathom keeps only a fingerprint and cannot show it again.</p>
    <div class="h-url cn-keybox"><code data-testid="new-key">${h.esc(r.key)}</code>${h.btn(st.copied === 'key' ? 'Copied' : 'Copy', 'data-conn="copy" data-which="key" data-testid="copy-new-key" aria-label="Copy the new key"', st.copied === 'key' ? '' : 'pri')}</div>
    <p class="h-mute sm">The setup commands below include it until you press Done.</p>
    <div class="h-acts">${h.btn('Done', 'data-conn="done" data-testid="key-done"', '')}</div>
  </div>`;
}

function setup(h) {
  const { claude, json } = snippets(st.mcp?.url);
  const live = !!st.revealed;
  return `<div class="cn-snips">
    <div class="cn-snip"><div class="h-sub-h">Claude Code<span>${copyBtn(h, 'claude', 'Copy')}</span></div>
      <pre class="h-pre" data-testid="snippet-claude">${h.esc(claude)}</pre></div>
    <div class="cn-snip"><div class="h-sub-h">Any MCP client (JSON config)<span>${copyBtn(h, 'json', 'Copy')}</span></div>
      <pre class="h-pre" data-testid="snippet-json">${h.esc(json)}</pre></div>
    <p class="h-mute sm">${live ? 'These include the key you just created.' : `Replace ${h.esc(PLACEHOLDER)} with a key you create above.`}</p>
  </div>`;
}

function keyRow(h, k) {
  const revoked = !!k.revokedAt;
  const confirming = !revoked && st.confirming === k.id;
  const busy = st.revoking === k.id;
  let acts = '';
  if (!revoked && confirming) {
    acts = `<div class="cn-confirm" role="group" aria-label="Confirm revoke"><span>Clients using it stop working.</span>
      ${h.btn(busy ? 'Revoking' : 'Revoke key', `data-conn="confirm-revoke" data-id="${h.esc(k.id)}" data-testid="confirm-revoke"${busy ? ' disabled' : ''}`, 'cn-danger')}
      ${h.btn('Cancel', `data-conn="cancel-revoke" data-id="${h.esc(k.id)}"`, 'ghost')}</div>`;
  } else if (!revoked) {
    acts = h.btn('Revoke', `data-conn="revoke" data-id="${h.esc(k.id)}" data-testid="revoke-key" aria-label="Revoke ${h.esc(k.name)}"`, 'ghost');
  }
  const created = fmtDate(k.createdAt, false);
  const used = k.lastUsedAt ? fmtDate(k.lastUsedAt, true) : 'never';
  return `<li class="cn-key${revoked ? ' revoked' : ''}" data-testid="key-row" data-key-id="${h.esc(k.id)}">
    <div class="cn-key-b">
      <div class="cn-key-top"><b data-testid="key-name">${h.esc(k.name)}</b><span class="cn-status ${revoked ? 'revoked' : 'active'}" data-testid="key-status" tabindex="-1">${revoked ? 'revoked' : 'active'}</span></div>
      <div class="h-meta"><span>${h.esc(SCOPE_TEXT(k.scopes))}</span><span>Created <time datetime="${h.esc(k.createdAt || '')}">${h.esc(created)}</time></span><span>Last used ${k.lastUsedAt ? `<time datetime="${h.esc(k.lastUsedAt)}">${h.esc(used)}</time>` : 'never'}</span>${revoked ? `<span>Revoked <time datetime="${h.esc(k.revokedAt)}">${h.esc(fmtDate(k.revokedAt, false))}</time></span>` : ''}</div>
    </div>
    <div class="h-acts cn-key-acts">${acts}</div>
  </li>`;
}

function keyList_(h) {
  const keys = st.keys.slice().reverse();
  const err = st.listError ? `<p class="cn-err" role="alert">${h.esc(st.listError)}</p>` : '';
  if (!keys.length) return `${err}<p class="h-mute">${st.loading ? 'Loading keys.' : 'No keys yet. Create one above for each client you connect.'}</p>`;
  return `${err}<ul class="cn-keys" aria-label="API keys">${keys.map((k) => keyRow(h, k)).join('')}</ul>`;
}

function tools(h) {
  const list = Array.isArray(st.mcp?.tools) ? st.mcp.tools : [];
  if (!list.length) return `<p class="h-mute">${st.loading ? 'Loading tools.' : 'No tools listed.'}</p>`;
  return `<ul class="h-tools cn-tools">${list.map((t) => {
    const w = t.scope !== 'read';
    return `<li data-testid="tool-row"><div class="cn-tool-h"><code>${h.esc(t.name)}</code> <span class="cn-scope${w ? ' w' : ''}">${w ? 'write' : 'read'}</span></div> ${t.description ? `<p>${h.esc(t.description)}</p>` : ''}</li>`;
  }).join('')}</ul>`;
}

export function render(h) {
  const active = st.keys.filter((k) => !k.revokedAt).length;
  const loadErr = st.loadError ? `<p class="cn-err" role="alert">${h.esc(st.loadError)}</p>` : '';
  return h.shell(`${h.pageHead('Connect', 'Bring your own AI', 'Point any MCP client at your plan with a key you issue here. Each key sees what its scope allows, and nothing else.')}
    ${loadErr}${urlBlock(h)}
    <div class="h-cols cn-cols"><div class="h-col-main">
      ${h.section('Create a key', `${createForm(h)}${revealPanel(h)}`)}
      ${h.section('Client setup', setup(h))}
      ${h.section('Keys', keyList_(h), `${active} active`)}
    </div><div class="h-col-side">
      ${h.section('Tools', tools(h), 'Read tools work with any key')}
    </div></div>`, 'connect');
}

/* ---------- events ---------- */

function focus(sel) {
  const el = document.querySelector(sel);
  if (el) el.focus();
}

function copyText(which) {
  if (which === 'key') return st.revealed?.key || '';
  if (which === 'url') return st.mcp?.url || '';
  const s = snippets(st.mcp?.url);
  return which === 'claude' ? s.claude : which === 'json' ? s.json : '';
}

export function onInput(target) {
  if (target.dataset.connInput === 'name') st.draft = target.value;
}

export function onClick(target, h) {
  const d = target.dataset;
  switch (d.conn) {
    case 'write-toggle': {
      st.write = !st.write;
      target.classList.toggle('on', st.write);
      target.setAttribute('aria-checked', String(st.write));
      return;
    }
    case 'copy': {
      const text = copyText(d.which);
      if (!text) return;
      const which = d.which;
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .then(() => {
          clearTimeout(st.copyTimer);
          st.copied = which;
          h.redraw();
          focus(`[data-conn="copy"][data-which="${which}"]`);
          st.copyTimer = setTimeout(() => { st.copied = ''; h.redraw(); }, 1600);
        })
        .catch(() => { /* clipboard unavailable: the text stays selectable on the page */ });
      return;
    }
    case 'done': {
      clearSecret();
      clearTimeout(st.copyTimer);
      st.copied = '';
      h.redraw();
      focus('#key-name-input');
      return;
    }
    case 'revoke': {
      st.confirming = d.id;
      st.listError = '';
      h.redraw();
      focus(`[data-conn="confirm-revoke"][data-id="${CSS.escape(d.id)}"]`);
      return;
    }
    case 'cancel-revoke': {
      st.confirming = null;
      h.redraw();
      focus(`[data-conn="revoke"][data-id="${CSS.escape(d.id)}"]`);
      return;
    }
    case 'confirm-revoke': {
      if (st.revoking) return;
      const id = d.id;
      st.revoking = id;
      h.redraw();
      const my = gen;
      postJson(`/api/keys/${encodeURIComponent(id)}/revoke`, {})
        .then((data) => {
          if (my !== gen) return;
          const next = keyList(data);
          if (next) st.keys = next;
          else if (data.record) st.keys = st.keys.map((k) => (k.id === id ? data.record : k));
          st.confirming = null;
          st.revoking = null;
          h.redraw();
          focus(`[data-key-id="${CSS.escape(id)}"] [data-testid="key-status"]`);
        })
        .catch((err) => {
          if (my !== gen) return;
          st.revoking = null;
          st.listError = err.message || 'Could not revoke the key.';
          h.redraw();
        });
      return;
    }
    default:
  }
}

export function onSubmit(form, h) {
  if (form.dataset.connForm !== 'create' || st.busy) return;
  const input = form.querySelector('#key-name-input');
  const name = String(input?.value ?? st.draft).trim();
  st.draft = input?.value ?? st.draft;
  if (!name) {
    st.formError = 'Give the key a name so you can tell your clients apart.';
    h.redraw();
    focus('#key-name-input');
    return;
  }
  const body = { name };
  if (st.write) body.scopes = ['write:recs'];
  st.busy = true;
  st.formError = '';
  clearSecret();
  h.redraw();
  const my = gen;
  postJson('/api/keys', body)
    .then((data) => {
      if (my !== gen) return;
      st.busy = false;
      const next = keyList(data);
      if (next) st.keys = next;
      else if (data.record) st.keys = st.keys.concat([data.record]);
      if (typeof data.key === 'string' && data.key) {
        st.revealed = { key: data.key, name: data.record?.name || name, scopes: data.record?.scopes || ['read'] };
      }
      st.draft = '';
      st.write = false;
      h.redraw();
      focus('#cn-reveal-t');
    })
    .catch((err) => {
      if (my !== gen) return;
      st.busy = false;
      st.formError = err.message || 'Could not create the key.';
      h.redraw();
      focus('#key-name-input');
    });
}
