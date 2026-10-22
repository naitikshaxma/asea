import type { Prisma, Task, WorkflowRun } from '@prisma/client';
import type { GithubRunInfo, TaskSubmissionRequest } from '@autonomous-engineer/contracts';
import { prisma } from './prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import { isUniqueViolation, resolvePolicyForVerification } from './policy/policyService.js';

export type SubmittedTask = Task & { runs: WorkflowRun[] };

/**
 * Creates a task with its first WorkflowRun and the outbox event that queues
 * it, in one transaction; a VERIFICATION task also gets its VerificationRun
 * (inputs and policy snapshot). An idempotency key already used in the
 * workspace returns that task instead (`created: false`), also when two
 * requests race on it (the key is unique per workspace).
 */
export async function submitTask(
  workspaceId: string,
  creatorId: string,
  input: TaskSubmissionRequest,
  options: { github?: Omit<GithubRunInfo, 'comment'> } = {}
): Promise<{ task: SubmittedTask; created: boolean }> {
  const existing = async () =>
    input.idempotencyKey
      ? prisma.task.findFirst({ where: { workspaceId, idempotencyKey: input.idempotencyKey }, include: { runs: true } })
      : null;
  const found = await existing();
  if (found) return { task: found, created: false };

  // If repositoryId is provided, verify it belongs to this workspace
  if (input.repositoryId) {
    const repo = await prisma.repository.findFirst({ where: { id: input.repositoryId, workspaceId } });
    if (!repo) {
      throw new AppError(400, 'BAD_REQUEST', 'Specified repository does not belong to this workspace');
    }
  }
  const verification = input.taskType === 'VERIFICATION' ? input.verification : undefined;
  // Resolved before the transaction: creating the default profile may race with another request
  const policy = verification ? await resolvePolicyForVerification(prisma, workspaceId, verification.policyProfileId) : undefined;

  try {
    const task = await prisma.$transaction(async (tx) => {
      const t = await tx.task.create({
        data: {
          workspaceId,
          creatorId,
          repositoryId: input.repositoryId,
          title: input.title,
          description: input.description,
          taskType: input.taskType,
          priority: input.priority,
          status: 'QUEUED',
          repositoryUrl: input.repositoryUrl,
          targetBranch: input.targetBranch,
          idempotencyKey: input.idempotencyKey,
          executionMetadata: {
            phase: 'PHASE_2_ENQUEUED',
            note: 'Persisted in PostgreSQL. Enqueued for BullMQ execution.',
          },
        },
      });

      const run = await tx.workflowRun.create({
        data: { taskId: t.id, attemptNumber: 1, status: 'QUEUED' },
      });

      // A VERIFICATION task's inputs live on its VerificationRun; the
      // description is the requirement the change is verified against, and
      // the policy is snapshotted so later profile edits don't change the run
      if (verification && policy) {
        await tx.verificationRun.create({
          data: {
            workspaceId,
            repositoryId: input.repositoryId!,
            taskId: t.id,
            baseSha: verification.baseSha,
            headSha: verification.headSha,
            requirement: input.description,
            authorType: verification.authorType,
            policyProfileId: policy.profileId,
            policyHash: policy.hash,
            policySnapshot: policy.config,
            ...(options.github ? { github: { ...options.github, comment: null } as Prisma.InputJsonObject } : {}),
            status: 'QUEUED',
          },
        });
      }

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'Task',
          aggregateId: t.id,
          eventType: 'TASK_ENQUEUED',
          payload: { taskId: t.id, workspaceId, attemptNumber: 1, runId: run.id },
          status: 'PENDING',
        },
      });

      return { ...t, runs: [run] };
    });
    return { task, created: true };
  } catch (err) {
    // Another request created the task with this idempotency key first
    const raced = isUniqueViolation(err) ? await existing() : null;
    if (raced) return { task: raced, created: false };
    throw err;
  }
}
