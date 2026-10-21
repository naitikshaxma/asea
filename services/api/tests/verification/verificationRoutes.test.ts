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
    auditHeadHash: null as string | null,
    auditEventCount: null as number | null,
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
  let runRow: typeof run;

  // A completed run's chain, sealed the way finishVerificationRun seals it
  function buildChain(): ChainedAuditEvent[] {
    const chain: ChainedAuditEvent[] = [];
    let last: string | null = null;
    const metadata: Array<Record<string, unknown>> = [
      { attemptNumber: 1 },
      { attemptNumber: 1, findingCount: 1, findingsDigest: findingsDigest([finding as any]) },
      { findingCount: 1 },
    ];
    ['VERIFICATION_STARTED', 'STATIC_ANALYSIS_COMPLETED', 'VERIFICATION_COMPLETED', 'RUN_SEALED'].forEach((eventType, i) => {
      if (eventType === 'RUN_SEALED') {
        metadata[i] = { status: 'COMPLETED', auditHeadHash: last, auditEventCount: 3 };
      }
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
    runRow = { ...run, auditHeadHash: events[2]!.hash, auditEventCount: 3 };
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'mem-r',
      workspaceId,
      userId: 'user-r',
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'R', ownerId: 'user-r' },
    } as any);
    vi.spyOn(prisma.verificationRun, 'findFirst').mockImplementation((async ({ where }: any) =>
      where.id === runId && where.workspaceId === workspaceId ? runRow : null) as any);
    vi.spyOn(prisma.verificationRun, 'findMany').mockImplementation((async () => [runRow]) as any);
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

  const verify = async () => (await get(`${base}/${runId}/audit/verify`)).body;

  it('verifies an intact, sealed audit chain and the findings digest', async () => {
    expect(await verify()).toEqual({
      verificationRunId: runId,
      valid: true,
      length: 4,
      headHash: events[3]!.hash,
      chain: { valid: true },
      seal: { required: true, valid: true },
      findingsDigestValid: true,
    });
  });

  it('reports a tampered audit event', async () => {
    events[1] = { ...events[1]!, metadata: { attemptNumber: 1, findingCount: 0 } };
    expect(await verify()).toMatchObject({
      valid: false,
      chain: { valid: false, brokenEventId: 'evt-1' },
      seal: { valid: false, reason: 'Audit chain is broken' },
    });
  });

  it('reports findings edited after the digest was recorded', async () => {
    findingRows[0] = { ...findingRows[0]!, severity: 'LOW' };
    expect(await verify()).toMatchObject({ valid: false, chain: { valid: true }, findingsDigestValid: false });
  });

  // Truncation: the remaining chain still links correctly; only the seal shows the loss
  it.each([
    ['the last event', 1],
    ['the last two events', 2],
  ])('detects deleting %s', async (_label, count) => {
    events = events.slice(0, events.length - count);
    const body = await verify();
    expect(body.chain).toEqual({ valid: true });
    expect(body).toMatchObject({
      valid: false,
      seal: { required: true, valid: false, reason: expect.stringMatching(/RUN_SEALED event is missing/) },
    });
  });

  it('detects a changed event count or head hash on the run', async () => {
    runRow = { ...runRow, auditEventCount: 2 };
    expect(await verify()).toMatchObject({ valid: false, seal: { valid: false, reason: expect.stringMatching(/event count/) } });

    runRow = { ...runRow, auditEventCount: 3, auditHeadHash: events[1]!.hash };
    expect(await verify()).toMatchObject({ valid: false, seal: { valid: false, reason: expect.stringMatching(/head hash/) } });
  });

  it('does not require a seal while the run is in progress', async () => {
    runRow = { ...runRow, status: 'RUNNING', auditHeadHash: null, auditEventCount: null };
    events = events.slice(0, 1);
    expect(await verify()).toMatchObject({ valid: true, seal: { required: false, valid: null }, findingsDigestValid: null });
  });

  it('returns 404 for a run in another workspace and requires auth and membership', async () => {
    expect((await get(`${base}/vr-other/findings`)).status).toBe(404);
    expect((await request(app).get(`${base}/${runId}/findings`)).status).toBe(401);

    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await get(`${base}/${runId}/audit/verify`)).status).toBe(403);
  });
});
