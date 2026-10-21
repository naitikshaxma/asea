import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';
import { chainAuditEvent, type ChainedAuditEvent } from '../../src/services/auditChain.js';
import { findingsDigest } from '../../src/services/verification/verificationService.js';

describe('Verification run routes', () => {
  const app = createApp();
  const workspaceId = 'ws-r';
  const runId = 'vr-r';
  const base = `/api/v1/workspaces/${workspaceId}/verification-runs`;
  const token = generateToken({ userId: 'user-r', email: 'r@example.com' });

  const run = {
    id: runId,
    workspaceId,
    repositoryId: 'repo-r',
    taskId: 'task-r',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    requirement: 'Only authenticated users may export.',
    authorType: 'AI',
    status: 'COMPLETED',
    score: null,
    verdict: null,
    startedAt: new Date('2026-10-21T10:00:00Z'),
    completedAt: new Date('2026-10-21T10:00:05Z'),
    createdAt: new Date('2026-10-21T09:59:59Z'),
    updatedAt: new Date('2026-10-21T10:00:05Z'),
    _count: { findings: 1 },
  };
  const finding = {
    id: 'row-1',
    verificationRunId: runId,
    findingId: 'f-route',
    category: 'STATIC',
    severity: 'HIGH',
    title: 'Route handler has no authentication decorator',
    file: 'routes/projects.py',
    line: 25,
    evidence: ['def export_projects():'],
    source: 'DETERMINISTIC',
    ruleId: 'ASEA-PY-ROUTE-NO-AUTH',
    remediation: 'Add @login_required.',
    createdAt: new Date(),
  };

  let findingRows: Array<typeof finding>;
  let events: ChainedAuditEvent[];

  function buildChain(): ChainedAuditEvent[] {
    const chain: ChainedAuditEvent[] = [];
    let last: string | null = null;
    const metadata = [
      { attemptNumber: 1 },
      { attemptNumber: 1, findingCount: 1, findingsDigest: findingsDigest([finding as any]) },
      { findingCount: 1 },
    ];
    ['VERIFICATION_STARTED', 'STATIC_ANALYSIS_COMPLETED', 'VERIFICATION_COMPLETED'].forEach((eventType, i) => {
      const fields = {
        id: `evt-${i}`,
        workspaceId,
        actorId: 'user-r',
        eventType,
        resourceType: 'VerificationRun',
        resourceId: runId,
        metadata: metadata[i],
        requestId: null,
        timestamp: new Date(Date.UTC(2026, 9, 21, 10, 0, i)),
      };
      const link = chainAuditEvent(last, fields);
      chain.push({ ...fields, ...link });
      last = link.hash;
    });
    return chain;
  }

  beforeEach(() => {
    findingRows = [{ ...finding }];
    events = buildChain();
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-r',
      workspaceId,
      userId: 'user-r',
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'R', ownerId: 'user-r' },
    } as any);
    vi.spyOn(prisma.verificationRun, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.id === runId && where.workspaceId === workspaceId ? run : null) as any);
    vi.spyOn(prisma.verificationRun, 'findMany').mockResolvedValue([run] as any);
    vi.spyOn(prisma.verificationFinding, 'findMany').mockImplementation((async ({ where }: any) =>
      findingRows.filter((f) => !where.severity || f.severity === where.severity)) as any);
    vi.spyOn(prisma.auditEvent, 'findMany').mockImplementation((async () => events) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  it('lists a task\'s verification runs and returns one run with null score and verdict', async () => {
    const list = await get(`${base}?taskId=task-r`);
    expect(list.status).toBe(200);
    expect(prisma.verificationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId, taskId: 'task-r' } })
    );
    expect(list.body.verificationRuns[0]).toMatchObject({ id: runId, findingCount: 1, score: null, verdict: null });

    const one = await get(`${base}/${runId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: runId, status: 'COMPLETED', authorType: 'AI', taskId: 'task-r' });
  });

  it('returns a run\'s findings and filters by severity', async () => {
    const res = await get(`${base}/${runId}/findings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verificationRunId: runId,
      total: 1,
      findings: [
        {
          id: 'row-1',
          findingId: 'f-route',
          category: 'STATIC',
          severity: 'HIGH',
          title: finding.title,
          file: 'routes/projects.py',
          line: 25,
          evidence: ['def export_projects():'],
          source: 'DETERMINISTIC',
          ruleId: 'ASEA-PY-ROUTE-NO-AUTH',
          remediation: 'Add @login_required.',
        },
      ],
    });

    expect((await get(`${base}/${runId}/findings?severity=LOW`)).body.total).toBe(0);
    const bad = await get(`${base}/${runId}/findings?severity=urgent`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('verifies an intact audit chain and the findings digest', async () => {
    const res = await get(`${base}/${runId}/audit/verify`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verificationRunId: runId,
      valid: true,
      length: 3,
      headHash: events[2]!.hash,
      findingsDigestValid: true,
    });
  });

  it('reports a tampered audit event', async () => {
    events[1] = { ...events[1]!, metadata: { attemptNumber: 1, findingCount: 0 } };
    const res = await get(`${base}/${runId}/audit/verify`);
    expect(res.body).toMatchObject({ valid: false, brokenEventId: 'evt-1', length: 1 });
  });

  it('reports findings edited after the digest was recorded', async () => {
    findingRows[0] = { ...findingRows[0]!, severity: 'LOW' };
    const res = await get(`${base}/${runId}/audit/verify`);
    expect(res.body).toMatchObject({ valid: true, findingsDigestValid: false });
  });

  it('returns 404 for a run in another workspace and requires auth and membership', async () => {
    expect((await get(`${base}/vr-other/findings`)).status).toBe(404);
    expect((await request(app).get(`${base}/${runId}/findings`)).status).toBe(401);

    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await get(`${base}/${runId}/audit/verify`)).status).toBe(403);
  });
});
