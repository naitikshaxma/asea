import { z } from 'zod';
import { FindingSchema, VerificationRequestSchema } from './verification.js';
import { PolicyConfigSchema, ScoreResultSchema } from './policy.js';

// Contract of the engine's verification pipeline (POST /api/v1/verify) and its
// repository index (/api/v1/index). snake_case wire format; mirrored by
// services/agent-service/app/pipeline/contract.py and kept in sync through
// schemas/asea-contract.schema.json.
//
// Pipeline: ingest -> static -> (negative_space || architecture) -> score -> report

export const AgentNameEnum = z.enum(['ingest', 'static', 'negative_space', 'architecture', 'score', 'report']);
export type AgentName = z.infer<typeof AgentNameEnum>;

export const AgentStatusEnum = z.enum(['completed', 'failed', 'skipped']);
export type AgentStatus = z.infer<typeof AgentStatusEnum>;

export const PipelineRequestSchema = z.object({
  request: VerificationRequestSchema,
  policy: PolicyConfigSchema,
});
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;

export const AgentRunSchema = z.object({
  name: AgentNameEnum,
  status: AgentStatusEnum,
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().int().min(0),
  // Tries made (an agent is retried after a failure or timeout)
  attempts: z.number().int().min(0),
  finding_count: z.number().int().min(0),
  detail: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const FindingExplanationSchema = z.object({
  finding_id: z.string().min(1),
  explanation: z.string(),
  suggested_fix: z.string(),
});
export type FindingExplanation = z.infer<typeof FindingExplanationSchema>;

// The reporter's explanation of the findings; it never adds findings
export const ReportSchema = z.object({
  summary: z.string(),
  explanations: z.array(FindingExplanationSchema),
  // fallback: the reporter failed and the text was built from the findings themselves
  generated_by: z.enum(['llm', 'fallback']),
});
export type Report = z.infer<typeof ReportSchema>;

export const StaticSummarySchema = z.object({
  tools_run: z.array(z.string()),
  tools_unavailable: z.array(z.string()),
  duration_ms: z.number().int().min(0),
  semgrep_ruleset_sha256: z.string().nullable(),
  finding_count: z.number().int().min(0),
});
export type StaticSummary = z.infer<typeof StaticSummarySchema>;

export const LLMInfoSchema = z.object({ provider: z.string(), model: z.string() });
export type LLMInfo = z.infer<typeof LLMInfoSchema>;

export const PipelineResultSchema = z.object({
  // Deterministic findings plus the agents' findings (an agent finding on a
  // line that already has a deterministic finding is folded into it)
  findings: z.array(FindingSchema),
  static: StaticSummarySchema,
  score: ScoreResultSchema,
  report: ReportSchema,
  agents: z.array(AgentRunSchema),
  llm: LLMInfoSchema,
  // False when negative_space or architecture did not complete
  complete: z.boolean(),
});
export type PipelineResult = z.infer<typeof PipelineResultSchema>;

// NDJSON events streamed by POST /api/v1/verify (Accept: application/x-ndjson)
export const AgentStartedEventSchema = z.object({ type: z.literal('agent_started'), agent: AgentNameEnum, at: z.string() });
export const AgentFinishedEventSchema = z.object({ type: z.literal('agent_finished'), run: AgentRunSchema });
export const ResultEventSchema = z.object({ type: z.literal('result'), result: PipelineResultSchema });
export const ErrorEventSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string() });
export const PipelineEventSchema = z.discriminatedUnion('type', [
  AgentStartedEventSchema,
  AgentFinishedEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
]);
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

export const IndexFileSchema = z.object({ path: z.string().min(1), content: z.string() });
export type IndexFile = z.infer<typeof IndexFileSchema>;

export const IndexRequestSchema = z.object({
  repository_id: z.string().min(1),
  commit_sha: z.string().min(1),
  files: z.array(IndexFileSchema),
  // The last batch for this commit; the index is marked usable (and cached) only then
  complete: z.boolean(),
});
export type IndexRequest = z.infer<typeof IndexRequestSchema>;

export const IndexResponseSchema = z.object({
  repository_id: z.string(),
  commit_sha: z.string(),
  indexed_files: z.number().int().min(0),
  symbols: z.number().int().min(0),
  // True when this commit was already indexed and nothing was done
  cached: z.boolean(),
  complete: z.boolean(),
});
export type IndexResponse = z.infer<typeof IndexResponseSchema>;

export const IndexStatusSchema = z.object({
  repository_id: z.string(),
  commit_sha: z.string(),
  indexed: z.boolean(),
  symbols: z.number().int().min(0),
});
export type IndexStatus = z.infer<typeof IndexStatusSchema>;
