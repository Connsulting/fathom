// serverInfo.version: the git SHA of the build when one was passed in, else the package version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serverInfo, serverVersion } from '../server.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
const SHA = 'fedcba9876543210fedcba9876543210fedcba98';

test('the build SHA is the server version', () => {
  assert.equal(serverVersion({ FATHOM_BUILD_SHA: SHA }), SHA);
  assert.deepEqual(serverInfo({ FATHOM_BUILD_SHA: ` ${SHA}\n` }), { name: 'fathom', version: SHA });
});

test('without a build SHA the package version is reported', () => {
  assert.equal(serverVersion({}), PACKAGE_VERSION);
  assert.equal(serverVersion({ FATHOM_BUILD_SHA: '' }), PACKAGE_VERSION);
  assert.equal(serverVersion({ FATHOM_BUILD_SHA: '  ' }), PACKAGE_VERSION);
});
