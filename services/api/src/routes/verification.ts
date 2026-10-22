import { Router } from 'express';
import type { FindingSeverity, VerificationRun } from '@prisma/client';
import {
  PolicyConfigSchema,
  ScoreResultSchema,
  type AuditChainVerificationResponse,
  type ScoreBreakdownResponse,
  type VerificationFindingListResponse,
  type VerificationRunDetailResponse,
  type VerificationRunListResponse,
  type VerificationRunResponse,
} from '@autonomous-engineer/contracts';
import { prisma } from '../services/prisma.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { AppError } from '../middlewares/errorHandler.js';
import { verifyAuditChain } from '../services/auditChain.js';
import {
  VERIFICATION_RESOURCE_TYPE,
  findingsDigest,
  scoreDigest,
  toVerdictEnum,
} from '../services/verification/verificationService.js';
import { verifyRunSeal } from '../services/verification/runSeal.js';
import { policyConfigHash } from '../services/policy/policyService.js';

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
    policyProfileId: run.policyProfileId,
    policyHash: run.policyHash,
    findingCount: run._count.findings,
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

function formatScoreBreakdown(stored: unknown): ScoreBreakdownResponse | null {
  if (stored === null || stored === undefined) return null;
  const score = ScoreResultSchema.parse(stored);
  const upper = <T extends string>(value: T) => value.toUpperCase() as Uppercase<T>;
  return {
    score: score.score,
    verdict: toVerdictEnum(score.verdict),
    rawScore: score.raw_score,
    totalDeduction: score.total_deduction,
    policyHash: score.policy_hash,
    items: score.breakdown.map((item) => ({
      findingId: item.finding_id,
      ruleId: item.rule_id,
      title: item.title,
      category: upper(item.category),
      severity: upper(item.severity),
      source: upper(item.source),
      severityWeight: item.severity_weight,
      categoryMultiplier: item.category_multiplier,
      sourceMultiplier: item.source_multiplier,
      deduction: item.deduction,
    })),
    capsApplied: score.caps_applied.map((cap) => ({
      id: cap.id,
      severity: upper(cap.severity),
      minCount: cap.min_count,
      count: cap.count,
      maxScore: cap.max_score,
      loweredScore: cap.lowered_score,
    })),
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
      const run = await findRunOr404(req.params['workspaceId']!, req.params['runId']!);
      const body: VerificationRunDetailResponse = {
        ...formatRun(run),
        scoreBreakdown: formatScoreBreakdown(run.scoreBreakdown),
        policySnapshot: run.policySnapshot === null ? null : PolicyConfigSchema.parse(run.policySnapshot),
      };
      res.status(200).json(body);
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
 * True when the stored score, verdict, breakdown and policy snapshot all match
 * what SCORE_COMPUTED recorded; null until the run has been scored.
 */
function verifyStoredScore(
  run: Pick<VerificationRun, 'score' | 'verdict' | 'scoreBreakdown' | 'policyHash' | 'policySnapshot'>,
  scored: { metadata: unknown } | undefined
): boolean | null {
  if (!scored) return null;
  const recorded = (scored.metadata ?? {}) as Record<string, unknown>;
  const snapshot = PolicyConfigSchema.safeParse(run.policySnapshot);
  return (
    recorded['score'] === run.score &&
    recorded['verdict'] === run.verdict &&
    run.scoreBreakdown !== null &&
    recorded['scoreDigest'] === scoreDigest(run.scoreBreakdown) &&
    recorded['policyHash'] === run.policyHash &&
    snapshot.success &&
    policyConfigHash(snapshot.data) === run.policyHash
  );
}

/**
 * Checks the run's audit hash chain, its seal (terminal runs: detects removed
 * trailing events and edited head/count), once static analysis has completed
 * that the stored findings still match the digest in the chain, and once the
 * run is scored that the stored score matches SCORE_COMPUTED.
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

      const seal = verifyRunSeal(run, events, chain);
      const scoreValid = verifyStoredScore(
        run,
        events.find((e) => e.eventType === 'SCORE_COMPUTED')
      );

      const body: AuditChainVerificationResponse = {
        verificationRunId: run.id,
        valid: chain.valid && seal.valid !== false && findingsDigestValid !== false && scoreValid !== false,
        length: chain.length,
        headHash: chain.valid ? chain.headHash : undefined,
        chain: chain.valid
          ? { valid: true }
          : { valid: false, brokenEventId: chain.brokenEventId, reason: chain.reason },
        seal,
        findingsDigestValid,
        scoreValid,
      };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);
