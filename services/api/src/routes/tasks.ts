import { Router } from 'express';
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
import { resolvePolicyForVerification } from '../services/policy/policyService.js';

export const tasksRouter = Router({ mergeParams: true });

function formatTaskResponse(task: any): TaskResponse {
  return {
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
  };
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
      const userId = req.user!.id;
      const validated = TaskSubmissionRequestSchema.parse(req.body);

      // Check Idempotency Key
      if (validated.idempotencyKey) {
        const existing = await prisma.task.findFirst({
          where: {
            workspaceId,
            idempotencyKey: validated.idempotencyKey,
          },
          include: { runs: true },
        });

        if (existing) {
          return res.status(200).json(formatTaskResponse(existing));
        }
      }

      // If repositoryId is provided, verify it belongs to this workspace
      if (validated.repositoryId) {
        const repo = await prisma.repository.findFirst({
          where: { id: validated.repositoryId, workspaceId },
        });
        if (!repo) {
          throw new AppError(400, 'BAD_REQUEST', 'Specified repository does not belong to this workspace');
        }
      }
      const verification = validated.taskType === 'VERIFICATION' ? validated.verification : undefined;
      // Resolved before the transaction: creating the default profile may race with another request
      const policy = verification
        ? await resolvePolicyForVerification(prisma, workspaceId, verification.policyProfileId)
        : undefined;

      // Atomic Transaction: Task + Initial Workflow Run + Outbox Event
      const task = await prisma.$transaction(async (tx) => {
        const t = await tx.task.create({
          data: {
            workspaceId,
            creatorId: userId,
            repositoryId: validated.repositoryId,
            title: validated.title,
            description: validated.description,
            taskType: validated.taskType,
            priority: validated.priority,
            status: 'QUEUED',
            repositoryUrl: validated.repositoryUrl,
            targetBranch: validated.targetBranch,
            idempotencyKey: validated.idempotencyKey,
            executionMetadata: {
              phase: 'PHASE_2_ENQUEUED',
              note: 'Persisted in PostgreSQL. Enqueued for BullMQ execution.',
            },
          },
        });

        const run = await tx.workflowRun.create({
          data: {
            taskId: t.id,
            attemptNumber: 1,
            status: 'QUEUED',
          },
        });

        // A VERIFICATION task's inputs live on its VerificationRun; the
        // description is the requirement the change is verified against, and
        // the policy is snapshotted so later profile edits don't change the run
        if (verification && policy) {
          await tx.verificationRun.create({
            data: {
              workspaceId,
              repositoryId: validated.repositoryId!,
              taskId: t.id,
              baseSha: verification.baseSha,
              headSha: verification.headSha,
              requirement: validated.description,
              authorType: verification.authorType,
              policyProfileId: policy.profileId,
              policyHash: policy.hash,
              policySnapshot: policy.config,
              status: 'QUEUED',
            },
          });
        }

        await tx.outboxEvent.create({
          data: {
            aggregateType: 'Task',
            aggregateId: t.id,
            eventType: 'TASK_ENQUEUED',
            payload: {
              taskId: t.id,
              workspaceId,
              attemptNumber: 1,
              runId: run.id,
            },
            status: 'PENDING',
          },
        });

        return { ...t, runs: [run] };
      });

      // Dispatch outbox asynchronously
      dispatchPendingOutboxEvents().catch(() => {});

      res.status(201).json(formatTaskResponse(task));
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
      const statusFilter = req.query['status'] as any;
      const typeFilter = req.query['taskType'] as any;

      const tasks = await prisma.task.findMany({
        where: {
          workspaceId,
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(typeFilter ? { taskType: typeFilter } : {}),
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
      const nextStatus = task.status === 'QUEUED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
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
