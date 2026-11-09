import { createHash } from 'node:crypto';
import { createAuthStore } from '../../src/auth/store.mjs';
import { fixture, recipe } from './model-import.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { ingestFile, retryFile } from '../../src/ingest/pipeline.mjs';
import { reviewImport } from '../../src/ingest/model-review.mjs';

export async function setup() {
  const x = await fixture({ engine: 'fake' });
  await createAuthStore(x.platform).setPlatformSetting('instance_model_cap_usd', 50);
  return { ...x, opts: { ...x.ctx, config: x.config } };
}
export async function upload(x, text, layout = recipe(), options = {}) {
  const bytes = Buffer.from(text), name = 'synthetic.csv';
  const fileId = 'f-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const source = await indexSource({ fileId, bytes, name, format: 'csv' });
  const proposal = applyLayout(source, layout);
  options.change?.(proposal);
  const fake = [{ text: JSON.stringify({ rows: proposal.rows, coverage: proposal.coverage, completeness: proposal.completeness, controls: proposal.controls, layout }), costUsd: 0.001,
    tokens: { input_tokens: 20, output_tokens: 40 } }];
  const opts = { ...x.opts, fake };
  const result = options.reinterpret ? await retryFile(x.db, fileId, { ...opts, mode: 'reinterpret' }) : await ingestFile(x.db, { name, bytes }, opts);
  return { ...result, fileId };
}
export const approve = async (x, r) => reviewImport(x.ctx, { proposalId: r.proposalId, version: r.version, decision: 'approve', evidence: 'yes' });
export const transactions = (amount = '-12.25', twice = true) => 'Account,Date,Amount USD,Description\n' +
  `account-synthetic,2032-03-02,${amount},Synthetic purchase\n` + (twice ? `account-synthetic,2032-03-02,${amount},Synthetic purchase\n` : '');
