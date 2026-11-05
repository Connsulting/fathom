// Knowledge pack tools: list_packs, get_pack_entry, search_pack_entries. All read scope.
// Packs load from ctx.packDirs, else the repo packs/ plus `<ctx.dataDir>/packs/your-plans` when it
// exists. Status comes from the stored facts, with a packs_state row whose `active` is set
// overriding it (1 active, 0 available).
//
// Load this module through ./index.mjs only: it imports ToolError from there, and index.mjs
// spreads `packTools` into the registry at load time.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, activePacks } from '../packs/index.mjs';
import { parseJson } from '../store/db.mjs';
import { ToolError } from './index.mjs';

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

// [{ pack, status, why }] sorted by pack id.
function loadPackView(ctx) {
  const packs = loadPacks(ctx.packDirs ?? packDirsFor(ctx.dataDir));
  const facts = Object.fromEntries(ctx.db.prepare('SELECT key, value FROM facts').all().map(f => [f.key, parseJson(f.value, f.value)]));
  const overrides = new Map(ctx.db.prepare('SELECT id, active FROM packs_state WHERE active IS NOT NULL').all().map(r => [r.id, r.active]));
  return activePacks(packs, facts).map(view => {
    if (!overrides.has(view.pack.id)) return view;
    const on = Boolean(overrides.get(view.pack.id));
    return { pack: view.pack, status: on ? 'active' : 'available', why: on ? 'Turned on by the owner.' : 'Turned off by the owner.' };
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
