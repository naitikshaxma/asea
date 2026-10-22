"""Contract of the verification pipeline and the repository index.

Mirrors packages/contracts/src/pipeline.ts (Zod); kept in sync by
tests/test_contract_sync.py like the rest of the ASEA contract.
"""

from typing import Literal

from pydantic import BaseModel, Field

from app.verification.contract import Finding, VerificationRequest
from app.verification.policy import PolicyConfig, ScoreResult

# Pipeline nodes, in order: ingest -> static -> (negative_space || architecture) -> score -> report
AgentName = Literal["ingest", "static", "negative_space", "architecture", "score", "report"]
AgentStatus = Literal["completed", "failed", "skipped"]


class PipelineRequest(BaseModel):
    request: VerificationRequest
    policy: PolicyConfig


class AgentRun(BaseModel):
    name: AgentName
    status: AgentStatus
    started_at: str
    finished_at: str
    duration_ms: int = Field(ge=0)
    # Tries made (an agent is retried after a failure or timeout)
    attempts: int = Field(ge=0)
    finding_count: int = Field(ge=0)
    detail: str | None
    error: str | None


class FindingExplanation(BaseModel):
    finding_id: str = Field(min_length=1)
    explanation: str
    suggested_fix: str


class Report(BaseModel):
    """The reporter's explanation of the findings; it never adds findings."""

    summary: str
    explanations: list[FindingExplanation]
    # fallback: the reporter failed and the text was built from the findings themselves
    generated_by: Literal["llm", "fallback"]


class StaticSummary(BaseModel):
    tools_run: list[str]
    tools_unavailable: list[str]
    duration_ms: int = Field(ge=0)
    semgrep_ruleset_sha256: str | None
    finding_count: int = Field(ge=0)


class LLMInfo(BaseModel):
    provider: str
    model: str


class PipelineResult(BaseModel):
    # Deterministic findings plus the agents' findings (an agent finding on a
    # line that already has a deterministic finding is folded into it)
    findings: list[Finding]
    static: StaticSummary
    score: ScoreResult
    report: Report
    agents: list[AgentRun]
    llm: LLMInfo
    # False when negative_space or architecture did not complete
    complete: bool


class AgentStartedEvent(BaseModel):
    type: Literal["agent_started"]
    agent: AgentName
    at: str


class AgentFinishedEvent(BaseModel):
    type: Literal["agent_finished"]
    run: AgentRun


class ResultEvent(BaseModel):
    type: Literal["result"]
    result: PipelineResult


class ErrorEvent(BaseModel):
    type: Literal["error"]
    code: str
    message: str


class IndexFile(BaseModel):
    path: str = Field(min_length=1)
    content: str


class IndexRequest(BaseModel):
    repository_id: str = Field(min_length=1)
    commit_sha: str = Field(min_length=1)
    files: list[IndexFile]
    # The last batch for this commit; the index is marked usable (and cached) only then
    complete: bool


class IndexResponse(BaseModel):
    repository_id: str
    commit_sha: str
    indexed_files: int = Field(ge=0)
    symbols: int = Field(ge=0)
    # True when this commit was already indexed and nothing was done
    cached: bool
    complete: bool


class IndexStatus(BaseModel):
    repository_id: str
    commit_sha: str
    indexed: bool
    symbols: int = Field(ge=0)
