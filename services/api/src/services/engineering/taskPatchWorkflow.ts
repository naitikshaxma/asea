import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUnifiedPatch } from './safePatch.js';
import { createTaskWorkspace, readPatchContextFiles, removeTaskWorkspace } from './taskWorkspace.js';
import { requestPatchProposal, type PatchContextFile, type PatchProposal } from './patchProposalClient.js';
import { runRepositoryTests, type TestExecutionReport } from './testRunner.js';
import { runSecurityScans, type SecurityExecutionReport } from './securityScanner.js';
import { reviewTaskPatch, type PatchReviewReport } from './patchReviewClient.js';
import { unavailableSandboxProvider, type SandboxDiagnostics, type SandboxLimits, type SandboxProvider } from './sandboxProvider.js';
import { redactSensitiveText } from './outputRedaction.js';

export interface TaskPatchWorkflowResult {
  snapshotHash: string;
  sourceRevision: string | null;
  patchHash: string;
  summary: string;
  plan: string[];
  evidence: string[];
  contextFiles: string[];
  changedFiles: string[];
  baseFiles: Array<{ path: string; sha256: string | null }>;
  unifiedDiff: string;
  sandboxDiagnostics: SandboxDiagnostics;
  testReport: TestExecutionReport;
  securityReport: SecurityExecutionReport;
  reviewReport: PatchReviewReport;
  workspaceCleanupStatus: 'CLEANED';
}

export class TaskPatchWorkflowError extends Error {
  constructor(message: string, readonly code: 'SNAPSHOT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PATCH_INVALID' | 'CLEANUP_FAILED' | 'CANCELLED') {
    super(message);
    this.name = 'TaskPatchWorkflowError';
  }
}

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 180_000, memoryMb: 1024, cpuCount: 2, maxProcesses: 128, maxOutputBytes: 262_144, workspaceSizeMb: 256, network: 'disabled',
};

function digestTaskFiles(workspacePath: string, filePaths: string[]): string {
  const root = fs.realpathSync(workspacePath);
  const hash = createHash('sha256');
  const uniquePaths = [...new Set(filePaths)].sort();
  for (const filePath of uniquePaths) {
    const normalized = filePath.replace(/\\/g, '/');
    const target = path.resolve(root, ...normalized.split('/'));
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Unsafe task snapshot path');
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Sandbox changed a snapshot file type');
    const real = fs.realpathSync(target);
    const realRelative = path.relative(root, real);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Sandbox changed a snapshot path');
    hash.update(normalized).update('\0').update(fs.readFileSync(real)).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Produces a bounded, reviewable patch inside a disposable task workspace.
 * The authorized source checkout is only read; generated content is never
 * written into it and no repository command is executed here.
 */
export async function generateTaskPatch(input: {
  taskId: string;
  workflowRunId: string;
  repositoryPath: string;
  allowedRoots: string;
  workspaceRoot: string;
  requirement: string;
  sandboxProvider?: SandboxProvider;
  sandboxLimits?: SandboxLimits;
  signal?: AbortSignal;
}): Promise<TaskPatchWorkflowResult> {
  // Use a run-specific opaque directory so retries cannot collide with stale
  // snapshots, and avoid putting arbitrary task identifiers in filesystem paths.
  const runHash = createHash('sha256').update(`${input.taskId}:${input.workflowRunId}`).digest('hex').slice(0, 40);
  const hostToken = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);
  const workspaceId = `task-${runHash}-${hostToken}-${process.pid}-${randomUUID()}`;
  let taskWorkspace;
  try {
    taskWorkspace = await createTaskWorkspace({
      repositoryPath: input.repositoryPath,
      workspaceRoot: input.workspaceRoot,
      taskId: workspaceId,
      allowedRoots: input.allowedRoots.split(',').map((root) => root.trim()).filter(Boolean),
    });
  } catch {
    throw new TaskPatchWorkflowError('Could not create an authorized isolated repository snapshot', 'SNAPSHOT_FAILED');
  }

  try {
    let context: PatchContextFile[];
    try {
      context = readPatchContextFiles({
        taskWorkspacePath: taskWorkspace.path,
        copiedFiles: taskWorkspace.copiedFiles,
        requirement: input.requirement,
      });
    } catch {
      throw new TaskPatchWorkflowError('The authorized snapshot has no eligible source context for patch generation', 'SNAPSHOT_FAILED');
    }
    let proposal: PatchProposal;
    try {
      if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
      proposal = await requestPatchProposal({ taskId: input.taskId, requirement: input.requirement, files: context, signal: input.signal });
    } catch {
      if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
      throw new TaskPatchWorkflowError('Patch proposal service is unavailable or did not return a usable proposal', 'PROVIDER_UNAVAILABLE');
    }
    let applied: ReturnType<typeof applyUnifiedPatch> | undefined;
    let validationError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
        const candidate = applyUnifiedPatch(input.workspaceRoot, taskWorkspace.path, proposal.unified_diff);
        const suppliedPaths = new Set(context.map((file) => file.path));
        const unreviewableFiles = candidate.baseFiles.filter((file) => file.sha256 !== null && !suppliedPaths.has(file.path));
        if (unreviewableFiles.length) throw new Error(`Patch changes files outside supplied review context: ${unreviewableFiles.map((file) => file.path).join(', ')}`);
        applied = candidate;
        break;
      } catch (error) {
        validationError = error;
        if (attempt === 1) throw new TaskPatchWorkflowError('The provider proposal failed patch validation after one repair attempt', 'PATCH_INVALID');
        const feedback = redactSensitiveText(error instanceof Error ? error.message : 'Patch validation failed', { maxBytes: 1000 });
        try {
          proposal = await requestPatchProposal({
            taskId: input.taskId,
            requirement: input.requirement,
            files: context,
            repairFeedback: feedback,
            signal: input.signal,
          });
        } catch {
          if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
          throw new TaskPatchWorkflowError('Patch repair service is unavailable', 'PROVIDER_UNAVAILABLE');
        }
      }
    }
    if (!applied) throw validationError instanceof Error ? validationError : new Error('Patch could not be applied');

    const sandboxProvider = input.sandboxProvider ?? unavailableSandboxProvider;
    const sandboxLimits = input.sandboxLimits ?? DEFAULT_LIMITS;
    let sandboxDiagnostics: SandboxDiagnostics;
    try { sandboxDiagnostics = await sandboxProvider.diagnose(); }
    catch { sandboxDiagnostics = await unavailableSandboxProvider.diagnose(); }

    // Scan the exact generated patch before tests can write build outputs into
    // the disposable workspace. Scanners receive a read-only bind mount.
    const securityReport = await runSecurityScans({
      workspacePath: taskWorkspace.path, provider: sandboxProvider, limits: sandboxLimits, signal: input.signal,
    });
    // A cancelled task must not go on to tests, a (possibly paid) review, or a persisted artifact.
    if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
    const protectedPaths = [...taskWorkspace.copiedFiles, ...applied.changedFiles];
    const beforeTestsHash = digestTaskFiles(taskWorkspace.path, protectedPaths);
    let testReport = await runRepositoryTests({
      workspacePath: taskWorkspace.path, provider: sandboxProvider, limits: sandboxLimits, signal: input.signal,
    });
    if (testReport.commands.length) {
      try {
        const afterTests = digestTaskFiles(taskWorkspace.path, protectedPaths);
        if (afterTests !== beforeTestsHash) throw new Error('Task snapshot contents changed');
      } catch {
        testReport = { ...testReport, status: 'FAILED', reason: 'A test process changed or removed a source snapshot file; its result is not accepted.' };
      }
    }
    if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');
    const reviewFiles = [...context];
    const suppliedPaths = new Set(context.map((file) => file.path));
    for (const baseFile of applied.baseFiles) {
      if (baseFile.sha256 === null && !suppliedPaths.has(baseFile.path)) reviewFiles.push({ path: baseFile.path, content: '' });
    }
    const reviewReport = await reviewTaskPatch({
      taskId: input.taskId, requirement: input.requirement, files: reviewFiles,
      summary: proposal.summary, plan: proposal.plan, evidence: proposal.evidence,
      unifiedDiff: proposal.unified_diff, signal: input.signal,
    });
    if (input.signal?.aborted) throw new TaskPatchWorkflowError('Task cancellation was requested.', 'CANCELLED');

    return {
      snapshotHash: taskWorkspace.snapshotHash,
      sourceRevision: taskWorkspace.sourceRevision,
      patchHash: applied.patchHash,
      summary: proposal.summary,
      plan: proposal.plan,
      evidence: proposal.evidence,
      contextFiles: context.map((file) => file.path),
      changedFiles: applied.changedFiles,
      baseFiles: applied.baseFiles,
      unifiedDiff: proposal.unified_diff,
      sandboxDiagnostics,
      testReport,
      securityReport,
      reviewReport,
      workspaceCleanupStatus: 'CLEANED',
    };
  } finally {
    try {
      removeTaskWorkspace(input.workspaceRoot, taskWorkspace.path);
    } catch {
      throw new TaskPatchWorkflowError('The isolated task workspace could not be removed', 'CLEANUP_FAILED');
    }
  }
}
