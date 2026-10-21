import os from 'node:os';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { TaskStatus } from '@prisma/client';
import { TASK_QUEUE_NAME, type TaskJobPayload } from './services/queueService.js';
import { prisma, disconnectPrisma } from './services/prisma.js';
import { validateTaskTransition, validateRunTransition } from './services/workflowStateMachine.js';
import { createAndRunAnalysis } from './services/intelligence/repositoryAnalysisService.js';
import { cancelVerificationRunForTask, runVerificationStep } from './services/verification/verificationService.js';
import { config } from './config.js';
import { logger } from './logger.js';

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
    include: { runs: true },
  });

  if (!task) {
    logger.error(`[Worker] Task ${taskId} not found in database. Aborting job.`);
    return;
  }

  // Check if task was cancelled before pickup
  if (task.status === 'CANCEL_REQUESTED' || task.status === 'CANCELLED') {
    logger.info(`[Worker] Task ${taskId} has been cancelled. Marking run cancelled.`);
    await cancelTaskRun(taskId, job.data.runId, 'Task cancelled by user before execution commenced.');
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
      // Step 2: ASEA static analysis; the placeholder steps don't apply
      const stepStartedAt = new Date();
      const resultMetadata = await runVerificationStep({
        taskId,
        workspaceId,
        actorId: task.creatorId,
        attemptNumber,
        isFinalAttempt: attempt >= maxAttempts,
      });
      await prisma.workflowStep.create({
        data: {
          workflowRunId: runId,
          stepType: 'STATIC_ANALYSIS',
          stepStatus: 'COMPLETED',
          stepOrder: 2,
          startedAt: stepStartedAt,
          finishedAt: new Date(),
          resultMetadata,
        },
      });
      lastStep = 'STATIC_ANALYSIS';
    } else {
      // Step 2: Repository Inspection & Intelligence
      let repoInspectionMeta: Record<string, unknown> = {
        repositoryUrl: task.repositoryUrl || 'local_workspace_only',
        targetBranch: task.targetBranch,
        phase: 'PHASE_3_INTELLIGENCE',
      };

      if (task.repositoryId) {
        try {
          const analysis = await createAndRunAnalysis(task.repositoryId, workspaceId);
          repoInspectionMeta = {
            ...repoInspectionMeta,
            analysisId: analysis.id,
            technologies: analysis.technologies.map((t) => t.name),
            eligibleFiles: analysis.statistics?.eligibleFiles,
          };
        } catch (err: unknown) {
          repoInspectionMeta['analysisNote'] = `Auto-analysis skipped: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      await prisma.workflowStep.create({
        data: {
          workflowRunId: runId,
          stepType: 'INSPECT_REPOSITORY',
          stepStatus: 'COMPLETED',
          stepOrder: 2,
          startedAt: new Date(),
          finishedAt: new Date(),
          resultMetadata: repoInspectionMeta as any,
        },
      });

      if ((await honourCancellation(taskId, runId, 'Task cancelled by user after INSPECT_REPOSITORY.')) === null) {
        return;
      }

      // Step 3: Spec & Plan Generation
      await prisma.workflowStep.create({
        data: {
          workflowRunId: runId,
          stepType: 'GENERATE_SPEC',
          stepStatus: 'COMPLETED',
          stepOrder: 3,
          startedAt: new Date(),
          finishedAt: new Date(),
          resultMetadata: {
            taskType: task.taskType,
            phase: 'PHASE_2_DETERMINISTIC_PIPELINE',
            note: 'Task parsed and queued for future Phase 3 autonomous agent synthesis.',
          },
        },
      });

      if ((await honourCancellation(taskId, runId, 'Task cancelled by user after GENERATE_SPEC.')) === null) {
        return;
      }

      // Step 4: Boundary & Safety Audit
      await prisma.workflowStep.create({
        data: {
          workflowRunId: runId,
          stepType: 'VERIFY_BOUNDARIES',
          stepStatus: 'COMPLETED',
          stepOrder: 4,
          startedAt: new Date(),
          finishedAt: new Date(),
          resultMetadata: {
            note: 'Placeholder step: no boundary verification is implemented yet.',
          },
        },
      });
      lastStep = 'VERIFY_BOUNDARIES';
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
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
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

    throw err; // Allow BullMQ backoff retry
  }
}

export function startWorker(): Worker<TaskJobPayload> {
  if (!worker) {
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
      logger.warn(`[Worker] Job ${job?.id} failed`, { error: err.message });
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
