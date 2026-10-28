import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../services/prisma.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { AppError } from '../middlewares/errorHandler.js';

export const approvalsRouter = Router({ mergeParams: true });

const createSchema = z.object({ patchHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'REJECTED' && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required to reject a patch' });
  }
});

const VERIFICATION_REQUIRED = 'Approval requires passing sandbox tests, security scans, and independent review';

/** The same gate publication enforces: every automated stage must have passed. */
function verificationPassed(patch: { testStatus: string; securityStatus: string; reviewStatus: string }): boolean {
  return patch.testStatus === 'PASSED' && patch.securityStatus === 'PASSED' && patch.reviewStatus === 'PASSED';
}

function currentPatchHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['patchHash'];
  return typeof value === 'string' ? value : null;
}

function isCurrentReviewableTask(task: { status: string; executionMetadata: unknown }, patchHash: string | null): boolean {
  return task.status === 'NEEDS_ATTENTION' && !!patchHash && patchHash === currentPatchHash(task.executionMetadata);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

approvalsRouter.use('/workspaces', requireAuth);

approvalsRouter.get(
  '/workspaces/:workspaceId/approvals',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const status = req.query['status'];
      if (status && !['PENDING', 'APPROVED', 'REJECTED'].includes(String(status))) {
        throw new AppError(400, 'BAD_REQUEST', 'Unsupported approval status filter');
      }
      const approvals = await prisma.approval.findMany({
        where: { task: { workspaceId }, ...(status ? { status: String(status) as any } : {}) },
        include: { task: true, requester: { select: { id: true, email: true, displayName: true } }, decider: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.status(200).json({
        approvals: approvals.map((approval) => ({ ...approval, patchIsCurrent: isCurrentReviewableTask(approval.task, approval.patchHash) })),
        total: approvals.length,
      });
    } catch (err) { next(err); }
  }
);

approvalsRouter.post(
  '/workspaces/:workspaceId/tasks/:taskId/approvals',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const taskId = req.params['taskId']!;
      const { patchHash } = createSchema.parse(req.body);
      const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId } });
      if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found');
      if (task.taskType !== 'CODE_PATCH') throw new AppError(409, 'CONFLICT', 'Approvals can only be requested for code patch tasks');
      if (task.status !== 'NEEDS_ATTENTION') throw new AppError(409, 'CONFLICT', 'Task has no reviewable patch');
      if (currentPatchHash(task.executionMetadata) !== patchHash) throw new AppError(409, 'CONFLICT', 'Patch hash does not match the current proposal');
      const patch = await prisma.taskPatch.findFirst({ where: { taskId, patchHash, status: 'PROPOSED' } });
      if (!patch) throw new AppError(409, 'CONFLICT', 'The patch artifact is missing or no longer reviewable');
      if (!verificationPassed(patch)) throw new AppError(409, 'CONFLICT', VERIFICATION_REQUIRED);

      const existing = await prisma.approval.findFirst({ where: { taskId, patchHash } });
      if (existing) {
        if (existing.status !== 'PENDING') throw new AppError(409, 'CONFLICT', 'This patch already has a decision');
        return res.status(200).json(existing);
      }
      try {
        const approval = await prisma.$transaction(async (tx) => {
          const created = await tx.approval.create({
            data: { taskId, patchHash, requestedById: req.user!.id, status: 'PENDING' },
          });
          await tx.auditEvent.create({
            data: {
              workspaceId, actorId: req.user!.id, eventType: 'PATCH_APPROVAL_REQUESTED',
              resourceType: 'Approval', resourceId: created.id,
              metadata: { taskId, patchHash },
            },
          });
          return created;
        });
        return res.status(201).json(approval);
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'CONFLICT', 'An approval already exists for this patch');
        throw err;
      }
    } catch (err) { next(err); }
  }
);

approvalsRouter.get(
  '/workspaces/:workspaceId/approvals/:approvalId',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const approval = await prisma.approval.findFirst({
        where: { id: req.params['approvalId'], task: { workspaceId: req.params['workspaceId'] } },
        include: {
          task: { include: { runs: { include: { steps: { orderBy: { stepOrder: 'asc' } } } } } },
          requester: { select: { id: true, email: true, displayName: true } },
          decider: { select: { id: true, email: true, displayName: true } },
        },
      });
      if (!approval) throw new AppError(404, 'NOT_FOUND', 'Approval not found');
      const auditHistory = await prisma.auditEvent.findMany({
        where: { workspaceId: req.params['workspaceId'], resourceType: 'Approval', resourceId: approval.id },
        orderBy: { timestamp: 'asc' },
        select: { id: true, actorId: true, eventType: true, metadata: true, requestId: true, timestamp: true },
      });
      res.status(200).json({ ...approval, patchIsCurrent: isCurrentReviewableTask(approval.task, approval.patchHash), auditHistory });
    } catch (err) { next(err); }
  }
);

approvalsRouter.post(
  '/workspaces/:workspaceId/approvals/:approvalId/decision',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const decision = decisionSchema.parse(req.body);
      const workspaceId = req.params['workspaceId']!;
      const approvalId = req.params['approvalId']!;
      const result = await prisma.$transaction(async (tx) => {
        const membership = await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: req.user!.id } },
          select: { role: true },
        });
        if (!membership || (membership.role !== 'ADMIN' && membership.role !== 'OWNER')) {
          throw new AppError(403, 'FORBIDDEN', 'Approving a patch requires workspace admin or owner access');
        }
        const approval = await tx.approval.findFirst({
          where: { id: approvalId, task: { workspaceId } },
          include: { task: true },
        });
        if (!approval) throw new AppError(404, 'NOT_FOUND', 'Approval not found');
        if (approval.status !== 'PENDING') throw new AppError(409, 'CONFLICT', 'Approval already has a decision');
        if (approval.task.status !== 'NEEDS_ATTENTION') throw new AppError(409, 'CONFLICT', 'The task is no longer awaiting patch review');
        if (!approval.patchHash || currentPatchHash(approval.task.executionMetadata) !== approval.patchHash) {
          throw new AppError(409, 'CONFLICT', 'The proposed patch changed; request a new approval for the current patch');
        }
        const patch = await tx.taskPatch.findFirst({
          where: { taskId: approval.taskId, patchHash: approval.patchHash, status: 'PROPOSED' },
        });
        if (!patch) throw new AppError(409, 'CONFLICT', 'The proposed patch is no longer reviewable');
        if (approval.requestedById === req.user!.id) throw new AppError(403, 'FORBIDDEN', 'A reviewer cannot approve their own patch request');
        // A blocked patch can still be rejected, never approved
        if (decision.decision === 'APPROVED' && !verificationPassed(patch)) throw new AppError(409, 'CONFLICT', VERIFICATION_REQUIRED);

        const changed = await tx.approval.updateMany({
          where: { id: approvalId, status: 'PENDING', patchHash: approval.patchHash },
          data: { status: decision.decision, decidedById: req.user!.id, reason: decision.reason ?? null },
        });
        if (changed.count !== 1) throw new AppError(409, 'CONFLICT', 'Approval already has a decision');
        const patchChanged = await tx.taskPatch.updateMany({
          where: { id: patch.id, status: 'PROPOSED' },
          data: { status: decision.decision },
        });
        if (patchChanged.count !== 1) throw new AppError(409, 'CONFLICT', 'The proposed patch already has a decision');
        await tx.auditEvent.create({
          data: {
            workspaceId, actorId: req.user!.id, eventType: decision.decision === 'APPROVED' ? 'PATCH_APPROVED' : 'PATCH_REJECTED',
            resourceType: 'Approval', resourceId: approvalId,
            metadata: { taskId: approval.taskId, patchHash: approval.patchHash, decision: decision.decision, reason: decision.reason ?? null },
          },
        });
        return tx.approval.findUnique({
          where: { id: approvalId },
          include: { task: true, requester: { select: { id: true, email: true, displayName: true } }, decider: { select: { id: true, email: true, displayName: true } } },
        });
      });
      res.status(200).json(result);
    } catch (err) { next(err); }
  }
);
