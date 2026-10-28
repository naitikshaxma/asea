import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/middlewares/authRateLimit.js';

describe('authentication rate limiter', () => {
  it('limits attempts per route and source, then resets after the window', async () => {
    let currentTime = 100_000;
    const app = express();
    const limit = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      now: () => currentTime,
      keyGenerator: () => 'test-client',
    });

    app.post('/auth/login', limit, (_req, res) => res.status(204).end());
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const err = error as { statusCode?: number; code?: string; message?: string };
      res.status(err.statusCode ?? 500).json({ code: err.code, message: err.message });
    });

    const first = await request(app).post('/auth/login');
    const second = await request(app).post('/auth/login');
    const blocked = await request(app).post('/auth/login');

    expect(first.status).toBe(204);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(second.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body.code).toBe('RATE_LIMITED');

    currentTime += 60_000;
    expect((await request(app).post('/auth/login')).status).toBe(204);
  });

  it('uses separate buckets for different authentication routes', async () => {
    const app = express();
    const limit = createRateLimiter({ windowMs: 60_000, max: 1, keyGenerator: () => 'test-client' });
    app.post('/auth/login', limit, (_req, res) => res.sendStatus(204));
    app.post('/auth/register', limit, (_req, res) => res.sendStatus(204));

    expect((await request(app).post('/auth/login')).status).toBe(204);
    expect((await request(app).post('/auth/register')).status).toBe(204);
    expect((await request(app).post('/auth/login')).status).toBe(429);
  });

  it('shares counters between API instances when backed by a shared store', async () => {
    const shared = new Map<string, { count: number; resetAt: number }>();
    const increment = async (key: string, windowMs: number) => {
      const currentTime = Date.now();
      let bucket = shared.get(key);
      if (!bucket || bucket.resetAt <= currentTime) {
        bucket = { count: 0, resetAt: currentTime + windowMs };
        shared.set(key, bucket);
      }
      bucket.count += 1;
      return { count: bucket.count, resetAfterMs: bucket.resetAt - currentTime };
    };
    const makeApp = () => {
      const app = express();
      app.post('/api/v1/auth/login', createRateLimiter({
        windowMs: 60_000,
        max: 1,
        keyGenerator: () => 'same-client',
        increment,
      }), (_req, res) => res.sendStatus(204));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const err = error as { statusCode?: number; code?: string };
        res.status(err.statusCode ?? 500).json({ code: err.code });
      });
      return app;
    };

    const firstInstance = makeApp();
    const secondInstance = makeApp();
    expect((await request(firstInstance).post('/api/v1/auth/login')).status).toBe(204);
    const blocked = await request(secondInstance).post('/api/v1/auth/login');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('fails closed when its shared store is unavailable', async () => {
    const app = express();
    const limit = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      increment: async () => { throw new Error('redis unavailable'); },
    });
    app.post('/auth/login', limit, (_req, res) => res.sendStatus(204));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const err = error as { statusCode?: number; code?: string };
      res.status(err.statusCode ?? 500).json({ code: err.code });
    });

    const response = await request(app).post('/auth/login');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
  });
});
