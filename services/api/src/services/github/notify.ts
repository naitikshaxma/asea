import type { Prisma } from '@prisma/client';
import { GithubRunInfoSchema, RunReportSchema, type GithubRunInfo } from '@autonomous-engineer/contracts';
import { prisma } from '../prisma.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { postPullRequestComment } from './githubClient.js';
import { formatPullRequestComment } from './prComment.js';

/**
 * Reports a finished verification on the pull request that triggered it, and
 * records the outcome (POSTED, FAILED or SKIPPED) on the run's `github` field.
 * The outcome is a notification, not part of the sealed audit chain. Runs that
 * no pull request triggered, or already commented on, are left alone. Never
 * throws: a GitHub problem must not fail the verification.
 */
export async function notifyPullRequestForTask(taskId: string, failure?: string): Promise<void> {
  try {
    const run = await prisma.verificationRun.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: { findings: true, policyProfile: { select: { name: true } } },
    });
    if (!run || run.github === null) return;
    const info = GithubRunInfoSchema.parse(run.github);
    if (info.comment?.status === 'POSTED') return;

    const at = new Date().toISOString();
    let comment: NonNullable<GithubRunInfo['comment']>;
    if (!config.GITHUB_TOKEN) {
      comment = { status: 'SKIPPED', url: null, error: 'GITHUB_TOKEN is not configured', at };
    } else {
      const body = formatPullRequestComment(
        {
          id: run.id,
          status: run.status,
          score: run.score,
          verdict: run.verdict,
          baseSha: run.baseSha,
          headSha: run.headSha,
          auditHeadHash: run.auditHeadHash,
          policyName: run.policyProfile?.name ?? null,
          findings: run.findings,
          report: run.report === null ? null : RunReportSchema.parse(run.report),
          error: failure ?? null,
        },
        config.PUBLIC_WEB_URL
      );
      try {
        const posted = await postPullRequestComment(info.repository, info.pullNumber, body);
        comment = { status: 'POSTED', url: posted.url, error: null, at };
      } catch (err) {
        comment = { status: 'FAILED', url: null, error: err instanceof Error ? err.message : String(err), at };
      }
    }
    await prisma.verificationRun.update({
      where: { id: run.id },
      data: { github: { ...info, comment } as Prisma.InputJsonObject },
    });
    logger.info(`[GitHub] PR comment for ${info.repository}#${info.pullNumber}: ${comment.status}`, {
      verificationRunId: run.id,
      error: comment.error,
    });
  } catch (err) {
    logger.error('[GitHub] Could not report the verification on its pull request', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
