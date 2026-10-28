import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';
import { authStateStore } from '../../src/services/authStateStore.js';
import { config } from '../../src/config.js';
import { GithubAppClient } from '../../src/services/github/githubAppClient.js';

describe('GitHub App workspace routes', () => {
  const app = createApp();
  const workspaceId = 'ws-github-app';
  const userId = 'user-github-app';
  const token = generateToken({ userId, email: 'member@example.com' });
  const configuredApp = createApp({
    GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'asea', GITHUB_APP_CLIENT_ID: 'client', GITHUB_APP_CLIENT_SECRET: 'secret',
    GITHUB_APP_PRIVATE_KEY: 'test-private-key', GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
  });
  let role = 'ADMIN';

  const as = (test: request.Test) => test.set('Authorization', `Bearer ${token}`);

  beforeEach(() => {
    role = 'ADMIN';
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockImplementation((async () => ({
      id: 'membership', workspaceId, userId, role, createdAt: new Date(),
      workspace: { id: workspaceId, name: 'Workspace', ownerId: userId },
    })) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reports the configured state without returning credentials', async () => {
    vi.spyOn(prisma.githubAppInstallation, 'findMany').mockResolvedValue([]);
    const response = await as(request(app).get(`/api/v1/workspaces/${workspaceId}/github-app`));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: false, appSlug: null, installations: [] });
    expect(JSON.stringify(response.body)).not.toMatch(/private.?key|token/i);
  });

  it('fails closed when publication has not passed sandbox and security checks', async () => {
    vi.spyOn(prisma.taskPatch, 'findFirst').mockResolvedValue({
      id: 'patch', taskId: 'task', patchHash: 'a'.repeat(64), status: 'APPROVED',
      testStatus: 'NOT_RUN', securityStatus: 'BOUNDARY_VALIDATED_NO_SCAN', publicationStatus: 'NOT_PUBLISHED',
      task: { status: 'NEEDS_ATTENTION', executionMetadata: { patchHash: 'a'.repeat(64) }, taskType: 'CODE_PATCH', repository: { githubFullName: 'acme/app', githubAppInstallationId: 'installation' } },
    } as any);
    const installationLookup = vi.spyOn(prisma.githubAppInstallation, 'findFirst').mockResolvedValue(null);
    const response = await as(request(app).post(`/api/v1/workspaces/${workspaceId}/tasks/task/publish`).send({}));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('passing sandbox tests');
    expect(installationLookup).not.toHaveBeenCalled();
  });

  it('refuses publication until independent review has passed even when tests and scanners passed', async () => {
    vi.spyOn(prisma.taskPatch, 'findFirst').mockResolvedValue({
      id: 'patch-reviewed', taskId: 'task', patchHash: 'c'.repeat(64), status: 'APPROVED',
      testStatus: 'PASSED', securityStatus: 'PASSED', reviewStatus: 'UNAVAILABLE', publicationStatus: 'NOT_PUBLISHED',
      task: { status: 'NEEDS_ATTENTION', executionMetadata: { patchHash: 'c'.repeat(64) }, taskType: 'CODE_PATCH', repository: { githubFullName: 'acme/app', githubAppInstallationId: 'installation' } },
    } as any);
    const installationLookup = vi.spyOn(prisma.githubAppInstallation, 'findFirst').mockResolvedValue(null);
    const response = await as(request(app).post(`/api/v1/workspaces/${workspaceId}/tasks/task/publish`).send({}));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('independent review');
    expect(installationLookup).not.toHaveBeenCalled();
  });

  it('does not provide install URLs when the server has no GitHub App credentials', async () => {
    const response = await as(request(app).get(`/api/v1/workspaces/${workspaceId}/github-app/install-url`));
    expect(response.status).toBe(503);
    expect(response.body.error.message).toContain('not configured');
  });

  it('requires admin role to initiate an installation', async () => {
    role = 'MEMBER';
    const response = await as(request(app).get(`/api/v1/workspaces/${workspaceId}/github-app/install-url`));
    expect(response.status).toBe(403);
  });

  it('persists CI status and an annotation-backed failure diagnosis', async () => {
    const patch = {
      id: 'patch-ci', taskId: 'task-ci', patchHash: 'b'.repeat(64), publicationStatus: 'PR_OPEN',
      githubCommitSha: 'a'.repeat(40), ciStatus: 'PENDING',
      task: { repository: { githubFullName: 'acme/app', githubAppInstallationId: 'installation-record' } },
    };
    vi.spyOn(prisma.taskPatch, 'findFirst').mockResolvedValue(patch as any);
    vi.spyOn(prisma.githubAppInstallation, 'findFirst').mockResolvedValue({
      id: 'installation-record', workspaceId, installationId: '99', accountLogin: 'acme', accountType: 'Organization',
    } as any);
    vi.spyOn(GithubAppClient.prototype, 'getCiChecks').mockResolvedValue([{
      name: 'typecheck', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/app/actions/runs/1',
      annotations: [{ path: 'src/api.ts', startLine: 18, endLine: 18, level: 'failure', title: 'Type error', message: 'Invalid type' }],
    }]);
    const update = vi.spyOn(prisma.taskPatch, 'update').mockImplementation((async ({ data }: any) => ({
      ...patch, ...data,
    })) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockResolvedValue({ id: 'audit' } as any);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: any) => callback(prisma)) as any);

    const response = await as(request(configuredApp).post(`/api/v1/workspaces/${workspaceId}/tasks/task-ci/ci/sync`).send({}));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ciStatus: 'FAILURE', diagnosis: { status: 'FILES_IDENTIFIED', affectedFiles: ['src/api.ts'] },
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      ciStatus: 'FAILURE', ciDiagnosis: expect.objectContaining({ affectedFiles: ['src/api.ts'] }),
    }) }));
  });

  it('limits multi-install selection to installations verified by the GitHub user token', async () => {
    role = 'ADMIN';
    vi.spyOn(GithubAppClient.prototype, 'getUserAccessibleInstallations').mockResolvedValue([
      { id: '101', accountLogin: 'org-one', accountType: 'Organization' },
      { id: '102', accountLogin: 'org-two', accountType: 'Organization' },
    ]);
    vi.spyOn(GithubAppClient.prototype, 'getInstallation').mockImplementation(async (id) => ({
      id, accountLogin: id === '102' ? 'org-two' : 'org-one', accountType: 'Organization',
    }));
    vi.spyOn(authStateStore, 'consumeOneTimeToken').mockResolvedValue(true);
    const saved = { id: 'installation-record', installationId: '102', accountLogin: 'org-two', accountType: 'Organization', createdAt: new Date() };
    vi.spyOn(prisma.githubAppInstallation, 'upsert').mockResolvedValue(saved as any);
    vi.spyOn(prisma.auditEvent, 'create').mockResolvedValue({ id: 'audit' } as any);
    const state = jwt.sign({ purpose: 'github-app-install', workspaceId, userId }, config.JWT_SECRET, {
      issuer: 'asea-api', audience: 'asea-github-app-install', expiresIn: '10m', jwtid: 'install-nonce',
    });

    const complete = await as(request(configuredApp).post(`/api/v1/workspaces/${workspaceId}/github-app/installations/complete`))
      .send({ state, code: 'one-time-github-code' });
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ selectionRequired: true, installations: [{ installationId: '101' }, { installationId: '102' }] });
    expect(prisma.githubAppInstallation.upsert).not.toHaveBeenCalled();

    const injected = await as(request(configuredApp).post(`/api/v1/workspaces/${workspaceId}/github-app/installations/select`))
      .send({ selectionToken: complete.body.selectionToken, installationId: '999' });
    expect(injected.status).toBe(400);
    expect(GithubAppClient.prototype.getInstallation).not.toHaveBeenCalled();

    const selected = await as(request(configuredApp).post(`/api/v1/workspaces/${workspaceId}/github-app/installations/select`))
      .send({ selectionToken: complete.body.selectionToken, installationId: '102' });
    expect(selected.status).toBe(201);
    expect(selected.body.installation).toMatchObject({ installationId: '102', accountLogin: 'org-two' });
    expect(JSON.stringify(selected.body)).not.toContain('one-time-github-code');
  });
});
