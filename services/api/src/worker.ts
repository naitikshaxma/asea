import os from 'node:os';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { TaskStatus } from '@prisma/client';
import { TASK_QUEUE_NAME, type TaskJobPayload } from './services/queueService.js';
import { prisma, disconnectPrisma } from './services/prisma.js';
import { validateTaskTransition, validateRunTransition } from './services/workflowStateMachine.js';
import { cancelVerificationRunForTask, runVerificationStep } from './services/verification/verificationService.js';
import { notifyPullRequestForTask } from './services/github/notify.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { resolveRepositoryFsPath } from './services/intelligence/repositoryAnalysisService.js';
import { generateTaskPatch, TaskPatchWorkflowError } from './services/engineering/taskPatchWorkflow.js';
import { configuredSandboxLimits, configuredSandboxProvider } from './services/engineering/sandboxFactory.js';
import { cleanupAbandonedTaskWorkspaces } from './services/engineering/taskWorkspace.js';
import { DockerSandboxProvider } from './services/engineering/dockerSandboxProvider.js';
import { redactSensitiveData, redactSensitiveText } from './services/engineering/outputRedaction.js';

logger.info('Starting Autonomous Engineer Background Task Worker...');

// Identifies the process that ran a WorkflowRun
export const WORKER_ID = `${os.hostname()}:${process.pid}`;

let workerRedis: Redis | null = null;
let worker: Worker<TaskJobPayload> | null = null;

function getWorkerRedis(): Redis {
  if (!workerRedis) {
    const opts = {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    };
    if (config.REDIS_URL) {
      workerRedis = new Redis(config.REDIS_URL, opts);
    } else {
      workerRedis = new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        ...opts,
      });
    }
  }
  return workerRedis;
}

async function cancelTaskRun(taskId: string, runId: string, reason: string): Promise<void> {
  const finishedAt = new Date();

  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  // A run that already finished (e.g. an earlier attempt that FAILED) keeps its status
  if (run && run.status !== 'FAILED' && run.status !== 'COMPLETED') {
    validateRunTransition(run.status, 'CANCELLED');
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', finishedAt, errorSummary: reason },
    });
  }

  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  validateTaskTransition(task.status, 'CANCELLED');
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'CANCELLED', completedAt: task.completedAt ?? finishedAt },
  });

  // The canceller is not recorded on the task, so the audit actor is unknown here
  if (task.taskType === 'VERIFICATION') {
    await cancelVerificationRunForTask(taskId, reason, null);
  }
}

/**
 * Re-reads the task so a cancellation requested while the job is running is
 * honoured between steps (B4). Returns the current status, or null once the
 * task and run have been moved to CANCELLED.
 */
async function honourCancellation(
  taskId: string,
  runId: string,
  reason: string
): Promise<TaskStatus | null> {
  const { status } = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true },
  });
  if (status === 'CANCEL_REQUESTED') {
    logger.info(`[Worker] Task ${taskId} cancellation requested. Stopping run ${runId}.`);
    await cancelTaskRun(taskId, runId, reason);
    return null;
  }
  return status;
}

function watchTaskCancellation(taskId: string, controller: AbortController): () => void {
  let pending = false;
  const timer = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = true;
    void prisma.task.findUnique({ where: { id: taskId }, select: { status: true } })
      .then((current) => {
        if (current?.status === 'CANCEL_REQUESTED') controller.abort();
      })
      .catch((error) => logger.warn(`[Worker] Cancellation poll failed for task ${taskId}`, { error }))
      .finally(() => { pending = false; });
  }, 300);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Each BullMQ attempt gets its own WorkflowRun. The first attempt uses the run
 * created with the task; a retry finds or creates the run for its attempt
 * number (a stalled job re-run keeps the same attempt number and run).
 */
async function resolveAttemptRun(job: Job<TaskJobPayload>): Promise<{ runId: string; attemptNumber: number }> {
  const attemptNumber = job.data.attemptNumber + job.attemptsMade;
  if (job.attemptsMade === 0) {
    return { runId: job.data.runId, attemptNumber };
  }

  const existing = await prisma.workflowRun.findFirst({
    where: { taskId: job.data.taskId, attemptNumber },
  });
  const run =
    existing ??
    (await prisma.workflowRun.create({
      data: { taskId: job.data.taskId, attemptNumber, status: 'QUEUED' },
    }));
  return { runId: run.id, attemptNumber };
}

export async function processTaskJob(job: Job<TaskJobPayload>): Promise<void> {
  const { taskId, workspaceId, simulatedFailure } = job.data;
  const startedAt = new Date();

  logger.info(`[Worker] Received job for task ${taskId}`, {
    jobId: job.id,
    attempt: job.attemptsMade + 1,
  });

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { runs: true, repository: true },
  });

  if (!task) {
    logger.error(`[Worker] Task ${taskId} not found in database. Aborting job.`);
    return;
  }

  // A task already cancelled by the API is terminal; a pending request still
  // needs the worker to close its active run and record cancellation.
  if (task.status === 'CANCELLED') return;
  if (task.status === 'CANCEL_REQUESTED') {
    logger.info(`[Worker] Task ${taskId} has been cancelled. Marking run cancelled.`);
    await cancelTaskRun(taskId, job.data.runId, 'Task cancelled by user before execution commenced.');
    return;
  }

  // BullMQ may redeliver after the database transaction committed but before
  // the worker acknowledged the job. The transaction stores the patch and
  // NEEDS_ATTENTION state atomically; replaying it would collide with the
  // completed run's artifact and could reopen a gate that was already denied.
  if (task.status === 'NEEDS_ATTENTION' || task.status === 'COMPLETED' || task.status === 'FAILED') {
    logger.info(`[Worker] Ignoring redelivered job for terminal task ${taskId}`, { status: task.status });
    return;
  }

  const { runId, attemptNumber } = await resolveAttemptRun(job);
  logger.info(`[Worker] Task ${taskId} attempt ${attemptNumber} uses run ${runId}`);
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;

  try {
    // Transition to RUNNING
    validateTaskTransition(task.status, 'RUNNING');
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'RUNNING',
        startedAt: task.startedAt ?? startedAt,
      },
    });

    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (run) {
      validateRunTransition(run.status, 'RUNNING');
      await prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: 'RUNNING',
          startedAt,
          workerId: WORKER_ID,
        },
      });
    }

    // Step 1: Context Validation
    await prisma.workflowStep.create({
      data: {
        workflowRunId: runId,
        stepType: 'VALIDATE_CONTEXT',
        stepStatus: 'COMPLETED',
        stepOrder: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
        resultMetadata: {
          workspaceId,
          titleLength: task.title.length,
          promptLength: task.description.length,
        },
      },
    });

    if ((await honourCancellation(taskId, runId, 'Task cancelled by user after VALIDATE_CONTEXT.')) === null) {
      return;
    }

    // Check simulated failure flag for automated tests
    if (simulatedFailure) {
      throw new Error('Simulated worker fault for test verification');
    }

    let lastStep: string;
    if (task.taskType === 'VERIFICATION') {
      // Steps 2-3: index the repository, then the engine's agent pipeline; the
      // placeholder steps don't apply. Each step is RUNNING while it executes
      // and is marked FAILED if the verification throws during it.
      let stepOrder = 1;
      let current: { id: string } | null = null;
      try {
        await runVerificationStep({
          taskId,
          workspaceId,
          actorId: task.creatorId,
          attemptNumber,
          isFinalAttempt: attempt >= maxAttempts,
          hooks: {
            started: async (stepType) => {
              current = await prisma.workflowStep.create({
                data: { workflowRunId: runId, stepType, stepStatus: 'RUNNING', stepOrder: ++stepOrder, startedAt: new Date() },
              });
            },
            finished: async (_stepType, resultMetadata) => {
              await prisma.workflowStep.update({
                where: { id: current!.id },
                data: { stepStatus: 'COMPLETED', finishedAt: new Date(), resultMetadata },
              });
              current = null;
            },
          },
        });
      } catch (err) {
        const failed = current as { id: string } | null;
        if (failed) {
          const safeMessage = redactSensitiveText(err instanceof Error ? err.message : String(err), { maxBytes: 1000 });
          await prisma.workflowStep.update({
            where: { id: failed.id },
            data: { stepStatus: 'FAILED', finishedAt: new Date(), failureSummary: safeMessage },
          });
        }
        throw err;
      }
      lastStep = 'VERIFICATION_PIPELINE';
    } else if (task.taskType === 'CODE_PATCH') {
      const repository = task.repository;
      const unavailableReason = !repository
        ? 'A registered repository is required before a patch can be proposed.'
        : repository.provider !== 'LOCAL'
          ? 'Patch proposals currently require an authorized local repository; GitHub checkout is not configured.'
          : !config.ALLOWED_REPO_ROOTS?.trim()
            ? 'Repository access is unavailable because ALLOWED_REPO_ROOTS is not configured.'
            : !config.TASK_WORKSPACE_ROOT?.trim()
              ? 'Isolated patch generation is unavailable because TASK_WORKSPACE_ROOT is not configured.'
              : null;

      if (unavailableReason) {
        const unavailableAt = new Date();
        await prisma.workflowStep.create({
          data: {
            workflowRunId: runId,
            stepType: 'INSPECT_REPOSITORY',
            stepStatus: 'SKIPPED',
            stepOrder: 2,
            startedAt: unavailableAt,
            finishedAt: unavailableAt,
            resultMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN', reason: unavailableReason },
            failureSummary: unavailableReason,
          },
        });
        if ((await honourCancellation(taskId, runId, 'Task cancelled while checking repository access.')) === null) return;
        const finishedAt = new Date();
        validateTaskTransition('RUNNING', 'NEEDS_ATTENTION');
        await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'COMPLETED', finishedAt } });
        await prisma.task.update({
          where: { id: taskId },
          data: {
            status: 'NEEDS_ATTENTION', completedAt: finishedAt, failureCode: 'WORKFLOW_UNAVAILABLE', failureReason: unavailableReason,
            executionMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN' },
          },
        });
        await prisma.auditEvent.create({
          data: {
            workspaceId, actorId: task.creatorId, eventType: 'TASK_NEEDS_ATTENTION', resourceType: 'Task', resourceId: taskId,
            metadata: { runId, reasonCode: 'WORKFLOW_UNAVAILABLE', taskType: task.taskType },
          },
        });
        logger.warn(`[Worker] CODE_PATCH task ${taskId} needs attention because repository access is unavailable`, { runId });
        return;
      }

      let repositoryPath: string;
      try {
        repositoryPath = resolveRepositoryFsPath(repository!.repositoryUrl);
      } catch {
        const reason = 'The registered repository path is outside the configured authorized repository roots or is unavailable.';
        const skippedAt = new Date();
        await prisma.workflowStep.create({
          data: {
            workflowRunId: runId, stepType: 'INSPECT_REPOSITORY', stepStatus: 'SKIPPED', stepOrder: 2,
            startedAt: skippedAt, finishedAt: skippedAt,
            resultMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN', reason }, failureSummary: reason,
          },
        });
        if ((await honourCancellation(taskId, runId, 'Task cancelled while checking repository authorization.')) === null) return;
        const finishedAt = new Date();
        await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'COMPLETED', finishedAt } });
        await prisma.task.update({
          where: { id: taskId },
          data: { status: 'NEEDS_ATTENTION', completedAt: finishedAt, failureCode: 'REPOSITORY_UNAVAILABLE', failureReason: reason,
            executionMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN' } },
        });
        await prisma.auditEvent.create({ data: { workspaceId, actorId: task.creatorId, eventType: 'TASK_NEEDS_ATTENTION', resourceType: 'Task', resourceId: taskId,
          metadata: { runId, reasonCode: 'REPOSITORY_UNAVAILABLE', taskType: task.taskType } } });
        return;
      }

      // A completed patch artifact makes redelivery of this run idempotent.
      const existingPatch = await prisma.taskPatch.findUnique({ where: { workflowRunId: runId } });
      if (existingPatch) return;

      let proposal;
      const cancellationController = new AbortController();
      const stopCancellationPoll = watchTaskCancellation(taskId, cancellationController);
      try {
        proposal = await generateTaskPatch({
          taskId,
          workflowRunId: runId,
          repositoryPath,
          allowedRoots: config.ALLOWED_REPO_ROOTS!,
          workspaceRoot: config.TASK_WORKSPACE_ROOT!,
          requirement: task.description,
          sandboxProvider: configuredSandboxProvider(),
          sandboxLimits: configuredSandboxLimits(),
          signal: cancellationController.signal,
        });
      } catch (error) {
        stopCancellationPoll();
        if (!(error instanceof TaskPatchWorkflowError)) throw error;
        if (error.code === 'CANCELLED') {
          await honourCancellation(taskId, runId, 'Task cancelled during patch generation or isolated verification.');
          return;
        }
        const safeMessage = redactSensitiveText(error.message, { maxBytes: 1000 });
        const failedAt = new Date();
        const stepType = error.code === 'SNAPSHOT_FAILED' ? 'INSPECT_REPOSITORY' : 'GENERATE_PATCH';
        validateTaskTransition('RUNNING', 'NEEDS_ATTENTION');
        await prisma.$transaction(async (tx) => {
          await tx.workflowStep.create({
            data: { workflowRunId: runId, stepType, stepStatus: 'FAILED', stepOrder: 2, startedAt, finishedAt: failedAt,
              failureSummary: safeMessage, resultMetadata: { status: 'UNAVAILABLE', reasonCode: error.code, patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN' } },
          });
          await tx.workflowRun.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: failedAt, errorSummary: safeMessage } });
          await tx.task.update({ where: { id: taskId }, data: { status: 'NEEDS_ATTENTION', completedAt: failedAt,
            failureCode: `PATCH_${error.code}`, failureReason: safeMessage,
            executionMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN', reasonCode: error.code } } });
          await tx.auditEvent.create({ data: { workspaceId, actorId: task.creatorId, eventType: 'TASK_NEEDS_ATTENTION',
            resourceType: 'Task', resourceId: taskId, metadata: { runId, reasonCode: `PATCH_${error.code}`, taskType: task.taskType } } });
        });
        return;
      }
      // Sanitize all execution evidence before it enters workflow-step or patch JSON columns.
      const safeTestReport = redactSensitiveData(proposal.testReport);
      const safeSecurityReport = redactSensitiveData(proposal.securityReport);
      const safeReviewReport = redactSensitiveData(proposal.reviewReport);
      const safeSandboxDiagnostics = redactSensitiveData(proposal.sandboxDiagnostics);
      const testStatus = proposal.testReport.status;
      const securityStatus = proposal.securityReport.status;
      const reviewStatus = proposal.reviewReport.status;
      const verificationPassed = testStatus === 'PASSED' && securityStatus === 'PASSED' && reviewStatus === 'PASSED';
      const failureDetails = redactSensitiveText([
        testStatus !== 'PASSED' ? `Tests ${testStatus.toLowerCase()}: ${safeTestReport.reason ?? safeTestReport.commands.find((result) => result.status !== 'PASSED')?.summary ?? 'no passing test result was produced'}` : null,
        securityStatus !== 'PASSED' ? `Security scan ${securityStatus.toLowerCase()}: ${safeSecurityReport.reason ?? safeSecurityReport.limitations.join('; ')}` : null,
        reviewStatus !== 'PASSED' ? `Independent review ${reviewStatus.toLowerCase()}: ${safeReviewReport.summary}` : null,
      ].filter(Boolean).join(' '), { maxBytes: 1000 });
      const approvalRequestedAt = new Date();
      try {
        await prisma.$transaction(async (tx) => {
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'INSPECT_REPOSITORY', stepStatus: 'COMPLETED', stepOrder: 2,
            startedAt, finishedAt: new Date(), resultMetadata: { snapshotHash: proposal.snapshotHash, sourceRevision: proposal.sourceRevision,
              contextFiles: proposal.contextFiles, contextFileCount: proposal.contextFiles.length } },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'GENERATE_PATCH', stepStatus: 'COMPLETED', stepOrder: 3,
            startedAt, finishedAt: new Date(), resultMetadata: { patchHash: proposal.patchHash, summary: proposal.summary,
              plan: proposal.plan, changedFiles: proposal.changedFiles } },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'APPLY_PATCH', stepStatus: 'COMPLETED', stepOrder: 4,
            startedAt, finishedAt: new Date(), resultMetadata: { patchHash: proposal.patchHash, changedFiles: proposal.changedFiles,
              appliedTo: 'DISPOSABLE_TASK_WORKSPACE', workspaceCleanupStatus: proposal.workspaceCleanupStatus } },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'VERIFY_BOUNDARIES',
            stepStatus: safeSandboxDiagnostics.status === 'READY' ? 'COMPLETED' : 'SKIPPED', stepOrder: 5,
            startedAt, finishedAt: new Date(), resultMetadata: { status: safeSandboxDiagnostics.status, patchHash: proposal.patchHash,
              changedFiles: proposal.changedFiles, sandbox: { ...safeSandboxDiagnostics } } },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'EXECUTE_TESTS',
            stepStatus: testStatus === 'PASSED' ? 'COMPLETED' : ['FAILED', 'TIMED_OUT'].includes(testStatus) ? 'FAILED' : 'SKIPPED',
            stepOrder: 6, startedAt, finishedAt: new Date(), resultMetadata: safeTestReport as any,
            failureSummary: testStatus === 'FAILED' || testStatus === 'TIMED_OUT' ? failureDetails.slice(0, 1000) : null },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'STATIC_ANALYSIS',
            stepStatus: securityStatus === 'PASSED' ? 'COMPLETED' : securityStatus === 'FAILED' ? 'FAILED' : 'SKIPPED',
            stepOrder: 7, startedAt, finishedAt: new Date(), resultMetadata: safeSecurityReport as any,
            failureSummary: securityStatus === 'FAILED' ? failureDetails.slice(0, 1000) : null },
        });
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'INDEPENDENT_REVIEW',
            stepStatus: reviewStatus === 'PASSED' ? 'COMPLETED' : reviewStatus === 'FAILED' ? 'FAILED' : 'SKIPPED',
            stepOrder: 8, startedAt, finishedAt: new Date(), resultMetadata: safeReviewReport as any,
            failureSummary: reviewStatus === 'FAILED' ? redactSensitiveText(safeReviewReport.summary, { maxBytes: 1000 }) : null },
        });
        const patch = await tx.taskPatch.create({
          data: { taskId, workflowRunId: runId, snapshotHash: proposal.snapshotHash, sourceRevision: proposal.sourceRevision, patchHash: proposal.patchHash,
            summary: proposal.summary, plan: proposal.plan as any, contextFiles: proposal.contextFiles as any,
            evidence: proposal.evidence as any,
            changedFiles: proposal.changedFiles as any, baseFiles: proposal.baseFiles as any, unifiedDiff: proposal.unifiedDiff,
            testStatus, securityStatus, reviewStatus,
            testResults: safeTestReport as any, securityResults: safeSecurityReport as any,
            reviewResults: safeReviewReport as any, sandboxDiagnostics: safeSandboxDiagnostics as any,
            workspaceCleanupStatus: proposal.workspaceCleanupStatus, status: 'PROPOSED' },
        });
        const finishedAt = new Date();
        const taskClaim = await tx.task.updateMany({
          where: { id: taskId, status: 'RUNNING' },
          data: { status: 'NEEDS_ATTENTION', completedAt: finishedAt,
            failureCode: verificationPassed ? 'AWAITING_REVIEW' : 'VERIFICATION_BLOCKED',
            failureReason: verificationPassed ? 'All automated verification stages passed. A second workspace administrator must approve this patch.' : failureDetails,
            executionMetadata: { status: verificationPassed ? 'PATCH_PROPOSED' : 'PATCH_BLOCKED', patchHash: proposal.patchHash,
              patchStatus: 'PROPOSED', testStatus, securityStatus, reviewStatus } },
        });
        const approval = taskClaim.count === 1 && verificationPassed
          ? await tx.approval.create({ data: { taskId, patchHash: proposal.patchHash, requestedById: task.creatorId, status: 'PENDING' } })
          : null;
        if (approval) {
          await tx.task.update({ where: { id: taskId }, data: { executionMetadata: {
            status: 'PATCH_PROPOSED', patchHash: proposal.patchHash, patchStatus: 'PROPOSED', approvalId: approval.id,
            testStatus, securityStatus, reviewStatus,
          } } });
        }
        await tx.workflowStep.create({
          data: { workflowRunId: runId, stepType: 'REQUEST_APPROVAL', stepStatus: approval ? 'COMPLETED' : 'SKIPPED', stepOrder: 9,
            startedAt: approvalRequestedAt, finishedAt: new Date(),
            resultMetadata: approval ? { approvalId: approval.id, patchHash: proposal.patchHash } : { status: 'BLOCKED', reason: verificationPassed ? 'Task is being cancelled.' : failureDetails } },
        });
        if (taskClaim.count === 1) await tx.workflowRun.update({ where: { id: runId }, data: { status: 'COMPLETED', finishedAt } });
        await tx.auditEvent.create({
          data: { workspaceId, actorId: task.creatorId, eventType: 'PATCH_PROPOSED', resourceType: 'TaskPatch', resourceId: patch.id,
            metadata: { taskId, runId, approvalId: approval?.id ?? null, patchHash: proposal.patchHash, snapshotHash: proposal.snapshotHash,
              changedFiles: proposal.changedFiles, testStatus, securityStatus, reviewStatus } },
        });
        if (approval) await tx.auditEvent.create({
          data: { workspaceId, actorId: task.creatorId, eventType: 'PATCH_APPROVAL_REQUESTED', resourceType: 'Approval', resourceId: approval.id,
            metadata: { taskId, patchHash: proposal.patchHash } },
        });
          return { patch, approval, taskClaim };
        });
      } finally {
        stopCancellationPoll();
      }
      if ((await honourCancellation(taskId, runId, 'Task cancelled during isolated verification.')) === null) return;
      if (verificationPassed) logger.info(`[Worker] Proposed verified patch ${proposal.patchHash} for task ${taskId}; awaiting human review`, { runId });
      else logger.warn(`[Worker] Patch ${proposal.patchHash} for task ${taskId} is blocked by verification results`, { runId, testStatus, securityStatus, reviewStatus });
      return;
    } else {
      // These task kinds still do not have a provider-backed engineering or
      // execution pipeline. Record the unavailable result honestly instead of
      // marking a placeholder inspection as successful work.
      const unavailableReason = 'This task type has no configured engineering workflow; no patch or test result was produced.';
      // Step 2: Repository Inspection & Intelligence
      const unavailableAt = new Date();
      await prisma.workflowStep.create({
        data: {
          workflowRunId: runId,
          stepType: 'GENERATE_SPEC',
          stepStatus: 'SKIPPED',
          stepOrder: 2,
          startedAt: unavailableAt,
          finishedAt: unavailableAt,
          resultMetadata: {
            status: 'UNAVAILABLE',
            taskType: task.taskType,
            patchStatus: 'NOT_GENERATED',
            testStatus: 'NOT_RUN',
            reason: unavailableReason,
          },
          failureSummary: unavailableReason,
        },
      });
      if ((await honourCancellation(taskId, runId, 'Task cancelled while checking engineering workflow availability.')) === null) return;

      const finishedAt = new Date();
      validateTaskTransition('RUNNING', 'NEEDS_ATTENTION');
      await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'COMPLETED', finishedAt } });
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'NEEDS_ATTENTION',
          failureCode: 'WORKFLOW_UNAVAILABLE',
          failureReason: unavailableReason,
          executionMetadata: { status: 'UNAVAILABLE', patchStatus: 'NOT_GENERATED', testStatus: 'NOT_RUN' },
        },
      });
      await prisma.auditEvent.create({
        data: {
          workspaceId, actorId: task.creatorId, eventType: 'TASK_NEEDS_ATTENTION',
          resourceType: 'Task', resourceId: taskId,
          metadata: { runId, reasonCode: 'WORKFLOW_UNAVAILABLE', taskType: task.taskType },
        },
      });
      logger.warn(`[Worker] Task ${taskId} needs attention because its workflow is unavailable`, { runId, taskType: task.taskType });
      return;
    }

    // Mark Task & Run as COMPLETED, unless cancellation was requested meanwhile
    const statusBeforeCompletion = await honourCancellation(
      taskId,
      runId,
      `Task cancelled by user after ${lastStep}.`
    );
    if (statusBeforeCompletion === null) {
      return;
    }
    validateTaskTransition(statusBeforeCompletion, 'COMPLETED');

    const finishedAt = new Date();
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED',
        finishedAt,
      },
    });

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'COMPLETED',
        completedAt: finishedAt,
      },
    });

    await prisma.auditEvent.create({
      data: {
        workspaceId,
        actorId: task.creatorId,
        eventType: 'TASK_COMPLETED',
        resourceType: 'Task',
        resourceId: taskId,
        metadata: {
          runId,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
      },
    });

    logger.info(`[Worker] Successfully completed task ${taskId} (Run ${runId})`);
    if (task.taskType === 'VERIFICATION') {
      // A pull request that triggered the run gets the result as a comment
      await notifyPullRequestForTask(taskId);
    }
  } catch (err: unknown) {
    const errorMsg = redactSensitiveText(err instanceof Error ? err.message : String(err), { maxBytes: 1000 });
    const finishedAt = new Date();

    // A cancellation requested during the failed attempt wins over a retry
    if ((await honourCancellation(taskId, runId, 'Task cancelled by user after a failed attempt.')) === null) {
      return;
    }

    // This attempt's run records the failure, whether or not BullMQ retries
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        finishedAt,
        errorSummary: errorMsg,
      },
    });

    // B3: FAILED is terminal for the task, so only the final attempt sets it.
    // Earlier attempts leave the task RUNNING; the retry gets a new run.
    if (attempt < maxAttempts) {
      logger.warn(`[Worker] Task ${taskId} attempt ${attempt}/${maxAttempts} failed; retrying`, {
        runId,
        error: errorMsg,
      });
      throw err;
    }

    logger.error(`[Worker] Task ${taskId} failed during processing`, {
      runId,
      error: errorMsg,
    });

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'FAILED',
        completedAt: finishedAt,
        failureCode: 'EXECUTION_FAILURE',
        failureReason: errorMsg,
      },
    });

    await prisma.auditEvent.create({
      data: {
        workspaceId,
        actorId: task.creatorId,
        eventType: 'TASK_FAILED',
        resourceType: 'Task',
        resourceId: taskId,
        metadata: {
          runId,
          error: errorMsg,
        },
      },
    });
    if (task.taskType === 'VERIFICATION') {
      await notifyPullRequestForTask(taskId, errorMsg);
    }

    throw err; // Allow BullMQ backoff retry
  }
}

export function startWorker(): Worker<TaskJobPayload> {
  if (!worker) {
    if (config.TASK_WORKSPACE_ROOT?.trim()) {
      try {
        const cleanup = cleanupAbandonedTaskWorkspaces(config.TASK_WORKSPACE_ROOT);
        if (cleanup.removed || cleanup.failed) logger.info('[Worker] Reaped abandoned task workspaces', {
          removed: cleanup.removed,
          failed: cleanup.failed,
        });
      } catch (error) {
        logger.warn('[Worker] Could not inspect abandoned task workspaces', { error });
      }
    }
    const sandbox = configuredSandboxProvider();
    if (sandbox instanceof DockerSandboxProvider) {
      void sandbox.reapAbandonedContainers()
        .then((cleanup) => {
          if (cleanup.removed || cleanup.failed) logger.info('[Worker] Reaped abandoned sandbox containers', { ...cleanup });
        })
        .catch((error) => logger.warn('[Worker] Could not inspect abandoned sandbox containers', {
          error: redactSensitiveText(error instanceof Error ? error.message : String(error), { maxBytes: 500 }),
        }));
    }
    worker = new Worker<TaskJobPayload>(
      TASK_QUEUE_NAME,
      async (job) => {
        await processTaskJob(job);
      },
      {
        connection: getWorkerRedis(),
        concurrency: 2,
      }
    );

    worker.on('ready', () => {
      logger.info(`[Worker] BullMQ worker listening on queue '${TASK_QUEUE_NAME}'`);
    });

    worker.on('failed', (job, err) => {
      logger.warn(`[Worker] Job ${job?.id} failed`, { error: redactSensitiveText(err.message, { maxBytes: 1000 }) });
    });
  }

  return worker;
}

// If executed directly as standalone process
if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  startWorker();

  async function shutdown(signal: string) {
    logger.info(`Received ${signal}. Shutting down worker...`);
    if (worker) {
      await worker.close();
    }
    if (workerRedis) {
      workerRedis.disconnect();
    }
    await disconnectPrisma();
    logger.info('Worker shutdown complete.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
