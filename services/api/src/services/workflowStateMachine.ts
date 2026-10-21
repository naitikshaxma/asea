import type { TaskStatus, WorkflowRunStatus } from '@prisma/client';
import { AppError } from '../middlewares/errorHandler.js';

// Explicit allowed task status transitions
const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ['RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCEL_REQUESTED', 'NEEDS_ATTENTION'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED'],
  NEEDS_ATTENTION: ['RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED'],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
};

// Explicit allowed workflow run transitions
const ALLOWED_RUN_TRANSITIONS: Record<WorkflowRunStatus, WorkflowRunStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
};

export function validateTaskTransition(current: TaskStatus, next: TaskStatus): void {
  if (current === next) return;

  const allowed = ALLOWED_TASK_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      `Illegal task state transition from '${current}' to '${next}'. Allowed transitions: [${allowed.join(', ')}]`
    );
  }
}

export function validateRunTransition(current: WorkflowRunStatus, next: WorkflowRunStatus): void {
  if (current === next) return;

  const allowed = ALLOWED_RUN_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      `Illegal workflow run state transition from '${current}' to '${next}'. Allowed transitions: [${allowed.join(', ')}]`
    );
  }
}

export function isTaskCancellable(status: TaskStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'NEEDS_ATTENTION';
}
