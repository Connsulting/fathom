import { usageCostUsd } from '../src/engine/pricing.mjs';

// Eval admission is calibrated separately from fail-closed production accounting.
export function estimateEvalCost({ model, maxTokens, system, messages, tools }) {
  const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const bytes = Buffer.byteLength(JSON.stringify({ system, messages, tools: definitions }), 'utf8');
  const inputTokens = Math.ceil(bytes / 3) + 1024;
  const costUsd = usageCostUsd(model, { input_tokens: 0, output_tokens: maxTokens,
    cache_creation_input_tokens: inputTokens });
  return { costUsd, inputTokens, outputTokens: maxTokens };
}
