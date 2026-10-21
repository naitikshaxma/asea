import { Router } from 'express';
import { TaskRelevantFilesRequestSchema } from '@autonomous-engineer/contracts';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import {
  createAndRunAnalysis,
  getLatestAnalysis,
  getAnalysisInventory,
  retrieveRelevantFilesForTask,
} from '../services/intelligence/repositoryAnalysisService.js';

export const intelligenceRouter = Router({ mergeParams: true });

intelligenceRouter.use('/workspaces', requireAuth);

/**
 * POST /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analyze
 * Starts repository analysis for the target repository.
 */
intelligenceRouter.post(
  '/workspaces/:workspaceId/repositories/:repositoryId/analyze',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const repo = await prisma.repository.findFirst({
        where: { id: repositoryId, workspaceId },
      });

      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found in workspace'));
      }

      const result = await createAndRunAnalysis(repositoryId!, workspaceId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analysis/latest
 * Retrieves the latest architecture analysis for a repository.
 */
intelligenceRouter.get(
  '/workspaces/:workspaceId/repositories/:repositoryId/analysis/latest',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const repo = await prisma.repository.findFirst({
        where: { id: repositoryId, workspaceId },
      });

      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found in workspace'));
      }

      const latest = await getLatestAnalysis(repositoryId!, workspaceId!);
      if (!latest) {
        return next(new AppError(404, 'NOT_FOUND', 'No analysis found for this repository'));
      }

      res.status(200).json(latest);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId
 * Retrieves specific analysis report by ID.
 */
intelligenceRouter.get(
  '/workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId, analysisId } = req.params;
      const record = await prisma.repositoryAnalysis.findFirst({
        where: { id: analysisId, repositoryId, workspaceId },
      });

      if (!record) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository analysis report not found'));
      }

      res.status(200).json({
        id: record.id,
        repositoryId: record.repositoryId,
        workspaceId: record.workspaceId,
        status: record.status,
        analyzerVersion: record.analyzerVersion,
        summary: record.summary,
        technologies: record.technologies || [],
        statistics: record.statistics,
        errorSummary: record.errorSummary,
        startedAt: record.startedAt?.toISOString() || null,
        completedAt: record.completedAt?.toISOString() || null,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId/files
 * Retrieves file inventory metadata for a completed analysis.
 */
intelligenceRouter.get(
  '/workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId/files',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId, analysisId } = req.params;
      const page = Math.max(parseInt(req.query['page'] as string) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(req.query['pageSize'] as string) || 50, 1), 200);
      const category = req.query['category'] as string | undefined;

      const result = await getAnalysisInventory(
        analysisId!,
        workspaceId!,
        page,
        pageSize,
        category
      );

      res.status(200).json({
        analysisId,
        repositoryId,
        files: result.files,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:workspaceId/repositories/:repositoryId/relevant-files
 * Task-focused file retrieval: scores and ranks repository files relevant to a task prompt.
 */
intelligenceRouter.post(
  '/workspaces/:workspaceId/repositories/:repositoryId/relevant-files',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const { workspaceId, repositoryId } = req.params;
      const validated = TaskRelevantFilesRequestSchema.parse(req.body);

      const repo = await prisma.repository.findFirst({
        where: { id: repositoryId, workspaceId },
      });

      if (!repo) {
        return next(new AppError(404, 'NOT_FOUND', 'Repository record not found in workspace'));
      }

      const results = await retrieveRelevantFilesForTask(
        repositoryId!,
        workspaceId!,
        validated.taskDescription,
        validated.limit
      );

      res.status(200).json(results);
    } catch (err) {
      next(err);
    }
  }
);
