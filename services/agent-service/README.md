# Agent Service (FastAPI)

Modular Python service skeleton for AI reasoning, repository intelligence, and agent orchestration.

## Phase 1 Scope

In Phase 1, this service acts as the foundation and contract verification point for future autonomous agents:
- Provides `/health` and `/ready` endpoints adhering to the platform shared contracts.
- Provides `/api/v1/analyze` contract endpoint for triage analysis.
- Runs without requiring any paid LLM API key by leveraging a local mock provider.
- Configured with Pydantic v2 schemas and strict environment validation.

## Local Development

### 1. Setup Virtual Environment
```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Run Service
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. Run Tests
```bash
pytest
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Process uptime and health status |
| `GET` | `/ready` | Service readiness and dependency connectivity |
| `POST` | `/api/v1/analyze` | Repository task analysis and triage skeleton |

## Phase 2 Roadmap
- Integrated AST code graph indexing.
- Multi-turn LLM reasoning loop with bounded tool usage.
- Secure communication with `workers/execution-worker` for isolated verification.
