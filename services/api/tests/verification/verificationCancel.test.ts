import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';
import { verifyAuditChain } from '../../src/services/auditChain.js';
import { verifyRunSeal } from '../../src/services/verification/runSeal.js';

// Cancelling a QUEUED VERIFICATION task through the API cancels and seals its
// verification run immediately (the worker never runs it).
describe('Cancelling a queued VERIFICATION task', () => {
  const app = createApp();
  const workspaceId = 'ws-c';
  const user = { id: 'user-c', email: 'c@example.com' };
  const token = generateToken({ userId: user.id, email: user.email });
  let verificationRun: Record<string, any>;
  let audits: Array<Record<string, any>>;

  beforeEach(() => {
    verificationRun = {
      id: 'vr-c',
      workspaceId,
      repositoryId: 'repo-c',
      taskId: 'task-c',
      status: 'QUEUED',
      auditHeadHash: null,
      auditEventCount: null,
    };
    audits = [];

    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-c',
      workspaceId,
      userId: user.id,
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'C', ownerId: user.id },
    } as any);
    vi.spyOn(prisma.task, 'findFirst').mockResolvedValue({
      id: 'task-c',
      workspaceId,
      status: 'QUEUED',
      taskType: 'VERIFICATION',
      runs: [{ id: 'run-c', status: 'QUEUED' }],
    } as any);
    vi.spyOn(prisma.task, 'update').mockResolvedValue({ id: 'task-c', status: 'CANCELLED' } as any);
    vi.spyOn(prisma.workflowRun, 'update').mockResolvedValue({ id: 'run-c', status: 'CANCELLED' } as any);
    vi.spyOn(prisma.verificationRun, 'findMany').mockImplementation((async ({ where }: any) =>
      where.status.in.includes(verificationRun.status) ? [{ ...verificationRun }] : []) as any);
    vi.spyOn(prisma.verificationRun, 'update').mockImplementation((async ({ data }: any) =>
      Object.assign(verificationRun, data)) as any);
    vi.spyOn(prisma.auditEvent, 'findMany').mockImplementation((async () => audits) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockImplementation((async ({ data }: any) => {
      audits.push({ ...data });
      return data;
    }) as any);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(prisma)) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves the verification run to CANCELLED and seals it, attributed to the user', async () => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks/task-c/cancel`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(verificationRun.status).toBe('CANCELLED');
    expect(audits.map((a) => a.eventType)).toEqual(['VERIFICATION_CANCELLED', 'RUN_SEALED']);
    expect(audits.every((a) => a.actorId === user.id)).toBe(true);
    const chain = verifyAuditChain(audits as any);
    expect(chain.valid).toBe(true);
    expect(verifyRunSeal(verificationRun as any, audits as any, chain)).toEqual({ required: true, valid: true });
  });
});
