import { Router, type Request } from 'express';
import { prisma } from '../services/prisma.js';
import { AppError } from '../middlewares/errorHandler.js';
import { logger } from '../logger.js';
import { verifySignature } from '../services/github/webhookSignature.js';
import { PullRequestEventSchema, VERIFIED_ACTIONS, pullRequestToTask } from '../services/github/pullRequests.js';
import { submitTask } from '../services/taskSubmission.js';
import { dispatchPendingOutboxEvents } from '../services/outboxDispatcher.js';

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

    // Unknown repositories have no secret to verify with, so they fail authentication too
    const candidates = fullName
      ? await prisma.repository.findMany({
          where: { githubFullName: fullName, githubWebhookSecret: { not: null } },
          include: { workspace: { select: { ownerId: true } } },
        })
      : [];
    const signature = req.header('x-hub-signature-256');
    const repositories = candidates.filter((r) => verifySignature(r.githubWebhookSecret!, raw, signature));
    if (repositories.length === 0) {
      throw new AppError(401, 'UNAUTHORIZED', 'Webhook signature does not match any repository connected to this GitHub repository');
    }

    if (event === 'ping') {
      return res.status(200).json({ ok: true, repositories: repositories.length });
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
