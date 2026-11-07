// The advisor review packet: a self-contained, printable HTML document (no scripts, no external
// resources) built from a scenario (src/scenario/build.mjs). Every money figure comes from the
// scenario's stored or derived figures and carries a numbered provenance note (kind, source, as
// of); a figure token with no source renders as "figure unavailable", never as a number. All text
// is reduced to plain text and escaped, so stored markup or owner text cannot inject anything.
//
// buildPacketHtml(scenario, { generatedOn }) -> string
// storePacket / readPacket keep it sealed in the household vault (src/ingest/vault.mjs).

import { createHash, randomBytes } from 'node:crypto';
import { TOKEN, KIND_WORDS, money, pct, esc } from '../shared/tokens.mjs';
import { storeFile, readStoredFile } from '../ingest/vault.mjs';
import { dayLabel } from './index.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Stored text is token text that may carry markup and entities: strip tags, decode entities.
function plain(s, keepEdges = false) {
  const out = String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
    })
    .replace(/\s+/g, ' ');
  return keepEdges ? out : out.trim();
}

// Collects every figure the packet shows, numbered in first-use order.
function notesBook(S, sources = {}) {
  const list = [];
  const byKey = new Map();
  const srcOf = id => (S.src && id && S.src[id]) || null;
  return {
    list,
    // Figure key -> footnote number, or null when the figure has no value or no known source.
    fig(key) {
      const f = S.fig ? S.fig[key] : null;
      if (!f || typeof f.v !== 'number' || !Number.isFinite(f.v) || !srcOf(f.src)) return null;
      if (byKey.has('f:' + key)) return byKey.get('f:' + key);
      const s = srcOf(f.src);
      const n = list.length + 1;
      list.push({ n, key, value: money(f.v), label: plain(f.label), kind: KIND_WORDS[f.kind] || KIND_WORDS.e, source: plain(s.label), asOf: plain(s.asOf),
        notes: (f.notes || []).map(plain), unavailable: f.unavailable ? plain(f.unavailable) : '' });
      byKey.set('f:' + key, n);
      return n;
    },
    // Statutory amounts ({l:}) and percentages ({p:}) come from the `law` and `pct` content rows;
    // their note names the row's source (contentSources). No known source: no number.
    param(type, key) {
      const table = type === 'l' ? S.law : S.pct;
      const src = type === 'l' ? sources.law : sources.pct;
      if (!table || typeof table[key] !== 'number' || !Number.isFinite(table[key]) || !src) return null;
      if (byKey.has(type + ':' + key)) return byKey.get(type + ':' + key);
      const n = list.length + 1;
      list.push({ n, key, value: type === 'l' ? money(table[key]) : pct(table[key]), label: key, kind: type === 'l' ? 'Statutory amount' : 'Rate',
        source: plain(src.label), asOf: plain(src.asOf), notes: [], unavailable: '' });
      byKey.set(type + ':' + key, n);
      return n;
    },
  };
}

const ref = (value, n) => `<span class="fig">${esc(value)}<sup><a href="#n${n}">${n}</a></sup></span>`;
const NO_FIG = '<span class="nofig">[figure unavailable]</span>';

// Token text -> escaped HTML with figures and footnote refs.
function rich(S, book, input) {
  const str = String(input == null ? '' : input);
  let out = '';
  let last = 0;
  for (const m of str.matchAll(TOKEN)) {
    out += esc(plain(str.slice(last, m.index), true));
    const [, type, key] = m;
    if (type === 'f' || type === 'fk') {
      const n = book.fig(key);
      out += n == null ? NO_FIG : ref(money(S.fig[key].v), n) + (S.fig[key].unavailable ? ' (not current)' : '');
    } else if (type === 'l' || type === 'p') {
      const n = book.param(type, key);
      out += n == null ? NO_FIG : ref(type === 'l' ? money(S.law[key]) : pct(S.pct[key]), n);
    } else {
      out += esc(plain(S.names?.[key] ?? ''));
    }
    last = m.index + m[0].length;
  }
  out += esc(plain(str.slice(last), true));
  return out.replace(/\s+([.,;:])/g, '$1').trim();
}

const arr = v => (Array.isArray(v) ? v : []);

const CSS = `
:root { color-scheme: light; }
body { font: 14px/1.5 Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; margin: 0; }
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
h3 { font-size: 16px; margin: 24px 0 4px; }
.sub, .mute { color: #555; }
.sm { font-size: 12px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0; }
dt { color: #555; }
dd { margin: 0; }
.fig { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
sup a { color: #555; text-decoration: none; font-size: 10px; margin-left: 1px; }
.nofig { color: #8a1c1c; }
.rec { break-inside: avoid-page; }
ol.notes li { margin-bottom: 6px; }
ul, ol { padding-left: 20px; }
footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 8px; color: #555; font-size: 12px; }
@media print { main { padding: 0; } a { color: inherit; } .noprint { display: none; } }
`;

// The packet for the scenario's waiting reviews (S.advisor.pending, in order).
// `sources` is contentSources(db): the provenance of the law and pct content rows.
export function buildPacketHtml(S, { generatedOn, sources = {} } = {}) {
  const book = notesBook(S, sources);
  const R = s => rich(S, book, s);
  const recs = arr(S.recs);
  const byId = new Map(recs.map(r => [r.id, r]));
  const adv = S.advisor || {};
  const pending = arr(adv.pending).map(id => byId.get(id)).filter(Boolean);
  const waiting = new Map(arr(adv.waiting).map(w => [w.recId, w]));
  const product = plain(S.meta?.product || 'Fathom');
  const advisorName = plain(adv.name ? S.names && /^\{n:([^}]+)\}$/.test(adv.name) ? S.names[adv.name.slice(3, -1)] : adv.name : '') || 'Your advisor';
  const open = recs.filter(r => ['proposed', 'doing', 'waiting', 'snoozed'].includes(r.status));
  const accounts = arr(S.accounts);
  const goals = arr(S.goals);
  const reviewed = arr(adv.reviewed);
  const assumptions = new Set();

  const recHtml = pending.map((r, i) => {
    const why = arr(r.why).map(p => `<p>${R(p)}</p>`).join('');
    const mine = arr(r.mine).map(m => {
      const n = book.fig(m.fig);
      return `<dt>${R(m.label)}</dt><dd>${n == null ? NO_FIG : ref(money(S.fig[m.fig].v), n)}</dd>`;
    }).join('');
    for (const m of arr(r.mine)) for (const note of arr(S.fig?.[m.fig]?.notes)) assumptions.add(plain(note));
    const kb = arr(r.kb).map(k => `<li><b>${R(k.title)}</b>${k.cite ? `, ${R(k.cite)}` : ''}</li>`).join('');
    const tasks = arr(r.tasks).map(t => `<li>${R(t.t)}</li>`).join('');
    const qs = [`Do you confirm "${R(r.title)}" as written, or should we drop it?`, ...arr(r.qa).map(q => R(q.q))];
    const w = waiting.get(r.id);
    return `<section class="rec" id="rec-${esc(r.id)}">
<h3>${i + 1}. ${R(r.title)}</h3>
<p class="sub">${R(r.summary)}</p>
<dl><dt>Status</dt><dd>${esc(r.status)}</dd>${r.window?.label ? `<dt>Window</dt><dd>${R(r.window.label)}</dd>` : ''}${w ? `<dt>Sent for review</dt><dd>${esc(w.sent)}</dd>` : ''}</dl>
${why ? `<h4>Why now</h4>${why}` : ''}
${mine ? `<h4>Figures from the household data</h4><dl>${mine}</dl>` : ''}
${tasks ? `<h4>Steps proposed</h4><ol>${tasks}</ol>` : ''}
${kb ? `<h4>Sources</h4><ul>${kb}</ul>` : ''}
<h4>Questions for the advisor</h4><ol>${qs.map(q => `<li>${q}</li>`).join('')}</ol>
</section>`;
  }).join('\n');

  const notes = book.list.map(f => {
    f.notes.forEach(n => assumptions.add(n));
    return `<li id="n${f.n}"><b>${esc(f.value)}</b>, ${esc(f.label)}. ${esc(f.kind)}. Source: ${esc(f.source)}${f.asOf ? `, as of ${esc(f.asOf)}` : ''}.${f.unavailable ? ` Not current: ${esc(f.unavailable)}.` : ''}</li>`;
  }).join('');

  const title = `Advisor review packet, ${esc(dayLabel(generatedOn || S.meta?.clock))}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${CSS}</style></head>
<body><main>
<h1>Advisor review packet</h1>
<p class="sub">${esc(plain(S.meta?.household) || 'The household')}. For ${esc(advisorName)}. Prepared ${esc(dayLabel(generatedOn || S.meta?.clock))} by ${esc(product)}. Data through ${esc(plain(S.meta?.dataThrough) || 'not stated')}.</p>
<p class="noprint sm mute">To save a PDF, print this page from your browser and choose Save as PDF.</p>
<h2>Household summary</h2>
<dl>
<dt>Open recommendations</dt><dd>${open.length}</dd>
<dt>Waiting on your review</dt><dd>${pending.length}</dd>
<dt>Reviewed so far</dt><dd>${reviewed.filter(v => v.verdict === 'confirmed').length} confirmed, ${reviewed.filter(v => v.verdict === 'vetoed').length} vetoed</dd>
<dt>Accounts on file</dt><dd>${accounts.length}</dd>
${adv.next?.when ? `<dt>Next check-in</dt><dd>${esc(adv.next.when)}${adv.next.length ? `, ${esc(adv.next.length)}` : ''}</dd>` : ''}
</dl>
${goals.length ? `<h4>Goals</h4><ul>${goals.map(g => `<li>${R(g.title || g.name || '')}</li>`).join('')}</ul>` : ''}
<h2>For review</h2>
${recHtml || '<p class="mute">Nothing is waiting on review.</p>'}
<h2>Assumptions</h2>
${assumptions.size ? `<ul>${[...assumptions].map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="mute">No stated assumptions beyond the sources below.</p>'}
<h2>Where each figure comes from</h2>
${notes ? `<ol class="notes">${notes}</ol>` : '<p class="mute">No figures in this packet.</p>'}
<footer>Advisory only. ${esc(product)} never files, moves money or picks securities. Every figure above comes from the household's stored data or a deterministic calculation, with its source listed.</footer>
</main></body></html>
`;
}

// Where the `law` and pct` content rows came from: a sources row or an imported file with the
// row's src id, or the planner, which writes them from the tax calculator's parameters.
export function contentSources(db) {
  const out = {};
  for (const key of ['law', 'pct']) {
    const row = db.prepare('SELECT src, updated_at FROM content WHERE key = ?').get(key);
    if (!row || !row.src) continue;
    const s = db.prepare('SELECT label, as_of FROM sources WHERE id = ?').get(row.src);
    const f = s ? null : db.prepare('SELECT name FROM files WHERE id = ?').get(row.src);
    const asOf = dayLabel(s?.as_of || row.updated_at);
    if (s) out[key] = { label: s.label, asOf };
    else if (f) out[key] = { label: `Imported file: ${f.name}`, asOf };
    else if (row.src === 'planner') out[key] = { label: 'Tax parameters for the year, from the tax calculator', asOf };
  }
  return out;
}

const PACKET_ID = /^advpkt-[a-f0-9]{16}$/;
export const isPacketId = id => typeof id === 'string' && PACKET_ID.test(id);

// Seals the packet in the household vault (purpose advisor-packet), then records it. Returns the
// packet id. `vault` is the household's { root, handle }.
export async function storePacket(db, { vault, html, clock, recIds, now }) {
  const id = `advpkt-${randomBytes(8).toString('hex')}`;
  const bytes = Buffer.from(html, 'utf8');
  const storedPath = await storeFile({ vault, id, bytes, purpose: 'advisor-packet' });
  db.prepare('INSERT INTO advisor_packets (id, created_at, clock, rec_ids, stored_path, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, clock, JSON.stringify(recIds), storedPath, bytes.length, createHash('sha256').update(bytes).digest('hex'));
  return id;
}

export async function readPacket(db, { vault, id }) {
  const row = isPacketId(id) ? db.prepare('SELECT * FROM advisor_packets WHERE id = ?').get(id) : null;
  if (!row) return null;
  const bytes = await readStoredFile({ vault, id: row.id, storedPath: row.stored_path, purpose: 'advisor-packet' });
  return { row, bytes };
}
