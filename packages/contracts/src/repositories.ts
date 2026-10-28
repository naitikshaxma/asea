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
  // GitHub repository whose pull requests are verified against this checkout
  githubFullName: z.string().nullable(),
  // A webhook secret exists (the secret itself is only returned when generated)
  githubWebhookConfigured: z.boolean(),
  githubAppConnected: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export type RepositoryResponse = z.infer<typeof RepositoryResponseSchema>;

// PUT .../repositories/:id/github: link the checkout to a GitHub repository and
// (re)generate the webhook secret, which is returned only in this response
export const ConnectGithubRequestSchema = z.object({
  fullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Use the "owner/name" form of the GitHub repository'),
});
export type ConnectGithubRequest = z.infer<typeof ConnectGithubRequestSchema>;

export const ConnectGithubResponseSchema = z.object({
  repositoryId: z.string(),
  githubFullName: z.string(),
  webhookUrl: z.string(),
  webhookSecret: z.string(),
  contentType: z.literal('application/json'),
  events: z.array(z.string()),
});
export type ConnectGithubResponse = z.infer<typeof ConnectGithubResponseSchema>;

export const RepositoryListResponseSchema = z.object({
  repositories: z.array(RepositoryResponseSchema),
  total: z.number().int().nonnegative(),
});

export type RepositoryListResponse = z.infer<typeof RepositoryListResponseSchema>;

// GET .../repositories/:id/refs: local branches to pick a change (base..head) from
export const RepositoryRefsResponseSchema = z.object({
  repositoryId: z.string(),
  defaultBranch: z.string(),
  branches: z.array(
    z.object({
      name: z.string(),
      sha: z.string(),
      subject: z.string(),
      committedAt: IsoTimestampSchema,
    })
  ),
});

export type RepositoryRefsResponse = z.infer<typeof RepositoryRefsResponseSchema>;
