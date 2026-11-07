// Playwright webServer entry. Wipes and recreates the e2e data directory named by E2E_DATA, then
// runs the real server against it in demo mode. The wipe happens here, before the server starts,
// so nothing touches the data directory while a server is using it.
//
// Default mode: E2E_DATA must resolve to a top-level directory inside the repository whose name
// starts with .e2e-data (gitignored as .e2e-data*/).
// E2E_EXTERNAL=1: E2E_DATA must be an absolute path whose parent is os.tmpdir() and whose name
// starts with fathom-e2e-, for flows that need a data directory outside the checkout (Your plans).
// Anything else is refused and nothing is deleted.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT } from './data-dir.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`e2e/serve.mjs: ${msg}`);
  process.exit(2);
}

const raw = process.env.E2E_DATA;
if (process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL || process.env.FATHOM_SMOKE_TARGET === 'real') {
  fail('refusing to reset data with a supplied smoke target');
}
if (!raw) fail('E2E_DATA is required');
let dataDir;
if (process.env.E2E_EXTERNAL === '1') {
  if (!isAbsolute(raw)) fail(`E2E_EXTERNAL=1 needs an absolute E2E_DATA, got ${raw}`);
  dataDir = resolve(raw);
  if (dirname(dataDir) !== resolve(tmpdir())) fail(`E2E_EXTERNAL=1 needs E2E_DATA directly inside the temp directory, got ${raw}`);
  if (!basename(dataDir).startsWith('fathom-e2e-')) fail(`E2E_EXTERNAL=1 needs an E2E_DATA name starting with fathom-e2e-, got ${raw}`);
} else {
  dataDir = resolve(repo, raw);
  const rel = relative(repo, dataDir);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail(`E2E_DATA must be inside the repository, got ${raw}`);
  if (rel.includes(sep) || !rel.startsWith(DATA_ROOT)) fail(`E2E_DATA must be a top-level ${DATA_ROOT}* directory, got ${raw}`);
}

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [resolve(repo, 'src/server.mjs')], {
  cwd: repo,
  env: { ...process.env, FATHOM_DATA: dataDir, FATHOM_DEMO: '1' },
  stdio: 'inherit'
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}

child.on('error', (err) => fail(`could not start src/server.mjs: ${err.message}`));
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
