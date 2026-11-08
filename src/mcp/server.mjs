// MCP tool server for one authenticated request: the low-level SDK Server offering the registry
// tools a key's scopes allow. Arguments and results are never logged.

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getTool, callTool, ToolError, operationScopes, instructions } from '../tools/index.mjs';
import { toolsForScopes } from './keys.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// The version a client sees: the git SHA of the build (FATHOM_BUILD_SHA, passed in when the image is
// built), else the package version.
export const serverVersion = (env = process.env) => String(env.FATHOM_BUILD_SHA ?? '').trim() || PACKAGE_VERSION;
export const serverInfo = (env = process.env) => ({ name: 'fathom', version: serverVersion(env) });

const errorResult = text => ({ isError: true, content: [{ type: 'text', text }] });

// A Server answering tools/list and tools/call for `scopes`, running tools with `ctx`.
export function createToolServer({ scopes, ctx, authorize }) {
  if (typeof authorize !== 'function') throw new TypeError('createToolServer needs authorization');
  const offered = toolsForScopes(scopes);
  const server = new Server(serverInfo(), { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!authorize()) throw new ToolError('forbidden', 'Key authorization is no longer available');
    return { tools: offered.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.kind === 'read', destructiveHint: false, openWorldHint: false },
    })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!authorize()) return errorResult('Key authorization is no longer available');
    const { name } = request.params;
    const tool = getTool(name);
    if (!tool) return errorResult(`no tool ${name}`);
    const operation = request.params.arguments?.operation;
    const op = tool.operations.find(o => o.name === operation);
    if (op && !operationScopes(op).some(scope => scopes.includes(scope))) {
      const needed = op.scope ? `the ${op.scope} scope` : 'a write scope';
      return errorResult(`Permission denied: ${name}.${operation} needs ${needed}, which this key does not have.`);
    }
    try {
      const result = await callTool(name, request.params.arguments ?? {}, { ...ctx, scopes });
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      console.error(`mcp: tool ${name} failed (${err && err.name ? err.name : 'Error'})`);
      return errorResult('Tool execution failed');
    }
  });

  return server;
}
