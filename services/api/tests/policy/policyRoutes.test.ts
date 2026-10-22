import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { DEFAULT_POLICY_CONFIG } from '@autonomous-engineer/contracts';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/services/prisma.js';
import { generateToken } from '../../src/services/authService.js';
import { policyConfigHash } from '../../src/services/policy/policyService.js';

describe('Policy profile routes', () => {
  const app = createApp();
  const workspaceId = 'ws-p';
  const base = `/api/v1/workspaces/${workspaceId}/policies`;
  const token = generateToken({ userId: 'user-p', email: 'p@example.com' });
  const strict = { ...DEFAULT_POLICY_CONFIG, verdict_bands: { allow: 95, review: 80, high_risk: 50, block: 0 } };

  let role: 'MEMBER' | 'ADMIN' | 'OWNER';
  let rows: Array<Record<string, any>>;

  const row = (id: string, name: string, config: object, isDefault: boolean) => ({
    id,
    workspaceId,
    name,
    description: null,
    config,
    configHash: policyConfigHash(config as typeof DEFAULT_POLICY_CONFIG),
    isDefault,
    createdAt: new Date('2026-10-22T08:00:00Z'),
    updatedAt: new Date('2026-10-22T08:00:00Z'),
  });
  const matches = (r: Record<string, any>, where: Record<string, any>) =>
    r.workspaceId === where.workspaceId &&
    (where.id === undefined || r.id === where.id) &&
    (where.isDefault === undefined || r.isDefault === where.isDefault) &&
    (where.NOT === undefined || r.id !== where.NOT.id);

  beforeEach(() => {
    role = 'ADMIN';
    rows = [row('pol-default', 'default', DEFAULT_POLICY_CONFIG, true)];
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockImplementation((async () => ({
      id: 'mem-p',
      workspaceId,
      userId: 'user-p',
      role,
      createdAt: new Date(),
      workspace: { id: workspaceId, name: 'P', ownerId: 'user-p' },
    })) as any);
    vi.spyOn(prisma.policyProfile, 'findFirst').mockImplementation((async ({ where }: any) =>
      rows.find((r) => matches(r, where)) ?? null) as any);
    vi.spyOn(prisma.policyProfile, 'findMany').mockImplementation((async ({ where }: any) =>
      rows.filter((r) => matches(r, where)).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))) as any);
    vi.spyOn(prisma.policyProfile, 'upsert').mockImplementation((async ({ create }: any) => {
      const created = { ...row('pol-default', 'default', DEFAULT_POLICY_CONFIG, true), ...create };
      rows.push(created);
      return created;
    }) as any);
    vi.spyOn(prisma.policyProfile, 'create').mockImplementation((async ({ data }: any) => {
      if (rows.some((r) => r.workspaceId === data.workspaceId && r.name === data.name)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
      const created = { ...row(`pol-${data.name}`, data.name, data.config, false), ...data };
      rows.push(created);
      return created;
    }) as any);
    vi.spyOn(prisma.policyProfile, 'update').mockImplementation((async ({ where, data }: any) => {
      const target = rows.find((r) => r.id === where.id)!;
      for (const [k, v] of Object.entries(data)) if (v !== undefined) target[k] = v;
      return { ...target };
    }) as any);
    vi.spyOn(prisma.policyProfile, 'updateMany').mockImplementation((async ({ where, data }: any) => {
      const targets = rows.filter((r) => matches(r, where));
      targets.forEach((t) => Object.assign(t, data));
      return { count: targets.length };
    }) as any);
    vi.spyOn(prisma.policyProfile, 'delete').mockImplementation((async ({ where }: any) => {
      rows = rows.filter((r) => r.id !== where.id);
      return {};
    }) as any);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => fn(prisma)) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  it('lists profiles and creates the default one on first use', async () => {
    rows = [];
    const res = await as(request(app).get(base));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.policies[0]).toMatchObject({
      name: 'default',
      isDefault: true,
      config: DEFAULT_POLICY_CONFIG,
      configHash: policyConfigHash(DEFAULT_POLICY_CONFIG),
    });
    expect(res.body.policies[0].description).toMatch(/placeholders/);
  });

  it('creates a profile with its config hash, and can make it the default', async () => {
    const res = await as(request(app).post(base)).send({ name: 'strict', config: strict, isDefault: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'strict', isDefault: true, configHash: policyConfigHash(strict) });
    expect(rows.find((r) => r.id === 'pol-default')!.isDefault).toBe(false);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it('rejects invalid configs and names with 400 and a duplicate name with 409', async () => {
    const badBands = await as(request(app).post(base)).send({
      name: 'loose',
      config: { ...DEFAULT_POLICY_CONFIG, verdict_bands: { allow: 10, review: 20, high_risk: 30, block: 0 } },
    });
    expect(badBands.status).toBe(400);
    expect(badBands.body.error.code).toBe('VALIDATION_ERROR');

    const badName = await as(request(app).post(base)).send({ name: 'Has Spaces', config: strict });
    expect(badName.status).toBe(400);

    const duplicate = await as(request(app).post(base)).send({ name: 'default', config: strict });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('gets one profile and returns 404 for a profile in another workspace', async () => {
    expect((await as(request(app).get(`${base}/pol-default`))).body).toMatchObject({ id: 'pol-default' });
    rows.push({ ...row('pol-foreign', 'foreign', strict, false), workspaceId: 'ws-other' });
    expect((await as(request(app).get(`${base}/pol-foreign`))).status).toBe(404);
  });

  it('updates the config and recomputes its hash; isDefault moves the default', async () => {
    await as(request(app).post(base)).send({ name: 'strict', config: DEFAULT_POLICY_CONFIG });
    const res = await as(request(app).patch(`${base}/pol-strict`)).send({ config: strict, isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isDefault: true, configHash: policyConfigHash(strict), config: strict });
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual(['pol-strict']);

    expect((await as(request(app).patch(`${base}/pol-strict`)).send({})).status).toBe(400);
    expect((await as(request(app).patch(`${base}/pol-strict`)).send({ isDefault: false })).status).toBe(400);
  });

  it('deletes a non-default profile but refuses to delete the default', async () => {
    await as(request(app).post(base)).send({ name: 'strict', config: strict });
    const refused = await as(request(app).delete(`${base}/pol-default`));
    expect(refused.status).toBe(409);
    expect((await as(request(app).delete(`${base}/pol-strict`))).status).toBe(204);
    expect(rows.map((r) => r.id)).toEqual(['pol-default']);
    expect((await as(request(app).delete(`${base}/pol-strict`))).status).toBe(404);
  });

  it('lets members read but only admins change profiles', async () => {
    role = 'MEMBER';
    expect((await as(request(app).get(base))).status).toBe(200);
    expect((await as(request(app).post(base)).send({ name: 'strict', config: strict })).status).toBe(403);
    expect((await as(request(app).patch(`${base}/pol-default`)).send({ description: 'x' })).status).toBe(403);
    expect((await as(request(app).delete(`${base}/pol-default`))).status).toBe(403);
  });

  it('requires authentication and membership', async () => {
    expect((await request(app).get(base)).status).toBe(401);
    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await as(request(app).get(base))).status).toBe(403);
  });
});
