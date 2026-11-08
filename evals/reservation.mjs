import { estimateUnknownCost } from '../src/engine/pricing.mjs';
import { SDK_RESPONSE_BOUND } from '../src/engine/index.mjs';

export function estimateEvalCost(request) {
  const estimate = estimateUnknownCost(request);
  // Ask uses the SDK runner, whose retries can bill multiple responses in one round.
  return { ...estimate, costUsd: Number((estimate.costUsd * SDK_RESPONSE_BOUND).toFixed(12)) };
}
