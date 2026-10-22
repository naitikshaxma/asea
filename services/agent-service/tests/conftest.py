import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.config import settings
from app.main import app
from app.verification.policy import PolicyConfig

# Pinned by services/api/tests/aseaContract.test.ts from DEFAULT_POLICY_CONFIG
DEFAULT_POLICY_FILE = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "schemas" / "default-policy.json"

# tests/fixtures holds sample code to analyse (e.g. demo_app/tests), not tests to run
collect_ignore_glob = ["fixtures/*"]

TEST_INTERNAL_TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def internal_token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", TEST_INTERNAL_TOKEN)
    return TEST_INTERNAL_TOKEN


@pytest.fixture
def client():
    """Client for the Node worker's view of the API: sends the internal token."""
    with TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN}) as test_client:
        yield test_client


@pytest.fixture
def anonymous_client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def default_policy() -> PolicyConfig:
    return PolicyConfig.model_validate(json.loads(DEFAULT_POLICY_FILE.read_text(encoding="utf-8")))
