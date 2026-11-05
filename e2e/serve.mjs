// Playwright webServer entry. Wipes and recreates the e2e data directory named by E2E_DATA, then
// runs the real server against it in demo mode. The wipe happens here, before the server starts,
// so nothing touches the data directory while a server is using it.
//
// E2E_DATA must resolve to a top-level directory inside the repository whose name starts with
// .e2e-data (gitignored as .e2e-data*/). Anything else is refused and nothing is deleted.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`e2e/serve.mjs: ${msg}`);
  process.exit(2);
}

const raw = process.env.E2E_DATA;
if (!raw) fail('E2E_DATA is required');
const dataDir = resolve(repo, raw);
const rel = relative(repo, dataDir);
if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail(`E2E_DATA must be inside the repository, got ${raw}`);
if (rel.includes(sep) || !rel.startsWith('.e2e-data')) fail(`E2E_DATA must be a top-level .e2e-data* directory, got ${raw}`);

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
