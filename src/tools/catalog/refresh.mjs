import { sameStore } from '../../storage/index.mjs';
import { randomUUID } from 'node:crypto';
import { ingestFiles, retryFile, triggerPlan, triggerFreshness, triggerGuesses } from '../../ingest/pipeline.mjs';
import { pendingItems } from '../../ingest/confirm.mjs';
import { openVault } from '../../ingest/vault.mjs';
import { buildYourPlans } from '../../packs/your-plans.mjs';
import { refreshLivePacks } from '../../packs/live.mjs';
import { runManualJob, SCHEDULER_MESSAGE } from '../../jobs/scheduler.mjs';
import { requireActor, saveReceipt, receiptOut } from '../../actions/receipts.mjs';
import { getSetting } from '../../store/db.mjs';
import { ToolError } from '../errors.mjs';

const BODY_LIMIT = 1024 * 1024;
const jobs = ['plan', 'simplefin-sync', 'freshness', 'confirm-guess'];
const refusal = message => { throw new ToolError('bad_input', message); };
const undo = { available: false, reason: 'Refresh effects are managed where they land; this run cannot be undone.' };
const apiContext = ctx => ({ ...ctx.services, db: ctx.db, household: ctx.household ?? ctx.services?.household, params: {}, body: {} });
const fileOut = file => ({ ...file, id: file.fileId ?? file.id });

function content(args) {
  if ((args.text !== undefined) === (args.contentBase64 !== undefined)) refusal('Send exactly one of text or contentBase64.');
  if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'refresh', arguments: { operation: 'import_file', ...args } } })) > BODY_LIMIT) refusal('File content exceeds the request limit.');
  if (args.contentBase64 !== undefined && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.contentBase64))) refusal('contentBase64 must be valid base64.');
  const bytes = args.text !== undefined ? Buffer.from(args.text, 'utf8') : Buffer.from(args.contentBase64, 'base64');
  if (!bytes.length || bytes.length > BODY_LIMIT) refusal('File content must be nonempty and fit within the request limit.');
  return bytes;
}
async function preflight(name, args, ctx) {
  await requireActor(ctx);
  if (!ctx.services || !apiContext(ctx).household) refusal('Household services are unavailable.');
  if (!sameStore(apiContext(ctx).household.db, ctx.db)) refusal('Household services do not own this store.');
  if (name === 'import_file') content(args);
  if (name === 'retry_import' && !await ctx.db.prepare('SELECT id FROM files WHERE id=?').get(args.fileId)) throw new ToolError('not_found', 'No such file.');
  if (name === 'review_import' && !await ctx.db.prepare('SELECT id FROM import_proposals WHERE id=?').get(args.proposalId)) throw new ToolError('not_found', 'No such proposal.');
  if (name === 'run_job' && args.job === 'plan' && await getSetting(ctx.db, 'mode', null) === 'demo') refusal('planning runs on real stores only');
  if (ctx.channel === 'ask' && needsQueue(name, args) && typeof ctx.queueAfterTools !== 'function') refusal('This refresh needs the Ask round-end queue.');
}
const needsQueue = (name, args) => name === 'review_import' ? args.decision === 'correct' : name !== 'run_job' || ['plan', 'confirm-guess'].includes(args.job);
async function execute(name, args, ctx) {
  const api = apiContext(ctx);
  try {
    if (name === 'import_file' || name === 'retry_import') {
      await openVault(api.household);
      const opts = { ...ctx, household: api.household, mode: args.mode ?? 'retry', engine: api.engine, config: api.config, now: new Date(ctx.now ?? Date.now()).toISOString() };
      if (name === 'import_file' && args.text !== undefined) opts.capturedAt = opts.now;
      const file = name === 'import_file'
        ? (await ingestFiles(ctx.db, [{ name: args.name, mime: args.mime, bytes: content(args) }], opts)).results[0]
        : await retryFile(ctx.db, args.fileId, opts);
      if (file.status === 'imported') { triggerPlan(api); triggerFreshness(api); triggerGuesses(api); }
      return { file: fileOut(file), ...(name === 'import_file' ? { pending: (await pendingItems(ctx.db)).length } : {}) };
    }
    if (name === 'build_your_plans') {
      if (!await api.engine?.isOn()) refusal('The engine is off, so Your plans cannot be built. Switch it on first.');
      const result = await buildYourPlans({ db: ctx.db, engine: api.engine, household: api.household, fileIds: args.fileIds ?? [], clock: api.config?.clock });
      if (result.written) await refreshLivePacks(ctx.db, { dataDir: api.household.root });
      const { written, entries, sources, warnings, dropped } = result;
      return { status: 'built', written, entries, sources, warnings, dropped };
    }
    return { run: await runManualJob(ctx.db, api.scheduler, args.job) };
  } catch (e) {
    if (e.name === 'SchedulerError') throw new ToolError('bad_input', SCHEDULER_MESSAGE[e.code] ?? 'The job could not run.');
    if (e.name === 'VaultError' || e.name === 'YourPlansRefusal' || e.name === 'IngestError') throw new ToolError(e.status === 404 ? 'not_found' : 'bad_input', e.message);
    if (e.name === 'EngineOffError') refusal('The engine is off, so Your plans cannot be built. Switch it on first.');
    if (e.name === 'BudgetExceededError') refusal("This month's engine budget is used up, so Your plans cannot be built. Raise the cap first.");
    throw e;
  }
}
async function updateReceipt(ctx, id, outcome) {
  const value = JSON.stringify(outcome);
  await ctx.db.prepare('UPDATE action_receipts SET after_state=?, after_value=?, planning_pending=0 WHERE id=?').run(value, value, id);
  return receiptOut(await ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(id));
}
async function refresh(name, args, ctx) {
  await preflight(name, args, ctx);
  const { reviewImport, IMPORT_READING_MESSAGE } = await import('../../ingest/model-review.mjs');
  if (name === 'review_import') return reviewImport({ ...ctx, ...apiContext(ctx), actorId: ctx.actorId,
    ownerText: ctx.channel === 'mcp' ? args.evidence : ctx.ownerText }, args);
  const queued = ctx.channel === 'ask' && needsQueue(name, args);
  const initial = { status: queued ? 'queued' : 'running', operation: name };
  const receipt = await saveReceipt(ctx, { scope: name === 'run_job' ? 'write:jobs' : 'write:imports', kind: 'refresh', id: randomUUID(),
    label: 'Data refresh', before: null, after: initial });
  const run = async () => {
    try {
      const result = await execute(name, args, ctx);
      const outcome = { ...result, status: result.status ?? result.file?.status ?? result.run?.status ?? 'finished' };
      const audit = await updateReceipt(ctx, receipt.id, outcome);
      return { ...result, receipt: result.file?.receipt ?? audit, ...(result.file?.receipt ? {} : { undo }) };
    } catch (e) {
      await updateReceipt(ctx, receipt.id, { status: 'failed', operation: name, error: 'The refresh could not finish. Check the import or job status.' });
      if (!queued) throw e;
      return null;
    }
  };
  if (!queued) {
    const result = await run();
    ctx.onReceipt?.(result.receipt);
    return result;
  }
  await ctx.db.prepare('UPDATE action_receipts SET planning_pending=1 WHERE id=?').run(receipt.id);
  receipt.planningPending = true;
  ctx.queueAfterTools(run);
  ctx.onReceipt?.(receipt);
  const nameOut = name === 'import_file' ? args.name : name === 'retry_import' ? (await ctx.db.prepare('SELECT name FROM files WHERE id=?').get(args.fileId)).name : null;
  return { status: 'queued', ...(nameOut ? { name: nameOut, message: IMPORT_READING_MESSAGE } : {}), ...(name === 'run_job' ? { run: { id: receipt.id, status: 'queued' } } : {}), receipt, undo };
}
const string = { type: 'string', minLength: 1 };
const definitions = [
  ['import_file', 'write:imports', 'Import.', 'Import a file or pasted note', ['POST /api/files', 'POST /api/onboarding/notes'],
    { name: { ...string, maxLength: 200 }, mime: string, text: string, contentBase64: string }, ['name', 'mime']],
  ['retry_import', 'write:imports', 'Retry.', 'Retry an imported file', ['POST /api/files/:id/retry'], { fileId: string, mode: { type: 'string', enum: ['retry', 'reinterpret'] } }, ['fileId']],
  ['review_import', 'write:imports', 'Review.', 'Review an import proposal', ['POST /api/import-proposals/:proposalId/review'],
    { proposalId: string, version: { type: 'integer', minimum: 1 }, decision: { type: 'string', enum: ['approve', 'correct'] }, evidence: { ...string, maxLength: 4000 } }, ['proposalId', 'version', 'decision', 'evidence']],
  ['build_your_plans', 'write:imports', 'Build plans.', 'Rebuild the Your plans pack', ['POST /api/your-plans/build'],
    { fileIds: { type: 'array', items: { ...string, maxLength: 200 }, maxItems: 50 } }, []],
  ['run_job', 'write:jobs', 'Run.', 'Refresh data or recompute the plan', ['POST /api/jobs/:id/run'], { job: { type: 'string', enum: jobs } }, ['job']],
];
export const operations = definitions.map(([name, scope, summary, route, routes, params, required]) => ({
  tool: 'refresh', name, scope, summary, route, routes, params, required,
  preflight: async (args, ctx) => await preflight(name, args, ctx), handler: async (args, ctx) => refresh(name, args, ctx),
}));
