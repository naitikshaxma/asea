import { Router } from 'express';
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from '@autonomous-engineer/contracts';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import {
  CreateWorkspaceInvitationRequestSchema,
  UpdateWorkspaceMemberRoleRequestSchema,
} from '@autonomous-engineer/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../middlewares/errorHandler.js';
import { config } from '../config.js';
import { queueDevelopmentMail } from '../services/securityMail.js';

export const workspacesRouter = Router();

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invitationResponse(invitation: {
  id: string; workspaceId: string; email: string; role: 'ADMIN' | 'MEMBER';
  expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; createdAt: Date;
}) {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    createdAt: invitation.createdAt.toISOString(),
  };
}

// Apply requireAuth to all workspace routes
workspacesRouter.use('/workspaces', requireAuth);

workspacesRouter.get('/workspaces', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'desc' },
    });

    const workspaces = memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      ownerId: m.workspace.ownerId,
      role: m.role,
      createdAt: m.workspace.createdAt.toISOString(),
      updatedAt: m.workspace.updatedAt.toISOString(),
    }));

    res.status(200).json({ workspaces, total: workspaces.length });
  } catch (err) {
    next(err);
  }
});

workspacesRouter.post('/workspaces', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const validated = CreateWorkspaceRequestSchema.parse(req.body);

    const workspace = await prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name: validated.name,
          ownerId: userId,
        },
      });

      await tx.workspaceMembership.create({
        data: {
          workspaceId: ws.id,
          userId,
          role: 'OWNER',
        },
      });

      return ws;
    });

    res.status(201).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      role: 'OWNER',
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

workspacesRouter.get(
  '/workspaces/:workspaceId',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspace = req.workspace!;
      const membership = req.membership!;

      res.status(200).json({
        id: workspace.id,
        name: workspace.name,
        ownerId: workspace.ownerId,
        role: membership.role,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.patch(
  '/workspaces/:workspaceId',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const validated = UpdateWorkspaceRequestSchema.parse(req.body);

      const updated = await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          name: validated.name,
        },
      });

      res.status(200).json({
        id: updated.id,
        name: updated.name,
        ownerId: updated.ownerId,
        role: req.membership!.role,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.get(
  '/workspaces/:workspaceId/members',
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const members = await prisma.workspaceMembership.findMany({
        where: { workspaceId: req.params['workspaceId']! },
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'asc' },
      });
      res.status(200).json({
        members: members.map((member) => ({
          id: member.id,
          userId: member.user.id,
          email: member.user.email,
          displayName: member.user.displayName,
          role: member.role,
          createdAt: member.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.get(
  '/workspaces/:workspaceId/invitations',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const invitations = await prisma.workspaceInvitation.findMany({
        where: { workspaceId: req.params['workspaceId']! },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.status(200).json({ invitations: invitations.map(invitationResponse) });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.post(
  '/workspaces/:workspaceId/invitations',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const validated = CreateWorkspaceInvitationRequestSchema.parse(req.body);
      if (validated.role === 'ADMIN' && req.membership!.role !== 'OWNER') {
        throw new AppError(403, 'FORBIDDEN', 'Only the workspace owner can invite an administrator');
      }
      if (config.NODE_ENV === 'production' || !config.DEV_MAILBOX_TOKEN) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Invitation delivery is not configured');
      }

      const workspaceId = req.params['workspaceId']!;
      const existingUser = await prisma.user.findUnique({ where: { email: validated.email } });
      if (existingUser) {
        const membership = await prisma.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
        });
        if (membership) throw new AppError(409, 'BAD_REQUEST', 'This user is already a workspace member');
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const invitation = await prisma.$transaction(async (tx) => {
        await tx.workspaceInvitation.updateMany({
          where: { workspaceId, email: validated.email, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const created = await tx.workspaceInvitation.create({
          data: {
            workspaceId,
            email: validated.email,
            role: validated.role,
            tokenHash: tokenDigest(token),
            createdById: req.user!.id,
            expiresAt,
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: req.user!.id,
            eventType: 'workspace.member.invited',
            resourceType: 'WorkspaceInvitation',
            resourceId: created.id,
            metadata: { email: validated.email, role: validated.role },
          },
        });
        return created;
      });

      const inviteUrl = new URL('/accept-invitation', config.PUBLIC_WEB_URL);
      inviteUrl.hash = new URLSearchParams({ token, workspaceId }).toString();
      const queued = queueDevelopmentMail({
        to: validated.email,
        subject: 'You have been invited to an ASEA workspace',
        text: `Accept this invitation within 7 days: ${inviteUrl.toString()}`,
      });
      if (!queued) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Invitation delivery is not configured');
      res.status(201).json({ invitation: invitationResponse(invitation) });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.delete(
  '/workspaces/:workspaceId/invitations/:invitationId',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const invitationId = req.params['invitationId']!;
      const invitation = await prisma.workspaceInvitation.findFirst({ where: { id: invitationId, workspaceId } });
      if (!invitation) throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
      if (invitation.acceptedAt) throw new AppError(409, 'BAD_REQUEST', 'Accepted invitations cannot be revoked');
      await prisma.$transaction(async (tx) => {
        const result = await tx.workspaceInvitation.updateMany({
          where: { id: invitationId, workspaceId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (result.count !== 1) throw new AppError(409, 'BAD_REQUEST', 'Invitation is already inactive');
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: req.user!.id,
            eventType: 'workspace.member.invitation_revoked',
            resourceType: 'WorkspaceInvitation',
            resourceId: invitationId,
            metadata: { email: invitation.email },
          },
        });
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.post('/workspaces/:workspaceId/invitations/accept', async (req, res, next) => {
  try {
    if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
    const workspaceId = req.params['workspaceId']!;
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (token.length < 32 || token.length > 256) throw new AppError(400, 'BAD_REQUEST', 'Invitation token is invalid or expired');
    const invitation = await prisma.workspaceInvitation.findUnique({ where: { tokenHash: tokenDigest(token) } });
    const now = new Date();
    if (!invitation || invitation.workspaceId !== workspaceId || invitation.email !== req.user.email.toLowerCase() ||
        invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
      throw new AppError(400, 'BAD_REQUEST', 'Invitation token is invalid or expired for this account');
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.workspaceInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new AppError(400, 'BAD_REQUEST', 'Invitation token is invalid or expired');
      const acceptedMembership = await tx.workspaceMembership.create({
        data: { workspaceId, userId: req.user!.id, role: invitation.role },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorId: req.user!.id,
          eventType: 'workspace.member.invitation_accepted',
          resourceType: 'WorkspaceMembership',
          resourceId: acceptedMembership.id,
          metadata: { role: invitation.role },
        },
      });
    });
    res.status(201).json({ success: true, workspaceId, role: invitation.role });
  } catch (err) {
    next(err);
  }
});

workspacesRouter.patch(
  '/workspaces/:workspaceId/members/:membershipId',
  requireWorkspaceMembership('OWNER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const membershipId = req.params['membershipId']!;
      const validated = UpdateWorkspaceMemberRoleRequestSchema.parse(req.body);
      const target = await prisma.workspaceMembership.findFirst({ where: { id: membershipId, workspaceId } });
      if (!target) throw new AppError(404, 'NOT_FOUND', 'Workspace member not found');
      if (target.userId === req.workspace!.ownerId || target.role === 'OWNER') {
        throw new AppError(409, 'BAD_REQUEST', 'The workspace owner role cannot be changed');
      }
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.workspaceMembership.update({ where: { id: membershipId }, data: { role: validated.role } });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: req.user!.id,
            eventType: 'workspace.member.role_changed',
            resourceType: 'WorkspaceMembership',
            resourceId: membershipId,
            metadata: { userId: target.userId, previousRole: target.role, role: result.role },
          },
        });
        return result;
      });
      res.status(200).json({ id: updated.id, userId: updated.userId, role: updated.role });
    } catch (err) {
      next(err);
    }
  }
);

workspacesRouter.delete(
  '/workspaces/:workspaceId/members/:membershipId',
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const membershipId = req.params['membershipId']!;
      const target = await prisma.workspaceMembership.findFirst({ where: { id: membershipId, workspaceId } });
      if (!target) throw new AppError(404, 'NOT_FOUND', 'Workspace member not found');
      if (target.userId === req.workspace!.ownerId || target.role === 'OWNER') {
        throw new AppError(409, 'BAD_REQUEST', 'The workspace owner cannot be removed');
      }
      if (req.membership!.role !== 'OWNER' && target.role !== 'MEMBER') {
        throw new AppError(403, 'FORBIDDEN', 'Administrators can remove members but not other administrators');
      }
      await prisma.$transaction(async (tx) => {
        const removed = await tx.workspaceMembership.deleteMany({
          where: {
            id: membershipId,
            workspaceId,
            userId: { not: req.workspace!.ownerId },
            ...(req.membership!.role === 'OWNER' ? {} : { role: 'MEMBER' as const }),
          },
        });
        if (removed.count !== 1) throw new AppError(409, 'BAD_REQUEST', 'Member role changed or the owner cannot be removed');
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: req.user!.id,
            eventType: 'workspace.member.removed',
            resourceType: 'WorkspaceMembership',
            resourceId: membershipId,
            metadata: { userId: target.userId, role: target.role },
          },
        });
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
