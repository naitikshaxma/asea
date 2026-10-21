import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VerificationFinding, VerificationRun } from '@prisma/client';
import type { AuthorType, Finding, StaticAnalysisResult } from '@autonomous-engineer/contracts';
import { prisma } from '../prisma.js';
import { config } from '../../config.js';
import { canonicalJson, chainAuditEvent, verifyAuditChain } from '../auditChain.js';
import { resolveRepositoryFsPath } from '../intelligence/repositoryAnalysisService.js';
import { buildVerificationRequest } from './gitDiff.js';
import { requestStaticAnalysis } from './agentClient.js';

type Db = PrismaClient | Prisma.TransactionClient;
type FindingRow = Omit<VerificationFinding, 'id' | 'createdAt'>;

export const VERIFICATION_RESOURCE_TYPE = 'VerificationRun';

/**
 * Appends an AuditEvent to a VerificationRun's hash chain. Refuses to extend a
 * chain that no longer verifies.
 */
export async function appendVerificationAuditEvent(
  db: Db,
  run: Pick<VerificationRun, 'id' | 'workspaceId'>,
  eventType: string,
  metadata: Prisma.InputJsonObject,
  actorId: string | null
): Promise<void> {
  const existing = await db.auditEvent.findMany({
    where: { resourceType: VERIFICATION_RESOURCE_TYPE, resourceId: run.id },
  });
  const chain = verifyAuditChain(existing);
  if (!chain.valid) {
    throw new Error(`Audit chain of verification run ${run.id} is broken at ${chain.brokenEventId}: ${chain.reason}`);
  }

  const fields = {
    id: randomUUID(),
    workspaceId: run.workspaceId,
    actorId,
    eventType,
    resourceType: VERIFICATION_RESOURCE_TYPE,
    resourceId: run.id,
    metadata,
    requestId: null,
    timestamp: new Date(),
  };
  await db.auditEvent.create({ data: { ...fields, ...chainAuditEvent(chain.headHash, fields) } });
}

/** sha256 over the run's findings, recorded in the audit chain so edits to them are detectable. */
export function findingsDigest(rows: Array<Omit<FindingRow, 'verificationRunId'>>): string {
  const canonical = rows
    .map((r) => ({
      findingId: r.findingId,
      category: r.category,
      severity: r.severity,
      title: r.title,
      file: r.file,
      line: r.line,
      evidence: r.evidence,
      source: r.source,
      ruleId: r.ruleId,
      remediation: r.remediation,
    }))
    .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
}

function toFindingRow(verificationRunId: string, f: Finding): FindingRow {
  return {
    verificationRunId,
    findingId: f.id,
    category: f.category.toUpperCase() as FindingRow['category'],
    severity: f.severity.toUpperCase() as FindingRow['severity'],
    title: f.title,
    file: f.file,
    line: f.line,
    evidence: f.evidence,
    source: f.source.toUpperCase() as FindingRow['source'],
    ruleId: f.rule_id,
    remediation: f.remediation,
  };
}

function summarize(result: StaticAnalysisResult) {
  const findingsBySeverity: Record<string, number> = {};
  for (const f of result.findings) findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
  return {
    findingCount: result.findings.length,
    findingsBySeverity,
    toolsRun: result.tools_run,
    toolsUnavailable: result.tools_unavailable,
    durationMs: result.duration_ms,
  };
}

/**
 * The STATIC_ANALYSIS step of a VERIFICATION task: builds the request from the
 * repository's git history, calls the engine, and persists the findings and
 * hash-chained audit events. score and verdict are left null.
 */
export async function runVerificationStep(args: {
  taskId: string;
  workspaceId: string;
  actorId: string | null;
  attemptNumber: number;
  isFinalAttempt: boolean;
}): Promise<Prisma.InputJsonObject> {
  const run = await prisma.verificationRun.findFirst({
    where: { taskId: args.taskId, workspaceId: args.workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  if (!run) {
    throw new Error(`Task ${args.taskId} has no VerificationRun`);
  }
  if (run.status === 'COMPLETED') {
    // Results were already committed (e.g. a stalled job re-ran); don't analyse twice
    const findingCount = await prisma.verificationFinding.count({ where: { verificationRunId: run.id } });
    return { verificationRunId: run.id, findingCount, alreadyCompleted: true };
  }

  await prisma.verificationRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() },
  });
  await appendVerificationAuditEvent(
    prisma,
    run,
    'VERIFICATION_STARTED',
    { attemptNumber: args.attemptNumber, baseSha: run.baseSha, headSha: run.headSha },
    args.actorId
  );

  try {
    const repository = await prisma.repository.findFirstOrThrow({
      where: { id: run.repositoryId, workspaceId: args.workspaceId },
    });
    const request = await buildVerificationRequest({
      repositoryId: run.repositoryId,
      repoPath: resolveRepositoryFsPath(repository.repositoryUrl),
      baseSha: run.baseSha,
      headSha: run.headSha,
      requirement: run.requirement,
      authorType: run.authorType.toLowerCase() as AuthorType,
      maxRequestBytes: config.VERIFICATION_MAX_REQUEST_BYTES,
    });
    const result = await requestStaticAnalysis(request);
    const rows = result.findings.map((f) => toFindingRow(run.id, f));
    const summary = summarize(result);

    await prisma.$transaction(async (tx) => {
      await tx.verificationFinding.createMany({ data: rows });
      await tx.verificationRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await appendVerificationAuditEvent(
        tx,
        run,
        'STATIC_ANALYSIS_COMPLETED',
        {
          attemptNumber: args.attemptNumber,
          resolvedBaseSha: request.base_sha,
          resolvedHeadSha: request.head_sha,
          changedFiles: request.changed_files.length,
          ...summary,
          findingsDigest: findingsDigest(rows),
        },
        args.actorId
      );
      await appendVerificationAuditEvent(tx, run, 'VERIFICATION_COMPLETED', { findingCount: rows.length }, args.actorId);
    });

    return { verificationRunId: run.id, ...summary };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    await appendVerificationAuditEvent(
      prisma,
      run,
      args.isFinalAttempt ? 'VERIFICATION_FAILED' : 'VERIFICATION_ATTEMPT_FAILED',
      { attemptNumber: args.attemptNumber, error },
      args.actorId
    );
    if (args.isFinalAttempt) {
      await prisma.verificationRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date() } });
    }
    throw err;
  }
}
