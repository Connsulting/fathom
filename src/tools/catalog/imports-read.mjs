import { listImportedFiles } from '../../ingest/freshness.mjs';
export const operations = [{
  tool: 'household', name: 'imports', scope: 'read', summary: 'Imported files with parser, counts and status, newest first.',
  route: 'List imported files and their status', routes: ['GET /api/files'], params: {}, required: [],
  handler: (args, ctx) => listImportedFiles(ctx.db),
}];
