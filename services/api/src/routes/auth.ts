import { Router, type Response } from 'express';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
} from '@autonomous-engineer/contracts';
import { registerUser, loginUser, toUserProfile, tokenTtlMs } from '../services/authService.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import { config } from '../config.js';
import { authStateStore } from '../services/authStateStore.js';
import { authRateLimit } from '../middlewares/authRateLimit.js';
import { AppError } from '../middlewares/errorHandler.js';
import {
  ChangePasswordRequestSchema,
  CompletePasswordResetRequestSchema,
  PasswordResetRequestSchema,
} from '@autonomous-engineer/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../services/authService.js';
import { queueDevelopmentMail } from '../services/securityMail.js';

export const authRouter = Router();

// COOKIE_SECURE overrides the default (secure only in production)
function cookieSecure(): boolean {
  return config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : config.NODE_ENV === 'production';
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    maxAge: tokenTtlMs(token),
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(config.COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
  });
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

authRouter.post('/register', authRateLimit, async (req, res, next) => {
  try {
    const validated = RegisterRequestSchema.parse(req.body);
    const { user, token } = await registerUser(validated);

    setSessionCookie(res, token);

    // The JWT is delivered only in the HttpOnly cookie, never in the body (S3)
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authRateLimit, async (req, res, next) => {
  try {
    const validated = LoginRequestSchema.parse(req.body);
    const { user, token } = await loginUser(validated);

    setSessionCookie(res, token);

    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    if (req.authSession) {
      await authStateStore.revokeSession(req.authSession.id, req.authSession.userId);
    }
    clearSessionCookie(res);
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch {
    next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Session storage is temporarily unavailable'));
  }
});

authRouter.post('/password/change', requireAuth, async (req, res, next) => {
  try {
    const validated = ChangePasswordRequestSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !(await verifyPassword(validated.currentPassword, user.passwordHash))) {
      throw new AppError(400, 'BAD_REQUEST', 'Current password is incorrect');
    }

    const passwordHash = await hashPassword(validated.newPassword);
    try { await authStateStore.revokeUserSessions(user.id); }
    catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Session storage is temporarily unavailable'); }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.auditEvent.create({
        data: { actorId: user.id, eventType: 'auth.password.changed', resourceType: 'User', resourceId: user.id },
      });
    });
    clearSessionCookie(res);
    res.status(200).json({ success: true, message: 'Password changed. Sign in again with your new password.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/password-reset/request', authRateLimit, async (req, res, next) => {
  try {
    const validated = PasswordResetRequestSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: validated.email } });
    if (user && config.NODE_ENV !== 'production' && config.DEV_MAILBOX_TOKEN) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await prisma.$transaction(async (tx) => {
        await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
        await tx.passwordResetToken.create({
          data: { userId: user.id, tokenHash: tokenDigest(token), expiresAt },
        });
        await tx.auditEvent.create({
          data: { actorId: user.id, eventType: 'auth.password_reset.requested', resourceType: 'User', resourceId: user.id },
        });
      });
      const resetUrl = new URL('/reset-password', config.PUBLIC_WEB_URL);
      resetUrl.hash = new URLSearchParams({ token }).toString();
      queueDevelopmentMail({
        to: user.email,
        subject: 'Reset your ASEA password',
        text: `Use this one-time link within 30 minutes: ${resetUrl.toString()}`,
      });
    }
    // Keep the same response for known, unknown, and undeliverable addresses.
    res.status(202).json({ success: true, message: 'If the account can receive a reset link, one has been sent.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/password-reset/complete', authRateLimit, async (req, res, next) => {
  try {
    const validated = CompletePasswordResetRequestSchema.parse(req.body);
    const now = new Date();
    const reset = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: tokenDigest(validated.token) },
      include: { user: true },
    });
    if (!reset || reset.usedAt || reset.expiresAt <= now || reset.user.accountStatus !== 'ACTIVE') {
      throw new AppError(400, 'BAD_REQUEST', 'This password reset link is invalid or expired');
    }

    const passwordHash = await hashPassword(validated.newPassword);
    try { await authStateStore.revokeUserSessions(reset.userId); }
    catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Session storage is temporarily unavailable'); }
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError(400, 'BAD_REQUEST', 'This password reset link is invalid or expired');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.passwordResetToken.deleteMany({ where: { userId: reset.userId, id: { not: reset.id } } });
      await tx.auditEvent.create({
        data: { actorId: reset.userId, eventType: 'auth.password_reset.completed', resourceType: 'User', resourceId: reset.userId },
      });
    });
    clearSessionCookie(res);
    res.status(200).json({ success: true, message: 'Password reset complete. Sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const workspaces = user.memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      ownerId: m.workspace.ownerId,
      role: m.role,
      createdAt: m.workspace.createdAt.toISOString(),
      updatedAt: m.workspace.updatedAt.toISOString(),
    }));

    res.status(200).json({
      user: toUserProfile(user),
      workspaces,
    });
  } catch (err) {
    next(err);
  }
});
