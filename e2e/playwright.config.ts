import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end tests of the built web app against the real API, worker
// and agent service of the stack that scripts/e2e/run.mjs starts.
export default defineConfig({
  testDir: 'ui',
  testMatch: '**/*.ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['ASEA_BASE_URL'] ?? 'http://localhost:18080',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: 'test-results',
});
