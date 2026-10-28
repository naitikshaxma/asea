import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { clearDevelopmentMailbox, queueDevelopmentMail } from '../src/services/securityMail.js';

describe('development mail sink', () => {
  const original = { env: config.NODE_ENV, token: config.DEV_MAILBOX_TOKEN };
  beforeEach(() => clearDevelopmentMailbox());
  afterEach(() => {
    config.NODE_ENV = original.env;
    config.DEV_MAILBOX_TOKEN = original.token;
    clearDevelopmentMailbox();
  });

  it('requires the configured bearer token and marks mailbox output non-cacheable', async () => {
    config.NODE_ENV = 'development';
    config.DEV_MAILBOX_TOKEN = 'development-mailbox-secret-123456';
    queueDevelopmentMail({ to: 'user@example.com', subject: 'Reset', text: 'one-time link' });
    const denied = await request(createApp()).get('/api/v1/dev/mailbox');
    const allowed = await request(createApp()).get('/api/v1/dev/mailbox').set('Authorization', 'Bearer development-mailbox-secret-123456');
    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.body.delivery).toBe('development-memory-mailbox');
    expect(allowed.body.messages).toHaveLength(1);
  });

  it('never enables the development sink in production', async () => {
    config.NODE_ENV = 'production';
    config.DEV_MAILBOX_TOKEN = 'development-mailbox-secret-123456';
    expect(queueDevelopmentMail({ to: 'user@example.com', subject: 'Reset', text: 'link' })).toBe(false);
    const response = await request(createApp()).get('/api/v1/dev/mailbox').set('Authorization', 'Bearer development-mailbox-secret-123456');
    expect(response.status).toBe(404);
  });
});
