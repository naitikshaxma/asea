import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('API Validation and Task Routes', () => {
  const app = createApp();

  it('POST /api/v1/tasks accepts valid task input and returns 201', async () => {
    const payload = {
      title: 'Fix Memory Leak in Ingestion Pipeline',
      description: 'Investigate unbounded buffer retention during high-throughput repository indexing.',
      taskType: 'BUG_INVESTIGATION',
      priority: 'HIGH',
      repositoryUrl: 'https://github.com/my-org/core-indexer',
      targetBranch: 'main',
    };

    const res = await request(app).post('/api/v1/tasks').send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.title).toBe(payload.title);
    expect(res.body.taskType).toBe('BUG_INVESTIGATION');
    expect(res.body.status).toBe('PENDING');
    expect(res.body).toHaveProperty('executionMetadata');
    expect(res.body.executionMetadata.note).toContain('Phase 2');
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
