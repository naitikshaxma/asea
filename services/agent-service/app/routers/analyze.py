from fastapi import APIRouter
from app.schemas import AnalysisRequest, AnalysisResponse
from app.config import settings

router = APIRouter(prefix="/api/v1", tags=["Analysis"])


@router.post("/analyze", response_model=AnalysisResponse)
def analyze_task(request: AnalysisRequest) -> AnalysisResponse:
    # Phase 1 skeleton returns structural triage and confirms contract boundary
    return AnalysisResponse(
        taskId=request.taskId,
        status="READY_FOR_TRIAGE",
        insights=[
            f"Received task query of length {len(request.query)} characters.",
            f"Task category classified as '{request.taskType}'.",
            "Contract interface verified between API and AI-service.",
            "Local mock analysis active - autonomous LLM reasoning loop scheduled for Phase 2.",
        ],
        confidence=1.0,
        suggestedAction="Queue for execution sandbox verification once Phase 2 worker engine is active.",
        providerUsed=settings.LLM_PROVIDER,
        phaseNote="Phase 1 AI-service skeleton active without external API dependencies.",
    )
