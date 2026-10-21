import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const UserRoleEnum = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export type UserRole = z.infer<typeof UserRoleEnum>;

export const AccountStatusEnum = z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);
export type AccountStatus = z.infer<typeof AccountStatusEnum>;

export const UserProfileSchema = z.object({
  id: RequestIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1),
  accountStatus: AccountStatusEnum,
  createdAt: IsoTimestampSchema,
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const RegisterRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long'),
  displayName: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(100, 'Display name too long')
    .trim(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .toLowerCase()
    .trim(),
  password: z.string().min(1, 'Password is required'),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  user: UserProfileSchema,
  token: z.string().optional(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
