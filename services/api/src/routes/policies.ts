import { Router } from 'express';
import type { PolicyProfile } from '@prisma/client';
import {
  CreatePolicyProfileRequestSchema,
  PolicyConfigSchema,
  UpdatePolicyProfileRequestSchema,
  type PolicyProfileListResponse,
  type PolicyProfileResponse,
} from '@autonomous-engineer/contracts';
import { prisma } from '../services/prisma.js';
import { requireAuth, requireWorkspaceMembership } from '../middlewares/authMiddleware.js';
import { AppError } from '../middlewares/errorHandler.js';
import {
  ensureDefaultPolicy,
  isUniqueViolation,
  makeDefaultPolicy,
  policyConfigHash,
} from '../services/policy/policyService.js';

export const policiesRouter = Router({ mergeParams: true });

function formatPolicy(profile: PolicyProfile): PolicyProfileResponse {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    name: profile.name,
    description: profile.description,
    config: PolicyConfigSchema.parse(profile.config),
    configHash: profile.configHash,
    isDefault: profile.isDefault,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

async function findPolicyOr404(workspaceId: string, policyId: string): Promise<PolicyProfile> {
  const profile = await prisma.policyProfile.findFirst({ where: { id: policyId, workspaceId } });
  if (!profile) {
    throw new AppError(404, 'NOT_FOUND', `Policy profile ${policyId} not found`);
  }
  return profile;
}

function duplicateNameError(name: string): AppError {
  return new AppError(409, 'CONFLICT', `A policy profile named '${name}' already exists in this workspace`);
}

policiesRouter.get(
  '/workspaces/:workspaceId/policies',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      await ensureDefaultPolicy(prisma, workspaceId);
      const profiles = await prisma.policyProfile.findMany({
        where: { workspaceId },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      });
      const body: PolicyProfileListResponse = { policies: profiles.map(formatPolicy), total: profiles.length };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

policiesRouter.post(
  '/workspaces/:workspaceId/policies',
  requireAuth,
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const validated = CreatePolicyProfileRequestSchema.parse(req.body);
      // The default profile must exist first, so a new profile can't be the only one without it
      await ensureDefaultPolicy(prisma, workspaceId);
      const created = await prisma.$transaction(async (tx) => {
        const profile = await tx.policyProfile.create({
          data: {
            workspaceId,
            name: validated.name,
            description: validated.description,
            config: validated.config,
            configHash: policyConfigHash(validated.config),
            isDefault: false,
          },
        });
        if (validated.isDefault) {
          await makeDefaultPolicy(tx, workspaceId, profile.id);
          return { ...profile, isDefault: true };
        }
        return profile;
      });
      res.status(201).json(formatPolicy(created));
    } catch (err) {
      next(isUniqueViolation(err) ? duplicateNameError(String(req.body?.name)) : err);
    }
  }
);

policiesRouter.get(
  '/workspaces/:workspaceId/policies/:policyId',
  requireAuth,
  requireWorkspaceMembership('MEMBER'),
  async (req, res, next) => {
    try {
      res.status(200).json(formatPolicy(await findPolicyOr404(req.params['workspaceId']!, req.params['policyId']!)));
    } catch (err) {
      next(err);
    }
  }
);

// Edits apply to future runs only: each run keeps the config snapshot it was scored with
policiesRouter.patch(
  '/workspaces/:workspaceId/policies/:policyId',
  requireAuth,
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const workspaceId = req.params['workspaceId']!;
      const validated = UpdatePolicyProfileRequestSchema.parse(req.body);
      const existing = await findPolicyOr404(workspaceId, req.params['policyId']!);
      const updated = await prisma.$transaction(async (tx) => {
        const profile = await tx.policyProfile.update({
          where: { id: existing.id },
          data: {
            name: validated.name,
            description: validated.description,
            ...(validated.config ? { config: validated.config, configHash: policyConfigHash(validated.config) } : {}),
          },
        });
        if (validated.isDefault && !profile.isDefault) {
          await makeDefaultPolicy(tx, workspaceId, profile.id);
          return { ...profile, isDefault: true };
        }
        return profile;
      });
      res.status(200).json(formatPolicy(updated));
    } catch (err) {
      next(isUniqueViolation(err) ? duplicateNameError(String(req.body?.name)) : err);
    }
  }
);

policiesRouter.delete(
  '/workspaces/:workspaceId/policies/:policyId',
  requireAuth,
  requireWorkspaceMembership('ADMIN'),
  async (req, res, next) => {
    try {
      const profile = await findPolicyOr404(req.params['workspaceId']!, req.params['policyId']!);
      if (profile.isDefault) {
        throw new AppError(409, 'CONFLICT', 'The default policy profile cannot be deleted; make another profile the default first');
      }
      // Runs scored with it keep their snapshot; their policyProfileId becomes null
      await prisma.policyProfile.delete({ where: { id: profile.id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
