import { describe, it, expect, vi, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { DEFAULT_POLICY_CONFIG } from '@autonomous-engineer/contracts';
import { prisma } from '../../src/services/prisma.js';
import {
  ensureDefaultPolicy,
  policyConfigHash,
  resolvePolicyForVerification,
  toResolvedPolicy,
} from '../../src/services/policy/policyService.js';

// Pinned on both sides: services/agent-service/tests/test_scoring.py expects the same hash
const DEFAULT_POLICY_HASH = '3d2ba0a91b23ddfc65968bb2d62f08bd6e5ece14c832ae5f07f133eb75ac1391';

describe('policyService', () => {
  const workspaceId = 'ws-pol';
  const defaultRow = {
    id: 'pol-default',
    workspaceId,
    name: 'default',
    description: null,
    config: DEFAULT_POLICY_CONFIG,
    configHash: DEFAULT_POLICY_HASH,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hashes the default policy exactly like the Python engine', () => {
    expect(policyConfigHash(DEFAULT_POLICY_CONFIG)).toBe(DEFAULT_POLICY_HASH);
    // Key order does not matter; values do
    const reordered = Object.fromEntries(Object.entries(DEFAULT_POLICY_CONFIG).reverse()) as typeof DEFAULT_POLICY_CONFIG;
    expect(policyConfigHash(reordered)).toBe(DEFAULT_POLICY_HASH);
    expect(
      policyConfigHash({ ...DEFAULT_POLICY_CONFIG, source_multipliers: { deterministic: 1, llm: 0.6 } })
    ).not.toBe(DEFAULT_POLICY_HASH);
  });

  it('returns the existing default profile', async () => {
    vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue(defaultRow as any);
    const upsert = vi.spyOn(prisma.policyProfile, 'upsert');
    expect(await ensureDefaultPolicy(prisma, workspaceId)).toBe(defaultRow);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('creates the default profile from DEFAULT_POLICY_CONFIG when a workspace has none', async () => {
    vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue(null);
    const upsert = vi.spyOn(prisma.policyProfile, 'upsert').mockResolvedValue(defaultRow as any);

    await ensureDefaultPolicy(prisma, workspaceId);

    expect(upsert).toHaveBeenCalledWith({
      where: { workspaceId_name: { workspaceId, name: 'default' } },
      create: expect.objectContaining({
        workspaceId,
        name: 'default',
        config: DEFAULT_POLICY_CONFIG,
        configHash: DEFAULT_POLICY_HASH,
        isDefault: true,
      }),
      update: { isDefault: true },
    });
  });

  it('re-reads the default when a concurrent request created it first', async () => {
    vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue(null);
    vi.spyOn(prisma.policyProfile, 'upsert').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    );
    vi.spyOn(prisma.policyProfile, 'findFirstOrThrow').mockResolvedValue(defaultRow as any);

    expect(await ensureDefaultPolicy(prisma, workspaceId)).toBe(defaultRow);
  });

  it('resolves a chosen profile only inside its workspace', async () => {
    const findFirst = vi.spyOn(prisma.policyProfile, 'findFirst').mockResolvedValue(defaultRow as any);
    expect(await resolvePolicyForVerification(prisma, workspaceId, 'pol-default')).toEqual({
      profileId: 'pol-default',
      config: DEFAULT_POLICY_CONFIG,
      hash: DEFAULT_POLICY_HASH,
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'pol-default', workspaceId } });

    findFirst.mockResolvedValue(null);
    await expect(resolvePolicyForVerification(prisma, workspaceId, 'pol-other')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('refuses a stored profile whose config does not match its hash', () => {
    expect(() => toResolvedPolicy({ ...defaultRow, configHash: '0'.repeat(64) })).toThrow(/does not match its configHash/);
    expect(() => toResolvedPolicy({ ...defaultRow, config: { nonsense: true } })).toThrow();
  });
});
