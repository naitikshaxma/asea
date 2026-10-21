import pytest
from fastapi.testclient import TestClient
from app.main import app

# tests/fixtures holds sample code to analyse (e.g. demo_app/tests), not tests to run
collect_ignore_glob = ["fixtures/*"]


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client
