import { defineConfig } from 'vitest/config';

// API-level end-to-end tests. They need the stack running (scripts/e2e/run.mjs
// starts it and sets ASEA_BASE_URL); the files run one at a time.
export default defineConfig({
  test: {
    include: ['api/**/*.e2e.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
