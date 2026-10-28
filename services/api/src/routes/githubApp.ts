import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EnvConfig } from '../config.js';
import { config } from '../config.js';
import { AppError } from '../middlewares/errorHandler.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { authStateStore } from '../services/authStateStore.js';
import { prisma } from '../services/prisma.js';
import { GithubApiError, GithubAppClient } from '../services/github/githubAppClient.js';
import { diagnoseCiChecks, publishApprovedPatch, summarizeCiChecks, type PatchBaseFile } from '../services/github/publishPatch.js';

const installationIdSchema = z.string().trim().regex(/^\d{1,20}$/);
const connectSchema = z.object({
  installationRecordId: z.string().uuid(),
  fullName: z.string().trim().regex(/^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/),
}).strict();

function appClient(activeConfig: EnvConfig): GithubAppClient {
  try { return new GithubAppClient(activeConfig); }
  catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'GitHub App integration is not configured on this server'); }
}

function mapGithubError(error: unknown): never {
  if (error instanceof GithubApiError) {
    if (error.status === 401 || error.status === 403) throw new AppError(403, 'FORBIDDEN', 'The GitHub App does not have access to this installation or repository');
    if (error.status === 404) throw new AppError(404, 'NOT_FOUND', 'GitHub installation or repository was not found');
    if (error.status === 422) throw new AppError(400, 'BAD_REQUEST', 'GitHub rejected the installation or repository request');
    throw new AppError(502, 'DEPENDENCY_FAILURE', 'GitHub could not complete the requested operation');
  }
  throw error;
}

async function saveInstallation(workspaceId: string, userId: string, installation: { id: string; accountLogin: string; accountType: string }) {
  const saved = await prisma.githubAppInstallation.upsert({
    where: { workspaceId_installationId: { workspaceId, installationId: installation.id } },
    create: { workspaceId, installationId: installation.id, accountLogin: installation.accountLogin, accountType: installation.accountType, createdById: userId },
    update: { accountLogin: installation.accountLogin, accountType: installation.accountType },
    select: { id: true, installationId: true, accountLogin: true, accountType: true, createdAt: true },
  });
  await prisma.auditEvent.create({
    data: { workspaceId, actorId: userId, eventType: 'GITHUB_APP_INSTALLATION_CONNECTED', resourceType: 'GithubAppInstallation', resourceId: saved.id,
      metadata: { installationId: saved.installationId, accountLogin: saved.accountLogin, accountType: saved.accountType } },
  });
  return saved;
}

export function createGithubAppRouter(activeConfig: EnvConfig = config): Router {
  const router = Router({ mergeParams: true });
  router.use('/workspaces', requireAuth);

  router.get('/workspaces/:workspaceId/github-app', requireWorkspaceMembership('MEMBER'), async (req, res, next) => {
    try {
      const installations = await prisma.githubAppInstallation.findMany({
        where: { workspaceId: req.params['workspaceId']! },
        select: { id: true, installationId: true, accountLogin: true, accountType: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      res.status(200).json({
        configured: Boolean(activeConfig.GITHUB_APP_ID && activeConfig.GITHUB_APP_SLUG && activeConfig.GITHUB_APP_CLIENT_ID && activeConfig.GITHUB_APP_CLIENT_SECRET && activeConfig.GITHUB_APP_PRIVATE_KEY && activeConfig.GITHUB_APP_WEBHOOK_SECRET),
        appSlug: activeConfig.GITHUB_APP_SLUG ?? null,
        installations,
      });
    } catch (error) { next(error); }
  });

  router.get('/workspaces/:workspaceId/github-app/install-url', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      if (!activeConfig.GITHUB_APP_ID || !activeConfig.GITHUB_APP_SLUG || !activeConfig.GITHUB_APP_CLIENT_ID || !activeConfig.GITHUB_APP_CLIENT_SECRET || !activeConfig.GITHUB_APP_PRIVATE_KEY || !activeConfig.GITHUB_APP_WEBHOOK_SECRET) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'GitHub App integration is not configured on this server');
      }
      const state = jwt.sign({ purpose: 'github-app-install', workspaceId: req.params['workspaceId'], userId: req.user!.id }, activeConfig.JWT_SECRET, {
        algorithm: 'HS256', issuer: 'asea-api', audience: 'asea-github-app-install', expiresIn: '10m', jwtid: randomUUID(),
      });
      const url = `https://github.com/apps/${encodeURIComponent(activeConfig.GITHUB_APP_SLUG)}/installations/new?state=${encodeURIComponent(state)}`;
      res.status(200).json({ url, expiresInSeconds: 600 });
    } catch (error) { next(error); }
  });

  router.post('/workspaces/:workspaceId/github-app/installations/complete', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      const body = z.object({ installationId: installationIdSchema.optional(), state: z.string().min(20).max(4096), code: z.string().min(8).max(4096) }).strict().parse(req.body);
      let claims: jwt.JwtPayload;
      try {
        claims = jwt.verify(body.state, activeConfig.JWT_SECRET, {
          algorithms: ['HS256'], issuer: 'asea-api', audience: 'asea-github-app-install',
        }) as jwt.JwtPayload;
      } catch {
        throw new AppError(400, 'BAD_REQUEST', 'GitHub installation state is invalid or expired');
      }
      if (claims['purpose'] !== 'github-app-install' || claims['workspaceId'] !== req.params['workspaceId'] || claims['userId'] !== req.user!.id || !claims.jti) {
        throw new AppError(400, 'BAD_REQUEST', 'GitHub installation state does not match this workspace and user');
      }

      const client = appClient(activeConfig);
      let userInstallations;
      try {
        userInstallations = await client.getUserAccessibleInstallations(body.code);
      } catch (error) { mapGithubError(error); }
      const accessible = body.installationId
        ? userInstallations!.filter((candidate) => candidate.id === body.installationId)
        : userInstallations!;
      if (accessible.length === 0) throw new AppError(403, 'FORBIDDEN', 'The authenticated GitHub user cannot access this installation');
      if (!body.installationId && accessible.length > 1) {
        const consumed = await authStateStore.consumeOneTimeToken(claims.jti, 10 * 60 * 1000);
        if (!consumed) throw new AppError(409, 'CONFLICT', 'This GitHub installation callback has already been used');
        const selectionToken = jwt.sign({
          purpose: 'github-app-install-selection', workspaceId: req.params['workspaceId'], userId: req.user!.id,
          installationIds: accessible.map((item) => item.id),
        }, activeConfig.JWT_SECRET, { algorithm: 'HS256', issuer: 'asea-api', audience: 'asea-github-app-selection', expiresIn: '10m', jwtid: randomUUID() });
        return res.status(200).json({
          selectionRequired: true, selectionToken,
          installations: accessible.map(({ id, accountLogin, accountType }) => ({ installationId: id, accountLogin, accountType })),
        });
      }
      const selectedId = body.installationId ?? accessible[0]!.id;
      let installation;
      try { installation = await client.getInstallation(selectedId); }
      catch (error) { mapGithubError(error); }
      const authorizedAccount = accessible.find((candidate) => candidate.id === selectedId);
      if (!authorizedAccount || authorizedAccount.accountLogin.toLowerCase() !== installation!.accountLogin.toLowerCase()) {
        throw new AppError(403, 'FORBIDDEN', 'The authenticated GitHub user cannot access this App installation');
      }
      const consumed = await authStateStore.consumeOneTimeToken(claims.jti, 10 * 60 * 1000);
      if (!consumed) throw new AppError(409, 'CONFLICT', 'This GitHub installation callback has already been used');
      const saved = await saveInstallation(req.params['workspaceId']!, req.user!.id, installation!);
      res.status(201).json({ installation: saved });
    } catch (error) { next(error); }
  });

  router.post('/workspaces/:workspaceId/github-app/installations/select', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      const body = z.object({ selectionToken: z.string().min(20).max(64_000), installationId: installationIdSchema }).strict().parse(req.body);
      let claims: jwt.JwtPayload;
      try {
        claims = jwt.verify(body.selectionToken, activeConfig.JWT_SECRET, {
          algorithms: ['HS256'], issuer: 'asea-api', audience: 'asea-github-app-selection',
        }) as jwt.JwtPayload;
      } catch { throw new AppError(400, 'BAD_REQUEST', 'GitHub installation selection is invalid or expired'); }
      const installationIds = Array.isArray(claims['installationIds']) ? claims['installationIds'] : [];
      if (claims['purpose'] !== 'github-app-install-selection' || claims['workspaceId'] !== req.params['workspaceId'] || claims['userId'] !== req.user!.id || !claims.jti || !installationIds.includes(body.installationId)) {
        throw new AppError(400, 'BAD_REQUEST', 'Selected installation is not part of this authorization');
      }
      const consumed = await authStateStore.consumeOneTimeToken(claims.jti, 10 * 60 * 1000);
      if (!consumed) throw new AppError(409, 'CONFLICT', 'This GitHub installation selection has already been used');
      let installation;
      try { installation = await appClient(activeConfig).getInstallation(body.installationId); }
      catch (error) { mapGithubError(error); }
      const saved = await saveInstallation(req.params['workspaceId']!, req.user!.id, installation!);
      res.status(201).json({ installation: saved });
    } catch (error) { next(error); }
  });

  router.get('/workspaces/:workspaceId/github-app/installations/:installationRecordId/repositories', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      const installation = await prisma.githubAppInstallation.findFirst({
        where: { id: req.params['installationRecordId'], workspaceId: req.params['workspaceId'] },
      });
      if (!installation) throw new AppError(404, 'NOT_FOUND', 'GitHub App installation not found in this workspace');
      let repositories;
      try { repositories = await appClient(activeConfig).listInstallationRepositories(installation.installationId); }
      catch (error) { mapGithubError(error); }
      res.status(200).json({ repositories: repositories!.map(({ id, full_name, private: isPrivate, default_branch }) => ({ id, fullName: full_name, private: isPrivate, defaultBranch: default_branch })) });
    } catch (error) { next(error); }
  });

  router.put('/workspaces/:workspaceId/repositories/:repositoryId/github-app', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      const body = connectSchema.parse(req.body);
      const workspaceId = req.params['workspaceId']!;
      const repository = await prisma.repository.findFirst({ where: { id: req.params['repositoryId'], workspaceId } });
      if (!repository) throw new AppError(404, 'NOT_FOUND', 'Repository not found in this workspace');
      const installation = await prisma.githubAppInstallation.findFirst({ where: { id: body.installationRecordId, workspaceId } });
      if (!installation) throw new AppError(404, 'NOT_FOUND', 'GitHub App installation not found in this workspace');
      const normalizedName = body.fullName.toLowerCase();
      let remote;
      try {
        remote = (await appClient(activeConfig).listInstallationRepositories(installation.installationId))
          .find((candidate) => candidate.full_name.toLowerCase() === normalizedName);
      } catch (error) { mapGithubError(error); }
      if (!remote) throw new AppError(403, 'FORBIDDEN', 'The selected repository is not available to this GitHub App installation');

      const updated = await prisma.repository.update({
        where: { id: repository.id },
        data: { githubFullName: normalizedName, githubAppInstallationId: installation.id, defaultBranch: remote.default_branch },
        select: { id: true, githubFullName: true, githubAppInstallationId: true, defaultBranch: true },
      });
      await prisma.auditEvent.create({
        data: {
          workspaceId, actorId: req.user!.id, eventType: 'GITHUB_APP_REPOSITORY_CONNECTED', resourceType: 'Repository', resourceId: updated.id,
          metadata: { githubFullName: updated.githubFullName, githubAppInstallationId: updated.githubAppInstallationId },
        },
      });
      res.status(200).json({ repositoryId: updated.id, githubFullName: updated.githubFullName, installationRecordId: updated.githubAppInstallationId, defaultBranch: updated.defaultBranch });
    } catch (error) { next(error); }
  });

  router.delete('/workspaces/:workspaceId/repositories/:repositoryId/github-app', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    try {
      const repository = await prisma.repository.findFirst({ where: { id: req.params['repositoryId'], workspaceId: req.params['workspaceId'] } });
      if (!repository) throw new AppError(404, 'NOT_FOUND', 'Repository not found in this workspace');
      const updated = await prisma.repository.update({ where: { id: repository.id }, data: { githubAppInstallationId: null }, select: { id: true } });
      await prisma.auditEvent.create({
        data: { workspaceId: req.params['workspaceId']!, actorId: req.user!.id, eventType: 'GITHUB_APP_REPOSITORY_DISCONNECTED', resourceType: 'Repository', resourceId: updated.id },
      });
      res.status(204).send();
    } catch (error) { next(error); }
  });

  router.post('/workspaces/:workspaceId/tasks/:taskId/publish', requireWorkspaceMembership('ADMIN'), async (req, res, next) => {
    const workspaceId = req.params['workspaceId']!;
    const taskId = req.params['taskId']!;
    let patchId: string | undefined;
    try {
      const patch = await prisma.taskPatch.findFirst({
        where: { taskId, task: { workspaceId } },
        orderBy: { createdAt: 'desc' },
        include: { task: { include: { repository: true } } },
      });
      if (!patch) throw new AppError(404, 'NOT_FOUND', 'Task patch not found');
      patchId = patch.id;
      if (patch.publicationStatus === 'PR_OPEN' && patch.pullRequestUrl && patch.publishedBranch && patch.githubCommitSha) {
        return res.status(200).json({
          publicationStatus: patch.publicationStatus, branch: patch.publishedBranch, commitSha: patch.githubCommitSha,
          pullRequestNumber: patch.pullRequestNumber, pullRequestUrl: patch.pullRequestUrl, ciStatus: patch.ciStatus,
        });
      }
      const executionMetadata = patch.task.executionMetadata && typeof patch.task.executionMetadata === 'object' && !Array.isArray(patch.task.executionMetadata)
        ? patch.task.executionMetadata as Record<string, unknown> : {};
      if (patch.task.status !== 'NEEDS_ATTENTION' || executionMetadata['patchHash'] !== patch.patchHash) {
        throw new AppError(409, 'CONFLICT', 'Only the task’s current patch can be published');
      }
      if (patch.status !== 'APPROVED') throw new AppError(409, 'CONFLICT', 'Only an approved patch can be published');
      if (patch.testStatus !== 'PASSED' || patch.securityStatus !== 'PASSED' || patch.reviewStatus !== 'PASSED') {
        throw new AppError(409, 'CONFLICT', 'Publishing requires passing sandbox tests, security scans, and independent review');
      }
      const approval = await prisma.approval.findFirst({
        where: { taskId, patchHash: patch.patchHash, status: 'APPROVED', decidedById: { not: null } },
      });
      if (!approval || approval.requestedById === approval.decidedById) throw new AppError(409, 'CONFLICT', 'A valid second-person approval is required for this patch');
      if (patch.task.taskType !== 'CODE_PATCH' || !patch.task.repository) throw new AppError(409, 'CONFLICT', 'This task is not linked to a publishable local repository');
      const repository = patch.task.repository;
      if (!repository.githubFullName || !repository.githubAppInstallationId) throw new AppError(409, 'CONFLICT', 'Connect this repository to a GitHub App installation before publishing');
      const installation = await prisma.githubAppInstallation.findFirst({ where: { id: repository.githubAppInstallationId, workspaceId } });
      if (!installation) throw new AppError(409, 'CONFLICT', 'The repository GitHub App installation is no longer connected');
      if (!patch.sourceRevision) throw new AppError(409, 'CONFLICT', 'The patch was generated from a dirty or non-Git source snapshot and cannot be published');

      const claimed = await prisma.taskPatch.updateMany({
        where: { id: patch.id, publicationStatus: { in: ['NOT_PUBLISHED', 'FAILED'] } },
        data: { publicationStatus: 'PUBLISHING', publicationError: null },
      });
      if (claimed.count !== 1) throw new AppError(409, 'CONFLICT', 'Patch publication is already in progress');

      try {
        const result = await publishApprovedPatch({
          client: appClient(activeConfig), installationId: installation.installationId,
          repositoryFullName: repository.githubFullName, baseBranch: repository.defaultBranch,
          taskId, patchHash: patch.patchHash, sourceRevision: patch.sourceRevision,
          summary: patch.summary, changedFiles: Array.isArray(patch.changedFiles) ? patch.changedFiles as string[] : [],
          baseFiles: Array.isArray(patch.baseFiles) ? patch.baseFiles as unknown as PatchBaseFile[] : [],
          unifiedDiff: patch.unifiedDiff,
        });
        const publishedAt = new Date();
        const saved = await prisma.$transaction(async (tx) => {
          const updated = await tx.taskPatch.update({
            where: { id: patch.id },
            data: {
              publicationStatus: 'PR_OPEN', publicationError: null, publishedBranch: result.branch,
              githubCommitSha: result.commitSha, pullRequestNumber: result.pullRequest.number,
              pullRequestUrl: result.pullRequest.html_url, publishedAt, ciStatus: 'PENDING',
            },
          });
          await tx.auditEvent.create({
            data: { workspaceId, actorId: req.user!.id, eventType: 'PATCH_PUBLISHED', resourceType: 'TaskPatch', resourceId: patch.id,
              metadata: { taskId, patchHash: patch.patchHash, repository: repository.githubFullName, branch: result.branch,
                commitSha: result.commitSha, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.html_url } },
          });
          return updated;
        });
        return res.status(201).json({
          publicationStatus: saved.publicationStatus, branch: saved.publishedBranch, commitSha: saved.githubCommitSha,
          pullRequestNumber: saved.pullRequestNumber, pullRequestUrl: saved.pullRequestUrl, ciStatus: saved.ciStatus,
        });
      } catch (error) {
        await prisma.taskPatch.updateMany({
          where: { id: patch.id, publicationStatus: 'PUBLISHING' },
          data: { publicationStatus: 'FAILED', publicationError: error instanceof GithubApiError ? `GitHub API returned HTTP ${error.status}` : 'Publication could not be completed safely' },
        });
        if (error instanceof AppError) throw error;
        if (error instanceof GithubApiError) mapGithubError(error);
        if (error instanceof Error && /changed since|no clean source|metadata|already exists|unsafe|invalid|not match|binary|UTF-8/.test(error.message)) {
          throw new AppError(409, 'CONFLICT', error.message.slice(0, 300));
        }
        throw new AppError(502, 'DEPENDENCY_FAILURE', 'Pull request publication failed; the patch remains available for retry');
      }
    } catch (error) { next(error); }
  });

  router.post('/workspaces/:workspaceId/tasks/:taskId/ci/sync', requireWorkspaceMembership('MEMBER'), async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const taskId = req.params['taskId']!;
      const patch = await prisma.taskPatch.findFirst({
        where: { taskId, task: { workspaceId } }, orderBy: { createdAt: 'desc' },
        include: { task: { include: { repository: true } } },
      });
      if (!patch) throw new AppError(404, 'NOT_FOUND', 'Task patch not found');
      if (patch.publicationStatus !== 'PR_OPEN' || !patch.githubCommitSha || !patch.task.repository?.githubFullName || !patch.task.repository.githubAppInstallationId) {
        throw new AppError(409, 'CONFLICT', 'CI can only be synchronized for a published pull request');
      }
      const installation = await prisma.githubAppInstallation.findFirst({ where: { id: patch.task.repository.githubAppInstallationId, workspaceId } });
      if (!installation) throw new AppError(409, 'CONFLICT', 'The repository GitHub App installation is no longer connected');
      const [owner, repo] = patch.task.repository.githubFullName.split('/');
      if (!owner || !repo) throw new AppError(409, 'CONFLICT', 'The connected GitHub repository name is invalid');
      let checks;
      try { checks = await appClient(activeConfig).getCiChecks(installation.installationId, owner, repo, patch.githubCommitSha); }
      catch (error) { mapGithubError(error); }
      const result = summarizeCiChecks(checks!);
      const diagnosis = diagnoseCiChecks(result.status, result.checks);
      const changedStatus = result.status !== patch.ciStatus;
      const saved = await prisma.$transaction(async (tx) => {
        const updated = await tx.taskPatch.update({
          where: { id: patch.id }, data: { ciStatus: result.status, ciChecks: result.checks as any, ciDiagnosis: diagnosis as any, ciSyncedAt: new Date() },
        });
        if (changedStatus) await tx.auditEvent.create({
          data: { workspaceId, actorId: req.user!.id, eventType: 'PULL_REQUEST_CI_STATUS_UPDATED', resourceType: 'TaskPatch', resourceId: patch.id,
            metadata: { taskId, patchHash: patch.patchHash, commitSha: patch.githubCommitSha, status: result.status,
              checkCount: result.checks.length, diagnosisStatus: diagnosis.status, affectedFileCount: diagnosis.affectedFiles.length } },
        });
        return updated;
      });
      res.status(200).json({ ciStatus: saved.ciStatus, checks: saved.ciChecks, diagnosis: saved.ciDiagnosis, syncedAt: saved.ciSyncedAt?.toISOString() ?? null });
    } catch (error) { next(error); }
  });

  return router;
}
