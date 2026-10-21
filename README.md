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

## 2. Phase 2 Architecture & Implemented Capabilities

Phase 2 advances the platform from an in-memory proof of concept into a persistent, asynchronous, multi-tenant backend:

- **Authoritative PostgreSQL Persistence**: Integrated **Prisma ORM** with migration-managed normalized schema: `User`, `Workspace`, `WorkspaceMembership`, `Repository`, `Task`, `WorkflowRun`, `WorkflowStep`, `Approval`, `AuditEvent`, and `OutboxEvent`.
- **Authentication & Multi-Tenant Authorization**:
  - Secure registration and login with **bcrypt** (cost factor 12) password hashing.
  - Signed JSON Web Tokens (JWT) delivered via both `Authorization: Bearer` and secure `HttpOnly` cookies.
  - Role-based access control (`OWNER`, `ADMIN`, `MEMBER`) strictly isolating workspace resources and tasks.
- **Durable Task & Workflow Management**:
  - Tasks, workflow runs, and workflow steps persist permanently across API and worker restarts.
  - Centralized **Workflow State Machine** enforcing strict state transitions (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCEL_REQUESTED`, `CANCELLED`).
  - Active task cancellation support.
- **BullMQ & Redis Background Worker Pipeline**:
  - Asynchronous background task execution isolated from the main Express API process.
  - Dedicated background worker (`npm run dev:worker`) executing deterministic steps: `VALIDATE_CONTEXT`, `INSPECT_REPOSITORY`, `GENERATE_SPEC`, and `VERIFY_BOUNDARIES`.
  - Exponential backoff retry policies and bounded execution.
- **Transactional Outbox Pattern**:
  - Guarantees durable dispatch between PostgreSQL and Redis, completely eliminating the dual-write problem.
  - Atomic transaction commits task, workflow run, and outbox event; outbox dispatcher reliably delivers jobs to BullMQ.
- **Interactive Developer Frontend (`apps/web`)**:
  - React 18, Vite 6, and Tailwind CSS dashboard.
  - User authentication modal (Sign In / Register) with auto-workspace provisioning.
  - Workspace selector switching contexts in real time.
  - Workspace repository registration and association.
  - Expandable workflow run drawer showing real worker attempt history and step status.
  - Zero mock task metrics or fabricated AI output: honestly reflects backend workflow state.

---

## 3. Technology Stack

| Layer | Technologies |
|---|---|
| **Monorepo Management** | npm Workspaces, TypeScript 5.7, Node.js 24.x |
| **Frontend** | React 18, Vite 6, Tailwind CSS 3.4, Lucide React, Vitest, Testing Library |
| **Main API & Backend** | Node.js, Express 4, TypeScript, Prisma ORM, BullMQ, bcryptjs, jsonwebtoken, cookie-parser, Zod, Vitest, Supertest |
| **Persistence & Queue** | PostgreSQL 16 (Prisma migrations), Redis 7 (BullMQ) |
| **AI Agent Service** | Python 3.12, FastAPI 0.115, Pydantic v2, Pytest, Httpx |
| **Contracts** | TypeScript, Zod runtime schemas |
| **CI/CD** | GitHub Actions |

---

## 4. Implemented vs. Planned Functionality

| Capability | Phase 1 | Phase 2 (Current) | Phase 3+ (Roadmap) |
|---|---|---|---|
| **Monorepo & Contracts** | Initial Zod schemas | Extended Auth, Workspace, Repo & Task DTOs | Sandbox execution contracts |
| **Task Persistence** | In-memory register | **PostgreSQL (Prisma ORM migrations)** | Large blob / artifact S3 storage |
| **Task Queue & Workers** | Synchronous register | **BullMQ + Redis + Dedicated Worker** | Distributed worker autoscaling |
| **Delivery Guarantee** | None | **Transactional Outbox Pattern** | Dead-letter queue inspection UI |
| **User & Tenant Auth** | Open / None | **Bcrypt + JWT + HttpOnly Cookies + RBAC** | SSO / SAML / WebAuthn MFA |
| **Repository Attachment** | Local checkout mode | **Workspace Repositories in PostgreSQL** | Real GitHub App & Webhook listener |
| **Code Execution** | Host shell disabled | **Deterministic Safe Worker Steps** | Disposable gVisor / MicroVM sandboxes |
| **AI Reasoning Engine** | FastAPI mock skeleton | FastAPI mock with validated contract | LangGraph / multi-agent reasoning loop |

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

### 3. Generate Database Client & Apply Migrations
```bash
# Generate the Prisma Client:
npm run prisma:generate

# Apply migrations to PostgreSQL (once containers are running):
npm run prisma:migrate
```

### 4. Setup Python Agent Service Virtual Environment
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

### Start Development Environment
```bash
# Starts Express API (4000), BullMQ Worker, and Web Frontend (5173) concurrently:
npm run dev:all

# Or run API and Web only:
npm run dev
```

### Start Python AI Agent Service
```bash
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
# Run all Node.js and Frontend tests (32 API tests + 6 Web tests):
npm test

# Run Python Pytest test suite (5 agent tests):
npm run test:python

# Run All (TypeScript + Python):
npm run test:all

# Run type checking across all TypeScript workspaces:
npm run typecheck

# Run production build:
npm run build
```

---

## 10. Documentation Index

- [Architecture Specification (Phase 2)](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/architecture.md)
- [Local Development Guide (Phase 2)](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/development.md)
- [Security Architecture & Threat Model (Phase 2)](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/docs/security.md)
- [Worker Sandbox Boundary](file:///c:/Users/sharm/OneDrive/Desktop/miniprject/workers/execution-worker/README.md)
