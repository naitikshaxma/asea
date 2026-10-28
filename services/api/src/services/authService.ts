import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { UserProfile } from '@autonomous-engineer/contracts';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import { AppError } from '../middlewares/errorHandler.js';
import { authStateStore } from './authStateStore.js';
import { randomUUID } from 'node:crypto';

// Keep the unknown-email path close to the known-email path by doing one
// bcrypt comparison either way. This value contains no credential and is
// generated once at process start with the same work factor as user hashes.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-login-timing-guard', 10);

export interface TokenPayload {
  userId: string;
  email: string;
  jti?: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as any,
  });
}

/** Sign and register a session with the shared auth-state store before returning it. */
export async function generateSessionToken(payload: Omit<TokenPayload, 'jti'>): Promise<string> {
  const sessionId = randomUUID();
  const token = jwt.sign({ ...payload, jti: sessionId }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as any,
  });
  const decoded = jwt.decode(token);
  const expiresAt = decoded && typeof decoded === 'object' ? decoded.exp : undefined;
  if (typeof expiresAt !== 'number') {
    throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Authentication token expiry is invalid');
  }

  try {
    await authStateStore.createSession(sessionId, payload.userId, expiresAt * 1000 - Date.now());
  } catch {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Session storage is temporarily unavailable');
  }
  return token;
}

export function tokenTtlMs(token: string): number {
  const decoded = jwt.decode(token);
  const expiresAt = decoded && typeof decoded === 'object' ? decoded.exp : undefined;
  return typeof expiresAt === 'number' ? Math.max(0, expiresAt * 1000 - Date.now()) : 0;
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication token');
  }
}

export function toUserProfile(user: {
  id: string;
  email: string;
  displayName: string;
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  createdAt: Date;
}): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function registerUser(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ user: UserProfile; token: string }> {
  const normalizedEmail = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    throw new AppError(409, 'BAD_REQUEST', 'An account with this email address already exists');
  }

  const passwordHash = await hashPassword(input.password);

  // Create User, Default Workspace, and OWNER Membership in a single transaction
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        displayName: input.displayName.trim(),
        accountStatus: 'ACTIVE',
      },
    });

    const workspace = await tx.workspace.create({
      data: {
        name: `${user.displayName}'s Workspace`,
        ownerId: user.id,
      },
    });

    await tx.workspaceMembership.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'OWNER',
      },
    });

    return user;
  });

  const profile = toUserProfile(result);
  const token = await generateSessionToken({ userId: profile.id, email: profile.email });

  return { user: profile, token };
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<{ user: UserProfile; token: string }> {
  const normalizedEmail = input.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Generic failure message to prevent email enumeration
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  if (user.accountStatus !== 'ACTIVE') {
    throw new AppError(403, 'FORBIDDEN', `Account is ${user.accountStatus.toLowerCase()}`);
  }

  const profile = toUserProfile(user);
  const token = await generateSessionToken({ userId: profile.id, email: profile.email });

  return { user: profile, token };
}
