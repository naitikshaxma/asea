from fastapi.testclient import TestClient


def test_health_endpoint(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "ok"
    assert data["service"] == "@autonomous-engineer/agent-service"
    assert data["version"] == "0.1.0"
    assert isinstance(data["uptime"], (int, float))
    assert "timestamp" in data


def test_readiness_endpoint(client: TestClient):
    response = client.get("/ready")
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "ready"
    assert "dependencies" in data
    assert "llm_provider" in data["dependencies"]
    assert data["dependencies"]["llm_provider"]["status"] == "up"
