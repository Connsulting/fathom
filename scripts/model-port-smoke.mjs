import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { loadModelConfig } from '../src/models/config.mjs';
import { setAllocation, FUNDING_SETTING } from '../src/platform/model-budget.mjs';

const purposes = { ask: 'chat', title: 'title', categorize: 'categorize', import: 'extract' };
const adapter = process.env.FATHOM_SMOKE_ADAPTER;
const env = { ...process.env };
for (const purpose of Object.keys(purposes)) {
  const prefix = `FATHOM_MODEL_${purpose.toUpperCase()}_`;
  for (const [suffix, source] of [['ADAPTER', adapter], ['MODEL', env.FATHOM_SMOKE_MODEL], ['BASE_URL', env.FATHOM_SMOKE_BASE_URL],
    ['KEY_FILE', env.FATHOM_SMOKE_KEY_FILE], ['INPUT_USD_PER_MILLION', env.FATHOM_SMOKE_INPUT_USD_PER_MILLION], ['OUTPUT_USD_PER_MILLION', env.FATHOM_SMOKE_OUTPUT_USD_PER_MILLION]]) {
    if (source) env[`${prefix}${suffix}`] = source;
  }
}
let directory, instance;
try {
  const modelPorts = loadModelConfig(env);
  directory = await mkdtemp(join(tmpdir(), 'fathom-model-smoke-'));
  instance = await createInstance(directory, { mode: 'demo' });
  await instance.platform.prepare('INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,?)').run(FUNDING_SETTING, JSON.stringify(1), Date.now());
  await setAllocation(instance.platform, instance.householdId, 1);
  const engine = await createRuntimeEngine({ db: instance.db, platform: instance.platform, householdId: instance.householdId, generation: 1,
    config: { engine: 'live', modelPorts }, allowed: () => true, funded: () => true });
  for (const [label, purpose] of Object.entries(purposes)) {
    let input = 0, output = 0, pass = false;
    try {
      const result = await engine.call({ purpose, maxTokens: 256, budget: { maxCostUsd: .05, timeoutMs: 120000 },
        system: 'Follow the synthetic request exactly. Return only the requested JSON. Do not add explanations.',
        messages: [{ role: 'user', content: 'Return {"ok":true}.' }],
        ...(purpose === 'categorize' ? { choices: [{ state: { description: 'Synthetic grocery store' },
          instructions: 'Choose Groceries. Return confidence 0.9 and probabilities Groceries 0.9, Business 0.1.', options: ['Groceries', 'Business'] }] }
          : { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }),
      });
      input = result.accounting.tokens.input_tokens ?? 0; output = result.accounting.tokens.output_tokens ?? 0;
      pass = purpose === 'categorize' ? result.choices?.[0]?.choice === 'Groceries' : JSON.parse(result.text).ok === true;
    } catch (error) {
      input = error.accounting?.tokens?.input_tokens ?? 0; output = error.accounting?.tokens?.output_tokens ?? 0;
    }
    console.log(`${label} ${pass ? 'pass' : 'fail'} input_tokens=${input} output_tokens=${output}`);
    if (!pass) process.exitCode = 1;
  }
} catch {
  for (const label of Object.keys(purposes)) console.log(`${label} fail input_tokens=0 output_tokens=0`);
  process.exitCode = 1;
} finally {
  await instance?.db.close(); await instance?.platform.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
