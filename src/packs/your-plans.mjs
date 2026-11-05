// The private "Your plans" knowledge pack, built from the owner's own plan and benefits documents
// into <dataDir>/packs/your-plans/ (the data volume, never the repository).
//
// buildYourPlans({ db, engine, dataDir, fileIds, clock }) -> { written, dir, entries, sources: [{fileId, name}], warnings }
// fakeExtractRows(text, { fileName }) -> [{ title, body, page }]   (the fake engine's extraction)
//
// Sources are documents with doc_type plan or benefits (their file, or fields.text when a row has
// no file) plus any extra files named by id. A stored_path resolves against dataDir and must stay
// inside it after symlinks. Each source goes through engine.extract; each row becomes one entry
// citing `<file name>, page <n>` at https://your-plans.invalid/<fileId>?page=<n> (a reserved host
// that never resolves; the UI shows it as plain text). The pack is written to a temporary sibling,
// validated with loadPacks, then swapped in, and settings['packs.generation'] is bumped so every
// running server refreshes. The target must resolve outside the repository entirely. Warnings
// never carry document text.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './index.mjs';
import { yourPlansDir } from './state.mjs';
import { getSetting, setSetting, parseJson } from '../store/db.mjs';
import { resolveClock } from '../scenario/build.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const CITE_HOST = 'https://your-plans.invalid/';
const MAX_TITLE = 120;
const MAX_BODY = 20000;

const ROW_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' }, page: { type: 'integer' }, taxYear: { type: 'integer' } },
  required: ['title', 'body', 'page'],
  additionalProperties: false,
};
const EXTRACT_SYSTEM = 'Extract the sections of this plan or benefits document as rows: a short title, the section text as written, ' +
  'and the page it starts on (1 when the document has no pages). Add taxYear only when the document states the year it applies to. ' +
  'Never invent sections, amounts or rules that are not in the document.';

export class YourPlansRefusal extends Error {
  constructor(message) { super(message); this.name = 'YourPlansRefusal'; }
}

// ---------------------------------------------------------------- fake extraction

const PAGE_MARK = /^\s*page\s+(\d{1,4})\s*$/i;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

export function fakeExtractRows(text, { fileName = 'document' } = {}) {
  const rows = [];
  let page = 1;
  let current = null;
  const close = () => {
    if (current) {
      const body = current.lines.join('\n').trim();
      if (body) rows.push({ title: current.title || `Page ${current.page} of ${fileName}`, body, page: current.page });
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

function readFileSource(file, dataDir, warnings) {
  const label = file.name || file.id;
  if (!file.stored_path) { warnings.push(`File ${label} has no stored copy and was skipped.`); return null; }
  const root = realpathSync(dataDir);
  const path = isAbsolute(file.stored_path) ? file.stored_path : resolve(dataDir, file.stored_path);
  let real;
  try { real = realpathSync(path); } catch { warnings.push(`File ${label} could not be found and was skipped.`); return null; }
  if (!inside(root, real)) { warnings.push(`File ${label} is outside the data directory and was skipped.`); return null; }
  let bytes;
  try { bytes = readFileSync(real); } catch { warnings.push(`File ${label} could not be read and was skipped.`); return null; }
  if (isText(file.mime, file.name)) return { fileId: file.id, name: label, document: { type: 'text', text: bytes.toString('utf8') } };
  if (isPdf(file.mime, bytes)) return { fileId: file.id, name: label, document: { type: 'pdf', data: bytes } };
  warnings.push(`File ${label} is not a text or PDF document and was skipped.`);
  return null;
}

function gatherSources(db, dataDir, fileIds, warnings) {
  const sources = [];
  const fileRow = db.prepare('SELECT id, name, mime, stored_path FROM files WHERE id = ?');
  const seen = new Set();
  const addFile = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const file = fileRow.get(id);
    if (!file) { warnings.push(`No file with id ${id}; it was skipped.`); return; }
    const source = readFileSource(file, dataDir, warnings);
    if (source) sources.push(source);
  };
  const docs = db.prepare("SELECT id, fields, file_id FROM documents WHERE doc_type IN ('plan', 'benefits') ORDER BY id").all();
  for (const doc of docs) {
    if (doc.file_id) { addFile(doc.file_id); continue; }
    const fields = parseJson(doc.fields, {});
    if (fields && typeof fields.text === 'string' && fields.text.trim()) {
      sources.push({ fileId: null, name: `document-${doc.id}`, document: { type: 'text', text: fields.text } });
    }
  }
  for (const id of fileIds) addFile(id);
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
  const title = neutralTitle(row.title ?? '').slice(0, MAX_TITLE).trim() || `Section on page ${row.page}`;
  return { title, body, page: row.page, taxYear: Number.isInteger(row.taxYear) ? row.taxYear : null };
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

export async function buildYourPlans({ db, engine, dataDir, fileIds = [], clock } = {}) {
  if (!db || !engine || typeof dataDir !== 'string' || !dataDir) throw new TypeError('buildYourPlans needs db, engine and dataDir');
  if (!Array.isArray(fileIds) || !fileIds.every(id => typeof id === 'string')) throw new TypeError('fileIds must be strings');
  guardTarget(dataDir);
  const day = resolveClock(db, clock);
  const dir = yourPlansDir(resolve(dataDir));
  const warnings = [];
  const sources = gatherSources(db, resolve(dataDir), fileIds, warnings);
  const entries = [];
  for (const source of sources) {
    const fake = engine.mode === 'fake' && source.document.type === 'text'
      ? [{ text: JSON.stringify({ rows: fakeExtractRows(source.document.text, { fileName: source.name }) }) }]
      : undefined;
    const rows = await engine.extract({ document: source.document, schema: ROW_SCHEMA, system: EXTRACT_SYSTEM, maxTokens: 4096,
      ...(fake ? { fake } : {}) });
    for (const row of rows) {
      const clean = cleanRow(row, warnings, source.name);
      if (clean) entries.push({ ...clean, fileId: source.fileId, name: source.name });
    }
  }
  const named = sources.map(s => ({ fileId: s.fileId, name: s.name }));
  if (!entries.length) return { written: false, dir, entries: 0, sources: named, warnings };
  writePack(dir, { entries, clock: day });
  setSetting(db, 'yourPlans', { builtAt: new Date().toISOString(), entries: entries.length, sources: named.map(s => s.name) });
  const generation = getSetting(db, 'packs.generation', 0);
  setSetting(db, 'packs.generation', (Number.isInteger(generation) ? generation : 0) + 1);
  return { written: true, dir, entries: entries.length, sources: named, warnings };
}
