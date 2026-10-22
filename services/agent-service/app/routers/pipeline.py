"""POST /api/v1/verify runs the whole pipeline; /api/v1/index builds the repository index.

/verify answers with the PipelineResult as JSON, or, when the request accepts
application/x-ndjson, streams one JSON event per line (agent_started,
agent_finished, then result or error) so the caller can show live progress.
"""

import json
import logging
import queue
import threading
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.config import settings
from app.llm.provider import LLMError, create_provider
from app.pipeline.contract import IndexRequest, IndexResponse, IndexStatus, PipelineRequest, PipelineResult
from app.pipeline.graph import PipelineDeps, run_pipeline
from app.rag.index import get_index
from app.schemas import ApiErrorDetail, ApiErrorEnvelope
from app.verification.static_analysis import InvalidVerificationInput

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["Pipeline"])
NDJSON = "application/x-ndjson"


def pipeline_deps(emit: Callable[[dict[str, Any]], None]) -> PipelineDeps:
    try:
        provider, provider_error = (
            create_provider(settings.LLM_PROVIDER, settings.LLM_API_KEY, settings.MODEL_NAME, settings.LLM_EFFORT),
            None,
        )
    except LLMError as exc:
        provider, provider_error = None, str(exc)
    return PipelineDeps(
        provider=provider,
        provider_error=provider_error,
        index=get_index(settings.QDRANT_URL, settings.QDRANT_API_KEY),
        auth_decorators={d.strip() for d in settings.ASEA_AUTH_DECORATORS.split(",") if d.strip()},
        semgrep={
            "semgrep_command": settings.SEMGREP_COMMAND,
            "semgrep_ruleset": settings.SEMGREP_RULESET,
            "semgrep_rules_lock": settings.SEMGREP_RULES_LOCK,
            "semgrep_timeout_seconds": settings.SEMGREP_TIMEOUT_SECONDS,
        },
        agent_timeout_s=settings.AGENT_TIMEOUT_SECONDS,
        agent_max_attempts=max(1, settings.AGENT_MAX_ATTEMPTS),
        llm_timeout_s=settings.LLM_TIMEOUT_SECONDS,
        emit=emit,
    )


def _error(code: str, message: str, request: Request) -> JSONResponse:
    envelope = ApiErrorEnvelope(
        success=False,
        error=ApiErrorDetail(
            code=code,
            message=message,
            requestId=request.headers.get("x-request-id"),
            timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=envelope.model_dump())


def _stream(body: PipelineRequest) -> Iterator[str]:
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def work() -> None:
        try:
            result = run_pipeline(body, pipeline_deps(events.put))
            events.put({"type": "result", "result": result.model_dump()})
        except InvalidVerificationInput as exc:
            events.put({"type": "error", "code": "INVALID_VERIFICATION_INPUT", "message": str(exc)})
        except Exception as exc:
            logger.exception("Verification pipeline failed")
            events.put({"type": "error", "code": "PIPELINE_FAILED", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            events.put(None)

    threading.Thread(target=work, name="asea-pipeline", daemon=True).start()
    while (event := events.get()) is not None:
        yield json.dumps(event) + "\n"


@router.post("/verify", response_model=PipelineResult)
def verify(body: PipelineRequest, request: Request):
    if NDJSON in request.headers.get("accept", ""):
        return StreamingResponse(_stream(body), media_type=NDJSON)
    try:
        return run_pipeline(body, pipeline_deps(lambda _event: None))
    except InvalidVerificationInput as exc:
        return _error("INVALID_VERIFICATION_INPUT", str(exc), request)


@router.post("/index", response_model=IndexResponse)
def index_repository(body: IndexRequest, request: Request):
    try:
        return get_index(settings.QDRANT_URL, settings.QDRANT_API_KEY).index(body)
    except InvalidVerificationInput as exc:
        return _error("INVALID_INDEX_INPUT", str(exc), request)


@router.get("/index/{repository_id}/{commit_sha}", response_model=IndexStatus)
def index_status(repository_id: str, commit_sha: str):
    return get_index(settings.QDRANT_URL, settings.QDRANT_API_KEY).status(repository_id, commit_sha)
