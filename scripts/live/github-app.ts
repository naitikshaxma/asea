// Live GitHub App verification against the real GitHub API.
// Runs the real API (:4000), web dev server (:5173, the App's callback),
// worker and agent service on this host, with run-only tmpfs PostgreSQL and
// Redis containers. Uses credentials from .asea/github-app.env (created by
// scripts/github/create-app.mjs); no secret is printed.
//
// Usage: npm run live:github-app
//   ASEA_LIVE_REPO=owner/name   repository the App is installed on (default naitikshaxma/asea)
//
// You sign in to the local web app once and install the App from Settings, so
// the real OAuth callback links the installation. The script then checks App
// authentication, installation scope, repository linking, the publication gate,
// branch/commit/PR creation and CI-status sync. It closes the PR and deletes the
// branch it created; it never merges.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { GithubAppClient } from '../../services/api/src/services/github/githubAppClient.js';
import { diagnoseCiChecks, summarizeCiChecks } from '../../services/api/src/services/github/publishPatch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = path.join(ROOT, '.asea', 'github-app.env');
const REPO = process.env.ASEA_LIVE_REPO ?? 'naitikshaxma/asea';
const [OWNER, NAME] = REPO.split('/') as [string, string];
const RUN = `asea-gh-${randomBytes(4).toString('hex')}`;
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN}-`));
const LOG_DIR = path.join(RUN_DIR, 'logs');
const REPOS = path.join(RUN_DIR, 'repos');
const WORKSPACES = path.join(RUN_DIR, 'task-workspaces');
const API = 'http://localhost:4000';
const WEB = 'http://localhost:5173';
const children: ChildProcess[] = [];
const containers: string[] = [];
const results: boolean[] = [];
const created: { branch?: string; pull?: number } = {};
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = () => randomBytes(24).toString('hex');
function check(name: string, ok: boolean, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} ${args[0]} failed (${result.status}): ${(result.stderr || '').slice(0, 300)}`);
  return result;
}
function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = ROOT) {
  const log = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log, log], windowsHide: true });
  children.push(child);
}
async function waitFor(label: string, probe: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* not ready */ }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not happen within ${Math.round(timeoutMs / 1000)}s (logs: ${LOG_DIR})`);
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
}
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function loadAppEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) throw new Error(`${path.relative(ROOT, ENV_FILE)} is missing; run node scripts/github/create-app.mjs first`);
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  for (const key of ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET']) {
    if (!values[key]) throw new Error(`${key} is missing from ${path.relative(ROOT, ENV_FILE)}`);
  }
  return values;
}

class Client {
  cookie?: string;
  async request(method: string, url: string, body?: unknown) {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { ...(method !== 'GET' ? { Origin: WEB, 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  get(url: string) { return this.request('GET', url); }
  post(url: string, body: unknown = {}) { return this.request('POST', url, body); }
  put(url: string, body: unknown) { return this.request('PUT', url, body); }
}

async function github(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function main() {
  const app = loadAppEnv();
  for (const port of [4000, 5173]) if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use; the App callback needs the web app on :5173 and its API proxy on :4000`);
  run('docker', ['info', '--format', '{{.ServerVersion}}']);

  // App authentication with its own JWT (also used to find the installation)
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign({ iat: now - 60, exp: now + 540, iss: app.GITHUB_APP_ID }, app.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'), { algorithm: 'RS256' });
  const self = await github(appJwt, 'GET', '/app');
  check('App authenticates with its private key (GET /app)', self.status === 200 && self.body?.slug === app.GITHUB_APP_SLUG, `status ${self.status}, slug ${self.body?.slug}`);
  if (self.status !== 200) return;

  // Disposable infrastructure and the local app
  const [pgPort, redisPort, agentPort] = [await freePort(), await freePort(), await freePort()];
  const pgPassword = secret();
  for (const [name, args] of [
    [`${RUN}-postgres`, ['--tmpfs', '/var/lib/postgresql/data', '-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=asea', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=asea_live', 'postgres:16-alpine']],
    [`${RUN}-redis`, ['--tmpfs', '/data', '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']],
  ] as const) {
    containers.push(name);
    run('docker', ['run', '--detach', '--rm', '--pull=never', '--name', name, '--label', `io.asea.live-run=${RUN}`, ...args]);
  }
  await waitFor('PostgreSQL', () => run('docker', ['exec', `${RUN}-postgres`, 'pg_isready', '-U', 'asea', '-d', 'asea_live'], { allowFailure: true }).status === 0, 60_000);
  const databaseUrl = `postgresql://asea:${pgPassword}@127.0.0.1:${pgPort}/asea_live?schema=public`;
  run(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'services/api/prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: databaseUrl } });

  fs.mkdirSync(REPOS, { recursive: true });
  const checkout = path.join(REPOS, NAME);
  run('git', ['clone', '--quiet', '--depth', '1', `https://github.com/${REPO}.git`, checkout]);

  const internalToken = secret();
  const python = ['services/agent-service/.venv/Scripts/python.exe', 'services/agent-service/.venv/bin/python']
    .map((candidate) => path.join(ROOT, candidate)).find((candidate) => fs.existsSync(candidate)) ?? (process.platform === 'win32' ? 'python' : 'python3');
  start('agent-service', python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'services/agent-service', '--host', '127.0.0.1', '--port', String(agentPort)], {
    ENVIRONMENT: 'test', LLM_PROVIDER: 'fake', MODEL_NAME: '', INTERNAL_SERVICE_TOKEN: internalToken, QDRANT_URL: '',
  });
  const tsx = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
  const appEnv = {
    ...app, NODE_ENV: 'development', PORT: '4000', CORS_ORIGIN: WEB, PUBLIC_WEB_URL: WEB,
    DATABASE_URL: databaseUrl, REDIS_URL: `redis://127.0.0.1:${redisPort}`, AUTH_STATE_STORE: 'redis',
    JWT_SECRET: secret(), COOKIE_SECRET: secret(), COOKIE_SECURE: 'false',
    AI_SERVICE_URL: `http://127.0.0.1:${agentPort}`, INTERNAL_SERVICE_TOKEN: internalToken,
    ALLOWED_REPO_ROOTS: REPOS, TASK_WORKSPACE_ROOT: WORKSPACES, SANDBOX_PROVIDER: 'unavailable', GITHUB_TOKEN: '',
  };
  start('api', process.execPath, [tsx, 'services/api/src/server.ts'], appEnv);
  start('worker', process.execPath, [tsx, 'services/api/src/worker.ts'], appEnv);
  start('web', process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', '5173', '--strictPort', '--host', 'localhost'], {}, path.join(ROOT, 'apps/web'));
  await waitFor('API', async () => (await fetch(`${API}/health`)).ok, 90_000);
  await waitFor('web app', async () => (await fetch(`${WEB}/`)).ok, 90_000);
  await waitFor('agent service', async () => (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok, 60_000);

  // One local account; you sign in with it in the browser to install the App
  const client = new Client();
  const email = `${RUN}@live.asea.invalid`;
  const password = `Live-${secret()}`;
  const registered = await client.post('/api/v1/auth/register', { email, password, displayName: 'ASEA live check' });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status}`);
  const workspaceId = (await client.get('/api/v1/auth/me')).body.workspaces[0].id;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const loginFile = path.join(RUN_DIR, 'login.txt');
  fs.writeFileSync(loginFile, `Email: ${email}\nPassword: ${password}\n`, { mode: 0o600 });
  console.log(`\nACTION  Open ${WEB}/login and sign in with the account in ${loginFile}.`);
  console.log(`        Then Settings → GitHub App → Install, choose "Only select repositories" → ${REPO}, and approve.`);
  console.log('        Waiting up to 15 minutes for the installation to be linked...\n');
  let installation: any;
  await waitFor('the GitHub App installation', async () => {
    installation = (await client.get(`${ws}/github-app`)).body?.installations?.[0];
    return Boolean(installation);
  }, 15 * 60_000, 3000);
  check('installation linked through the real OAuth callback', Boolean(installation?.installationId), `account ${installation?.accountLogin}`);

  // Installation scope
  const appClient = new GithubAppClient({ ...app, GITHUB_API_URL: 'https://api.github.com' } as any);
  const installationId = String(installation.installationId);
  const repos = await appClient.listInstallationRepositories(installationId);
  const names = repos.map((repo) => repo.full_name.toLowerCase());
  check(`installation can access only ${REPO}`, names.length === 1 && names[0] === REPO.toLowerCase(), names.join(', '));
  const token = await appClient.createInstallationToken(installationId);
  const tokenScope = await github(token, 'GET', '/installation/repositories');
  check('installation token is limited to the selected repository', tokenScope.status === 200 && tokenScope.body.total_count === 1, `total ${tokenScope.body?.total_count}`);

  // Repository linking through the API
  const repository = await client.post(`${ws}/repositories`, { name: NAME, provider: 'LOCAL', repositoryUrl: checkout, defaultBranch: 'main' });
  const linked = await client.put(`${ws}/repositories/${repository.body.id}/github-app`, { installationRecordId: installation.id, fullName: REPO });
  check('repository links to the installation', linked.status === 200 && linked.body.githubFullName === REPO.toLowerCase(), `status ${linked.status}`);
  const foreign = await client.put(`${ws}/repositories/${repository.body.id}/github-app`, { installationRecordId: installation.id, fullName: `${OWNER}/asea-not-installed-${RUN}` });
  check('a repository outside the installation is refused', foreign.status === 403, `status ${foreign.status}`);

  // The publication gate refuses a patch whose verification did not pass
  const branchesBefore = (await github(token, 'GET', `/repos/${REPO}/branches?per_page=100`)).body.map((branch: any) => branch.name);
  const task = await client.post(`${ws}/tasks`, { title: 'Live publication gate', description: 'Propose a small change; publication must stay blocked.', taskType: 'CODE_PATCH', priority: 'NORMAL', repositoryId: repository.body.id });
  let current: any;
  await waitFor('the gate task to finish', async () => {
    current = (await client.get(`${ws}/tasks/${task.body.id}`)).body;
    return ['NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(current?.status);
  }, 180_000, 1000);
  const published = await client.post(`${ws}/tasks/${task.body.id}/publish`);
  const branchesAfter = (await github(token, 'GET', `/repos/${REPO}/branches?per_page=100`)).body.map((branch: any) => branch.name);
  check('publishing a blocked patch is refused and writes nothing to GitHub', published.status === 409 && branchesAfter.length === branchesBefore.length,
    `task ${current?.executionMetadata?.status}, publish ${published.status}, branches ${branchesBefore.length}→${branchesAfter.length}`);

  // Branch, commit and PR through the App client
  const main = await appClient.getRef(installationId, OWNER, NAME, 'main');
  const base = await appClient.getCommit(installationId, OWNER, NAME, main.sha);
  const filePath = `docs/live-checks/${RUN}.md`;
  const blob = await appClient.createBlob(installationId, OWNER, NAME, Buffer.from(`ASEA live GitHub App check ${RUN}. Safe to delete; the PR is closed unmerged.\n`).toString('base64'));
  const tree = await appClient.createTree(installationId, OWNER, NAME, base.tree.sha, [{ path: filePath, sha: blob }]);
  const commit = await appClient.createCommit(installationId, OWNER, NAME, `chore: ASEA live App check ${RUN}`, tree, main.sha);
  created.branch = `asea-live-check-${RUN}`;
  await appClient.createRef(installationId, OWNER, NAME, created.branch, commit);
  const pull = await appClient.createPullRequest(installationId, OWNER, NAME, `[ASEA live check] ${RUN} — do not merge`,
    'Created by scripts/live/github-app.ts to verify App branch/commit/PR access. It is closed and its branch deleted automatically.', created.branch, 'main');
  created.pull = pull.number;
  const prView = await github(token, 'GET', `/repos/${REPO}/pulls/${pull.number}`);
  check('App creates a branch, commit and pull request', prView.status === 200 && prView.body.head.sha === commit && prView.body.merged === false,
    `PR #${pull.number} ${prView.body?.html_url}`);

  // CI-status synchronization for the PR head
  let summary: ReturnType<typeof summarizeCiChecks> | undefined;
  await waitFor('CI checks on the PR head', async () => {
    summary = summarizeCiChecks(await appClient.getCiChecks(installationId, OWNER, NAME, commit));
    return summary.status !== 'NOT_CONFIGURED' && summary.status !== 'PENDING';
  }, 15 * 60_000, 15_000).catch(() => undefined);
  const diagnosis = summary ? diagnoseCiChecks(summary.status, summary.checks) : undefined;
  check('CI status is read for the PR head', Boolean(summary) && ['SUCCESS', 'FAILURE'].includes(summary!.status),
    `${summary?.status ?? 'none'} (${summary?.checks.length ?? 0} checks): ${diagnosis?.summary ?? ''}`.slice(0, 220));
}

async function cleanupGithub() {
  if (!created.branch && !created.pull) return;
  try {
    const app = loadAppEnv();
    const appClient = new GithubAppClient({ ...app, GITHUB_API_URL: 'https://api.github.com' } as any);
    const now = Math.floor(Date.now() / 1000);
    const appJwt = jwt.sign({ iat: now - 60, exp: now + 540, iss: app.GITHUB_APP_ID }, app.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'), { algorithm: 'RS256' });
    const installation = await github(appJwt, 'GET', `/repos/${REPO}/installation`);
    const token = await appClient.createInstallationToken(String(installation.body.id));
    if (created.pull) {
      const closed = await github(token, 'PATCH', `/repos/${REPO}/pulls/${created.pull}`, { state: 'closed' });
      check(`cleanup: PR #${created.pull} closed without merging`, closed.status === 200 && closed.body.state === 'closed' && closed.body.merged === false);
    }
    if (created.branch) {
      const deleted = await github(token, 'DELETE', `/repos/${REPO}/git/refs/heads/${created.branch}`);
      const gone = await github(token, 'GET', `/repos/${REPO}/git/ref/heads/${created.branch}`);
      check(`cleanup: branch ${created.branch} deleted`, deleted.status === 204 && gone.status === 404);
    }
  } catch (error) {
    check('cleanup of GitHub test resources', false, error instanceof Error ? error.message : String(error));
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanupGithub();
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  for (const name of containers) spawnSync('docker', ['rm', '--force', name], { windowsHide: true, stdio: 'ignore' });
}
failed ||= results.length === 0 || results.some((ok) => !ok);
if (failed) console.log(`Run directory kept for inspection: ${RUN_DIR}`);
else {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* holds only this run's logs */ }
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
