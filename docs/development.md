# Local Development Guide (Phase 3)

## 1. Prerequisites

Ensure the following tools are installed:
- **Node.js**: `v24.x` or later (tested on `v24.12.0`)
- **npm**: `v11.x` or later (tested on `11.7.0`)
- **Python**: `3.12.x` or later (tested on `3.12.10`)
- **Docker & Docker Compose**: `v28.x` or later (Docker Desktop / engine)
- **Git**: `2.x` or later

---

## 2. Quickstart

### Step 1: Clone and Configure Environment
```bash
# Copy example environment variables
cp .env.example .env
```

Review `.env`. It contains safe development secrets (`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`).

To use repository analysis, set `ALLOWED_REPO_ROOTS` to the absolute directories that hold your local checkouts (comma-separated). It has no default; until it is set, analysis requests return 503.

### Step 2: Install Node Monorepo Dependencies
```bash
npm install
```
This installs dependencies across `packages/contracts`, `services/api`, and `apps/web`.

### Step 3: Build Contracts, Generate Prisma Client & Run Migrations
```bash
# Required before typecheck, tests or dev servers (the API imports packages/contracts/dist)
npm run build:contracts

# Generate the Prisma Client (no database needed)
npm run prisma:generate

# Apply migrations to PostgreSQL (requires docker:up or local Postgres).
# Prisma migrations are the single source of truth for the schema.
# Uses DATABASE_URL from the repo-root .env.
npm run prisma:migrate
```

### Step 4: Setup Python Virtual Environment (Agent Service)
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

## 3. Starting Services

### Option A: Local Dev Infrastructure (PostgreSQL & Redis)
```bash
# Start PostgreSQL (port 5432) and Redis (port 6379)
npm run docker:up

# Check container status
docker compose ps

# Stop containers
npm run docker:down
```

### Option B: Start Full Development Environment (API + Worker + Frontend)
```bash
npm run dev:all
```
This runs three processes concurrently:
- **Express API**: `http://localhost:4000`
- **BullMQ Worker**: Background job consumer
- **React Frontend**: `http://localhost:5173`

Or start them individually:
```bash
# Start API only
npm run dev:api

# Start Worker only
npm run dev:worker

# Start Web only
npm run dev:web
```

### Option C: Start Python Agent Service
```bash
npm run dev:agent
# Runs on: http://localhost:8000
```

---

## 4. Running Checks and Tests

### Run All Tests
```bash
# Run TypeScript tests (111 API tests + 11 Web tests = 122 tests)
npm test

# Run API test suite individually
npm run test:api

# Run Web test suite individually
npm run test:web

# Run Python Pytest tests (60 agent tests)
npm run test:python

# Run Everything (74 total tests)
npm run test:all
```

### Type Checking
```bash
npm run typecheck
```

### Production Build
```bash
npm run build
```

---

## 5. API Endpoints

### Authentication
- `POST /api/v1/auth/register` — Register new user & auto-create workspace
- `POST /api/v1/auth/login` — Authenticate and obtain JWT / HttpOnly cookie
- `POST /api/v1/auth/logout` — Invalidate session cookie
- `GET /api/v1/auth/me` — Retrieve profile & accessible workspaces

### Workspaces & Membership
- `GET /api/v1/workspaces` — List workspaces for authenticated user
- `POST /api/v1/workspaces` — Create new workspace
- `GET /api/v1/workspaces/:workspaceId` — Workspace details (requires membership)
- `PATCH /api/v1/workspaces/:workspaceId` — Update workspace name (requires ADMIN/OWNER)

### Repositories
- `GET /api/v1/workspaces/:workspaceId/repositories` — List workspace repositories
- `POST /api/v1/workspaces/:workspaceId/repositories` — Attach repository record
- `GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId` — Repository details

### Repository Intelligence (Phase 3)
- `POST /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analyze` — Trigger snapshot analysis
- `GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analysis` — Retrieve latest analysis and architecture summary
- `GET /api/v1/workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId/files` — Paginated file inventory with classification
- `POST /api/v1/workspaces/:workspaceId/repositories/:repositoryId/relevant-files` — Task-focused file retrieval and ranking

### Tasks & Execution History
- `POST /api/v1/workspaces/:workspaceId/tasks` — Submit task & enqueue workflow
- `GET /api/v1/workspaces/:workspaceId/tasks` — List tasks with status/type filters
- `GET /api/v1/workspaces/:workspaceId/tasks/:taskId` — Task details
- `POST /api/v1/workspaces/:workspaceId/tasks/:taskId/cancel` — Cancel active task
- `GET /api/v1/workspaces/:workspaceId/tasks/:taskId/runs` — Task workflow runs and steps

### ASEA Verification
A `VERIFICATION` task needs `repositoryId` (a registered local git repository inside `ALLOWED_REPO_ROOTS`) and `verification: { baseSha, headSha, authorType: AI|HUMAN|UNKNOWN }`; its description is the requirement. Submitting it creates a QUEUED VerificationRun. The worker builds the diff with `git` (argument list, no shell), calls the agent service's `POST /api/v1/verify/static` at `AI_SERVICE_URL` with `X-Internal-Token: $INTERNAL_SERVICE_TOKEN`, stores the findings, appends hash-chained audit events and records a `STATIC_ANALYSIS` workflow step.
- `GET /api/v1/workspaces/:workspaceId/verification-runs?taskId=` — Verification runs (latest first), optionally for one task
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId` — One verification run (score and verdict are null until scoring exists)
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId/findings?severity=` — The run's findings
- `GET /api/v1/workspaces/:workspaceId/verification-runs/:runId/audit/verify` — Checks the run's audit hash chain and that the findings match the digest recorded in it

---

## 6. Troubleshooting

### Database Authentication Failed
If Docker Postgres is not running or credentials differ:
- Check container logs: `docker compose logs postgres`
- Verify that `.env` has:
  ```env
  DATABASE_URL=postgresql://dev_user:dev_password@localhost:5432/autonomous_dev
  ```

### Redis Connection Error in Worker
- Check Redis container: `docker compose ps`
- The API gracefully operates in mock fallback mode if Redis is down, but the background worker requires an accessible Redis instance.
