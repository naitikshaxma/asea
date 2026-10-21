from typing import Optional, Dict, List, Literal
from pydantic import BaseModel, Field


class DependencyCheckResult(BaseModel):
    status: Literal["up", "down", "unconfigured", "degraded"]
    latencyMs: Optional[float] = None
    message: Optional[str] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded", "error"]
    service: str
    version: str
    uptime: float
    timestamp: str
    environment: Optional[str] = None


class ReadinessResponse(BaseModel):
    status: Literal["ready", "not_ready"]
    service: str
    timestamp: str
    dependencies: Dict[str, DependencyCheckResult]


class AnalysisRequest(BaseModel):
    taskId: str = Field(..., min_length=1, max_length=128)
    taskType: Literal[
        "BUG_INVESTIGATION",
        "CODE_PATCH",
        "TEST_GENERATION",
        "CODE_REVIEW",
        "CI_DIAGNOSIS",
    ] = "BUG_INVESTIGATION"
    query: str = Field(..., min_length=5, max_length=5000)
    repositoryUrl: Optional[str] = None
    targetBranch: str = "main"


class AnalysisResponse(BaseModel):
    taskId: str
    status: Literal["READY_FOR_TRIAGE", "IN_ANALYSIS", "COMPLETED", "FAILED"]
    insights: List[str]
    confidence: float
    suggestedAction: str
    providerUsed: str
    phaseNote: str


class ValidationErrorDetail(BaseModel):
    field: str
    message: str
    code: Optional[str] = None


class ApiErrorDetail(BaseModel):
    code: str
    message: str
    details: Optional[List[ValidationErrorDetail]] = None
    requestId: Optional[str] = None
    timestamp: str


class ApiErrorEnvelope(BaseModel):
    success: Literal[False] = False
    error: ApiErrorDetail
