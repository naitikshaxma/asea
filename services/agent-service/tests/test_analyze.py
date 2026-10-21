from fastapi.testclient import TestClient


def test_analyze_valid_input(client: TestClient):
    payload = {
        "taskId": "task-test-101",
        "taskType": "BUG_INVESTIGATION",
        "query": "Investigate race condition in task execution pool worker dispatch.",
        "repositoryUrl": "https://github.com/example/engine",
        "targetBranch": "main",
    }
    response = client.post("/api/v1/analyze", json=payload)
    assert response.status_code == 200

    data = response.json()
    assert data["taskId"] == "task-test-101"
    assert data["status"] == "READY_FOR_TRIAGE"
    assert isinstance(data["insights"], list)
    assert len(data["insights"]) > 0
    assert data["confidence"] == 1.0
    assert "phaseNote" in data


def test_analyze_invalid_input_short_query(client: TestClient):
    # Query length under 5 characters
    payload = {
        "taskId": "task-test-102",
        "query": "Fix",
    }
    response = client.post("/api/v1/analyze", json=payload)
    assert response.status_code == 422

    data = response.json()
    assert data["success"] is False
    assert data["error"]["code"] == "VALIDATION_ERROR"
    assert "details" in data["error"]
    fields = [d["field"] for d in data["error"]["details"]]
    assert any("query" in f for f in fields)


def test_analyze_invalid_task_type(client: TestClient):
    payload = {
        "taskId": "task-test-103",
        "taskType": "NON_EXISTENT_TYPE",
        "query": "Valid query text exceeding minimum characters.",
    }
    response = client.post("/api/v1/analyze", json=payload)
    assert response.status_code == 422

    data = response.json()
    assert data["success"] is False
    assert data["error"]["code"] == "VALIDATION_ERROR"
