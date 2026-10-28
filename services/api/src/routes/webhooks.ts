import { Router, type Request } from 'express';
import { prisma } from '../services/prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import { logger } from '../logger.js';
import { verifySignature } from '../services/github/webhookSignature.js';
import { PullRequestEventSchema, VERIFIED_ACTIONS, pullRequestToTask } from '../services/github/pullRequests.js';
import { submitTask } from '../services/taskSubmission.js';
import { dispatchPendingOutboxEvents } from '../services/outboxDispatcher.js';
import { config } from '../config.js';
import { GithubAppClient } from '../services/github/githubAppClient.js';
import { diagnoseCiChecks, summarizeCiChecks } from '../services/github/publishPatch.js';

export const webhooksRouter = Router();

// app.ts keeps the exact request bytes for webhook paths: the signature is over them
export type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * GitHub webhook (content type application/json). Each connected repository
 * has its own secret; a delivery is accepted for the repositories registered
 * under its `repository.full_name` whose secret produced X-Hub-Signature-256.
 * `pull_request` events that change code (opened, synchronize, reopened,
 * ready_for_review) start a VERIFICATION task in each such repository's
 * workspace; the worker posts the result back as a PR comment. `ping` is
 * acknowledged; other events are ignored with 202.
 */
webhooksRouter.post('/webhooks/github', async (req, res, next) => {
  try {
    const event = req.header('x-github-event');
    const deliveryId = req.header('x-github-delivery');
    if (!event || !deliveryId) {
      throw new AppError(400, 'BAD_REQUEST', 'X-GitHub-Event and X-GitHub-Delivery headers are required');
    }
    const raw = (req as RawBodyRequest).rawBody;
    if (!raw || !req.is('application/json')) {
      throw new AppError(400, 'BAD_REQUEST', 'Webhook deliveries must use content type application/json');
    }
    const payload = req.body as { repository?: { full_name?: unknown } };
    const fullName = typeof payload?.repository?.full_name === 'string' ? payload.repository.full_name.toLowerCase() : null;
    const signature = req.header('x-hub-signature-256');
    const appSigned = Boolean(config.GITHUB_APP_WEBHOOK_SECRET && verifySignature(config.GITHUB_APP_WEBHOOK_SECRET, raw, signature));

    if (event === 'installation' && appSigned) {
      const body = req.body as { action?: unknown; installation?: { id?: unknown; account?: { login?: unknown; type?: unknown } } };
      if (body.action === 'deleted' && (typeof body.installation?.id === 'number' || typeof body.installation?.id === 'string')) {
        const installationId = String(body.installation.id);
        const connected = await prisma.githubAppInstallation.findMany({ where: { installationId }, select: { id: true, workspaceId: true } });
        await prisma.githubAppInstallation.deleteMany({ where: { installationId } });
        for (const installation of connected) await prisma.auditEvent.create({
          data: { workspaceId: installation.workspaceId, eventType: 'GITHUB_APP_INSTALLATION_REMOVED', resourceType: 'GithubAppInstallation', resourceId: installation.id,
            metadata: { installationId, deliveryId } },
        });
        return res.status(202).json({ accepted: true, removed: connected.length });
      }
      return res.status(202).json({ accepted: true, action: typeof body.action === 'string' ? body.action : 'unknown' });
    }
    if (event === 'ping' && appSigned) return res.status(200).json({ ok: true, githubApp: true });
    if (event === 'installation_repositories' && appSigned) return res.status(202).json({ accepted: true, reason: 'Repository access changes are reflected by the installation repository picker' });

    // Unknown repositories have no secret to verify with, so they fail authentication too
    const candidates = fullName
      ? await prisma.repository.findMany({
          where: { githubFullName: fullName, OR: [{ githubWebhookSecret: { not: null } }, { githubAppInstallationId: { not: null } }] },
          include: { workspace: { select: { ownerId: true } } },
        })
      : [];
    const repositories = candidates.filter((r) =>
      (Boolean(r.githubWebhookSecret) && verifySignature(r.githubWebhookSecret!, raw, signature)) ||
      (appSigned && Boolean(r.githubAppInstallationId))
    );
    if (repositories.length === 0) {
      throw new AppError(401, 'UNAUTHORIZED', 'Webhook signature does not match any repository connected to this GitHub repository');
    }

    if (event === 'ping') {
      return res.status(200).json({ ok: true, repositories: repositories.length });
    }
    if (['check_run', 'check_suite', 'status'].includes(event)) {
      if (!appSigned) return res.status(202).json({ accepted: false, reason: 'CI events require the GitHub App webhook signature' });
      const checkPayload = req.body as {
        check_run?: { head_sha?: unknown };
        check_suite?: { head_sha?: unknown };
        sha?: unknown;
      };
      const sha = [checkPayload.check_run?.head_sha, checkPayload.check_suite?.head_sha, checkPayload.sha]
        .find((value) => typeof value === 'string') as string | undefined;
      if (!fullName || !sha || !/^[a-f0-9]{40,64}$/i.test(sha)) {
        return res.status(202).json({ accepted: false, reason: 'CI event does not contain a repository and commit SHA' });
      }
      const patches = await prisma.taskPatch.findMany({
        where: { githubCommitSha: sha, publicationStatus: 'PR_OPEN', task: { repository: { githubFullName: fullName, githubAppInstallationId: { not: null } } } },
        include: { task: { include: { repository: true } } },
      });
      for (const patch of patches) {
        const repository = patch.task.repository;
        if (!repository?.githubAppInstallationId) continue;
        const installation = await prisma.githubAppInstallation.findFirst({ where: { id: repository.githubAppInstallationId, workspaceId: patch.task.workspaceId } });
        if (!installation) continue;
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) continue;
        try {
          const checks = await new GithubAppClient(config).getCiChecks(installation.installationId, owner, repo, sha);
          const result = summarizeCiChecks(checks);
          const diagnosis = diagnoseCiChecks(result.status, result.checks);
          const changed = result.status !== patch.ciStatus;
          await prisma.$transaction(async (tx) => {
            await tx.taskPatch.update({ where: { id: patch.id }, data: { ciStatus: result.status, ciChecks: result.checks as any, ciDiagnosis: diagnosis as any, ciSyncedAt: new Date() } });
            if (changed) await tx.auditEvent.create({
              data: { workspaceId: patch.task.workspaceId, eventType: 'PULL_REQUEST_CI_STATUS_UPDATED', resourceType: 'TaskPatch', resourceId: patch.id,
                metadata: { taskId: patch.taskId, patchHash: patch.patchHash, commitSha: sha, status: result.status,
                  checkCount: result.checks.length, diagnosisStatus: diagnosis.status, affectedFileCount: diagnosis.affectedFiles.length, deliveryId } },
            });
          });
        } catch {
          // GitHub will redeliver failed webhook requests when possible; no
          // provider details or credentials are written to logs.
          throw new Error('GitHub CI status synchronization failed');
        }
      }
      return res.status(202).json({ accepted: true, synchronized: patches.length });
    }
    if (event !== 'pull_request') {
      return res.status(202).json({ accepted: false, reason: `Event '${event}' is not used` });
    }
    const parsed = PullRequestEventSchema.parse(req.body);
    if (!VERIFIED_ACTIONS.has(parsed.action)) {
      return res.status(202).json({ accepted: false, reason: `Action '${parsed.action}' does not change the code` });
    }

    const pr = parsed.pull_request;
    const verifications = [];
    for (const repository of repositories) {
      // The workspace owner is the task's creator: the delivery has no user of this product
      const { task, created } = await submitTask(
        repository.workspaceId,
        repository.workspace.ownerId,
        pullRequestToTask(parsed, deliveryId, repository.id),
        {
          github: {
            repository: fullName!,
            pullNumber: pr.number,
            pullUrl: pr.html_url ?? null,
            baseRef: pr.base.ref,
            headRef: pr.head.ref,
            deliveryId,
          },
        }
      );
      verifications.push({ workspaceId: repository.workspaceId, repositoryId: repository.id, taskId: task.id, created });
    }
    if (verifications.some((v) => v.created)) {
      dispatchPendingOutboxEvents().catch(() => {});
    }
    logger.info(`[GitHub] ${fullName}#${pr.number} ${parsed.action}: ${verifications.length} verification(s)`, { deliveryId });
    res.status(202).json({ accepted: true, verifications });
  } catch (err) {
    next(err);
  }
});
