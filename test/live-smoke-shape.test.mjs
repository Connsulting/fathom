// AC7 shape: the shared Ask smoke (src/engine/test/smoke-ask.mjs) runs end to end in fake mode
// with the same helper the opt-in live test uses, and live mode without a credential fails
// closed with a notice and no spend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAskSmoke } from '../src/engine/test/smoke-ask.mjs';

test('the Ask smoke in fake mode is grounded, records spend and carries provenance', async () => {
  const r = await runAskSmoke({ mode: 'fake' });
  assert.equal(r.notice, false);
  assert.equal(r.groundingOk, true);
  assert.ok(r.spendRows.length >= 1);
  for (const row of r.spendRows) {
    assert.equal(row.purpose, 'chat');
    assert.equal(row.model, 'fake');
    assert.equal(row.yyyymm, '2026-11', 'spend lands in the demo clock month');
    assert.ok(row.costUsd > 0);
  }
  assert.equal(r.provenance.engine, 'fake');
  assert.equal(r.provenance.grounding.ok, true);
  assert.ok(r.provenance.tools.some(x => x.name === 'household_summary'));
  assert.ok(r.provenance.costUsd > 0);
});

test('the Ask smoke in live mode without a credential answers with a notice and spends nothing', async () => {
  const r = await runAskSmoke({ mode: 'live' });
  assert.equal(r.notice, true);
  assert.equal(r.groundingOk, false);
  assert.deepEqual(r.spendRows, []);
  assert.ok(r.paragraphs.join('\n').includes('could not answer just now, so nothing was made up'));
});
