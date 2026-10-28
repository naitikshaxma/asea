import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('cookie request CSRF protection', () => {
  const app = createApp({ CORS_ORIGIN: 'http://localhost:5173' });

  it('rejects unsafe requests from an untrusted browser origin', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://attacker.example')
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects cookie-authenticated unsafe requests without Origin or Referer', async () => {
    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', 'ae_auth_token=untrusted-test-token');

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('Origin is required');
  });

  it('allows requests from the configured web origin', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({});

    // The origin passes CSRF validation and the request reaches payload validation.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('allows native clients without browser cookies and origin headers', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts an allowed Referer when a browser omits Origin', async () => {
    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', 'ae_auth_token=invalid-session')
      .set('Referer', 'http://localhost:5173/settings');

    expect(response.status).toBe(200);
  });
});
