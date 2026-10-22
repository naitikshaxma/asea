import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { hashPassword, verifyPassword, generateToken } from '../src/services/authService.js';
import { config } from '../src/config.js';

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
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'nonexistent@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid email or password');
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
});
