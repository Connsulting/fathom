// Playwright config for the Fathom end-to-end suite.
// FATHOM_SMOKE_BASE_URL or BASE_URL set: run against that server, start nothing locally.
// Both unset: start three demo servers through e2e/serve.mjs: the main one, a January one
// whose clock is pinned to 2027-01-05 for e2e/january.spec.mjs, and a Your plans one whose data
// directory sits outside the checkout (in the temp directory) for e2e/your-plans.spec.mjs.
// FATHOM_SMOKE_TARGET=real (default demo) selects the real-store smoke assertions. Real mode
// requires a base URL. Without a signed-in session only the signed-out @auth-smoke assertions
// can pass against a real store. FATHOM_SMOKE_STORAGE_STATE optionally names a Playwright
// storage-state file holding a session for that supplied server (made by signing in with a
// passkey); it becomes use.storageState for the authenticated real smoke. It needs a supplied
// base URL, and specs that must start signed out reset their own storage state.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

function portFrom(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65533) throw new Error(`E2E_PORT must be an integer port, got ${value}`);
  return n;
}

function smokeStorageState(raw, baseURL) {
  if (raw == null || raw === '') return undefined;
  if (!baseURL) throw new Error('FATHOM_SMOKE_STORAGE_STATE needs FATHOM_SMOKE_BASE_URL or BASE_URL');
  const file = resolve(raw);
  if (!existsSync(file)) throw new Error('FATHOM_SMOKE_STORAGE_STATE must name an existing storage-state file');
  return file;
}

const CI = !!process.env.CI;
const SINGLE_SERVER = process.env.E2E_SINGLE_SERVER === '1';
const SMOKE_TARGET = process.env.FATHOM_SMOKE_TARGET === 'real' ? 'real' : 'demo';
const BASE_URL = process.env.FATHOM_SMOKE_BASE_URL || process.env.BASE_URL || '';
const STORAGE_STATE = smokeStorageState(process.env.FATHOM_SMOKE_STORAGE_STATE, BASE_URL);
if (SMOKE_TARGET === 'real' && !BASE_URL) {
  throw new Error('FATHOM_SMOKE_TARGET=real needs FATHOM_SMOKE_BASE_URL or BASE_URL');
}
const PORT = portFrom(process.env.E2E_PORT, 4173);
const JAN_PORT = PORT + 1;
const YP_PORT = PORT + 2;
const baseURL = BASE_URL || `http://127.0.0.1:${PORT}`;
// Specs read this from testInfo.config.metadata.janBaseURL. Empty means no January server, and
// e2e/january.spec.mjs skips. JAN_BASE_URL lets a caller point it at a server of its own.
const janBaseURL = process.env.JAN_BASE_URL || (BASE_URL ? '' : `http://127.0.0.1:${JAN_PORT}`);
// Specs read these from testInfo.config.metadata. The Your plans server's data directory is
// deterministic so every evaluation of this config agrees on it. Both are empty when BASE_URL is
// set, and e2e/your-plans.spec.mjs skips.
const ypDataDirLocal = join(tmpdir(), 'fathom-e2e-yp-' + PORT);
const ypBaseURL = BASE_URL ? '' : `http://127.0.0.1:${YP_PORT}`;
const ypDataDir = BASE_URL ? '' : ypDataDirLocal;

function demoServer(port, dataDir, extraEnv = {}) {
  return {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    env: { FATHOM_PORT: String(port), E2E_DATA: dataDir, ...extraEnv },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe'
  };
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  metadata: { janBaseURL, ypBaseURL, ypDataDir, smokeTarget: SMOKE_TARGET },
  use: {
    baseURL,
    launchOptions: { args: [`--explicitly-allowed-ports=${PORT}`] },
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'desktop',
      grepInvert: /@mobile-only/,
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } }
    },
    {
      name: 'mobile',
      grep: /@mobile/,
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
    }
  ],
  webServer: BASE_URL
    ? undefined
    : SINGLE_SERVER ? [demoServer(PORT, process.env.E2E_DATA || '.e2e-data')] : [
        demoServer(PORT, process.env.E2E_DATA || '.e2e-data'),
        demoServer(JAN_PORT, '.e2e-data-jan', { FATHOM_CLOCK: '2027-01-05' }),
        demoServer(YP_PORT, ypDataDirLocal, { E2E_EXTERNAL: '1' })
      ]
});
