from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.schemas import AnalysisRequest, ApiErrorDetail, ApiErrorEnvelope

router = APIRouter(prefix="/api/v1", tags=["Analysis"])


@router.post("/analyze")
def analyze_task(_body: AnalysisRequest, request: Request) -> JSONResponse:
    """Keep the retired triage route explicit instead of returning mock findings."""
    envelope = ApiErrorEnvelope(
        success=False,
        error=ApiErrorDetail(
            code="NOT_IMPLEMENTED",
            message="Natural-language task analysis is not implemented; use the verification workflow for change review.",
            requestId=request.headers.get("x-request-id"),
            timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )
    return JSONResponse(status_code=501, content=envelope.model_dump())
