import { z } from 'zod';
import { IsoTimestampSchema } from './request.js';
import { PolicyConfigSchema } from './policy.js';

// API responses for persisted ASEA verification runs. Enum values are the
// database's (uppercase), like the rest of the API; the engine wire contract
// (snake_case, lowercase enums) is in verification.ts.

export const VerdictResponseEnum = z.enum(['ALLOW', 'REVIEW', 'HIGH_RISK', 'BLOCK']);
export type VerdictResponse = z.infer<typeof VerdictResponseEnum>;

// The pull request that triggered a run, and whether its result reached the PR
export const GithubRunInfoSchema = z.object({
  repository: z.string(),
  pullNumber: z.number().int(),
  pullUrl: z.string().nullable(),
  // Branch names on GitHub; the worker fetches them if the commits are not in the checkout
  baseRef: z.string(),
  headRef: z.string(),
  deliveryId: z.string(),
  comment: z
    .object({
      status: z.enum(['POSTED', 'FAILED', 'SKIPPED']),
      url: z.string().nullable(),
      error: z.string().nullable(),
      at: z.string(),
    })
    .nullable(),
});
export type GithubRunInfo = z.infer<typeof GithubRunInfoSchema>;

export const VerificationRunResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  repositoryId: z.string(),
  taskId: z.string().optional(),
  baseSha: z.string(),
  headSha: z.string(),
  requirement: z.string(),
  authorType: z.enum(['AI', 'HUMAN', 'UNKNOWN']),
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  score: z.number().nullable(),
  verdict: VerdictResponseEnum.nullable(),
  // The policy profile the run was scored with and the hash of its config at
  // submission time (the run keeps that snapshot even if the profile changes)
  policyProfileId: z.string().nullable(),
  policyHash: z.string().nullable(),
  github: GithubRunInfoSchema.nullable(),
  findingCount: z.number().int(),
  startedAt: IsoTimestampSchema.optional(),
  completedAt: IsoTimestampSchema.optional(),
  createdAt: IsoTimestampSchema,
});
export type VerificationRunResponse = z.infer<typeof VerificationRunResponseSchema>;

// "Why this score": the engine's ScoreResult (policy.ts) in API casing
export const ScoreBreakdownResponseSchema = z.object({
  score: z.number().int(),
  verdict: VerdictResponseEnum,
  rawScore: z.number(),
  totalDeduction: z.number(),
  policyHash: z.string(),
  items: z.array(
    z.object({
      findingId: z.string(),
      ruleId: z.string(),
      title: z.string(),
      category: z.enum(['STATIC', 'NEGATIVE_SPACE', 'ARCHITECTURE', 'TEST_GAP']),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      source: z.enum(['DETERMINISTIC', 'LLM']),
      severityWeight: z.number(),
      categoryMultiplier: z.number(),
      sourceMultiplier: z.number(),
      deduction: z.number(),
    })
  ),
  capsApplied: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      minCount: z.number().int(),
      count: z.number().int(),
      maxScore: z.number().int(),
      loweredScore: z.boolean(),
    })
  ),
});
export type ScoreBreakdownResponse = z.infer<typeof ScoreBreakdownResponseSchema>;

// One pipeline agent's progress; "running" only while the run executes
export const AgentTimelineEntrySchema = z.object({
  name: z.enum(['ingest', 'static', 'negative_space', 'architecture', 'score', 'report']),
  status: z.enum(['running', 'completed', 'failed', 'skipped']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  attempts: z.number().int(),
  findingCount: z.number().int(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentTimelineEntry = z.infer<typeof AgentTimelineEntrySchema>;

// The reporter's text; it explains findings and never adds any
export const RunReportSchema = z.object({
  summary: z.string(),
  generatedBy: z.enum(['llm', 'fallback']),
  explanations: z.array(z.object({ findingId: z.string(), explanation: z.string(), suggestedFix: z.string() })),
});
export type RunReport = z.infer<typeof RunReportSchema>;

export const EngineInfoSchema = z.object({
  llmProvider: z.string(),
  llmModel: z.string(),
  // False when the negative-space or architecture agent did not complete
  complete: z.boolean(),
  toolsRun: z.array(z.string()),
  toolsUnavailable: z.array(z.string()),
  semgrepRulesetSha256: z.string().nullable(),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

export const VerificationRunDetailResponseSchema = VerificationRunResponseSchema.extend({
  // null until the run has been scored
  scoreBreakdown: ScoreBreakdownResponseSchema.nullable(),
  policySnapshot: PolicyConfigSchema.nullable(),
  agentTimeline: z.array(AgentTimelineEntrySchema),
  report: RunReportSchema.nullable(),
  engine: EngineInfoSchema.nullable(),
});
export type VerificationRunDetailResponse = z.infer<typeof VerificationRunDetailResponseSchema>;

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
  // True only when no check below failed
  valid: z.boolean(),
  length: z.number().int(),
  headHash: z.string().nullable().optional(),
  // Hash links and recomputed hashes of every event
  chain: z.object({
    valid: z.boolean(),
    brokenEventId: z.string().optional(),
    reason: z.string().optional(),
  }),
  // Terminal runs must end with a RUN_SEALED event matching the head hash and
  // event count stored on the run; valid is null while the run is in progress
  seal: z.object({
    required: z.boolean(),
    valid: z.boolean().nullable(),
    reason: z.string().optional(),
  }),
  // Whether the stored findings match the digest recorded when static analysis
  // completed; null until then
  findingsDigestValid: z.boolean().nullable(),
  // Whether the stored score, verdict and breakdown match the SCORE_COMPUTED
  // event; null until the run has been scored
  scoreValid: z.boolean().nullable(),
  // Whether the stored report matches the REPORT_GENERATED event; null until then
  reportValid: z.boolean().nullable(),
});
export type AuditChainVerificationResponse = z.infer<typeof AuditChainVerificationResponseSchema>;
