from datetime import datetime, timezone
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import health, analyze
from app.schemas import ApiErrorEnvelope, ApiErrorDetail, ValidationErrorDetail

app = FastAPI(
    title="Autonomous AI Software Engineering Platform - Agent Service",
    description="Python FastAPI service skeleton for AI reasoning and repository intelligence",
    version="0.1.0",
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)
