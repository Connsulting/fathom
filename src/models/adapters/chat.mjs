import { compileSchema } from '../../engine/schema.mjs';

const statusCode = status => status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit'
  : status >= 500 ? 'unavailable' : 'invalid_request';
const count = n => Number.isSafeInteger(n) && n >= 0;
const failure = (model, errorCode, costUsd, tokens = {}) => ({ text: '', content: [], model, errorCode, tokens,
  costUsd, accountingUnknown: costUsd === undefined, status: 'model_error', is_error: true, details: {}, toolResults: [] });

export function chatMessages(messages) {
  return messages.flatMap((message, index) => {
    if (message.role === 'tool') {
      const uses = messages[index - 1]?.content?.filter(b => b.type === 'tool_use') ?? [];
      return uses.map((use, i) => ({ role: 'tool', tool_call_id: use.id, tool_name: use.name,
        content: JSON.stringify(message.content[i]?.result ?? null) }));
    }
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
    const blocks = message.content ?? [];
    if (blocks.some(b => b.type === 'document' && b.source?.type !== 'text')) throw new TypeError('This adapter accepts text documents only');
    const text = blocks.filter(b => b.type === 'text' || b.type === 'document').map(b => b.text ?? b.source.data).join('\n');
    const uses = blocks.filter(b => b.type === 'tool_use');
    return [{ role: message.role, content: text, ...(uses.length ? { tool_calls: uses.map(b => ({ id: b.id, type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) } })) } : {}) }];
  });
}

export function choiceSchema(choices) {
  return { type: 'object', properties: Object.fromEntries(choices.map((q, i) => [`q${i}`, { type: 'object',
    properties: { choice: { type: 'string', enum: q.options }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      probabilities: { type: 'object', properties: Object.fromEntries(q.options.map(o => [o, { type: 'number', minimum: 0, maximum: 1 }])), required: q.options, additionalProperties: false } },
    required: ['choice', 'confidence', 'probabilities'], additionalProperties: false }])), required: choices.map((_, i) => `q${i}`), additionalProperties: false };
}

export function parseChoices(text, choices) {
  const parsed = JSON.parse(text);
  if (!compileSchema(choiceSchema(choices))(parsed)) throw new TypeError('Invalid choices');
  return choices.map((q, i) => {
    const a = parsed[`q${i}`];
    const probabilities = Object.values(a.probabilities);
    if (Math.abs(probabilities.reduce((s, p) => s + p, 0) - 1) > .02 || q.options.some(o => a.probabilities[o] > a.probabilities[a.choice])) throw new TypeError('Invalid probabilities');
    return a;
  });
}

export function createChatAdapter(selection, transport = fetch, credential) {
  const { adapter, model, baseUrl, inputUsdPerMillion = 0, outputUsdPerMillion = 0 } = selection;
  if (!baseUrl || !model || ![inputUsdPerMillion, outputUsdPerMillion].every(n => Number.isFinite(n) && n >= 0)) throw new TypeError('Invalid model configuration');
  const ollama = adapter === 'ollama';
  const cost = (input, output) => (input * inputUsdPerMillion + output * outputUsdPerMillion) / 1e6;
  const prepare = request => {
    const schema = request.choices ? choiceSchema(request.choices) : request.schema;
    const messages = [
      ...(request.system || request.systemDynamic ? [{ role: 'system', content: [request.system, request.systemDynamic].filter(Boolean).join('\n') }] : []),
      ...chatMessages(request.messages),
      ...(request.choices ? [{ role: 'user', content: JSON.stringify(request.choices) }] : []),
    ];
    const offered = (request.tools ?? []).filter(t => !request.registry || request.registry.names.includes(t.name));
    const tools = offered.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (ollama) for (const m of messages) {
      if (m.tool_calls) m.tool_calls = m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: JSON.parse(c.function.arguments) } }));
    }
    return { model, messages, stream: false, ...(tools.length ? { tools } : {}),
      ...(ollama ? { options: { num_predict: request.maxTokens, temperature: 0 }, ...(schema ? { format: schema } : {}) }
        : { max_tokens: request.maxTokens, ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } } } : {}) }) };
  };
  return {
    model, credentialRequired: false, responseBound: 1,
    estimate(request) {
      const inputTokens = Buffer.byteLength(JSON.stringify(prepare(request))) + 4096 + (request.extraInputTokens ?? 0);
      return { inputTokens, outputTokens: request.maxTokens, costUsd: cost(inputTokens, request.maxTokens) };
    },
    async complete(request) {
      const body = prepare(request);
      const auth = credential ?? request.credential;
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { name: 'TimeoutError' })); }, request.timeoutMs ?? 120000); });
        const result = await Promise.race([(async () => {
          const response = await transport(`${baseUrl.replace(/\/$/, '')}/${ollama ? 'api/chat' : 'chat/completions'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth?.value ? { Authorization: `Bearer ${auth.value}` } : {}) },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!response.ok) return failure(model, statusCode(response.status), 0);
          const data = await response.json();
          const message = ollama ? data.message : data.choices?.[0]?.message;
          const input = ollama ? data.prompt_eval_count : data.usage?.prompt_tokens;
          const output = ollama ? data.eval_count : data.usage?.completion_tokens;
          const tokens = { input_tokens: input, output_tokens: output };
          if (!count(input) || !count(output)) return failure(model, 'accounting', undefined, tokens);
          const reportedCost = ollama ? undefined : data.usage?.cost;
          if (reportedCost !== undefined && (!Number.isFinite(reportedCost) || reportedCost < 0)) return failure(model, 'accounting', undefined, tokens);
          const costUsd = reportedCost ?? cost(input, output);
          if (!message || (ollama && data.done !== true)) return failure(model, 'invalid_response', costUsd, tokens);
          const text = typeof message.content === 'string' ? message.content : '';
          const content = text ? [{ type: 'text', text }] : [];
          const toolCalls = message.tool_calls ?? [];
          try {
            if (!Array.isArray(toolCalls)) throw new TypeError();
            for (const [i, c] of toolCalls.entries()) {
              const args = ollama ? c.function.arguments : JSON.parse(c.function.arguments);
              if (!c.function.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError();
              content.push({ type: 'tool_use', id: c.id ?? `call_${i}`, name: c.function.name, input: args });
            }
            if (request.schema && !toolCalls.length && !compileSchema(request.schema)(JSON.parse(text))) throw new TypeError();
            if (request.choices && !toolCalls.length) parseChoices(text, request.choices);
          } catch { return failure(model, 'invalid_response', costUsd, tokens); }
          const reason = ollama ? data.done_reason : data.choices[0].finish_reason;
          if (reason === 'length') return failure(model, 'budget', costUsd, tokens);
          if (!ollama && (toolCalls.length ? reason !== 'tool_calls' : reason !== 'stop')) return failure(model, 'invalid_response', costUsd, tokens);
          for (const block of content) {
            if (block.type === 'tool_use') {
              try { request.onEvent?.({ type: 'tool', name: block.name }); } catch {}
              await request.registry.invoke(block.name, block.input);
            } else { try { request.onEvent?.({ type: 'text', text: block.text }); } catch {} }
          }
          return { text, content, tokens, costUsd, model, status: toolCalls.length ? 'error_max_turns' : 'success',
            toolResults: request.registry?.results ?? [], details: {}, ...(request.choices ? { choices: parseChoices(text, request.choices) } : {}) };
        })(), timeout]);
        return result;
      } catch (error) {
        return failure(model, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable', undefined);
      } finally { clearTimeout(timer); }
    },
  };
}
