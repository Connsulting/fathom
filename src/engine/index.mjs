import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { checkGrounding } from './grounding.mjs';
import { compileSchema } from './schema.mjs';
import { createRegistryServer } from './tools.mjs';
import { sdkRound, messagesRound } from './live.mjs';
import { modelFor, estimateUnknownCost } from './pricing.mjs';
import { EngineOffError, BudgetExceededError, RoundLimitError, ModelCallError, ModelAccountingError } from './errors.mjs';
export { EngineOffError, BudgetExceededError, RoundLimitError, ModelCallError, ModelAccountingError } from './errors.mjs';
export { checkGrounding, numberPattern } from './grounding.mjs';

const queues = new WeakMap();
async function serial(ledger, callback) {
  const prior = queues.get(ledger) ?? Promise.resolve();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  queues.set(ledger, wait);
  await prior;
  try { return await callback(); } finally { release(); if (queues.get(ledger) === wait) queues.delete(ledger); }
}

// Purposes answered in one structured messages round with no tools and no tool loop. 'title'
// (Ask thread names) runs on TITLE_MODEL, every other purpose on DEFAULT_MODEL.
const SINGLE_ROUND = ['extract', 'confirm', 'title'];
const PURPOSES = ['chat', 'job', ...SINGLE_ROUND];

// Keep every round. Join with '' only when the cut is inside a word or a number. A finished
// sentence starts a new paragraph. Anything else (a word, a comma) gets one space.
const WORD_CHAR = /[\p{L}\p{N}]/u;
const TERMINAL = /[.!?]["'\u201d]?$/;

export function joinAnswerParts(parts) {
  let out = '';
  for (const part of parts) {
    if (typeof part !== 'string' || !part) continue;
    if (!out) { out = part; continue; }
    const prev = out.replace(/\s+$/, '');
    const next = part.replace(/^\s+/, '');
    const a = prev.slice(-1);
    const b = next.slice(0, 1);
    const lastWord = prev.match(/[\p{L}\p{N}]+$/u)?.[0] ?? '';
    const midWord = WORD_CHAR.test(a) && WORD_CHAR.test(b) && (
      (/[\p{N}]/u.test(a) && /[\p{N}]/u.test(b))
      || (lastWord.length === 1 && /[\p{L}]/u.test(a) && /[\p{L}]/u.test(b))
    );
    let sep = '\n\n';
    if (midWord) sep = '';
    else if (!TERMINAL.test(prev)) sep = ' ';
    out = prev + sep + next;
  }
  return out;
}

const monthKey = timestamp => new Date(timestamp).toISOString().slice(0, 7).replace('-', '');

export function createMemoryLedger(initial = []) {
  const entries = [];
  const ledger = {
    get entries() { return structuredClone(entries); },
    monthSpendUsd(month) { return Number(entries.filter(entry => monthKey(entry.ts) === month).reduce((sum, entry) => sum + entry.costUsd, 0).toFixed(12)); },
    record(entry) {
      if (!entry || !Number.isFinite(entry.costUsd) || entry.costUsd < 0) throw new TypeError('Invalid ledger cost');
      monthKey(entry.ts);
      entries.push(structuredClone(entry));
    },
  };
  initial.forEach(entry => ledger.record(entry));
  return ledger;
}

export async function loadCredential(file = process.env.FATHOM_CLAUDE_CREDENTIAL_FILE) {
  if (!file) throw new TypeError('An explicit credential file is required');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new TypeError('Credential file must be private');
    const value = (await handle.readFile('utf8')).trim();
    if (!value) throw new TypeError('Credential file is empty');
    if (/\s/.test(value)) throw new TypeError('Credential must contain one token');
    return { type: 'api-key', value };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Cannot read the explicit credential file');
  } finally { await handle?.close(); }
}

function explicitCredential(credential) {
  const result = typeof credential === 'string' ? { type: 'api-key', value: credential } : credential;
  if (!result || result.type !== 'api-key' || typeof result.value !== 'string' || !result.value.trim() || /\s/.test(result.value)) {
    throw new TypeError('An explicit live credential is required');
  }
  return result;
}

// request.fake (optional, fake mode): a per-call script list used instead of the constructor queue.
// request.systemDynamic (optional): system text placed after the dynamic boundary (not cached).
// request.toolContext (optional): { db, now } for this call's tools instead of the constructed one.
// request.onEvent (optional, purpose 'chat'): called with { type: 'tool', name } as each tool call
// starts and { type: 'text', text } for each text delta, in every round. In fake mode the round's
// scripted text arrives in deterministic chunks of FAKE_CHUNK_WORDS words, streamDelayMs apart.
// A throwing listener is ignored; events never change the result, the spend or the ledger.
export const FAKE_CHUNK_WORDS = 3;

export function fakeChunks(text) {
  const parts = String(text ?? '').split(/(?<=\s)(?=\S)/);
  const out = [];
  for (let i = 0; i < parts.length; i += FAKE_CHUNK_WORDS) out.push(parts.slice(i, i + FAKE_CHUNK_WORDS).join(''));
  return out;
}

const pause = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

export function createEngine({ mode = process.env.FATHOM_ENGINE ?? 'off', ledger = createMemoryLedger(), capUsd = 200,
  credential, responses = [], now = () => new Date(), toolContext = {}, streamDelayMs = 0 } = {}) {
  if (!['live', 'fake', 'off'].includes(mode)) throw new TypeError('Invalid engine mode');
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new TypeError('Invalid monthly cap');
  if (typeof ledger.monthSpendUsd !== 'function' || typeof ledger.record !== 'function') throw new TypeError('Invalid ledger adapter');
  const scripted = [...responses];
  let poisoned = false;
  const call = async ({ purpose, system = '', systemDynamic = '', messages, tools = [], maxTokens = 1024, schema, grounding = {}, fake,
    toolContext: callContext, onEvent } = {}) => {
    if (mode === 'off') throw new EngineOffError();
    let bridge = false;
    const emit = typeof onEvent === 'function' && purpose === 'chat'
      ? event => {
        try {
          if (bridge && event && event.type === 'text' && event.text) {
            bridge = false;
            const prev = joinAnswerParts(answerParts);
            if (prev) {
              const next = String(event.text).replace(/^\s+/, '');
              const joined = joinAnswerParts([prev, event.text]);
              const sep = joined.slice(prev.length, joined.length - next.length);
              if (sep) onEvent({ type: 'text', text: sep });
            }
          }
          onEvent(event);
        } catch { /* listeners never fail a call */ }
      }
      : null;
    if (!PURPOSES.includes(purpose)) throw new TypeError('Invalid call purpose');
    const model = modelFor(purpose);
    if (typeof system !== 'string' || typeof systemDynamic !== 'string' || !Array.isArray(messages) || messages.length === 0 || !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 128000) {
      throw new TypeError('Invalid model request');
    }
    if (fake !== undefined && !Array.isArray(fake)) throw new TypeError('Invalid fake script list');
    const queue = fake === undefined ? scripted : structuredClone(fake);
    const transcript = structuredClone(messages);
    const allResults = [];
    const rounds = [];
    const answerParts = [];
    let cost = 0;
    for (let roundIndex = 0; roundIndex < 8; roundIndex++) {
      let round;
      bridge = true;
      await serial(ledger, async () => {
        if (poisoned) throw new ModelAccountingError();
        const ts = new Date(now()).toISOString();
        const spend = await ledger.monthSpendUsd(monthKey(ts));
        if (!Number.isFinite(spend) || spend < 0) throw new ModelAccountingError();
        if (spend >= capUsd) { const error = new BudgetExceededError(); error.toolResults = allResults; throw error; }
        const auth = mode === 'live' ? explicitCredential(credential) : undefined;
        const context = callContext ?? toolContext;
        const registry = createRegistryServer(tools, { purpose, ctx: { db: context.db, now: context.now ?? ts } });
        try {
          if (mode === 'fake') {
            if (!queue.length) throw new ModelCallError('Fake engine has no scripted response');
            const script = structuredClone(queue.shift());
            if (emit) {
              for (const item of script.toolCalls ?? []) { emit({ type: 'tool', name: item.name }); await pause(streamDelayMs); }
            }
            await Promise.all((script.toolCalls ?? []).map(item => registry.invoke(item.name, item.args ?? {})));
            const blockTexts = Array.isArray(script.content)
              ? script.content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text)
              : null;
            const text = blockTexts && blockTexts.length ? blockTexts.join('') : (script.text ?? '');
            if (emit && text) {
              for (const chunk of fakeChunks(text)) { await pause(streamDelayMs); emit({ type: 'text', text: chunk }); }
            }
            round = { text, costUsd: Object.hasOwn(script, 'costUsd') ? script.costUsd : 0.001, model: 'fake', tokens: script.tokens ?? {},
              status: script.status ?? (script.toolCalls?.length ? 'error_max_turns' : 'success'),
              is_error: script.is_error === true, api_error_status: script.api_error_status ?? null,
              accountingUnknown: script.accountingUnknown ?? false, toolResults: registry.results,
              content: Array.isArray(script.content) ? script.content : [{ type: 'text', text }], details: { maxBudgetUsd: capUsd - spend } };
          } else {
            try {
              round = await (SINGLE_ROUND.includes(purpose) ? messagesRound : sdkRound)({ credential: auth, system, systemDynamic,
                messages: transcript, maxTokens, maxBudgetUsd: capUsd - spend, model, registry, schema, ...(emit ? { onEvent: emit } : {}) });
            } catch {
              round = { text: '', content: [], status: 'transport_error', is_error: true,
                accountingUnknown: true, model, tokens: {}, toolResults: registry.results, details: {} };
            }
          }
          const knownCost = Number.isFinite(round.costUsd) && round.costUsd >= 0 ? round.costUsd : 0;
          if (round.accountingUnknown || !Number.isFinite(round.costUsd) || round.costUsd < 0) {
            const estimate = estimateUnknownCost({ model, maxTokens,
              system: systemDynamic ? `${system}\n${systemDynamic}` : system, messages: transcript, tools });
            round.costUsd = Math.max(knownCost, estimate.costUsd);
            round.tokens = { ...round.tokens, estimated: true, knownCostUsd: knownCost,
              estimatedInputTokens: estimate.inputTokens, estimatedOutputTokens: estimate.outputTokens };
            round.accountingUnknown = true;
          }
          if (Number.isFinite(round.costUsd) && round.costUsd >= 0) {
            try { await ledger.record({ ts, purpose, costUsd: round.costUsd, model: round.model, tokens: round.tokens }); }
            catch { poisoned = true; throw new ModelAccountingError(); }
          } else { poisoned = true; throw new ModelAccountingError(); }
          if (round.accountingUnknown) {
            poisoned = true;
            if (round.is_error || round.api_error_status != null) throw new ModelCallError('Live model call failed; conservative spend was recorded');
            throw new ModelAccountingError();
          }
        } finally { await registry.instance.close(); }
      });
      cost += round.costUsd;
      rounds.push(round.details);
      allResults.push(...round.toolResults);
      if (typeof round.text === 'string' && round.text) answerParts.push(round.text);
      const toolBoundary = round.status === 'error_max_turns' && round.toolResults.length > 0;
      if (round.api_error_status != null || (round.is_error && !toolBoundary && round.status !== 'error_max_budget_usd')) {
        throw new ModelCallError('Model did not complete a valid response');
      }
      if (round.status === 'error_max_budget_usd') {
        const error = new BudgetExceededError(); error.toolResults = allResults; throw error;
      }
      if (!['success', 'error_max_turns'].includes(round.status)) throw new ModelCallError('Model did not complete a valid response');
      if (round.status === 'error_max_turns' && round.toolResults.length === 0) throw new ModelCallError('Model reached a turn limit without a tool result');
      if (round.toolResults.length === 0 || SINGLE_ROUND.includes(purpose)) {
        const text = joinAnswerParts(answerParts);
        return { text, content: round.content, costUsd: Number(cost.toFixed(12)), model: round.model,
          toolResults: allResults, rounds, grounding: checkGrounding(text, { ...grounding, toolResults: allResults }) };
      }
      transcript.push({ role: 'assistant', content: round.content }, { role: 'tool', content: round.toolResults });
    }
    const error = new RoundLimitError(); error.toolResults = allResults; throw error;
  };
  return { call, async extract({ document, schema, system = 'Extract documented rows without guessing.', maxTokens = 4096, fake } = {}) {
    if (mode === 'off') throw new EngineOffError();
    const responseSchema = { type: 'object', properties: { rows: { type: 'array', items: schema } }, required: ['rows'], additionalProperties: false };
    const validate = compileSchema(responseSchema);
    let block;
    if (document?.type === 'text' && typeof document.text === 'string') {
      block = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: document.text } };
    } else if (document?.type === 'pdf' && (Buffer.isBuffer(document.data) || document.data instanceof Uint8Array)) {
      block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(document.data).toString('base64') } };
    } else throw new TypeError('A text or PDF document is required');
    const response = await call({ purpose: 'extract', system, maxTokens, schema: responseSchema, fake,
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Return the rows matching the supplied schema.' }] }] });
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { throw new ModelCallError('Model returned invalid JSON'); }
    if (!validate(parsed)) throw new ModelCallError('Extracted rows failed schema validation');
    return parsed.rows;
  } };
}
