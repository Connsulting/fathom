/* Horizon packs: the list with the Your plans builder, and the pack page with its manifest meta,
   entries loaded on demand, the What if conversation and its follow-up composer.
   Entry bodies are markdown from the pack files; renderMarkdown keeps a small subset and escapes
   everything else. */

let H = null;

export function bind(kit) { H = kit; }

const TOGGLE_NOTE = 'Recommendations update on the next planning run.';
const PRIVATE_HOST = 'your-plans.invalid';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ST = { active: 'On', suggested: 'Suggested', available: 'Available', exploring: 'Exploring' };

// Screen state that is not in the scenario. Survives redraws, not reloads.
const S = {
  open: null,               // { pack, entry } of the open entry
  entries: new Map(),       // `${pack}/${entry}` -> { state: 'loading' | 'ok' | 'missing', entry }
  yp: { off: new Set(), on: new Set(), building: false, result: null }
};

const ekey = (pack, entry) => `${pack}/${entry}`;
// Plain escaping for manifest-derived text: no markup, no scenario tokens.
const lit = (s) => H.esc(String(s ?? '')).replace(/'/g, '&#39;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
// Manifest-backed rows render literally; demo rows may carry tokens.
const mt = (p, s) => (p.manifest ? lit(s) : H.T(s));
const nameOf = (p) => (p.label ? H.T(p.label) : mt(p, p.name));

function isoLabel(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : H.api.txt(String(s || ''));
}

/* ---------- markdown subset ---------- */

// http(s) links render as links, except the reserved private host, which renders as plain text.
function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname === PRIVATE_HOST || u.hostname.endsWith('.' + PRIVATE_HOST)) return null;
  return String(raw);
}

// Dollar amounts in already escaped text, wrapped as statutory money (they come from pack files).
const law = (h) => h.replace(/-?\$\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|[KMB])\b)?/g, '<span class="fx-law">$&</span>');

// Escaped text with emphasis and code, and every dollar amount wrapped as statutory money.
function inlineText(s) {
  let h = lit(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  h = h.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  h = h.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  return law(h);
}

function inline(s) {
  const out = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out.push(inlineText(s.slice(last, m.index)));
    const url = safeUrl(m[2]);
    const label = inlineText(m[1]);
    out.push(url ? `<a href="${H.esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
    last = m.index + m[0].length;
  }
  out.push(inlineText(s.slice(last)));
  return out.join('');
}

export function renderMarkdown(md, title = '') {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    para = [];
    if (!text) return;
    const meta = /^(Tax year|Reviewed|Source|Sources):/.test(text);
    out.push(`<p${meta ? ' class="h-entry-m"' : ''}>${inline(text)}</p>`);
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      flushPara(); flushList();
      const text = hd[2].replace(/\s+#+$/, '').trim();
      // The entry title is already the button label.
      if (!(first && text === title)) out.push(`<h4>${inline(text)}</h4>`);
      first = false;
      continue;
    }
    first = false;
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (list) {
      // A continuation line of the last item.
      list.items[list.items.length - 1] += ' ' + line;
      continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

/* ---------- entries ---------- */

function citeItem(c) {
  if (!c) return '';
  const label = law(lit(c.label || ''));
  const url = safeUrl(c.url);
  return `<li>${url ? `<a href="${H.esc(url)}" target="_blank" rel="noopener noreferrer">${label || H.esc(url)}</a>` : label}</li>`;
}

function entriesHtml(p) {
  const { arr, icon, esc, section, plural } = H;
  const list = arr(p.entryList).filter((e) => e && e.id);
  if (!list.length) return '';
  const items = list.map((e) => {
    const open = !!(S.open && S.open.pack === p.id && S.open.entry === e.id);
    let body = '';
    if (open) {
      const got = S.entries.get(ekey(p.id, e.id));
      const cites = arr(got?.entry?.cites).length ? got.entry.cites : arr(e.cites);
      const content = !got || got.state === 'loading'
        ? '<p class="h-mute sm h-entry-load">Loading the entry</p>'
        : got.state === 'missing'
          ? '<p class="h-mute sm">This entry could not be loaded right now.</p>'
          : `<div class="h-entry-body">${renderMarkdown(got.entry.body, got.entry.title || e.title)}</div>`;
      body = `<div class="h-entry-x" id="h-entry-${esc(e.id)}">${content}${cites.length ? `<div class="h-sub-h h-entry-ch">Citations</div><ul class="h-entry-cites">${cites.map(citeItem).join('')}</ul>` : ''}</div>`;
    }
    return `<div class="h-entry-i${open ? ' open' : ''}"><button type="button" class="h-entry" data-pack="${esc(p.id)}" data-entry="${esc(e.id)}" aria-expanded="${open}"${open ? ` aria-controls="h-entry-${esc(e.id)}"` : ''}>${law(lit(e.title || e.id))}${icon('chev')}</button>${body}</div>`;
  }).join('');
  return section('Entries', `<div class="h-entries">${items}</div>`, plural(list.length, 'entry', 'entries'));
}

function toggleEntry(pack, entry) {
  const { api, draw } = H;
  if (S.open && S.open.pack === pack && S.open.entry === entry) { S.open = null; draw(); return; }
  S.open = { pack, entry };
  const k = ekey(pack, entry);
  const got = S.entries.get(k);
  if (!got || got.state === 'missing') {
    S.entries.set(k, { state: 'loading' });
    Promise.resolve(typeof api.packEntry === 'function' ? api.packEntry(pack, entry) : null)
      .catch(() => null)
      .then((e) => {
        S.entries.set(k, e && typeof e.body === 'string' ? { state: 'ok', entry: e } : { state: 'missing' });
        if (H.api) H.draw();
      });
  }
  draw();
}

/* ---------- pack page ---------- */

function metaHtml(p) {
  const { T, plural } = H;
  const parts = [`<span>${plural(p.entries || 0, 'curated entry', 'curated entries')}</span>`];
  if (p.curator) parts.push(`<span>Curated by ${mt(p, p.curator)}</span>`);
  if (p.manifest) {
    if (p.version) parts.push(`<span>Version ${lit(p.version)}</span>`);
    if (p.taxYear) parts.push(`<span>Tax year ${lit(p.taxYear)}</span>`);
    if (p.reviewed) parts.push(`<span>Reviewed ${lit(isoLabel(p.reviewed))}</span>`);
    return `<div class="h-meta h-pack-meta">${parts.join('')}</div>`;
  }
  if (p.updated) parts.push(`<span>Updated ${mt(p, p.updated)}</span>`);
  return `<div class="h-meta">${parts.join('')}</div>`;
}

function packPage(p) {
  const { api, T, arr, esc, icon, btn, goA, href, shell, section, thread, composer, recById } = H;
  const on = p.status === 'active';
  const recs = arr(p.recIds).map((rid) => recById(rid)).filter(Boolean);
  const msgs = arr(api.conversation('pack:' + p.id));
  const explored = msgs.length > 0 || p.status === 'exploring';
  const unlocks = arr(p.whatIf?.unlocks);
  const st = ST[p.status] || esc(p.status);
  const override = (api.s.live?.packs || {})[p.id];
  const toggled = !!override && override.active != null;
  const turnOn = btn('Turn this pack on', `data-packtoggle="${esc(p.id)}"`, 'pri');

  const unlockHtml = unlocks.length ? `<div class="h-unlocks"><div class="h-sub-h">Would add to your plan</div><ul>${unlocks.map((u) => {
    const r = u.recId ? api.rec(u.recId) : null;
    const live = r && r.status !== 'hidden';
    return `<li><div><b>${live ? goA('rec', T(u.title), { id: r.id }) : T(u.title)}</b><p>${T(u.text)}</p></div>${live ? `<em>${T(r.window?.label || '')}</em>` : ''}</li>`;
  }).join('')}</ul>${on ? `<p class="h-acc">${icon('check')}Pack is on. These are on your plan.</p>` : `<div class="h-acts">${turnOn}</div>`}</div>` : (on ? '' : `<div class="h-acts">${turnOn}</div>`);

  const whatIf = !on || explored ? section('What if', explored
    ? `${thread(msgs)}${composer('pack:' + p.id, 'Ask a follow-up')}${unlockHtml}`
    : `<p class="h-mute">Talk through what changes if this applied to you. Nothing turns on until you say so.</p><button type="button" class="h-chip" data-whatif="${esc(p.id)}">${T(p.whatIf?.prompt || 'What if')}</button>`) : '';

  return shell(`<div class="h-rec">
    <a class="h-back" href="${href('packs')}" data-go="packs">${icon('back')}Packs</a>
    <div class="h-rec-head"><div class="h-kicker">Knowledge pack<span>${st}</span></div><h1>${nameOf(p)}</h1><p class="h-lede">${mt(p, p.why)}</p>
    ${metaHtml(p)}</div>
    ${on ? `<div class="h-acts big">${btn('Turn off', `data-packtoggle="${esc(p.id)}"`, 'ghost')}</div>` : explored ? '' : `<div class="h-acts big">${btn('What if', `data-whatif="${esc(p.id)}"`, '')}${turnOn}</div>`}
    ${toggled ? `<p class="h-pack-note">${icon('clock')}<span>${TOGGLE_NOTE}</span></p>` : ''}
    <div class="h-cols rec"><div class="h-col-main">
      ${whatIf}
      ${on ? section('Powers on your plan', recs.length ? `<div class="h-refs wide">${recs.map((r) => `<a href="${href('rec', { id: r.id })}" data-go="rec" data-id="${esc(r.id)}"><span>${T(r.title)}</span><em>${T(r.window?.label || '')}</em>${icon('arrow')}</a>`).join('')}</div>` : '<p class="h-mute">Nothing on the plan right now. It still informs answers.</p>') : ''}
      ${entriesHtml(p)}
    </div><div class="h-col-side">
      ${section('Covers', arr(p.covers).length ? `<ul class="h-cross">${arr(p.covers).map((c) => `<li>${mt(p, c)}</li>`).join('')}</ul>` : '<p class="h-mute">Not listed.</p>')}
    </div></div></div>`, 'packs');
}

/* ---------- packs list ---------- */

function packCard(p) {
  const { T, arr, esc, icon, btn, goA, href, plural, recById } = H;
  const on = p.status === 'active';
  const recs = arr(p.recIds).map((id) => recById(id)).filter(Boolean);
  const st = ST[p.status] || esc(p.status);
  return `<article class="h-pack ${esc(p.status)}">
    <div class="h-pack-h"><a href="${href('packs', { id: p.id })}" data-go="packs" data-id="${esc(p.id)}"><b>${nameOf(p)}</b></a><span class="h-pack-st">${on ? '<i></i>' : ''}${st}</span></div>
    <p>${mt(p, p.why)}</p>
    ${arr(p.covers).length ? `<p class="h-mute sm">Covers ${arr(p.covers).map((c) => mt(p, c)).join(', ')}</p>` : ''}
    <div class="h-meta"><span>${plural(p.entries || 0, 'entry', 'entries')}</span>${p.curator ? `<span>${mt(p, p.curator)}</span>` : ''}${p.updated ? `<span>Updated ${mt(p, p.updated)}</span>` : ''}${on ? `<span>Powers ${plural(recs.length, 'item')}</span>` : ''}</div>
    <div class="h-acts">${on ? goA('packs', `Open${icon('arrow')}`, { id: p.id }, 'h-more') : btn('What if', `data-whatif="${esc(p.id)}"`, '')}</div>
  </article>`;
}

// Candidate documents: plan and benefits documents on file (always read) plus any other file.
function ypCandidates(yp) {
  const { arr } = H;
  const out = [];
  const seen = new Set();
  arr(yp.sources).forEach((s) => {
    if (!s) return;
    if (!s.fileId) {
      const key = `text:${s.name || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, name: s.name || 'document', docType: s.docType || '', source: true, fixed: true });
      return;
    }
    if (seen.has(s.fileId)) return;
    seen.add(s.fileId);
    out.push({ id: s.fileId, name: s.name || s.fileId, docType: s.docType || '', source: true });
  });
  arr(yp.files).forEach((f) => {
    if (!f || !f.id || seen.has(f.id)) return;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name || f.id, docType: '', source: false });
  });
  return out;
}

// Plan and benefits documents start ticked, other files start unticked.
const isPicked = (c) => c.fixed || (c.source ? !S.yp.off.has(c.id) : S.yp.on.has(c.id));

function resultLine(r) {
  const { arr, plural, esc } = H;
  if (!r) return '';
  const warns = arr(r.warnings).length;
  const docs = arr(r.sources).length;
  const text = r.written
    ? `Built ${plural(Number(r.entries) || 0, 'entry', 'entries')} from ${plural(docs, 'document')}.`
    : `Nothing was written. No plan sections were found in ${plural(docs, 'document')}.`;
  return `<p class="h-yp-result${r.written ? '' : ' none'}" role="status">${esc(text)}${warns ? ` <span>${plural(warns, 'document')} skipped.</span>` : ''}</p>`;
}

function yourPlansCard(packs) {
  const { api, esc, goA, icon, section, plural } = H;
  const yp = api.s.live?.yourPlans || {};
  const list = ypCandidates(yp);
  const built = yp.built && typeof yp.built === 'object' ? yp.built : null;
  const pack = packs.find((x) => x.id === 'your-plans' || x.manifest === 'your-plans');
  const files = list.length
    ? `<ul class="h-yp-files">${list.map((c) => `<li><label>${c.fixed ? '' : `<input type="checkbox" data-yp-file="${esc(c.id)}"${isPicked(c) ? ' checked' : ''}>`}<span>${esc(c.name)}</span>${c.source ? `<em>${esc(c.docType || 'plan')} document</em>` : ''}</label></li>`).join('')}</ul>`
    : '<p class="h-mute sm">No documents on file yet. Upload a plan summary or benefits guide first.</p>';
  const builtLine = built
    ? `<p class="h-mute sm">Last built ${esc(isoLabel(built.builtAt))}${Number.isFinite(Number(built.entries)) ? `, ${plural(Number(built.entries), 'entry', 'entries')}` : ''}. ${pack ? goA('packs', `Open the pack${icon('arrow')}`, { id: pack.id }) : ''}</p>`
    : pack ? `<p class="h-mute sm">${goA('packs', `Open the pack${icon('arrow')}`, { id: pack.id })}</p>` : '';
  const body = `<div class="h-card h-yp"${S.yp.building ? ' aria-busy="true"' : ''}>
    <p class="h-yp-lede">Build a private pack from your own plan and benefits documents. Answers cite the file and page. Plan and benefits documents on file are always read; tick any other file to include it.</p>
    ${files}
    <div class="h-acts"><button type="button" class="h-btn pri" data-yp-build${S.yp.building || !(list.some((c) => c.source) || list.some(isPicked)) ? ' disabled' : ''}>Build Your plans pack</button>${S.yp.building ? '<span class="h-mute sm">Reading your documents</span>' : ''}</div>
    ${resultLine(S.yp.result)}${builtLine}
  </div>`;
  return section('Your plans', body, 'Private to this household');
}

function packsList() {
  const { api, arr, shell, section, pageHead } = H;
  const packs = arr(api.packs());
  const act = packs.filter((x) => x.status === 'active');
  const sug = packs.filter((x) => x.status === 'suggested' || x.status === 'exploring');
  const av = packs.filter((x) => x.status === 'available');
  return shell(`${pageHead('Packs', 'What Fathom knows', 'Curated knowledge that grounds answers and recommendations. Packs turn on when your facts make them apply. Explore the rest with a what-if.')}
    ${act.length ? section(`On <em>${act.length}</em>`, `<div class="h-packs">${act.map(packCard).join('')}</div>`) : ''}
    ${sug.length ? section(`Might apply <em>${sug.length}</em>`, `<div class="h-packs">${sug.map(packCard).join('')}</div>`) : ''}
    ${av.length ? section(`Available <em>${av.length}</em>`, `<div class="h-packs">${av.map(packCard).join('')}</div>`) : ''}
    ${packs.length ? '' : '<p class="h-mute">No packs.</p>'}
    ${yourPlansCard(packs)}`, 'packs');
}

export function render(id) {
  const p = id ? H.arr(H.api.packs()).find((x) => x.id === id) : null;
  return p ? packPage(p) : packsList();
}

/* ---------- events ---------- */

function build() {
  const { api } = H;
  if (S.yp.building || typeof api.buildYourPlans !== 'function') return;
  const list = ypCandidates(api.s.live?.yourPlans || {});
  const ids = list.filter((c) => !c.fixed && isPicked(c)).map((c) => c.id);
  S.yp.building = true;
  S.yp.result = null;
  H.draw();
  Promise.resolve(api.buildYourPlans(ids)).catch(() => null).then((res) => {
    S.yp.building = false;
    if (res) { S.yp.result = res; S.entries.clear(); }
    if (H.api) H.draw();
  });
}

// Returns true when the click was handled here.
export function onClick(e) {
  const t = e.target.closest && e.target.closest('[data-entry][data-pack],[data-yp-build]');
  if (!t || !H.root || !H.root.contains(t)) return false;
  e.preventDefault();
  if (t.hasAttribute('data-yp-build')) { if (!t.disabled) build(); return true; }
  toggleEntry(t.getAttribute('data-pack'), t.getAttribute('data-entry'));
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (!t || !t.matches || !t.matches('input[data-yp-file]')) return false;
  const id = t.getAttribute('data-yp-file');
  const c = ypCandidates(H.api.s.live?.yourPlans || {}).find((x) => x.id === id);
  if (!c || c.fixed) return true;
  const set = c.source ? S.yp.off : S.yp.on;
  if (t.checked === !c.source) set.add(id); else set.delete(id);
  const list = ypCandidates(H.api.s.live?.yourPlans || {});
  const btn = H.root && H.root.querySelector('button[data-yp-build]');
  if (btn) btn.disabled = !!S.yp.building || !(list.some((x) => x.source) || list.some(isPicked));
  return true;
}

// A demo reset or a new design mount starts the screen fresh.
export function reset() {
  S.open = null;
  S.entries.clear();
  S.yp = { off: new Set(), on: new Set(), building: false, result: null };
}
