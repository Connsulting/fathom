// Preload for a child server (NODE_OPTIONS=--import=<this file's URL>): appends one line to
// $TEST_COUNT_OPENS_LOG for every fs open or read of $TEST_COUNT_OPENS_TARGET, through the builtin
// modules' live ESM bindings, before any server module loads. Without both variables it does nothing.

import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const target = process.env.TEST_COUNT_OPENS_TARGET;
const log = process.env.TEST_COUNT_OPENS_LOG;

if (target && log) {
  const want = resolve(target);
  const require = createRequire(import.meta.url);
  const fsp = require('node:fs/promises');
  const fs = require('node:fs');
  const names = [[fsp, 'open'], [fsp, 'readFile'], [fs, 'openSync'], [fs, 'readFileSync'], [fs, 'open'], [fs, 'readFile'], [fs, 'createReadStream']];
  for (const [mod, name] of names) {
    const original = mod[name];
    mod[name] = function counted(path, ...rest) {
      if ((typeof path === 'string' || path instanceof URL) && resolve(String(path instanceof URL ? path.pathname : path)) === want) {
        appendFileSync(log, `${name}\n`);
      }
      return original.call(this, path, ...rest);
    };
  }
  syncBuiltinESMExports();
}
