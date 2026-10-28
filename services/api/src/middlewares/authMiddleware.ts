import type { Request, Response, NextFunction } from 'express';
import type { WorkspaceRole } from '@prisma/client';
import { verifyToken, type TokenPayload } from '../services/authService.js';
import { prisma } from '../services/prisma.js';
import { config } from '../config.js';
import { authStateStore } from '../services/authStateStore.js';
import { AppError } from './errorHandler.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
      authSession?: {
        id: string;
        userId: string;
      };
      workspace?: {
        id: string;
        name: string;
        ownerId: string;
        createdAt: Date;
        updatedAt: Date;
      };
      membership?: {
        id: string;
        workspaceId: string;
        userId: string;
        role: WorkspaceRole;
      };
    }
  }
}

const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  let token: string | undefined;

  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. Fall back to HttpOnly cookie
  if (!token && req.cookies && req.cookies[config.COOKIE_NAME]) {
    token = req.cookies[config.COOKIE_NAME];
  }

  if (!token) return next();

  let payload: TokenPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next();
  }

  if (!payload.jti) {
    // The legacy token helper is retained for route tests only. Deployed APIs
    // reject JWTs without a server-registered session id.
    if (config.NODE_ENV === 'test') {
      req.user = { id: payload.userId, email: payload.email };
    }
    return next();
  }

  req.authSession = { id: payload.jti, userId: payload.userId };
  const isLogout = req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/v1/auth/logout';
  if (isLogout) return next();

  try {
    const sessionUserId = await authStateStore.getSessionUserId(payload.jti);
    if (sessionUserId === payload.userId) {
      req.user = { id: payload.userId, email: payload.email };
    }
    next();
  } catch {
    next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Session storage is temporarily unavailable'));
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication is required to access this resource'));
  }
  next();
}

export function requireWorkspaceMembership(minRole: WorkspaceRole = 'MEMBER') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication is required'));
    }

    const workspaceId = req.params['workspaceId'] || req.body?.workspaceId;
    if (!workspaceId) {
      return next(new AppError(400, 'BAD_REQUEST', 'Workspace ID is required'));
    }

    try {
      const membership = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.id,
          },
        },
        include: {
          workspace: true,
        },
      });

      if (!membership) {
        return next(
          new AppError(403, 'FORBIDDEN', 'You do not have permission to access this workspace')
        );
      }

      // Role authorization check
      const userRank = ROLE_HIERARCHY[membership.role];
      const requiredRank = ROLE_HIERARCHY[minRole];

      if (userRank < requiredRank) {
        return next(
          new AppError(
            403,
            'FORBIDDEN',
            `Insufficient permissions. Role '${minRole}' or higher is required.`
          )
        );
      }

      req.workspace = membership.workspace;
      req.membership = {
        id: membership.id,
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
