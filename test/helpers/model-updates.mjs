import { fixture } from './model-import.mjs';
export async function updateFixture(text = 'Payroll true-up done, the payroll provider pays next Tuesday.', options = {}) {
  const x = await fixture(options);
  const source = await x.source(text, 'text');
  await x.db.prepare("INSERT INTO recs (id,def,status,updated_at) VALUES ('payroll',?,'proposed',?)")
    .run(JSON.stringify({ title: 'Payroll', tasks: [{ t: 'Payroll true-up' }] }), x.ctx.now);
  const ctx = { ...x.ctx, scopes: ['write:imports', 'write:facts', 'write:goals', 'write:steps', 'write:recs'], replan: async () => ({ status: 'ok' }) };
  const span = { fileId: source.fileId, sha256: source.sha256, byteStart: 0, byteEnd: source.bytes.length };
  const expected = { tool: 'answer', operation: 'expected_transaction', span, args: {
    subject: 'payroll provider', direction: 'inflow', dueDate: '2032-03-09', datePrecision: 'day', amount: null,
    evidence: text, relativeDate: 'next Tuesday',
  } };
  const step = { tool: 'act_on_recommendation', operation: 'step', span, args: { id: 'payroll', index: 0, checked: true } };
  return { ...x, ctx, source, span, expected, step };
}
