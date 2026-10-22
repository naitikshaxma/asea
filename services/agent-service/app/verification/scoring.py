"""Deterministic scoring: findings + policy -> score, verdict and breakdown.

Pure and stateless: the same findings and policy always give the same result.
Each finding deducts severity_weight x category_multiplier x source_multiplier
(rounded to 4 decimals) from 100. The score is the rounded remainder clamped
to 0-100, then lowered by every cap whose condition holds. The verdict is the
first band (allow, review, high_risk, block) whose minimum the score reaches.

If any agent did not complete, an "allow" verdict becomes "review": a
verification that did not run every check is never allowed.

The weights themselves come from the policy; the default policy's values are
placeholders (see DEFAULT_POLICY_CONFIG in packages/contracts/src/policy.ts).
"""

import math
from collections import Counter

from app.verification.contract import Finding
from app.verification.policy import (
    CapApplied,
    PolicyConfig,
    ScoreBreakdownItem,
    ScoreResult,
    Verdict,
    VerdictAdjustment,
    policy_hash,
)

SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
VERDICT_ORDER: tuple[Verdict, ...] = ("allow", "review", "high_risk", "block")


def _round4(value: float) -> float:
    return round(value, 4)


def verdict_for(score: int, policy: PolicyConfig) -> Verdict:
    bands = policy.verdict_bands
    for verdict in VERDICT_ORDER:
        if score >= getattr(bands, verdict):
            return verdict
    return "block"  # unreachable: verdict_bands.block is validated to be 0


def score_findings(findings: list[Finding], policy: PolicyConfig, incomplete_agents: list[str] | None = None) -> ScoreResult:
    breakdown = []
    for finding in findings:
        weight = getattr(policy.severity_weights, finding.severity)
        category_multiplier = getattr(policy.category_multipliers, finding.category)
        source_multiplier = getattr(policy.source_multipliers, finding.source)
        breakdown.append(
            ScoreBreakdownItem(
                finding_id=finding.id,
                rule_id=finding.rule_id,
                title=finding.title,
                category=finding.category,
                severity=finding.severity,
                source=finding.source,
                severity_weight=weight,
                category_multiplier=category_multiplier,
                source_multiplier=source_multiplier,
                deduction=_round4(weight * category_multiplier * source_multiplier),
            )
        )
    breakdown.sort(key=lambda item: (-item.deduction, SEVERITY_RANK[item.severity], item.finding_id))

    total = _round4(sum(item.deduction for item in breakdown))
    raw_score = _round4(100 - total)
    # Half-up rounding (not Python's round-half-to-even), then clamp
    score = max(0, min(100, math.floor(raw_score + 0.5)))

    counts = Counter(finding.severity for finding in findings)
    caps_applied = []
    for cap in policy.caps:
        count = counts.get(cap.severity, 0)
        if count < cap.min_count:
            continue
        lowered = score > cap.max_score
        score = min(score, cap.max_score)
        caps_applied.append(
            CapApplied(
                id=cap.id,
                severity=cap.severity,
                min_count=cap.min_count,
                count=count,
                max_score=cap.max_score,
                lowered_score=lowered,
            )
        )

    verdict = verdict_for(score, policy)
    adjustments = []
    if incomplete_agents and verdict == "allow":
        adjustments.append(
            VerdictAdjustment(
                reason=f"Not every agent completed ({', '.join(sorted(incomplete_agents))}); an incomplete verification is not allowed",
                from_verdict="allow",
                to_verdict="review",
            )
        )
        verdict = "review"

    return ScoreResult(
        score=score,
        verdict=verdict,
        raw_score=raw_score,
        total_deduction=total,
        policy_hash=policy_hash(policy),
        breakdown=breakdown,
        caps_applied=caps_applied,
        adjustments=adjustments,
    )
