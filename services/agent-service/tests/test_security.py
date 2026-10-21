"""S8 hardening: no CORS, X-Internal-Token on /api/v1/*, request size limits."""

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from tests.conftest import TEST_INTERNAL_TOKEN

ANALYZE = "/api/v1/analyze"
VALID_ANALYZE = {"taskId": "t-1", "query": "Investigate the failing worker."}


def test_no_cors_headers_are_sent(anonymous_client: TestClient):
    origin = {"Origin": "https://evil.example"}
    preflight = anonymous_client.options(
        "/api/v1/verify/static",
        headers={**origin, "Access-Control-Request-Method": "POST", "X-Internal-Token": TEST_INTERNAL_TOKEN},
    )
    assert "access-control-allow-origin" not in preflight.headers
    assert "access-control-allow-credentials" not in preflight.headers
    assert "access-control-allow-origin" not in anonymous_client.get("/health", headers=origin).headers


def test_health_and_ready_do_not_need_the_token(anonymous_client: TestClient):
    assert anonymous_client.get("/health").status_code == 200
    assert anonymous_client.get("/ready").status_code == 200


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}, {"X-Internal-Token": ""}])
def test_api_rejects_missing_or_wrong_token(anonymous_client: TestClient, headers: dict):
    response = anonymous_client.post(ANALYZE, json=VALID_ANALYZE, headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_token_is_checked_before_the_body_is_validated(anonymous_client: TestClient):
    response = anonymous_client.post("/api/v1/verify/static", json={"not": "a request"})
    assert response.status_code == 401


def test_api_accepts_the_configured_token(client: TestClient):
    assert client.post(ANALYZE, json=VALID_ANALYZE).status_code == 200


def test_api_is_disabled_while_no_token_is_configured(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", None)
    response = client.post(ANALYZE, json=VALID_ANALYZE)
    assert response.status_code == 503
    assert "INTERNAL_SERVICE_TOKEN" in response.json()["error"]["message"]


def test_declared_oversized_body_is_rejected(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_MAX_REQUEST_BYTES", 1000)
    response = client.post(ANALYZE, json={**VALID_ANALYZE, "query": "x" * 2000})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_streamed_oversized_body_without_content_length_is_rejected(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_MAX_REQUEST_BYTES", 1000)

    def chunks():
        yield b'{"taskId": "t-1", "query": "'
        for _ in range(10):
            yield b"x" * 200
        yield b'"}'

    response = client.post(ANALYZE, content=chunks(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_body_under_the_limit_is_accepted(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_MAX_REQUEST_BYTES", 1000)
    assert client.post(ANALYZE, json=VALID_ANALYZE).status_code == 200
