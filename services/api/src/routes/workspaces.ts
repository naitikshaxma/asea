import { Router } from 'express';
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from '@autonomous-engineer/contracts';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';

export const workspacesRouter = Router();

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
        createdAt: new Date().toISOString(),
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
