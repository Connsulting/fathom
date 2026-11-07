import test from 'node:test';
import assert from 'node:assert/strict';
import { syncNotice } from '../web/horizon/screens/simplefin.js';

const scenario = { meta: { dataThrough: 'Jun 20, 2032' }, live: { simplefin: { accounts: 4 } } };

test('an ok sync names the account count and the data-through date', () => {
  assert.equal(syncNotice({ scenario, run: { status: 'ok' } }), 'Synced 4 accounts, data through Jun 20, 2032');
});

test('a failed or skipped sync does not claim success', () => {
  assert.equal(syncNotice({ scenario, run: { status: 'error' } }), '');
  assert.equal(syncNotice({ scenario, run: { status: 'skipped' } }), '');
  assert.equal(syncNotice({ scenario, run: null }), '');
  assert.equal(syncNotice(null), '');
});
