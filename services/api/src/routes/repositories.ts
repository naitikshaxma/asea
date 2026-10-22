import { Router } from 'express';
import { CreateRepositoryRequestSchema, type RepositoryRefsResponse } from '@autonomous-engineer/contracts';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import { resolveRepositoryFsPath } from '../services/intelligence/repositoryAnalysisService.js';
import { listBranches, VerificationInputError } from '../services/verification/gitDiff.js';

export const repositoriesRouter = Router({ mergeParams: true });

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

      const formatted = repositories.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        provider: r.provider,
        repositoryUrl: r.repositoryUrl,
        defaultBranch: r.defaultBranch,
        connectionStatus: r.connectionStatus,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

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

      res.status(201).json({
        id: repo.id,
        workspaceId: repo.workspaceId,
        name: repo.name,
        provider: repo.provider,
        repositoryUrl: repo.repositoryUrl,
        defaultBranch: repo.defaultBranch,
        connectionStatus: repo.connectionStatus,
        createdAt: repo.createdAt.toISOString(),
        updatedAt: repo.updatedAt.toISOString(),
      });
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

      res.status(200).json({
        id: repo.id,
        workspaceId: repo.workspaceId,
        name: repo.name,
        provider: repo.provider,
        repositoryUrl: repo.repositoryUrl,
        defaultBranch: repo.defaultBranch,
        connectionStatus: repo.connectionStatus,
        createdAt: repo.createdAt.toISOString(),
        updatedAt: repo.updatedAt.toISOString(),
      });
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
