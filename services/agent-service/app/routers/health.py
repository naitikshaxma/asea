import time
from datetime import datetime, timezone
from fastapi import APIRouter
from app.schemas import HealthResponse, ReadinessResponse, DependencyCheckResult
from app.config import settings
from app.llm.provider import LLMError, create_provider
from app.rag.index import get_index

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


def _llm_check() -> DependencyCheckResult:
    start = time.time()
    try:
        provider = create_provider(settings.LLM_PROVIDER, settings.LLM_API_KEY, settings.MODEL_NAME, settings.LLM_EFFORT)
    except LLMError as exc:
        return DependencyCheckResult(status="unconfigured", message=f"{exc}; the LLM agents are skipped")
    note = " (deterministic stand-in, no model is called)" if provider.name == "fake" else ""
    return DependencyCheckResult(
        status="up",
        latencyMs=round((time.time() - start) * 1000, 2),
        message=f"LLM provider '{provider.name}', model '{provider.model}'{note}",
    )


def _index_check() -> DependencyCheckResult:
    start = time.time()
    try:
        get_index(settings.QDRANT_URL, settings.QDRANT_API_KEY).client.get_collections()
    except Exception as exc:  # report, don't fail readiness: only the architecture agent needs it
        return DependencyCheckResult(status="down", message=f"Qdrant unreachable: {type(exc).__name__}")
    where = settings.QDRANT_URL or "in-memory"
    return DependencyCheckResult(status="up", latencyMs=round((time.time() - start) * 1000, 2), message=f"Qdrant ({where})")


@router.get("/ready", response_model=ReadinessResponse)
def get_readiness() -> ReadinessResponse:
    dependencies = {
        "llm_provider": _llm_check(),
        "code_index": _index_check(),
    }

    return ReadinessResponse(
        status="ready",
        service="@autonomous-engineer/agent-service",
        timestamp=datetime.now(timezone.utc).isoformat(),
        dependencies=dependencies,
    )
