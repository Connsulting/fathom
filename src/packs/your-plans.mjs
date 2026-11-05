// The private "Your plans" knowledge pack, built from the owner's own plan and benefits documents
// into <dataDir>/packs/your-plans/ (the data volume, never the repository).
//
// buildYourPlans({ db, engine, dataDir, key, fileIds, clock }) -> { written, dir, entries, sources: [{fileId, name}], warnings, dropped }
// fakeExtractRows(text) -> [{ title, body, excerpt, page }]   (the fake engine's extraction)
//
// Sources are documents with doc_type plan or benefits (their file, or fields.text when a row has
// no file) plus any extra files named by id. Files are read the way ingest reads its own uploads:
// through the vault (readStoredFile) under the data key `key`, with the file id as associated
// data, so a stored file that fails authentication is skipped with a warning and nothing from it
// reaches the engine. A PDF is read through ingest's text layer (pdfText): its pages go to the
// engine as one text document with a `Page N` line opening each page, and the page check uses the
// PDF's own page boundaries; an image-only PDF (no text layer) or an unreadable one is skipped with
// one warning before any model call. Each source goes through engine.extract; each row becomes one
// entry citing `<file name>, page <n>` at https://your-plans.invalid/<fileId>?page=<n> (a reserved
// host that never resolves; the UI shows it as plain text). A row is kept only when its verbatim
// excerpt is in the source text (whitespace-normalized), every number in its title and body is in
// the excerpt (every digit run, years and dates included, with no prose exemptions), and the
// excerpt sits on the row's page (Page N markers before it in a text file, the page boundaries in
// a PDF); every other row is dropped and counted. The pack is written to a temporary sibling,
// validated with loadPacks, then swapped in, and settings['packs.generation'] is bumped so every
// running server refreshes. The target must resolve outside the repository entirely. Warnings
// never carry document text.

import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './index.mjs';
import { yourPlansDir } from './live.mjs';
import { getSetting, setSetting, parseJson } from '../store/db.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { checkGrounding } from '../engine/grounding.mjs';
import { readStoredFile, VaultError } from '../ingest/vault.mjs';
import { pdfText } from '../ingest/pdftext.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const CITE_HOST = 'https://your-plans.invalid/';
const MAX_TITLE = 120;
const MAX_BODY = 20000;

const ROW_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' }, excerpt: { type: 'string' }, page: { type: 'integer' }, taxYear: { type: 'integer' } },
  required: ['title', 'body', 'excerpt', 'page'],
  additionalProperties: false,
};
const EXTRACT_SYSTEM = 'Extract the sections of this plan or benefits document as rows: a short title, the section text as written, ' +
  'the excerpt (the exact source text the row is drawn from, copied verbatim) and the page it starts on (1 when the document has no pages). ' +
  'Every number in the title and the section text must appear in the excerpt. Add taxYear only when the document states the year it applies to. ' +
  'Never invent sections, amounts or rules that are not in the document.';

export class YourPlansRefusal extends Error {
  constructor(message) { super(message); this.name = 'YourPlansRefusal'; }
}

// ---------------------------------------------------------------- fake extraction

const PAGE_MARK = /^\s*page\s+(\d{1,4})\s*$/i;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
// The title of a section with no heading: numberless, so it passes the excerpt number check.
const UNTITLED = 'Untitled section';

export function fakeExtractRows(text) {
  const rows = [];
  let page = 1;
  let current = null;
  const close = () => {
    if (current) {
      const body = current.lines.join('\n').trim();
      if (body) rows.push({ title: current.title || UNTITLED, body, excerpt: body, page: current.page });
    }
    current = null;
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const mark = PAGE_MARK.exec(line);
    if (mark) { close(); page = Math.max(1, Number(mark[1])); current = { title: '', page, lines: [] }; continue; }
    const heading = HEADING.exec(line);
    if (heading) { close(); current = { title: heading[1].trim(), page, lines: [] }; continue; }
    if (!current) current = { title: '', page, lines: [] };
    current.lines.push(line);
  }
  close();
  return rows;
}

// ---------------------------------------------------------------- the excerpt check

// The source lines whitespace-normalized (runs collapsed to one space, trimmed) into one string,
// with the page each stretch is on: breaks[i] = [normalized index where page starts, page].
// pageOf(line, index) is the page a line opens, or null.
function normalizedSource(lines, pageOf) {
  let norm = '';
  const breaks = [[0, 1]];
  lines.forEach((line, index) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    if (norm) norm += ' ';
    const page = pageOf(line, index);
    if (page) breaks.push([norm.length, page]);
    norm += words.join(' ');
  });
  return { norm, breaks };
}

const lines = text => String(text ?? '').split(/\r?\n/);

// A text file's pages: `Page N` marker lines.
function textSource(text) {
  const markOf = line => { const mark = PAGE_MARK.exec(line); return mark ? Math.max(1, Number(mark[1])) : null; };
  return { document: { type: 'text', text }, checked: normalizedSource(lines(text), markOf) };
}

// A PDF text layer's pages (pdfText separates them with a form feed): the engine sees each page
// opened by a `Page N` line, and only those lines are page breaks, so a `Page 3` line printed
// inside a page never moves the page check.
function pdfSource(layerText) {
  const all = [];
  const opens = new Map();
  layerText.split('\f').forEach((page, i) => {
    if (all.length) all.push('');
    opens.set(all.length, i + 1);
    all.push(`Page ${i + 1}`, '', ...lines(page.trim()));
  });
  return { document: { type: 'text', text: all.join('\n') }, checked: normalizedSource(all, (_, index) => opens.get(index) ?? null) };
}

const normalize = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function pageAt(breaks, index) {
  let page = 1;
  for (const [at, p] of breaks) if (at <= index) page = p;
  return page;
}

// The digit runs of a text, thousands separators removed (1,500 and 1500 are the same run) and
// leading zeros dropped. A date or a year is just its runs: 2026-12-15 is 2026, 12 and 15.
const digitRuns = text => new Set([...String(text ?? '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1').matchAll(/\d+/g)]
  .map(m => m[0].replace(/^0+(?=\d)/, '')));

// A cleaned row matches its source when its excerpt is in the source text, every number in its
// title and body is in the excerpt, and some occurrence of the excerpt is on the row's page.
// The number check has no prose exemptions: every digit run of the title and body, years and
// dates included, must be a digit run of the excerpt. On top of that checkGrounding (with the
// excerpt as the only data) must find nothing but non-percent number words, and such a word counts
// as in the excerpt only when the excerpt has the same words not followed by a percent marker.
// Percent-marked word phrases are grounded by checkGrounding itself, so a percent violation is a
// real mismatch.
function matchesSource(row, source) {
  const excerpt = normalize(row.excerpt);
  if (!excerpt) return false;
  const lower = excerpt.toLowerCase();
  const stated = `${row.title}\n\n${row.body}`;
  const runs = digitRuns(excerpt);
  if (![...digitRuns(stated)].every(run => runs.has(run))) return false;
  const { violations } = checkGrounding(stated, { data: [excerpt] });
  const plain = v => v.reason === 'numeric word absent from sources'
    && !/^\s*(?:percent\b|%)/i.test(stated.slice(v.index + v.text.length))
    && new RegExp(`\\b${v.text.toLowerCase()}\\b(?!\\s*(?:percent\\b|%))`).test(lower);
  if (!violations.every(plain)) return false;
  for (let at = source.norm.indexOf(excerpt); at >= 0; at = source.norm.indexOf(excerpt, at + 1)) {
    if (pageAt(source.breaks, at) === row.page) return true;
  }
  return false;
}

// ---------------------------------------------------------------- guards

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// The real path of `target`: the realpath of its nearest existing ancestor plus the rest.
function realTarget(target) {
  let existing = resolve(target);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ''));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

// The data directory, the write parent <dataDir>/packs (where the temporary pack is written and the
// final directory, or a symlink in its place, is replaced) and the final target must all resolve
// outside the repository. Checking only the final target would follow a your-plans symlink out of
// the repository while the write still lands in a parent inside it.
function guardTarget(dataDir) {
  const repo = realpathSync(REPO_ROOT);
  const target = yourPlansDir(resolve(dataDir));
  for (const path of [resolve(dataDir), dirname(target), target]) {
    if (inside(repo, realTarget(path))) {
      throw new YourPlansRefusal('FATHOM_DATA is inside the repository; set it to a directory outside the checkout');
    }
  }
}

// ---------------------------------------------------------------- sources

const isText = (mime, name) => /^text\//i.test(mime || '') || ['.md', '.txt', '.markdown'].includes(extname(name || '').toLowerCase());
const isPdf = (mime, bytes) => (mime || '').toLowerCase() === 'application/pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-';
const AUTH_FAILED = 'file failed authentication';

// One stored upload, decrypted by the vault exactly as ingest reads its own files (the stored path
// must be files/<id>.bin and the file id is the associated data). Text files are read as UTF-8 and
// PDFs through their text layer; anything else, or any read, authentication or text layer failure,
// warns (naming the file, never its text) and yields no source.
async function readFileSource(file, dataDir, key, warnings) {
  const label = file.name || file.id;
  if (!file.stored_path) { warnings.push(`File ${label} has no stored copy and was skipped.`); return null; }
  let bytes;
  try {
    bytes = await readStoredFile({ dataDir, key, id: file.id, storedPath: file.stored_path });
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    warnings.push(e.message === AUTH_FAILED
      ? `File ${label} failed its integrity check (it was changed or is not this store's file) and was skipped.`
      : `File ${label} could not be read from the data directory and was skipped.`);
    return null;
  }
  if (isText(file.mime, file.name)) return { fileId: file.id, name: label, ...textSource(bytes.toString('utf8')) };
  if (!isPdf(file.mime, bytes)) { warnings.push(`File ${label} is not a text or PDF document and was skipped.`); return null; }
  const layer = await pdfText(bytes);
  if (layer.status === 'text') return { fileId: file.id, name: label, ...pdfSource(layer.text) };
  warnings.push(layer.status === 'image_only'
    ? `File ${label} is an image-only PDF with no text layer, so it was skipped. Upload a copy with a text layer or a text file instead.`
    : `File ${label} is a PDF whose text layer could not be read in full, so it was skipped.`);
  return null;
}

async function gatherSources(db, dataDir, key, fileIds, warnings) {
  const sources = [];
  const fileRow = db.prepare('SELECT id, name, mime, stored_path FROM files WHERE id = ?');
  const seen = new Set();
  const addFile = async id => {
    if (seen.has(id)) return;
    seen.add(id);
    const file = fileRow.get(id);
    if (!file) { warnings.push(`No file with id ${id}; it was skipped.`); return; }
    const source = await readFileSource(file, dataDir, key, warnings);
    if (source) sources.push(source);
  };
  const docs = db.prepare("SELECT id, fields, file_id FROM documents WHERE doc_type IN ('plan', 'benefits') ORDER BY id").all();
  for (const doc of docs) {
    if (doc.file_id) { await addFile(doc.file_id); continue; }
    const fields = parseJson(doc.fields, {});
    if (fields && typeof fields.text === 'string' && fields.text.trim()) {
      sources.push({ fileId: null, name: `document-${doc.id}`, ...textSource(fields.text) });
    }
  }
  for (const id of fileIds) await addFile(id);
  return sources;
}

// ---------------------------------------------------------------- writing

const slug = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'entry';
const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
// Model-extracted titles reach the manifest covers, entry titles and the entry heading: drop markup
// and token characters, keep the words. Bodies go through the UI's escaping markdown renderer, so
// only braces (which could form scenario tokens) are replaced there.
const neutralTitle = s => oneLine(String(s).replace(/[<>{}]/g, ' '));
const neutralBody = s => String(s).replace(/\{/g, '(').replace(/\}/g, ')');

function cleanRow(row, warnings, name) {
  const body = neutralBody(String(row.body ?? '').trim().slice(0, MAX_BODY));
  if (!body || !Number.isInteger(row.page) || row.page < 1) {
    warnings.push(`A section of ${name} had no text or page and was skipped.`);
    return null;
  }
  const title = neutralTitle(row.title ?? '').slice(0, MAX_TITLE).trim() || UNTITLED;
  return { title, body, excerpt: String(row.excerpt ?? ''), page: row.page, taxYear: Number.isInteger(row.taxYear) ? row.taxYear : null };
}

function writePack(dir, { entries, clock }) {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = join(parent, `.your-plans.tmp-${stamp}`);
  const old = join(parent, `.your-plans.old-${stamp}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  try {
    const year = Number(clock.slice(0, 4));
    const listed = entries.map((e, i) => {
      const file = `${String(i + 1).padStart(2, '0')}-${slug(e.title)}.md`;
      const cite = `${e.name}, page ${e.page}`;
      writeFileSync(join(tmp, file), `# ${e.title}\n\n${e.body}\n\nSource: ${cite}\nTax year: ${e.taxYear ?? year}\nReviewed: ${clock}\n`);
      return { file, title: e.title, cites: [{ label: cite, url: `${CITE_HOST}${encodeURIComponent(e.fileId ?? e.name)}?page=${e.page}` }] };
    });
    const manifest = {
      id: 'your-plans', name: 'Your plans', version: '1.0.0', taxYear: year, reviewed: clock,
      curator: 'Built from your documents', covers: [...new Set(entries.map(e => e.title))], appliesWhen: { all: [] },
      whatIf: { prompt: 'What do our own plan and benefits documents say about the choices in front of us?' },
      entries: listed,
    };
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    loadPacks([tmp]);
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- build

export async function buildYourPlans({ db, engine, dataDir, key, fileIds = [], clock } = {}) {
  if (!db || !engine || typeof dataDir !== 'string' || !dataDir) throw new TypeError('buildYourPlans needs db, engine and dataDir');
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('buildYourPlans needs the 32 byte data key as key');
  if (!Array.isArray(fileIds) || !fileIds.every(id => typeof id === 'string')) throw new TypeError('fileIds must be strings');
  guardTarget(dataDir);
  const day = resolveClock(db, clock);
  const dir = yourPlansDir(resolve(dataDir));
  const warnings = [];
  const sources = await gatherSources(db, resolve(dataDir), key, fileIds, warnings);
  const entries = [];
  let dropped = 0;
  for (const source of sources) {
    const fake = engine.mode === 'fake' ? [{ text: JSON.stringify({ rows: fakeExtractRows(source.document.text) }) }] : undefined;
    const rows = await engine.extract({ document: source.document, schema: ROW_SCHEMA, system: EXTRACT_SYSTEM, maxTokens: 4096,
      ...(fake ? { fake } : {}) });
    let mismatched = 0;
    for (const row of rows) {
      const clean = cleanRow(row, warnings, source.name);
      if (!clean) continue;
      if (!matchesSource(clean, source.checked)) { mismatched++; continue; }
      entries.push({ title: clean.title, body: clean.body, page: clean.page, taxYear: clean.taxYear, fileId: source.fileId, name: source.name });
    }
    if (mismatched) {
      dropped += mismatched;
      warnings.push(`${mismatched === 1 ? '1 section' : `${mismatched} sections`} of ${source.name} ${mismatched === 1 ? 'was' : 'were'} dropped because ${mismatched === 1 ? 'it' : 'they'} did not match the document.`);
    }
  }
  const named = sources.map(s => ({ fileId: s.fileId, name: s.name }));
  if (!entries.length) return { written: false, dir, entries: 0, sources: named, warnings, dropped };
  writePack(dir, { entries, clock: day });
  setSetting(db, 'yourPlans', { builtAt: new Date().toISOString(), entries: entries.length, dropped, sources: named.map(s => s.name) });
  const generation = getSetting(db, 'packs.generation', 0);
  setSetting(db, 'packs.generation', (Number.isInteger(generation) ? generation : 0) + 1);
  return { written: true, dir, entries: entries.length, sources: named, warnings, dropped };
}
