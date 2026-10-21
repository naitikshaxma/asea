import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { UserProfile } from '@autonomous-engineer/contracts';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import { AppError } from '../middlewares/errorHandler.js';

export interface TokenPayload {
  userId: string;
  email: string;
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
  const token = generateToken({ userId: profile.id, email: profile.email });

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
  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  if (user.accountStatus !== 'ACTIVE') {
    throw new AppError(403, 'FORBIDDEN', `Account is ${user.accountStatus.toLowerCase()}`);
  }

  const profile = toUserProfile(user);
  const token = generateToken({ userId: profile.id, email: profile.email });

  return { user: profile, token };
}
