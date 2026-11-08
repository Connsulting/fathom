// Verified model prices in USD per million tokens. A model with `longPrompt` charges its `long`
// row for every token of a request whose prompt (input plus cache read plus cache write tokens)
// is over `longPrompt` tokens, and its base row otherwise.
export const DEFAULT_MODEL = 'claude-opus-5-5';
// Thread titles (src/api/threads.mjs) run on the small model.
export const TITLE_MODEL = 'claude-haiku-5-5';

// The model each call purpose runs on; the one place the choice lives. src/engine/index.mjs and
// the Engine screen both read it.
export const MODEL_PURPOSES = Object.freeze(['chat', 'job', 'extract', 'title', 'confirm']);
export const modelFor = purpose => (purpose === 'title' ? TITLE_MODEL : DEFAULT_MODEL);

const SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export const PRICING = Object.freeze({
  [DEFAULT_MODEL]: Object.freeze({ input: 4, output: 20, cacheRead: 0.20, cacheWrite5m: 5, cacheWrite1h: 8,
    unit: 'USD per million tokens', verifiedOn: '2026-11-05', source: SOURCE }),
  [TITLE_MODEL]: Object.freeze({ input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.20,
    longPrompt: 100000,
    long: Object.freeze({ input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1.00 }),
    unit: 'USD per million tokens', verifiedOn: '2026-11-05', source: SOURCE }),
});

export function usageCostUsd(model, usage) {
  const base = PRICING[model];
  if (!base) throw new TypeError('No verified pricing for this model');
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) {
    throw new TypeError('Model usage is missing');
  }
  const tokens = key => {
    const value = usage[key] ?? 0;
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Invalid token count');
    return value;
  };
  const created = tokens('cache_creation_input_tokens');
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (!Number.isFinite(oneHour) || oneHour < 0 || oneHour > created) throw new TypeError('Invalid cache usage');
  const prompt = tokens('input_tokens') + tokens('cache_read_input_tokens') + created;
  const price = base.longPrompt != null && prompt > base.longPrompt ? base.long : base;
  return Number(((tokens('input_tokens') * price.input + tokens('output_tokens') * price.output +
    tokens('cache_read_input_tokens') * price.cacheRead + (created - oneHour) * price.cacheWrite5m +
    oneHour * price.cacheWrite1h) / 1e6).toFixed(12));
}

// The input-token ceiling reserved per page of a PDF document block. PDF support converts each
// page to an image and also extracts its text, so a page is billed as both; Anthropic documents
// typically 1,500 to 3,000 tokens per page, and page images are downscaled so one stays near 1,600
// tokens (https://docs.claude.com/en/docs/build-with-claude/pdf-support). 5000 is a conservative
// ceiling over both, so a compact multipage PDF is not bounded by its serialized bytes alone.
export const PDF_PAGE_INPUT_TOKENS = 5000;

// extraInputTokens (nonnegative integer, default 0): input tokens the serialized bytes do not
// account for (an image-only PDF's per-page bound), added to the reserved input tokens.
export function estimateUnknownCost({ model, maxTokens, system, messages, tools, schema, extraInputTokens = 0 }) {
  if (!Number.isInteger(extraInputTokens) || extraInputTokens < 0) throw new TypeError('Invalid extra input tokens');
  const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  // Reserve UTF-8 bytes as input tokens plus an SDK envelope, at the highest standard input rate.
  const inputTokens = Buffer.byteLength(JSON.stringify({ system, messages, tools: definitions, ...(schema ? { schema } : {}) }), 'utf8') + 4096 + extraInputTokens;
  const tokens = { input_tokens: 0, output_tokens: maxTokens, cache_creation_input_tokens: inputTokens,
    cache_creation: { ephemeral_1h_input_tokens: inputTokens } };
  return { costUsd: usageCostUsd(model, tokens), inputTokens, outputTokens: maxTokens };
}
