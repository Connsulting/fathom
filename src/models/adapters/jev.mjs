export const JEV_MODEL = 'jev-1.14.0';
export const JEV_INPUT_USD = .042 / 1_000_000;
const probability = n => Number.isFinite(n) && n >= 0 && n <= 1;

export function jevBody(choices) {
  return { model: JEV_MODEL, state: Object.fromEntries(choices.map((q, i) => [`q${i}`, q.state])),
    questions: Object.fromEntries(choices.map((q, i) => [`q${i}`, { type: 'choice', instructions: `For state.q${i} only: ${q.instructions}`,
      criteria: Object.fromEntries(q.options.map(o => [o, o])) }])) };
}
export const jevEstimate = choices => Buffer.byteLength(JSON.stringify(jevBody(choices))) + 1024 * choices.length + 4096;

export function jevAnswers(data, choices) {
  if (data?.model !== JEV_MODEL || !data.answers || Object.keys(data.answers).length !== choices.length) throw new TypeError('Invalid choice response');
  return choices.map((q, i) => {
    const a = data.answers[`q${i}`], probs = a?.probabilities;
    if (a?.type !== 'choice' || !q.options.includes(a.choice) || !probability(a.confidence)
      || !probs || Object.keys(probs).length !== q.options.length || !q.options.every(o => probability(probs[o]))
      || Math.abs(Object.values(probs).reduce((s, p) => s + p, 0) - 1) > .02
      || q.options.some(o => probs[o] > probs[a.choice])) throw new TypeError('Invalid choice response');
    return { choice: a.choice, confidence: a.confidence, probabilities: probs };
  });
}

export function createJevAdapter({ transport = fetch, credential } = {}) {
  return { model: JEV_MODEL, responseBound: 1, credentialRequired: true,
    estimate({ choices }) {
      const inputTokens = jevEstimate(choices);
      return { inputTokens, outputTokens: 0, costUsd: inputTokens * JEV_INPUT_USD };
    },
    async complete({ choices, credential: auth = credential, timeoutMs = 10000, tools = [], schema }) {
      const base = { model: JEV_MODEL, content: [], text: '', tokens: {}, toolResults: [], details: {} };
      if (tools.length || schema) return { ...base, status: 'model_error', is_error: true, errorCode: 'invalid_request', costUsd: 0 };
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { name: 'TimeoutError' })); }, timeoutMs); });
        return await Promise.race([(async () => {
          const response = await transport('https://api.typesafe.ai/v1/systemone', { method: 'POST',
            headers: { Authorization: `Bearer ${auth.value}`, 'Content-Type': 'application/json' }, body: JSON.stringify(jevBody(choices)), signal: controller.signal });
          if (!response.ok) return { ...base, status: 'model_error', is_error: true, costUsd: 0, httpStatus: response.status,
            retryAfterMs: Math.min(10000, Math.max(0, Number(response.headers?.get('retry-after')) * 1000 || 0)),
            errorCode: response.status === 429 ? 'rate_limit' : response.status === 401 || response.status === 403 ? 'authentication'
              : response.status >= 500 ? 'unavailable' : 'invalid_request' };
          const data = await response.json();
          const input = data?.usage?.input_tokens, output = data?.usage?.output_tokens;
          const accounted = Number.isSafeInteger(input) && input >= 0 && input <= jevEstimate(choices) && Number.isSafeInteger(output) && output >= 0;
          const round = { ...base, data, tokens: { input_tokens: input, output_tokens: output },
            costUsd: accounted ? input * JEV_INPUT_USD : undefined, accountingUnknown: !accounted };
          if (!accounted) return { ...round, status: 'model_error', is_error: true, errorCode: 'accounting' };
          try {
            const answers = jevAnswers(data, choices);
            return { ...round, choices: answers, text: JSON.stringify(answers), content: [{ type: 'text', text: JSON.stringify(answers) }], status: 'success' };
          } catch { return { ...round, status: 'model_error', is_error: true, errorCode: 'invalid_response' }; }
        })(), timeout]);
      } catch (error) {
        return { ...base, status: 'model_error', is_error: true, errorCode: error?.name === 'TimeoutError' ? 'timeout' : 'unavailable', accountingUnknown: true };
      } finally { clearTimeout(timer); }
    },
  };
}
