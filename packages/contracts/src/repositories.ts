import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const RepositoryProviderEnum = z.enum(['LOCAL', 'GITHUB']);
export type RepositoryProvider = z.infer<typeof RepositoryProviderEnum>;

export const RepoConnectionStatusEnum = z.enum(['CONNECTED', 'DISCONNECTED', 'PENDING']);
export type RepoConnectionStatus = z.infer<typeof RepoConnectionStatusEnum>;

export const CreateRepositoryRequestSchema = z.object({
  name: z
    .string()
    .min(2, 'Repository name must be at least 2 characters')
    .max(100, 'Repository name too long')
    .trim(),
  provider: RepositoryProviderEnum.default('LOCAL'),
  repositoryUrl: z
    .string()
    .min(1, 'Repository URL or path is required')
    .max(500)
    .trim(),
  defaultBranch: z.string().max(100).default('main'),
});

export type CreateRepositoryRequest = z.infer<typeof CreateRepositoryRequestSchema>;

export const RepositoryResponseSchema = z.object({
  id: RequestIdSchema,
  workspaceId: RequestIdSchema,
  name: z.string(),
  provider: RepositoryProviderEnum,
  repositoryUrl: z.string(),
  defaultBranch: z.string(),
  connectionStatus: RepoConnectionStatusEnum,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export type RepositoryResponse = z.infer<typeof RepositoryResponseSchema>;

export const RepositoryListResponseSchema = z.object({
  repositories: z.array(RepositoryResponseSchema),
  total: z.number().int().nonnegative(),
});

export type RepositoryListResponse = z.infer<typeof RepositoryListResponseSchema>;
