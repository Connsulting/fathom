// Onboarding API: the Tell us note. The text is stored as a notes document through the ingest
// pipeline (the same path as an uploaded .md file: encrypted in the vault, the notes parser, then
// fact and goal extraction with the engine gateway), so its facts land with provenance and anything
// ambiguous becomes a Confirm card. With the engine off only the parser's deterministic path runs:
// the note is stored and waits (status needs_extraction) until the engine reads it. Errors carry
// fixed messages; the note text never reaches a response or a log.

import { ingestFile } from '../ingest/pipeline.mjs';
import { VaultError } from '../ingest/vault.mjs';
import { understoodOf } from '../onboarding/heard.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';
import { householdVault, ingestOpts, triggerPlan, triggerGuesses } from './ingest-handlers.mjs';

export const NOTE_MAX_BYTES = 30000;
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export async function saveNotes(ctx) {
  const raw = ctx.body && ctx.body.text;
  if (typeof raw !== 'string') throw new HttpError(400, 'text is required');
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new HttpError(400, 'write something first; the note is empty');
  if (CONTROL.test(text)) throw new HttpError(400, 'the note has characters that cannot be read');
  const bytes = new TextEncoder().encode(text + '\n');
  if (bytes.length > NOTE_MAX_BYTES) throw new HttpError(413, `the note is over ${NOTE_MAX_BYTES} bytes; split it or attach it as a file`);

  await householdVault(ctx);
  const opts = ingestOpts(ctx);
  let file;
  try {
    file = await ingestFile(ctx.db, { name: `Setup notes ${opts.now.slice(0, 10)}.md`, bytes, mime: 'text/markdown' }, opts);
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (file.status === 'failed' || file.status === 'unsupported' || file.status === 'too_large') {
    throw new HttpError(422, 'the note could not be saved');
  }
  if (file.status === 'imported') {
    triggerPlan(ctx);
    triggerGuesses(ctx);
  }
  const engineOn = !!(ctx.engine && typeof ctx.engine.isOn === 'function' && ctx.engine.isOn());
  return { scenario: scenarioOf(ctx), file, understood: understoodOf(ctx.db, file, { engineOn }) };
}
