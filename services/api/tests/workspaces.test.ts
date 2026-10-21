import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { generateToken } from '../src/services/authService.js';

describe('Workspace Authorization & Access Control', () => {
  const app = createApp();

  const userAlice = { id: 'user-alice-10', email: 'alice@example.com' };
  const userMallory = { id: 'user-mallory-20', email: 'mallory@attacker.local' };

  const tokenAlice = generateToken({ userId: userAlice.id, email: userAlice.email });
  const tokenMallory = generateToken({ userId: userMallory.id, email: userMallory.email });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authenticated user to create a workspace and sets role to OWNER', async () => {
    const mockCreatedWorkspace = {
      id: 'ws-new-42',
      name: 'Alpha Engineering Team',
      ownerId: userAlice.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const txMock = {
        workspace: { create: vi.fn().mockResolvedValue(mockCreatedWorkspace) },
        workspaceMembership: { create: vi.fn().mockResolvedValue({ id: 'mem-new-42' }) },
      };
      return callback(txMock);
    });

    const res = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${tokenAlice}`)
      .send({ name: 'Alpha Engineering Team' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alpha Engineering Team');
    expect(res.body.role).toBe('OWNER');
  });

  it('denies access to a workspace when user is not a member (Cross-Workspace Isolation)', async () => {
    // Mallory attempts to access Alice's workspace
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/v1/workspaces/ws-alice-private')
      .set('Authorization', `Bearer ${tokenMallory}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('do not have permission');
  });

  it('denies workspace mutation if user has only MEMBER role (Privilege Escalation Defense)', async () => {
    // Alice is MEMBER, not ADMIN or OWNER
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce({
      id: 'mem-10',
      workspaceId: 'ws-shared',
      userId: userAlice.id,
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: 'ws-shared', name: 'Shared Team', ownerId: 'other-user' },
    } as any);

    const res = await request(app)
      .patch('/api/v1/workspaces/ws-shared')
      .set('Authorization', `Bearer ${tokenAlice}`)
      .send({ name: 'Hijacked Workspace Name' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain("Role 'ADMIN' or higher is required");
  });
});
