import { accountFreshness, freshnessOf } from '../../ingest/freshness.mjs';
import { categoryCoverage, loadCategoryInputs } from '../../categories/store.mjs';
import { pendingItems } from '../../ingest/confirm.mjs';
import { yearendChecklist, taxYearFor } from '../../yearend/expected.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { clockOf, plainDeep } from './figures.mjs';
import { accountIds, selectedAccounts, makeFigure, uniqueGaps, bounded } from './balances.mjs';
import { mapSeries } from '../../shared/series.mjs';

async function health(args, ctx) {
  const { db } = ctx, clock = await clockOf(ctx), refArgs = { operation: 'health', ...args };
  const scope = await tokenScope(db), naming = await accountNaming(db);
  const plain = value => plainDeep(scope, value);
  const gaps = [];
  const figure = (path, value, label, asOf, sources, unit = 'count', fgaps = []) => makeFigure('household', refArgs, path, value, unit, label, asOf,
    { calc: 'dataHealth', sources }, fgaps);
  const source = (table, ids) => [{ table, ids: ids.slice(0,50), count: ids.length }];
  const rows = await selectedAccounts(db, args.accounts);
  const accounts = await mapSeries(rows, async (a,i) => {
    const f = await accountFreshness(db, a.id, { clock });
    const kind = f.sourceId ? (await db.prepare('SELECT kind FROM sources WHERE id=?').get(f.sourceId))?.kind : null;
    const age = freshnessOf({ kind, asOf: f.asOf }, clock).ageDays;
    const label = a.parser === 'demo-seed' ? plain(naming.label(a)) : naming.label(a);
    const silent = !await db.prepare('SELECT 1 FROM transactions WHERE account_id=? LIMIT 1').get(a.id);
    if (f.fresh === 'stale') gaps.push({ code: 'stale_account', message: `${label} has stale data.` });
    if (silent) gaps.push({ code: 'account_no_history', message: `${label} has no transaction history.` });
    const ageGaps = age === null ? [{ code: 'missing_fact', message: `${label} has no dated feed for freshness.` }] : [];
    gaps.push(...ageGaps);
    return { id: a.id, label, mask: a.mask, kind: a.kind, lastData: f.asOf || null, freshness: f.fresh,
      ageDays: figure(`accounts.${i}.ageDays`, age, 'Age of account data', f.asOf || null, source('accounts',[a.id]), 'days', ageGaps), source: f.sourceId };
  });
  const coverage = await categoryCoverage(db, { clock, accountIds: args.accounts });
  const input = await loadCategoryInputs(db);
  if (args.accounts !== undefined) input.transactions = input.transactions.filter(t => args.accounts.includes(t.account_id));
  const cats = { rows: coverage.rows, uncategorized: coverage.uncategorized, guessed: coverage.layers.guess, corrected: coverage.layers.correction, queueSize: coverage.queueSize };
  const dataDate = input.transactions.map(t => t.date).sort().at(-1) || null;
  const categories = Object.fromEntries(Object.entries(cats).map(([key,value]) => [key, figure(`categories.${key}`, value, `Category ${key}`, dataDate, source('transactions',input.transactions.map(t => t.id)))]));
  if (cats.uncategorized) gaps.push({ code: 'uncategorized_rows', message: 'Some transactions have no category.', count: cats.uncategorized });
  if (cats.guessed) gaps.push({ code: 'guessed_rows', message: 'Some transaction categories are guesses.', count: cats.guessed });
  const pending = await pendingItems(db);
  const byKind = {};
  for (const kind of [...new Set(pending.map(p => p.kind))].sort()) {
    const items = pending.filter(p => p.kind === kind);
    byKind[kind] = figure(`pendingConfirm.byKind.${kind}`, items.length, 'Household pending confirmations', items.map(p => p.createdAt).filter(Boolean).sort().at(-1)?.slice(0,10) || null, source('confirm_items',items.map(p => p.id)));
  }
  const file = await db.prepare('SELECT id,name,uploaded_at,status FROM files WHERE stored_path IS NOT NULL ORDER BY uploaded_at DESC,rowid DESC LIMIT 1').get();
  const year = taxYearFor(clock), checklist = await yearendChecklist(db, { year, clock, plain });
  const jobs = await mapSeries((await db.prepare('SELECT id FROM jobs ORDER BY sort,id').all()), async j => {
    const run = await db.prepare('SELECT started_at,finished_at,status FROM job_runs WHERE job_id=? ORDER BY id DESC LIMIT 1').get(j.id);
    return { id: j.id, lastRun: run?.finished_at || run?.started_at || null, status: run?.status || null };
  });
  return { accounts, lastImport: file ? { fileId: file.id, name: file.name, at: file.uploaded_at, status: file.status } : null,
    categories, unavailableFiguresScope: 'household', unavailableFigures: (await db.prepare('SELECT key,label,unavailable_reason AS reason FROM figures WHERE unavailable_reason IS NOT NULL ORDER BY key').all()).map(f => ({ ...f, label: plain(f.label) })),
    pendingConfirm: { scope: 'household', total: figure('pendingConfirm.total', pending.length, 'Household pending confirmations', null, source('confirm_items',pending.map(p => p.id))), byKind },
    yearend: { year, items: checklist.items.map(i => ({ key: i.key, form: i.form, issuer: i.t, status: i.status === 'have' ? 'received' : i.status === 'skipped' ? 'marked' : 'missing' })) }, jobs, gaps: uniqueGaps(gaps) };
}

export const operations = [{ tool: 'household', name: 'health', scope: 'read', summary: 'Freshness, category coverage, missing figures, Confirm, year-end documents and jobs.',
  route: 'Freshness, uncategorized rows, missing history, expected tax documents', routes: ['GET /api/jobs'], params: { accounts: accountIds }, required: [], referenceable: true, handler: async (args,ctx) => bounded(await health(args,ctx)) }];
