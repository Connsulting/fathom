import { createHash } from 'node:crypto';
import { fixture, recipe } from './model-import.mjs';
import { serveAppFixture } from './server.mjs';
import { createAuthStore } from '../../src/auth/store.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { SCOPES } from '../../src/mcp/keys.mjs';
import { rpcResult, callToolRpc } from '../../src/mcp/test/helpers.mjs';

export const csv = 'Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\n';
export const note = 'single\n2032-03-01\nowner\n';
export async function interpretation(text, { negate = false, pasted = false } = {}) {
  const bytes = Buffer.from(text), fileId = 'f-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const source = await indexSource({ fileId, bytes, format: pasted ? 'text' : 'csv' });
  if (pasted) {
    const ref = value => ({ refs: [Object.keys(source.values).find(id => String(source.values[id]).trim() === value)], transform: { op: 'trim' } });
    return { rows: [{ target: 'fact', key: 'household.filingStatus', scope: 'household', datePrecision: 'day', fields: {
      value: ref('single'), asOf: ref('2032-03-01'), subject: ref('owner'),
    } }], completeness: 'complete', coverage: source.regions.map(regionId => ({ regionId, refs: source.inventory[regionId].refs, disposition: 'imported_detail' })) };
  }
  const layout = recipe();
  if (negate) layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
  const { rows, coverage, completeness, controls } = applyLayout(source, layout);
  return { rows, coverage, completeness, controls, layout };
}

export async function modelApp(t) {
  const x = await fixture({ engine: 'fake' });
  await createAuthStore(x.platform).setPlatformSetting('instance_model_cap_usd', 50);
  const inner = await createRuntimeEngine({ db: x.db, config: { engine: 'fake', fakeStreamMs: 0 } }), responses = [];
  let extracts = 0, chat = [], onExtract = () => {}, onChat = () => {};
  const engine = { ...inner, async call(request) {
    if (request.purpose === 'extract') {
      extracts++; onExtract(request);
      if (!responses.length) throw new Error('No scripted interpretation');
      return await inner.call({ ...request, fake: [{ text: JSON.stringify(responses.shift()), costUsd: 0.001,
        tokens: { input_tokens: 20, output_tokens: 40 } }] });
    }
    if (request.purpose === 'chat') { onChat(request); return await inner.call({ ...request, fake: chat }); }
    return await inner.call({ ...request, fake: [{ text: request.purpose === 'title' ? '{"title":"Synthetic import"}' : '{}', costUsd: 0 }] });
  } };
  const app = await serveAppFixture({ ...x, engine, authenticated: true });
  t.after(async () => { await app.household.scheduler.stop(); await app.close(); await x.close(); });
  const { key } = await app.keys.create({ householdId: app.household.householdId, userId: app.session.user.id, name: 'Synthetic import key', scopes: SCOPES });
  return { ...x, app, engine, responses, get extracts() { return extracts; },
    set chat(value) { chat = value; }, set onExtract(value) { onExtract = value; }, set onChat(value) { onChat = value; },
    async tool(name, args, scopes) {
      const scoped = scopes ? (await app.keys.create({ householdId: app.household.householdId, userId: app.session.user.id, name: 'Synthetic scoped key', scopes })).key : key;
      const result = rpcResult(await callToolRpc(app.baseUrl, scoped, name, args));
      if (result.isError) return { error: result.content[0].text };
      return JSON.parse(result.content[0].text);
    },
    mcp(operation, args = {}) { return this.tool('refresh', { operation, ...args }); },
    async upload(text = csv) {
      const form = new FormData(); form.append('files', new Blob([text], { type: 'text/csv' }), 'synthetic.csv');
      const response = await fetch(app.baseUrl + '/api/files', { method: 'POST', headers: app.headers, body: form });
      return (await response.json()).files[0];
    },
    async review(proposal, decision = 'approve', evidence = 'yes') {
      return app.postJson(`/api/import-proposals/${proposal.proposalId}/review`, { version: proposal.version, decision, evidence });
    },
  };
}
