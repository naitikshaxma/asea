import fs from 'node:fs';
import path from 'node:path';
import type {
  RepositoryAnalysisResponse,
  TaskRelevantFilesResponse,
  FileInventoryItem,
} from '@autonomous-engineer/contracts';
import { prisma } from '../prisma.js';
import { logger } from '../../logger.js';
import { config } from '../../config.js';
import { collectRepositorySnapshot } from './snapshotCollector.js';
import { detectTechnologies } from './technologyDetector.js';
import { buildArchitectureSummary } from './architectureSummarizer.js';
import { rankRelevantFiles } from './relevanceRanker.js';

export function resolveRepositoryFsPath(repositoryUrl: string): string {
  // If repositoryUrl is a local absolute or relative filesystem path
  if (
    repositoryUrl.startsWith('/') ||
    repositoryUrl.startsWith('./') ||
    repositoryUrl.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(repositoryUrl)
  ) {
    if (fs.existsSync(repositoryUrl)) {
      return path.resolve(repositoryUrl);
    }
  }

  // Fallback: If local workspace is requested or default checkout
  return process.cwd();
}

export async function createAndRunAnalysis(
  repositoryId: string,
  workspaceId: string
): Promise<RepositoryAnalysisResponse> {
  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, workspaceId },
  });

  if (!repo) {
    throw new Error(`Repository record ${repositoryId} not found in workspace ${workspaceId}`);
  }

  // Create initial PENDING analysis record
  const initialRecord = await prisma.repositoryAnalysis.create({
    data: {
      repositoryId,
      workspaceId,
      status: 'PENDING',
      analyzerVersion: '1.0.0',
    },
  });

  const analysisId = initialRecord.id;
  const startedAt = new Date();

  try {
    await prisma.repositoryAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'RUNNING',
        startedAt,
      },
    });

    // 1. Resolve Path
    const targetFsPath = resolveRepositoryFsPath(repo.repositoryUrl);

    // 2. Collect Snapshot
    const snapshot = await collectRepositorySnapshot(targetFsPath, {
      maxFiles: config.ANALYSIS_MAX_FILES,
      maxFileSizeBytes: config.ANALYSIS_MAX_FILE_SIZE_BYTES,
      maxTotalBytes: config.ANALYSIS_MAX_TOTAL_BYTES,
      timeoutMs: config.ANALYSIS_TIMEOUT_MS,
    });

    // 3. Detect Technologies
    const technologies = detectTechnologies(snapshot.repositoryRoot, snapshot.files);

    // 4. Build Architecture Summary & Relationships
    const architecture = buildArchitectureSummary(snapshot.repositoryRoot, snapshot.files);

    // Append any collector limitations to architecture summary
    if (snapshot.limitations.length > 0) {
      architecture.limitations.push(...snapshot.limitations);
    }

    const completedAt = new Date();

    // 5. Persist Analysis Record
    const updated = await prisma.repositoryAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'COMPLETED',
        summary: architecture as any,
        technologies: technologies as any,
        inventory: snapshot.files as any,
        statistics: snapshot.statistics as any,
        completedAt,
      },
    });

    logger.info(
      `[Intelligence] Completed analysis ${analysisId} for repository ${repo.name} (${snapshot.statistics.eligibleFiles} files, ${technologies.length} technologies)`
    );

    return {
      id: updated.id,
      repositoryId: updated.repositoryId,
      workspaceId: updated.workspaceId,
      status: updated.status as any,
      analyzerVersion: updated.analyzerVersion,
      summary: updated.summary as any,
      technologies: (updated.technologies as any) || [],
      statistics: updated.statistics as any,
      errorSummary: updated.errorSummary,
      startedAt: updated.startedAt?.toISOString() || null,
      completedAt: updated.completedAt?.toISOString() || null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[Intelligence] Analysis ${analysisId} failed: ${errorMsg}`);

    const failed = await prisma.repositoryAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'FAILED',
        errorSummary: errorMsg,
        completedAt: new Date(),
      },
    });

    return {
      id: failed.id,
      repositoryId: failed.repositoryId,
      workspaceId: failed.workspaceId,
      status: 'FAILED',
      analyzerVersion: failed.analyzerVersion,
      summary: null,
      technologies: [],
      statistics: null,
      errorSummary: errorMsg,
      startedAt: failed.startedAt?.toISOString() || null,
      completedAt: failed.completedAt?.toISOString() || null,
      createdAt: failed.createdAt.toISOString(),
      updatedAt: failed.updatedAt.toISOString(),
    };
  }
}

export async function getLatestAnalysis(
  repositoryId: string,
  workspaceId: string
): Promise<RepositoryAnalysisResponse | null> {
  const record = await prisma.repositoryAnalysis.findFirst({
    where: { repositoryId, workspaceId },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return null;

  return {
    id: record.id,
    repositoryId: record.repositoryId,
    workspaceId: record.workspaceId,
    status: record.status as any,
    analyzerVersion: record.analyzerVersion,
    summary: record.summary as any,
    technologies: (record.technologies as any) || [],
    statistics: record.statistics as any,
    errorSummary: record.errorSummary,
    startedAt: record.startedAt?.toISOString() || null,
    completedAt: record.completedAt?.toISOString() || null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function getAnalysisInventory(
  analysisId: string,
  workspaceId: string,
  page: number = 1,
  pageSize: number = 50,
  categoryFilter?: string
): Promise<{ files: FileInventoryItem[]; total: number; page: number; pageSize: number }> {
  const record = await prisma.repositoryAnalysis.findFirst({
    where: { id: analysisId, workspaceId },
  });

  if (!record || !record.inventory) {
    return { files: [], total: 0, page, pageSize };
  }

  let inventory = (record.inventory as any as FileInventoryItem[]) || [];

  if (categoryFilter) {
    inventory = inventory.filter((f) => f.category === categoryFilter);
  }

  const total = inventory.length;
  const startIndex = (page - 1) * pageSize;
  const files = inventory.slice(startIndex, startIndex + pageSize);

  return { files, total, page, pageSize };
}

export async function retrieveRelevantFilesForTask(
  repositoryId: string,
  workspaceId: string,
  taskDescription: string,
  limit: number = 10
): Promise<TaskRelevantFilesResponse> {
  // Find latest analysis
  let analysis = await prisma.repositoryAnalysis.findFirst({
    where: { repositoryId, workspaceId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
  });

  // If no completed analysis exists yet, perform analysis now
  if (!analysis || !analysis.inventory || !analysis.summary) {
    await createAndRunAnalysis(repositoryId, workspaceId);
    analysis = await prisma.repositoryAnalysis.findFirst({
      where: { repositoryId, workspaceId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!analysis || !analysis.inventory || !analysis.summary) {
    return {
      repositoryId,
      workspaceId,
      query: taskDescription,
      totalAnalyzed: 0,
      results: [],
      limitations: ['No completed analysis available to rank files.'],
    };
  }

  const inventory = analysis.inventory as any as FileInventoryItem[];
  const summary = analysis.summary as any;

  const results = rankRelevantFiles(taskDescription, inventory, summary, limit);

  return {
    repositoryId,
    workspaceId,
    query: taskDescription,
    totalAnalyzed: inventory.length,
    results,
    limitations: [
      'Relevance scores are heuristic indications of term proximity and functional role, not execution correctness proofs.',
    ],
  };
}
