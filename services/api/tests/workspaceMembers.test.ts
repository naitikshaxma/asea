import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { generateToken } from '../src/services/authService.js';
import { config } from '../src/config.js';
import { clearDevelopmentMailbox, readDevelopmentMailbox } from '../src/services/securityMail.js';

const workspaceId = 'ws-members-test';
const owner = { id: 'owner-1', email: 'owner@example.com' };
const token = generateToken({ userId: owner.id, email: owner.email });
const app = createApp();

function membership(role: 'OWNER' | 'ADMIN' | 'MEMBER') {
  return {
    id: `membership-${role.toLowerCase()}`,
    workspaceId,
    userId: owner.id,
    role,
    createdAt: new Date(),
    workspace: {
      id: workspaceId,
      name: 'Test workspace',
      ownerId: role === 'OWNER' ? owner.id : 'actual-owner',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

describe('workspace membership and invitation workflows', () => {
  const original = { env: config.NODE_ENV, mailbox: config.DEV_MAILBOX_TOKEN };
  beforeEach(() => { vi.clearAllMocks(); clearDevelopmentMailbox(); });
  afterEach(() => { config.NODE_ENV = original.env; config.DEV_MAILBOX_TOKEN = original.mailbox; });

  it('lists workspace members without returning password hashes or credentials', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('MEMBER') as any);
    vi.spyOn(prisma.workspaceMembership, 'findMany').mockResolvedValueOnce([{
      id: 'mem-1', workspaceId, userId: 'user-2', role: 'MEMBER', createdAt: new Date('2026-01-01T00:00:00Z'),
      user: { id: 'user-2', email: 'member@example.com', displayName: 'Test Member', passwordHash: 'never-return-this' },
    }] as any);

    const response = await request(app).get(`/api/v1/workspaces/${workspaceId}/members`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.members[0]).toMatchObject({ userId: 'user-2', email: 'member@example.com', role: 'MEMBER' });
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('never-return-this');
  });

  it('does not allow an administrator to invite another administrator', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('ADMIN') as any);
    const transaction = vi.spyOn(prisma, '$transaction');
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@example.com', role: 'ADMIN' });
    expect(response.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('stores only a hash of a one-time invitation token and returns no token in the API response', async () => {
    config.DEV_MAILBOX_TOKEN = 'development-mailbox-token-for-tests';
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('OWNER') as any);
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);
    let storedHash = '';
    const invitation = {
      id: 'invite-1', workspaceId, email: 'new@example.com', role: 'MEMBER',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), acceptedAt: null, revokedAt: null, createdAt: new Date(),
    };
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      workspaceInvitation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockImplementation(async ({ data }) => { storedHash = data.tokenHash; return invitation; }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    }));

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'NEW@example.com', role: 'MEMBER' });
    expect(response.status).toBe(201);
    expect(response.body.invitation).not.toHaveProperty('token');
    expect(response.body.invitation).not.toHaveProperty('tokenHash');
    const mail = readDevelopmentMailbox()[0]!;
    const inviteUrl = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    const tokenValue = new URLSearchParams(inviteUrl.hash.slice(1)).get('token')!;
    expect(storedHash).toBe(createHash('sha256').update(tokenValue).digest('hex'));
    expect(mail.to).toBe('new@example.com');
  });

  it('rejects an invitation token redeemed by a different email account', async () => {
    const findInvitation = vi.spyOn(prisma.workspaceInvitation, 'findUnique').mockResolvedValueOnce({
      id: 'invite-1', workspaceId, email: 'someone-else@example.com', role: 'MEMBER',
      expiresAt: new Date(Date.now() + 60_000), acceptedAt: null, revokedAt: null,
    } as any);
    const transaction = vi.spyOn(prisma, '$transaction');
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations/accept`)
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'i'.repeat(48) });
    expect(response.status).toBe(400);
    expect(findInvitation).toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts a matching, unexpired invitation once and audits the new membership atomically', async () => {
    const inviteeToken = generateToken({ userId: 'invitee-user', email: 'new@example.com' });
    vi.spyOn(prisma.workspaceInvitation, 'findUnique').mockResolvedValueOnce({
      id: 'invite-accept-1', workspaceId, email: 'new@example.com', role: 'MEMBER',
      expiresAt: new Date(Date.now() + 60_000), acceptedAt: null, revokedAt: null,
    } as any);
    const claim = vi.fn().mockResolvedValue({ count: 1 });
    const createMembership = vi.fn().mockResolvedValue({ id: 'accepted-membership' });
    const createAudit = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      workspaceInvitation: { updateMany: claim },
      workspaceMembership: { create: createMembership },
      auditEvent: { create: createAudit },
    }));

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`)
      .send({ token: 'i'.repeat(48) });
    expect(response.status).toBe(201);
    expect(createMembership).toHaveBeenCalledWith({ data: { workspaceId, userId: 'invitee-user', role: 'MEMBER' } });
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resourceId: 'accepted-membership' }) }));
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ acceptedAt: null }) }));
  });

  it('rejects an expired invitation before attempting to claim it', async () => {
    const inviteeToken = generateToken({ userId: 'invitee-user', email: 'new@example.com' });
    vi.spyOn(prisma.workspaceInvitation, 'findUnique').mockResolvedValueOnce({
      id: 'invite-expired', workspaceId, email: 'new@example.com', role: 'MEMBER',
      expiresAt: new Date(Date.now() - 1000), acceptedAt: null, revokedAt: null,
    } as any);
    const transaction = vi.spyOn(prisma, '$transaction');
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`)
      .send({ token: 'e'.repeat(48) });
    expect(response.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('prevents role changes to the workspace owner', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('OWNER') as any);
    vi.spyOn(prisma.workspaceMembership, 'findFirst').mockResolvedValueOnce({
      id: 'owner-membership', workspaceId, userId: owner.id, role: 'OWNER', createdAt: new Date(),
    } as any);
    const update = vi.spyOn(prisma.workspaceMembership, 'update');
    const response = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/owner-membership`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'MEMBER' });
    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('changes a non-owner role and writes the audit event in the same transaction', async () => {
    const target = { id: 'membership-target', workspaceId, userId: 'member-2', role: 'MEMBER', createdAt: new Date() };
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('OWNER') as any);
    vi.spyOn(prisma.workspaceMembership, 'findFirst').mockResolvedValueOnce(target as any);
    const update = vi.fn().mockResolvedValue({ ...target, role: 'ADMIN' });
    const audit = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      workspaceMembership: { update },
      auditEvent: { create: audit },
    }));

    const response = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${target.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ADMIN' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: target.id, userId: target.userId, role: 'ADMIN' });
    expect(update).toHaveBeenCalledWith({ where: { id: target.id }, data: { role: 'ADMIN' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'workspace.member.role_changed', resourceId: target.id,
      metadata: { userId: target.userId, previousRole: 'MEMBER', role: 'ADMIN' },
    }) }));
  });

  it('allows administrators to remove members with an atomic role check and audit', async () => {
    const target = { id: 'membership-target', workspaceId, userId: 'member-2', role: 'MEMBER', createdAt: new Date() };
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('ADMIN') as any);
    vi.spyOn(prisma.workspaceMembership, 'findFirst').mockResolvedValueOnce(target as any);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const audit = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      workspaceMembership: { deleteMany },
      auditEvent: { create: audit },
    }));

    const response = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${target.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(204);
    expect(deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      id: target.id, workspaceId, userId: { not: 'actual-owner' }, role: 'MEMBER',
    }) });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'workspace.member.removed', resourceId: target.id,
    }) }));
  });

  it('does not allow an administrator to remove another administrator', async () => {
    const target = { id: 'membership-admin', workspaceId, userId: 'admin-2', role: 'ADMIN', createdAt: new Date() };
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('ADMIN') as any);
    vi.spyOn(prisma.workspaceMembership, 'findFirst').mockResolvedValueOnce(target as any);
    const transaction = vi.spyOn(prisma, '$transaction');
    const response = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${target.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('revokes a pending invitation and audits the change atomically', async () => {
    const invitationId = 'invite-pending';
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce(membership('ADMIN') as any);
    vi.spyOn(prisma.workspaceInvitation, 'findFirst').mockResolvedValueOnce({
      id: invitationId, workspaceId, email: 'pending@example.com', acceptedAt: null, revokedAt: null,
    } as any);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const audit = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback({
      workspaceInvitation: { updateMany },
      auditEvent: { create: audit },
    }));

    const response = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(204);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: invitationId, workspaceId, acceptedAt: null, revokedAt: null,
    } }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'workspace.member.invitation_revoked', resourceId: invitationId,
    }) }));
  });
});
