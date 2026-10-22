import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VerificationFinding, VerificationRun } from '@prisma/client';
import {
  GithubRunInfoSchema,
  PolicyConfigSchema,
  type AgentRun,
  type AgentTimelineEntry,
  type AuthorType,
  type EngineInfo,
  type Finding,
  type IndexResponse,
  type Report,
  type RunReport,
  type ScoreResult,
} from '@autonomous-engineer/contracts';
import { prisma } from '../prisma.js';
import { config } from '../../config.js';
import { canonicalJson, chainAuditEvent, verifyAuditChain } from '../auditChain.js';
import { resolveRepositoryFsPath } from '../intelligence/repositoryAnalysisService.js';
import { buildVerificationRequest, ensurePullRequestCommits, readTreeFiles, resolveCommit, type TreeFile } from './gitDiff.js';
import { getIndexStatus, indexFiles, runPipeline } from './agentClient.js';
import { RUN_SEALED } from './runSeal.js';
import { ensureDefaultPolicy, policyConfigHash, toResolvedPolicy, type ResolvedPolicy } from '../policy/policyService.js';

type Db = PrismaClient | Prisma.TransactionClient;
type FindingRow = Omit<VerificationFinding, 'id' | 'createdAt'>;

export const VERIFICATION_RESOURCE_TYPE = 'VerificationRun';

/**
 * Appends an AuditEvent to a VerificationRun's hash chain and returns the new
 * head and length. Refuses to extend a chain that no longer verifies or that
 * has been sealed.
 */
export async function appendVerificationAuditEvent(
  db: Db,
  run: Pick<VerificationRun, 'id' | 'workspaceId'>,
  eventType: string,
  metadata: Prisma.InputJsonObject,
  actorId: string | null
): Promise<{ headHash: string; length: number }> {
  const existing = await db.auditEvent.findMany({
    where: { resourceType: VERIFICATION_RESOURCE_TYPE, resourceId: run.id },
  });
  const chain = verifyAuditChain(existing);
  if (!chain.valid) {
    throw new Error(`Audit chain of verification run ${run.id} is broken at ${chain.brokenEventId}: ${chain.reason}`);
  }
  if (existing.some((e) => e.eventType === RUN_SEALED)) {
    throw new Error(`Verification run ${run.id} is sealed; its audit chain cannot be extended`);
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
  const link = chainAuditEvent(chain.headHash, fields);
  await db.auditEvent.create({ data: { ...fields, ...link } });
  return { headHash: link.hash, length: chain.length + 1 };
}

/**
 * Moves a run to a terminal status: appends the final event, then RUN_SEALED
 * recording the chain head and event count at that point, and stores the same
 * head and count on the run (see runSeal.ts). Call inside a transaction.
 */
export async function finishVerificationRun(
  db: Db,
  run: Pick<VerificationRun, 'id' | 'workspaceId'>,
  outcome: {
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    eventType: string;
    metadata: Prisma.InputJsonObject;
    data?: Prisma.VerificationRunUpdateInput;
  },
  actorId: string | null
): Promise<void> {
  const sealed = await appendVerificationAuditEvent(db, run, outcome.eventType, outcome.metadata, actorId);
  await appendVerificationAuditEvent(
    db,
    run,
    RUN_SEALED,
    { status: outcome.status, auditHeadHash: sealed.headHash, auditEventCount: sealed.length },
    actorId
  );
  await db.verificationRun.update({
    where: { id: run.id },
    data: {
      ...outcome.data,
      status: outcome.status,
      completedAt: new Date(),
      auditHeadHash: sealed.headHash,
      auditEventCount: sealed.length,
    },
  });
}

/**
 * Cancels the task's verification run if it has not finished (QUEUED, or
 * RUNNING after a failed attempt): VERIFICATION_CANCELLED, then the seal.
 * A run that already reached a terminal state is left as it is.
 */
export async function cancelVerificationRunForTask(taskId: string, reason: string, actorId: string | null): Promise<void> {
  const runs = await prisma.verificationRun.findMany({
    where: { taskId, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  for (const run of runs) {
    await prisma.$transaction((tx) =>
      finishVerificationRun(tx, run, { status: 'CANCELLED', eventType: 'VERIFICATION_CANCELLED', metadata: { reason } }, actorId)
    );
  }
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

/** sha256 over the engine's ScoreResult, recorded in SCORE_COMPUTED so edits to the stored breakdown are detectable. */
export function scoreDigest(score: unknown): string {
  return createHash('sha256').update(canonicalJson(score), 'utf8').digest('hex');
}

/** The verdict as stored and returned by the API (uppercase, like the other enums). */
export function toVerdictEnum(verdict: ScoreResult['verdict']): NonNullable<VerificationRun['verdict']> {
  return verdict.toUpperCase() as NonNullable<VerificationRun['verdict']>;
}

/**
 * The policy the run is scored with: the snapshot taken at submission, checked
 * against its hash. Runs submitted before policy profiles existed get the
 * workspace's default profile, snapshotted now.
 */
async function policyForRun(run: VerificationRun): Promise<ResolvedPolicy> {
  if (run.policySnapshot !== null && run.policyHash !== null) {
    const config = PolicyConfigSchema.parse(run.policySnapshot);
    if (policyConfigHash(config) !== run.policyHash) {
      throw new Error(`Policy snapshot of verification run ${run.id} does not match its policyHash`);
    }
    return { profileId: run.policyProfileId, config, hash: run.policyHash };
  }
  const resolved = toResolvedPolicy(await ensureDefaultPolicy(prisma, run.workspaceId));
  await prisma.verificationRun.update({
    where: { id: run.id },
    data: { policyProfileId: resolved.profileId, policyHash: resolved.hash, policySnapshot: resolved.config },
  });
  return resolved;
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

/** sha256 over the stored report, recorded in REPORT_GENERATED so edits to it are detectable. */
export function reportDigest(report: unknown): string {
  return createHash('sha256').update(canonicalJson(report), 'utf8').digest('hex');
}

function toTimelineEntry(run: AgentRun): AgentTimelineEntry {
  return {
    name: run.name,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    durationMs: run.duration_ms,
    attempts: run.attempts,
    findingCount: run.finding_count,
    detail: run.detail,
    error: run.error,
  };
}

function toRunReport(report: Report): RunReport {
  return {
    summary: report.summary,
    generatedBy: report.generated_by,
    explanations: report.explanations.map((e) => ({
      findingId: e.finding_id,
      explanation: e.explanation,
      suggestedFix: e.suggested_fix,
    })),
  };
}

function countBySeverity(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Makes sure the engine has indexed the repository at the base commit, which
 * the architecture agent compares the change with. The engine caches the
 * index by commit, so after the first run of a commit this is one status call.
 * Files go in batches of at most INDEX_BATCH_BYTES; the last batch completes it.
 */
export async function ensureRepositoryIndexed(repositoryId: string, repoPath: string, baseSha: string) {
  const commitSha = await resolveCommit(repoPath, baseSha);
  const status = await getIndexStatus(repositoryId, commitSha);
  if (status.indexed) {
    return { commitSha, cached: true, symbols: status.symbols, files: 0, truncated: false };
  }
  const { files, truncated } = await readTreeFiles(repoPath, commitSha, {
    extensions: ['.py'],
    maxFiles: config.INDEX_MAX_FILES,
    maxBytes: config.INDEX_MAX_BYTES,
  });
  const batches: TreeFile[][] = [[]];
  let batchBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8') + Buffer.byteLength(file.path, 'utf8');
    if (batchBytes + bytes > config.INDEX_BATCH_BYTES && batches[batches.length - 1]!.length > 0) {
      batches.push([]);
      batchBytes = 0;
    }
    batches[batches.length - 1]!.push(file);
    batchBytes += bytes;
  }
  let last: IndexResponse | undefined;
  for (const [i, batch] of batches.entries()) {
    last = await indexFiles({ repository_id: repositoryId, commit_sha: commitSha, files: batch, complete: i === batches.length - 1 });
  }
  return { commitSha, cached: last!.cached, symbols: last!.symbols, files: files.length, truncated };
}

export type VerificationStepType = 'INDEX_REPOSITORY' | 'VERIFICATION_PIPELINE';

/** The worker records each phase of a verification as a WorkflowStep. */
export interface VerificationStepHooks {
  started(step: VerificationStepType): Promise<void>;
  finished(step: VerificationStepType, metadata: Prisma.InputJsonObject): Promise<void>;
}

/**
 * Runs a VERIFICATION task's verification: indexes the repository at the base
 * commit (INDEX_REPOSITORY), then builds the request from git and streams the
 * engine's pipeline (VERIFICATION_PIPELINE), keeping the run's agent timeline
 * up to date while it runs. Persists findings, score, verdict, report and the
 * hash-chained audit events, then seals the run.
 */
export async function runVerificationStep(args: {
  taskId: string;
  workspaceId: string;
  actorId: string | null;
  attemptNumber: number;
  isFinalAttempt: boolean;
  hooks: VerificationStepHooks;
}): Promise<void> {
  const { hooks } = args;
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
    await hooks.started('VERIFICATION_PIPELINE');
    await hooks.finished('VERIFICATION_PIPELINE', { verificationRunId: run.id, findingCount, alreadyCompleted: true });
    return;
  }

  await prisma.verificationRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date(), agentTimeline: [] },
  });
  const policy = await policyForRun(run);
  await appendVerificationAuditEvent(
    prisma,
    run,
    'VERIFICATION_STARTED',
    { attemptNumber: args.attemptNumber, baseSha: run.baseSha, headSha: run.headSha, policyHash: policy.hash },
    args.actorId
  );

  try {
    const repository = await prisma.repository.findFirstOrThrow({
      where: { id: run.repositoryId, workspaceId: args.workspaceId },
    });
    const repoPath = resolveRepositoryFsPath(repository.repositoryUrl);

    await hooks.started('INDEX_REPOSITORY');
    // A pull request's commits may not be in the checkout yet
    const github = run.github === null ? null : GithubRunInfoSchema.parse(run.github);
    const fetched = github
      ? (await ensurePullRequestCommits(repoPath, { baseSha: run.baseSha, headSha: run.headSha, pullNumber: github.pullNumber, baseRef: github.baseRef }, config.GITHUB_TOKEN)).fetched
      : false;
    const index = await ensureRepositoryIndexed(run.repositoryId, repoPath, run.baseSha);
    await appendVerificationAuditEvent(
      prisma,
      run,
      'REPOSITORY_INDEXED',
      { attemptNumber: args.attemptNumber, ...index, ...(github ? { fetchedPullRequest: fetched } : {}) },
      args.actorId
    );
    await hooks.finished('INDEX_REPOSITORY', { verificationRunId: run.id, ...index });

    await hooks.started('VERIFICATION_PIPELINE');
    const request = await buildVerificationRequest({
      repositoryId: run.repositoryId,
      repoPath,
      baseSha: run.baseSha,
      headSha: run.headSha,
      requirement: run.requirement,
      authorType: run.authorType.toLowerCase() as AuthorType,
      maxRequestBytes: config.VERIFICATION_MAX_REQUEST_BYTES,
    });
    const timeline: AgentTimelineEntry[] = [];
    const result = await runPipeline({ request, policy: policy.config }, async (event) => {
      const entry: AgentTimelineEntry =
        event.type === 'agent_started'
          ? { name: event.agent, status: 'running', startedAt: event.at, finishedAt: null, durationMs: null, attempts: 0, findingCount: 0, detail: null, error: null }
          : toTimelineEntry(event.run);
      const i = timeline.findIndex((e) => e.name === entry.name);
      if (i >= 0) timeline[i] = entry;
      else timeline.push(entry);
      await prisma.verificationRun.update({ where: { id: run.id }, data: { agentTimeline: asJson(timeline) } });
    });

    const score = result.score;
    if (score.policy_hash !== policy.hash) {
      throw new Error(`Engine scored with policy ${score.policy_hash}, expected ${policy.hash}`);
    }
    const verdict = toVerdictEnum(score.verdict);
    const rows = result.findings.map((f) => toFindingRow(run.id, f));
    const report = toRunReport(result.report);
    const engineInfo: EngineInfo = {
      llmProvider: result.llm.provider,
      llmModel: result.llm.model,
      complete: result.complete,
      toolsRun: result.static.tools_run,
      toolsUnavailable: result.static.tools_unavailable,
      semgrepRulesetSha256: result.static.semgrep_ruleset_sha256,
    };
    const findingsBySeverity = countBySeverity(result.findings);

    await prisma.$transaction(async (tx) => {
      await tx.verificationFinding.createMany({ data: rows });
      await appendVerificationAuditEvent(
        tx,
        run,
        'STATIC_ANALYSIS_COMPLETED',
        {
          attemptNumber: args.attemptNumber,
          resolvedBaseSha: request.base_sha,
          resolvedHeadSha: request.head_sha,
          changedFiles: request.changed_files.length,
          findingCount: result.static.finding_count,
          toolsRun: result.static.tools_run,
          toolsUnavailable: result.static.tools_unavailable,
          durationMs: result.static.duration_ms,
          semgrepRulesetSha256: result.static.semgrep_ruleset_sha256,
        },
        args.actorId
      );
      await appendVerificationAuditEvent(
        tx,
        run,
        'AGENTS_COMPLETED',
        {
          complete: result.complete,
          llmProvider: result.llm.provider,
          llmModel: result.llm.model,
          agents: result.agents
            .filter((a) => a.name === 'negative_space' || a.name === 'architecture' || a.name === 'report')
            .map((a) => ({ name: a.name, status: a.status, attempts: a.attempts, findingCount: a.finding_count, error: a.error })),
        },
        args.actorId
      );
      await appendVerificationAuditEvent(
        tx,
        run,
        'FINDINGS_RECORDED',
        { findingCount: rows.length, findingsBySeverity, findingsDigest: findingsDigest(rows) },
        args.actorId
      );
      await appendVerificationAuditEvent(
        tx,
        run,
        'SCORE_COMPUTED',
        {
          score: score.score,
          verdict,
          rawScore: score.raw_score,
          policyHash: score.policy_hash,
          policyProfileId: policy.profileId,
          capsApplied: score.caps_applied.map((c) => c.id),
          scoreDigest: scoreDigest(score),
        },
        args.actorId
      );
      await appendVerificationAuditEvent(
        tx,
        run,
        'REPORT_GENERATED',
        { generatedBy: report.generatedBy, reportDigest: reportDigest(report) },
        args.actorId
      );
      await finishVerificationRun(
        tx,
        run,
        {
          status: 'COMPLETED',
          eventType: 'VERIFICATION_COMPLETED',
          metadata: { findingCount: rows.length, score: score.score, verdict },
          data: {
            score: score.score,
            verdict,
            scoreBreakdown: asJson(score),
            report: asJson(report),
            agentTimeline: asJson(result.agents.map(toTimelineEntry)),
            engineInfo: asJson(engineInfo),
          },
        },
        args.actorId
      );
    });

    await hooks.finished('VERIFICATION_PIPELINE', {
      verificationRunId: run.id,
      findingCount: rows.length,
      findingsBySeverity,
      score: score.score,
      verdict,
      complete: result.complete,
      llmProvider: result.llm.provider,
      toolsRun: result.static.tools_run,
      toolsUnavailable: result.static.tools_unavailable,
      semgrepRulesetSha256: result.static.semgrep_ruleset_sha256,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const metadata = { attemptNumber: args.attemptNumber, error };
    if (args.isFinalAttempt) {
      await prisma.$transaction((tx) =>
        finishVerificationRun(tx, run, { status: 'FAILED', eventType: 'VERIFICATION_FAILED', metadata }, args.actorId)
      );
    } else {
      await appendVerificationAuditEvent(prisma, run, 'VERIFICATION_ATTEMPT_FAILED', metadata, args.actorId);
    }
    throw err;
  }
}
