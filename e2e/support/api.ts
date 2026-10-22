import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared helpers for the e2e suites. The runner (scripts/e2e/run.mjs) sets
// ASEA_BASE_URL and the compose project/env file of the stack under test.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BASE_URL = process.env['ASEA_BASE_URL'] ?? 'http://localhost:18080';
export const DEMO_REPO_PATH = '/repos/demo_app';

export interface DemoCase {
  case: string;
  branch: string;
  title: string;
  requirement: string;
  expectedVerdict: 'ALLOW' | 'REVIEW' | 'HIGH_RISK' | 'BLOCK';
}
export const DEMO_CASES: DemoCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/demo/cases.json'), 'utf8'));

export function expectedFindings(caseName: string): Array<{ rule_id: string; severity: string; file: string; line: number }> {
  const file = path.join(ROOT, 'services/agent-service/tests/fixtures/diffs', `${caseName}.expected_findings.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A user agent with its own session cookie. */
export class ApiClient {
  cookie: string | undefined;

  async request<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await fetch(`${BASE_URL}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', url, body ?? {}, headers);
  }
  patch<T = any>(url: string, body: unknown) {
    return this.request<T>('PATCH', url, body);
  }
  delete<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }
}

export interface Session {
  client: ApiClient;
  user: { id: string; email: string; displayName: string };
  workspaceId: string;
  password: string;
}

/** Registers a fresh user (with their default workspace) and returns a signed-in client. */
export async function registerUser(label: string): Promise<Session> {
  const client = new ApiClient();
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.asea.invalid`;
  const password = 'e2e-Password-123!';
  const reg = await client.post('/api/v1/auth/register', { email, password, displayName: `E2E ${label}` });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const me = await client.get('/api/v1/auth/me');
  return { client, user: me.body.user, workspaceId: me.body.workspaces[0].id, password };
}

export async function addDemoRepository(session: Session, name = 'demo_app'): Promise<string> {
  const res = await session.client.post(`/api/v1/workspaces/${session.workspaceId}/repositories`, {
    name,
    provider: 'LOCAL',
    repositoryUrl: DEMO_REPO_PATH,
    defaultBranch: 'main',
  });
  if (res.status !== 201) throw new Error(`add repository failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function branchShas(session: Session, repositoryId: string): Promise<Record<string, string>> {
  const res = await session.client.get(`/api/v1/workspaces/${session.workspaceId}/repositories/${repositoryId}/refs`);
  if (res.status !== 200) throw new Error(`refs failed: ${res.status} ${JSON.stringify(res.body)}`);
  return Object.fromEntries(res.body.branches.map((b: { name: string; sha: string }) => [b.name, b.sha]));
}

export async function submitVerification(
  session: Session,
  input: { repositoryId: string; baseSha: string; headSha: string; title: string; requirement: string; policyProfileId?: string }
) {
  return session.client.post(`/api/v1/workspaces/${session.workspaceId}/tasks`, {
    title: input.title,
    description: input.requirement,
    taskType: 'VERIFICATION',
    repositoryId: input.repositoryId,
    verification: {
      baseSha: input.baseSha,
      headSha: input.headSha,
      authorType: 'AI',
      ...(input.policyProfileId ? { policyProfileId: input.policyProfileId } : {}),
    },
  });
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Polls the task's verification run until it reaches a terminal status. */
export async function waitForRun(session: Session, taskId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const res = await session.client.get(`/api/v1/workspaces/${session.workspaceId}/verification-runs?taskId=${taskId}`);
    last = res.body?.verificationRuns?.[0];
    if (last && TERMINAL.has(last.status)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`verification run of task ${taskId} did not finish in ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}

/** Runs SQL in the stack's Postgres (used to simulate tampering). Returns psql's unaligned output. */
export function psql(sql: string): string {
  const project = process.env['ASEA_COMPOSE_PROJECT'] ?? 'asea-e2e';
  const envFile = process.env['ASEA_COMPOSE_ENV_FILE'] ?? path.join(ROOT, '.asea', `${project}.env`);
  const result = spawnSync(
    'docker',
    ['compose', '-p', project, '-f', path.join(ROOT, 'compose.stack.yaml'), '--env-file', envFile,
      'exec', '-T', 'postgres', 'psql', '-U', 'asea', '-d', 'asea', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr}`);
  return result.stdout.trim();
}
