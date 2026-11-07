import test from 'node:test';
import assert from 'node:assert/strict';
import { syncNotice } from '../web/horizon/screens/simplefin.js';

const scenario = { meta: { dataThrough: 'Jun 20, 2032' }, live: { simplefin: { accounts: 4 } } };

test('an ok sync names the account count and the data-through date', () => {
  assert.equal(syncNotice({ scenario, run: { status: 'ok' } }), 'Synced 4 accounts, data through Jun 20, 2032');
});

test('a failed or skipped sync replaces a previous success line with nothing', () => {
  const previous = syncNotice({ scenario, run: { status: 'ok' } });
  assert.match(previous, /^Synced 4 accounts/);
  for (const res of [{ scenario, run: { status: 'error' } }, { scenario, run: { status: 'skipped' } }, null]) {
    assert.equal(syncNotice(res), '', 'the caller assigns this, including the empty string');
  }
});
