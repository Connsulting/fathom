// The advisor review packet: a self-contained, printable HTML document (no scripts, no external
// resources) built from a scenario (src/scenario/build.mjs). Every money figure comes from the
// scenario's stored or derived figures and carries a numbered provenance note (kind, source, as
// of); a figure token with no source renders as "figure unavailable", never as a number. All text
// is reduced to plain text and escaped, so stored markup or owner text cannot inject anything.
//
// buildPacketHtml(scenario, { generatedOn }) -> string
// storePacket / readPacket keep it encrypted in the data volume (src/ingest/vault.mjs).

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
function notesBook(S) {
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
    law(key) {
      if (!S.law || typeof S.law[key] !== 'number') return null;
      if (byKey.has('l:' + key)) return byKey.get('l:' + key);
      const n = list.length + 1;
      list.push({ n, key, value: money(S.law[key]), label: key, kind: 'Statutory amount', source: 'Tax law parameters for the year', asOf: '', notes: [], unavailable: '' });
      byKey.set('l:' + key, n);
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
    } else if (type === 'l') {
      const n = book.law(key);
      out += n == null ? NO_FIG : ref(money(S.law[key]), n);
    } else if (type === 'p') {
      out += typeof S.pct?.[key] === 'number' ? esc(pct(S.pct[key])) : '';
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
export function buildPacketHtml(S, { generatedOn } = {}) {
  const book = notesBook(S);
  const R = s => rich(S, book, s);
  const recs = arr(S.recs);
  const byId = new Map(recs.map(r => [r.id, r]));
  const adv = S.advisor || {};
  const pending = arr(adv.pending).map(id => byId.get(id)).filter(Boolean);
  const waiting = new Map(arr(adv.waiting).map(w => [w.recId, w]));
  const product = plain(S.meta?.product || 'Fathom');
  const advisorName = plain(adv.name ? S.names && /^\{n:([^}]+)\}$/.test(adv.name) ? S.names[adv.name.slice(3, -1)] : adv.name : '') || 'Your advisor';
  const open = recs.filter(r => ['proposed', 'accepted', 'doing', 'waiting', 'snoozed'].includes(r.status));
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

const PACKET_ID = /^advpkt-[a-f0-9]{16}$/;
export const isPacketId = id => typeof id === 'string' && PACKET_ID.test(id);

// Encrypts and stores the packet, then records it. Returns the packet id.
export async function storePacket(db, { dataDir, key, html, clock, recIds, now }) {
  const id = `advpkt-${randomBytes(8).toString('hex')}`;
  const bytes = Buffer.from(html, 'utf8');
  const storedPath = await storeFile({ dataDir, key, id, bytes });
  db.prepare('INSERT INTO advisor_packets (id, created_at, clock, rec_ids, stored_path, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, clock, JSON.stringify(recIds), storedPath, bytes.length, createHash('sha256').update(bytes).digest('hex'));
  return id;
}

export async function readPacket(db, { dataDir, key, id }) {
  const row = isPacketId(id) ? db.prepare('SELECT * FROM advisor_packets WHERE id = ?').get(id) : null;
  if (!row) return null;
  const bytes = await readStoredFile({ dataDir, key, id: row.id, storedPath: row.stored_path });
  return { row, bytes };
}
