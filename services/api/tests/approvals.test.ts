import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateToken } from '../src/services/authService.js';
import { prisma } from '../src/services/prisma.js';

describe('durable patch approvals', () => {
  const workspaceId = 'ws-approval';
  const taskId = 'task-approval';
  const patchHash = 'a'.repeat(64);
  const base = `/api/v1/workspaces/${workspaceId}`;
  const app = createApp();
  let membershipRole: 'MEMBER' | 'ADMIN' | 'OWNER';
  let task: Record<string, any>;
  let patchArtifact: Record<string, any>;
  let approvals: Array<Record<string, any>>;
  let auditEvents: Array<Record<string, any>>;

  const auth = (userId = 'requester') => {
    const authorization = `Bearer ${generateToken({ userId, email: `${userId}@example.invalid` })}`;
    return {
      get: (url: string) => request(app).get(url).set('Authorization', authorization),
      post: (url: string) => request(app).post(url).set('Authorization', authorization),
    };
  };
  const hydrated = (approval: Record<string, any>) => ({ ...approval, task: { ...task } });

  beforeEach(() => {
    membershipRole = 'ADMIN';
    task = {
      id: taskId, workspaceId, taskType: 'CODE_PATCH', status: 'NEEDS_ATTENTION',
      title: 'Patch auth flow', creatorId: 'requester', executionMetadata: { patchHash },
    };
    patchArtifact = { id: 'patch-1', taskId, patchHash, status: 'PROPOSED', testStatus: 'PASSED', securityStatus: 'PASSED', reviewStatus: 'PASSED' };
    approvals = [];
    auditEvents = [];
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockImplementation((async () => ({
      id: 'membership', workspaceId, userId: 'requester', role: membershipRole,
      createdAt: new Date(), workspace: { id: workspaceId, name: 'Workspace', ownerId: 'requester' },
    })) as any);
    vi.spyOn(prisma.task, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.id === taskId && where.workspaceId === workspaceId ? { ...task } : null) as any);
    vi.spyOn(prisma.approval, 'findMany').mockImplementation((async () => approvals.map(hydrated)) as any);
    vi.spyOn(prisma.approval, 'findFirst').mockImplementation((async ({ where }: any) => {
      const row = approvals.find((candidate) =>
        (where.id === undefined || candidate.id === where.id) &&
        (where.taskId === undefined || candidate.taskId === where.taskId) &&
        (where.patchHash === undefined || candidate.patchHash === where.patchHash));
      return row ? hydrated(row) : null;
    }) as any);
    vi.spyOn(prisma.approval, 'create').mockImplementation((async ({ data }: any) => {
      const row = { id: `approval-${approvals.length + 1}`, ...data, createdAt: new Date(), decidedById: null, reason: null };
      approvals.push(row);
      return row;
    }) as any);
    vi.spyOn(prisma.approval, 'updateMany').mockImplementation((async ({ where, data }: any) => {
      const row = approvals.find((candidate) => candidate.id === where.id && candidate.status === where.status && candidate.patchHash === where.patchHash);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }) as any);
    vi.spyOn(prisma.approval, 'findUnique').mockImplementation((async ({ where }: any) => {
      const row = approvals.find((candidate) => candidate.id === where.id);
      return row ? hydrated(row) : null;
    }) as any);
    vi.spyOn(prisma.taskPatch, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.taskId === taskId && where.patchHash === patchHash && patchArtifact.status === where.status ? { ...patchArtifact } : null) as any);
    vi.spyOn(prisma.taskPatch, 'updateMany').mockImplementation((async ({ where, data }: any) => {
      if (patchArtifact.id !== where.id || patchArtifact.status !== where.status) return { count: 0 };
      Object.assign(patchArtifact, data);
      return { count: 1 };
    }) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockImplementation((async ({ data }: any) => {
      auditEvents.push(data);
      return data;
    }) as any);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: any) => callback(prisma)) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates one approval request for a current patch and records it in audit history', async () => {
    const first = await auth().post(`${base}/tasks/${taskId}/approvals`).send({ patchHash });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ taskId, patchHash, requestedById: 'requester', status: 'PENDING' });
    expect(auditEvents[0]).toMatchObject({ eventType: 'PATCH_APPROVAL_REQUESTED', resourceId: first.body.id });

    const duplicate = await auth().post(`${base}/tasks/${taskId}/approvals`).send({ patchHash });
    expect(duplicate.status).toBe(200);
    expect(approvals).toHaveLength(1);
  });

  it('requires a current code patch and refuses stale hashes or foreign tasks', async () => {
    expect((await auth().post(`${base}/tasks/missing/approvals`).send({ patchHash })).status).toBe(404);
    task.taskType = 'BUG_INVESTIGATION';
    expect((await auth().post(`${base}/tasks/${taskId}/approvals`).send({ patchHash })).status).toBe(409);
    task.taskType = 'CODE_PATCH';
    task.executionMetadata.patchHash = 'b'.repeat(64);
    expect((await auth().post(`${base}/tasks/${taskId}/approvals`).send({ patchHash })).status).toBe(409);
    expect(approvals).toHaveLength(0);
  });

  it('refuses to request or grant approval for a patch whose verification did not pass, but still allows rejection', async () => {
    for (const blocked of [{ testStatus: 'NOT_RUN' }, { securityStatus: 'FAILED' }, { reviewStatus: 'UNAVAILABLE' }]) {
      Object.assign(patchArtifact, { testStatus: 'PASSED', securityStatus: 'PASSED', reviewStatus: 'PASSED' }, blocked);
      const created = await auth().post(`${base}/tasks/${taskId}/approvals`).send({ patchHash });
      expect(created.status).toBe(409);
      expect(created.body.error.message).toMatch(/passing sandbox tests, security scans, and independent review/);
    }
    expect(approvals).toHaveLength(0);

    // A request that predates this gate cannot be approved while the patch is blocked
    const row = { id: 'approval-legacy', taskId, patchHash, requestedById: 'requester', status: 'PENDING', decidedById: null, reason: null };
    approvals.push(row);
    const approved = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' });
    expect(approved.status).toBe(409);
    expect(row.status).toBe('PENDING');
    expect(patchArtifact.status).toBe('PROPOSED');
    const rejected = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'REJECTED', reason: 'Security scan failed.' });
    expect(rejected.status).toBe(200);
    expect(patchArtifact.status).toBe('REJECTED');
  });

  it('allows an authorized second reviewer to approve and records reviewer and audit event', async () => {
    const row = { id: 'approval-existing', taskId, patchHash, requestedById: 'requester', status: 'PENDING', decidedById: null, reason: null };
    approvals.push(row);
    const result = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'APPROVED', decidedById: 'reviewer', patchHash });
    expect(patchArtifact.status).toBe('APPROVED');
    expect(auditEvents[0]).toMatchObject({ eventType: 'PATCH_APPROVED', actorId: 'reviewer' });
  });

  it('requires a rejection reason, prevents self-approval and rejects a changed patch', async () => {
    const row = { id: 'approval-existing', taskId, patchHash, requestedById: 'requester', status: 'PENDING', decidedById: null, reason: null };
    approvals.push(row);
    expect((await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'REJECTED' })).status).toBe(400);
    expect((await auth('requester').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(403);

    task.executionMetadata.patchHash = 'b'.repeat(64);
    const stale = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' });
    expect(stale.status).toBe(409);
    expect(row.status).toBe('PENDING');

    task.executionMetadata.patchHash = patchHash;
    task.status = 'CANCELLED';
    const cancelled = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' });
    expect(cancelled.status).toBe(409);
    expect(row.status).toBe('PENDING');
  });

  it('records rejection reason and prevents duplicate decisions', async () => {
    const row = { id: 'approval-existing', taskId, patchHash, requestedById: 'requester', status: 'PENDING', decidedById: null, reason: null };
    approvals.push(row);
    const rejected = await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'REJECTED', reason: 'Patch misses the required validation.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', reason: 'Patch misses the required validation.' });
    expect(patchArtifact.status).toBe('REJECTED');
    expect(auditEvents[0]).toMatchObject({ eventType: 'PATCH_REJECTED' });
    expect((await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(409);
  });

  it('limits decision rights to workspace admins and owners', async () => {
    membershipRole = 'MEMBER';
    const row = { id: 'approval-existing', taskId, patchHash, requestedById: 'other', status: 'PENDING', decidedById: null, reason: null };
    approvals.push(row);
    expect((await auth('reviewer').post(`${base}/approvals/${row.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(403);
  });

  it('lists pending approvals with a current-patch indicator', async () => {
    approvals.push({ id: 'approval-existing', taskId, patchHash, requestedById: 'requester', status: 'PENDING' });
    const result = await auth().get(`${base}/approvals?status=PENDING`);
    expect(result.status).toBe(200);
    expect(result.body.approvals[0].patchIsCurrent).toBe(true);
  });
});
