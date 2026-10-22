import { z } from 'zod';
import { IsoTimestampSchema } from './request.js';
import { PolicyConfigSchema } from './policy.js';

// API requests and responses for workspace policy profiles. The config itself
// is the engine's PolicyConfig document (snake_case) and is stored as given.

const PolicyNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(64, 'Name cannot exceed 64 characters')
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Use lowercase letters, digits, "-" and "_"');

export const CreatePolicyProfileRequestSchema = z.object({
  name: PolicyNameSchema,
  description: z.string().max(500).optional(),
  config: PolicyConfigSchema,
  isDefault: z.boolean().optional(),
});
export type CreatePolicyProfileRequest = z.infer<typeof CreatePolicyProfileRequestSchema>;

export const UpdatePolicyProfileRequestSchema = z
  .object({
    name: PolicyNameSchema.optional(),
    description: z.string().max(500).optional(),
    config: PolicyConfigSchema.optional(),
    // Only true is accepted: a workspace always has exactly one default profile
    isDefault: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required');
export type UpdatePolicyProfileRequest = z.infer<typeof UpdatePolicyProfileRequestSchema>;

export const PolicyProfileResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  config: PolicyConfigSchema,
  configHash: z.string(),
  isDefault: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type PolicyProfileResponse = z.infer<typeof PolicyProfileResponseSchema>;

export const PolicyProfileListResponseSchema = z.object({
  policies: z.array(PolicyProfileResponseSchema),
  total: z.number().int(),
});
export type PolicyProfileListResponse = z.infer<typeof PolicyProfileListResponseSchema>;
