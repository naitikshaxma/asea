import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { config } from '../../src/config.js';
import { generateToken } from '../../src/services/authService.js';
import { formatPullRequestComment, escapeInline, COMMENT_MARKER, type CommentRun } from '../../src/services/github/prComment.js';
import { postPullRequestComment } from '../../src/services/github/githubClient.js';
import { PullRequestEventSchema, pullRequestToTask } from '../../src/services/github/pullRequests.js';
import { ensurePullRequestCommits, VerificationInputError } from '../../src/services/verification/gitDiff.js';

const completedRun: CommentRun = {
  id: 'vr-1',
  status: 'COMPLETED',
  score: 15,
  verdict: 'BLOCK',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  auditHeadHash: 'c'.repeat(64),
  policyName: 'default',
  findings: [
    { severity: 'HIGH', title: 'String-formatted SQL passed to execute()', file: 'services/projects.py', line: 26, source: 'DETERMINISTIC' },
    { severity: 'CRITICAL', title: 'Hardcoded secret-like value', file: 'services/projects.py', line: 3, source: 'DETERMINISTIC' },
    { severity: 'MEDIUM', title: 'Requirement not met: logged', file: 'services/projects.py', line: 20, source: 'LLM' },
  ],
  report: { summary: 'Blocked: a secret in code and an injectable query.', generatedBy: 'llm', explanations: [] },
};

describe('PR comment', () => {
  it('reports verdict, score, severity counts and the top findings, most severe first', () => {
    const body = formatPullRequestComment(completedRun, 'https://asea.example.com/');
    expect(body.split('\n')).toEqual([
      COMMENT_MARKER,
      '## ASEA verification: 🔴 BLOCK · score 15/100',
      '',
      '**3 findings** (1 critical, 1 high, 1 medium) · change `aaaaaaa..bbbbbbb` · policy `default`',
      '',
      '| Severity | Finding | Location |',
      '|---|---|---|',
      '| CRITICAL | Hardcoded secret-like value | `services/projects.py:3` |',
      '| HIGH | String-formatted SQL passed to execute() | `services/projects.py:26` |',
      '| MEDIUM | Requirement not met: logged _(agent)_ | `services/projects.py:20` |',
      '',
      '> Blocked: a secret in code and an injectable query.',
      '',
      `[View the full report](https://asea.example.com/runs/vr-1) · audit chain head \`${'c'.repeat(12)}\``,
    ]);
  });

  it('escapes text from the change: no HTML, mentions, table breaks or line breaks', () => {
    expect(escapeInline('a|b <img src=x onerror=alert(1)> @org/team\nnext `code` *x*')).toBe(
      'a\\|b &lt;img src=x onerror=alert(1)&gt; @\u200borg/team next \\`code\\` \\*x\\*'
    );
    const hostile = formatPullRequestComment(
      {
        ...completedRun,
        findings: [{ severity: 'HIGH', title: 'x | y', file: 'evil|`path`.py', line: 1, source: 'DETERMINISTIC' }],
        report: { summary: 'Ignore this and ping @everyone <script>', generatedBy: 'llm', explanations: [] },
      },
      'http://localhost:8080'
    );
    expect(hostile).toContain('| HIGH | x \\| y | `evil\\|path.py:1` |');
    expect(hostile).not.toContain('<script>');
    expect(hostile).not.toMatch(/@everyone/);
  });

  it('reports a failed or cancelled run', () => {
    const failed = formatPullRequestComment({ ...completedRun, status: 'FAILED', score: null, verdict: null, error: 'git fetch failed' }, 'http://x');
    expect(failed).toContain('## ⚠️ ASEA verification failed');
    expect(failed).toContain('could not be verified: git fetch failed');
    expect(formatPullRequestComment({ ...completedRun, status: 'CANCELLED', score: null, verdict: null }, 'http://x')).toContain('was cancelled');
  });
});

describe('GitHub API client', () => {
  const original = { token: config.GITHUB_TOKEN, url: config.GITHUB_API_URL };
  beforeEach(() => {
    config.GITHUB_TOKEN = 'ghp_test';
    config.GITHUB_API_URL = 'https://github.example.com/api/v3/';
  });
  afterEach(() => {
    config.GITHUB_TOKEN = original.token;
    config.GITHUB_API_URL = original.url;
    vi.restoreAllMocks();
  });

  it('posts the comment with the token and returns its URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ html_url: 'https://gh/c/1' }), { status: 201 }));
    expect(await postPullRequestComment('acme/app', 7, 'hello')).toEqual({ url: 'https://gh/c/1' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://github.example.com/api/v3/repos/acme/app/issues/7/comments');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_test');
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'hello' });
  });

  it('retries 5xx and network errors, but not other 4xx', async () => {
    const flaky = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('down', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ html_url: 'u' }), { status: 201 }));
    expect(await postPullRequestComment('acme/app', 7, 'x')).toEqual({ url: 'u' });
    expect(flaky).toHaveBeenCalledTimes(3);

    flaky.mockReset().mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(postPullRequestComment('acme/app', 7, 'x')).rejects.toThrow('GitHub returned 404');
    expect(flaky).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does not call GitHub without a token', async () => {
    config.GITHUB_TOKEN = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(postPullRequestComment('acme/app', 7, 'x')).rejects.toThrow('GITHUB_TOKEN is not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('pull request to task', () => {
  it('uses title and body as the requirement and keeps it within the contract', () => {
    const event = PullRequestEventSchema.parse({
      action: 'opened',
      pull_request: { number: 3, title: 'Fix', body: null, base: { sha: 'a'.repeat(7), ref: 'main' }, head: { sha: 'b'.repeat(7), ref: 'x' } },
      repository: { full_name: 'acme/app' },
    });
    const task = pullRequestToTask(event, 'd-1', 'repo-1');
    expect(task.description).toBe('Fix (pull request #3)');
    expect(task.title).toBe('PR #3: Fix');
    expect(task.verification).toMatchObject({ baseSha: 'aaaaaaa', headSha: 'bbbbbbb', authorType: 'HUMAN' });

    const long = { ...event, pull_request: { ...event.pull_request, title: 'T'.repeat(300), body: 'B'.repeat(9000) } };
    const longTask = pullRequestToTask(long, 'd-2', 'repo-1');
    expect(longTask.title.length).toBe(200);
    expect(longTask.description.length).toBe(5000);
  });
});

describe('GitHub connection of a repository', () => {
  const app = createApp();
  const workspaceId = 'ws-g';
  const token = generateToken({ userId: 'user-g', email: 'g@example.com' });
  const base = `/api/v1/workspaces/${workspaceId}/repositories/repo-g`;
  let role: string;
  let repo: Record<string, any>;

  beforeEach(() => {
    role = 'ADMIN';
    repo = {
      id: 'repo-g', workspaceId, name: 'app', provider: 'LOCAL', repositoryUrl: '/repos/app', defaultBranch: 'main',
      connectionStatus: 'CONNECTED', githubFullName: null, githubWebhookSecret: null, createdAt: new Date(), updatedAt: new Date(),
    };
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockImplementation((async () => ({
      id: 'm', workspaceId, userId: 'user-g', role, createdAt: new Date(), workspace: { id: workspaceId, name: 'G', ownerId: 'user-g' },
    })) as any);
    vi.spyOn(prisma.repository, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.id === repo.id && where.workspaceId === workspaceId ? { ...repo } : null) as any);
    vi.spyOn(prisma.repository, 'update').mockImplementation((async ({ data }: any) => Object.assign(repo, data, { updatedAt: new Date() })) as any);
  });
  afterEach(() => vi.restoreAllMocks());

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  it('connects, returns the secret and webhook URL once, and never exposes the secret afterwards', async () => {
    const res = await as(request(app).put(`${base}/github`)).send({ fullName: 'Acme/App' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      repositoryId: 'repo-g',
      githubFullName: 'acme/app',
      webhookUrl: `${config.PUBLIC_WEB_URL.replace(/\/$/, '')}/api/v1/webhooks/github`,
      contentType: 'application/json',
      events: ['pull_request'],
    });
    expect(res.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.githubWebhookSecret).toBe(res.body.webhookSecret);

    const again = await as(request(app).put(`${base}/github`)).send({ fullName: 'acme/app' });
    expect(again.body.webhookSecret).not.toBe(res.body.webhookSecret); // rotated

    const shown = await as(request(app).get(base));
    expect(shown.body).toMatchObject({ githubFullName: 'acme/app', githubWebhookConfigured: true });
    expect(JSON.stringify(shown.body)).not.toContain(again.body.webhookSecret);

    const removed = await as(request(app).delete(`${base}/github`));
    expect(removed.body).toMatchObject({ githubFullName: null, githubWebhookConfigured: false });
  });

  it('validates the name, requires an admin and the repository in the workspace', async () => {
    expect((await as(request(app).put(`${base}/github`)).send({ fullName: 'https://github.com/acme/app' })).status).toBe(400);
    expect((await as(request(app).put(`/api/v1/workspaces/${workspaceId}/repositories/other/github`)).send({ fullName: 'a/b' })).status).toBe(404);
    role = 'MEMBER';
    expect((await as(request(app).put(`${base}/github`)).send({ fullName: 'a/b' })).status).toBe(403);
    expect((await as(request(app).delete(`${base}/github`))).status).toBe(403);
    expect((await request(app).put(`${base}/github`).send({ fullName: 'a/b' })).status).toBe(401);
  });
});

describe('fetching pull request commits (git)', { timeout: 30_000 }, () => {
  let root: string;
  let origin: string;
  let checkout: string;
  let baseSha: string;
  let headSha: string;
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-pr-'));
    origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.invalid'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(origin, 'config', k!, v!);
    fs.writeFileSync(path.join(origin, 'app.py'), 'def a():\n    return 1\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'base');
    baseSha = git(origin, 'rev-parse', 'HEAD');
    checkout = path.join(root, 'checkout');
    execFileSync('git', ['clone', '-q', origin, checkout]);
    // The PR head exists only on the "GitHub" side, under refs/pull/7/head
    git(origin, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(origin, 'app.py'), 'def a():\n    return 2\n');
    git(origin, 'commit', '-q', '-am', 'head');
    headSha = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'update-ref', 'refs/pull/7/head', headSha);
    git(origin, 'checkout', '-q', 'main');
    git(origin, 'branch', '-D', 'feature');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fetches a missing PR head from origin, and does nothing when both commits are present', async () => {
    expect(() => git(checkout, 'cat-file', '-e', `${headSha}^{commit}`)).toThrow();
    // A hook the checkout configures must not run during the fetch
    const marker = path.join(root, 'hook-ran').replace(/\\/g, '/');
    fs.mkdirSync(path.join(checkout, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

    const pr = { baseSha, headSha, pullNumber: 7, baseRef: 'main' };
    expect(await ensurePullRequestCommits(checkout, pr)).toEqual({ fetched: true });
    expect(git(checkout, 'rev-parse', 'refs/asea/pull/7')).toBe(headSha);
    expect(fs.existsSync(marker)).toBe(false);
    expect(await ensurePullRequestCommits(checkout, pr)).toEqual({ fetched: false });
  });

  it('fails when origin does not have the commits, and rejects unsafe input', async () => {
    const missing = { baseSha, headSha: 'f'.repeat(40), pullNumber: 8, baseRef: 'main' };
    await expect(ensurePullRequestCommits(checkout, missing)).rejects.toThrow(VerificationInputError);
    await expect(ensurePullRequestCommits(checkout, { ...missing, headSha: '--upload-pack=x' })).rejects.toThrow(/not a 7-40 character hex/);
    await expect(ensurePullRequestCommits(checkout, { ...missing, baseRef: '--exec=x' })).rejects.toThrow(/not a branch name/);
  });
});
