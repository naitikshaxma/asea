import { Router } from 'express';
import { z } from 'zod';
import { TaskStatus, TaskType } from '@prisma/client';
import {
  TaskSubmissionRequestSchema,
  type TaskResponse,
  type TaskListResponse,
} from '@autonomous-engineer/contracts';
import { prisma } from '../services/prisma.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { validateTaskTransition, isTaskCancellable } from '../services/workflowStateMachine.js';
import { dispatchPendingOutboxEvents } from '../services/outboxDispatcher.js';
import { AppError } from '../middlewares/errorHandler.js';
import { cancelVerificationRunForTask } from '../services/verification/verificationService.js';
import { submitTask } from '../services/taskSubmission.js';
import { redactSensitiveData } from '../services/engineering/outputRedaction.js';

export const tasksRouter = Router({ mergeParams: true });

// List filters use the database enums: the contract's status enum still has
// legacy values no stored task can hold, and every stored type stays listable.
const taskListQuerySchema = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  taskType: z.nativeEnum(TaskType).optional(),
});

function formatTaskResponse(task: any): TaskResponse {
  return redactSensitiveData({
    id: task.id,
    workspaceId: task.workspaceId,
    repositoryId: task.repositoryId ?? undefined,
    creatorId: task.creatorId ?? undefined,
    title: task.title,
    description: task.description,
    taskType: task.taskType,
    priority: task.priority,
    status: task.status,
    repositoryUrl: task.repositoryUrl ?? undefined,
    targetBranch: task.targetBranch ?? undefined,
    idempotencyKey: task.idempotencyKey ?? undefined,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
    startedAt: task.startedAt instanceof Date ? task.startedAt.toISOString() : task.startedAt,
    completedAt: task.completedAt instanceof Date ? task.completedAt.toISOString() : task.completedAt,
    failureCode: task.failureCode ?? undefined,
    failureReason: task.failureReason ?? undefined,
    executionMetadata: task.executionMetadata ?? undefined,
    runs: task.runs
      ? task.runs.map((r: any) => ({
          id: r.id,
          taskId: r.taskId,
          attemptNumber: r.attemptNumber,
          status: r.status,
          workerId: r.workerId ?? undefined,
          startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : r.startedAt,
          finishedAt: r.finishedAt instanceof Date ? r.finishedAt.toISOString() : r.finishedAt,
          errorSummary: r.errorSummary ?? undefined,
          steps: r.steps
            ? r.steps.map((s: any) => ({
                id: s.id,
                workflowRunId: s.workflowRunId,
                stepType: s.stepType,
                stepStatus: s.stepStatus,
                stepOrder: s.stepOrder,
                startedAt: s.startedAt instanceof Date ? s.startedAt.toISOString() : s.startedAt,
                finishedAt: s.finishedAt instanceof Date ? s.finishedAt.toISOString() : s.finishedAt,
                resultMetadata: s.resultMetadata ?? undefined,
                failureSummary: s.failureSummary ?? undefined,
              }))
            : undefined,
        }))
      : undefined,
  } as TaskResponse);
}

// -----------------------------------------------------------------------------
// Workspace-Scoped Routes (Phase 2 Canonical)
// -----------------------------------------------------------------------------

tasksRouter.post(
  '/workspaces/:workspaceId/tasks',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const validated = TaskSubmissionRequestSchema.parse(req.body);
      const { task, created } = await submitTask(workspaceId, req.user!.id, validated);
      if (created) {
        // Dispatch outbox asynchronously
        dispatchPendingOutboxEvents().catch(() => {});
      }
      res.status(created ? 201 : 200).json(formatTaskResponse(task));
    } catch (err) {
      next(err);
    }
  }
);

tasksRouter.get(
  '/workspaces/:workspaceId/tasks',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const { status, taskType } = taskListQuerySchema.parse(req.query);

      const tasks = await prisma.task.findMany({
        where: {
          workspaceId,
          ...(status ? { status } : {}),
          ...(taskType ? { taskType } : {}),
        },
        include: { runs: true },
        orderBy: { createdAt: 'desc' },
      });

      const formatted = tasks.map(formatTaskResponse);
      res.status(200).json({ tasks: formatted, total: formatted.length });
    } catch (err) {
      next(err);
    }
  }
);

tasksRouter.get(
  '/workspaces/:workspaceId/tasks/:taskId',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, taskId } = req.params;
      const task = await prisma.task.findFirst({
        where: { id: taskId, workspaceId },
        include: {
          runs: {
            include: { steps: { orderBy: { stepOrder: 'asc' } } },
            orderBy: { attemptNumber: 'desc' },
          },
        },
      });

      if (!task) {
        return next(new AppError(404, 'NOT_FOUND', `Task with ID ${taskId} not found`));
      }

      res.status(200).json(formatTaskResponse(task));
    } catch (err) {
      next(err);
    }
  }
);

tasksRouter.get(
  '/workspaces/:workspaceId/tasks/:taskId/patch',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, taskId } = req.params;
      const patch = await prisma.taskPatch.findFirst({
        where: { taskId, task: { workspaceId } },
        orderBy: { createdAt: 'desc' },
      });
      if (!patch) throw new AppError(404, 'NOT_FOUND', 'Task patch not found');
      res.status(200).json(redactSensitiveData({
        id: patch.id,
        taskId: patch.taskId,
        workflowRunId: patch.workflowRunId,
        snapshotHash: patch.snapshotHash,
        patchHash: patch.patchHash,
        summary: patch.summary,
        plan: patch.plan,
        evidence: patch.evidence,
        contextFiles: patch.contextFiles,
        changedFiles: patch.changedFiles,
        unifiedDiff: patch.unifiedDiff,
        testStatus: patch.testStatus,
        testResults: patch.testResults,
        securityStatus: patch.securityStatus,
        securityResults: patch.securityResults,
        reviewStatus: patch.reviewStatus,
        reviewResults: patch.reviewResults,
        sandboxDiagnostics: patch.sandboxDiagnostics,
        workspaceCleanupStatus: patch.workspaceCleanupStatus,
        status: patch.status,
        publicationStatus: patch.publicationStatus,
        publicationError: patch.publicationError,
        publishedBranch: patch.publishedBranch,
        githubCommitSha: patch.githubCommitSha,
        pullRequestNumber: patch.pullRequestNumber,
        pullRequestUrl: patch.pullRequestUrl,
        publishedAt: patch.publishedAt?.toISOString() ?? null,
        ciStatus: patch.ciStatus,
        ciChecks: patch.ciChecks,
        ciDiagnosis: patch.ciDiagnosis,
        ciSyncedAt: patch.ciSyncedAt?.toISOString() ?? null,
        createdAt: patch.createdAt.toISOString(),
        updatedAt: patch.updatedAt.toISOString(),
      }));
    } catch (err) { next(err); }
  }
);

tasksRouter.post(
  '/workspaces/:workspaceId/tasks/:taskId/cancel',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, taskId } = req.params;
      const task = await prisma.task.findFirst({
        where: { id: taskId, workspaceId },
        include: { runs: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
      });

      if (!task) {
        return next(new AppError(404, 'NOT_FOUND', `Task with ID ${taskId} not found`));
      }

      if (!isTaskCancellable(task.status)) {
        throw new AppError(
          400,
          'BAD_REQUEST',
          `Cannot cancel task in '${task.status}' state. Only QUEUED, RUNNING, or NEEDS_ATTENTION tasks can be cancelled.`
        );
      }

      // If QUEUED, cancel immediately
      // NEEDS_ATTENTION jobs have no active worker to observe a cancellation
      // request, so finish cancellation synchronously and prevent stale review.
      const nextStatus = task.status === 'QUEUED' || task.status === 'NEEDS_ATTENTION' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      validateTaskTransition(task.status, nextStatus);

      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          status: nextStatus,
          completedAt: nextStatus === 'CANCELLED' ? new Date() : undefined,
        },
      });

      // Update active run if queued
      if (nextStatus === 'CANCELLED' && task.runs[0] && task.runs[0].status === 'QUEUED') {
        await prisma.workflowRun.update({
          where: { id: task.runs[0].id },
          data: { status: 'CANCELLED', finishedAt: new Date() },
        });
      }
      if (nextStatus === 'CANCELLED' && task.taskType === 'VERIFICATION') {
        await cancelVerificationRunForTask(task.id, 'Task cancelled by user before execution commenced.', req.user!.id);
      }

      res.status(200).json({
        success: true,
        taskId: updated.id,
        status: updated.status,
        message:
          nextStatus === 'CANCELLED'
            ? 'Task cancelled immediately.'
            : 'Cancellation requested. Active worker will terminate execution.',
      });
    } catch (err) {
      next(err);
    }
  }
);

tasksRouter.get(
  '/workspaces/:workspaceId/tasks/:taskId/runs',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, taskId } = req.params;
      const runs = await prisma.workflowRun.findMany({
        where: {
          taskId,
          task: { workspaceId },
        },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
        orderBy: { attemptNumber: 'desc' },
      });

      res.status(200).json({ runs, total: runs.length });
    } catch (err) {
      next(err);
    }
  }
);

tasksRouter.get(
  '/workspaces/:workspaceId/runs/:runId',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, runId } = req.params;
      const run = await prisma.workflowRun.findFirst({
        where: {
          id: runId,
          task: { workspaceId },
        },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });

      if (!run) {
        return next(new AppError(404, 'NOT_FOUND', `Workflow run with ID ${runId} not found`));
      }

      res.status(200).json(run);
    } catch (err) {
      next(err);
    }
  }
);
