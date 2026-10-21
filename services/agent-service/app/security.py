"""Service-to-service hardening (ASEA_AUDIT.md S8).

The agent service is called only by the Node worker, never by browsers, so it
has no CORS. Every /api/v1/* request must carry the shared X-Internal-Token,
and request bodies are size-limited.
"""

import hmac
from collections.abc import Callable
from datetime import datetime, timezone

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.schemas import ApiErrorDetail, ApiErrorEnvelope

PROTECTED_PREFIX = "/api/v1/"
TOKEN_HEADER = b"x-internal-token"


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    envelope = ApiErrorEnvelope(
        success=False,
        error=ApiErrorDetail(code=code, message=message, timestamp=datetime.now(timezone.utc).isoformat()),
    )
    return JSONResponse(status_code=status_code, content=envelope.model_dump())


def _header(scope: Scope, name: bytes) -> bytes | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value
    return None


class InternalTokenMiddleware:
    def __init__(self, app: ASGIApp, get_token: Callable[[], str | None]):
        self.app = app
        self.get_token = get_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PROTECTED_PREFIX):
            await self.app(scope, receive, send)
            return

        expected = self.get_token()
        if not expected:
            response = error_response(
                503, "SERVICE_UNAVAILABLE", "INTERNAL_SERVICE_TOKEN is not configured; /api/v1 is disabled."
            )
            await response(scope, receive, send)
            return

        provided = _header(scope, TOKEN_HEADER)
        if provided is None or not hmac.compare_digest(provided, expected.encode()):
            response = error_response(401, "UNAUTHORIZED", "A valid X-Internal-Token header is required.")
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


class RequestTooLarge(HTTPException):
    def __init__(self, limit: int):
        super().__init__(status_code=413, detail=f"Request body exceeds {limit} bytes.")


class RequestSizeLimitMiddleware:
    """Rejects bodies over the limit: up front when Content-Length is declared,
    otherwise as soon as the streamed body passes the limit."""

    def __init__(self, app: ASGIApp, get_limit: Callable[[], int]):
        self.app = app
        self.get_limit = get_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.get_limit()
        declared = _header(scope, b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await error_response(413, "PAYLOAD_TOO_LARGE", f"Request body exceeds {limit} bytes.")(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # FastAPI re-raises HTTPExceptions raised while reading the body
                    raise RequestTooLarge(limit)
            return message

        await self.app(scope, limited_receive, send)
