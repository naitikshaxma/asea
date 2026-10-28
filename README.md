# Autonomous AI Software Engineering Platform

> An enterprise-grade platform for autonomous software engineering, repository intelligence, and verified code repair.

> Current scope includes local repository analysis, change verification, and a bounded `CODE_PATCH` workflow. When configured, the worker snapshots a repository, applies a bounded proposal only in the disposable copy, runs exact-policy tests and scanners through an opt-in Docker provider, obtains a separate reviewer decision, then requests hash-bound human approval. Missing sandbox, scanners, or reviewer blocks approval and publication. Docker was unavailable in the last verification session, so the provider has not been exercised against a live engine. GitHub App publication and CI synchronization are implemented but require live credentials for smoke tests. See the [implementation status](docs/IMPLEMENTATION_STATUS.md) and [API reference](docs/API_REFERENCE.md) for verified behavior and limits.

---

## 1. Product Vision

The long-term objective of this platform is to take engineering tasks from natural language to verified, reviewed, and tested code changes with minimal human friction:
- Comprehend unfamiliar and legacy codebases using AST code graphs and semantic indexing.
- Investigate defects and isolate root causes through targeted reproduction harnesses.
- Synthesize bounded, regression-tested code patches.
- Execute automated peer reviews for architectural violations, bugs, and security risks.
- Generate evidence-backed engineering reports and automated GitHub pull requests.

---

## 2. Phase 3 Architecture & Implemented Capabilities

Phase 3 implements the **Repository Intelligence Engine**, giving the platform the ability to inspect, map, and rank repository codebases with mathematical determinism and defense-in-depth isolation:

- **Safe, Controlled Snapshot Collection (`snapshotCollector.ts`)**:
  - Strict path canonicalization rejecting directory traversal (`../`), null bytes, and root escapes.
  - Allowed roots jail via `ALLOWED_REPO_ROOTS` (required; only absolute local paths inside these roots can be analyzed).
  - Symlink containment: resolves all symlinks via realpath and blocks any symlink escaping the repository root.
  - Zero-exposure secret file filtering: completely excludes `.env`, `*.key`, `*.pem`, `id_rsa`, `credentials.json`, `*secret*`, and `*token*` files from analysis and inventory storage.
  - Binary file sniffing: inspects file headers for null bytes and control codes, safely categorizing and skipping them from textual parsing.
  - Hard resource limits: bounds maximum file count (default 5,000), single file size (default 1MB), total byte consumption (default 50MB), and scan timeout (default 30s).
- **Evidence-Backed Technology Detection (`technologyDetector.ts`)**:
  - Deterministic manifest inspection across `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Dockerfile`, `compose.yaml`.
  - Classifies runtime languages, backend/frontend frameworks, ORMs, queues, testing frameworks, and containerization tooling.
  - Each finding provides concrete file evidence, confidence scores (0.0 - 1.0), and human-verifiable rationales.
- **Deterministic Architecture Summarization (`architectureSummarizer.ts`)**:
  - Identifies server and application entry points (`server.ts`, `main.py`, `index.ts`, `app.py`).
  - Maps primary functional modules, API route definitions, service locations, and data models.
  - Extracts static relative file relationships (`IMPORTS`, `TESTS`, `CONFIGURES`) and links test files directly to corresponding source files.
- **Task-Focused Relevant File Retrieval (`relevanceRanker.ts`)**:
  - Natural language task prompt analysis: extracts domain-specific engineering keywords and code tokens.
  - Multi-factor file ranking: exact filename and basename matching, path containment, source-category bonuses, test file bonuses, and static relationship graph propagation.
  - Provides relevance scores (0 - 100), explicit match reasons, and action recommendations (`MODIFY`, `REFERENCE`, `EXTEND_TESTS`).
- **Database Persistence & Workspace Authorization (`repositoryAnalysisService.ts`)**:
  - Backed by Prisma `RepositoryAnalysis` model in PostgreSQL with migration management.
  - Workspace-scoped authorization ensuring only authenticated members of a workspace can analyze or query repositories.
  - All task endpoints are workspace-scoped (`/api/v1/workspaces/:workspaceId/tasks`); the unauthenticated legacy `/api/v1/tasks` routes have been removed.
- **Background Worker Pipeline Integration (`worker.ts`)**:
  - Runs verification jobs through BullMQ and handles provider-backed `CODE_PATCH` proposals when all required configuration is present.
  - Patch work occurs only in an isolated task snapshot; proposal, patch metadata, approval, workflow state, and audit entries are persisted together.
  - Only `CODE_PATCH` and `VERIFICATION` tasks are accepted; other task types are rejected at submission with `400 VALIDATION_ERROR`. Missing dependencies stop in an explicit `NEEDS_ATTENTION` state; no test success or patch is fabricated.
- **Task Workspace and Patch Safety Libraries**:
  - Create a bounded, secret-filtered repository copy in a separate task directory and calculate a content snapshot hash.
  - Validate bounded unified text patches and apply additions/modifications only inside a task directory.
  - The source checkout is left untouched, the disposable copy is removed after proposal validation, and one invalid diff repair is permitted.
- **Engineering Task and Review UI (`apps/web`)**:
  - Create tasks, follow persisted workflow steps, inspect the exact unified diff, and approve or reject proposals through role-checked APIs.
  - Displays persisted test, scanner, review, approval, GitHub, and CI evidence. Missing sandbox or reviewer configuration remains an explicit blocked state.
- **Interactive Developer Dashboard (`apps/web`)**:
  - Dedicated "Repo Intelligence" tab with technology cards, architecture map, interactive task query tool, and searchable file inventory browser.

---

## 3. Technology Stack

| Layer | Technologies |
|---|---|
| **Monorepo Management** | npm Workspaces, TypeScript 5.7, Node.js 24.x |
| **Frontend** | React 18, Vite 6, Tailwind CSS 3.4, Lucide React, Vitest, Testing Library |
| **Main API & Backend** | Node.js, Express 4, TypeScript, Prisma ORM, BullMQ, bcryptjs, jsonwebtoken, cookie-parser, Zod, Vitest, Supertest |
| **Persistence & Queue** | PostgreSQL 16 (Prisma migrations), Redis 7 (BullMQ) |
| **AI Agent Service** | Python 3.12, FastAPI 0.115, Pydantic v2, Pytest, Httpx |
| **Contracts** | TypeScript, Zod runtime schemas (`packages/contracts`) |
| **CI/CD** | GitHub Actions |

---

## 4. Implemented vs. Planned Functionality

| Capability | Phase 1 | Phase 2 | Phase 3 (Current) | Phase 4+ (Roadmap) |
|---|---|---|---|---|
| **Monorepo & Contracts** | Initial Zod schemas | Extended Auth, Workspace & Repo DTOs | **Repository Intelligence & Ranking Contracts** | Sandbox execution contracts |
| **Task Persistence** | In-memory register | PostgreSQL (Prisma ORM) | **PostgreSQL + Analysis History & Snapshots** | Large blob / artifact S3 storage |
| **Task Queue & Workers** | Synchronous register | BullMQ + Redis + Dedicated Worker | **BullMQ Worker with Real Repo Inspection** | Distributed worker autoscaling |
| **Delivery Guarantee** | None | Transactional Outbox Pattern | **Transactional Outbox Pattern** | Dead-letter queue inspection UI |
| **User & Tenant Auth** | Open / None | Bcrypt + JWT + HttpOnly Cookies + RBAC | Redis-backed revocable sessions, shared rate limits, CSRF checks | SSO / SAML / WebAuthn MFA |
| **Repository Attachment** | Local checkout mode | Workspace Repositories in PostgreSQL | **Repository Snapshot Collection & Analysis** | Real GitHub App & Webhook listener |
| **Repository Intelligence** | None | Basic metadata record | **Tech Detection, Import Extraction (regex) & File Retrieval** | Semantic vector embeddings |
| **Code Execution** | Host shell disabled | No repository execution | Opt-in Docker provider and exact command policy; disabled by default and not live-verified | Hardened VM/runtime and approved dependency cache |
| **AI Reasoning Engine** | FastAPI mock skeleton | Validated service boundary | LangGraph verification pipeline with deterministic checks and optional configured Anthropic provider; no-key runs skip LLM stages |

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

The API and the Prisma CLI scripts both read this repo-root `.env`.

### 2. Install Node Dependencies, Build Contracts & Generate the Prisma Client
```bash
npm install

# Required before typecheck, tests or dev servers: the API imports runtime
# schemas from packages/contracts/dist, which is not committed.
npm run build:contracts

# Generate the Prisma Client (no database needed):
npm run prisma:generate
```

### 3. Start PostgreSQL & Redis and Apply Migrations
```bash
# Start PostgreSQL 16 and Redis 7 (the Postgres container starts with an empty database):
npm run docker:up

# Create or upgrade the schema (uses DATABASE_URL from the root .env):
npm run prisma:migrate
```

Prisma migrations in `services/api/prisma/migrations` are the single source of truth for the database schema.

> **Upgrading from an older checkout:** earlier versions created tables from `infra/docker/init-db.sql` when the Postgres volume was first initialised. Prisma refuses to migrate that database (`P3005: The database schema is not empty`). Recreate the dev volume with `docker compose down -v` (**this deletes all local dev data**), then run the steps above again.

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

The default `LLM_PROVIDER=anthropic` requires `LLM_API_KEY` for LLM stages. Without a key, static checks and deterministic scoring still run; LLM stages are recorded as skipped and the report uses a deterministic fallback. `LLM_PROVIDER=fake` is an explicit test stand-in and is not a live AI review.

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

## 8. Service URLs & API Endpoints

- **Web Dashboard**: [http://localhost:5173](http://localhost:5173)
- **Express API Health**: [http://localhost:4000/health](http://localhost:4000/health)
- **Express API Readiness**: [http://localhost:4000/ready](http://localhost:4000/ready)
- **AI Agent Service Health**: [http://localhost:8000/health](http://localhost:8000/health)
- **AI Agent Service Readiness**: [http://localhost:8000/ready](http://localhost:8000/ready)
- **PostgreSQL**: `127.0.0.1:5432` (`dev_user` / `dev_password` / `autonomous_dev`)
- **Redis**: `127.0.0.1:6379`

### Repository Intelligence Endpoints
See the [complete API reference](docs/API_REFERENCE.md) for repository analysis and all other routes. Analysis is synchronous and limited to local repositories inside `ALLOWED_REPO_ROOTS`.

### ASEA Verification Endpoints
Submit a `VERIFICATION` task (see [docs/development.md](docs/development.md)); the agent service must be running with the same `INTERNAL_SERVICE_TOKEN`.
- `GET /api/v1/workspaces/:workspaceId/verification-runs?taskId=` — Verification runs (latest first), optionally for one task
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId` — One verification run with its score, verdict (`ALLOW`, `REVIEW`, `HIGH_RISK`, `BLOCK`), per-finding score breakdown and the policy snapshot it was scored with (null until scored)
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId/findings?severity=` — The run's findings
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId/audit/verify` — Checks the run's audit hash chain, its seal (a terminal run must end with RUN_SEALED matching the head hash and event count stored on the run, so removed trailing events are detected), the findings digest, and that the stored score, verdict, breakdown and policy snapshot match the SCORE_COMPUTED event
- `GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/refs` — Local branches (name, commit SHA, subject) to pick `baseSha`/`headSha` from

### GitHub Pull Requests
Connect a registered checkout to its GitHub repository; pull requests are then verified automatically and the result is posted as a PR comment.
- `PUT /api/v1/workspaces/:workspaceId/repositories/:repositoryId/github` `{ "fullName": "owner/name" }` (admins) — returns the webhook URL and a new secret (shown once). In GitHub: Settings → Webhooks → Add webhook, content type `application/json`, that secret, event "Pull requests".
- `DELETE …/github` — disconnects it.
- `POST /api/v1/webhooks/github` — the webhook. Signed `pull_request` events (opened, synchronize, reopened, ready for review) start a VERIFICATION task with the PR's base and head commits and its title and description as the requirement; bot authors and `ai-generated` labels mark the change as AI-authored. The worker fetches missing PR commits from `origin`, and posts score, verdict and top findings to the PR when `GITHUB_TOKEN` is set.

### Policy Profiles
A policy turns findings into a score and verdict (see `packages/contracts/src/policy.ts`). Each workspace gets a `default` profile on first use; its weights are uncalibrated placeholders. A VERIFICATION task may name `verification.policyProfileId`; the run stores a snapshot of that profile's config and its hash, so later edits only affect new runs.
- `GET|POST /api/v1/workspaces/:workspaceId/policies` — List (members) / create (admins)
- `GET|PATCH|DELETE /api/v1/workspaces/:workspaceId/policies/:policyId` — Read (members) / update or delete (admins; the default profile cannot be deleted)

---

## 9. Automated Testing Commands

Typecheck and the TypeScript test suites need step 2 of the setup (contracts built, Prisma Client generated). They do not need a running database. The latest audited counts are in [implementation status](docs/IMPLEMENTATION_STATUS.md).

```bash
# Run API and frontend tests:
npm test

# Run API tests individually:
npm run test:api

# Run Web tests individually:
npm run test:web

# Run Python agent-service tests:
npm run test:python

# Run API, frontend, and Python tests:
npm run test:all

# Run the isolated Docker end-to-end suite (uses its own Compose project and volumes):
npm run e2e

# Run type checking across all TypeScript workspaces:
npm run typecheck

# Run production build:
npm run build
```

---

## 10. Documentation Index

- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [API reference](docs/API_REFERENCE.md)
- [Architecture](docs/architecture.md)
- [Local development guide](docs/development.md)
- [Security architecture and threat model](docs/security.md)
- [Planned worker sandbox boundary](workers/execution-worker/README.md)
