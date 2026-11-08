import Anthropic from '@anthropic-ai/sdk';
import { createEngine, loadCredential, BudgetExceededError, ModelCallError } from '../engine/index.mjs';
import { createSpendLedger } from '../engine/runtime.mjs';
import { wireMessages, ANTHROPIC_BASE_URL } from '../engine/live.mjs';
import { PRICING, usageCostUsd } from '../engine/pricing.mjs';
import { DEMO_LIMIT_MESSAGE } from './control.mjs';

export class DemoLimitError extends BudgetExceededError {
  constructor() { super(); this.demoLimit = true; }
}

export async function publicDemoRound({ credential, system, systemDynamic, messages, tools, maxTokens, model, registry, onEvent }) {
  const client = new Anthropic({ apiKey: credential.value, authToken: null,
    baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, timeout: 30000 });
  const response = await client.messages.create({ model, max_tokens: maxTokens,
    system: `${system}\n${systemDynamic}`, messages: wireMessages(messages),
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) });
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      onEvent?.({ type: 'tool', name: block.name });
      await registry.invoke(block.name, block.input);
    } else if (block.type === 'text') onEvent?.({ type: 'text', text: block.text });
  }
  return { text: response.content.filter(b => b.type === 'text').map(b => b.text).join(''), content: response.content,
    tokens: response.usage, model, costUsd: usageCostUsd(model, response.usage), toolResults: registry.results,
    status: response.stop_reason === 'tool_use' ? 'error_max_turns' : 'success', details: {} };
}

export function createPublicDemoEngine({ db, config, control, visitorId }) {
  const limits = config.publicDemoLimits;
  let inner;
  let credentialState = 'none';
  let initPromise;
  const init = () => (initPromise ??= (async () => {
    let credential;
    if (config.engine === 'live') {
      try { credential = await loadCredential(config.claudeCredentialFile); credentialState = 'loaded'; }
      catch { credentialState = 'failed'; }
    }
    inner = createEngine({ mode: config.engine, credential, ledger: createSpendLedger(db), capUsd: Number.MAX_SAFE_INTEGER,
      modelOverride: limits.model, maxRounds: 2, streamDelayMs: config.fakeStreamMs,
      roundRunner: publicDemoRound,
      admitRound(request) {
        const definitions = request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        const input = Buffer.byteLength(JSON.stringify({ system: request.system, systemDynamic: request.systemDynamic,
          messages: request.messages, tools: definitions }), 'utf8') + 4096;
        const price = PRICING[limits.model].long || PRICING[limits.model];
        const usd = (input * price.input + request.maxTokens * price.output) / 1e6;
        if (input > limits.maxInputTokens || !control.reserveRound(visitorId, input + request.maxTokens, usd)) throw new DemoLimitError();
      },
    });
  })());
  return {
    mode: config.engine, init,
    get credentialState() { return credentialState; },
    isOn: () => config.engine !== 'off',
    async call(request) {
      await init();
      if (credentialState === 'failed') throw new ModelCallError('engine credential unavailable');
      return inner.call({ ...request, maxTokens: Math.min(request.maxTokens ?? limits.maxTokens, limits.maxTokens),
        tools: (request.tools || []).filter(tool => tool.kind === 'read') });
    },
    async extract() { throw new ModelCallError('File import is disabled in public demo mode'); },
  };
}

export function limitDemoAnswerer(answerer, control, visitorId, clientAddress) {
  const limit = fn => async request => {
    if (!control.reserveTurn(visitorId, clientAddress())) return { paragraphs: [DEMO_LIMIT_MESSAGE], refs: [], notice: true };
    const result = await fn(request);
    return result;
  };
  return { answer: limit(request => answerer.answer(request)), whatIf: limit(request => answerer.whatIf(request)) };
}
