import time
from datetime import datetime, timezone
from fastapi import APIRouter
from app.schemas import HealthResponse, ReadinessResponse, DependencyCheckResult
from app.config import settings

router = APIRouter(tags=["Health"])

START_TIME = time.time()


@router.get("/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    uptime = time.time() - START_TIME
    return HealthResponse(
        status="ok",
        service="@autonomous-engineer/agent-service",
        version="0.1.0",
        uptime=round(uptime, 2),
        timestamp=datetime.now(timezone.utc).isoformat(),
        environment=settings.ENVIRONMENT,
    )


@router.get("/ready", response_model=ReadinessResponse)
def get_readiness() -> ReadinessResponse:
    start_check = time.time()
    # In Phase 1 skeleton, LLM provider operates in local_mock mode without paid API key
    llm_check = DependencyCheckResult(
        status="up",
        latencyMs=round((time.time() - start_check) * 1000, 2),
        message=f"Model provider '{settings.LLM_PROVIDER}' initialized. Real agent execution planned for Phase 2.",
    )

    dependencies = {
        "llm_provider": llm_check,
    }

    return ReadinessResponse(
        status="ready",
        service="@autonomous-engineer/agent-service",
        timestamp=datetime.now(timezone.utc).isoformat(),
        dependencies=dependencies,
    )
