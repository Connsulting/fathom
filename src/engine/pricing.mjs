export const DEFAULT_MODEL = 'claude-opus-5-5';

export const PRICING = Object.freeze({
  [DEFAULT_MODEL]: Object.freeze({ input: 4, output: 20, cacheRead: 0.20, cacheWrite5m: 5, cacheWrite1h: 8,
    unit: 'USD per million tokens', verifiedOn: '2026-11-05',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing' }),
});

export function usageCostUsd(model, usage) {
  const price = PRICING[model];
  if (!price) throw new TypeError('No verified pricing for this model');
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
  return Number(((tokens('input_tokens') * price.input + tokens('output_tokens') * price.output +
    tokens('cache_read_input_tokens') * price.cacheRead + (created - oneHour) * price.cacheWrite5m +
    oneHour * price.cacheWrite1h) / 1e6).toFixed(12));
}
