import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';

// Every Prisma call is stubbed so these tests behave the same whether or not
// a database is reachable.
describe('API Validation and Task Routes', () => {
  const app = createApp();

  const validPayload = {
    title: 'Fix Memory Leak in Ingestion Pipeline',
    description: 'Investigate unbounded buffer retention during high-throughput repository indexing.',
    taskType: 'BUG_INVESTIGATION',
    priority: 'HIGH',
    repositoryUrl: 'https://github.com/my-org/core-indexer',
    targetBranch: 'main',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/v1/tasks persists the task and returns 201', async () => {
    const now = new Date();
    vi.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'user-1' } as any);
    vi.spyOn(prisma.workspace, 'findFirst').mockResolvedValue({ id: 'ws-1' } as any);
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

    const res = await request(app).post('/api/v1/tasks').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('task-1');
    expect(res.body.title).toBe(validPayload.title);
    expect(res.body.taskType).toBe('BUG_INVESTIGATION');
    expect(res.body.status).toBe('QUEUED');
    expect(tx.task.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it('POST /api/v1/tasks returns 500 when the database fails instead of faking success', async () => {
    vi.spyOn(prisma.user, 'findFirst').mockRejectedValue(new Error('connection refused'));

    const res = await request(app).post('/api/v1/tasks').send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('POST /api/v1/tasks rejects invalid payload with 400 and validation details', async () => {
    const invalidPayload = {
      title: 'Hi', // Too short (min 3)
      description: 'Short', // Too short (min 10)
      taskType: 'INVALID_TYPE',
      repositoryUrl: 'not-a-valid-url',
    };

    const res = await request(app).post('/api/v1/tasks').send(invalidPayload);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
    expect(res.body.error).toHaveProperty('details');
    expect(Array.isArray(res.body.error.details)).toBe(true);

    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('title');
    expect(fields).toContain('description');
    expect(fields).toContain('taskType');
    expect(fields).toContain('repositoryUrl');
  });

  it('GET /api/v1/tasks returns task list and total count', async () => {
    const res = await request(app).get('/api/v1/tasks');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tasks');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/tasks/:id returns 404 for non-existent task', async () => {
    vi.spyOn(prisma.task, 'findUnique').mockResolvedValue(null);

    const res = await request(app).get('/api/v1/tasks/non-existent-id-999');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/v1/system/info returns platform metadata and worker boundary status', async () => {
    const res = await request(app).get('/api/v1/system/info');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('platform');
    expect(res.body.phase).toBe(1);
    expect(res.body.services.workerBoundary.arbitraryShellExecutionEnabled).toBe(false);
  });
});
