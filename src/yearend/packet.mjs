// The accountant packet: a zip of every received document for the tax year, decrypted from the
// vault, plus a self-contained printable index.html (expected against received, the year's tax
// payments, key figures and open items, each with its provenance). Built in a private temp
// directory that is always removed; nothing decrypted is written anywhere else.

import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { readStoredFile, VaultError } from '../ingest/vault.mjs';
import { getSetting } from '../store/db.mjs';
import { esc, money, resolveTokens } from '../shared/tokens.mjs';
import { tokenScope, resolveClock, loadRecs, deriveDecisions } from '../scenario/build.mjs';
import { yearendChecklist, yearendDecisions, recordPacket, formLabel } from './expected.mjs';
import { writeZip } from './zip.mjs';

export const TEMP_PREFIX = 'fathom-packet-';

const slug = (s) => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function extOf(name, mime) {
  const e = extname(String(name || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(e)) return e;
  return { 'application/pdf': '.pdf', 'text/csv': '.csv', 'text/plain': '.txt', 'text/markdown': '.md' }[String(mime || '').toLowerCase()] || '.bin';
}

// A demo store's documents are synthetic rows with no stored bytes: the packet carries a small text
// rendering of the row's fields instead, so the demo builds the same zip shape.
function demoBytes(row, label) {
  const lines = [`Synthetic demo document: ${label}`, `Tax year ${row.tax_year}`, ''];
  for (const [k, v] of Object.entries(row.fields || {})) lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const provText = (r, files) => {
  const f = r.file_id ? files.get(r.file_id) : null;
  const loc = r.locator == null ? '' : typeof r.locator === 'string' ? r.locator : JSON.stringify(r.locator);
  return [f ? f.name : r.file_id ? `file ${r.file_id}` : 'no file', r.parser, loc].filter(Boolean).join(', ');
};

// Every input the index needs, read from the store.
export function packetData(db, { year, clock }) {
  const scope = tokenScope(db);
  const checklist = yearendChecklist(db, { year, clock, plain: (s) => resolveTokens(scope, s, false) });
  const files = new Map(db.prepare('SELECT id, name, uploaded_at, stored_path, mime, parser FROM files').all().map((f) => [f.id, f]));
  const payments = db.prepare('SELECT * FROM tax_payments WHERE tax_year = ? ORDER BY date, id').all(year);
  const pnl = db.prepare(`SELECT entity, category, round(sum(amount), 2) AS total, count(*) AS n, group_concat(DISTINCT file_id) AS file_ids
                          FROM pnl_lines WHERE substr(period, 1, 4) = ? GROUP BY entity, category ORDER BY entity, category`).all(String(year));
  const figures = db.prepare(`SELECT f.key, f.v, f.label, f.kind, f.file_id, f.parser, f.locator, s.label AS src_label, s.as_of
                              FROM figures f LEFT JOIN sources s ON s.id = f.src WHERE f.kind = 'a' AND f.label != '' AND f.unavailable_reason IS NULL ORDER BY f.key`).all()
    .map((f) => ({ ...f, label: resolveTokens(scope, f.label, false) }));
  const facts = db.prepare("SELECT key, value, src, file_id, parser, locator, confirmed FROM facts WHERE key IN ('household.filingStatus', 'household.state', 'household.dependents') ORDER BY key").all();
  const recs = loadRecs(db, clock);
  const recsById = new Map(recs.map((r) => [r.id, r]));
  const decisionRows = db.prepare('SELECT * FROM decisions ORDER BY sort, id').all();
  const decisions = yearendDecisions({
    year, recs: recs.map((r) => ({ ...r, title: resolveTokens(scope, r.title, false) })),
    decisions: deriveDecisions(decisionRows, recsById, clock, {}).map((d) => ({ ...d, title: resolveTokens(scope, d.title, false) })),
    recRows: db.prepare('SELECT id, window_close FROM recs').all(), opensOn: new Map(decisionRows.map((r) => [r.id, r.opens_on])),
  }).map((d) => ({ ...d, when: resolveTokens(scope, d.when, false) }));
  return { ...checklist, files, payments, pnl, figures, facts, decisions, household: resolveTokens(scope, parseMeta(db).household || '', false) };
}

function parseMeta(db) {
  const r = db.prepare("SELECT value FROM content WHERE key = 'meta'").get();
  try { return JSON.parse(r?.value || '{}') || {}; } catch { return {}; }
}

const STATUS = { have: 'Received', expected: 'Not yet due', missing: 'Missing', skipped: 'Not needed' };

// The printable index. Every text value is escaped; figures are formatted from stored numbers.
export function renderIndex(d, { generatedAt, entries, unreadable }) {
  const rowsDocs = d.items.map((i) => `<tr class="${i.status}"><td>${esc(i.t)}</td><td>${STATUS[i.status]}</td><td>${i.files.length
    ? i.files.map((f) => `${f.zip ? `<a href="${esc(f.zip)}">${esc(f.zip)}</a>` : esc(f.name)}<br><small>${esc(f.name)}, stored ${esc(f.date)}${f.pnl ? ', ledger lines' : ''}</small>`).join('<br>')
    : i.status === 'skipped' ? `Not needed: ${esc(i.skip.reason)}` : `${esc(i.src)}. ${esc(i.note)}`}</td></tr>`).join('');
  const rowsUnmatched = d.unmatched.map((u) => `<tr><td>${esc(u.t)}</td><td>${u.zip ? `<a href="${esc(u.zip)}">${esc(u.zip)}</a>` : ''}<br><small>${esc(u.name)}, stored ${esc(u.date)}</small></td></tr>`).join('');
  const byJur = new Map();
  for (const p of d.payments) byJur.set(p.jurisdiction, (byJur.get(p.jurisdiction) || 0) + p.amount);
  const rowsPay = d.payments.map((p) => `<tr><td>${esc(p.date)}</td><td>${esc(p.jurisdiction)}</td><td>${esc(p.kind || '')}</td><td class="r">${esc(money(p.amount, { cents: true }))}</td><td><small>${esc(provText(p, d.files))}</small></td></tr>`).join('');
  const rowsPayTotal = [...byJur].map(([j, v]) => `<tr><td>Total ${esc(j)}</td><td class="r">${esc(money(Math.round(v * 100) / 100, { cents: true }))}</td><td><small>Sum of ${d.payments.filter((p) => p.jurisdiction === j).length} payments listed above</small></td></tr>`).join('');
  const rowsPnl = d.pnl.map((p) => `<tr><td>${esc(p.entity)}</td><td>${esc(p.category)}</td><td class="r">${esc(money(p.total, { cents: true }))}</td><td><small>Sum of ${p.n} ledger lines from ${esc(String(p.file_ids || '').split(',').map((id) => d.files.get(id)?.name || id).join(', '))}</small></td></tr>`).join('');
  const rowsFig = d.figures.map((f) => `<tr><td>${esc(f.label)}</td><td class="r">${esc(money(f.v, { cents: true }))}</td><td><small>${esc([f.src_label, f.as_of].filter(Boolean).join(', '))}; ${esc(provText(f, d.files))}</small></td></tr>`).join('');
  const rowsFacts = d.facts.map((f) => `<tr><td>${esc(f.key)}</td><td>${esc(JSON.parse(f.value))}</td><td><small>${f.confirmed ? 'Confirmed by the owner' : 'From an import'}; ${esc(provText(f, d.files))}</small></td></tr>`).join('');
  const open = [
    ...d.items.filter((i) => i.status === 'missing' || i.status === 'expected').map((i) => `${esc(i.t)}: ${STATUS[i.status].toLowerCase()}, usually ${esc(i.note.toLowerCase())}`),
    ...unreadable.map((u) => `${esc(u.name)}: the stored copy could not be read, so it is not in this packet`),
    ...d.decisions.filter((x) => !x.done).map((x) => `Decision: ${esc(x.t)}${x.when ? ` (${esc(x.when)})` : ''}`),
  ];
  const have = d.items.filter((i) => i.status === 'have').length;
  const table = (head, body, empty) => (body ? `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>` : `<p class="mute">${empty}</p>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax packet ${d.year}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d232b;background:#fff;margin:32px auto;max-width:900px;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #d5dae1;padding-bottom:4px}
table{width:100%;border-collapse:collapse;margin:4px 0}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #e6e9ee}
th{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6573}td.r{text-align:right;font-variant-numeric:tabular-nums}
small,.mute{color:#5b6573}tr.missing td:nth-child(2){color:#a33}tr.have td:nth-child(2){color:#276b3a}ul{padding-left:20px}a{color:#1f5fae}
@media print{body{margin:0;max-width:none}a{color:inherit;text-decoration:none}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
<h1>Tax packet for ${d.year}</h1>
<p class="mute">${d.household ? `${esc(d.household)}. ` : ''}Generated ${esc(generatedAt)}. ${have} of ${d.items.length} expected documents received, ${entries} files in this packet. Figures come from stored data; each row names its source.</p>
<h2>Open items</h2>${open.length ? `<ul>${open.map((o) => `<li>${o}</li>`).join('')}</ul>` : '<p class="mute">None.</p>'}
<h2>Expected documents</h2>${table(['Document', 'Status', 'File or where it comes from'], rowsDocs, 'No documents are expected from the stored facts and accounts.')}
<h2>Other documents received</h2>${table(['Document', 'File'], rowsUnmatched, 'None.')}
<h2>Tax payments for ${d.year}</h2>${table(['Date', 'Jurisdiction', 'Kind', 'Amount', 'Source'], rowsPay, 'No tax payments stored for this year.')}
${rowsPayTotal ? table(['Total', 'Amount', 'Calculation'], rowsPayTotal, '') : ''}
<h2>Business profit and loss, ${d.year}</h2>${table(['Entity', 'Category', 'Total', 'Source'], rowsPnl, 'No profit and loss lines stored for this year.')}
<h2>Key figures</h2>${table(['Figure', 'Value', 'Source'], rowsFig, 'No stored actual figures.')}
<h2>Household</h2>${table(['Fact', 'Value', 'Source'], rowsFacts, 'No household facts stored.')}
<h2>Decisions for the year</h2>${table(['Decision', 'Status'], d.decisions.map((x) => `<tr><td>${esc(x.t)}</td><td>${x.done ? 'Done' : esc(x.status)}${x.when ? `, ${esc(x.when)}` : ''}</td></tr>`).join(''), 'None.')}
</body></html>
`;
}

// Builds the packet zip in a fresh private temp directory and records the generation. Returns
// {file, dir, size, filename, counts, cleanup}; the caller streams `file` and must call cleanup().
// On any failure the directory is removed before the error propagates.
export async function buildPacket(db, { year, clock, dataDir, key, tmpRoot = tmpdir(), now = new Date().toISOString() }) {
  const dir = await mkdtemp(join(tmpRoot, TEMP_PREFIX));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const d = packetData(db, { year, clock: clock || resolveClock(db) });
    const demo = getSetting(db, 'mode', null) === 'demo';
    const entries = [];
    const unreadable = [];
    const used = new Set();
    const docRows = new Map(db.prepare('SELECT id, doc_type, tax_year, fields FROM documents WHERE tax_year = ?').all(year).map((r) => [r.id, { ...r, fields: JSON.parse(r.fields || '{}') }]));
    const take = async (f, label) => {
      if (f.pnl) return;
      const file = d.files.get(f.id);
      let bytes = null;
      let ext = extOf(file?.name, file?.mime);
      if (file?.stored_path) {
        try { bytes = await readStoredFile({ dataDir, key, id: file.id, storedPath: file.stored_path }); } catch (e) { if (!(e instanceof VaultError)) throw e; }
      } else if (demo && file) {
        bytes = demoBytes(docRows.get(f.docId) || { tax_year: year, fields: {} }, label);
        ext = '.txt';
      }
      if (!bytes) { unreadable.push(f); return; }
      let base = `documents/${String(entries.length + 1).padStart(2, '0')}-${slug(formLabel(f.form))}${f.issuer ? `-${slug(f.issuer)}` : ''}-${year}`;
      while (used.has(base + ext)) base += '-b';
      used.add(base + ext);
      f.zip = base + ext;
      entries.push({ name: f.zip, data: bytes });
    };
    for (const i of d.items) for (const f of i.files) await take(f, i.t);
    for (const u of d.unmatched) await take(u, u.t);
    const html = renderIndex(d, { generatedAt: now.slice(0, 16).replace('T', ' ') + ' UTC', entries: entries.length, unreadable });
    const zip = [{ name: 'index.html', data: Buffer.from(html, 'utf8') }, ...entries];
    const file = join(dir, `packet-${year}.zip`);
    const handle = await open(file, 'wx', 0o600);
    let size;
    try { size = await writeZip(zip, (b) => handle.write(b), { date: new Date(now) }); } finally { await handle.close(); }
    const counts = {
      expected: d.items.length, received: d.items.filter((i) => i.status === 'have').length,
      missing: d.items.filter((i) => i.status === 'missing' || i.status === 'expected').length, skipped: d.items.filter((i) => i.status === 'skipped').length,
      unmatched: d.unmatched.length, files: entries.length, unreadable: unreadable.length, payments: d.payments.length, decisions: d.decisions.length,
    };
    recordPacket(db, { year, counts, bytes: size, now });
    return { file, dir, size: (await stat(file)).size, filename: `tax-packet-${year}.zip`, counts, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// Streams a built packet to an HTTP response and removes the temp directory when the response
// ends, fails or the client goes away.
export function streamPacket(res, packet) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; packet.cleanup().finally(resolve); };
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': packet.size,
      'Content-Disposition': `attachment; filename="${packet.filename}"`,
      'Cache-Control': 'no-store',
    });
    const s = createReadStream(packet.file);
    s.on('error', () => { res.destroy(); finish(); });
    res.on('close', finish);
    s.on('close', () => { if (res.writableEnded) finish(); });
    s.pipe(res);
  });
}
