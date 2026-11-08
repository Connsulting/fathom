import { sdkRound, messagesRound, messagesToolRound } from '../engine/live.mjs';
import { estimateUnknownCost } from '../engine/pricing.mjs';
import { selectionFor } from './config.mjs';
import { createChatAdapter, choiceSchema, parseChoices } from './adapters/chat.mjs';
import { createJevAdapter } from './adapters/jev.mjs';

export const MODEL_ERROR_CODES = Object.freeze(['paused', 'funding_unavailable', 'budget', 'authentication',
  'rate_limit', 'timeout', 'unavailable', 'invalid_request', 'invalid_response', 'accounting',
  'household_unavailable', 'authorization_revoked', 'accounting_hold', 'accounting_unrecorded', 'round_limit']);

export function modelErrorCode(error) {
  if (MODEL_ERROR_CODES.includes(error?.code)) return error.code;
  return ({ EngineOffError: 'paused', BudgetExceededError: 'budget', RoundLimitError: 'round_limit',
    ModelAccountingError: 'accounting', TypeError: 'invalid_request' })[error?.name] ?? 'unavailable';
}

/** A completion port performs one response. The engine owns admission, tool continuations and
 * accounting around every complete invocation. Adapters never retry or dispatch tool continuations.
 * Request: messages, tools, schema or choices, maxTokens, budget, beforeDispatch.
 * Result: text/content, tokens, costUsd, toolResults, choices, and a fixed errorCode on refusal.
 */
export function createModelPort({ selection, transport, credential, purpose = 'chat', roundRunner = sdkRound, testTransport } = {}) {
  if (selection.adapter === 'openai' || selection.adapter === 'ollama') return createChatAdapter(selection, transport, credential);
  if (selection.adapter === 'jev') return createJevAdapter({ transport, credential });
  if (selection.adapter !== 'claude') throw new TypeError('Invalid model adapter');
  const runner = ['extract', 'confirm', 'title', 'categorize'].includes(purpose) ? messagesRound : testTransport ? messagesToolRound : roundRunner;
  const prepare = req => req.choices ? { ...req, schema: choiceSchema(req.choices),
    messages: [...req.messages, { role: 'user', content: JSON.stringify(req.choices) }] } : req;
  return { model: selection.model, credentialRequired: true,
    responseBound: runner === messagesRound || runner === messagesToolRound ? 1 : 2,
    estimate: req => estimateUnknownCost({ ...prepare(req), model: selection.model }),
    async complete(request) {
      const r = await runner({ ...prepare(request), model: selection.model, credential: credential ?? request.credential,
        ...(testTransport ? { baseURL: testTransport.baseURL } : {}) });
      if (r.api_error_status != null) r.errorCode = r.api_error_status === 429 ? 'rate_limit'
        : [401, 403].includes(r.api_error_status) ? 'authentication' : r.api_error_status >= 500 ? 'unavailable' : 'invalid_request';
      else if (r.status === 'error_max_budget_usd') r.errorCode = 'budget';
      else if (r.is_error && r.status !== 'error_max_turns') r.errorCode = 'unavailable';
      if (request.choices && r.status === 'success') {
        try { r.choices = parseChoices(r.text, request.choices); }
        catch { r.status = 'model_error'; r.is_error = true; r.errorCode = 'invalid_response'; }
      }
      return r;
    },
  };
}

export function estimateCompletion(request, modelConfig = {}) {
  const port = createModelPort({ selection: selectionFor(modelConfig, request.purpose), purpose: request.purpose });
  return { ...port.estimate(request), model: port.model, responseBound: port.responseBound };
}
