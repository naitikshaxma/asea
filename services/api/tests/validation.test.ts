import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { generateToken } from '../src/services/authService.js';
import { Prisma } from '@prisma/client';
import { DEFAULT_POLICY_CONFIG } from '@autonomous-engineer/contracts';
import { policyConfigHash } from '../src/services/policy/policyService.js';

// Every Prisma call is stubbed so these tests behave the same whether or not
// a database is reachable.
describe('API Validation and Task Routes', () => {
  const app = createApp();
  const workspaceId = 'ws-val-01';
  const user = { id: 'user-val-01', email: 'val@example.com' };
  const token = generateToken({ userId: user.id, email: user.email });

  const validPayload = {
    title: 'Fix Memory Leak in Ingestion Pipeline',
    description: 'Investigate unbounded buffer retention during high-throughput repository indexing.',
    taskType: 'CODE_PATCH',
    priority: 'HIGH',
    repositoryId: 'repo-val-01',
    repositoryUrl: 'https://github.com/my-org/core-indexer',
    targetBranch: 'main',
  };

  function mockMembership() {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-val-01',
      workspaceId,
      userId: user.id,
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'Validation WS', ownerId: user.id },
    } as any);
    vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue({ id: 'repo-val-01', workspaceId } as any);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('POST /workspaces/:id/tasks persists the task and returns 201', async () => {
    const now = new Date();
    mockMembership();
    vi.spyOn(prisma.outboxEvent, 'findMany').mockResolvedValue([]);

    const tx = {
      task: {
        create: vi.fn().mockImplementation(async ({ data }) => ({
          ...data,
          id: 'task-1',
          createdAt: now,
          updatedAt: now,
        })),
      },
      workflowRun: {
        create: vi.fn().mockResolvedValue({
          id: 'run-1',
          taskId: 'task-1',
          attemptNumber: 1,
          status: 'QUEUED',
        }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'evt-1' }) },
    };
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('task-1');
    expect(res.body.workspaceId).toBe(workspaceId);
    expect(res.body.creatorId).toBe(user.id);
    expect(res.body.status).toBe('QUEUED');
    expect(tx.task.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  describe('VERIFICATION tasks', () => {
    const verificationPayload = {
      title: 'Verify export endpoint',
      description: 'Only authenticated users may export projects.',
      taskType: 'VERIFICATION',
      repositoryId: 'repo-val-01',
      verification: { baseSha: 'a1b2c3d', headSha: 'b'.repeat(40), authorType: 'AI' },
    };

    function stubTransaction() {
      const now = new Date();
      const tx = {
        task: { create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, id: 'task-v', createdAt: now, updatedAt: now })) },
        workflowRun: { create: vi.fn().mockResolvedValue({ id: 'run-v', taskId: 'task-v', attemptNumber: 1, status: 'QUEUED' }) },
        verificationRun: { create: vi.fn().mockResolvedValue({ id: 'vr-1' }) },
        outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'evt-v' }) },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(tx)) as any);
      vi.spyOn(prisma.outboxEvent, 'findMany').mockResolvedValue([]);
      return tx;
    }

    const submit = (body: object) =>
      request(app).post(`/api/v1/workspaces/${workspaceId}/tasks`).set('Authorization', `Bearer ${token}`).send(body);

    const defaultHash = policyConfigHash(DEFAULT_POLICY_CONFIG);
    const strictConfig = { ...DEFAULT_POLICY_CONFIG, verdict_bands: { allow: 95, review: 80, high_risk: 50, block: 0 } };
    const profiles = [
      { id: 'pol-default', workspaceId, name: 'default', isDefault: true, config: DEFAULT_POLICY_CONFIG, configHash: defaultHash },
      { id: 'pol-strict', workspaceId, name: 'strict', isDefault: false, config: strictConfig, configHash: policyConfigHash(strictConfig) },
    ];
    function stubPolicies() {
      vi.spyOn(prisma.policyProfile, 'findFirst').mockImplementation((async ({ where }: any) =>
        profiles.find(
          (p) => p.workspaceId === where.workspaceId && (where.id ? p.id === where.id : p.isDefault === where.isDefault)
        ) ?? null) as any);
    }

    it('creates a QUEUED VerificationRun with the inputs and the default policy snapshot in the task transaction', async () => {
      mockMembership();
      stubPolicies();
      vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue({ id: 'repo-val-01', workspaceId } as any);
      const tx = stubTransaction();

      const res = await submit(verificationPayload);

      expect(res.status).toBe(201);
      expect(res.body.taskType).toBe('VERIFICATION');
      expect(tx.verificationRun.create).toHaveBeenCalledWith({
        data: {
          workspaceId,
          repositoryId: 'repo-val-01',
          taskId: 'task-v',
          baseSha: 'a1b2c3d',
          headSha: 'b'.repeat(40),
          requirement: verificationPayload.description,
          authorType: 'AI',
          policyProfileId: 'pol-default',
          policyHash: defaultHash,
          policySnapshot: DEFAULT_POLICY_CONFIG,
          status: 'QUEUED',
        },
      });
    });

    it('snapshots an explicitly chosen policy profile and rejects one from another workspace', async () => {
      mockMembership();
      stubPolicies();
      vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue({ id: 'repo-val-01', workspaceId } as any);
      const tx = stubTransaction();

      const chosen = await submit({ ...verificationPayload, verification: { ...verificationPayload.verification, policyProfileId: 'pol-strict' } });
      expect(chosen.status).toBe(201);
      expect(tx.verificationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          policyProfileId: 'pol-strict',
          policyHash: policyConfigHash(strictConfig),
          policySnapshot: strictConfig,
        }),
      });

      tx.verificationRun.create.mockClear();
      const foreign = await submit({ ...verificationPayload, verification: { ...verificationPayload.verification, policyProfileId: 'pol-elsewhere' } });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error.message).toMatch(/policy profile does not belong/);
      expect(tx.verificationRun.create).not.toHaveBeenCalled();
    });

    it('refuses a policy profile whose stored config no longer matches its hash', async () => {
      mockMembership();
      vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue({ id: 'repo-val-01', workspaceId } as any);
      vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue({ ...profiles[0], configHash: 'f'.repeat(64) } as any);
      const tx = stubTransaction();

      const res = await submit(verificationPayload);
      expect(res.status).toBe(500);
      expect(tx.verificationRun.create).not.toHaveBeenCalled();
    });

    it('requires repositoryId and verification inputs, with hex SHAs', async () => {
      mockMembership();
      const res = await submit({ ...verificationPayload, repositoryId: undefined, verification: undefined });
      expect(res.status).toBe(400);
      const fields = res.body.error.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['repositoryId', 'verification']));

      const badSha = await submit({ ...verificationPayload, verification: { baseSha: 'main', headSha: 'HEAD' } });
      expect(badSha.status).toBe(400);
    });

    it('rejects verification inputs on other task types and repositories from other workspaces', async () => {
      mockMembership();
      const other = await submit({ ...verificationPayload, taskType: 'CODE_REVIEW' });
      expect(other.status).toBe(400);

      vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue(null);
      const tx = stubTransaction();
      const foreign = await submit(verificationPayload);
      expect(foreign.status).toBe(400);
      expect(tx.verificationRun.create).not.toHaveBeenCalled();
    });
  });

  it('POST /workspaces/:id/tasks returns the existing task for a reused idempotency key, also when two requests race (B10)', async () => {
    mockMembership();
    const now = new Date();
    const earlier = { id: 'task-earlier', workspaceId, idempotencyKey: 'key-1', title: 't', description: 'd', taskType: 'BUG_INVESTIGATION', priority: 'NORMAL', status: 'QUEUED', createdAt: now, updatedAt: now, runs: [] };
    // First lookup finds nothing; the create loses the race on the unique key; the second lookup finds the winner
    const findFirst = vi.spyOn(prisma.task, 'findFirst').mockResolvedValueOnce(null).mockResolvedValueOnce(earlier as any);
    vi.spyOn(prisma, '$transaction').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on (workspaceId, idempotencyKey)', { code: 'P2002', clientVersion: 'test' })
    );

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, idempotencyKey: 'key-1' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('task-earlier');
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId, idempotencyKey: 'key-1' }, include: { runs: true } });
  });

  it('POST /workspaces/:id/tasks returns 500 when the database fails instead of faking success', async () => {
    mockMembership();
    vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('connection refused'));

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('POST /workspaces/:id/tasks rejects task types without a workflow before persisting anything', async () => {
    mockMembership();
    const transaction = vi.spyOn(prisma, '$transaction');
    for (const taskType of ['BUG_INVESTIGATION', 'TEST_GENERATION', 'CODE_REVIEW', 'CI_DIAGNOSIS']) {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/tasks`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validPayload, taskType });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const detail = res.body.error.details.find((d: { field: string }) => d.field === 'taskType');
      expect(detail.message).toMatch(/no workflow yet.*CODE_PATCH, VERIFICATION/);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('POST /workspaces/:id/tasks requires an explicit task type and a repository for CODE_PATCH', async () => {
    mockMembership();
    const { taskType: _omitted, ...untyped } = validPayload;
    const missingType = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(untyped);
    expect(missingType.status).toBe(400);
    expect(missingType.body.error.details.map((d: { field: string }) => d.field)).toContain('taskType');

    const { repositoryId: _repo, ...unlinked } = validPayload;
    const missingRepository = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(unlinked);
    expect(missingRepository.status).toBe(400);
    expect(missingRepository.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'repositoryId', message: 'Required for CODE_PATCH tasks' })])
    );
  });

  it('POST /workspaces/:id/tasks rejects invalid payload with 400 and validation details', async () => {
    mockMembership();
    const invalidPayload = {
      title: 'Hi', // Too short (min 3)
      description: 'Short', // Too short (min 10)
      taskType: 'INVALID_TYPE',
      repositoryUrl: 'not-a-valid-url',
    };

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(invalidPayload);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);

    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('title');
    expect(fields).toContain('description');
    expect(fields).toContain('taskType');
    expect(fields).toContain('repositoryUrl');
  });

  it('GET /workspaces/:id/tasks rejects unknown status and taskType filters with 400 instead of querying', async () => {
    mockMembership();
    const findMany = vi.spyOn(prisma.task, 'findMany');
    for (const query of ['status=DONE', 'status=PENDING', 'taskType=NOT_A_TYPE', 'status=QUEUED&taskType=bogus']) {
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/tasks?${query}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('GET /workspaces/:id/tasks passes valid filters, including types no longer submittable', async () => {
    mockMembership();
    const findMany = vi.spyOn(prisma.task, 'findMany').mockResolvedValue([]);
    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/tasks?status=NEEDS_ATTENTION&taskType=BUG_INVESTIGATION`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: [], total: 0 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId, status: 'NEEDS_ATTENTION', taskType: 'BUG_INVESTIGATION' },
    }));
  });

  it('GET /workspaces/:id/tasks/:taskId does not invent executionMetadata when none is stored', async () => {
    mockMembership();
    vi.spyOn(prisma.task, 'findFirst').mockResolvedValue({
      id: 'task-2',
      workspaceId,
      creatorId: user.id,
      title: validPayload.title,
      description: validPayload.description,
      taskType: 'BUG_INVESTIGATION',
      priority: 'NORMAL',
      status: 'QUEUED',
      executionMetadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      runs: [],
    } as any);

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/tasks/task-2`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('executionMetadata');
    expect(JSON.stringify(res.body)).not.toMatch(/sandboxType|worker-bullmq-01/);
  });

  it('redacts persisted task execution evidence before returning task and patch API responses', async () => {
    const secret = 'ASEA_API_RESPONSE_SYNTHETIC_SECRET_62be17aa';
    vi.stubEnv('ASEA_API_TEST_SECRET', secret);
    mockMembership();
    vi.spyOn(prisma.taskPatch, 'findFirst').mockResolvedValue({
      id: 'patch-1', taskId: 'task-2', workflowRunId: 'run-2', snapshotHash: 'a'.repeat(64), patchHash: 'b'.repeat(64),
      summary: 'fixture', plan: [], evidence: [], contextFiles: [], changedFiles: [], unifiedDiff: `+const token = '${secret}';`,
      testStatus: 'FAILED', testResults: { status: 'FAILED', commands: [{ stdout: `printed ${secret}`, stderr: `API_TOKEN=${secret}` }] },
      securityStatus: 'FAILED', securityResults: { tools: [{ findings: [{ message: `scanner: ${secret}` }] }] },
      reviewStatus: 'UNAVAILABLE', reviewResults: { summary: `review error: ${secret}` }, sandboxDiagnostics: { message: `diagnostic: ${secret}` },
      workspaceCleanupStatus: 'CLEANED', status: 'PROPOSED', publicationStatus: 'NOT_PUBLISHED', publicationError: null,
      publishedBranch: null, githubCommitSha: null, pullRequestNumber: null, pullRequestUrl: null, publishedAt: null,
      ciStatus: 'NOT_RUN', ciChecks: [], ciDiagnosis: null, ciSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
    } as any);

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/tasks/task-2/patch`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).toContain('[REDACTED]');
  });

  it('POST /workspaces/:id/tasks rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post(`/api/v1/workspaces/${workspaceId}/tasks`).send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // S1 regression: the unauthenticated legacy task routes and /system/info are gone
  it.each([
    ['POST', '/api/v1/tasks'],
    ['GET', '/api/v1/tasks'],
    ['GET', '/api/v1/tasks/some-task-id'],
    ['GET', '/api/v1/system/info'],
  ])('%s %s no longer exists (404)', async (method, url) => {
    const createSpy = vi.spyOn(prisma.task, 'create');
    const req = method === 'POST' ? request(app).post(url).send(validPayload) : request(app).get(url);

    const res = await req;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(createSpy).not.toHaveBeenCalled();
  });
});
