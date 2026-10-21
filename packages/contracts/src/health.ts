import { z } from 'zod';
import { IsoTimestampSchema } from './request.js';

export const HealthStatusEnum = z.enum(['ok', 'degraded', 'error']);
export type HealthStatus = z.infer<typeof HealthStatusEnum>;

export const HealthResponseSchema = z.object({
  status: HealthStatusEnum,
  service: z.string(),
  version: z.string(),
  uptime: z.number().nonnegative(),
  timestamp: IsoTimestampSchema,
  environment: z.string().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DependencyStatusEnum = z.enum(['up', 'down', 'unconfigured', 'degraded']);
export type DependencyStatus = z.infer<typeof DependencyStatusEnum>;

export const DependencyCheckResultSchema = z.object({
  status: DependencyStatusEnum,
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export type DependencyCheckResult = z.infer<typeof DependencyCheckResultSchema>;

export const ReadinessStatusEnum = z.enum(['ready', 'not_ready']);
export type ReadinessStatus = z.infer<typeof ReadinessStatusEnum>;

export const ReadinessResponseSchema = z.object({
  status: ReadinessStatusEnum,
  service: z.string(),
  timestamp: IsoTimestampSchema,
  dependencies: z.record(z.string(), DependencyCheckResultSchema),
});

export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
