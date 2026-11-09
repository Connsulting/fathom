import { listImportedFiles } from '../../ingest/freshness.mjs';
export const operations = [{
  tool: 'household', name: 'imports', scope: 'read', summary: 'Import status and receipts.',
  route: 'List imported files and their status', routes: ['GET /api/files'], params: {}, required: [],
  handler: async (args, ctx) => await listImportedFiles(ctx.db),
}];
