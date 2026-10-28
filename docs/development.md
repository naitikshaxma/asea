# Local Development Guide

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

Review `.env` and replace development-only secrets before using a shared or production environment.

To use repository analysis, set `ALLOWED_REPO_ROOTS` to the absolute directories that hold your local checkouts (comma-separated). It has no default; until it is set, analysis requests return 503.

`LLM_PROVIDER` defaults to `anthropic`. Set `LLM_API_KEY` to enable model-backed proposal and analysis stages. Without a key, LLM stages are unavailable/skipped. `LLM_PROVIDER=fake` selects the explicit deterministic test stand-in; it is used by test/E2E configurations and is not a live model review.

Authentication uses Redis for shared rate-limit counters and server-side session state by default. Set `AUTH_STATE_STORE=memory` only for isolated tests or local development; production refuses this setting. Redis is required for readiness when this store is selected. Browser writes must include the same `Origin` as `CORS_ORIGIN` (or a matching `Referer`).

Password change and reset revoke all registered sessions. Set a random `DEV_MAILBOX_TOKEN` (at least 24 characters) only in a local/test environment to enable invitation links and account-reset links. Inspect the process-local inbox using `GET /api/v1/dev/mailbox` with `Authorization: Bearer <DEV_MAILBOX_TOKEN>`. This protected memory sink is not email delivery, disappears when the API restarts, and is always disabled in production. Without it, password-reset requests still return the same generic response but no reset token is issued; invitation creation returns `503`. A real email adapter is required before enabling these workflows for production users.

For model-backed `CODE_PATCH` tasks, set `ALLOWED_REPO_ROOTS` and a separate writable `TASK_WORKSPACE_ROOT`. The worker copies a secret-filtered snapshot, obtains an evidence-bearing proposal, validates and applies the diff only in that disposable copy, then runs verification before it requests human approval. The original checkout remains read-only. Missing runtimes, scanner tools, tests, or reviewer configuration are stored as unavailable/not-run and block approval and publication.

#### Optional local Docker sandbox

The Docker provider is opt-in and is for a worker process running directly on the development host. The regular application Compose worker has no Docker CLI or daemon socket and explicitly reports `SANDBOX_PROVIDER=unavailable`.

1. Build the scanner/test image from the repository root in a trusted build environment (the image build downloads pinned tools and an OSV advisory database):

   ```powershell
   docker build -f services/api/sandbox/Dockerfile -t asea/sandbox:2026.10 .
   ```

2. Configure the host worker environment:

   ```dotenv
   SANDBOX_PROVIDER=docker
   SANDBOX_DOCKER_IMAGE=asea/sandbox:2026.10
   SANDBOX_DOCKER_EXECUTABLE=docker
   SANDBOX_WORKSPACE_SIZE_MB=256
   TASK_WORKSPACE_ROOT=C:/asea/task-workspaces
   ALLOWED_REPO_ROOTS=C:/checkouts
   ```

   Ensure Docker Desktop can bind-mount the workspace path. On Linux, set `SANDBOX_DOCKER_UID` and `SANDBOX_DOCKER_GID` to the host worker's file owner. The image must already exist locally; task containers use `--pull=never`.

3. Keep the worker's Docker daemon access in the trusted worker process. Repository code receives only a read-only bind mount of its bounded task snapshot at `/input`; test commands copy it into `/workspace`, a per-container memory-backed tmpfs. `SANDBOX_WORKSPACE_SIZE_MB` defaults to 256 MiB and is clamped to 64–1024 MiB. The tmpfs `size=` cap was verified live by filling a 64 MiB workspace until Linux returned `ENOSPC`; this is an enforced memory-backed workspace bound, **not a disk quota on a writable host bind mount**. If Docker cannot create the tmpfs, the command fails closed; there is no writable bind-mount fallback. The test snapshot itself is bounded by the repository collector (5,000 files, 1 MiB per file, 50 MiB total), and its host-side task directory is removed after execution or by the guarded worker-startup reaper. Scanner mounts are read-only. Containers use `--network=none`, a read-only root filesystem, dropped capabilities, no-new-privileges, non-root identity, PID/memory/swap/CPU/time/output bounds, and a separate bounded `/tmp`. The provider explicitly passes `--security-opt=seccomp=builtin`; it does not rely on the daemon default. Containers use `--log-driver=none`: Docker does not persist container logs, while the attached CLI stream remains available to the provider's bounded capture/redaction path. No Docker socket or application credential is passed into a task container. The command deadline is enforced inside the container as well as by the worker process, so `--rm` removes a container after that deadline even if its worker exits. Every run gets a unique workspace name containing a host token and owner PID; on startup, the worker removes only matching direct-child workspaces whose recorded PID is no longer alive. Unrecognized names, other-host workspaces, live owners, and cleanup failures are left intact or reported. Sandbox containers carry the same ownership as labels (`io.asea.sandbox=v1`, `io.asea.sandbox.host`, `io.asea.sandbox.pid`); on startup the worker force-removes only labelled `asea-sbx-*` containers of this host whose owner PID is dead. Unlabelled containers, other hosts, and live owners are never touched. A cancellation that arrives before Docker has created the container keeps retrying `docker rm` until the container is actually removed, so a late create cannot leave a stray `Created` container.

4. Run the whole `CODE_PATCH` pipeline live with `npm run live:code-patch` (set `SANDBOX_DOCKER_IMAGE` if your tag differs). It starts uniquely named tmpfs PostgreSQL/Redis containers on loopback ports, applies migrations, creates a fixture git repository, and runs the agent service (deterministic `fake` proposer and reviewer), API, and worker on this host. It then checks that the task reaches a `PENDING` approval with all evidence `PASSED`, that the requester cannot approve it, and that a cancellation during sandbox execution stores nothing and leaves no workspace or container. Teardown removes only that run's processes, its two containers (by exact name), and its temporary directory. It never reads `DATABASE_URL`/`REDIS_URL` from your environment. The `fake` reviewer approves only the fake proposer's marker-only diff and is refused when `ENVIRONMENT=production`.

Test stdout/stderr is byte-bounded and redacted before it enters a test report. The worker sanitizes nested test, scanner, review, and sandbox evidence before persistence; task and patch API responses apply the sanitizer again. Redaction covers common credential formats, credential-style assignments, private-key blocks, and exact values of at least four characters from sensitive environment variables visible to the trusted worker. These controls prevent the tested synthetic secrets from being stored or returned. They cannot identify every arbitrary unlabeled secret or every value unavailable to the worker process, so repository tests should not print credentials.

The fixed command policy permits `node --test`, offline `npm test` with lifecycle scripts disabled, `python -m pytest -q`, and the pinned Gitleaks, Semgrep, and offline OSV-Scanner commands. Scanner configs are image-baked and override repository-defined Gitleaks/OSV exceptions; Semgrep suppressions and Git ignores are disabled, and a repository `.semgrepignore` blocks a clean result because its exclusions cannot be trusted. No dependency install or network fetch occurs for a task. Project tests that need packages absent from the sandbox image/cache can fail; their real command output and exit status are persisted. This container configuration reduces exposure but is not a complete boundary against a hostile Linux kernel, Docker daemon, or container escape.

**Seccomp validation (2026-10-23):** this Docker Desktop Engine reports `Security Options: seccomp Profile: unconfined`, so its implicit default is not treated as a security control. The provider explicitly selects Docker's built-in seccomp profile. On the verified Engine, `docker inspect` reported `seccomp=builtin`, the process reported `Seccomp: 2`, a Python pytest fixture passed normal operations, and the `keyctl` syscall returned `EPERM`. With the same container settings but no explicit profile, the `keyctl` probe succeeded. Engines that reject `seccomp=builtin` fail the sandbox command rather than silently running without it. See [implementation status](IMPLEMENTATION_STATUS.md#seccomp-hardening-follow-up).

For an independent patch review, configure `REVIEW_LLM_PROVIDER`, `REVIEW_LLM_API_KEY`, and `REVIEW_MODEL_NAME` on the agent service. The review identity must use a different model when it shares the proposal provider. Review is unavailable by default; unavailable review blocks approval and publication.

### GitHub App setup

For the workspace installation picker, approved-patch PR publisher, and CI sync:

1. Register a GitHub App and enable **Request user authorization (OAuth) during installation**. Set its Callback URL to the browser app's exact Settings URL (for example, `https://asea.example.com/settings`). GitHub App setup URL and OAuth callback URL are distinct; requesting user authorization during installation uses the callback URL.
2. Grant Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Checks: Read-only**, **Commit statuses: Read-only**, and **Metadata: Read-only**. Subscribe to `installation`, `installation_repositories`, `pull_request`, `check_run`, `check_suite`, and `status` events.
3. Set the App webhook URL to `https://asea.example.com/api/v1/webhooks/github` and configure a webhook secret. Set all six API environment variables together: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET`.
4. Keep the App private key, client secret, webhook secret, App JWTs, installation tokens, and user access tokens on the API server. The OAuth callback code is exchanged server-side; the user access token is held only in memory while the API verifies `GET /user/installations` and is not persisted.
5. Link an installation under **Settings → GitHub App**, then choose an App-accessible repository from the repository page. The existing local checkout remains the source snapshot for patch generation.

The publisher requires a clean source revision, matching remote base SHA and changed-file hashes, a current second-person approval, and `PASSED` test, security, and independent-review statuses. The Docker sandbox has been live-verified; live GitHub/LLM credentials remain unavailable, so no real publication was run. See [API_REFERENCE.md](API_REFERENCE.md#github-app-and-pr-lifecycle) and [security.md](security.md).

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
# Run API and frontend tests
npm test

# Run API test suite individually
npm run test:api

# Run Web test suite individually
npm run test:web

# Run Python agent-service tests
npm run test:python

# Run all API, frontend, and Python tests
npm run test:all

# Run the isolated Docker end-to-end suite
npm run e2e
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

## 5. API Reference

See [API_REFERENCE.md](API_REFERENCE.md) for every mounted Node and Python endpoint, authentication and role requirements, request/response contracts, and error behavior. Login and registration are limited to five attempts per 15 minutes per IP by default (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`) using Redis-shared fixed windows. Logout revokes the server-side session and clears the browser cookie; Redis outages fail closed with `503`.

The E2E script normally uses the isolated `asea-e2e` Compose project and removes its volumes after the run. If that project already contains data you want to keep, set `E2E_PROJECT` to a new project name before running it.

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
- Task processing requires Redis. When Redis is unavailable, tasks remain persisted in PostgreSQL and the transactional outbox retries dispatch after Redis recovers; the worker still requires a live Redis connection.
