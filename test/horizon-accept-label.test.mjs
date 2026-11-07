// The Confirm group card's Accept button names how many best guesses it will take.

import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptLabel } from '../web/horizon/screens/ingest.js';

test('acceptLabel is singular for one best guess', () => {
  assert.equal(acceptLabel(1), 'Accept 1 best guess');
});

test('acceptLabel is plural for several best guesses', () => {
  assert.equal(acceptLabel(2), 'Accept 2 best guesses');
  assert.equal(acceptLabel(3), 'Accept 3 best guesses');
  assert.equal(acceptLabel(12), 'Accept 12 best guesses');
});
