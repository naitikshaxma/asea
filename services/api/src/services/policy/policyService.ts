import { createHash } from 'node:crypto';
import { Prisma, type PolicyProfile, type PrismaClient } from '@prisma/client';
import {
  DEFAULT_POLICY_CONFIG,
  DEFAULT_POLICY_NAME,
  PolicyConfigSchema,
  type PolicyConfig,
} from '@autonomous-engineer/contracts';
import { canonicalJson } from '../auditChain.js';
import { AppError } from '../../middlewares/errorHandler.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_POLICY_DESCRIPTION =
  'Default policy. Its weights, caps and bands are uncalibrated placeholders; tune them for your team.';

/** sha256 of the config's canonical JSON; the engine's policy_hash() gives the same value. */
export function policyConfigHash(config: PolicyConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * The workspace's default profile. It is created from DEFAULT_POLICY_CONFIG
 * the first time a workspace needs one; concurrent first calls converge on the
 * same row through the (workspaceId, name) unique key.
 */
export async function ensureDefaultPolicy(db: Db, workspaceId: string): Promise<PolicyProfile> {
  const existing = await db.policyProfile.findFirst({ where: { workspaceId, isDefault: true } });
  if (existing) return existing;
  try {
    return await db.policyProfile.upsert({
      where: { workspaceId_name: { workspaceId, name: DEFAULT_POLICY_NAME } },
      create: {
        workspaceId,
        name: DEFAULT_POLICY_NAME,
        description: DEFAULT_POLICY_DESCRIPTION,
        config: DEFAULT_POLICY_CONFIG,
        configHash: policyConfigHash(DEFAULT_POLICY_CONFIG),
        isDefault: true,
      },
      // A profile named "default" exists but no profile is the default: restore the invariant
      update: { isDefault: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return db.policyProfile.findFirstOrThrow({ where: { workspaceId, isDefault: true } });
  }
}

export interface ResolvedPolicy {
  // null when the run's profile was deleted after its snapshot was taken
  profileId: string | null;
  config: PolicyConfig;
  hash: string;
}

/** Parses a stored profile and checks its config still matches its recorded hash. */
export function toResolvedPolicy(profile: Pick<PolicyProfile, 'id' | 'config' | 'configHash'>): ResolvedPolicy {
  const config = PolicyConfigSchema.parse(profile.config);
  const hash = policyConfigHash(config);
  if (hash !== profile.configHash) {
    throw new Error(`Policy profile ${profile.id} config does not match its configHash`);
  }
  return { profileId: profile.id, config, hash };
}

/** The profile a verification is scored with: the given one (must be in the workspace) or the default. */
export async function resolvePolicyForVerification(
  db: Db,
  workspaceId: string,
  policyProfileId?: string
): Promise<ResolvedPolicy> {
  if (!policyProfileId) {
    return toResolvedPolicy(await ensureDefaultPolicy(db, workspaceId));
  }
  const profile = await db.policyProfile.findFirst({ where: { id: policyProfileId, workspaceId } });
  if (!profile) {
    throw new AppError(400, 'BAD_REQUEST', 'Specified policy profile does not belong to this workspace');
  }
  return toResolvedPolicy(profile);
}

/** Makes `profileId` the workspace's only default profile. Call inside a transaction. */
export async function makeDefaultPolicy(db: Db, workspaceId: string, profileId: string): Promise<void> {
  await db.policyProfile.updateMany({
    where: { workspaceId, isDefault: true, NOT: { id: profileId } },
    data: { isDefault: false },
  });
  await db.policyProfile.update({ where: { id: profileId }, data: { isDefault: true } });
}
