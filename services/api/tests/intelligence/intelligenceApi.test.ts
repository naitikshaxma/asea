import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';

describe('Repository Intelligence API & Security Boundary', () => {
  const app = createApp();

  const userAlice = { id: 'usr-alice-10', email: 'alice@autonomous.dev' };
  const userMallory = { id: 'usr-mallory-20', email: 'mallory@evil.corp' };

  const tokenAlice = generateToken({ userId: userAlice.id, email: userAlice.email });
  const tokenMallory = generateToken({ userId: userMallory.id, email: userMallory.email });

  const workspaceId = 'ws-corp-100';
  const repoId = 'repo-core-500';

  const mockRepo = {
    id: repoId,
    workspaceId,
    name: 'core-indexer',
    provider: 'LOCAL',
    repositoryUrl: process.cwd(),
    defaultBranch: 'main',
    connectionStatus: 'CONNECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated requests to analyze repository with 401', async () => {
    const res = await request(app).post(
      `/api/v1/workspaces/${workspaceId}/repositories/${repoId}/analyze`
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects cross-workspace access to repository intelligence with 403', async () => {
    // Mallory is NOT a member of workspaceId
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/repositories/${repoId}/analyze`)
      .set('Authorization', `Bearer ${tokenMallory}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects requests targeting non-existent repository with 404', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-alice',
      workspaceId,
      userId: userAlice.id,
      role: 'ADMIN',
      createdAt: new Date(),
    } as any);

    vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/repositories/non-existent-repo/analyze`)
      .set('Authorization', `Bearer ${tokenAlice}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('triggers repository analysis and returns completed architecture report', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-alice',
      workspaceId,
      userId: userAlice.id,
      role: 'ADMIN',
      createdAt: new Date(),
    } as any);

    vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue(mockRepo as any);

    const mockAnalysisRecord = {
      id: 'analysis-123',
      repositoryId: repoId,
      workspaceId,
      status: 'PENDING',
      analyzerVersion: '1.0.0',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.repositoryAnalysis, 'create').mockResolvedValue(mockAnalysisRecord as any);

    const mockCompletedRecord = {
      ...mockAnalysisRecord,
      status: 'COMPLETED',
      analyzerVersion: '1.0.0',
      summary: {
        repositoryOverview: 'Analyzed repository',
        entryPoints: ['src/server.ts'],
        keyModules: [],
        apiRoutes: [],
        serviceLocations: ['src/services/authService.ts'],
        modelLocations: [],
        testFrameworks: ['Vitest'],
        testLocations: [],
        configurationLocations: [],
        relationships: [],
        limitations: [],
        confidence: 0.95,
      },
      technologies: [
        {
          name: 'TypeScript',
          category: 'LANGUAGE',
          confidence: 1.0,
          evidenceFiles: ['package.json'],
          rationale: 'TypeScript detected',
        },
      ],
      statistics: {
        totalFiles: 42,
        eligibleFiles: 35,
        skippedFiles: 7,
        totalBytes: 50000,
        durationMs: 120,
        binaryFilesSkipped: 2,
        secretFilesExcluded: 3,
      },
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.repositoryAnalysis, 'update').mockResolvedValue(mockCompletedRecord as any);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/repositories/${repoId}/analyze`)
      .set('Authorization', `Bearer ${tokenAlice}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.technologies.length).toBeGreaterThanOrEqual(1);
    expect(res.body.statistics.eligibleFiles).toBe(35);
  });

  it('ranks relevant files for task query using task-focused retrieval', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-alice',
      workspaceId,
      userId: userAlice.id,
      role: 'MEMBER',
      createdAt: new Date(),
    } as any);

    vi.spyOn(prisma.repository, 'findFirst').mockResolvedValue(mockRepo as any);

    vi.spyOn(prisma.repositoryAnalysis, 'findFirst').mockResolvedValue({
      id: 'analysis-123',
      repositoryId: repoId,
      workspaceId,
      status: 'COMPLETED',
      inventory: [
        { path: 'src/middlewares/authMiddleware.ts', extension: '.ts', sizeBytes: 200, category: 'SOURCE' },
        { path: 'src/services/authService.ts', extension: '.ts', sizeBytes: 500, category: 'SOURCE' },
        { path: 'src/unrelated.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      ],
      summary: {
        repositoryOverview: 'Overview',
        entryPoints: ['src/server.ts'],
        keyModules: [],
        apiRoutes: [],
        serviceLocations: ['src/services/authService.ts'],
        modelLocations: [],
        testFrameworks: [],
        testLocations: [],
        configurationLocations: [],
        relationships: [],
        limitations: [],
        confidence: 1.0,
      },
    } as any);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/repositories/${repoId}/relevant-files`)
      .set('Authorization', `Bearer ${tokenAlice}`)
      .send({
        taskDescription: 'Fix authentication token verification in authMiddleware',
        limit: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results[0].path).toBe('src/middlewares/authMiddleware.ts');
    expect(res.body.results[0].score).toBeGreaterThan(0);
  });

  it('regression security test: unauthenticated GET /api/v1/tasks does NOT expose private workspace tasks', async () => {
    vi.spyOn(prisma.task, 'findMany').mockResolvedValue([
      {
        id: 'task-confidential-99',
        workspaceId: 'private-client-ws',
        title: 'Confidential Proprietary Security Audit',
        description: 'Internal secret analysis',
        taskType: 'BUG_INVESTIGATION',
        status: 'RUNNING',
        priority: 'URGENT',
        targetBranch: 'main',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    // Call without authorization header
    const res = await request(app).get('/api/v1/tasks');

    expect(res.status).toBe(200);
    // Must NOT contain the confidential task
    const taskIds = res.body.tasks.map((t: any) => t.id);
    expect(taskIds).not.toContain('task-confidential-99');
    // Only safe demo bootstrap task returned
    expect(taskIds).toContain('task-demo-01');
  });

  it('regression security test: unauthenticated GET /api/v1/tasks/:id for private task returns 401', async () => {
    vi.spyOn(prisma.task, 'findUnique').mockResolvedValue({
      id: 'task-confidential-99',
      workspaceId: 'private-client-ws',
      title: 'Confidential Task',
      description: 'Secret data',
      taskType: 'BUG_INVESTIGATION',
      status: 'RUNNING',
      priority: 'HIGH',
      targetBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res = await request(app).get('/api/v1/tasks/task-confidential-99');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
