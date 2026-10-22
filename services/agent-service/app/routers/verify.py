from datetime import datetime, timezone

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from app.config import settings
from app.schemas import ApiErrorDetail, ApiErrorEnvelope
from app.verification.contract import StaticAnalysisResult, VerificationRequest
from app.verification.policy import ScoreRequest, ScoreResult
from app.verification.scoring import score_findings
from app.verification.static_analysis import InvalidVerificationInput, run_static_analysis

router = APIRouter(prefix="/api/v1/verify", tags=["Verification"])


@router.post("/static", response_model=StaticAnalysisResult)
def verify_static(body: VerificationRequest, request: Request):
    try:
        return run_static_analysis(
            body,
            auth_decorators={d.strip() for d in settings.ASEA_AUTH_DECORATORS.split(",") if d.strip()},
            semgrep_command=settings.SEMGREP_COMMAND,
            semgrep_ruleset=settings.SEMGREP_RULESET,
            semgrep_rules_lock=settings.SEMGREP_RULES_LOCK,
            semgrep_timeout_seconds=settings.SEMGREP_TIMEOUT_SECONDS,
        )
    except InvalidVerificationInput as exc:
        envelope = ApiErrorEnvelope(
            success=False,
            error=ApiErrorDetail(
                code="INVALID_VERIFICATION_INPUT",
                message=str(exc),
                requestId=request.headers.get("x-request-id"),
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
        )
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=envelope.model_dump())


@router.post("/score", response_model=ScoreResult)
def verify_score(body: ScoreRequest):
    """Deterministic score, verdict and per-finding breakdown for findings under a policy."""
    return score_findings(body.findings, body.policy, body.incomplete_agents)
