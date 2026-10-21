import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import * as dbService from '../src/services/db.js';
import * as redisService from '../src/services/redis.js';

describe('API Health and Readiness Endpoints', () => {
  const app = createApp();

  it('GET /health returns 200 and process status', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('service', '@autonomous-engineer/api');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.headers).toHaveProperty('x-request-id');
    expect(res.headers).toHaveProperty('x-api-version', 'v1');
  });

  it('GET /ready reports readiness structure and dependency results', async () => {
    const res = await request(app).get('/ready');

    // By default in dev without POSTGRES_REQUIRED_FOR_READINESS, it returns 200
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('dependencies');
    expect(res.body.dependencies).toHaveProperty('postgres');
    expect(res.body.dependencies).toHaveProperty('redis');
  });

  it('GET /ready returns 503 when a required dependency fails', async () => {
    vi.spyOn(dbService, 'checkPostgresHealth').mockResolvedValueOnce({
      status: 'down',
      message: 'Connection refused',
      error: 'ECONNREFUSED',
    });

    // Create app with postgres required
    const strictApp = createApp({
      POSTGRES_REQUIRED_FOR_READINESS: true,
    });

    const res = await request(strictApp).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.dependencies.postgres.status).toBe('down');
  });

  it('GET /unmatched-path returns 404 with standardized error envelope', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
    expect(res.body.error).toHaveProperty('timestamp');
  });
});
