// Notes share upload storage, indexed proposals and explicit approval before financial writes.

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
  const opts = await ingestOpts(ctx);
  opts.capturedAt = opts.now;
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
  return { scenario: await scenarioOf(ctx), file, understood: await understoodOf(ctx.db, file, { engineOn }) };
}
