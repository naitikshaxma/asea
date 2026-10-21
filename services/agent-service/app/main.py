from datetime import datetime, timezone
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import health, analyze, verify
from app.schemas import ApiErrorEnvelope, ApiErrorDetail, ValidationErrorDetail
from app.security import (
    InternalTokenMiddleware,
    RequestSizeLimitMiddleware,
    RequestTooLarge,
    error_response,
)

app = FastAPI(
    title="Autonomous AI Software Engineering Platform - Agent Service",
    description="Python FastAPI service skeleton for AI reasoning and repository intelligence",
    version="0.1.0",
)

# S8: no CORS; only the Node worker calls this service. Settings are read per
# request so tests (and a reloaded config) take effect without a restart.
app.add_middleware(RequestSizeLimitMiddleware, get_limit=lambda: settings.AGENT_MAX_REQUEST_BYTES)
app.add_middleware(InternalTokenMiddleware, get_token=lambda: settings.INTERNAL_SERVICE_TOKEN)


@app.exception_handler(RequestTooLarge)
async def request_too_large_handler(request: Request, exc: RequestTooLarge) -> JSONResponse:
    return error_response(413, "PAYLOAD_TOO_LARGE", str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    details = []
    for error in exc.errors():
        field = ".".join(str(loc) for loc in error.get("loc", []))
        details.append(
            ValidationErrorDetail(
                field=field,
                message=error.get("msg", "Invalid value"),
                code=error.get("type", "validation_error"),
            )
        )

    error_response = ApiErrorEnvelope(
        success=False,
        error=ApiErrorDetail(
            code="VALIDATION_ERROR",
            message="Request validation failed",
            details=details,
            requestId=request.headers.get("x-request-id"),
            timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=error_response.model_dump(),
    )


# Mount routers
app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(verify.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)
