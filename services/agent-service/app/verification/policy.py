"""Policy profile config: how findings turn into a score and verdict.

Mirrors packages/contracts/src/policy.ts (Zod); kept in sync by
tests/test_contract_sync.py. Numbers allow at most 4 decimal places so the
canonical JSON, and therefore policy_hash(), match the TypeScript side.
"""

import hashlib
import json
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator

from app.verification.contract import Finding, FindingCategory, FindingSeverity, FindingSource


def _at_most_four_decimals(value: float) -> float:
    if abs(round(value * 10000) - value * 10000) >= 1e-6:
        raise ValueError("at most 4 decimal places")
    return value


Weight = Annotated[float, Field(ge=0, le=100), AfterValidator(_at_most_four_decimals)]
Multiplier = Annotated[float, Field(ge=0, le=10), AfterValidator(_at_most_four_decimals)]
Score = Annotated[int, Field(ge=0, le=100)]


class SeverityWeights(BaseModel):
    critical: Weight
    high: Weight
    medium: Weight
    low: Weight


class CategoryMultipliers(BaseModel):
    static: Multiplier
    negative_space: Multiplier
    architecture: Multiplier
    test_gap: Multiplier


class SourceMultipliers(BaseModel):
    deterministic: Multiplier
    llm: Multiplier


class ScoreCap(BaseModel):
    """The score is capped at max_score when at least min_count findings have the severity."""

    id: str = Field(min_length=1)
    severity: FindingSeverity
    min_count: int = Field(ge=1)
    max_score: Score


class VerdictBands(BaseModel):
    """Minimum score for each verdict; block must be 0 so every score has a verdict."""

    allow: Score
    review: Score
    high_risk: Score
    block: Score


class PolicyConfig(BaseModel):
    severity_weights: SeverityWeights
    category_multipliers: CategoryMultipliers
    source_multipliers: SourceMultipliers
    caps: list[ScoreCap]
    verdict_bands: VerdictBands

    @model_validator(mode="after")
    def _check_bands_and_caps(self) -> "PolicyConfig":
        bands = self.verdict_bands
        if bands.block != 0:
            raise ValueError("verdict_bands.block must be 0")
        if not (bands.allow > bands.review > bands.high_risk > bands.block):
            raise ValueError("verdict_bands thresholds must decrease: allow > review > high_risk > block")
        ids = [cap.id for cap in self.caps]
        if len(set(ids)) != len(ids):
            raise ValueError("cap ids must be unique")
        return self


Verdict = Literal["allow", "review", "high_risk", "block"]


class ScoreRequest(BaseModel):
    findings: list[Finding]
    policy: PolicyConfig


class ScoreBreakdownItem(BaseModel):
    finding_id: str = Field(min_length=1)
    rule_id: str = Field(min_length=1)
    title: str
    category: FindingCategory
    severity: FindingSeverity
    source: FindingSource
    severity_weight: float
    category_multiplier: float
    source_multiplier: float
    # severity_weight x category_multiplier x source_multiplier, rounded to 4 decimals
    deduction: float


class CapApplied(BaseModel):
    """A cap whose condition held; lowered_score is false when the score was already at or below max_score."""

    id: str = Field(min_length=1)
    severity: FindingSeverity
    min_count: int
    count: int
    max_score: int
    lowered_score: bool


class ScoreResult(BaseModel):
    score: int = Field(ge=0, le=100)
    verdict: Verdict
    # 100 minus the total deduction, before clamping to 0-100 and applying caps
    raw_score: float
    total_deduction: float
    # sha256 of the policy's canonical JSON (equals PolicyProfile.configHash)
    policy_hash: str = Field(min_length=64, max_length=64)
    # Largest deduction first
    breakdown: list[ScoreBreakdownItem]
    caps_applied: list[CapApplied]


def _normalize(value: Any) -> Any:
    # 50.0 and 50 must hash alike (JavaScript writes both as 50)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def canonical_policy_json(config: PolicyConfig) -> str:
    return json.dumps(_normalize(config.model_dump(mode="json")), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def policy_hash(config: PolicyConfig) -> str:
    """sha256 of the policy's canonical JSON; equals the API's PolicyProfile.configHash."""
    return hashlib.sha256(canonical_policy_json(config).encode("utf-8")).hexdigest()
