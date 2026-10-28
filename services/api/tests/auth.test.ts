import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { hashPassword, verifyPassword, generateToken } from '../src/services/authService.js';
import { config } from '../src/config.js';
import { authStateStore } from '../src/services/authStateStore.js';
import { createHash } from 'node:crypto';

describe('Authentication & Authorization Endpoints', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies that passwords are securely hashed using bcrypt', async () => {
    const rawPassword = 'superSecurePassword123!';
    const hashed = await hashPassword(rawPassword);

    expect(hashed).not.toBe(rawPassword);
    expect(hashed.startsWith('$2')).toBe(true);

    const matches = await verifyPassword(rawPassword, hashed);
    expect(matches).toBe(true);

    const wrongMatches = await verifyPassword('wrongPassword', hashed);
    expect(wrongMatches).toBe(false);
  });

  it('POST /api/v1/auth/register validates payload and rejects short passwords', async () => {
    const invalidPayload = {
      email: 'user@example.com',
      password: '123', // < 8 characters
      displayName: 'User',
    };

    const res = await request(app).post('/api/v1/auth/register').send(invalidPayload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d: any) => d.field);
    expect(fields).toContain('password');
  });

  it('POST /api/v1/auth/register creates user and default workspace on valid input', async () => {
    const validPayload = {
      email: 'alice@example.com',
      password: 'P@ssword12345!',
      displayName: 'Alice Engineer',
    };

    const mockUser = {
      id: 'user-alice-01',
      email: 'alice@example.com',
      passwordHash: '$2a$10$mockedHashValue',
      displayName: 'Alice Engineer',
      accountStatus: 'ACTIVE' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const txMock = {
        user: { create: vi.fn().mockResolvedValue(mockUser) },
        workspace: { create: vi.fn().mockResolvedValue({ id: 'ws-alice-01', name: "Alice's Workspace" }) },
        workspaceMembership: { create: vi.fn().mockResolvedValue({ id: 'mem-01' }) },
      };
      return callback(txMock);
    });

    const res = await request(app).post('/api/v1/auth/register').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.displayName).toBe('Alice Engineer');
    // S3: the JWT travels only in the HttpOnly cookie, never in the body
    expect(res.body).not.toHaveProperty('token');
    expect(res.headers['set-cookie'][0]).toMatch(/^ae_auth_token=.+; .*HttpOnly/);
  });

  it('POST /api/v1/auth/register rejects duplicate email with 409', async () => {
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
      id: 'existing-id',
      email: 'alice@example.com',
      passwordHash: 'hash',
      displayName: 'Alice',
      accountStatus: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'alice@example.com',
      password: 'P@ssword12345!',
      displayName: 'Alice',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('POST /api/v1/auth/login rejects invalid credentials with generic 401 error', async () => {
    const passwordHash = await hashPassword('the-correct-password');
    vi.spyOn(prisma.user, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'user-known',
        email: 'known@example.com',
        passwordHash,
        displayName: 'Known',
        accountStatus: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const unknownEmail = await request(app).post('/api/v1/auth/login').send({
      email: 'nonexistent@example.com',
      password: 'password123',
    });
    const wrongPassword = await request(app).post('/api/v1/auth/login').send({
      email: 'known@example.com',
      password: 'incorrect-password',
    });

    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.error.code).toBe('UNAUTHORIZED');
    expect(unknownEmail.body.error.message).toBe('Invalid email or password');
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('POST /api/v1/auth/login sets only an HttpOnly cookie, which alone authenticates /me', async () => {
    const userId = 'user-carol-07';
    const passwordHash = await hashPassword('P@ssword12345!');
    vi.spyOn(prisma.user, 'findUnique')
      .mockResolvedValueOnce({
        id: userId,
        email: 'carol@example.com',
        passwordHash,
        displayName: 'Carol',
        accountStatus: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: userId,
        email: 'carol@example.com',
        passwordHash,
        displayName: 'Carol',
        accountStatus: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberships: [],
      } as any);

    const login = await request(app).post('/api/v1/auth/login').send({
      email: 'carol@example.com',
      password: 'P@ssword12345!',
    });

    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(userId);
    expect(login.body).not.toHaveProperty('token');
    const cookie = login.headers['set-cookie'][0];
    expect(cookie).toMatch(/^ae_auth_token=.+; .*HttpOnly/);

    // No Authorization header: the browser client relies on the cookie only
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie.split(';')[0]);

    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(userId);
  });

  it('GET /api/v1/auth/me rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/v1/auth/me returns authenticated user profile and workspaces with valid Bearer token', async () => {
    const testUserId = 'user-bob-99';
    const token = generateToken({ userId: testUserId, email: 'bob@example.com' });

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
      id: testUserId,
      email: 'bob@example.com',
      displayName: 'Bob Architect',
      passwordHash: 'hash',
      accountStatus: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      memberships: [
        {
          id: 'mem-99',
          workspaceId: 'ws-99',
          userId: testUserId,
          role: 'OWNER',
          createdAt: new Date(),
          workspace: {
            id: 'ws-99',
            name: "Bob's Workspace",
            ownerId: testUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
    } as any);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('bob@example.com');
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].name).toBe("Bob's Workspace");
  });

  it('POST /api/v1/auth/logout clears auth cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('revokes the server-side session so a copied cookie stops authenticating after logout', async () => {
    const userId = 'user-revoke-01';
    const passwordHash = await hashPassword('P@ssword12345!');
    vi.spyOn(prisma.user, 'findUnique')
      .mockResolvedValueOnce({
        id: userId,
        email: 'revoke@example.com',
        passwordHash,
        displayName: 'Revoke Test',
        accountStatus: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: userId,
        email: 'revoke@example.com',
        passwordHash,
        displayName: 'Revoke Test',
        accountStatus: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        memberships: [],
      } as any);

    const login = await request(app).post('/api/v1/auth/login').send({
      email: 'revoke@example.com',
      password: 'P@ssword12345!',
    });
    const cookie = (login.headers['set-cookie'][0] as string).split(';')[0];
    expect(login.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', config.CORS_ORIGIN);
    expect(logout.status).toBe(200);

    const replay = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHORIZED');
  });

  it('marks the session cookie Secure by NODE_ENV unless COOKIE_SECURE overrides it', async () => {
    const original = { env: config.NODE_ENV, secure: config.COOKIE_SECURE };
    const logoutCookie = async () => (await request(app).post('/api/v1/auth/logout')).headers['set-cookie'][0] as string;
    try {
      config.NODE_ENV = 'production';
      config.COOKIE_SECURE = undefined;
      expect(await logoutCookie()).toMatch(/; Secure/);

      config.COOKIE_SECURE = 'false'; // production build served over plain HTTP
      expect(await logoutCookie()).not.toMatch(/; Secure/);

      config.NODE_ENV = 'development';
      config.COOKIE_SECURE = 'true';
      expect(await logoutCookie()).toMatch(/; Secure/);
    } finally {
      config.NODE_ENV = original.env;
      config.COOKIE_SECURE = original.secure;
    }
  });

  it('returns the same password-reset response for existing and unknown accounts when delivery is unavailable', async () => {
    const originalMailbox = config.DEV_MAILBOX_TOKEN;
    config.DEV_MAILBOX_TOKEN = undefined;
    try {
      vi.spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce({ id: 'known-user', email: 'known@example.com' } as any)
        .mockResolvedValueOnce(null);
      const known = await request(app).post('/api/v1/auth/password-reset/request').send({ email: 'known@example.com' });
      const unknown = await request(app).post('/api/v1/auth/password-reset/request').send({ email: 'missing@example.com' });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual(unknown.body);
      expect(known.body.message).toContain('If the account can receive');
    } finally { config.DEV_MAILBOX_TOKEN = originalMailbox; }
  });

  it('changes a password only after verifying the current password and revokes every server session', async () => {
    const userId = 'password-change-user';
    const oldHash = await hashPassword('old-password-55');
    let savedHash = '';
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
      id: userId, email: 'password@example.com', passwordHash: oldHash, displayName: 'Password User', accountStatus: 'ACTIVE',
    } as any);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      user: { update: vi.fn().mockImplementation(async ({ data }) => { savedHash = data.passwordHash; return {}; }) },
      passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
    await authStateStore.createSession('password-change-other-session', userId, 60_000);

    const response = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${generateToken({ userId, email: 'password@example.com' })}`)
      .send({ currentPassword: 'old-password-55', newPassword: 'new-password-66' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('password');
    expect(await verifyPassword('new-password-66', savedHash)).toBe(true);
    expect(await authStateStore.getSessionUserId('password-change-other-session')).toBeNull();
  });

  it('consumes a reset token once, hashes the new password, and revokes existing sessions', async () => {
    const userId = 'password-reset-user';
    const rawToken = 'reset-token-value-that-is-only-in-this-test-fixture-123456';
    const resetRecord = {
      id: 'reset-1', userId, tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000), usedAt: null,
      user: { id: userId, email: 'reset@example.com', accountStatus: 'ACTIVE' },
    };
    let savedHash = '';
    vi.spyOn(prisma.passwordResetToken, 'findUnique').mockResolvedValueOnce(resetRecord as any).mockResolvedValueOnce(null);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      passwordResetToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      user: { update: vi.fn().mockImplementation(async ({ data }) => { savedHash = data.passwordHash; return {}; }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
    await authStateStore.createSession('password-reset-existing-session', userId, 60_000);

    const body = { token: rawToken, newPassword: 'reset-password-77' };
    const completed = await request(app).post('/api/v1/auth/password-reset/complete').send(body);
    const replay = await request(app).post('/api/v1/auth/password-reset/complete').send(body);
    expect(completed.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(await verifyPassword('reset-password-77', savedHash)).toBe(true);
    expect(await authStateStore.getSessionUserId('password-reset-existing-session')).toBeNull();
    expect(JSON.stringify(completed.body)).not.toContain(rawToken);
  });
});
