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

export const WorkspaceMemberSchema = z.object({
  id: RequestIdSchema,
  userId: RequestIdSchema,
  email: z.string().email(),
  displayName: z.string(),
  role: UserRoleEnum,
  createdAt: IsoTimestampSchema,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

export const CreateWorkspaceInvitationRequestSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});
export type CreateWorkspaceInvitationRequest = z.infer<typeof CreateWorkspaceInvitationRequestSchema>;

export const WorkspaceInvitationResponseSchema = z.object({
  id: RequestIdSchema,
  workspaceId: RequestIdSchema,
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER']),
  expiresAt: IsoTimestampSchema,
  acceptedAt: IsoTimestampSchema.nullable(),
  revokedAt: IsoTimestampSchema.nullable(),
  createdAt: IsoTimestampSchema,
});
export type WorkspaceInvitationResponse = z.infer<typeof WorkspaceInvitationResponseSchema>;

export const UpdateWorkspaceMemberRoleRequestSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });
export type UpdateWorkspaceMemberRoleRequest = z.infer<typeof UpdateWorkspaceMemberRoleRequestSchema>;
