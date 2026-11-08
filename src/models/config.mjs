import { DEFAULT_MODEL, TITLE_MODEL, PRICING } from '../engine/pricing.mjs';

export const MODEL_PURPOSES = Object.freeze(['ask', 'title', 'categorize', 'import']);
const ADAPTERS = ['claude', 'jev', 'openai', 'ollama'];
const purposeOf = p => ({ chat: 'ask', job: 'ask', confirm: 'import', extract: 'import' })[p] ?? p;
const defaults = p => ({ adapter: p === 'categorize' ? 'jev' : 'claude',
  model: p === 'categorize' ? 'jev-1.14.0' : p === 'title' ? TITLE_MODEL : DEFAULT_MODEL });

export function selectionFor(config = {}, purpose) {
  const key = purposeOf(purpose);
  if (!MODEL_PURPOSES.includes(key)) throw new TypeError('Invalid model purpose');
  const configured = config[key] ?? {};
  const adapter = configured.adapter ?? defaults(key).adapter;
  if (!ADAPTERS.includes(adapter) || adapter === 'jev' && key !== 'categorize') throw new TypeError('Invalid model adapter');
  return { ...defaults(key), model: adapter === 'jev' ? 'jev-1.14.0' : key === 'title' ? TITLE_MODEL : DEFAULT_MODEL, ...configured, adapter };
}

export function loadModelConfig(env = process.env) {
  return Object.fromEntries(MODEL_PURPOSES.map(purpose => {
    const prefix = `FATHOM_MODEL_${purpose.toUpperCase()}_`;
    const adapter = env[`${prefix}ADAPTER`] || defaults(purpose).adapter;
    if (!ADAPTERS.includes(adapter) || (adapter === 'jev' && purpose !== 'categorize')) throw new TypeError('Invalid model adapter');
    const custom = adapter === 'openai' || adapter === 'ollama';
    const model = env[`${prefix}MODEL`] || (custom ? null : adapter === 'jev' ? 'jev-1.14.0' : purpose === 'title' ? TITLE_MODEL : DEFAULT_MODEL);
    const baseUrl = env[`${prefix}BASE_URL`] || null;
    if (adapter === 'jev' && model !== 'jev-1.14.0') throw new TypeError('Invalid choice model');
    if (!model || (custom && !baseUrl)) throw new TypeError('Model and base URL are required');
    if (adapter === 'claude' && !PRICING[model]) throw new TypeError('No verified model pricing');
    if (baseUrl && !custom) throw new TypeError('This adapter has a fixed endpoint');
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid model base URL');
    }
    const rates = {};
    for (const [suffix, key] of [['INPUT_USD_PER_MILLION', 'inputUsdPerMillion'], ['OUTPUT_USD_PER_MILLION', 'outputUsdPerMillion']]) {
      const value = env[`${prefix}${suffix}`];
      if (custom && adapter !== 'ollama' && (value == null || value === '')) throw new TypeError('Model pricing is required');
      if (value != null && value !== '') {
        rates[key] = Number(value);
        if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new TypeError('Invalid model pricing');
      } else if (adapter === 'ollama') rates[key] = 0;
    }
    return [purpose, { adapter, model, ...(baseUrl ? { baseUrl } : {}), ...rates,
      keyFile: env[`${prefix}KEY_FILE`] || null }];
  }));
}
