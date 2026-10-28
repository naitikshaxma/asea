import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxCommandRequest, SandboxCommandResult, SandboxProvider } from '../../src/services/engineering/sandboxProvider.js';

// The real patch workflow (snapshot, diff validation/apply, test runner,
// scanners, gates and worker persistence) runs here. Only the edges are
// doubles: the proposal/review model clients, the sandbox engine and Prisma.
const mocks = vi.hoisted(() => ({
  requestPatchProposal: vi.fn(),
  reviewTaskPatch: vi.fn(),
  sandbox: null as SandboxProvider | null,
  config: { ALLOWED_REPO_ROOTS: '', TASK_WORKSPACE_ROOT: '' },
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
vi.mock('../../src/services/engineering/patchProposalClient.js', () => ({ requestPatchProposal: mocks.requestPatchProposal }));
vi.mock('../../src/services/engineering/patchReviewClient.js', () => ({ reviewTaskPatch: mocks.reviewTaskPatch }));
vi.mock('../../src/services/engineering/sandboxFactory.js', () => ({
  configuredSandboxLimits: () => ({ timeoutMs: 10_000, memoryMb: 512, cpuCount: 1, maxProcesses: 32, maxOutputBytes: 4096, workspaceSizeMb: 64, network: 'disabled' }),
  configuredSandboxProvider: () => mocks.sandbox,
}));
vi.mock('../../src/services/intelligence/repositoryAnalysisService.js', () => ({ resolveRepositoryFsPath: (url: string) => url }));

import { processTaskJob } from '../../src/worker.js';
import type { TaskJobPayload } from '../../src/services/queueService.js';

const validDiff = [
  '--- a/src/value.js',
  '+++ b/src/value.js',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
].join('\n');

type Script = (request: SandboxCommandRequest) => Partial<SandboxCommandResult> | Promise<Partial<SandboxCommandResult>>;

function scriptedSandbox(script: Script = () => ({})): SandboxProvider & { calls: SandboxCommandRequest[] } {
  const calls: SandboxCommandRequest[] = [];
  return {
    available: true,
    calls,
    async diagnose() {
      return { provider: 'docker', status: 'READY', image: 'asea/sandbox:test', reasonCode: null, message: 'ready' };
    },
    async execute(request) {
      calls.push(request);
      const { command } = request;
      const stdout = command.includes('version') || command.includes('--version') ? 'scanner 1.0'
        : command[0] === 'gitleaks' ? '[]'
          : command[0] === 'node' ? '1 test passed' : JSON.stringify({ results: [] });
      return { exitCode: 0, stdout, stderr: '', durationMs: 5, timedOut: false, cancelled: false, outputTruncated: false, ...(await script(request)) };
    },
  };
}

describe('CODE_PATCH worker flow with the real patch workflow', () => {
  let root: string;
  let repository: string;
  let workspaceRoot: string;
  let task: Record<string, any>;
  let run: Record<string, any>;
  let steps: Array<Record<string, any>>;
  let patches: Array<Record<string, any>>;
  let approvals: Array<Record<string, any>>;
  let audits: Array<Record<string, any>>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-code-patch-flow-'));
    repository = path.join(root, 'repos', 'app');
    workspaceRoot = path.join(root, 'task-workspaces');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'value.js'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
    mocks.config.ALLOWED_REPO_ROOTS = path.join(root, 'repos');
    mocks.config.TASK_WORKSPACE_ROOT = workspaceRoot;

    mocks.requestPatchProposal.mockResolvedValue({
      summary: 'Change the value', plan: ['Update the exported value'], evidence: ['src/value.js:1 exports 1'], unified_diff: validDiff,
    });
    mocks.reviewTaskPatch.mockResolvedValue({ status: 'PASSED', reviewer: 'independent-llm', verdict: 'APPROVE', summary: 'No findings.', findings: [] });

    task = {
      id: 'task-flow', workspaceId: 'ws-flow', creatorId: 'user-1', repositoryId: 'repo-1', title: 'Change value',
      description: 'Change the exported value to two.', taskType: 'CODE_PATCH', priority: 'NORMAL', status: 'QUEUED',
      startedAt: null, completedAt: null, targetBranch: 'main',
      repository: { id: 'repo-1', provider: 'LOCAL', repositoryUrl: repository },
    };
    run = { id: 'run-flow', taskId: task.id, attemptNumber: 1, status: 'QUEUED' };
    steps = []; patches = []; approvals = []; audits = [];

    const p = mocks.prisma;
    p.task.findUnique.mockImplementation(async () => ({ ...task }));
    p.task.findUniqueOrThrow.mockImplementation(async () => ({ ...task }));
    p.task.update.mockImplementation(async ({ data }: any) => Object.assign(task, data));
    p.workflowRun.findUnique.mockImplementation(async () => ({ ...run }));
    p.workflowRun.update.mockImplementation(async ({ data }: any) => Object.assign(run, data));
    p.workflowStep.create.mockImplementation(async ({ data }: any) => { steps.push(data); return { id: `step-${steps.length}` }; });
    p.taskPatch.findUnique.mockResolvedValue(null);
    p.auditEvent.create.mockImplementation(async ({ data }: any) => { audits.push(data); return data; });
    const tx = {
      workflowStep: p.workflowStep,
      workflowRun: p.workflowRun,
      auditEvent: p.auditEvent,
      taskPatch: { create: vi.fn(async ({ data }: any) => { patches.push(data); return { id: `patch-${patches.length}`, ...data }; }) },
      task: {
        update: p.task.update,
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (task.status !== where.status) return { count: 0 };
          Object.assign(task, data);
          return { count: 1 };
        }),
      },
      approval: { create: vi.fn(async ({ data }: any) => { approvals.push(data); return { id: `approval-${approvals.length}`, ...data }; }) },
    };
    p.$transaction.mockImplementation(async (callback: any) => callback(tx));
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.sandbox = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const job = () => ({
    id: 'job-flow', attemptsMade: 0, opts: { attempts: 3 },
    data: { taskId: task.id, runId: run.id, workspaceId: task.workspaceId, attemptNumber: 1 } as TaskJobPayload,
  }) as any;

  it('persists passing evidence and requests a hash-bound approval only after tests, scans and review pass', async () => {
    const sandbox = scriptedSandbox();
    mocks.sandbox = sandbox;

    await processTaskJob(job());

    expect(patches).toHaveLength(1);
    const [patch] = patches;
    expect(patch).toMatchObject({ testStatus: 'PASSED', securityStatus: 'PASSED', reviewStatus: 'PASSED', status: 'PROPOSED', workspaceCleanupStatus: 'CLEANED' });
    expect(patch!.changedFiles).toEqual(['src/value.js']);
    expect(patch!.unifiedDiff).toContain('+export const value = 2;');
    expect(approvals).toEqual([expect.objectContaining({ taskId: task.id, patchHash: patch!.patchHash, requestedById: 'user-1', status: 'PENDING' })]);
    expect(task).toMatchObject({ status: 'NEEDS_ATTENTION', failureCode: 'AWAITING_REVIEW' });
    expect(task.executionMetadata).toMatchObject({ status: 'PATCH_PROPOSED', patchHash: patch!.patchHash, approvalId: 'approval-1' });
    expect(run.status).toBe('COMPLETED');
    expect(steps.map((step) => [step.stepType, step.stepStatus])).toEqual([
      ['VALIDATE_CONTEXT', 'COMPLETED'], ['INSPECT_REPOSITORY', 'COMPLETED'], ['GENERATE_PATCH', 'COMPLETED'],
      ['APPLY_PATCH', 'COMPLETED'], ['VERIFY_BOUNDARIES', 'COMPLETED'], ['EXECUTE_TESTS', 'COMPLETED'],
      ['STATIC_ANALYSIS', 'COMPLETED'], ['INDEPENDENT_REVIEW', 'COMPLETED'], ['REQUEST_APPROVAL', 'COMPLETED'],
    ]);
    expect(audits.map((audit) => audit.eventType)).toEqual(['PATCH_PROPOSED', 'PATCH_APPROVAL_REQUESTED']);
    // Tests ran against the patched snapshot; the checkout and workspace root are untouched/clean
    expect(sandbox.calls.some((call) => call.command.join(' ') === 'node --test')).toBe(true);
    expect(fs.readFileSync(path.join(repository, 'src', 'value.js'), 'utf8')).toBe('export const value = 1;\n');
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    // The reviewer saw the proposed diff, not just the requirement
    expect(JSON.stringify(mocks.reviewTaskPatch.mock.calls[0]?.[0])).toContain('+export const value = 2;');
  });

  it('blocks approval when a scanner reports a finding, keeping the evidence', async () => {
    mocks.sandbox = scriptedSandbox((request) => request.command[0] === 'gitleaks' && request.command[1] === 'dir'
      ? { stdout: JSON.stringify([{ RuleID: 'generic-api-key', Description: 'Possible credential', File: 'src/value.js', StartLine: 1 }]) }
      : {});

    await processTaskJob(job());

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ testStatus: 'PASSED', securityStatus: 'FAILED', reviewStatus: 'PASSED' });
    expect(JSON.stringify(patches[0]!.securityResults)).toContain('generic-api-key');
    expect(approvals).toEqual([]);
    expect(task).toMatchObject({ status: 'NEEDS_ATTENTION', failureCode: 'VERIFICATION_BLOCKED' });
    expect(task.failureReason).toMatch(/Security scan failed/);
    expect(steps.find((step) => step.stepType === 'STATIC_ANALYSIS')?.stepStatus).toBe('FAILED');
    expect(steps.find((step) => step.stepType === 'REQUEST_APPROVAL')?.stepStatus).toBe('SKIPPED');
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
  });

  it('blocks approval when repository tests fail', async () => {
    mocks.sandbox = scriptedSandbox((request) => request.command[0] === 'node'
      ? { exitCode: 1, stdout: 'not ok 1 - value is two', stderr: 'AssertionError' }
      : {});

    await processTaskJob(job());

    expect(patches[0]).toMatchObject({ testStatus: 'FAILED', securityStatus: 'PASSED' });
    expect(approvals).toEqual([]);
    expect(task.failureCode).toBe('VERIFICATION_BLOCKED');
    expect(steps.find((step) => step.stepType === 'EXECUTE_TESTS')?.stepStatus).toBe('FAILED');
  });

  it('blocks approval when the independent reviewer is unavailable', async () => {
    mocks.sandbox = scriptedSandbox();
    mocks.reviewTaskPatch.mockResolvedValue({ status: 'UNAVAILABLE', reviewer: null, verdict: null, summary: 'Reviewer is not configured.', findings: [] });

    await processTaskJob(job());

    expect(patches[0]).toMatchObject({ testStatus: 'PASSED', securityStatus: 'PASSED', reviewStatus: 'UNAVAILABLE' });
    expect(approvals).toEqual([]);
    expect(task.failureReason).toMatch(/Independent review unavailable/);
  });

  it('cancels during sandbox execution without persisting a patch or leaving a workspace', async () => {
    mocks.sandbox = scriptedSandbox(async (request) => {
      if (request.command[0] !== 'node') return {};
      // The API flips the task while its tests run; the worker's poll aborts the sandbox command
      task.status = 'CANCEL_REQUESTED';
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) return resolve();
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { exitCode: null, cancelled: true, stdout: '', stderr: '' };
    });

    await processTaskJob(job());

    expect(patches).toEqual([]);
    expect(approvals).toEqual([]);
    expect(mocks.reviewTaskPatch).not.toHaveBeenCalled();
    expect(task.status).toBe('CANCELLED');
    expect(run.status).toBe('CANCELLED');
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
  }, 15_000);
});
