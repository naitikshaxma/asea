import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { DEFAULT_POLICY_CONFIG } from '@autonomous-engineer/contracts';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { signPayload, verifySignature } from '../../src/services/github/webhookSignature.js';
import { policyConfigHash } from '../../src/services/policy/policyService.js';

// Deliveries are signed exactly like GitHub does (HMAC-SHA256 of the raw body
// with the webhook's secret) and sent through the real Express app.
describe('POST /api/v1/webhooks/github', () => {
  const app = createApp();
  const url = '/api/v1/webhooks/github';
  const secretA = 'secret-of-workspace-a';
  const secretB = 'secret-of-workspace-b';
  const repos = [
    { id: 'repo-a', workspaceId: 'ws-a', githubFullName: 'acme/app', githubWebhookSecret: secretA, workspace: { ownerId: 'owner-a' } },
    { id: 'repo-b', workspaceId: 'ws-b', githubFullName: 'acme/app', githubWebhookSecret: secretB, workspace: { ownerId: 'owner-b' } },
  ];
  let createdTasks: Array<Record<string, any>>;
  let createdRuns: Array<Record<string, any>>;
  let existingTasks: Array<Record<string, any>>;

  const pullRequest = (overrides: Record<string, any> = {}) => ({
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      title: 'Add GET /projects/export',
      body: 'Only authenticated users may export their projects.',
      html_url: 'https://github.com/acme/app/pull/7',
      user: { login: 'dev', type: 'User' },
      labels: [],
      base: { sha: 'a'.repeat(40), ref: 'main' },
      head: { sha: 'b'.repeat(40), ref: 'feature/export' },
    },
    repository: { full_name: 'Acme/App' },
    ...overrides,
  });

  const deliver = (event: string, payload: object | string, secret: string | null = secretA, delivery = 'delivery-1') => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = request(app)
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', delivery);
    if (secret) req.set('X-Hub-Signature-256', signPayload(secret, body));
    return req.send(body);
  };

  beforeEach(() => {
    createdTasks = [];
    createdRuns = [];
    existingTasks = [];
    vi.spyOn(prisma.repository, 'findMany').mockImplementation((async ({ where }: any) =>
      repos.filter((r) => r.githubFullName === where.githubFullName)) as any);
    vi.spyOn(prisma.repository, 'findFirst').mockImplementation((async ({ where }: any) =>
      repos.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null) as any);
    vi.spyOn(prisma.task, 'findFirst').mockImplementation((async ({ where }: any) =>
      existingTasks.find((t) => t.workspaceId === where.workspaceId && t.idempotencyKey === where.idempotencyKey) ?? null) as any);
    vi.spyOn(prisma.policyProfile, 'findFirst').mockImplementation((async ({ where }: any) => ({
      id: `pol-${where.workspaceId}`,
      workspaceId: where.workspaceId,
      name: 'default',
      isDefault: true,
      config: DEFAULT_POLICY_CONFIG,
      configHash: policyConfigHash(DEFAULT_POLICY_CONFIG),
    })) as any);
    const tx = {
      task: {
        create: vi.fn(async ({ data }: any) => {
          const task = { ...data, id: `task-${createdTasks.length + 1}`, createdAt: new Date(), updatedAt: new Date() };
          createdTasks.push(task);
          return task;
        }),
      },
      workflowRun: { create: vi.fn(async ({ data }: any) => ({ id: `run-${data.taskId}`, ...data })) },
      verificationRun: {
        create: vi.fn(async ({ data }: any) => {
          createdRuns.push(data);
          return { id: `vr-${createdRuns.length}`, ...data };
        }),
      },
      outboxEvent: { create: vi.fn(async () => ({ id: 'evt' })) },
    };
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);
    vi.spyOn(prisma.outboxEvent, 'findMany').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies the signature in constant time against the raw body', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature('s', body, signPayload('s', body))).toBe(true);
    expect(verifySignature('s', body, signPayload('other', body))).toBe(false);
    expect(verifySignature('s', Buffer.from('{"a": 1}'), signPayload('s', body))).toBe(false);
    expect(verifySignature('s', body, undefined)).toBe(false);
    expect(verifySignature('s', body, 'sha1=abc')).toBe(false);
    expect(verifySignature('s', body, 'sha256=00')).toBe(false);
  });

  it('starts a verification for a signed pull_request event, in the workspace whose secret signed it', async () => {
    const res = await deliver('pull_request', pullRequest());

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: true,
      verifications: [{ workspaceId: 'ws-a', repositoryId: 'repo-a', taskId: 'task-1', created: true }],
    });
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]).toMatchObject({
      workspaceId: 'ws-a',
      creatorId: 'owner-a',
      repositoryId: 'repo-a',
      title: 'PR #7: Add GET /projects/export',
      description: 'Add GET /projects/export\n\nOnly authenticated users may export their projects.',
      taskType: 'VERIFICATION',
      idempotencyKey: 'github:delivery-1:repo-a',
    });
    expect(createdRuns[0]).toMatchObject({
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      authorType: 'HUMAN',
      requirement: createdTasks[0]!.description,
      github: {
        repository: 'acme/app',
        pullNumber: 7,
        pullUrl: 'https://github.com/acme/app/pull/7',
        baseRef: 'main',
        headRef: 'feature/export',
        deliveryId: 'delivery-1',
        comment: null,
      },
    });
  });

  it('treats a bot author or an AI label as an AI-authored change', async () => {
    const bot = pullRequest();
    bot.pull_request.user = { login: 'copilot[bot]', type: 'Bot' };
    await deliver('pull_request', bot, secretA, 'd-bot');
    const labelled = pullRequest();
    labelled.pull_request.labels = [{ name: 'AI-generated' }] as any;
    await deliver('pull_request', labelled, secretA, 'd-label');
    expect(createdRuns.map((r) => r.authorType)).toEqual(['AI', 'AI']);
  });

  it('rejects a missing, wrong or tampered signature with 401 and creates nothing', async () => {
    expect((await deliver('pull_request', pullRequest(), null)).status).toBe(401);
    expect((await deliver('pull_request', pullRequest(), 'not-the-secret')).status).toBe(401);

    const signedBody = JSON.stringify(pullRequest());
    const tampered = await request(app)
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-tamper')
      .set('X-Hub-Signature-256', signPayload(secretA, signedBody))
      .send(signedBody.replace('feature/export', 'feature/evil'));
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('UNAUTHORIZED');
    expect(createdTasks).toHaveLength(0);
  });

  it('rejects deliveries for repositories nobody connected', async () => {
    const res = await deliver('pull_request', pullRequest({ repository: { full_name: 'someone/else' } }));
    expect(res.status).toBe(401);
    expect(createdTasks).toHaveLength(0);
  });

  it('acknowledges ping and ignores other events and actions with 202', async () => {
    const ping = await deliver('ping', { zen: 'Keep it logically awesome.', repository: { full_name: 'acme/app' } });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ ok: true, repositories: 1 });

    const push = await deliver('push', { ref: 'refs/heads/main', repository: { full_name: 'acme/app' } });
    expect(push.status).toBe(202);
    expect(push.body).toEqual({ accepted: false, reason: "Event 'push' is not used" });

    const closed = await deliver('pull_request', pullRequest({ action: 'closed' }));
    expect(closed.status).toBe(202);
    expect(closed.body.reason).toBe("Action 'closed' does not change the code");
    expect(createdTasks).toHaveLength(0);
  });

  it('returns the existing task when GitHub redelivers the same delivery', async () => {
    existingTasks.push({ id: 'task-earlier', workspaceId: 'ws-a', idempotencyKey: 'github:delivery-1:repo-a', runs: [] });
    const res = await deliver('pull_request', pullRequest());
    expect(res.status).toBe(202);
    expect(res.body.verifications).toEqual([{ workspaceId: 'ws-a', repositoryId: 'repo-a', taskId: 'task-earlier', created: false }]);
    expect(createdTasks).toHaveLength(0);
  });

  it('validates the request', async () => {
    const noHeaders = await request(app).post(url).set('Content-Type', 'application/json').send('{}');
    expect(noHeaders.status).toBe(400);

    const form = await request(app)
      .post(url)
      .set('X-GitHub-Event', 'ping')
      .set('X-GitHub-Delivery', 'd-form')
      .type('form')
      .send('payload=%7B%7D');
    expect(form.status).toBe(400);
    expect(form.body.error.message).toMatch(/application\/json/);

    const malformed = await deliver('pull_request', '{"action": ', secretA);
    expect(malformed.status).toBe(400);

    // Signed, but not a pull_request payload
    const incomplete = await deliver('pull_request', { action: 'opened', repository: { full_name: 'acme/app' } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe('VALIDATION_ERROR');

    const badSha = pullRequest();
    badSha.pull_request.head.sha = 'not-a-sha';
    expect((await deliver('pull_request', badSha)).status).toBe(400);
    expect(createdTasks).toHaveLength(0);
  });
});
