import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/services/verification/gitDiff.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/verification/gitDiff.js')>()),
  listBranches: vi.fn(),
}));

import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { config } from '../src/config.js';
import { generateToken } from '../src/services/authService.js';
import { listBranches, VerificationInputError } from '../src/services/verification/gitDiff.js';

describe('GET /workspaces/:ws/repositories/:id/refs', () => {
  const app = createApp();
  const workspaceId = 'ws-refs';
  const token = generateToken({ userId: 'user-refs', email: 'refs@example.com' });
  const url = (repoId: string) => `/api/v1/workspaces/${workspaceId}/repositories/${repoId}/refs`;
  const originalRoots = config.ALLOWED_REPO_ROOTS;
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-refs-'));
    config.ALLOWED_REPO_ROOTS = os.tmpdir();
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-refs',
      workspaceId,
      userId: 'user-refs',
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'Refs', ownerId: 'user-refs' },
    } as any);
    vi.spyOn(prisma.repository, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.id === 'repo-1' && where.workspaceId === workspaceId
        ? { id: 'repo-1', workspaceId, repositoryUrl: repoDir, defaultBranch: 'main' }
        : null) as any);
    vi.mocked(listBranches).mockReset().mockResolvedValue([
      { name: 'main', sha: 'a'.repeat(40), subject: 'Initial', committedAt: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.ALLOWED_REPO_ROOTS = originalRoots;
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const get = (repoId: string) => request(app).get(url(repoId)).set('Authorization', `Bearer ${token}`);

  it('returns the branches of the registered local repository', async () => {
    const res = await get('repo-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repositoryId: 'repo-1',
      defaultBranch: 'main',
      branches: [{ name: 'main', sha: 'a'.repeat(40), subject: 'Initial', committedAt: '2026-10-01T00:00:00.000Z' }],
    });
    expect(listBranches).toHaveBeenCalledWith(fs.realpathSync(repoDir));
  });

  it('returns 400 when the directory is not a git repository', async () => {
    vi.mocked(listBranches).mockRejectedValue(new VerificationInputError('git for-each-ref failed: not a git repository'));
    const res = await get('repo-1');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not a readable git repository/);
  });

  it('returns 404 for a repository in another workspace and requires auth and membership', async () => {
    expect((await get('repo-other')).status).toBe(404);
    expect((await request(app).get(url('repo-1'))).status).toBe(401);
    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await get('repo-1')).status).toBe(403);
    expect(listBranches).not.toHaveBeenCalled();
  });
});
