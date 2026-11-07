import { resolve } from 'node:path';
import { PRICING, TITLE_MODEL } from '../engine/pricing.mjs';

export function publicDemoConfig(env) {
  const flag = env.FATHOM_PUBLIC_DEMO;
  if (flag != null && flag !== '' && !['0', '1'].includes(flag)) throw new TypeError('FATHOM_PUBLIC_DEMO must be 1 or 0');
  if (flag !== '1') return { publicDemo: false };
  const refuse = detail => { throw new TypeError(`public demo: ${detail}`); };
  if (env.FATHOM_DEMO === '0') refuse('requires a synthetic demo store');
  for (const [name, value] of Object.entries(env)) {
    if (value == null || value === '') continue;
    if (/^FATHOM_(?:SIMPLEFIN|EMAIL|SMTP|MCP|BACKUP|PLATFORM|DATA_KEY)(?:_|$)/.test(name)
      && !(name === 'FATHOM_EMAIL_TRANSPORT' && value === 'dev')) refuse(`remove ${name}`);
  }
  const demoDataDir = resolve(env.FATHOM_PUBLIC_DEMO_DATA || 'demo-data');
  if (env.FATHOM_DATA && resolve(env.FATHOM_DATA) !== demoDataDir) refuse('FATHOM_DATA must name FATHOM_PUBLIC_DEMO_DATA');
  const integer = (suffix, fallback, max) => {
    const value = env[`FATHOM_PUBLIC_DEMO_${suffix}`];
    if (value == null || value === '') return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) refuse(`invalid ${suffix}`);
    return Number(value);
  };
  const usd = Number(env.FATHOM_PUBLIC_DEMO_USD_PER_DAY || '5');
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1000) refuse('invalid USD_PER_DAY');
  const model = env.FATHOM_PUBLIC_DEMO_MODEL || TITLE_MODEL;
  if (!Object.hasOwn(PRICING, model)) refuse('MODEL must have verified pricing');
  return {
    publicDemo: true,
    demoDataDir,
    publicDemoLimits: {
      turns: integer('TURNS_PER_DAY', 20, 1000), tokens: integer('TOKENS_PER_DAY', 500000, 10000000),
      calls: integer('CALLS_PER_DAY', 200, 100000), usd,
      maxTokens: integer('MAX_TOKENS', 512, 2048), maxInputTokens: integer('MAX_INPUT_TOKENS', 262144, 1048576),
      requests: integer('REQUESTS_PER_MINUTE', 120, 10000),
      ipTurns: integer('TURNS_PER_IP_PER_DAY', 40, 10000),
      creations: integer('CREATIONS_PER_IP_PER_DAY', 5, 100),
      sandboxes: integer('SANDBOXES', 50, 200), ttl: integer('TTL_SECONDS', 86400, 604800), model,
    },
  };
}
