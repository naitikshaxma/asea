import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { StaticAnalysisResult, VerificationRequest } from '@autonomous-engineer/contracts';

vi.mock('../../src/services/verification/agentClient.js', () => ({ requestStaticAnalysis: vi.fn() }));
vi.mock('../../src/services/verification/gitDiff.js', () => ({ buildVerificationRequest: vi.fn() }));

import { prisma } from '../../src/services/prisma.js';
import { config } from '../../src/config.js';
import { processTaskJob } from '../../src/worker.js';
import { requestStaticAnalysis } from '../../src/services/verification/agentClient.js';
import { buildVerificationRequest } from '../../src/services/verification/gitDiff.js';
import { verifyAuditChain } from '../../src/services/auditChain.js';
import { findingsDigest } from '../../src/services/verification/verificationService.js';
import { verifyRunSeal } from '../../src/services/verification/runSeal.js';
import type { TaskJobPayload } from '../../src/services/queueService.js';

const engineResult: StaticAnalysisResult = {
  findings: [
    {
      id: 'f-route',
      category: 'static',
      severity: 'high',
      title: 'Route handler has no authentication decorator',
      file: 'routes/projects.py',
      line: 25,
      evidence: ['def export_projects():'],
      source: 'deterministic',
      rule_id: 'ASEA-PY-ROUTE-NO-AUTH',
      remediation: 'Add @login_required.',
    },
    {
      id: 'f-gap',
      category: 'test_gap',
      severity: 'medium',
      title: 'New public function is not referenced by any test',
      file: 'services/projects.py',
      line: 21,
      evidence: ['def archive_project(owner_id, project_id):'],
      source: 'deterministic',
      rule_id: 'ASEA-PY-TEST-GAP',
      remediation: 'Add a test.',
    },
  ],
  tools_run: ['python-ast', 'semgrep'],
  tools_unavailable: [],
  duration_ms: 12,
  semgrep_ruleset_sha256: 'c7b5'.padEnd(64, '0'),
};

const builtRequest: VerificationRequest = {
  repository_id: 'repo-v',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  requirement: 'Export projects for authenticated users only.',
  unified_diff: 'diff --git a/x b/x\n',
  changed_files: [{ path: 'routes/projects.py', head_content: '...' }],
  author_type: 'ai',
};

describe('VERIFICATION tasks in the worker (agent service mocked)', () => {
  const taskId = 'task-v';
  const workspaceId = 'ws-v';
  let repoDir: string;
  let task: Record<string, any>;
  let runs: Map<string, Record<string, any>>;
  let verificationRun: Record<string, any>;
  let findings: Array<Record<string, any>>;
  let audits: Array<Record<string, any>>;
  let steps: Array<Record<string, any>>;
  const originalRoots = config.ALLOWED_REPO_ROOTS;

  const job = (attemptsMade: number) =>
    ({
      id: 'job-v',
      attemptsMade,
      opts: { attempts: 3 },
      data: { taskId, runId: 'run-v-1', workspaceId, attemptNumber: 1 },
    }) as unknown as Job<TaskJobPayload>;
  // The run's hash chain (task-level TASK_COMPLETED/TASK_FAILED events are not part of it)
  const chain = () => audits.filter((a) => a.resourceType === 'VerificationRun');
  const eventTypes = () => chain().map((a) => a.eventType);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-repo-'));
    config.ALLOWED_REPO_ROOTS = os.tmpdir();
    task = {
      id: taskId,
      workspaceId,
      creatorId: 'user-v',
      repositoryId: 'repo-v',
      title: 'Verify export endpoint',
      description: 'Export projects for authenticated users only.',
      taskType: 'VERIFICATION',
      status: 'QUEUED',
      startedAt: null,
      completedAt: null,
      targetBranch: 'main',
    };
    runs = new Map([['run-v-1', { id: 'run-v-1', taskId, attemptNumber: 1, status: 'QUEUED' }]]);
    verificationRun = {
      id: 'vr-1',
      workspaceId,
      repositoryId: 'repo-v',
      taskId,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      requirement: task.description,
      authorType: 'AI',
      status: 'QUEUED',
      score: null,
      verdict: null,
      startedAt: null,
      completedAt: null,
      auditHeadHash: null,
      auditEventCount: null,
      createdAt: new Date(),
    };
    findings = [];
    audits = [];
    steps = [];

    const taskRow = async () => ({ ...task, runs: [...runs.values()] });
    vi.spyOn(prisma.task, 'findUnique').mockImplementation(taskRow as any);
    vi.spyOn(prisma.task, 'findUniqueOrThrow').mockImplementation(taskRow as any);
    vi.spyOn(prisma.task, 'update').mockImplementation((async ({ data }: any) => Object.assign(task, data)) as any);
    vi.spyOn(prisma.workflowRun, 'findUnique').mockImplementation((async ({ where }: any) =>
      runs.has(where.id) ? { ...runs.get(where.id) } : null) as any);
    vi.spyOn(prisma.workflowRun, 'findFirst').mockImplementation((async ({ where }: any) =>
      [...runs.values()].find((r) => r.attemptNumber === where.attemptNumber) ?? null) as any);
    vi.spyOn(prisma.workflowRun, 'create').mockImplementation((async ({ data }: any) => {
      const run = { id: `run-v-${data.attemptNumber}`, ...data };
      runs.set(run.id, run);
      return run;
    }) as any);
    vi.spyOn(prisma.workflowRun, 'update').mockImplementation((async ({ where, data }: any) =>
      Object.assign(runs.get(where.id)!, data)) as any);
    vi.spyOn(prisma.workflowStep, 'create').mockImplementation((async ({ data }: any) => {
      steps.push(data);
      return data;
    }) as any);
    vi.spyOn(prisma.repository, 'findFirstOrThrow').mockResolvedValue({
      id: 'repo-v',
      workspaceId,
      repositoryUrl: repoDir,
    } as any);
    vi.spyOn(prisma.verificationRun, 'findFirst').mockImplementation((async () => ({ ...verificationRun })) as any);
    vi.spyOn(prisma.verificationRun, 'update').mockImplementation((async ({ data }: any) =>
      Object.assign(verificationRun, data)) as any);
    vi.spyOn(prisma.verificationFinding, 'createMany').mockImplementation((async ({ data }: any) => {
      findings.push(...data);
      return { count: data.length };
    }) as any);
    vi.spyOn(prisma.verificationFinding, 'count').mockImplementation((async () => findings.length) as any);
    vi.spyOn(prisma.auditEvent, 'findMany').mockImplementation((async ({ where }: any) =>
      audits.filter((a) => !where?.resourceId || a.resourceId === where.resourceId)) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockImplementation((async ({ data }: any) => {
      audits.push({ ...data });
      return data;
    }) as any);
    // The fake has no real transactions; the callback runs against the same stubs
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(prisma)) as any);

    vi.mocked(buildVerificationRequest).mockReset().mockResolvedValue(builtRequest);
    vi.mocked(requestStaticAnalysis).mockReset().mockResolvedValue(engineResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.ALLOWED_REPO_ROOTS = originalRoots;
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('runs static analysis, persists findings and a valid audit chain, and completes the task', async () => {
    await processTaskJob(job(0));

    expect(vi.mocked(buildVerificationRequest)).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-v',
        repoPath: fs.realpathSync(repoDir),
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        requirement: 'Export projects for authenticated users only.',
        authorType: 'ai',
      })
    );
    expect(vi.mocked(requestStaticAnalysis)).toHaveBeenCalledWith(builtRequest);

    // Only the context check and static analysis; no placeholder steps
    expect(steps.map((s) => s.stepType)).toEqual(['VALIDATE_CONTEXT', 'STATIC_ANALYSIS']);
    expect(steps[1].resultMetadata).toMatchObject({
      verificationRunId: 'vr-1',
      findingCount: 2,
      findingsBySeverity: { high: 1, medium: 1 },
      toolsRun: ['python-ast', 'semgrep'],
      toolsUnavailable: [],
      semgrepRulesetSha256: 'c7b5'.padEnd(64, '0'),
    });
    // The ruleset hash is also in the audit chain
    expect(chain().find((a) => a.eventType === 'STATIC_ANALYSIS_COMPLETED')!.metadata.semgrepRulesetSha256).toBe(
      'c7b5'.padEnd(64, '0')
    );

    expect(findings).toEqual([
      expect.objectContaining({ verificationRunId: 'vr-1', findingId: 'f-route', category: 'STATIC', severity: 'HIGH', source: 'DETERMINISTIC', ruleId: 'ASEA-PY-ROUTE-NO-AUTH', line: 25 }),
      expect.objectContaining({ findingId: 'f-gap', category: 'TEST_GAP', severity: 'MEDIUM' }),
    ]);
    expect(verificationRun.status).toBe('COMPLETED');
    expect(verificationRun.score).toBeNull();
    expect(verificationRun.verdict).toBeNull();
    expect(task.status).toBe('COMPLETED');

    expect(eventTypes()).toEqual([
      'VERIFICATION_STARTED',
      'STATIC_ANALYSIS_COMPLETED',
      'VERIFICATION_COMPLETED',
      'RUN_SEALED',
    ]);
    const verified = verifyAuditChain(chain());
    expect(verified).toMatchObject({ valid: true, length: 4 });

    // Sealed: the run stores the head and count as of VERIFICATION_COMPLETED, and RUN_SEALED records them
    const completedEvent = chain()[2]!;
    expect(verificationRun.auditHeadHash).toBe(completedEvent.hash);
    expect(verificationRun.auditEventCount).toBe(3);
    expect(chain()[3]!.metadata).toEqual({ status: 'COMPLETED', auditHeadHash: completedEvent.hash, auditEventCount: 3 });
    expect(verifyRunSeal(verificationRun as any, chain() as any, verified)).toEqual({ required: true, valid: true });
    const completed = chain().find((a) => a.eventType === 'STATIC_ANALYSIS_COMPLETED')!;
    expect(completed.metadata.findingsDigest).toBe(findingsDigest(findings as any));
  });

  it('records a failed attempt in the chain and keeps the run RUNNING until the retry succeeds', async () => {
    vi.mocked(requestStaticAnalysis).mockRejectedValueOnce(new Error('Agent service returned 503'));

    await expect(processTaskJob(job(0))).rejects.toThrow('Agent service returned 503');
    expect(verificationRun.status).toBe('RUNNING');
    expect(task.status).toBe('RUNNING');
    expect(findings).toHaveLength(0);

    await processTaskJob(job(1));

    expect(eventTypes()).toEqual([
      'VERIFICATION_STARTED',
      'VERIFICATION_ATTEMPT_FAILED',
      'VERIFICATION_STARTED',
      'STATIC_ANALYSIS_COMPLETED',
      'VERIFICATION_COMPLETED',
      'RUN_SEALED',
    ]);
    expect(chain()[1].metadata).toEqual({ attemptNumber: 1, error: 'Agent service returned 503' });
    expect(verifyAuditChain(chain())).toMatchObject({ valid: true, length: 6 });
    expect(verificationRun.auditEventCount).toBe(5);
    expect(verificationRun.status).toBe('COMPLETED');
    expect(findings).toHaveLength(2);
    // The successful attempt's steps are in the attempt-2 run
    expect(steps.filter((s) => s.workflowRunId === 'run-v-2').map((s) => s.stepType)).toEqual([
      'VALIDATE_CONTEXT',
      'STATIC_ANALYSIS',
    ]);
  });

  it('marks the verification run FAILED on the final attempt', async () => {
    task.status = 'RUNNING';
    runs.get('run-v-1')!.status = 'FAILED';
    vi.mocked(buildVerificationRequest).mockRejectedValue(new Error('git rev-parse failed'));

    await expect(processTaskJob(job(2))).rejects.toThrow('git rev-parse failed');

    expect(verificationRun.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');
    expect(eventTypes()).toEqual(['VERIFICATION_STARTED', 'VERIFICATION_FAILED', 'RUN_SEALED']);
    const verified = verifyAuditChain(chain());
    expect(verified.valid).toBe(true);
    expect(verificationRun.auditEventCount).toBe(2);
    expect(verifyRunSeal(verificationRun as any, chain() as any, verified).valid).toBe(true);
  });

  it('does not analyse again when the verification run already completed', async () => {
    verificationRun.status = 'COMPLETED';
    findings.push({ findingId: 'f-route' });

    await processTaskJob(job(1));

    expect(vi.mocked(requestStaticAnalysis)).not.toHaveBeenCalled();
    expect(steps.find((s) => s.stepType === 'STATIC_ANALYSIS')?.resultMetadata).toEqual({
      verificationRunId: 'vr-1',
      findingCount: 1,
      alreadyCompleted: true,
    });
    expect(task.status).toBe('COMPLETED');
  });

  it('refuses to extend a sealed audit chain', async () => {
    await processTaskJob(job(0));
    verificationRun.status = 'RUNNING'; // e.g. a status edited back by hand
    task.status = 'RUNNING';

    await expect(processTaskJob(job(1))).rejects.toThrow(/vr-1 is sealed/);
    expect(eventTypes().at(-1)).toBe('RUN_SEALED');
  });

  it('refuses to extend an audit chain that no longer verifies', async () => {
    await processTaskJob(job(0));
    chain()[1].metadata = { ...chain()[1].metadata, findingCount: 0 }; // tamper
    verificationRun.status = 'RUNNING';
    task.status = 'RUNNING';

    await expect(processTaskJob(job(1))).rejects.toThrow(/Audit chain of verification run vr-1 is broken/);
  });
});
