import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';
import { chainAuditEvent, type ChainedAuditEvent } from '../../src/services/auditChain.js';
import { findingsDigest, reportDigest, scoreDigest } from '../../src/services/verification/verificationService.js';
import { policyConfigHash } from '../../src/services/policy/policyService.js';
import { DEFAULT_POLICY_CONFIG, type ScoreResult } from '@autonomous-engineer/contracts';

describe('Verification run routes', () => {
  const app = createApp();
  const workspaceId = 'ws-r';
  const runId = 'vr-r';
  const base = `/api/v1/workspaces/${workspaceId}/verification-runs`;
  const token = generateToken({ userId: 'user-r', email: 'r@example.com' });
  const policyHash = policyConfigHash(DEFAULT_POLICY_CONFIG);
  const scoreResult: ScoreResult = {
    score: 65,
    verdict: 'high_risk',
    raw_score: 65,
    total_deduction: 35,
    policy_hash: policyHash,
    breakdown: [
      {
        finding_id: 'f-route',
        rule_id: 'ASEA-PY-ROUTE-NO-AUTH',
        title: 'Route handler has no authentication decorator',
        category: 'static',
        severity: 'high',
        source: 'deterministic',
        severity_weight: 35,
        category_multiplier: 1,
        source_multiplier: 1,
        deduction: 35,
      },
    ],
    caps_applied: [],
  };

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
    score: 65 as number | null,
    verdict: 'HIGH_RISK' as string | null,
    scoreBreakdown: scoreResult as unknown,
    policyProfileId: 'pol-default',
    policyHash,
    policySnapshot: DEFAULT_POLICY_CONFIG as unknown,
    agentTimeline: [
      { name: 'ingest', status: 'completed', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:00:00.100Z', durationMs: 100, attempts: 1, findingCount: 0, detail: '1 changed file(s)', error: null },
      { name: 'architecture', status: 'failed', startedAt: '2026-10-21T10:00:01.000Z', finishedAt: '2026-10-21T10:00:03.000Z', durationMs: 2000, attempts: 2, findingCount: 0, detail: null, error: 'timed out after 1s' },
    ] as unknown,
    report: {
      summary: 'High risk: an unauthenticated export route.',
      generatedBy: 'llm',
      explanations: [{ findingId: 'f-route', explanation: 'Anyone can export.', suggestedFix: 'Add @login_required.' }],
    } as unknown,
    engineInfo: {
      llmProvider: 'fake',
      llmModel: 'fake-deterministic-v1',
      complete: false,
      toolsRun: ['python-ast'],
      toolsUnavailable: ['semgrep'],
      semgrepRulesetSha256: null,
    } as unknown,
    github: null as unknown,
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

  const scoreEvent = { score: 65, verdict: 'HIGH_RISK', rawScore: 65, policyHash, policyProfileId: 'pol-default', capsApplied: [], scoreDigest: scoreDigest(scoreResult) };
  // A completed, scored run's chain as the agent pipeline writes it
  const pipelineEvents = (): Array<[string, Record<string, unknown>]> => [
    ['VERIFICATION_STARTED', { attemptNumber: 1, policyHash }],
    ['REPOSITORY_INDEXED', { attemptNumber: 1, commitSha: 'a'.repeat(40), cached: false, symbols: 12, files: 11, truncated: false }],
    ['STATIC_ANALYSIS_COMPLETED', { attemptNumber: 1, findingCount: 1 }],
    ['AGENTS_COMPLETED', { complete: false, llmProvider: 'fake', llmModel: 'fake-deterministic-v1', agents: [] }],
    ['FINDINGS_RECORDED', { findingCount: 1, findingsBySeverity: { high: 1 }, findingsDigest: findingsDigest([finding as any]) }],
    ['SCORE_COMPUTED', scoreEvent],
    ['REPORT_GENERATED', { generatedBy: 'llm', reportDigest: reportDigest(run.report) }],
    ['VERIFICATION_COMPLETED', { findingCount: 1, score: 65, verdict: 'HIGH_RISK' }],
  ];
  // Runs scored before the agent pipeline kept the findings digest on STATIC_ANALYSIS_COMPLETED
  const legacyEvents = (): Array<[string, Record<string, unknown>]> => [
    ['VERIFICATION_STARTED', { attemptNumber: 1, policyHash }],
    ['STATIC_ANALYSIS_COMPLETED', { attemptNumber: 1, findingCount: 1, findingsDigest: findingsDigest([finding as any]) }],
    ['SCORE_COMPUTED', scoreEvent],
    ['VERIFICATION_COMPLETED', { findingCount: 1, score: 65, verdict: 'HIGH_RISK' }],
  ];

  // The chain of the given events followed by RUN_SEALED, as finishVerificationRun seals it
  function buildChain(spec: Array<[string, Record<string, unknown>]> = pipelineEvents()): ChainedAuditEvent[] {
    const chain: ChainedAuditEvent[] = [];
    let last: string | null = null;
    const all: Array<[string, Record<string, unknown>]> = [...spec, ['RUN_SEALED', {}]];
    all.forEach(([eventType, eventMetadata], i) => {
      const metadata = eventType === 'RUN_SEALED' ? { status: 'COMPLETED', auditHeadHash: last, auditEventCount: spec.length } : eventMetadata;
      const fields = {
        id: `evt-${i}`,
        workspaceId,
        actorId: 'user-r',
        eventType,
        resourceType: 'VerificationRun',
        resourceId: runId,
        metadata,
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
    runRow = { ...run, auditHeadHash: events.at(-2)!.hash, auditEventCount: events.length - 1 };
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

  it('lists a task\'s verification runs and returns one run with its score, verdict and breakdown', async () => {
    const list = await get(`${base}?taskId=task-r`);
    expect(list.status).toBe(200);
    expect(prisma.verificationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId, taskId: 'task-r' } })
    );
    expect(list.body.verificationRuns[0]).toMatchObject({
      id: runId,
      findingCount: 1,
      score: 65,
      verdict: 'HIGH_RISK',
      policyProfileId: 'pol-default',
      policyHash,
    });
    // The list stays light: no breakdown or snapshot
    expect(list.body.verificationRuns[0]).not.toHaveProperty('scoreBreakdown');

    const one = await get(`${base}/${runId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: runId, status: 'COMPLETED', authorType: 'AI', taskId: 'task-r' });
    expect(one.body.policySnapshot).toEqual(DEFAULT_POLICY_CONFIG);
    expect(one.body.agentTimeline).toEqual(run.agentTimeline);
    expect(one.body.report).toEqual(run.report);
    expect(one.body.engine).toEqual(run.engineInfo);
    expect(one.body.scoreBreakdown).toEqual({
      score: 65,
      verdict: 'HIGH_RISK',
      rawScore: 65,
      totalDeduction: 35,
      policyHash,
      items: [
        {
          findingId: 'f-route',
          ruleId: 'ASEA-PY-ROUTE-NO-AUTH',
          title: 'Route handler has no authentication decorator',
          category: 'STATIC',
          severity: 'HIGH',
          source: 'DETERMINISTIC',
          severityWeight: 35,
          categoryMultiplier: 1,
          sourceMultiplier: 1,
          deduction: 35,
        },
      ],
      capsApplied: [],
    });
  });

  it('returns null breakdown and snapshot for a run that has not been scored', async () => {
    runRow = { ...runRow, status: 'QUEUED', score: null, verdict: null, scoreBreakdown: null, policySnapshot: null, agentTimeline: null, report: null, engineInfo: null };
    const one = await get(`${base}/${runId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ score: null, verdict: null, scoreBreakdown: null, policySnapshot: null, agentTimeline: [], report: null, engine: null });
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

  it('verifies an intact, sealed audit chain, the findings digest, the stored score and the report', async () => {
    expect(await verify()).toEqual({
      verificationRunId: runId,
      valid: true,
      length: 9,
      headHash: events[8]!.hash,
      chain: { valid: true },
      seal: { required: true, valid: true },
      findingsDigestValid: true,
      scoreValid: true,
      reportValid: true,
    });
  });

  it('verifies runs recorded before the agent pipeline (digest on STATIC_ANALYSIS_COMPLETED, no report)', async () => {
    events = buildChain(legacyEvents());
    runRow = { ...runRow, auditHeadHash: events.at(-2)!.hash, auditEventCount: events.length - 1, report: null };
    expect(await verify()).toMatchObject({ valid: true, length: 5, findingsDigestValid: true, scoreValid: true, reportValid: null });
  });

  it('reports a stored report edited after it was generated', async () => {
    runRow = { ...runRow, report: { ...(run.report as object), summary: 'All good, ship it.' } };
    expect(await verify()).toMatchObject({ valid: false, chain: { valid: true }, seal: { valid: true }, scoreValid: true, reportValid: false });
  });

  it.each([
    ['score', { score: 95 }],
    ['verdict', { verdict: 'ALLOW' }],
    ['breakdown', { scoreBreakdown: { ...scoreResult, breakdown: [] } }],
    ['policy snapshot', { policySnapshot: { ...DEFAULT_POLICY_CONFIG, source_multipliers: { deterministic: 0, llm: 0 } } }],
    ['policy hash', { policyHash: 'a'.repeat(64) }],
  ])('reports a stored %s edited after scoring', async (_label, edit) => {
    runRow = { ...runRow, ...edit };
    expect(await verify()).toMatchObject({ valid: false, chain: { valid: true }, seal: { valid: true }, scoreValid: false });
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

    runRow = { ...runRow, auditEventCount: 8, auditHeadHash: events[1]!.hash };
    expect(await verify()).toMatchObject({ valid: false, seal: { valid: false, reason: expect.stringMatching(/head hash/) } });
  });

  it('does not require a seal while the run is in progress', async () => {
    runRow = { ...runRow, status: 'RUNNING', auditHeadHash: null, auditEventCount: null };
    events = events.slice(0, 1);
    expect(await verify()).toMatchObject({
      valid: true,
      seal: { required: false, valid: null },
      findingsDigestValid: null,
      scoreValid: null,
      reportValid: null,
    });
  });

  it('returns 404 for a run in another workspace and requires auth and membership', async () => {
    expect((await get(`${base}/vr-other/findings`)).status).toBe(404);
    expect((await request(app).get(`${base}/${runId}/findings`)).status).toBe(401);

    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await get(`${base}/${runId}/audit/verify`)).status).toBe(403);
  });
});
