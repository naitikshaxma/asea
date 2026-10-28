import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateTaskPatch: vi.fn(),
  resolveRepositoryFsPath: vi.fn(),
  config: {
    ALLOWED_REPO_ROOTS: '',
    TASK_WORKSPACE_ROOT: '',
  },
  prisma: {
    task: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    workflowRun: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    workflowStep: { create: vi.fn(), update: vi.fn() },
    taskPatch: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    approval: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({ config: mocks.config }));
vi.mock('../../src/services/prisma.js', () => ({ prisma: mocks.prisma, disconnectPrisma: vi.fn() }));
vi.mock('../../src/services/engineering/taskPatchWorkflow.js', () => ({
  generateTaskPatch: mocks.generateTaskPatch,
  TaskPatchWorkflowError: class TaskPatchWorkflowError extends Error {},
}));
vi.mock('../../src/services/engineering/sandboxFactory.js', () => ({
  configuredSandboxLimits: () => ({ timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 4096, workspaceSizeMb: 64, network: 'disabled' }),
  configuredSandboxProvider: () => ({ available: false }),
}));
vi.mock('../../src/services/intelligence/repositoryAnalysisService.js', () => ({ resolveRepositoryFsPath: mocks.resolveRepositoryFsPath }));
vi.mock('../../src/services/engineering/taskWorkspace.js', () => ({ cleanupAbandonedTaskWorkspaces: vi.fn(() => ({ removed: 0, failed: 0 })) }));

import { prisma } from '../../src/services/prisma.js';
import { processTaskJob } from '../../src/worker.js';
import type { TaskJobPayload } from '../../src/services/queueService.js';

describe('worker execution evidence redaction before persistence', () => {
  const taskId = 'task-output-redaction';
  const runId = 'run-output-redaction';
  const workspaceId = 'workspace-output-redaction';
  const secret = 'ASEA_WORKER_SYNTHETIC_SECRET_730ac19e';
  let task: Record<string, any>;
  let run: Record<string, any>;
  let persistedPatch: Record<string, any>;
  let persistedSteps: Array<Record<string, any>>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.generateTaskPatch.mockReset();
    mocks.resolveRepositoryFsPath.mockReset();
    mocks.config.ALLOWED_REPO_ROOTS = '';
    mocks.config.TASK_WORKSPACE_ROOT = '';
  });

  it('redacts test, scanner, review and diagnostic evidence before Prisma create/update calls', async () => {
    vi.stubEnv('ASEA_WORKER_TEST_SECRET', secret);
    const workspaceRoot = `C:/temp/asea-worker-evidence-${Date.now()}`;
    mocks.config.ALLOWED_REPO_ROOTS = 'C:/fixture';
    mocks.config.TASK_WORKSPACE_ROOT = workspaceRoot;
    mocks.resolveRepositoryFsPath.mockReturnValue('C:/fixture/repository');
    mocks.generateTaskPatch.mockResolvedValue({
      snapshotHash: 'a'.repeat(64), sourceRevision: null, patchHash: 'b'.repeat(64),
      summary: 'fixture patch', plan: [], evidence: [], contextFiles: ['src/index.js'], changedFiles: ['src/index.js'],
      baseFiles: [{ path: 'src/index.js', sha256: 'c'.repeat(64) }], unifiedDiff: '--- a/src/index.js\n+++ b/src/index.js',
      sandboxDiagnostics: { provider: 'docker', status: 'READY', image: 'fixture', reasonCode: null, message: `diagnostic ${secret}` },
      testReport: { status: 'FAILED', detectedCommands: [['node', '--test']], reason: `failure ${secret}`, commands: [{
        name: 'node:test', command: ['node', '--test'], status: 'FAILED', exitCode: 1, durationMs: 1,
        stdout: `stdout ${secret}`, stderr: `AssertionError API_TOKEN=${secret}`, outputTruncated: false, summary: `exception ${secret}`,
      }] },
      securityReport: { status: 'FAILED', tools: [{ scanner: 'semgrep', status: 'FAILED', summary: `scanner ${secret}`, stderr: `evidence ${secret}`, findings: [{ message: `finding ${secret}` }] }], coverage: [], limitations: [], reason: `scan ${secret}` },
      reviewReport: { status: 'UNAVAILABLE', reviewer: null, verdict: null, summary: `review ${secret}`, findings: [] },
      workspaceCleanupStatus: 'CLEANED',
    });

    task = {
      id: taskId, workspaceId, creatorId: 'user-1', repositoryId: 'repo-1', title: 'Test evidence',
      description: 'Redact persisted task execution evidence.', taskType: 'CODE_PATCH', priority: 'NORMAL', status: 'QUEUED',
      startedAt: null, completedAt: null, targetBranch: 'main', repository: { id: 'repo-1', provider: 'LOCAL', repositoryUrl: 'C:/fixture/repository' },
    };
    run = { id: runId, taskId, attemptNumber: 1, status: 'QUEUED' };
    persistedPatch = {};
    persistedSteps = [];

    vi.spyOn(prisma.task, 'findUnique').mockImplementation((async () => ({ ...task })) as any);
    vi.spyOn(prisma.task, 'findUniqueOrThrow').mockImplementation((async () => ({ ...task })) as any);
    vi.spyOn(prisma.task, 'update').mockImplementation((async ({ data }: any) => Object.assign(task, data)) as any);
    vi.spyOn(prisma.workflowRun, 'findUnique').mockResolvedValue(run as any);
    vi.spyOn(prisma.workflowRun, 'update').mockImplementation((async ({ data }: any) => Object.assign(run, data)) as any);
    vi.spyOn(prisma.taskPatch, 'findUnique').mockResolvedValue(null);

    const tx = {
      workflowStep: { create: vi.fn(async ({ data }: any) => { persistedSteps.push(data); return { id: `step-${persistedSteps.length}` }; }) },
      workflowRun: { update: vi.fn(async ({ data }: any) => Object.assign(run, data)) },
      taskPatch: { create: vi.fn(async ({ data }: any) => { persistedPatch = data; return { id: 'patch-1' }; }) },
      task: {
        updateMany: vi.fn(async ({ data }: any) => { Object.assign(task, data); return { count: 1 }; }),
        update: vi.fn(async ({ data }: any) => Object.assign(task, data)),
      },
      approval: { create: vi.fn() },
      auditEvent: { create: vi.fn(async ({ data }: any) => data) },
    };
    vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: any) => callback(tx)) as any);

    const job = {
      id: `job-${taskId}`, attemptsMade: 0, opts: { attempts: 3 },
      data: { taskId, runId, workspaceId, attemptNumber: 1 } as TaskJobPayload,
    } as any;
    await processTaskJob(job);

    expect(task.failureCode).toBe('VERIFICATION_BLOCKED');
    expect(JSON.stringify(persistedPatch.testResults)).not.toContain(secret);
    expect(JSON.stringify(persistedPatch.securityResults)).not.toContain(secret);
    expect(JSON.stringify(persistedPatch.reviewResults)).not.toContain(secret);
    expect(JSON.stringify(persistedPatch.sandboxDiagnostics)).not.toContain(secret);
    expect(JSON.stringify(persistedSteps)).not.toContain(secret);
    expect(task.failureReason).not.toContain(secret);
  });
});
