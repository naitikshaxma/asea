#!/usr/bin/env node
// Live CODE_PATCH run: the real API, worker and agent service on this host, the
// Docker sandbox, and PostgreSQL/Redis containers created for this run only
// (tmpfs data, unique names, loopback ports). Proposal and review use the
// agent service's deterministic `fake` provider, so no model is called.
//
// Usage: node scripts/live/code-patch-sandbox.mjs
//   SANDBOX_DOCKER_IMAGE   sandbox image to use (default asea/sandbox:2026.10); must exist locally
//   ASEA_LIVE_KEEP=1       keep the run directory (fixture, logs) after a successful run
//
// Teardown removes only the processes, the two containers (by exact name) and
// the temporary directory this run created. It never selects DATABASE_URL or
// REDIS_URL from the environment.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.SANDBOX_DOCKER_IMAGE ?? 'asea/sandbox:2026.10';
const RUN = `asea-live-${randomBytes(4).toString('hex')}`;
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN}-`));
const LOG_DIR = path.join(RUN_DIR, 'logs');
const REPOS = path.join(RUN_DIR, 'repos');
const WORKSPACES = path.join(RUN_DIR, 'task-workspaces');
const PG = `${RUN}-postgres`;
const REDIS = `${RUN}-redis`;
const children = [];
const containers = [];
const results = [];
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

const secret = () => randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function start(name, command, args, env) {
  const log = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', log, log], windowsHide: true });
  children.push(child);
  return child;
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* not ready yet */ }
    await sleep(500);
  }
  throw new Error(`${label} was not ready within ${timeoutMs / 1000}s (logs: ${LOG_DIR})`);
}

function sandboxContainers() {
  const listed = run('docker', ['ps', '--all', '--quiet', '--filter', 'label=io.asea.sandbox=v1'], { allowFailure: true });
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

function writeFixture(name) {
  const repository = path.join(REPOS, name);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  // OSV-Scanner needs a lockfile to report a clean scan; this one matches the live sandbox fixture
  fs.writeFileSync(path.join(repository, 'package-lock.json'), JSON.stringify({
    name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name, version: '1.0.0', dependencies: { lodash: '4.18.0' } },
      'node_modules/lodash': { version: '4.18.0', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.18.0.tgz' },
    },
  }, null, 2));
  fs.writeFileSync(path.join(repository, 'src', 'value.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repository, 'test', 'value.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.js';",
    "test('value stays one', () => assert.equal(value, 1));",
    '',
  ].join('\n'));
  run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository });
  run('git', ['-c', 'user.email=live@asea.invalid', '-c', 'user.name=ASEA live run', 'add', '.'], { cwd: repository });
  run('git', ['-c', 'user.email=live@asea.invalid', '-c', 'user.name=ASEA live run', 'commit', '--quiet', '-m', 'fixture'], { cwd: repository });
  return repository;
}

class Client {
  constructor(base) { this.base = base; this.cookie = undefined; }
  async request(method, url, body) {
    const res = await fetch(`${this.base}${url}`, {
      method,
      headers: {
        ...(method !== 'GET' ? { Origin: this.base, 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  get(url) { return this.request('GET', url); }
  post(url, body = {}) { return this.request('POST', url, body); }
}

async function waitForTask(client, base, taskId, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    task = (await client.get(`${base}/tasks/${taskId}`)).body;
    if (done(task)) return task;
    await sleep(1000);
  }
  return task;
}

function teardown() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  // Only the two containers this run created, by exact name
  for (const name of containers) spawnSync('docker', ['rm', '--force', name], { windowsHide: true, stdio: 'ignore' });
}

async function main() {
  run('docker', ['info', '--format', '{{.ServerVersion}}']);
  run('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
  const [pgPort, redisPort, agentPort, apiPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const pgPassword = secret();

  console.log(`Run ${RUN}: image ${IMAGE}, directory ${RUN_DIR}`);
  containers.push(PG);
  run('docker', ['run', '--detach', '--rm', '--pull=never', '--name', PG, '--label', `io.asea.live-run=${RUN}`,
    '--tmpfs', '/var/lib/postgresql/data', '-p', `127.0.0.1:${pgPort}:5432`,
    '-e', 'POSTGRES_USER=asea', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=asea_live', 'postgres:16-alpine']);
  containers.push(REDIS);
  run('docker', ['run', '--detach', '--rm', '--pull=never', '--name', REDIS, '--label', `io.asea.live-run=${RUN}`,
    '--tmpfs', '/data', '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  await waitFor('PostgreSQL', () => run('docker', ['exec', PG, 'pg_isready', '-U', 'asea', '-d', 'asea_live'], { allowFailure: true }).status === 0, 60_000);
  await waitFor('Redis', () => run('docker', ['exec', REDIS, 'redis-cli', 'ping'], { allowFailure: true }).stdout.trim() === 'PONG', 30_000);

  const databaseUrl = `postgresql://asea:${pgPassword}@127.0.0.1:${pgPort}/asea_live?schema=public`;
  const migrated = run(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'services/api/prisma/schema.prisma'],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, allowFailure: true });
  check('migrations apply to the disposable database', migrated.status === 0, migrated.status === 0 ? '' : (migrated.stderr || '').slice(0, 300));
  if (migrated.status !== 0) return;
  const drift = run(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-url', databaseUrl,
    '--to-schema-datamodel', 'services/api/prisma/schema.prisma', '--exit-code'], { allowFailure: true });
  check('the migrated database matches schema.prisma (no drift)', drift.status === 0, drift.status === 0 ? '' : (drift.stdout || drift.stderr || '').slice(0, 300));

  const repository = writeFixture('app');
  const internalToken = secret();
  const base = `http://127.0.0.1:${apiPort}`;
  const python = fs.existsSync(path.join(ROOT, 'services/agent-service/.venv/Scripts/python.exe'))
    ? path.join(ROOT, 'services/agent-service/.venv/Scripts/python.exe')
    : fs.existsSync(path.join(ROOT, 'services/agent-service/.venv/bin/python'))
      ? path.join(ROOT, 'services/agent-service/.venv/bin/python')
      : process.platform === 'win32' ? 'python' : 'python3';
  start('agent-service', python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'services/agent-service', '--host', '127.0.0.1', '--port', String(agentPort)], {
    ENVIRONMENT: 'test', LLM_PROVIDER: 'fake', MODEL_NAME: '', LLM_API_KEY: '',
    REVIEW_LLM_PROVIDER: 'fake', REVIEW_LLM_API_KEY: 'test-only-placeholder', REVIEW_MODEL_NAME: 'fake-reviewer',
    INTERNAL_SERVICE_TOKEN: internalToken, QDRANT_URL: '',
  });
  const tsx = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
  const appEnv = {
    NODE_ENV: 'development', PORT: String(apiPort), CORS_ORIGIN: base, PUBLIC_WEB_URL: base,
    DATABASE_URL: databaseUrl, REDIS_URL: `redis://127.0.0.1:${redisPort}`, AUTH_STATE_STORE: 'redis',
    JWT_SECRET: secret(), COOKIE_SECRET: secret(), COOKIE_SECURE: 'false',
    AI_SERVICE_URL: `http://127.0.0.1:${agentPort}`, INTERNAL_SERVICE_TOKEN: internalToken,
    ALLOWED_REPO_ROOTS: REPOS, TASK_WORKSPACE_ROOT: WORKSPACES,
    SANDBOX_PROVIDER: 'docker', SANDBOX_DOCKER_IMAGE: IMAGE, SANDBOX_MEMORY_MB: '1024',
    GITHUB_TOKEN: '', GITHUB_APP_ID: '', GITHUB_APP_SLUG: '', GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_WEBHOOK_SECRET: '',
  };
  start('api', process.execPath, [tsx, 'services/api/src/server.ts'], appEnv);
  start('worker', process.execPath, [tsx, 'services/api/src/worker.ts'], appEnv);
  await waitFor('agent service', async () => (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok, 60_000);
  await waitFor('API', async () => (await fetch(`${base}/health`)).ok, 90_000);

  const requester = new Client(base);
  const registered = await requester.post('/api/v1/auth/register', { email: `${RUN}@live.asea.invalid`, password: 'live-Password-123!', displayName: 'Live requester' });
  check('register through the Redis-backed API', registered.status === 201, `status ${registered.status}`);
  const workspaceId = (await requester.get('/api/v1/auth/me')).body.workspaces[0].id;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const repo = await requester.post(`${ws}/repositories`, { name: 'live-app', provider: 'LOCAL', repositoryUrl: repository, defaultBranch: 'main' });
  check('register the authorized local repository', repo.status === 201, `status ${repo.status}`);

  // 1. Full pipeline to a pending approval
  const submitted = await requester.post(`${ws}/tasks`, {
    title: 'Live sandbox patch', description: 'Propose a small safe change to the live fixture repository.',
    taskType: 'CODE_PATCH', priority: 'NORMAL', repositoryId: repo.body.id,
  });
  check('submit a CODE_PATCH task', submitted.status === 201, `status ${submitted.status}`);
  const task = await waitForTask(requester, ws, submitted.body.id, (t) => ['NEEDS_ATTENTION', 'FAILED', 'CANCELLED', 'COMPLETED'].includes(t?.status), 8 * 60_000);
  const meta = task?.executionMetadata ?? {};
  check('worker finishes with a patch awaiting review', task?.status === 'NEEDS_ATTENTION' && task?.failureCode === 'AWAITING_REVIEW',
    `status ${task?.status}, code ${task?.failureCode}, reason ${String(task?.failureReason ?? '').slice(0, 300)}`);
  check('tests, scans and review all PASSED', meta.testStatus === 'PASSED' && meta.securityStatus === 'PASSED' && meta.reviewStatus === 'PASSED',
    `test ${meta.testStatus}, security ${meta.securityStatus}, review ${meta.reviewStatus}`);
  const patch = await requester.get(`${ws}/tasks/${submitted.body.id}/patch`);
  const body = patch.body ?? {};
  check('patch evidence is persisted', patch.status === 200 && body.patchHash === meta.patchHash && body.workspaceCleanupStatus === 'CLEANED'
    && /ASEA deterministic test proposal/.test(body.unifiedDiff ?? '')
    && body.testResults?.commands?.some((command) => command.command?.join(' ') === 'node --test' && command.status === 'PASSED')
    && ['gitleaks', 'semgrep', 'osv-scanner'].every((scanner) => body.securityResults?.tools?.some((tool) => tool.scanner === scanner && tool.status === 'PASSED')),
  `status ${patch.status}, cleanup ${body.workspaceCleanupStatus}, tools ${(body.securityResults?.tools ?? []).map((tool) => `${tool.scanner}:${tool.status}`).join(',')}`);
  const steps = (task?.runs?.[0]?.steps ?? []).map((step) => `${step.stepType}:${step.stepStatus}`);
  check('all workflow steps completed in order', steps.join(' ') === [
    'VALIDATE_CONTEXT', 'INSPECT_REPOSITORY', 'GENERATE_PATCH', 'APPLY_PATCH', 'VERIFY_BOUNDARIES', 'EXECUTE_TESTS', 'STATIC_ANALYSIS', 'INDEPENDENT_REVIEW', 'REQUEST_APPROVAL',
  ].map((step) => `${step}:COMPLETED`).join(' '), steps.join(' '));
  const approvals = await requester.get(`${ws}/approvals?status=PENDING`);
  const approval = (approvals.body?.approvals ?? []).find((entry) => entry.taskId === submitted.body.id);
  check('a PENDING approval is bound to the persisted patch hash', Boolean(approval) && approval.patchHash === body.patchHash, `approvals ${approvals.status}`);
  if (approval) {
    const selfDecision = await requester.post(`${ws}/approvals/${approval.id}/decision`, { decision: 'APPROVED' });
    check('the requester cannot approve their own patch', selfDecision.status === 403, `status ${selfDecision.status}`);
  }
  check('the source checkout is unchanged', run('git', ['status', '--porcelain'], { cwd: repository }).stdout.trim() === ''
    && fs.readFileSync(path.join(repository, 'src', 'value.js'), 'utf8') === 'export const value = 1;\n');
  check('no task workspace or sandbox container remains', fs.readdirSync(WORKSPACES).length === 0 && sandboxContainers().length === 0,
    `workspaces ${fs.readdirSync(WORKSPACES).length}, containers ${sandboxContainers().length}`);

  // 2. Cancellation while a sandbox container is running
  const second = await requester.post(`${ws}/tasks`, {
    title: 'Live sandbox cancellation', description: 'Propose a change, then get cancelled during isolated verification.',
    taskType: 'CODE_PATCH', priority: 'NORMAL', repositoryId: repo.body.id,
  });
  await waitFor('a sandbox container for the second task', () => sandboxContainers().length > 0, 120_000);
  const cancel = await requester.post(`${ws}/tasks/${second.body.id}/cancel`);
  check('cancellation is accepted while the sandbox runs', cancel.status === 200 && cancel.body?.status === 'CANCEL_REQUESTED', `status ${cancel.status} ${cancel.body?.status}`);
  const cancelled = await waitForTask(requester, ws, second.body.id, (t) => ['CANCELLED', 'NEEDS_ATTENTION', 'FAILED', 'COMPLETED'].includes(t?.status), 120_000);
  check('the task ends CANCELLED', cancelled?.status === 'CANCELLED', `status ${cancelled?.status}`);
  const noPatch = await requester.get(`${ws}/tasks/${second.body.id}/patch`);
  check('no patch is persisted for the cancelled task', noPatch.status === 404, `status ${noPatch.status}`);
  await waitFor('sandbox cleanup after cancellation', () => fs.readdirSync(WORKSPACES).length === 0 && sandboxContainers().length === 0, 30_000).catch(() => undefined);
  check('cancellation leaves no workspace or sandbox container', fs.readdirSync(WORKSPACES).length === 0 && sandboxContainers().length === 0,
    `workspaces ${fs.readdirSync(WORKSPACES).length}, containers ${sandboxContainers().length}`);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  teardown();
}
failed ||= results.some((ok) => !ok) || results.length === 0;
if (failed || process.env.ASEA_LIVE_KEEP === '1') {
  console.log(`Run directory kept for inspection: ${RUN_DIR}`);
} else {
  // Killed processes can hold log handles briefly on Windows
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch { console.log(`Could not remove ${RUN_DIR}; it holds only this run's fixture and logs.`); }
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
