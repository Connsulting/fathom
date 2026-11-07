import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compileSchema } from './schema.mjs';
import { operationScopes } from '../tools/tools.mjs';
import { WRITE_SCOPES } from '../shared/action-scopes.mjs';

export function createRegistryServer(registry = [], { purpose, ctx } = {}) {
  if (!Array.isArray(registry)) throw new TypeError('Tool registry must be an array');
  const names = new Set();
  const offered = [];
  for (const entry of registry) {
    if (!entry || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name) || names.has(entry.name) ||
      !['read', 'write'].includes(entry.kind) || !Array.isArray(entry.operations) || entry.operations.some(o => operationScopes(o).some(s => !['read', ...WRITE_SCOPES].includes(s))) || typeof entry.description !== 'string' || typeof entry.handler !== 'function') {
      throw new TypeError('Invalid tool registry entry');
    }
    names.add(entry.name);
    if (purpose === 'extract' || purpose === 'confirm' || (entry.kind !== 'read' && purpose !== 'chat') || entry.mcpOnly) continue;
    offered.push({ entry, validate: compileSchema(entry.inputSchema) });
  }
  offered.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  const results = [];
  const invoke = async (name, args) => {
    const found = offered.find(item => item.entry.name === name);
    if (!found) {
      results.push({ name, args: structuredClone(args), isError: true, result: { error: 'Tool name or arguments rejected' } });
      return { isError: true, content: [{ type: 'text', text: 'Tool name or arguments rejected' }] };
    }
    if (!found.validate(args)) {
      const text = `${name}.${args?.operation ?? '(missing operation)'}: bad_input: arguments rejected`;
      results.push({ name, args: structuredClone(args), isError: true, result: { error: text } });
      return { isError: true, content: [{ type: 'text', text }] };
    }
    try {
      const result = await found.entry.handler(args, ctx);
      const text = JSON.stringify(result ?? null);
      results.push({ name, args: structuredClone(args), result: JSON.parse(text) });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      results.push({ name, args: structuredClone(args), isError: true, result: null });
      return { isError: true, content: [{ type: 'text', text: err?.name === 'ToolError' || err?.name === 'FactAnswerError' ? err.message : 'Tool execution failed' }] };
    }
  };
  const instance = new McpServer({ name: 'fathom', version: '1.0.0' });
  instance.server.registerCapabilities({ tools: {} });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: offered.map(({ entry }) => ({
    name: entry.name, description: entry.description, inputSchema: entry.inputSchema,
    annotations: { readOnlyHint: entry.kind === 'read', destructiveHint: false, openWorldHint: false },
  })) }));
  instance.server.setRequestHandler(CallToolRequestSchema, request => invoke(request.params.name, request.params.arguments ?? {}));
  return { type: 'sdk', name: 'fathom', instance, results, invoke, names: offered.map(item => item.entry.name) };
}
