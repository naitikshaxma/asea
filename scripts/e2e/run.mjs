#!/usr/bin/env node
// `npm run e2e`: starts the full stack as an isolated compose project
// (asea-e2e, web on :18080 by default), runs the e2e suites against it and
// removes the project and its volumes afterwards.
//
//   E2E_KEEP_STACK=1   leave the stack running afterwards (for debugging)
//   E2E_SKIP_UP=1      reuse a stack that is already running
//   E2E_PORT=18080     web port of the e2e stack
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, compose, ensureEnvFile, stackUp } from '../stack/stack.mjs';

const project = process.env.E2E_PROJECT ?? 'asea-e2e';
// The e2e stack adds a fake GitHub API for the webhook flow
process.env.ASEA_COMPOSE_EXTRA = process.env.ASEA_COMPOSE_EXTRA ?? 'compose.e2e.yaml';
const port = Number(process.env.E2E_PORT ?? 18080);
const { file: envFile } = ensureEnvFile(project, { port });
const env = {
  ...process.env,
  ASEA_BASE_URL: `http://localhost:${port}`,
  ASEA_COMPOSE_PROJECT: project,
  ASEA_COMPOSE_ENV_FILE: envFile,
  ASEA_GITHUB_MOCK_URL: `http://localhost:${process.env.E2E_GITHUB_MOCK_PORT ?? 18099}`,
};

function run(label, command, args, cwd = ROOT) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  const status = result.status ?? 1;
  console.log(`=== ${label}: ${status === 0 ? 'passed' : `FAILED (exit ${status})`} in ${Math.round((Date.now() - started) / 1000)}s ===`);
  return status;
}

let status = 0;
if (process.env.E2E_SKIP_UP !== '1') {
  console.log(`Starting compose project ${project} on port ${port} (first build takes a few minutes)...`);
  const up = stackUp(project, { port });
  if (up.status !== 0) {
    compose(project, ['logs', '--tail', '100']);
    console.error('The stack did not become healthy.');
    status = up.status;
  }
}

const suites = [
  ['API e2e (Vitest)', 'npx', ['vitest', 'run', '--config', 'vitest.config.ts']],
  // Needs a Playwright Chromium build (`npx playwright install chromium`)
  ['UI e2e (Playwright)', 'npx', ['playwright', 'test', '--config', 'playwright.config.ts']],
];
if (status === 0) {
  for (const [label, command, args] of suites) {
    status = run(label, command, args, path.join(ROOT, 'e2e')) || status;
  }
  if (status !== 0) compose(project, ['logs', '--tail', '80', 'api', 'worker', 'agent-service']);
}

if (process.env.E2E_KEEP_STACK === '1') {
  // The extra compose file must be included, or its services (the GitHub mock) keep running
  console.log(`\nStack left running: http://localhost:${port} (stop with: ASEA_COMPOSE_EXTRA=${process.env.ASEA_COMPOSE_EXTRA} node scripts/stack/stack.mjs down --project ${project} --volumes)`);
} else if (process.env.E2E_SKIP_UP !== '1') {
  compose(project, ['down', '-v', '--remove-orphans']);
}
process.exit(status);
