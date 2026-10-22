import { Router } from 'express';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
} from '@autonomous-engineer/contracts';
import { registerUser, loginUser, toUserProfile } from '../services/authService.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { prisma } from '../services/prisma.js';
import { config } from '../config.js';

export const authRouter = Router();

// COOKIE_SECURE overrides the default (secure only in production)
function cookieSecure(): boolean {
  return config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : config.NODE_ENV === 'production';
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const validated = RegisterRequestSchema.parse(req.body);
    const { user, token } = await registerUser(validated);

    // Set secure HttpOnly session cookie
    res.cookie(config.COOKIE_NAME, token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // The JWT is delivered only in the HttpOnly cookie, never in the body (S3)
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const validated = LoginRequestSchema.parse(req.body);
    const { user, token } = await loginUser(validated);

    res.cookie(config.COOKIE_NAME, token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(config.COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
  });
  res.status(200).json({ success: true, message: 'Logged out successfully' });
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
