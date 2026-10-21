import { Router } from 'express';
import type { FindingSeverity, VerificationRun } from '@prisma/client';
import type {
  AuditChainVerificationResponse,
  VerificationFindingListResponse,
  VerificationRunListResponse,
  VerificationRunResponse,
} from '@autonomous-engineer/contracts';
import { prisma } from '../services/prisma.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { AppError } from '../middlewares/errorHandler.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { VERIFICATION_RESOURCE_TYPE, findingsDigest } from '../services/verification/verificationService.js';

export const verificationRouter = Router({ mergeParams: true });

const SEVERITIES: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function formatRun(run: VerificationRun & { _count: { findings: number } }): VerificationRunResponse {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    repositoryId: run.repositoryId,
    taskId: run.taskId ?? undefined,
    baseSha: run.baseSha,
    headSha: run.headSha,
    requirement: run.requirement,
    authorType: run.authorType,
    status: run.status,
    score: run.score,
    verdict: run.verdict,
    findingCount: run._count.findings,
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

async function findRunOr404(workspaceId: string, runId: string) {
  const run = await prisma.verificationRun.findFirst({
    where: { id: runId, workspaceId },
    include: { _count: { select: { findings: true } } },
  });
  if (!run) {
    throw new AppError(404, 'NOT_FOUND', `Verification run ${runId} not found`);
  }
  return run;
}

verificationRouter.get(
  '/workspaces/:workspaceId/verification-runs',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const taskId = typeof req.query['taskId'] === 'string' ? req.query['taskId'] : undefined;
      const runs = await prisma.verificationRun.findMany({
        where: { workspaceId: req.params['workspaceId']!, ...(taskId ? { taskId } : {}) },
        include: { _count: { select: { findings: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const body: VerificationRunListResponse = { verificationRuns: runs.map(formatRun) };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

verificationRouter.get(
  '/workspaces/:workspaceId/verification-runs/:runId',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      res.status(200).json(formatRun(await findRunOr404(req.params['workspaceId']!, req.params['runId']!)));
    } catch (err) {
      next(err);
    }
  }
);

verificationRouter.get(
  '/workspaces/:workspaceId/verification-runs/:runId/findings',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const severity = req.query['severity'];
      if (severity !== undefined && !SEVERITIES.includes(severity as FindingSeverity)) {
        throw new AppError(400, 'BAD_REQUEST', `severity must be one of ${SEVERITIES.join(', ')}`);
      }
      const run = await findRunOr404(req.params['workspaceId']!, req.params['runId']!);
      const findings = await prisma.verificationFinding.findMany({
        where: { verificationRunId: run.id, ...(severity ? { severity: severity as FindingSeverity } : {}) },
        orderBy: [{ file: 'asc' }, { line: 'asc' }, { ruleId: 'asc' }],
      });
      const body: VerificationFindingListResponse = {
        verificationRunId: run.id,
        total: findings.length,
        findings: findings.map((f) => ({
          id: f.id,
          findingId: f.findingId,
          category: f.category,
          severity: f.severity,
          title: f.title,
          file: f.file,
          line: f.line,
          evidence: f.evidence,
          source: f.source,
          ruleId: f.ruleId,
          remediation: f.remediation,
        })),
      };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Checks the run's audit hash chain and, once static analysis has completed,
 * that the stored findings still match the digest recorded in the chain.
 */
verificationRouter.get(
  '/workspaces/:workspaceId/verification-runs/:runId/audit/verify',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const run = await findRunOr404(req.params['workspaceId']!, req.params['runId']!);
      const events = await prisma.auditEvent.findMany({
        where: { resourceType: VERIFICATION_RESOURCE_TYPE, resourceId: run.id },
      });
      const chain = verifyAuditChain(events);

      const completed = events.find((e) => e.eventType === 'STATIC_ANALYSIS_COMPLETED');
      const recordedDigest = (completed?.metadata as { findingsDigest?: unknown } | null)?.findingsDigest;
      let findingsDigestValid: boolean | null = null;
      if (completed) {
        const rows = await prisma.verificationFinding.findMany({ where: { verificationRunId: run.id } });
        findingsDigestValid = recordedDigest === findingsDigest(rows);
      }

      const body: AuditChainVerificationResponse = { verificationRunId: run.id, ...chain, findingsDigestValid };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);
