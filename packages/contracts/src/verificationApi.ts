import { z } from 'zod';
import { IsoTimestampSchema } from './request.js';

// API responses for persisted ASEA verification runs. Enum values are the
// database's (uppercase), like the rest of the API; the engine wire contract
// (snake_case, lowercase enums) is in verification.ts.

export const VerificationRunResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  repositoryId: z.string(),
  taskId: z.string().optional(),
  baseSha: z.string(),
  headSha: z.string(),
  requirement: z.string(),
  authorType: z.enum(['AI', 'HUMAN', 'UNKNOWN']),
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  score: z.number().nullable(),
  verdict: z.string().nullable(),
  findingCount: z.number().int(),
  startedAt: IsoTimestampSchema.optional(),
  completedAt: IsoTimestampSchema.optional(),
  createdAt: IsoTimestampSchema,
});
export type VerificationRunResponse = z.infer<typeof VerificationRunResponseSchema>;

export const VerificationRunListResponseSchema = z.object({
  verificationRuns: z.array(VerificationRunResponseSchema),
});
export type VerificationRunListResponse = z.infer<typeof VerificationRunListResponseSchema>;

export const VerificationFindingResponseSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  category: z.enum(['STATIC', 'NEGATIVE_SPACE', 'ARCHITECTURE', 'TEST_GAP']),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  title: z.string(),
  file: z.string(),
  line: z.number().int(),
  evidence: z.array(z.string()),
  source: z.enum(['DETERMINISTIC', 'LLM']),
  ruleId: z.string(),
  remediation: z.string(),
});
export type VerificationFindingResponse = z.infer<typeof VerificationFindingResponseSchema>;

export const VerificationFindingListResponseSchema = z.object({
  verificationRunId: z.string(),
  findings: z.array(VerificationFindingResponseSchema),
  total: z.number().int(),
});
export type VerificationFindingListResponse = z.infer<typeof VerificationFindingListResponseSchema>;

export const AuditChainVerificationResponseSchema = z.object({
  verificationRunId: z.string(),
  valid: z.boolean(),
  length: z.number().int(),
  headHash: z.string().nullable().optional(),
  brokenEventId: z.string().optional(),
  reason: z.string().optional(),
  // Whether the stored findings match the digest recorded when static analysis
  // completed; null until then
  findingsDigestValid: z.boolean().nullable(),
});
export type AuditChainVerificationResponse = z.infer<typeof AuditChainVerificationResponseSchema>;
