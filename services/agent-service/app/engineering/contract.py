from pydantic import BaseModel, ConfigDict, Field


class PatchContextFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(max_length=80_000)


class PatchProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=128)
    requirement: str = Field(min_length=5, max_length=5_000)
    files: list[PatchContextFile] = Field(min_length=1, max_length=24)
    repair_feedback: str | None = Field(default=None, max_length=2_000)


class PatchProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=1_000)
    plan: list[str] = Field(min_length=1, max_length=12)
    evidence: list[str] = Field(min_length=1, max_length=24)
    unified_diff: str = Field(min_length=1, max_length=2_000_000)


class PatchReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=128)
    requirement: str = Field(min_length=5, max_length=5_000)
    files: list[PatchContextFile] = Field(min_length=1, max_length=24)
    summary: str = Field(min_length=1, max_length=1_000)
    plan: list[str] = Field(min_length=1, max_length=12)
    evidence: list[str] = Field(min_length=1, max_length=24)
    unified_diff: str = Field(min_length=1, max_length=2_000_000)


class PatchReviewFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    severity: str = Field(min_length=1, max_length=24)
    path: str | None = Field(default=None, max_length=1_024)
    line: int | None = Field(default=None, ge=1)
    message: str = Field(min_length=1, max_length=500)
    evidence: str = Field(min_length=1, max_length=1_000)


class PatchReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: str = Field(pattern="^(APPROVE|REQUEST_CHANGES)$")
    summary: str = Field(min_length=1, max_length=1_000)
    findings: list[PatchReviewFinding] = Field(max_length=100)
