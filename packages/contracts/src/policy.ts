import { z } from 'zod';
import { FindingCategoryEnum, FindingSchema, FindingSeverityEnum, FindingSourceEnum } from './verification.js';

// Policy profile config: how findings turn into a score and verdict. snake_case
// because it is sent to the verification engine. Mirrored by Pydantic models in
// services/agent-service/app/verification/policy.py (kept in sync by the
// contract tests).
//
// Numbers allow at most 4 decimal places so the canonical JSON (and therefore
// the policy hash) is identical in TypeScript and Python.

const hasAtMostFourDecimals = (n: number) => Math.abs(Math.round(n * 10000) - n * 10000) < 1e-6;
const weight = z.number().min(0).max(100).refine(hasAtMostFourDecimals, 'At most 4 decimal places');
const multiplier = z.number().min(0).max(10).refine(hasAtMostFourDecimals, 'At most 4 decimal places');
const score = z.number().int().min(0).max(100);

export const SeverityWeightsSchema = z.object({ critical: weight, high: weight, medium: weight, low: weight });
export const CategoryMultipliersSchema = z.object({
  static: multiplier,
  negative_space: multiplier,
  architecture: multiplier,
  test_gap: multiplier,
});
export const SourceMultipliersSchema = z.object({ deterministic: multiplier, llm: multiplier });
// The score is capped at max_score when at least min_count findings have the severity
export const ScoreCapSchema = z.object({
  id: z.string().min(1),
  severity: FindingSeverityEnum,
  min_count: z.number().int().min(1),
  max_score: score,
});
// Minimum score for each verdict; block must be 0 so every score has a verdict
export const VerdictBandsSchema = z.object({ allow: score, review: score, high_risk: score, block: score });

export const PolicyConfigSchema = z
  .object({
    severity_weights: SeverityWeightsSchema,
    category_multipliers: CategoryMultipliersSchema,
    source_multipliers: SourceMultipliersSchema,
    caps: z.array(ScoreCapSchema),
    verdict_bands: VerdictBandsSchema,
  })
  .superRefine((config, ctx) => {
    const { allow, review, high_risk, block } = config.verdict_bands;
    if (block !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verdict_bands', 'block'], message: 'Must be 0' });
    }
    if (!(allow > review && review > high_risk && high_risk > block)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict_bands'],
        message: 'Thresholds must decrease: allow > review > high_risk > block',
      });
    }
    const ids = config.caps.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['caps'], message: 'Cap ids must be unique' });
    }
  });
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/**
 * Default policy, seeded as each workspace's "default" profile.
 *
 * PLACEHOLDER VALUES: these weights, multipliers, caps and bands are not
 * calibrated. They were chosen only so the demo fixtures land in distinct
 * bands (clean -> allow, no_tests -> review, missing_auth -> high_risk,
 * secret_and_sql -> block) and must be calibrated against real changes.
 */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  severity_weights: { critical: 50, high: 35, medium: 15, low: 5 },
  category_multipliers: { static: 1, negative_space: 1, architecture: 1, test_gap: 1 },
  source_multipliers: { deterministic: 1, llm: 0.5 },
  caps: [
    { id: 'critical_present', severity: 'critical', min_count: 1, max_score: 39 },
    { id: 'two_or_more_high', severity: 'high', min_count: 2, max_score: 59 },
  ],
  verdict_bands: { allow: 90, review: 70, high_risk: 40, block: 0 },
};

export const DEFAULT_POLICY_NAME = 'default';

// Deterministic scoring (POST /api/v1/verify/score on the engine). Every
// finding deducts severity_weight x category_multiplier x source_multiplier
// from 100; caps then limit the score; the verdict is the first band whose
// minimum the score reaches (allow, review, high_risk, block).

export const VerdictEnum = z.enum(['allow', 'review', 'high_risk', 'block']);
export type Verdict = z.infer<typeof VerdictEnum>;

export const ScoreRequestSchema = z.object({
  findings: z.array(FindingSchema),
  policy: PolicyConfigSchema,
  // Agents that did not complete; an incomplete verification is never allowed
  incomplete_agents: z.array(z.string()).default([]),
});
export type ScoreRequest = z.infer<typeof ScoreRequestSchema>;

export const ScoreBreakdownItemSchema = z.object({
  finding_id: z.string().min(1),
  rule_id: z.string().min(1),
  title: z.string(),
  category: FindingCategoryEnum,
  severity: FindingSeverityEnum,
  source: FindingSourceEnum,
  severity_weight: z.number(),
  category_multiplier: z.number(),
  source_multiplier: z.number(),
  // severity_weight x category_multiplier x source_multiplier, rounded to 4 decimals
  deduction: z.number(),
});
export type ScoreBreakdownItem = z.infer<typeof ScoreBreakdownItemSchema>;

// A cap whose condition held (at least min_count findings of the severity);
// lowered_score is false when the score was already at or below max_score
export const CapAppliedSchema = z.object({
  id: z.string().min(1),
  severity: FindingSeverityEnum,
  min_count: z.number().int(),
  count: z.number().int(),
  max_score: z.number().int(),
  lowered_score: z.boolean(),
});
export type CapApplied = z.infer<typeof CapAppliedSchema>;

export const VerdictAdjustmentSchema = z.object({
  reason: z.string(),
  from_verdict: VerdictEnum,
  to_verdict: VerdictEnum,
});
export type VerdictAdjustment = z.infer<typeof VerdictAdjustmentSchema>;

export const ScoreResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: VerdictEnum,
  // 100 minus the total deduction, before clamping to 0-100 and applying caps
  raw_score: z.number(),
  total_deduction: z.number(),
  // sha256 of the policy's canonical JSON (equals PolicyProfile.configHash)
  policy_hash: z.string().length(64),
  // Largest deduction first
  breakdown: z.array(ScoreBreakdownItemSchema),
  caps_applied: z.array(CapAppliedSchema),
  // Verdict changes made after the bands, e.g. allow -> review when agents did not complete
  adjustments: z.array(VerdictAdjustmentSchema).default([]),
});
export type ScoreResult = z.infer<typeof ScoreResultSchema>;
