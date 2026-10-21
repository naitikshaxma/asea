# Autonomous AI Software Engineering Platform

> An enterprise-grade platform for autonomous software engineering, repository intelligence, and verified code repair.

---

## 1. Product Vision

The long-term objective of this platform is to take engineering tasks from natural language to verified, reviewed, and tested code changes with minimal human friction:
- Comprehend unfamiliar and legacy codebases using AST code graphs and semantic indexing.
- Investigate defects and isolate root causes through targeted reproduction harnesses.
- Synthesize bounded, regression-tested code patches.
- Execute automated peer reviews for architectural violations, bugs, and security risks.
- Generate evidence-backed engineering reports and automated GitHub pull requests.

---

## 2. Phase 1 Implementation Scope

Phase 1 provides the foundational monorepo and contracts architecture:

- **Frontend Dashboard (`apps/web`)**: React 18, Vite 6, TypeScript, Tailwind CSS dark-first developer dashboard with sidebar navigation, metrics overview, live API connectivity indicator, task intake form, and honest empty/loading/error states.
- **Control Plane API (`services/api`)**: Node.js 24 + Express 4 + TypeScript service with Zod schema validation, request ID propagation, credential-redacted JSON logging, centralized error handling, and `/health` and `/ready` endpoints.
- **AI Agent Service Skeleton (`services/agent-service`)**: Python 3.12 + FastAPI + Pydantic v2 service skeleton with `/health`, `/ready`, and `/api/v1/analyze` endpoints. Operates using a local mock provider without requiring paid LLM API keys.
- **Shared Contracts (`packages/contracts`)**: Unified Zod schemas and TypeScript types defining request tracing, standardized API error responses, health/readiness models, and task DTOs.
- **Execution Worker Boundary (`workers/execution-worker`)**: Documented zero-trust security specification. Arbitrary host shell execution is disabled by design.
- **Local Dev Infrastructure (`compose.yaml`)**: Containerized PostgreSQL 16 and Redis 7 with healthchecks, persistent dev volumes, and localhost-bound ports.
- **Continuous Integration (`.github/workflows/ci.yml`)**: Multi-job GitHub Actions workflow covering type checking, Node tests, frontend tests, Python pytest, and build verification.

---

## 3. Technology Stack

| Layer | Technologies |
|---|---|
| **Monorepo Management** | npm Workspaces, TypeScript 5.7, Node.js 24.x |
| **Frontend** | React 18, Vite 6, Tailwind CSS 3.4, Lucide React, Vitest, Testing Library |
| **Main API** | Node.js, Express 4, TypeScript, Zod, pg, ioredis, Vitest, Supertest |
| **AI Agent Service** | Python 3.12, FastAPI 0.115, Pydantic v2, Pytest, Httpx |
| **Contracts** | TypeScript, Zod runtime schemas |
| **Infrastructure** | Docker Compose v2, PostgreSQL 16 Alpine, Redis 7 Alpine |
| **CI/CD** | GitHub Actions |

---

## 4. Implemented vs. Planned Functionality

| Capability | Phase 1 (Current) | Phase 2+ (Roadmap) |
|---|---|---|
| **Monorepo & Contracts** | Full implementation (Zod + TS + Pydantic) | Incremental schema extensions |
| **Task Intake & Validation** | Full intake validation & audit register | Multi-stage pipeline queue |
| **Service Health Probing** | Express & FastAPI `/health` + `/ready` | Distributed tracing & OpenTelemetry |
| **AI Reasoning Engine** | FastAPI skeleton with local mock provider | Multi-agent LangGraph / AutoGen loop |
| **LLM Key Requirement** | None (100% runnable without API keys) | Configurable BYOK (OpenAI, Anthropic, Gemini) |
| **Code Execution** | Host shell disabled; boundary documented | Disposable OCI / gVisor microVM sandboxes |
| **Version Control** | Local repository checkout mode | GitHub App, webhooks & automated PRs |
| **Database & Cache** | Docker Compose PostgreSQL 16 & Redis 7 | Prisma/Kysely migrations & BullMQ queue |

---

## 5. Prerequisites

Before setting up, ensure you have:
- **Node.js**: `>= 20.x` (tested on `v24.12.0`)
- **npm**: `>= 10.x` (tested on `11.7.0`)
- **Python**: `>= 3.11.x` (tested on `3.12.10`)
- **Docker & Docker Compose**: Docker Desktop or Docker Engine
- **Git**: `>= 2.x`

---

## 6. Exact Setup Instructions

### 1. Initialize Environment
```bash
cp .env.example .env
```

### 2. Install Node Dependencies
```bash
npm install
```

### 3. Setup Python Agent Service Virtual Environment
```bash
cd services/agent-service
python -m venv .venv

# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
cd ../..
```

---

## 7. Starting and Stopping Services

### Start Infrastructure (PostgreSQL & Redis)
```bash
npm run docker:up
```

Verify containers are running:
```bash
docker compose ps
```

To stop containers:
```bash
npm run docker:down
```

### Start Application Development Servers
```bash
# Starts Express API (port 4000) and Web Frontend (port 5173) concurrently:
npm run dev
```

### Start Python AI Agent Service
```bash
# From workspace root (with .venv activated):
npm run dev:agent
```

---

## 8. Service URLs & Health Probes

- **Web Dashboard**: [http://localhost:5173](http://localhost:5173)
- **Express API Health**: [http://localhost:4000/health](http://localhost:4000/health)
- **Express API Readiness**: [http://localhost:4000/ready](http://localhost:4000/ready)
- **AI Agent Service Health**: [http://localhost:8000/health](http://localhost:8000/health)
- **AI Agent Service Readiness**: [http://localhost:8000/ready](http://localhost:8000/ready)
- **PostgreSQL**: `127.0.0.1:5432` (`dev_user` / `dev_password` / `autonomous_dev`)
- **Redis**: `127.0.0.1:6379`

---

## 9. Automated Testing Commands

```bash
# Run all Node.js and Frontend tests:
npm test

# Run Python Pytest test suite:
npm run test:python

# Run type checking across all TypeScript workspaces:
npm run typecheck

# Run production build:
npm run build
```

---

## 10. Documentation Index

- [Architecture Specification](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/architecture.md)
- [Local Development Guide](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/development.md)
- [Security Architecture & Threat Model](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/security.md)
- [Worker Sandbox Boundary](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/workers/execution-worker/README.md)
