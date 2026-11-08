import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { redactTaxIdentifiers, redactProviderText } from '../ingest/redact.mjs';
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
  if (ctx?.conversationKey && ctx.actorId && typeof ctx.db?.prepare === 'function') {
    ctx = { ...ctx, evidenceMessageId: ctx.db.prepare('SELECT coalesce(max(id), 0) AS id FROM messages WHERE conversation_key = ?').get(ctx.conversationKey).id };
  }
  const results = [];
  const reject = (name, args, error) => {
    results.push({ name, args: structuredClone(args), isError: true, result: { error } });
    return { isError: true, content: [{ type: 'text', text: redactTaxIdentifiers(error) }] };
  };
  const invoke = async (name, args) => {
    const found = offered.find(item => item.entry.name === name);
    if (!found) return reject(name, args, 'Tool is not available for this request.');
    if (!found.validate(args)) {
      const error = found.validate.errors.map(e => {
        const path = 'args' + e.instancePath.replaceAll('/', '.')
          + (e.params.missingProperty ? `.${e.params.missingProperty}` : '')
          + (e.params.additionalProperty ? `.${e.params.additionalProperty}` : '');
        const reason = e.keyword === 'enum' ? `must be one of ${e.params.allowedValues.join(', ')}`
          : e.keyword === 'additionalProperties' ? 'is not a known argument' : e.message;
        return `${path} ${reason}`;
      }).join('; ');
      return reject(name, args, `${name}.${args?.operation ?? '(missing operation)'}: bad_input: ${error}`);
    }
    try {
      const result = await found.entry.handler(args, ctx);
      const text = JSON.stringify(result ?? null);
      results.push({ name, args: structuredClone(args), result: JSON.parse(text) });
      return { content: [{ type: 'text', text: JSON.stringify(redactProviderText(JSON.parse(text))) }] };
    } catch (err) {
      return reject(name, args, err?.name === 'ToolError' || err?.name === 'FactAnswerError' ? err.message : 'Tool execution failed');
    }
  };
  const instance = new McpServer({ name: 'fathom', version: '1.0.0' });
  instance.server.registerCapabilities({ tools: {} });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: offered.map(({ entry }) => redactProviderText({
    name: entry.name, description: entry.description, inputSchema: entry.inputSchema,
    annotations: { readOnlyHint: entry.kind === 'read', destructiveHint: false, openWorldHint: false },
  })) }));
  instance.server.setRequestHandler(CallToolRequestSchema, request => invoke(request.params.name, request.params.arguments ?? {}));
  return { type: 'sdk', name: 'fathom', instance, results, invoke, names: offered.map(item => item.entry.name) };
}
