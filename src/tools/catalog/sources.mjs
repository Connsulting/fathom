import { archiveAccount, removeFile, mergeAccounts, SOURCES_SCOPE, CHANGED_SINCE } from '../../accounts/sources.mjs';
import { ConfirmError } from '../../ingest/confirm.mjs';
import { autoResolve } from '../../ingest/auto.mjs';
import { ToolError } from '../errors.mjs';

const id = { type: 'string', minLength: 1 };
// Figures read the store on the next scenario build; the plan reruns in the background.
const replan = (ctx, out) => { ctx.queuePlan?.(); return out; };

export const operations = [
  {
    tool: 'sources', name: 'archive_account', scope: SOURCES_SCOPE,
    summary: 'Archive an account (out of current balances, totals and Ask, history kept), or restore it with archived false.',
    route: 'Archive or restore an account', routes: ['POST /api/accounts/:id/archive'],
    params: { id, archived: { type: 'boolean' } }, required: ['id'],
    handler: (args, ctx) => replan(ctx, archiveAccount(ctx, args.id, args.archived ?? true)),
  },
  {
    tool: 'sources', name: 'remove_file', scope: SOURCES_SCOPE,
    summary: 'Remove an uploaded file: its rows are deleted and figures recompute.',
    route: 'Remove an imported file', routes: ['POST /api/files/:id/remove'],
    params: { id }, required: ['id'],
    handler: (args, ctx) => replan(ctx, removeFile(ctx, args.id)),
  },
  {
    tool: 'sources', name: 'merge_accounts', scope: SOURCES_SCOPE,
    summary: 'Merge two accounts that are the same account; the imported one keeps its history.',
    route: 'Merge duplicate accounts', routes: ['POST /api/accounts/:id/merge'],
    params: { id, withId: id }, required: ['id', 'withId'],
    handler(args, ctx) {
      let out;
      try { out = mergeAccounts(ctx, args.id, args.withId); } catch (e) {
        if (e instanceof ConfirmError) throw new ToolError('conflict', CHANGED_SINCE);
        throw e;
      }
      try { autoResolve(ctx.db, { now: new Date(ctx.now ?? Date.now()).toISOString() }); } catch { /* auto-resolution never fails the merge */ }
      return replan(ctx, { receipt: out.receipt, survivorId: out.survivorId, itemId: out.itemId });
    },
  },
];
