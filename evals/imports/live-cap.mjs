import { FILE_LIMITS } from '../../src/ingest/model-parse.mjs';
import { estimateCompletion } from '../../src/models/port.mjs';

export function admitLive({ authorized, credentials, funded, maxCostUsd, maxCalls } = {}) {
  if (authorized !== true || credentials !== true || funded !== true) throw new Error('live_admission_required');
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 5 || !Number.isInteger(maxCalls) || maxCalls <= 0 || maxCalls > 24) throw new Error('live_caps_required');
}
const round = value => Number(value.toFixed(12));
export function cappedEngine(engine, options, estimate = request => estimateCompletion(request, engine.modelConfig)) {
  admitLive(options);
  const files = new Map(), models = new Map();
  const state = { calls: 0, failedCalls: 0, costUsd: 0, actualCostUsd: 0, estimatedCostUsd: 0, stopReason: null };
  const stop = reason => { state.stopReason = reason; throw new Error('evaluation_cap'); };
  return { ...engine,
    report: () => ({ ...state, models: Object.fromEntries(models) }),
    async call(request) {
      if (state.stopReason) throw new Error('evaluation_cap');
      if (state.calls >= options.maxCalls) stop('call_cap');
      const bound = estimate(request), fileId = /^import:([^:]+):/.exec(request.budget?.correlationId ?? '')?.[1];
      if (!fileId || !Number.isFinite(bound.costUsd) || bound.costUsd < 0 || !Number.isInteger(bound.inputTokens) || bound.inputTokens < 0 || !bound.model) throw new Error('invalid_estimate');
      const file = files.get(fileId) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > FILE_LIMITS.outputPerCall || file.calls >= FILE_LIMITS.calls ||
        round(file.costUsd + bound.costUsd) > FILE_LIMITS.costUsd || file.inputTokens + bound.inputTokens > FILE_LIMITS.inputTokens || file.outputTokens + request.maxTokens > FILE_LIMITS.outputTokens) throw new Error('file_cap');
      if (round(state.costUsd + bound.costUsd) > options.maxCostUsd) stop('cost_cap');
      const allowance = Math.min(request.budget.maxCostUsd, options.maxCostUsd - state.costUsd, FILE_LIMITS.costUsd - file.costUsd, bound.costUsd);
      if (!Number.isFinite(allowance) || allowance < bound.costUsd) stop('cost_cap');
      state.calls++; file.calls++; files.set(fileId, file);
      let accounting, failed = false;
      try {
        const result = await engine.call({ ...request, budget: { ...request.budget, maxCostUsd: allowance } });
        accounting = result.accounting;
        return result;
      } catch (error) { failed = true; accounting = error.accounting; throw error; }
      finally {
        const known = accounting?.estimated !== true && Number.isFinite(accounting?.costUsd) && accounting.costUsd >= 0;
        const cost = known ? accounting.costUsd : Math.max(bound.costUsd, Number.isFinite(accounting?.costUsd) ? accounting.costUsd : 0);
        const tokens = accounting?.tokens ?? {};
        const input = [tokens.input_tokens, tokens.cache_read_input_tokens, tokens.cache_creation_input_tokens].reduce((n, v) => n + (v ?? 0), 0);
        const usageKnown = known && Number.isInteger(input) && input >= 0 && Number.isInteger(tokens.output_tokens) && tokens.output_tokens >= 0;
        const inputTokens = usageKnown ? input : bound.inputTokens, outputTokens = usageKnown ? tokens.output_tokens : request.maxTokens;
        state.costUsd = round(state.costUsd + cost); state[known ? 'actualCostUsd' : 'estimatedCostUsd'] = round(state[known ? 'actualCostUsd' : 'estimatedCostUsd'] + cost);
        file.costUsd = round(file.costUsd + cost); file.inputTokens += inputTokens; file.outputTokens += outputTokens;
        if (failed) state.failedCalls++;
        const model = bound.model, total = models.get(model) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        total.calls++; total.costUsd = round(total.costUsd + cost); total.inputTokens += inputTokens; total.outputTokens += outputTokens; models.set(model, total);
        if (cost > bound.costUsd || file.costUsd > FILE_LIMITS.costUsd || file.inputTokens > FILE_LIMITS.inputTokens || file.outputTokens > FILE_LIMITS.outputTokens) {
          state.stopReason = 'accounting_exceeded';
          if (!failed) throw new Error('accounting_exceeded');
        }
        if (state.costUsd >= options.maxCostUsd) state.stopReason = 'cost_cap';
        else if (state.calls >= options.maxCalls) state.stopReason = 'call_cap';
      }
    },
  };
}
