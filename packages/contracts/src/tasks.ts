import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const TaskTypeEnum = z.enum([
  'BUG_INVESTIGATION',
  'CODE_PATCH',
  'TEST_GENERATION',
  'CODE_REVIEW',
  'CI_DIAGNOSIS',
  'VERIFICATION',
]);

export type TaskType = z.infer<typeof TaskTypeEnum>;

export const TaskPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type TaskPriority = z.infer<typeof TaskPriorityEnum>;

export const TaskStatusEnum = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'ANALYZING',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'NEEDS_ATTENTION',
]);

export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const WorkflowRunStatusEnum = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusEnum>;

export const WorkflowStepStatusEnum = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
]);

export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusEnum>;

export const WorkflowStepTypeEnum = z.enum([
  'VALIDATE_CONTEXT',
  'INSPECT_REPOSITORY',
  'GENERATE_SPEC',
  'VERIFY_BOUNDARIES',
  'SIMULATE_EXECUTION',
]);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeEnum>;

export const WorkflowStepResponseSchema = z.object({
  id: RequestIdSchema,
  workflowRunId: RequestIdSchema,
  stepType: WorkflowStepTypeEnum,
  stepStatus: WorkflowStepStatusEnum,
  stepOrder: z.number().int().nonnegative(),
  startedAt: IsoTimestampSchema.optional(),
  finishedAt: IsoTimestampSchema.optional(),
  resultMetadata: z.record(z.string(), z.unknown()).optional(),
  failureSummary: z.string().optional(),
});

export type WorkflowStepResponse = z.infer<typeof WorkflowStepResponseSchema>;

export const WorkflowRunResponseSchema = z.object({
  id: RequestIdSchema,
  taskId: RequestIdSchema,
  attemptNumber: z.number().int().positive(),
  status: WorkflowRunStatusEnum,
  workerId: z.string().optional(),
  startedAt: IsoTimestampSchema.optional(),
  finishedAt: IsoTimestampSchema.optional(),
  errorSummary: z.string().optional(),
  configMetadata: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(WorkflowStepResponseSchema).optional(),
});

export type WorkflowRunResponse = z.infer<typeof WorkflowRunResponseSchema>;

// Inputs of a VERIFICATION task: the change baseSha..headSha in the task's
// repository is verified against the task description (the requirement).
export const VerificationTaskInputSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{7,40}$/i, 'Must be a 7-40 character hex commit SHA'),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/i, 'Must be a 7-40 character hex commit SHA'),
  authorType: z.enum(['AI', 'HUMAN', 'UNKNOWN']).default('UNKNOWN'),
  // Policy profile to score with; the workspace's default profile when omitted
  policyProfileId: z.string().min(1).optional(),
});

export type VerificationTaskInput = z.infer<typeof VerificationTaskInputSchema>;

export const TaskSubmissionRequestSchema = z.object({
  title: z
    .string()
    .min(3, 'Title must be at least 3 characters')
    .max(200, 'Title cannot exceed 200 characters'),
  description: z
    .string()
    .min(10, 'Description must be at least 10 characters')
    .max(5000, 'Description cannot exceed 5000 characters'),
  taskType: TaskTypeEnum.default('BUG_INVESTIGATION'),
  priority: TaskPriorityEnum.default('NORMAL'),
  repositoryUrl: z
    .string()
    .url('Must be a valid URL')
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  repositoryId: z.string().optional(),
  workspaceId: z.string().optional(),
  targetBranch: z.string().max(100).optional().default('main'),
  idempotencyKey: z.string().max(128).optional(),
  verification: VerificationTaskInputSchema.optional(),
}).superRefine((task, ctx) => {
  if (task.taskType === 'VERIFICATION') {
    if (!task.repositoryId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repositoryId'], message: 'Required for VERIFICATION tasks' });
    }
    if (!task.verification) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: 'Required for VERIFICATION tasks' });
    }
  } else if (task.verification) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: 'Only allowed for VERIFICATION tasks' });
  }
});

export type TaskSubmissionRequest = z.infer<typeof TaskSubmissionRequestSchema>;

export const TaskResponseSchema = z.object({
  id: RequestIdSchema,
  workspaceId: z.string().optional(),
  repositoryId: z.string().optional(),
  creatorId: z.string().optional(),
  title: z.string(),
  description: z.string(),
  taskType: TaskTypeEnum,
  priority: TaskPriorityEnum,
  status: TaskStatusEnum,
  repositoryUrl: z.string().optional(),
  targetBranch: z.string().optional(),
  idempotencyKey: z.string().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.optional(),
  completedAt: IsoTimestampSchema.optional(),
  failureCode: z.string().optional(),
  failureReason: z.string().optional(),
  executionMetadata: z
    .object({
      workerId: z.string().optional(),
      sandboxType: z.string().optional(),
      phase: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  runs: z.array(WorkflowRunResponseSchema).optional(),
});

export type TaskResponse = z.infer<typeof TaskResponseSchema>;

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskResponseSchema),
  total: z.number().int().nonnegative(),
});

export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const CancelTaskResponseSchema = z.object({
  success: z.boolean(),
  taskId: RequestIdSchema,
  status: TaskStatusEnum,
  message: z.string(),
});

export type CancelTaskResponse = z.infer<typeof CancelTaskResponseSchema>;
