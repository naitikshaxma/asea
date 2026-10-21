import { z } from 'zod';

// ASEA verification contract between the Node worker and the Python
// verification engine (services/agent-service). Field names are snake_case
// because this is the JSON wire format. Mirrored by Pydantic models in
// services/agent-service/app/verification/contract.py; the shapes are kept in
// sync through schemas/asea-contract.schema.json (see the contract tests).

export const AuthorTypeEnum = z.enum(['ai', 'human', 'unknown']);
export type AuthorType = z.infer<typeof AuthorTypeEnum>;

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  head_content: z.string(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const VerificationRequestSchema = z.object({
  repository_id: z.string().min(1),
  base_sha: z.string().min(1),
  head_sha: z.string().min(1),
  requirement: z.string(),
  unified_diff: z.string(),
  changed_files: z.array(ChangedFileSchema),
  author_type: AuthorTypeEnum,
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const FindingCategoryEnum = z.enum(['static', 'negative_space', 'architecture', 'test_gap']);
export type FindingCategory = z.infer<typeof FindingCategoryEnum>;

export const FindingSeverityEnum = z.enum(['critical', 'high', 'medium', 'low']);
export type FindingSeverity = z.infer<typeof FindingSeverityEnum>;

export const FindingSourceEnum = z.enum(['deterministic', 'llm']);
export type FindingSource = z.infer<typeof FindingSourceEnum>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  category: FindingCategoryEnum,
  severity: FindingSeverityEnum,
  title: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().min(1),
  evidence: z.array(z.string()),
  source: FindingSourceEnum,
  rule_id: z.string().min(1),
  remediation: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const StaticAnalysisResultSchema = z.object({
  findings: z.array(FindingSchema),
  tools_run: z.array(z.string()),
  tools_unavailable: z.array(z.string()),
  duration_ms: z.number().int().min(0),
});
export type StaticAnalysisResult = z.infer<typeof StaticAnalysisResultSchema>;
