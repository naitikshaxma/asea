import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const TaskTypeEnum = z.enum([
  'BUG_INVESTIGATION',
  'CODE_PATCH',
  'TEST_GENERATION',
  'CODE_REVIEW',
  'CI_DIAGNOSIS',
]);

export type TaskType = z.infer<typeof TaskTypeEnum>;

export const TaskPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type TaskPriority = z.infer<typeof TaskPriorityEnum>;

export const TaskStatusEnum = z.enum([
  'PENDING',
  'QUEUED',
  'ANALYZING',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export type TaskStatus = z.infer<typeof TaskStatusEnum>;

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
  targetBranch: z.string().max(100).optional().default('main'),
});

export type TaskSubmissionRequest = z.infer<typeof TaskSubmissionRequestSchema>;

export const TaskResponseSchema = z.object({
  id: RequestIdSchema,
  title: z.string(),
  description: z.string(),
  taskType: TaskTypeEnum,
  priority: TaskPriorityEnum,
  status: TaskStatusEnum,
  repositoryUrl: z.string().optional(),
  targetBranch: z.string().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  executionMetadata: z
    .object({
      workerId: z.string().optional(),
      sandboxType: z.string().optional(),
      phase: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});

export type TaskResponse = z.infer<typeof TaskResponseSchema>;

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskResponseSchema),
  total: z.number().int().nonnegative(),
});

export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
