"""ASEA verification contract.

Mirrors packages/contracts/src/verification.ts (Zod). The shapes are kept in
sync by tests/test_contract_sync.py, which compares these models' JSON Schema
with packages/contracts/schemas/asea-contract.schema.json (generated from Zod).
"""

from typing import Literal

from pydantic import BaseModel, Field

AuthorType = Literal["ai", "human", "unknown"]
FindingCategory = Literal["static", "negative_space", "architecture", "test_gap"]
FindingSeverity = Literal["critical", "high", "medium", "low"]
FindingSource = Literal["deterministic", "llm"]


class ChangedFile(BaseModel):
    path: str = Field(min_length=1)
    head_content: str


class VerificationRequest(BaseModel):
    repository_id: str = Field(min_length=1)
    base_sha: str = Field(min_length=1)
    head_sha: str = Field(min_length=1)
    requirement: str
    unified_diff: str
    changed_files: list[ChangedFile]
    author_type: AuthorType


class Finding(BaseModel):
    id: str = Field(min_length=1)
    category: FindingCategory
    severity: FindingSeverity
    title: str = Field(min_length=1)
    file: str = Field(min_length=1)
    line: int = Field(ge=1)
    evidence: list[str]
    source: FindingSource
    rule_id: str = Field(min_length=1)
    remediation: str


class StaticAnalysisResult(BaseModel):
    findings: list[Finding]
    tools_run: list[str]
    tools_unavailable: list[str]
    duration_ms: int = Field(ge=0)
    # sha256 of the pinned Semgrep ruleset Semgrep ran with; null when it did not run
    semgrep_ruleset_sha256: str | None
