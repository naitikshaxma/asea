import { Router } from 'express';
import type { Repository } from '@prisma/client';
import {
  ConnectGithubRequestSchema,
  CreateRepositoryRequestSchema,
  type ConnectGithubResponse,
  type RepositoryRefsResponse,
  type RepositoryResponse,
} from '@autonomous-engineer/contracts';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import { resolveRepositoryFsPath } from '../services/intelligence/repositoryAnalysisService.js';
import { listBranches, VerificationInputError } from '../services/verification/gitDiff.js';
import { generateWebhookSecret } from '../services/github/webhookSignature.js';
import { config } from '../config.js';

export const repositoriesRouter = Router({ mergeParams: true });

// The webhook secret is never returned here, only when it is generated
function formatRepository(r: Repository): RepositoryResponse {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    provider: r.provider,
    repositoryUrl: r.repositoryUrl,
    defaultBranch: r.defaultBranch,
    connectionStatus: r.connectionStatus,
    githubFullName: r.githubFullName,
    githubWebhookConfigured: r.githubWebhookSecret !== null,
    githubAppConnected: r.githubAppInstallationId !== null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

repositoriesRouter.use('/workspaces', requireAuth);

repositoriesRouter.get(
  '/workspaces/:workspaceId/repositories',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const repositories = await prisma.repository.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      });

      const formatted = repositories.map(formatRepository);

      res.status(200).json({ repositories: formatted, total: formatted.length });
    } catch (err) {
      next(err);
    }
  }
);

repositoriesRouter.post(
  '/workspaces/:workspaceId/repositories',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const validated = CreateRepositoryRequestSchema.parse(req.body);

      const repo = await prisma.repository.create({
        data: {
          workspaceId,
          name: validated.name,
          provider: validated.provider,
          repositoryUrl: validated.repositoryUrl,
          defaultBranch: validated.defaultBranch,
          connectionStatus: 'CONNECTED',
        },
      });

      res.status(201).json(formatRepository(repo));
    } catch (err) {
      next(err);
    }
  }
);

repositoriesRouter.get(
  '/workspaces/:workspaceId/repositories/:repositoryId',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const repo = await prisma.repository.findFirst({
        where: {
          id: repositoryId,
          workspaceId,
        },
      });

      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found'));
      }

      res.status(200).json(formatRepository(repo));
    } catch (err) {
      next(err);
    }
  }
);

repositoriesRouter.get(
  '/workspaces/:workspaceId/repositories/:repositoryId/refs',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const repo = await prisma.repository.findFirst({ where: { id: repositoryId, workspaceId } });
      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found'));
      }
      const repoPath = resolveRepositoryFsPath(repo.repositoryUrl);
      let branches;
      try {
        branches = await listBranches(repoPath);
      } catch (err) {
        if (err instanceof VerificationInputError) {
          throw new AppError(400, 'BAD_REQUEST', `Repository is not a readable git repository: ${err.message}`);
        }
        throw err;
      }
      const body: RepositoryRefsResponse = { repositoryId: repo.id, defaultBranch: repo.defaultBranch, branches };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Links the checkout to a GitHub repository and generates a new webhook
 * secret (replacing any previous one). The secret is returned only here: set
 * it on the GitHub webhook together with the URL.
 */
repositoriesRouter.put(
  '/workspaces/:workspaceId/repositories/:repositoryId/github',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const { fullName } = ConnectGithubRequestSchema.parse(req.body);
      const repo = await prisma.repository.findFirst({ where: { id: repositoryId, workspaceId } });
      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found'));
      }
      const secret = generateWebhookSecret();
      const updated = await prisma.repository.update({
        where: { id: repo.id },
        data: { githubFullName: fullName.toLowerCase(), githubWebhookSecret: secret },
      });
      const body: ConnectGithubResponse = {
        repositoryId: updated.id,
        githubFullName: updated.githubFullName!,
        webhookUrl: `${config.PUBLIC_WEB_URL.replace(/\/$/, '')}/api/v1/webhooks/github`,
        webhookSecret: secret,
        contentType: 'application/json',
        events: ['pull_request'],
      };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

repositoriesRouter.delete(
  '/workspaces/:workspaceId/repositories/:repositoryId/github',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const repo = await prisma.repository.findFirst({ where: { id: repositoryId, workspaceId } });
      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found'));
      }
      const updated = await prisma.repository.update({
        where: { id: repo.id },
        data: { githubFullName: repo.githubAppInstallationId ? repo.githubFullName : null, githubWebhookSecret: null },
      });
      res.status(200).json(formatRepository(updated));
    } catch (err) {
      next(err);
    }
  }
);
