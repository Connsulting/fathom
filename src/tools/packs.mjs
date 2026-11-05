// Knowledge pack tools: list_packs, get_pack_entry, search_pack_entries. All read scope.
// Packs load from ctx.packDirs, else the repo packs/ plus `<ctx.dataDir>/packs/your-plans` when it
// exists. Status is what the owner sees: a manifest pack linked to a packs_state row (by the row's
// def.manifest, else the row id) reads packStatus(row base status, row active/exploring); a pack
// with no row keeps the status derived from the stored facts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, activePacks } from '../packs/index.mjs';
import { parseJson } from '../store/db.mjs';
import { getFacts } from '../store/facts.mjs';
import { packStatus } from '../shared/rules.mjs';
import { resolveTokens } from '../shared/tokens.mjs';
import { tokenScope } from '../scenario/build.mjs';
import { ToolError } from './errors.mjs';

export const REPO_PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url)).replace(/[\\/]$/, '');

const SEARCH_DEFAULT = 10;
const SNIPPET = 200;

// Pack directories for a data dir: the repo packs, plus the owner's private plans when present.
export function packDirsFor(dataDir) {
  const dirs = [REPO_PACKS_DIR];
  if (dataDir) {
    const mine = join(dataDir, 'packs', 'your-plans');
    if (existsSync(mine)) dirs.push(mine);
  }
  return dirs;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// packs_state rows by the manifest id they stand for: def.manifest when it is a string, else the
// row's own id. The first row in display order wins.
function rowsByManifest(db) {
  const rows = new Map();
  for (const r of db.prepare('SELECT id, def, active, exploring FROM packs_state ORDER BY sort, id').all()) {
    const parsed = parseJson(r.def, null);
    const def = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const key = typeof def.manifest === 'string' && def.manifest ? def.manifest : r.id;
    if (!rows.has(key)) rows.set(key, { def, active: r.active, exploring: r.exploring });
  }
  return rows;
}

// [{ pack, status, why }] sorted by pack id. A manifest pack with a linked packs_state row takes
// the row's live state (packStatus over the row's base status, active and exploring); one without
// keeps the status derived from the facts.
function loadPackView(ctx) {
  const { db } = ctx;
  const packs = loadPacks(ctx.packDirs ?? packDirsFor(ctx.dataDir));
  const rows = rowsByManifest(db);
  const views = activePacks(packs, getFacts(db));
  if (!rows.size) return views;
  const scope = tokenScope(db);
  return views.map(view => {
    const row = rows.get(view.pack.id);
    if (!row) return view;
    const live = { active: row.active == null ? null : Boolean(row.active), exploring: Boolean(row.exploring) };
    const base = typeof row.def.status === 'string' ? row.def.status : view.status;
    let why = view.why;
    if (live.active !== null) why = live.active ? 'Turned on by the owner.' : 'Turned off by the owner.';
    else if (typeof row.def.why === 'string' && row.def.why) why = resolveTokens(scope, row.def.why, false);
    return { pack: view.pack, status: packStatus(base, live), why };
  });
}

function countOf(haystack, term) {
  let n = 0;
  for (let i = haystack.indexOf(term); i >= 0; i = haystack.indexOf(term, i + term.length)) n++;
  return n;
}

// Up to SNIPPET chars of the body, whitespace collapsed, around the earliest term hit.
function snippetOf(body, terms) {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const hits = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(at - Math.floor(SNIPPET / 2), flat.length - SNIPPET));
  return flat.slice(start, start + SNIPPET).trim();
}

const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };

export const packTools = [
  {
    name: 'list_packs',
    description: 'Knowledge packs (sourced tax and planning guidance) with their status for this household (active, suggested, available), why, version, tax year, review date, coverage and entry titles.',
    inputSchema: noArgs,
    scope: 'read',
    handler(args, ctx) {
      return loadPackView(ctx).map(({ pack, status, why }) => ({
        id: pack.id,
        name: pack.name,
        status,
        why,
        version: pack.version,
        taxYear: pack.taxYear,
        reviewed: pack.reviewed,
        covers: [...pack.covers],
        entries: pack.entries.map(e => ({ file: e.file, title: e.title })),
      }));
    },
  },
  {
    name: 'get_pack_entry',
    description: 'One knowledge pack entry as markdown with its citations. `file` is the entry file from list_packs or its id (the file name without .md). Works for any pack, active or not.',
    inputSchema: {
      type: 'object',
      properties: {
        packId: { type: 'string', minLength: 1 },
        file: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['packId', 'file'],
      additionalProperties: false,
    },
    scope: 'read',
    handler(args, ctx) {
      const view = loadPackView(ctx).find(v => v.pack.id === args.packId);
      if (!view) throw new ToolError('not_found', `no pack ${args.packId}`);
      const { pack } = view;
      const entry = pack.entries.find(e => e.file === args.file) || pack.entries.find(e => e.id === args.file);
      if (!entry) throw new ToolError('not_found', `no entry ${args.file} in pack ${pack.id}`);
      return {
        packId: pack.id,
        packName: pack.name,
        file: entry.file,
        id: entry.id,
        title: entry.title,
        markdown: entry.body,
        citations: entry.cites.map(c => ({ label: c.label, url: c.url })),
        version: pack.version,
        taxYear: pack.taxYear,
        reviewed: pack.reviewed,
      };
    },
  },
  {
    name: 'search_pack_entries',
    description: 'Search the entries of active knowledge packs (optionally one pack) for every word of the query. Title hits weigh more than body hits. Returns at most `limit` results (default 10, max 20) with a short snippet, the total match count and whether the list was cut.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200 },
        packId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    scope: 'read',
    handler(args, ctx) {
      const terms = [...new Set(args.query.toLowerCase().match(/[a-z0-9]{2,}/g) || [])];
      if (!terms.length) throw new ToolError('bad_input', 'args.query needs a word of at least two letters or digits');
      const limit = args.limit === undefined ? SEARCH_DEFAULT : args.limit;
      const matches = [];
      for (const { pack, status } of loadPackView(ctx)) {
        if (status !== 'active' || (args.packId !== undefined && pack.id !== args.packId)) continue;
        for (const entry of pack.entries) {
          const title = entry.title.toLowerCase();
          const body = entry.body.toLowerCase();
          const text = `${title}\n${body}`;
          if (!terms.every(t => text.includes(t))) continue;
          const score = terms.reduce((n, t) => n + 5 * countOf(title, t) + countOf(body, t), 0);
          matches.push({ packId: pack.id, file: entry.file, id: entry.id, title: entry.title, score, snippet: snippetOf(entry.body, terms) });
        }
      }
      matches.sort((a, b) => b.score - a.score || compare(a.packId, b.packId) || compare(a.id, b.id));
      return { query: args.query, results: matches.slice(0, limit), total: matches.length, truncated: matches.length > limit };
    },
  },
];
