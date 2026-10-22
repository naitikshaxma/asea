import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import {
  DEFAULT_POLICY_CONFIG,
  type AgentRun,
  type PipelineResult,
  type ScoreResult,
  type VerificationRequest,
} from '@autonomous-engineer/contracts';

vi.mock('../../src/services/verification/agentClient.js', () => ({
  runPipeline: vi.fn(),
  getIndexStatus: vi.fn(),
  indexFiles: vi.fn(),
  requestScore: vi.fn(),
}));
vi.mock('../../src/services/verification/gitDiff.js', () => ({
  buildVerificationRequest: vi.fn(),
  readTreeFiles: vi.fn(),
  resolveCommit: vi.fn(),
}));

import { prisma } from '../../src/services/prisma.js';
import { config } from '../../src/config.js';
import { processTaskJob } from '../../src/worker.js';
import { getIndexStatus, indexFiles, runPipeline } from '../../src/services/verification/agentClient.js';
import { buildVerificationRequest, readTreeFiles, resolveCommit } from '../../src/services/verification/gitDiff.js';
import { verifyAuditChain } from '../../src/services/auditChain.js';
import { findingsDigest, reportDigest, scoreDigest } from '../../src/services/verification/verificationService.js';
import { verifyRunSeal } from '../../src/services/verification/runSeal.js';
import { policyConfigHash } from '../../src/services/policy/policyService.js';
import type { TaskJobPayload } from '../../src/services/queueService.js';

const defaultPolicyHash = policyConfigHash(DEFAULT_POLICY_CONFIG);
const BASE = 'a'.repeat(40);

const findings: PipelineResult['findings'] = [
  {
    id: 'f-route',
    category: 'static',
    severity: 'high',
    title: 'Route handler has no authentication decorator',
    file: 'routes/projects.py',
    line: 25,
    evidence: ['def export_projects():', 'Also reported by the negative-space agent: Requirement not met'],
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
];

const scoreResult: ScoreResult = {
  score: 50,
  verdict: 'high_risk',
  raw_score: 50,
  total_deduction: 50,
  policy_hash: defaultPolicyHash,
  breakdown: [
    { finding_id: 'f-route', rule_id: 'ASEA-PY-ROUTE-NO-AUTH', title: findings[0]!.title, category: 'static', severity: 'high', source: 'deterministic', severity_weight: 35, category_multiplier: 1, source_multiplier: 1, deduction: 35 },
    { finding_id: 'f-gap', rule_id: 'ASEA-PY-TEST-GAP', title: findings[1]!.title, category: 'test_gap', severity: 'medium', source: 'deterministic', severity_weight: 15, category_multiplier: 1, source_multiplier: 1, deduction: 15 },
  ],
  caps_applied: [],
  adjustments: [],
};

const agent = (name: AgentRun['name'], extra: Partial<AgentRun> = {}): AgentRun => ({
  name,
  status: 'completed',
  started_at: '2026-10-22T10:00:00.000Z',
  finished_at: '2026-10-22T10:00:01.000Z',
  duration_ms: 1000,
  attempts: 1,
  finding_count: 0,
  detail: null,
  error: null,
  ...extra,
});

const pipelineResult: PipelineResult = {
  findings,
  static: { tools_run: ['python-ast', 'semgrep'], tools_unavailable: [], duration_ms: 12, semgrep_ruleset_sha256: 'c7b5'.padEnd(64, '0'), finding_count: 2 },
  score: scoreResult,
  report: {
    summary: 'High risk: an unauthenticated route and an untested function.',
    explanations: [
      { finding_id: 'f-gap', explanation: 'No test calls it.', suggested_fix: 'Add a test.' },
      { finding_id: 'f-route', explanation: 'Anyone can export.', suggested_fix: 'Add @login_required.' },
    ],
    generated_by: 'llm',
  },
  agents: [
    agent('ingest'),
    agent('static', { finding_count: 2 }),
    agent('negative_space', { finding_count: 1, detail: '1 responsibilities checked, 1 missing' }),
    agent('architecture', { attempts: 2 }),
    agent('score', { finding_count: 2 }),
    agent('report'),
  ],
  llm: { provider: 'fake', model: 'fake-deterministic-v1' },
  complete: true,
};

const builtRequest: VerificationRequest = {
  repository_id: 'repo-v',
  base_sha: BASE,
  head_sha: 'b'.repeat(40),
  requirement: 'Export projects for authenticated users only.',
  unified_diff: 'diff --git a/x b/x\n',
  changed_files: [{ path: 'routes/projects.py', head_content: '...' }],
  author_type: 'ai',
};

const COMPLETED_EVENTS = [
  'VERIFICATION_STARTED',
  'REPOSITORY_INDEXED',
  'STATIC_ANALYSIS_COMPLETED',
  'AGENTS_COMPLETED',
  'FINDINGS_RECORDED',
  'SCORE_COMPUTED',
  'REPORT_GENERATED',
  'VERIFICATION_COMPLETED',
  'RUN_SEALED',
];

describe('VERIFICATION tasks in the worker (agent service mocked)', () => {
  const taskId = 'task-v';
  const workspaceId = 'ws-v';
  let repoDir: string;
  let task: Record<string, any>;
  let runs: Map<string, Record<string, any>>;
  let verificationRun: Record<string, any>;
  let findingRows: Array<Record<string, any>>;
  let audits: Array<Record<string, any>>;
  let steps: Array<Record<string, any>>;
  let timelineWrites: Array<Array<Record<string, any>>>;
  let onStepCreated: (stepType: string) => void;
  let onStepCompleted: (stepType: string) => void;
  const originalRoots = config.ALLOWED_REPO_ROOTS;
  const originalBatch = config.INDEX_BATCH_BYTES;

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
  const event = (type: string) => chain().find((a) => a.eventType === type)!;
  const stepSummary = () => steps.map((s) => `${s.workflowRunId}:${s.stepType}:${s.stepStatus}`);

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
      baseSha: BASE,
      headSha: 'b'.repeat(40),
      requirement: task.description,
      authorType: 'AI',
      status: 'QUEUED',
      score: null,
      verdict: null,
      scoreBreakdown: null,
      policyProfileId: 'pol-default',
      policyHash: defaultPolicyHash,
      policySnapshot: DEFAULT_POLICY_CONFIG,
      agentTimeline: null,
      report: null,
      engineInfo: null,
      startedAt: null,
      completedAt: null,
      auditHeadHash: null,
      auditEventCount: null,
      createdAt: new Date(),
    };
    findingRows = [];
    audits = [];
    steps = [];
    timelineWrites = [];
    onStepCreated = () => {};
    onStepCompleted = () => {};

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
      const step = { id: `step-${steps.length + 1}`, ...data };
      steps.push(step);
      onStepCreated(data.stepType);
      return step;
    }) as any);
    vi.spyOn(prisma.workflowStep, 'update').mockImplementation((async ({ where, data }: any) => {
      const step = Object.assign(steps.find((s) => s.id === where.id)!, data);
      if (data.stepStatus === 'COMPLETED') onStepCompleted(step.stepType);
      return step;
    }) as any);
    vi.spyOn(prisma.repository, 'findFirstOrThrow').mockResolvedValue({ id: 'repo-v', workspaceId, repositoryUrl: repoDir } as any);
    vi.spyOn(prisma.verificationRun, 'findFirst').mockImplementation((async () => ({ ...verificationRun })) as any);
    vi.spyOn(prisma.verificationRun, 'update').mockImplementation((async ({ data }: any) => {
      if (data.agentTimeline && verificationRun.status === 'RUNNING' && data.status === undefined) {
        timelineWrites.push(structuredClone(data.agentTimeline));
      }
      return Object.assign(verificationRun, data);
    }) as any);
    vi.spyOn(prisma.verificationRun, 'findMany').mockImplementation((async ({ where }: any) =>
      where.status.in.includes(verificationRun.status) ? [{ ...verificationRun }] : []) as any);
    vi.spyOn(prisma.verificationFinding, 'createMany').mockImplementation((async ({ data }: any) => {
      findingRows.push(...data);
      return { count: data.length };
    }) as any);
    vi.spyOn(prisma.verificationFinding, 'count').mockImplementation((async () => findingRows.length) as any);
    vi.spyOn(prisma.auditEvent, 'findMany').mockImplementation((async ({ where }: any) =>
      audits.filter((a) => !where?.resourceId || a.resourceId === where.resourceId)) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockImplementation((async ({ data }: any) => {
      audits.push({ ...data });
      return data;
    }) as any);
    // The fake has no real transactions; the callback runs against the same stubs
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(prisma)) as any);

    vi.mocked(resolveCommit).mockReset().mockResolvedValue(BASE);
    vi.mocked(buildVerificationRequest).mockReset().mockResolvedValue(builtRequest);
    vi.mocked(getIndexStatus).mockReset().mockResolvedValue({ repository_id: 'repo-v', commit_sha: BASE, indexed: false, symbols: 0 });
    vi.mocked(readTreeFiles).mockReset().mockResolvedValue({
      commitSha: BASE,
      files: [{ path: 'routes/projects.py', content: 'def a():\n    pass\n' }, { path: 'services/projects.py', content: 'def b():\n    pass\n' }],
      truncated: false,
    });
    vi.mocked(indexFiles).mockReset().mockImplementation(async (req) => ({
      repository_id: req.repository_id,
      commit_sha: req.commit_sha,
      indexed_files: req.files.length,
      symbols: 12,
      cached: false,
      complete: req.complete,
    }));
    vi.mocked(runPipeline).mockReset().mockImplementation(async (_req, onEvent) => {
      await onEvent({ type: 'agent_started', agent: 'ingest', at: '2026-10-22T10:00:00.000Z' });
      await onEvent({ type: 'agent_finished', run: agent('ingest') });
      await onEvent({ type: 'agent_started', agent: 'static', at: '2026-10-22T10:00:01.000Z' });
      return pipelineResult;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.ALLOWED_REPO_ROOTS = originalRoots;
    config.INDEX_BATCH_BYTES = originalBatch;
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('indexes the repository, runs the pipeline and persists findings, score, report, timeline and a valid sealed chain', async () => {
    await processTaskJob(job(0));

    // Index at the resolved base commit, then the pipeline with the run's policy snapshot
    expect(vi.mocked(readTreeFiles)).toHaveBeenCalledWith(fs.realpathSync(repoDir), BASE, expect.objectContaining({ extensions: ['.py'] }));
    expect(vi.mocked(indexFiles)).toHaveBeenCalledWith(expect.objectContaining({ repository_id: 'repo-v', commit_sha: BASE, complete: true }));
    expect(vi.mocked(buildVerificationRequest)).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 'repo-v', repoPath: fs.realpathSync(repoDir), baseSha: BASE, authorType: 'ai' })
    );
    expect(vi.mocked(runPipeline)).toHaveBeenCalledWith({ request: builtRequest, policy: DEFAULT_POLICY_CONFIG }, expect.any(Function));

    // Steps: context, index, pipeline (no placeholder steps)
    expect(stepSummary()).toEqual(['run-v-1:VALIDATE_CONTEXT:COMPLETED', 'run-v-1:INDEX_REPOSITORY:COMPLETED', 'run-v-1:VERIFICATION_PIPELINE:COMPLETED']);
    expect(steps[1]!.resultMetadata).toEqual({ verificationRunId: 'vr-1', commitSha: BASE, cached: false, symbols: 12, files: 2, truncated: false });
    expect(steps[2]!.resultMetadata).toMatchObject({
      verificationRunId: 'vr-1',
      findingCount: 2,
      findingsBySeverity: { high: 1, medium: 1 },
      score: 50,
      verdict: 'HIGH_RISK',
      complete: true,
      llmProvider: 'fake',
      toolsRun: ['python-ast', 'semgrep'],
      semgrepRulesetSha256: 'c7b5'.padEnd(64, '0'),
    });

    // The live timeline was written while the pipeline streamed
    expect(timelineWrites.map((w) => w.map((e) => `${e['name']}:${e['status']}`))).toEqual([
      ['ingest:running'],
      ['ingest:completed'],
      ['ingest:completed', 'static:running'],
    ]);

    expect(findingRows).toEqual([
      expect.objectContaining({ verificationRunId: 'vr-1', findingId: 'f-route', category: 'STATIC', severity: 'HIGH', source: 'DETERMINISTIC', ruleId: 'ASEA-PY-ROUTE-NO-AUTH', line: 25 }),
      expect.objectContaining({ findingId: 'f-gap', category: 'TEST_GAP', severity: 'MEDIUM' }),
    ]);
    expect(verificationRun).toMatchObject({ status: 'COMPLETED', score: 50, verdict: 'HIGH_RISK', scoreBreakdown: scoreResult });
    expect(verificationRun.report).toEqual({
      summary: pipelineResult.report.summary,
      generatedBy: 'llm',
      explanations: [
        { findingId: 'f-gap', explanation: 'No test calls it.', suggestedFix: 'Add a test.' },
        { findingId: 'f-route', explanation: 'Anyone can export.', suggestedFix: 'Add @login_required.' },
      ],
    });
    expect(verificationRun.agentTimeline.map((e: any) => [e.name, e.status, e.attempts])).toEqual([
      ['ingest', 'completed', 1],
      ['static', 'completed', 1],
      ['negative_space', 'completed', 1],
      ['architecture', 'completed', 2],
      ['score', 'completed', 1],
      ['report', 'completed', 1],
    ]);
    expect(verificationRun.engineInfo).toEqual({
      llmProvider: 'fake',
      llmModel: 'fake-deterministic-v1',
      complete: true,
      toolsRun: ['python-ast', 'semgrep'],
      toolsUnavailable: [],
      semgrepRulesetSha256: 'c7b5'.padEnd(64, '0'),
    });
    expect(task.status).toBe('COMPLETED');

    expect(eventTypes()).toEqual(COMPLETED_EVENTS);
    const verified = verifyAuditChain(chain());
    expect(verified).toMatchObject({ valid: true, length: 9 });
    expect(event('VERIFICATION_STARTED').metadata).toMatchObject({ policyHash: defaultPolicyHash });
    expect(event('REPOSITORY_INDEXED').metadata).toEqual({ attemptNumber: 1, commitSha: BASE, cached: false, symbols: 12, files: 2, truncated: false });
    expect(event('STATIC_ANALYSIS_COMPLETED').metadata).toMatchObject({ semgrepRulesetSha256: 'c7b5'.padEnd(64, '0'), findingCount: 2 });
    expect(event('AGENTS_COMPLETED').metadata).toEqual({
      complete: true,
      llmProvider: 'fake',
      llmModel: 'fake-deterministic-v1',
      agents: [
        { name: 'negative_space', status: 'completed', attempts: 1, findingCount: 1, error: null },
        { name: 'architecture', status: 'completed', attempts: 2, findingCount: 0, error: null },
        { name: 'report', status: 'completed', attempts: 1, findingCount: 0, error: null },
      ],
    });
    expect(event('FINDINGS_RECORDED').metadata).toEqual({
      findingCount: 2,
      findingsBySeverity: { high: 1, medium: 1 },
      findingsDigest: findingsDigest(findingRows as any),
    });
    expect(event('SCORE_COMPUTED').metadata).toEqual({
      score: 50,
      verdict: 'HIGH_RISK',
      rawScore: 50,
      policyHash: defaultPolicyHash,
      policyProfileId: 'pol-default',
      capsApplied: [],
      scoreDigest: scoreDigest(scoreResult),
    });
    expect(event('REPORT_GENERATED').metadata).toEqual({ generatedBy: 'llm', reportDigest: reportDigest(verificationRun.report) });

    // Sealed: the run stores the head and count as of VERIFICATION_COMPLETED, and RUN_SEALED records them
    const completedEvent = event('VERIFICATION_COMPLETED');
    expect(verificationRun.auditHeadHash).toBe(completedEvent.hash);
    expect(verificationRun.auditEventCount).toBe(8);
    expect(event('RUN_SEALED').metadata).toEqual({ status: 'COMPLETED', auditHeadHash: completedEvent.hash, auditEventCount: 8 });
    expect(verifyRunSeal(verificationRun as any, chain() as any, verified)).toEqual({ required: true, valid: true });
  });

  it('does not send the files again when the commit is already indexed', async () => {
    vi.mocked(getIndexStatus).mockResolvedValue({ repository_id: 'repo-v', commit_sha: BASE, indexed: true, symbols: 40 });

    await processTaskJob(job(0));

    expect(vi.mocked(readTreeFiles)).not.toHaveBeenCalled();
    expect(vi.mocked(indexFiles)).not.toHaveBeenCalled();
    expect(event('REPOSITORY_INDEXED').metadata).toEqual({ attemptNumber: 1, commitSha: BASE, cached: true, symbols: 40, files: 0, truncated: false });
    expect(verificationRun.status).toBe('COMPLETED');
  });

  it('sends a large repository in batches and completes the index with the last one', async () => {
    config.INDEX_BATCH_BYTES = 40;
    vi.mocked(readTreeFiles).mockResolvedValue({
      commitSha: BASE,
      files: ['a', 'b', 'c'].map((n) => ({ path: `${n}.py`, content: `def ${n}():\n    return 1\n` })),
      truncated: true,
    });

    await processTaskJob(job(0));

    const calls = vi.mocked(indexFiles).mock.calls.map(([req]) => [req.files.map((f) => f.path), req.complete]);
    expect(calls).toEqual([
      [['a.py'], false],
      [['b.py'], false],
      [['c.py'], true],
    ]);
    expect(event('REPOSITORY_INDEXED').metadata).toMatchObject({ files: 3, truncated: true });
  });

  it('records a failed attempt in the chain and on its step, and keeps the run RUNNING until the retry succeeds', async () => {
    vi.mocked(runPipeline).mockRejectedValueOnce(new Error('Agent service returned 503'));

    await expect(processTaskJob(job(0))).rejects.toThrow('Agent service returned 503');
    expect(verificationRun.status).toBe('RUNNING');
    expect(task.status).toBe('RUNNING');
    expect(findingRows).toHaveLength(0);
    expect(steps.at(-1)).toMatchObject({ stepType: 'VERIFICATION_PIPELINE', stepStatus: 'FAILED', failureSummary: 'Agent service returned 503' });

    await processTaskJob(job(1));

    expect(eventTypes()).toEqual([
      'VERIFICATION_STARTED',
      'REPOSITORY_INDEXED',
      'VERIFICATION_ATTEMPT_FAILED',
      ...COMPLETED_EVENTS,
    ]);
    expect(chain()[2].metadata).toEqual({ attemptNumber: 1, error: 'Agent service returned 503' });
    expect(verifyAuditChain(chain())).toMatchObject({ valid: true, length: 12 });
    expect(verificationRun.auditEventCount).toBe(11);
    expect(verificationRun.status).toBe('COMPLETED');
    expect(findingRows).toHaveLength(2);
    // The successful attempt's steps are in the attempt-2 run
    expect(stepSummary().filter((s) => s.startsWith('run-v-2'))).toEqual([
      'run-v-2:VALIDATE_CONTEXT:COMPLETED',
      'run-v-2:INDEX_REPOSITORY:COMPLETED',
      'run-v-2:VERIFICATION_PIPELINE:COMPLETED',
    ]);
  });

  it('fails the attempt when the engine scored with a different policy', async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce({ ...pipelineResult, score: { ...scoreResult, policy_hash: 'e'.repeat(64) } });

    await expect(processTaskJob(job(0))).rejects.toThrow(`Engine scored with policy ${'e'.repeat(64)}, expected ${defaultPolicyHash}`);
    expect(findingRows).toHaveLength(0);
    expect(verificationRun.score).toBeNull();
    expect(eventTypes()).toEqual(['VERIFICATION_STARTED', 'REPOSITORY_INDEXED', 'VERIFICATION_ATTEMPT_FAILED']);
  });

  it('refuses a policy snapshot that no longer matches its hash', async () => {
    verificationRun.policySnapshot = { ...DEFAULT_POLICY_CONFIG, verdict_bands: { allow: 50, review: 40, high_risk: 30, block: 0 } };

    await expect(processTaskJob(job(0))).rejects.toThrow('Policy snapshot of verification run vr-1 does not match its policyHash');
    expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
  });

  it('scores a run submitted before policy profiles existed with the workspace default, and snapshots it', async () => {
    Object.assign(verificationRun, { policyProfileId: null, policyHash: null, policySnapshot: null });
    vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue({
      id: 'pol-default',
      workspaceId,
      name: 'default',
      isDefault: true,
      config: DEFAULT_POLICY_CONFIG,
      configHash: defaultPolicyHash,
    } as any);

    await processTaskJob(job(0));

    expect(verificationRun).toMatchObject({
      policyProfileId: 'pol-default',
      policyHash: defaultPolicyHash,
      policySnapshot: DEFAULT_POLICY_CONFIG,
      verdict: 'HIGH_RISK',
      status: 'COMPLETED',
    });
  });

  it('marks the verification run and the failing step FAILED on the final attempt', async () => {
    task.status = 'RUNNING';
    runs.get('run-v-1')!.status = 'FAILED';
    vi.mocked(buildVerificationRequest).mockRejectedValue(new Error('git rev-parse failed'));

    await expect(processTaskJob(job(2))).rejects.toThrow('git rev-parse failed');

    expect(verificationRun.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');
    expect(stepSummary()).toEqual([
      'run-v-3:VALIDATE_CONTEXT:COMPLETED',
      'run-v-3:INDEX_REPOSITORY:COMPLETED',
      'run-v-3:VERIFICATION_PIPELINE:FAILED',
    ]);
    expect(eventTypes()).toEqual(['VERIFICATION_STARTED', 'REPOSITORY_INDEXED', 'VERIFICATION_FAILED', 'RUN_SEALED']);
    const verified = verifyAuditChain(chain());
    expect(verified.valid).toBe(true);
    expect(verificationRun.auditEventCount).toBe(3);
    expect(verifyRunSeal(verificationRun as any, chain() as any, verified).valid).toBe(true);
  });

  it('marks the index step FAILED when indexing fails', async () => {
    vi.mocked(getIndexStatus).mockRejectedValue(new Error('Agent service returned 503 for index status'));

    await expect(processTaskJob(job(0))).rejects.toThrow('503 for index status');
    expect(stepSummary()).toEqual(['run-v-1:VALIDATE_CONTEXT:COMPLETED', 'run-v-1:INDEX_REPOSITORY:FAILED']);
    expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
  });

  it('does not analyse again when the verification run already completed', async () => {
    verificationRun.status = 'COMPLETED';
    findingRows.push({ findingId: 'f-route' });

    await processTaskJob(job(1));

    expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
    expect(vi.mocked(getIndexStatus)).not.toHaveBeenCalled();
    expect(steps.find((s) => s.stepType === 'VERIFICATION_PIPELINE')).toMatchObject({
      stepStatus: 'COMPLETED',
      resultMetadata: { verificationRunId: 'vr-1', findingCount: 1, alreadyCompleted: true },
    });
    expect(task.status).toBe('COMPLETED');
  });

  describe('cancellation before analysis (task 1c)', () => {
    const expectCancelledAndSealed = (eventsBefore: string[]) => {
      expect(verificationRun.status).toBe('CANCELLED');
      expect(task.status).toBe('CANCELLED');
      expect(eventTypes()).toEqual([...eventsBefore, 'VERIFICATION_CANCELLED', 'RUN_SEALED']);
      const verified = verifyAuditChain(chain());
      expect(verified.valid).toBe(true);
      expect(verifyRunSeal(verificationRun as any, chain() as any, verified)).toEqual({ required: true, valid: true });
    };

    it('cancels and seals the run when the task is picked up in CANCEL_REQUESTED', async () => {
      task.status = 'CANCEL_REQUESTED';
      await processTaskJob(job(0));
      expectCancelledAndSealed([]);
      expect(chain()[0]!.metadata).toEqual({ reason: 'Task cancelled by user before execution commenced.' });
      expect(chain()[0]!.actorId).toBeNull();
      expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
    });

    it('cancels and seals the run when cancellation arrives before the verification starts', async () => {
      onStepCreated = (stepType) => {
        if (stepType === 'VALIDATE_CONTEXT') task.status = 'CANCEL_REQUESTED';
      };
      await processTaskJob(job(0));
      expectCancelledAndSealed([]);
      expect(steps.map((s) => s.stepType)).toEqual(['VALIDATE_CONTEXT']);
      expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
    });

    it('cancels and seals a run left RUNNING by a failed attempt', async () => {
      vi.mocked(runPipeline).mockRejectedValueOnce(new Error('Agent service returned 503'));
      await expect(processTaskJob(job(0))).rejects.toThrow();
      expect(verificationRun.status).toBe('RUNNING');

      task.status = 'CANCEL_REQUESTED';
      await processTaskJob(job(1));

      expectCancelledAndSealed(['VERIFICATION_STARTED', 'REPOSITORY_INDEXED', 'VERIFICATION_ATTEMPT_FAILED']);
      expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
    });

    it('leaves a completed run as it is when cancellation arrives after the pipeline', async () => {
      onStepCompleted = (stepType) => {
        if (stepType === 'VERIFICATION_PIPELINE') task.status = 'CANCEL_REQUESTED';
      };
      await processTaskJob(job(0));
      expect(task.status).toBe('CANCELLED');
      expect(verificationRun.status).toBe('COMPLETED');
      expect(eventTypes().at(-1)).toBe('RUN_SEALED');
      expect(eventTypes()).not.toContain('VERIFICATION_CANCELLED');
    });
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
    chain()[1].metadata = { ...chain()[1].metadata, symbols: 0 }; // tamper
    verificationRun.status = 'RUNNING';
    task.status = 'RUNNING';

    await expect(processTaskJob(job(1))).rejects.toThrow(/Audit chain of verification run vr-1 is broken/);
  });
});
