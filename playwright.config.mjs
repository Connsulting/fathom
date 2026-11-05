// Playwright config for the Fathom end-to-end suite.
// BASE_URL set: run against that server, start nothing locally (smoke receipts).
// BASE_URL unset: start two demo servers through e2e/serve.mjs, the main one and a January one
// whose clock is pinned to 2027-01-05 for e2e/january.spec.mjs.

import { defineConfig } from '@playwright/test';

function portFrom(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65534) throw new Error(`E2E_PORT must be an integer port, got ${value}`);
  return n;
}

const CI = !!process.env.CI;
const BASE_URL = process.env.BASE_URL || '';
const PORT = portFrom(process.env.E2E_PORT, 4173);
const JAN_PORT = PORT + 1;
const baseURL = BASE_URL || `http://127.0.0.1:${PORT}`;
// Specs read this from testInfo.config.metadata.janBaseURL. Empty means no January server, and
// e2e/january.spec.mjs skips. JAN_BASE_URL lets a caller point it at a server of its own.
const janBaseURL = process.env.JAN_BASE_URL || (BASE_URL ? '' : `http://127.0.0.1:${JAN_PORT}`);

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
  metadata: { janBaseURL },
  use: {
    baseURL,
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
    : [
        demoServer(PORT, '.e2e-data'),
        demoServer(JAN_PORT, '.e2e-data-jan', { FATHOM_CLOCK: '2027-01-05' })
      ]
});
