import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';
import { UserRoleEnum } from './auth.js';

export const WorkspaceResponseSchema = z.object({
  id: RequestIdSchema,
  name: z.string().min(1),
  ownerId: RequestIdSchema,
  role: UserRoleEnum.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z
    .string()
    .min(2, 'Workspace name must be at least 2 characters')
    .max(100, 'Workspace name too long')
    .trim(),
});

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z
    .string()
    .min(2, 'Workspace name must be at least 2 characters')
    .max(100, 'Workspace name too long')
    .trim()
    .optional(),
});

export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const WorkspaceListResponseSchema = z.object({
  workspaces: z.array(WorkspaceResponseSchema),
  total: z.number().int().nonnegative(),
});

export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;
