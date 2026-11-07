// MCP tool server for one authenticated request: the low-level SDK Server offering the registry
// tools a key's scopes allow. Arguments and results are never logged.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getTool, callTool, ToolError, operationScopes, instructions } from '../tools/index.mjs';
import { toolsForScopes } from './keys.mjs';

const SERVER_INFO = { name: 'fathom', version: '1.0.0' };

const errorResult = text => ({ isError: true, content: [{ type: 'text', text }] });

// A Server answering tools/list and tools/call for `scopes`, running tools with `ctx`.
export function createToolServer({ scopes, ctx }) {
  const offered = toolsForScopes(scopes);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offered.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.kind === 'read', destructiveHint: false, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
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
