import { accountLabel } from '../../shared/account-label.mjs';
import { envelope } from '../../calc/figure.mjs';
import { accountFreshness, freshnessOf, householdDataThrough } from '../../ingest/freshness.mjs';
import { categoryCoverage } from '../../categories/store.mjs';
import { pendingItems } from '../../ingest/confirm.mjs';
import { yearendChecklist } from '../../yearend/expected.mjs';
import { planningYear } from '../../jobs/planner/data.mjs';
import { ToolError } from '../errors.mjs';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const STATUS = { have: 'received', skipped: 'marked' };

function clockOf(ctx) {
  const raw = ctx.clock || null;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = ctx.now == null ? new Date() : new Date(ctx.now);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function countFigure(value, label, path, args, asOf, gaps) {
  return envelope(value, {
    unit: 'count', label, kind: 'a', asOf,
    ref: { tool: 'data_health', args, path },
    provenance: { calc: 'data_health', formula: label, inputs: [], sources: [] },
    gaps,
  });
}

function dedupe(gaps) {
  const seen = new Set();
  const out = [];
  for (const gap of gaps) {
    const key = `${gap.code}\n${gap.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

export const tools = [
  {
    name: 'data_health',
    description: 'Report whether household data is complete and current: per-account freshness, the last import, category coverage, unavailable figures, pending Confirm items and the year-end document checklist.',
    inputSchema: obj({
      accounts: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 } },
    }),
    scope: 'read',
    handler(args, ctx) {
      const clock = clockOf(ctx);
      const requested = args.accounts;
      const rows = ctx.db.prepare('SELECT * FROM accounts ORDER BY id').all()
        .filter(row => !requested || requested.includes(row.id));
      if (requested && rows.length !== requested.length) throw new ToolError('bad_input', 'unknown account id');
      const asOf = householdDataThrough(ctx.db, clock);
      const coverage = categoryCoverage(ctx.db);
      const pending = pendingItems(ctx.db);
      const byKind = {};
      for (const item of pending) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      const year = planningYear(clock) ?? Number(clock.slice(0, 4));
      const checklist = yearendChecklist(ctx.db, { year, clock });
      const gaps = [];
      const accounts = rows.map(row => {
        const fresh = accountFreshness(ctx.db, row.id, { clock });
        const source = fresh.sourceId
          ? ctx.db.prepare('SELECT kind FROM sources WHERE id = ?').get(fresh.sourceId)
          : null;
        const age = fresh.asOf && source?.kind ? freshnessOf({ kind: source.kind, asOf: fresh.asOf }, clock) : null;
        if (!fresh.asOf) gaps.push({ code: 'account_no_history', message: 'An account has no stored rows', count: 1 });
        else if (fresh.fresh === 'stale') gaps.push({ code: 'stale_account', message: 'An account is past its freshness window', count: 1 });
        return {
          id: row.id,
          label: accountLabel(row),
          mask: row.mask,
          kind: row.kind,
          lastData: fresh.asOf,
          freshness: fresh.fresh,
          ageDays: age ? age.ageDays : null,
          source: fresh.sourceId,
        };
      });
      if (coverage.uncategorized) gaps.push({ code: 'uncategorized_rows', message: 'Some rows have no category', count: coverage.uncategorized });
      if (coverage.layers.guess) gaps.push({ code: 'guessed_rows', message: 'Some rows are only guessed', count: coverage.layers.guess });
      const categoryGaps = code => gaps.filter(g => g.code === code);
      const file = ctx.db.prepare(`SELECT id, name, status, uploaded_at FROM files
                                   ORDER BY uploaded_at DESC, rowid DESC LIMIT 1`).get();
      const unavailableFigures = ctx.db.prepare(`SELECT key, label, unavailable_reason AS reason FROM figures
                                                 WHERE unavailable_reason IS NOT NULL AND unavailable_reason != ''
                                                 ORDER BY key`).all();
      return {
        accounts,
        lastImport: file ? { fileId: file.id, name: file.name, at: file.uploaded_at, status: file.status } : null,
        categories: {
          rows: countFigure(coverage.rows, 'Categorized rows', 'categories.rows', args, asOf, []),
          uncategorized: countFigure(coverage.uncategorized, 'Uncategorized rows', 'categories.uncategorized', args, asOf, categoryGaps('uncategorized_rows')),
          guessed: countFigure(coverage.layers.guess, 'Guessed rows', 'categories.guessed', args, asOf, categoryGaps('guessed_rows')),
          corrected: countFigure(coverage.layers.correction, 'Corrected rows', 'categories.corrected', args, asOf, []),
          queueSize: countFigure(coverage.queueSize, 'Category check queue', 'categories.queueSize', args, asOf, []),
        },
        unavailableFigures,
        pendingConfirm: { total: pending.length, byKind },
        yearend: {
          year: checklist.year,
          items: checklist.items.map(item => ({
            key: item.key,
            form: item.form,
            issuer: item.files[0]?.issuer || '',
            status: STATUS[item.status] || item.status,
          })),
        },
        gaps: dedupe(gaps),
      };
    },
  },
];

export const parity = {};
