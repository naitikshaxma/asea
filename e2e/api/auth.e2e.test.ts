import { describe, expect, it } from 'vitest';
import { ApiClient, registerUser } from '../support/api.js';

describe('authentication state through the real Redis-backed API', () => {
  it('rejects a copied cookie after logout revokes its server-side session', async () => {
    const session = await registerUser('session-revocation');
    const copiedClient = new ApiClient();
    copiedClient.cookie = session.client.cookie;

    expect((await copiedClient.get('/api/v1/auth/me')).status).toBe(200);
    expect((await session.client.post('/api/v1/auth/logout')).status).toBe(200);

    const replay = await copiedClient.get('/api/v1/auth/me');
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHORIZED');
  });
});
