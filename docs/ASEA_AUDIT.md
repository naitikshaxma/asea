# ASEA Pre-Work Audit

Read-only audit of this repository at commit `09aa8bb`, compared against the planned ASEA (Agent-agnostic Safe-to-merge Evaluation) architecture. All findings come from reading the source code; nothing was installed, built, run or tested. Claims about runtime behaviour are marked **expected (not executed)**.

---

## 1. Summary

This repo is **not ASEA yet, and it uses a different stack from the ASEA plan**. It is an npm-workspaces TypeScript monorepo called "Autonomous AI Software Engineering Platform" ([package.json:2-6](package.json#L2-L6)), built in three commits labelled Phases 1–3. It contains:

- an Express 4 + Prisma 6 + PostgreSQL API with JWT auth, multi-tenant workspaces, repository records and "tasks";
- a transactional outbox that feeds a BullMQ worker, which runs four hardcoded steps that write canned metadata ([worker.ts:95-185](services/api/src/worker.ts#L95-L185));
- a "Repository Intelligence" module that walks a **local directory**, detects technologies from manifest files, extracts imports with **regex** (not AST), and ranks files by keyword overlap with a prompt;
- a React 18 + Vite dashboard (not Next.js);
- a FastAPI "agent service" whose only real endpoint returns a **hardcoded mock** ([analyze.py:8-24](services/agent-service/app/routers/analyze.py#L8-L24)).

None of the following exist: Django/DRF, Celery, LangGraph, LLM calls, Qdrant/RAG, Semgrep, Python-AST analysis, any notion of a PR/diff, merge-safety scoring, a reporter, GitHub App/webhooks, a hash-chained audit trail, or MCP. Pieces that could be reused for ASEA:

- the auth and workspace RBAC layer;
- the outbox → queue pattern;
- the path-jail and secret-file filtering in the snapshot collector;
- the FastAPI service shell, which is the natural home for Python-native tooling (LangGraph, Semgrep, `ast`).

---

## 2. Tech stack actually present

Versions are declared ranges from the manifests, with the exact versions resolved in `package-lock.json` in parentheses.

| Layer | Present | Source |
|---|---|---|
| Monorepo | npm workspaces (`packages/*`, `services/api`, `apps/*`); TypeScript ^5.7.3 (5.9.3) | [package.json:7-11](package.json#L7-L11), [package.json:37-41](package.json#L37-L41) |
| Runtime | Node 24.x in CI; README says ≥20 | [ci.yml:20-24](.github/workflows/ci.yml#L20-L24), [README.md:85](README.md#L85) |
| API | Express ^4.21.2 (4.22.3), zod ^3.24.2 (3.25.76), jsonwebtoken ^9.0.2 (9.0.3), bcryptjs ^2.4.3, cookie-parser ^1.4.7, cors ^2.8.5 (2.8.6), dotenv ^16.4.7 (16.6.1) | [services/api/package.json:19-32](services/api/package.json#L19-L32) |
| ORM / DB | Prisma + @prisma/client ^6.3.1 (6.19.3), pg ^8.13.3 (8.23.1); PostgreSQL 16 (`postgres:16-alpine`) | [services/api/package.json](services/api/package.json), [compose.yaml:5](compose.yaml#L5) |
| Queue | BullMQ ^5.41.0 (5.81.5), ioredis ^5.6.0 (5.11.1); Redis 7 (`redis:7-alpine`) | [services/api/package.json:23-28](services/api/package.json#L23-L28), [compose.yaml:25](compose.yaml#L25) |
| Frontend | React ^18.3.1, Vite ^6.1.0 (6.4.4), Tailwind ^3.4.17 (3.4.19), lucide-react ^0.475.0 | [apps/web/package.json](apps/web/package.json) |
| Test (TS) | Vitest ^3.0.5 (3.2.7), Supertest ^7.0.0 (7.3.1), Testing Library, jsdom ^26 | [services/api/package.json:33-48](services/api/package.json#L33-L48), [apps/web/package.json:21-35](apps/web/package.json#L21-L35) |
| Python service | Python ≥3.11 (CI 3.12); fastapi==0.115.6, uvicorn==0.34.0, pydantic==2.10.4, pydantic-settings==2.7.0, httpx==0.28.1, pytest==8.3.4, pytest-asyncio==0.25.1 | [pyproject.toml:10](services/agent-service/pyproject.toml#L10), [requirements.txt](services/agent-service/requirements.txt) |
| CI | GitHub Actions: typecheck, API tests, web tests, build, pytest, `docker compose config` | [ci.yml](.github/workflows/ci.yml) |

**Absent from every manifest:** Django, DRF, Celery, LangGraph/LangChain, any LLM SDK (OpenAI/Anthropic/etc.), Qdrant or any vector DB, Semgrep, Next.js, MCP SDK, Octokit/GitHub SDK. A grep of all tracked source finds no imports of any of them; the only hits are a UI string and the technology-detector code that recognises those names in other repos.

---

## 3. Directory map

| Path | Purpose |
|---|---|
| [apps/web/](apps/web/) | React + Vite SPA dashboard on :5173; proxies `/api`, `/health` and `/ready` to :4000 ([vite.config.ts:10-23](apps/web/vite.config.ts#L10-L23)) |
| [apps/web/src/App.tsx](apps/web/src/App.tsx) | Tab "router" plus session/workspace state |
| [apps/web/src/api/client.ts](apps/web/src/api/client.ts) | Fetch wrapper for every API call; keeps the JWT in `sessionStorage` |
| [apps/web/src/components/](apps/web/src/components/) | AuthModal, Header, Sidebar, TaskInputForm, RecentTasks, RepoPlaceholder (repo records), RepositoryIntelligence (analysis UI); ExecutionPanel and MetricsOverview are static text |
| [packages/contracts/src/](packages/contracts/src/) | Shared Zod schemas and TS types (auth, workspaces, repositories, tasks, intelligence, errors, health). The API imports them **at runtime from `dist/`** ([contracts/package.json:5-13](packages/contracts/package.json#L5-L13)) |
| [services/api/src/server.ts](services/api/src/server.ts) | HTTP entry point (:4000); starts the outbox poller |
| [services/api/src/worker.ts](services/api/src/worker.ts) | BullMQ worker entry point (separate process, same package) |
| [services/api/src/app.ts](services/api/src/app.ts) | Middleware stack and router mounting |
| [services/api/src/config.ts](services/api/src/config.ts) | Zod-validated environment config |
| [services/api/src/routes/](services/api/src/routes/) | `health`, `auth`, `workspaces`, `repositories`, `intelligence`, `tasks` (including legacy routes) |
| [services/api/src/middlewares/](services/api/src/middlewares/) | JWT auth and workspace RBAC, error envelope, request id, request logging |
| [services/api/src/services/](services/api/src/services/) | Prisma client, pg pool and Redis (readiness probes only), queue, outbox, state machine, auth |
| [services/api/src/services/intelligence/](services/api/src/services/intelligence/) | snapshotCollector, technologyDetector, architectureSummarizer, relevanceRanker, repositoryAnalysisService |
| [services/api/prisma/](services/api/prisma/) | `schema.prisma` and 2 migrations (`20261021_init`, `20261021_phase3_intelligence`) |
| [services/api/tests/](services/api/tests/) | 61 Vitest tests |
| [services/agent-service/](services/agent-service/) | FastAPI skeleton: `/health`, `/ready`, `/api/v1/analyze` (mock); 5 pytest tests. The local `.venv/` is untracked |
| [workers/execution-worker/](workers/execution-worker/) | **README only** (sandbox design doc; no code) |
| [infra/docker/init-db.sql](infra/docker/init-db.sql) | Schema bootstrap mounted into the Postgres container ([compose.yaml:15](compose.yaml#L15)) |
| [compose.yaml](compose.yaml) | Local Postgres 16 and Redis 7 only, bound to 127.0.0.1 |
| [docs/](docs/) | architecture, development, security docs (Phase 3); several claims don't match the code (§6.4) |
| [scripts/run-python-tests.js](scripts/run-python-tests.js) | Runs pytest from the venv or system Python |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI pipeline |
| [.env.example](.env.example) | Env template. Variable names only (values not reproduced): `NODE_ENV, VITE_API_URL, VITE_PORT, PORT, HOST, CORS_ORIGIN, LOG_LEVEL, REQUEST_TIMEOUT_MS, JWT_SECRET, JWT_EXPIRES_IN, COOKIE_SECRET, COOKIE_SECURE, OUTBOX_POLL_INTERVAL_MS, OUTBOX_BATCH_SIZE, BULLMQ_WORKER_CONCURRENCY, AI_SERVICE_URL, AI_SERVICE_PORT, AI_SERVICE_HOST, LLM_PROVIDER, LLM_API_KEY (empty), MODEL_NAME, POSTGRES_*, DATABASE_URL, REDIS_HOST, REDIS_PORT, REDIS_REQUIRED_FOR_READINESS, REDIS_URL, EXECUTION_SANDBOX_ENABLED, ARBITRARY_SHELL_ENABLED`. Secret values look like dev placeholders, and no `.env` is committed ([.gitignore:7-9](.gitignore#L7-L9)) |

---

## 4. Component status vs. the ASEA plan

Status values: **Done**, **Partial** (some real working code), **Stub** (placeholder or mock), **Missing**.

| Component | Status | Evidence | Notes |
|---|---|---|---|
| Ingestion | **Partial** | [snapshotCollector.ts:319](services/api/src/services/intelligence/snapshotCollector.ts#L319), [repositoryAnalysisService.ts:16-31](services/api/src/services/intelligence/repositoryAnalysisService.ts#L16-L31) | Walks a **local directory** only. No PR, diff or commit ingestion; no git clone or fetch. A GitHub URL silently falls back to the server's `process.cwd()` ([:30](services/api/src/services/intelligence/repositoryAnalysisService.ts#L30)). Reusable: the path jail, symlink containment and secret-file filter ([snapshotCollector.ts:57-73](services/api/src/services/intelligence/snapshotCollector.ts#L57-L73), [:265-314](services/api/src/services/intelligence/snapshotCollector.ts#L265-L314)). |
| Static analysis | **Missing** | [architectureSummarizer.ts:200](services/api/src/services/intelligence/architectureSummarizer.ts#L200), [:235](services/api/src/services/intelligence/architectureSummarizer.ts#L235), [technologyDetector.ts:6](services/api/src/services/intelligence/technologyDetector.ts#L6) | No Semgrep, no Python `ast`, no findings model. What exists is regex import extraction (first 60 files only, [:184-186](services/api/src/services/intelligence/architectureSummarizer.ts#L184-L186)) and manifest-based technology detection. The commit message and [README.md:37](README.md#L37) call this "AST mapping"; it is regex. |
| RAG indexing | **Missing** | [relevanceRanker.ts:87-211](services/api/src/services/intelligence/relevanceRanker.ts#L87-L211) | No embeddings or vector store. The ranker matches prompt tokens against **file paths** only; file contents are never read. |
| Negative-space agent | **Missing** | — | No agent code; no LLM calls anywhere. |
| Architecture agent | **Missing** | [architectureSummarizer.ts:32](services/api/src/services/intelligence/architectureSummarizer.ts#L32) | Related: a deterministic repo-structure summary (entry points, directories, route files picked by filename). It is not an agent and does not evaluate a change. `confidence` is hardcoded to 0.95 or 0.2 ([:283](services/api/src/services/intelligence/architectureSummarizer.ts#L283)). |
| Scoring | **Missing** | [relevanceRanker.ts:115-172](services/api/src/services/intelligence/relevanceRanker.ts#L115-L172) | The only score is "file relevance to a prompt" (0–100). There is no merge-safety score or verdict. |
| Reporter | **Missing** | [analyze.py:8-24](services/agent-service/app/routers/analyze.py#L8-L24) | `/api/v1/analyze` returns fixed strings and `confidence=1.0`. |
| LangGraph wiring | **Missing** | [worker.ts:95-185](services/api/src/worker.ts#L95-L185) | "Orchestration" is a BullMQ job that writes 4 `WorkflowStep` rows with canned data, e.g. `auditPass: true` ([:179-183](services/api/src/worker.ts#L179-L183)). |
| Django models/API | **Missing** (Express + Prisma equivalent: **Done** for auth, workspaces, repos and tasks) | [schema.prisma:101-319](services/api/prisma/schema.prisma#L101-L319), [app.ts:43-47](services/api/src/app.ts#L43-L47) | No Django or DRF. The Express API works but has security holes (§6.1). |
| Celery jobs | **Missing** (BullMQ equivalent: **Partial**) | [worker.ts:266-289](services/api/src/worker.ts#L266-L289), [queueService.ts:48-70](services/api/src/services/queueService.ts#L48-L70), [outboxDispatcher.ts:8-62](services/api/src/services/outboxDispatcher.ts#L8-L62) | Outbox → BullMQ → worker works on paper. Retries can never succeed (B3), and cancelling a RUNNING task is ignored (B4). |
| Audit trail | **Partial** | [schema.prisma:262-279](services/api/prisma/schema.prisma#L262-L279), [worker.ts:205](services/api/src/worker.ts#L205), [worker.ts:248](services/api/src/worker.ts#L248) | The `AuditEvent` table exists. Only `TASK_COMPLETED` and `TASK_FAILED` are ever written. No hash chain (no `prevHash`/`hash`), no append-only enforcement, no read endpoint, and no audit of auth or API actions. |
| GitHub integration | **Missing** | [schema.prisma:22-25](services/api/prisma/schema.prisma#L22-L25) | Only a `GITHUB` enum value. No App, OAuth, webhook endpoint, signature verification, API client or PR comments. The UI calls it future work ([App.tsx:254](apps/web/src/App.tsx#L254)). |
| Dashboard | **Partial** | [App.tsx](apps/web/src/App.tsx), [RepositoryIntelligence.tsx:111-167](apps/web/src/components/RepositoryIntelligence.tsx#L111-L167) | Vite SPA, **not Next.js**. Real features: login/register, workspace switcher, repo records, task submit/list/cancel, analysis UI. Static marketing content: [ExecutionPanel.tsx:5-48](apps/web/src/components/ExecutionPanel.tsx#L5-L48) (claims OCI sandboxes, cgroup limits and syscall tracing that don't exist) and [MetricsOverview.tsx:10-47](apps/web/src/components/MetricsOverview.tsx#L10-L47). No PR or verdict views. |
| MCP | **Missing** | — | — |
| Tests | **Partial** | [services/api/tests/](services/api/tests/), [App.test.tsx](apps/web/src/App.test.tsx), [agent-service/tests/](services/agent-service/tests/) | 61 API, 8 web and 5 Python tests (the counts match [README.md:184-197](README.md#L184-L197)). Prisma is always stubbed with `vi.spyOn`, so there are no DB integration tests. [validation.test.ts:8-26](services/api/tests/validation.test.ts#L8-L26) only passes when the DB is **unreachable** (B5). The Python tests cover the mock only. |
| Docker setup | **Partial** | [compose.yaml:4-38](compose.yaml#L4-L38) | Postgres and Redis only. No Dockerfile for api, worker, web or agent-service. `init-db.sql` collides with the Prisma migrations (B1). |
| *(extra)* LLM provider abstraction | **Stub** | [config.py:12-14](services/agent-service/app/config.py#L12-L14), [analyze.py:22](services/agent-service/app/routers/analyze.py#L22) | `LLM_PROVIDER=local_mock` is only echoed back in responses. No SDK is installed. The Node API never calls the agent service: `AI_SERVICE_URL` is parsed ([config.ts:25](services/api/src/config.ts#L25)) but never used. |

---

## 5. Data models and API endpoints

### 5.1 Prisma models ([schema.prisma](services/api/prisma/schema.prisma))

All IDs are `String @default(uuid())`. Most models have `createdAt` and `updatedAt`.

| Model | Fields | Relations / notes |
|---|---|---|
| `User` (:101) | email (unique), passwordHash, displayName, accountStatus (`ACTIVE, SUSPENDED, DEACTIVATED`) | owns Workspaces; has memberships, tasks, approvals |
| `Workspace` (:119) | name, ownerId | the tenant boundary |
| `WorkspaceMembership` (:136) | workspaceId, userId, role (`OWNER, ADMIN, MEMBER`) | unique on (workspaceId, userId) |
| `Repository` (:151) | workspaceId, name, provider (`LOCAL, GITHUB`), repositoryUrl (a local path or URL), defaultBranch, connectionStatus | — |
| `Task` (:169) | workspaceId, repositoryId?, creatorId, title, description, taskType (`BUG_INVESTIGATION, CODE_PATCH, TEST_GENERATION, CODE_REVIEW, CI_DIAGNOSIS`), status (`QUEUED, RUNNING, COMPLETED, FAILED, CANCEL_REQUESTED, CANCELLED, NEEDS_ATTENTION`), priority, repositoryUrl?, targetBranch, idempotencyKey? (indexed, **not unique**), startedAt, completedAt, failureCode, failureReason, executionMetadata (Json) | — |
| `WorkflowRun` (:202) | taskId, attemptNumber, status, workerId, startedAt, finishedAt, errorSummary, configMetadata (Json) | — |
| `WorkflowStep` (:222) | workflowRunId, stepType (`VALIDATE_CONTEXT, INSPECT_REPOSITORY, GENERATE_SPEC, VERIFY_BOUNDARIES, SIMULATE_EXECUTION`), stepStatus, stepOrder, resultMetadata (Json), failureSummary | `SIMULATE_EXECUTION` is never used |
| `Approval` (:242) | taskId, workflowStepId?, status (`PENDING, APPROVED, REJECTED`), requestedById, decidedById?, reason | **no route reads or writes it** |
| `AuditEvent` (:262) | workspaceId?, actorId?, eventType, resourceType, resourceId?, metadata (Json), requestId?, timestamp | no hash fields |
| `OutboxEvent` (:281) | aggregateType, aggregateId, eventType, payload (Json), status (`PENDING, DISPATCHED, FAILED`), retryCount, dispatchedAt | — |
| `RepositoryAnalysis` (:296) | repositoryId, workspaceId, status (`PENDING, RUNNING, COMPLETED, FAILED`), analyzerVersion, summary / technologies / inventory / statistics (all Json), errorSummary, startedAt, completedAt | the whole file inventory is stored as one JSON blob |

### 5.2 Express API (`services/api`, port 4000)

"Member" / "Admin" means `requireAuth` plus `requireWorkspaceMembership(role)`.

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/health`, `/ready` | none | [health.ts:14](services/api/src/routes/health.ts#L14), [:27](services/api/src/routes/health.ts#L27) |
| POST | `/api/v1/auth/register`, `/login`, `/logout` | none | [auth.ts:13](services/api/src/routes/auth.ts#L13), [:32](services/api/src/routes/auth.ts#L32), [:50](services/api/src/routes/auth.ts#L50) |
| GET | `/api/v1/auth/me` | auth | [auth.ts:59](services/api/src/routes/auth.ts#L59) |
| GET, POST | `/api/v1/workspaces` | auth | [workspaces.ts:14](services/api/src/routes/workspaces.ts#L14), [:38](services/api/src/routes/workspaces.ts#L38) |
| GET / PATCH | `/api/v1/workspaces/:workspaceId` | Member / Admin | [workspaces.ts:75](services/api/src/routes/workspaces.ts#L75), [:96](services/api/src/routes/workspaces.ts#L96) |
| GET / POST | `/api/v1/workspaces/:ws/repositories` | Member / Admin | [repositories.ts:11](services/api/src/routes/repositories.ts#L11), [:41](services/api/src/routes/repositories.ts#L41) |
| GET | `/api/v1/workspaces/:ws/repositories/:repositoryId` | Member | [repositories.ts:77](services/api/src/routes/repositories.ts#L77) |
| POST | `…/repositories/:repositoryId/analyze` (runs **synchronously** in the request) | Member | [intelligence.ts:21](services/api/src/routes/intelligence.ts#L21) |
| GET | `…/repositories/:repositoryId/analysis/latest` | Member | [intelligence.ts:47](services/api/src/routes/intelligence.ts#L47) |
| GET | `…/repositories/:repositoryId/analysis/:analysisId` | Member | [intelligence.ts:77](services/api/src/routes/intelligence.ts#L77) |
| GET | `…/analysis/:analysisId/files?page&pageSize&category` | Member | [intelligence.ts:116](services/api/src/routes/intelligence.ts#L116) |
| POST | `…/repositories/:repositoryId/relevant-files` `{taskDescription, limit}` | Member | [intelligence.ts:152](services/api/src/routes/intelligence.ts#L152) |
| POST / GET | `/api/v1/workspaces/:ws/tasks` (GET accepts `?status&taskType`) | Member | [tasks.ts:73](services/api/src/routes/tasks.ts#L73), [:166](services/api/src/routes/tasks.ts#L166) |
| GET | `/api/v1/workspaces/:ws/tasks/:taskId` | Member | [tasks.ts:194](services/api/src/routes/tasks.ts#L194) |
| POST | `/api/v1/workspaces/:ws/tasks/:taskId/cancel` | Member | [tasks.ts:222](services/api/src/routes/tasks.ts#L222) |
| GET | `/api/v1/workspaces/:ws/tasks/:taskId/runs`, `/api/v1/workspaces/:ws/runs/:runId` | Member | [tasks.ts:281](services/api/src/routes/tasks.ts#L281), [:304](services/api/src/routes/tasks.ts#L304) |
| GET | `/api/v1/tasks` (legacy; returns a hardcoded demo task if the list is empty) | optional | [tasks.ts:334](services/api/src/routes/tasks.ts#L334) |
| POST | `/api/v1/tasks` (legacy) | **none** (see S1) | [tasks.ts:389](services/api/src/routes/tasks.ts#L389) |
| GET | `/api/v1/tasks/:id` (legacy; `task-demo-01` is hardcoded) | auth + membership check inline | [tasks.ts:504](services/api/src/routes/tasks.ts#L504) |
| GET | `/api/v1/system/info` (fully hardcoded) | none | [tasks.ts:556](services/api/src/routes/tasks.ts#L556) |

### 5.3 Agent service (`services/agent-service`, port 8000)

| Method | Path | Behaviour |
|---|---|---|
| GET | `/health` | uptime and environment ([health.py:12](services/agent-service/app/routers/health.py#L12)) |
| GET | `/ready` | always reports `ready` with `llm_provider: up` ([health.py:25-44](services/agent-service/app/routers/health.py#L25-L44)) |
| POST | `/api/v1/analyze` `{taskId, taskType, query, repositoryUrl?, targetBranch}` | hardcoded mock response ([analyze.py:8-24](services/agent-service/app/routers/analyze.py#L8-L24)) |

No endpoint in either service requires a webhook signature, because no webhook endpoints exist.

---

## 6. Problems found

### 6.1 Security

| # | Issue | Evidence |
|---|---|---|
| S1 | **Unauthenticated, cross-tenant task creation.** Legacy `POST /api/v1/tasks` has no auth. It takes `workspaceId` from the request body with no membership check. An anonymous caller is attributed to `prisma.user.findFirst()`, which is an arbitrary real user, and lands in that user's workspace. Authenticated users can also target any workspace ID they know. The web UI uses this route whenever no workspace is active. | [tasks.ts:389-475](services/api/src/routes/tasks.ts#L389-L475) (esp. [:395](services/api/src/routes/tasks.ts#L395), [:400](services/api/src/routes/tasks.ts#L400), [:414](services/api/src/routes/tasks.ts#L414)); contract allows `workspaceId` ([contracts/tasks.ts:109](packages/contracts/src/tasks.ts#L109)); UI fallback [TaskInputForm.tsx:41-42](apps/web/src/components/TaskInputForm.tsx#L41-L42) |
| S2 | **Server filesystem disclosure via repository analysis.** Any `repositoryUrl` that isn't an existing local path (for example a GitHub URL) resolves to the API process's `cwd`. `ALLOWED_REPO_ROOTS` also defaults to `cwd`. Any workspace member can therefore get a file inventory (paths, sizes, languages) of the server's own working directory. Relative `./`/`../` paths resolve against the server cwd. An ADMIN can register any directory under the allowed roots. Secret-named files are excluded; other files are not. | [repositoryAnalysisService.ts:16-31](services/api/src/services/intelligence/repositoryAnalysisService.ts#L16-L31), [config.ts:47](services/api/src/config.ts#L47), [repositories.ts:41-58](services/api/src/routes/repositories.ts#L41-L58) |
| S3 | **The JWT is readable by JavaScript.** The token is returned in the JSON body and stored in `sessionStorage`. That defeats the HttpOnly-cookie XSS protection the docs claim. | [auth.ts:26](services/api/src/routes/auth.ts#L26), [auth.ts:44](services/api/src/routes/auth.ts#L44), [client.ts:26-44](apps/web/src/api/client.ts#L26-L44) vs [docs/security.md:24](docs/security.md#L24), [:94](docs/security.md#L94) |
| S4 | **Account enumeration, and no rate limiting.** Register returns 409 "already exists". Login returns before running bcrypt when the email is unknown, which creates a timing oracle. No rate limiter exists anywhere (grep for `rate`, `helmet`, `csrf` finds nothing), despite the docs. | [authService.ts:63-64](services/api/src/services/authService.ts#L63-L64), [:115-117](services/api/src/services/authService.ts#L115-L117) vs [docs/architecture.md:82](docs/architecture.md#L82), [docs/security.md:89](docs/security.md#L89) |
| S5 | **Hardcoded fallback secrets.** There is a default JWT secret and cookie secret in code. The production guard only checks `JWT_SECRET`, and only when `NODE_ENV === 'production'` exactly. Default DB credentials are dev-only and bound to 127.0.0.1. No real API keys were found. | [config.ts:7](services/api/src/config.ts#L7), [:19](services/api/src/config.ts#L19), [:22](services/api/src/config.ts#L22), [:53-63](services/api/src/config.ts#L53-L63); [compose.yaml:8-12](compose.yaml#L8-L12) |
| S6 | **Event-loop DoS.** Analysis runs inside the HTTP request using only synchronous `fs` calls. The timeout is checked only between directories, so a single request can block the whole API for up to 30 s. `/relevant-files` also starts a full analysis automatically if none exists. Any MEMBER can trigger either. | [snapshotCollector.ts:339-352](services/api/src/services/intelligence/snapshotCollector.ts#L339-L352), [intelligence.ts:35](services/api/src/routes/intelligence.ts#L35), [repositoryAnalysisService.ts:223-224](services/api/src/services/intelligence/repositoryAnalysisService.ts#L223-L224) |
| S7 | **Stale sessions.** Suspended accounts keep access until their JWT expires (7 days by default), because `authenticate` never checks `accountStatus`. Logout only clears the cookie; tokens are not revoked. | [authMiddleware.ts:50-60](services/api/src/middlewares/authMiddleware.ts#L50-L60), [auth.ts:50-57](services/api/src/routes/auth.ts#L50-L57), [config.ts:20](services/api/src/config.ts#L20) |
| S8 | **Agent service has wildcard CORS with credentials and no auth.** Harmless while it returns a mock; not safe once it does real work. | [main.py:18-24](services/agent-service/app/main.py#L18-L24) |
| — | **Subprocess use.** None in service code. The only one is the test-runner script, which uses `shell: true` on Windows with constant arguments (low risk). | [run-python-tests.js:24](scripts/run-python-tests.js#L24) |
| — | **Webhook signature checks.** Not applicable: no webhook endpoints exist. Must be designed in for the GitHub App. | — |

### 6.2 Bugs and broken behaviour

| # | Issue | Evidence |
|---|---|---|
| B1 | **The documented setup conflicts with itself** (expected, not executed). On the container's first boot, `init-db.sql` creates every enum and table. Running `npm run prisma:migrate` afterwards, as the README instructs, executes `CREATE TYPE "AccountStatus"` with no `IF NOT EXISTS`, which should fail with "type already exists". | [init-db.sql:17-237](infra/docker/init-db.sql#L17-L237), [compose.yaml:15](compose.yaml#L15), [init migration.sql:2](services/api/prisma/migrations/20261021_init/migration.sql#L2), [README.md:105-135](README.md#L105-L135) |
| B2 | **A fresh clone probably won't build or test, and CI is likely red** (expected, not executed). The API imports Zod schemas at runtime from `packages/contracts/dist`, which is gitignored. The README setup never builds contracts, and CI runs `typecheck` and `test:api` before `build`. CI also never runs `prisma generate` before typechecking. (This machine has `dist/` and the generated client locally, so it may work here.) | [contracts/package.json:5-13](packages/contracts/package.json#L5-L13), [ci.yml:26-39](.github/workflows/ci.yml#L26-L39), [README.md:95-126](README.md#L95-L126) |
| B3 | **Worker retries can never succeed.** A failed attempt sets the task to `FAILED`, which is terminal, and rethrows for retry (`attempts: 3`). The next attempt calls `validateTaskTransition('FAILED','RUNNING')`, which throws. Each retry overwrites `failureReason` with "Illegal task state transition" and writes another `TASK_FAILED` audit row. | [worker.ts:73](services/api/src/worker.ts#L73), [:238-262](services/api/src/worker.ts#L238-L262), [queueService.ts:53](services/api/src/services/queueService.ts#L53), [workflowStateMachine.ts:12](services/api/src/services/workflowStateMachine.ts#L12) |
| B4 | **Cancelling a RUNNING task does nothing.** The worker never re-checks for `CANCEL_REQUESTED` and unconditionally writes `COMPLETED`, bypassing the state machine (`CANCEL_REQUESTED → COMPLETED` is illegal there). | [worker.ts:187-203](services/api/src/worker.ts#L187-L203), [workflowStateMachine.ts:8](services/api/src/services/workflowStateMachine.ts#L8) |
| B5 | **Legacy POST fakes success.** Any DB error is caught, and the handler returns HTTP 201 with an invented `task-<timestamp>` id and status `PENDING`, which isn't a DB enum value. A test asserts this fallback, so it fails when a DB *is* reachable. | [tasks.ts:476-498](services/api/src/routes/tasks.ts#L476-L498), [validation.test.ts:8-26](services/api/tests/validation.test.ts#L8-L26) |
| B6 | **GitHub repos analyse the wrong directory.** The analysis reports `COMPLETED` with data about the server's cwd (the same root cause as S2). | [repositoryAnalysisService.ts:30](services/api/src/services/intelligence/repositoryAnalysisService.ts#L30) |
| B7 | **The root `.env` is probably ignored** (expected). `dotenv.config()` reads `.env` from the cwd, and npm workspace scripts run from `services/api`. The defaults happen to match `.env.example`. The Prisma CLI needs `DATABASE_URL` in its environment ([schema.prisma:3](services/api/prisma/schema.prisma#L3)), so `prisma:migrate` may fail with "Environment variable not found". | [config.ts:5](services/api/src/config.ts#L5), [services/api/package.json:7-17](services/api/package.json#L7-L17) |
| B8 | **Contract and DB enum drift.** The contracts' `TaskStatusEnum` adds `PENDING`, `ANALYZING` and `EXECUTING`, which don't exist in Prisma. | [contracts/tasks.ts:17-28](packages/contracts/src/tasks.ts#L17-L28) vs [schema.prisma:48-56](services/api/prisma/schema.prisma#L48-L56) |
| B9 | **Unvalidated filters return 500.** `?status`/`?taskType` values are passed straight to Prisma, so an invalid enum value causes a 500 instead of a 400. | [tasks.ts:173-180](services/api/src/routes/tasks.ts#L173-L180) |
| B10 | **Idempotency is racy.** The handler does a find and then a create, and the key has only a non-unique index. | [tasks.ts:84-96](services/api/src/routes/tasks.ts#L84-L96), [schema.prisma:199](services/api/prisma/schema.prisma#L199) |
| B11 | **Wrong response fields.** `GET /workspaces/:id` returns `createdAt: new Date()` and no `updatedAt` (the contract requires one). A duplicate registration returns 409 with code `BAD_REQUEST`. `/auth/me` returns a 404 in a non-standard error shape. | [workspaces.ts:83-89](services/api/src/routes/workspaces.ts#L83-L89), [contracts/workspaces.ts:11](packages/contracts/src/workspaces.ts#L11), [authService.ts:64](services/api/src/services/authService.ts#L64), [auth.ts:74](services/api/src/routes/auth.ts#L74) |
| B12 | **Env vars that do nothing.** `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `BULLMQ_WORKER_CONCURRENCY`, `COOKIE_SECURE` and `ARBITRARY_SHELL_ENABLED` are never read; the code hardcodes 3000 ms, a batch of 50, concurrency 2, and cookie security based on `NODE_ENV`. `AI_SERVICE_URL` and `REQUEST_TIMEOUT_MS` are parsed but never used. | [.env.example:31-38](.env.example#L31-L38), [server.ts:21](services/api/src/server.ts#L21), [outboxDispatcher.ts:17](services/api/src/services/outboxDispatcher.ts#L17), [worker.ts:275](services/api/src/worker.ts#L275), [auth.ts:21](services/api/src/routes/auth.ts#L21), [config.ts:16](services/api/src/config.ts#L16), [:25](services/api/src/config.ts#L25) |
| B13 | **The outbox isn't safe with multiple instances.** It uses a plain `findMany` plus an in-process flag, not `FOR UPDATE SKIP LOCKED` as documented. A deterministic `jobId` softens the risk of duplicate enqueues. | [outboxDispatcher.ts:9-18](services/api/src/services/outboxDispatcher.ts#L9-L18), [queueService.ts:78](services/api/src/services/queueService.ts#L78) vs [docs/architecture.md:90](docs/architecture.md#L90) |
| B14 | **Snapshot limits leak.** Hitting the `maxTotalBytes` limit breaks out of the current directory only, and scanning continues in sibling directories. Limitation messages are duplicated. | [snapshotCollector.ts:446-449](services/api/src/services/intelligence/snapshotCollector.ts#L446-L449) |
| B15 | **Heuristic accuracy.** Python import resolution matches by `endsWith`, so false positives are likely (`import os` matches any `…/os.py`). Only 60 files are scanned for relationships. BullMQ is labelled `BUILD_TOOL`. Python frameworks are detected by substring (`'django'` anywhere in the text). | [architectureSummarizer.ts:240-242](services/api/src/services/intelligence/architectureSummarizer.ts#L240-L242), [:184-186](services/api/src/services/intelligence/architectureSummarizer.ts#L184-L186), [technologyDetector.ts:139-148](services/api/src/services/intelligence/technologyDetector.ts#L139-L148), [:200-248](services/api/src/services/intelligence/technologyDetector.ts#L200-L248) |
| B16 | **Run steps never render in the task list.** The list endpoint includes `runs` but not `steps`, while the UI tries to render `run.steps`. | [tasks.ts:182](services/api/src/routes/tasks.ts#L182), [RecentTasks.tsx:253](apps/web/src/components/RecentTasks.tsx#L253) |
| B17 | **Hardcoded worker identity.** `workerId` is always `'worker-bullmq-01'`, and the response formatter invents `executionMetadata` (`sandboxType: 'disposable-container'`) when it is null. | [worker.ts:90](services/api/src/worker.ts#L90), [tasks.ts:35-40](services/api/src/routes/tasks.ts#L35-L40) |
| B18 | **Missing `app/routers/__init__.py`.** It works as a namespace package, but it's inconsistent and may trip setuptools package discovery if the service is installed. | [services/agent-service/app/routers/](services/agent-service/app/routers/) |

### 6.3 Docs vs. code inconsistencies

| Docs claim | Code reality |
|---|---|
| "AST mapping" (commit `09aa8bb`, [README.md:37](README.md#L37)) | Regex ([architectureSummarizer.ts:200](services/api/src/services/intelligence/architectureSummarizer.ts#L200), [:235](services/api/src/services/intelligence/architectureSummarizer.ts#L235)) |
| Ranking weights +40/+20/+10/+8 (content)/+15 (test) ([docs/architecture.md:204-211](docs/architecture.md#L204-L211)) | +25/+12/+8/+10/+7/+5/+8/+6/+12/+4/+3, and **no content matching** ([relevanceRanker.ts:115-172](services/api/src/services/intelligence/relevanceRanker.ts#L115-L172)) |
| Actions `MODIFY`/`REFERENCE`/`EXTEND_TESTS` ([README.md:40](README.md#L40), [docs/architecture.md:212](docs/architecture.md#L212)) | Free-text strings ([relevanceRanker.ts:178-185](services/api/src/services/intelligence/relevanceRanker.ts#L178-L185)) |
| Queue `ae-tasks`, job ids `task:<id>:<run>`, status `PROCESSED`, `SKIP LOCKED` ([docs/architecture.md:90-91](docs/architecture.md#L90-L91)) | `task-execution`, `job-<id>-<run>`, `DISPATCHED`, plain `findMany` ([queueService.ts:6](services/api/src/services/queueService.ts#L6), [:78](services/api/src/services/queueService.ts#L78)) |
| bcrypt cost 12 ([docs/security.md:17](docs/security.md#L17), [App.tsx:297](apps/web/src/App.tsx#L297)) | Cost 10 ([authService.ts:14](services/api/src/services/authService.ts#L14)) |
| `RepositoryAnalysis` has `commitHash`, `fileInventory` ([docs/architecture.md:121](docs/architecture.md#L121)) | No `commitHash`; field is `inventory` ([schema.prisma:296-310](services/api/prisma/schema.prisma#L296-L310)) |
| Secret files recorded as `SECRET_EXCLUDED`; symlinks as `SYMLINK_ESCAPE` ([docs/security.md:64](docs/security.md#L64), [:76](docs/security.md#L76)) | Secret files are silently dropped; symlinks only appear as limitation text ([snapshotCollector.ts:379](services/api/src/services/intelligence/snapshotCollector.ts#L379), [:401-405](services/api/src/services/intelligence/snapshotCollector.ts#L401-L405)) |
| Binary sniffing over 1 KB for nulls *and* control characters ([docs/security.md:74](docs/security.md#L74)) | 512 bytes, null bytes only ([snapshotCollector.ts:151-160](services/api/src/services/intelligence/snapshotCollector.ts#L151-L160)) |
| `GET …/analysis` ([README.md:175](README.md#L175), [docs/development.md:151](docs/development.md#L151)) | `GET …/analysis/latest` ([intelligence.ts:48](services/api/src/routes/intelligence.ts#L48)) |
| Rate limiting ([docs/security.md:89](docs/security.md#L89)) | None |
| Sandbox, cgroups, syscall audit ([ExecutionPanel.tsx:5-48](apps/web/src/components/ExecutionPanel.tsx#L5-L48), [workers/execution-worker/README.md](workers/execution-worker/README.md)) | No code exists |
| Doc links ([README.md:210-213](README.md#L210-L213)) | Absolute `file:///c:/Users/sharm/...` paths that break for anyone else |

---

## 7. How to run it today

This is based only on what's in the repo; none of it was executed here.

**Prerequisites:** Node ≥20 (CI uses 24), npm, Python ≥3.11, Docker.

```bash
cp .env.example .env              # API likely reads .env from services/api, not root (B7); defaults match anyway
npm install
npm run build:contracts           # NOT in README, but required: API imports packages/contracts/dist at runtime (B2)
npm run prisma:generate
npm run docker:up                 # Postgres 16 + Redis 7 on 127.0.0.1; init-db.sql creates the schema on first boot
# Schema: either rely on init-db.sql, or run migrations on an EMPTY database. Not both (B1).
#   Migrations probably need DATABASE_URL exported in the shell (B7):
#   DATABASE_URL=postgresql://dev_user:dev_password@localhost:5432/autonomous_dev npm run prisma:migrate
npm run dev:all                   # API :4000, BullMQ worker, web :5173

# Python agent service (optional; nothing calls it)
cd services/agent-service && python -m venv .venv && .venv/Scripts/activate   # or: source .venv/bin/activate
pip install -r requirements.txt && cd ../..
npm run dev:agent                 # FastAPI :8000
```

**Test commands** (listed only, not run):

| Command | What it covers |
|---|---|
| `npm run test:api` | 61 Vitest tests; Prisma stubbed, no DB needed. One test requires the DB to be *down* (B5) |
| `npm run test:web` | 8 Vitest/RTL tests; API client stubbed |
| `npm run test:python` | 5 pytest tests against the mock agent service |
| `npm run typecheck` | Needs contracts built and the Prisma client generated first |
| `npm run build` | Contracts, then API, then web |

**Unknown:**

- Which schema path (`init-db.sql` or migrations) the authors actually use.
- Whether CI has ever passed; no run history is available in the repo.
- Whether the worker starts correctly under `tsx watch`. It depends on `process.argv[1]` ending in `worker.ts` ([worker.ts:292](services/api/src/worker.ts#L292)).

---

## 8. Recommended next 5 tasks

Ordered smallest and most unblocking first. These are scoping steps, not a rewrite plan.

1. **Decide the stack direction and write it down** (a decision, no code). The ASEA plan says Django/DRF + Celery + Next.js; this repo is Express/Prisma/BullMQ + Vite, plus a FastAPI service. Every later task's location depends on this choice. Either way, the Python service is the natural home for LangGraph, Semgrep and `ast`, all of which are Python-native.
2. **Get a reproducible fresh-clone baseline.** Pick one schema source (B1). Build contracts and run `prisma generate` before typecheck and tests in CI and the README (B2). Fix `.env` loading (B7). Make [validation.test.ts](services/api/tests/validation.test.ts) independent of DB availability (B5). Goal: green CI that can be trusted for every later change. If the decision is Django, the equivalent is a minimal compose + `migrate` + one passing test.
3. **Close the live holes in the existing API** (skip this if the Express API is being retired and isn't running anywhere). These are small, contained diffs:
   - require auth and membership on the legacy `POST /api/v1/tasks` (S1), or delete the legacy routes;
   - remove the `process.cwd()` fallback in `resolveRepositoryFsPath` (S2/B6);
   - stop returning and storing the JWT in `sessionStorage` (S3).
4. **Define ASEA's core contract and models before any agent code.**
   - Input: the PR (repo, base/head SHA, unified diff, changed files, author type: AI or human).
   - Output: `Finding`, `AgentResult`, `Score`/`Verdict`.
   - An append-only `AuditEvent` with `prevHash`/`hash`.

   Write these as Pydantic and/or Zod schemas plus DB tables. This unblocks the agents, scoring, reporter and dashboard in parallel.
5. **Build the first real pipeline node: deterministic static analysis on a diff.** In the Python service, accept the contract from task 4, run Semgrep and Python `ast` checks on the changed files only, and return `Finding`s, with pytest fixtures (a clean diff and a risky diff). It needs no LLM, Qdrant or GitHub, and it is the deterministic base that scoring depends on. Run Semgrep with argument lists (no shell), a timeout, and inside the existing path-jail rules.

After these five: GitHub App and webhook endpoint with HMAC signature verification, LangGraph wiring, Qdrant indexing, the LLM agents (negative-space, architecture), scoring, reporter, dashboard views, and MCP.

---

## 9. Session 1 changes

Goal: a clean, honest, reproducible baseline. No new features and no ASEA agent code. Branch `session-1-baseline`, one commit per task. Sections 1–8 above still describe the repo as it was at `09aa8bb`; their line references predate these commits.

Decisions recorded for this session (not revisited): keep Express + Prisma + BullMQ and React + Vite; the ASEA verification engine will live in `services/agent-service` (FastAPI); no Django, Next.js or Celery. This answers §8 task 1.

### 9.1 Fixed

| ID | Commit | Change |
|---|---|---|
| B1 | `0d49e0e` | Deleted `infra/docker/init-db.sql` and its compose mount; the postgres image creates the DB and user from `POSTGRES_*`. Prisma migrations are the only schema source. Added `migration_lock.toml`. New CI job applies migrations to an empty Postgres 16 and fails on schema drift. README explains how to reset an old dev volume. |
| B2, B7 | `0015f4a` | CI and README run `build:contracts` and `prisma:generate` before typecheck and tests. `config.ts` loads the repo-root `.env` by explicit path; `prisma:migrate` uses `dotenv-cli -e ../../.env`. |
| B5 | `fb2dd78` | Removed the legacy POST fake-success fallback. `validation.test.ts` stubs every Prisma call, so it passes with or without a reachable DB, and asserts that a DB error returns 500. |
| S1 | `bdc2ba6` | Deleted legacy `/api/v1/tasks`, `/api/v1/tasks/:id` and `/api/v1/system/info`. The web client only uses workspace-scoped routes; the task form is disabled until a workspace is active. |
| S2, B6 | `bdc2ba6` | No `process.cwd()` fallback. `ALLOWED_REPO_ROOTS` has no default: analysis returns 503 until it is set. Only absolute local paths inside the roots are accepted; anything else (GitHub URL, relative, missing, outside the roots) returns 400 before an analysis row is created. Empty entries in the roots list are ignored. |
| S3 | `bdc2ba6` | Register/login return only `{ user }`; the JWT is set only as the HttpOnly cookie. `client.ts` no longer stores or sends it (no `sessionStorage`). |
| B3 | `433280a` | Non-final failed attempts leave the task and run `RUNNING`, record `Attempt n of m failed: …` on the run, and rethrow so BullMQ retries. Only the final attempt (`attemptsMade + 1 >= opts.attempts`) marks them `FAILED` and writes `TASK_FAILED`. |
| B4 | `433280a` | The worker re-reads the task between steps, before completion, and after a failed attempt. On `CANCEL_REQUESTED` it moves the run and task to `CANCELLED` through `validateRunTransition` / `validateTaskTransition` and stops without a retry. Completion is validated by the state machine. |
| B17 | `a6311bf` | `workerId` is the real `${hostname}:${pid}`. Task responses no longer invent `executionMetadata` (`sandboxType: 'disposable-container'`). |
| Fake claims (§4 Dashboard, §6.3) | `a6311bf` | `ExecutionPanel` and the three static `MetricsOverview` tiles replaced with "Coming soon" states (the task-count tile is real and stays). "AST mapping" → "import extraction (regex)" in the UI, README and docs. Worker no longer writes `auditPass: true` or `status: 'verified_safe'`; `VERIFY_BOUNDARIES` says it is a placeholder. |

Docs touched along the way: `docs/security.md` (token delivery, removed legacy routes, required allowed roots), `docs/architecture.md`, `docs/development.md`, README test counts.

### 9.2 Test results at end of session

Run locally on Windows, Node 24, Python venv in `services/agent-service/.venv`.

| Command | Result |
|---|---|
| `npm run typecheck` | pass (contracts, api, web) |
| `npm run test:api` | 78 passed (13 files); was 61 |
| `npm run test:web` | 11 passed; was 8 |
| `npm run test:python` | 5 passed, 1 third-party deprecation warning (starlette `BlockingPortal`) |
| `npm run build` | pass |

New tests cover: removed legacy routes (404), rejected repository paths and unset roots, cookie-only login → `/auth/me`, worker retry → success, final-attempt failure, cancellation between steps / before completion / during a failed attempt / at pickup, real worker id, no invented `executionMetadata`, and the coming-soon UI states.

Not verified this session: the app running end to end in a browser with a real Redis-backed worker, and CI on GitHub (nothing was pushed).

### 9.3 Deferred

Found or left open during this session:

- **B3/B4 follow-ups.** Retries reuse one `WorkflowRun`, so steps that completed before a failure are recorded again by the retry; a `WorkflowRun` per attempt (the schema already has `attemptNumber`) would be cleaner but is a modelling change. A small race remains between the last status check and the `COMPLETED` write, and between the pickup check and the `RUNNING` write; a conditional `updateMany … where status` would close them.
- **S2 follow-up.** `POST …/repositories` still accepts any `repositoryUrl`; validation happens only at analysis time. Existing records with relative paths or GitHub URLs now get a 400 when analysed.
- **S3 follow-up.** The API still accepts `Authorization: Bearer` (used by tests and non-browser clients). Token revocation and suspended-account checks are S7 and were not touched.
- **Contracts.** `executionMetadata.sandboxType` is still an optional field in `packages/contracts/src/tasks.ts`, unused now. Enum drift (B8) is unchanged.
- **Not addressed this session:** S4, S5, S6, S7, S8; B8–B16 and B18; the rest of §6.3 docs drift (ranking weights, action names, queue/job names, bcrypt cost, `commitHash`, `SECRET_EXCLUDED`/`SYMLINK_ESCAPE`, binary-sniffing description in `docs/security.md`, `/analysis` vs `/analysis/latest`, rate limiting, absolute `file:///` doc links).
- **Intentionally unchanged.** The README "Product Vision" and agent-service "Roadmap" still mention AST code graphs; they describe planned work, not current behaviour.

---

## 10. Session 2 changes

Goal: the first deterministic ASEA verification path, end to end. No LLM, Qdrant, LangGraph or GitHub work. Branch `session-1-baseline` (continued), one commit per task.

Decisions recorded for this session (not revisited): Express + Prisma + BullMQ + React/Vite stay and Prisma owns the schema; `services/agent-service` is the ASEA verification engine and is **stateless** (it never touches Postgres; the Node worker persists everything). Decisions made during the session, on request:

- A VERIFICATION task's diff comes from **git on the registered local repository** (`baseSha..headSha`), not from the client.
- The **VerificationRun is created at submission** (QUEUED, holding baseSha, headSha, authorType and the requirement) and linked by a new nullable `VerificationRun.taskId`.
- VERIFICATION tasks run **VALIDATE_CONTEXT then STATIC_ANALYSIS only**; the placeholder steps stay for the other task types.

### 10.1 Done

| Task | Commit | Change |
|---|---|---|
| — | `c659909` | The audit moved from the untracked repo root to `docs/ASEA_AUDIT.md` (tracked). |
| 0. WorkflowRun per attempt (B3 follow-up) | `3238502` | Each BullMQ attempt has its own WorkflowRun (`attemptNumber = data.attemptNumber + attemptsMade`, found or created, so a stalled re-run reuses it). Every failed attempt marks its run FAILED; only the final attempt fails the task. Steps attach to their attempt's run. |
| 1. ASEA contract | `9ccf015` | `VerificationRequest`, `ChangedFile`, `Finding`, `StaticAnalysisResult` in Pydantic (`app/verification/contract.py`) and Zod (`packages/contracts/src/verification.ts`), snake_case on the wire. Sync test: the Zod schemas' JSON Schema is pinned in `packages/contracts/schemas/asea-contract.schema.json` (Vitest file snapshot); pytest normalises that file and Pydantic's `model_json_schema()` and compares them, and checks that the comparison catches drift. |
| 2. Prisma models + hash chain | `927b377` | `VerificationRun`, `VerificationFinding` and their enums; `AuditEvent.prevHash`/`hash` (nullable; only VerificationRun events are chained). `auditChain.ts`: `hash = sha256(prevHash + canonicalJson(all other event fields))`, genesis = 64 zeros; `verifyAuditChain` follows the links from genesis (input order does not matter) and detects edited fields, edited or missing links, deleted events and forks. Known-answer hash cross-checked with Python. |
| 3. Fixtures | `aac7acf` | `tests/fixtures/demo_app/` (Flask: services layer, `@login_required`, `validate_payload()`, tests) and `diffs/` (`clean`, `missing_auth`, `secret_and_sql`, `no_tests`), each with `*.expected_findings.json`. The diffs are real `git diff` output; expected lines were located by text search, not by the analyzer. |
| 4. Static-analysis node | `4d9e420` | `POST /api/v1/verify/static`. Python ast checks limited to the changed lines (unidiff; added lines plus removal points): `ROUTE-NO-AUTH` (configurable decorators), `BARE-EXCEPT`, `HARDCODED-SECRET` (value redacted), `SUBPROCESS-SHELL`, `EVAL-EXEC`, `SQL-STRING-FORMAT`, `TEST-GAP`, plus `PARSE-ERROR`. Semgrep (`p/python`, `--json`, argument list, timeout) runs on the changed files in a temp dir; if unavailable it is listed in `tools_unavailable` and the ast results are still returned; a Semgrep result on a file+line the ast checks reported is merged into that finding. WSL and Docker usage is documented in the agent-service README. |
| 5. Agent hardening (S8) | `be5aaf6` | CORS removed; `X-Internal-Token` required on `/api/v1/*` (constant-time compare; 503 while `INTERNAL_SERVICE_TOKEN` is unset); 413 above `AGENT_MAX_REQUEST_BYTES` for declared and streamed bodies. |
| 6. End to end | `edf33e6`, `8a84640` | VERIFICATION task type; submission creates the VerificationRun in the task's transaction. The worker builds the request with git (`execFile`, no shell, timeout, SHA validation, `--no-ext-diff --no-textconv` and `-c` overrides so repository config cannot run commands), calls the agent at `AI_SERVICE_URL` (now used) with the token, persists the findings and hash-chained events (`VERIFICATION_STARTED`, `STATIC_ANALYSIS_COMPLETED` with a digest of the findings, `VERIFICATION_COMPLETED`; or `VERIFICATION_ATTEMPT_FAILED` / `VERIFICATION_FAILED`), and writes the STATIC_ANALYSIS step. Routes: list runs (`?taskId`), get a run, findings (`?severity`), `audit/verify` (chain result plus `findingsDigestValid`). score and verdict stay null. `8a84640` raises the timeout of the git-based builder tests (see 10.2). |

IDs closed or advanced: **S8** fixed; **B3** follow-up (per-attempt runs) done; **B12** in part (`AI_SERVICE_URL` is used); §4 "Audit trail" now has a hash chain for verification runs; §8 tasks 4 and 5 (contract, first deterministic node) done.

### 10.2 Test results at end of session

Run locally on Windows, Node 24, Python venv in `services/agent-service/.venv`.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:api` | 111 passed (19 files); was 78 |
| `npm run test:web` | 11 passed |
| `npm run test:python` | 60 passed, 1 third-party deprecation warning (starlette); was 5 |
| `npm run build` | pass |

The first end-of-session run had one failure: the git builder test that checks repository-configured commands are not run. It reproduced twice with typecheck running concurrently (5.0 s against Vitest's 5 s default; it spawns about a dozen git processes) and passed twice under the same load once its timeout was raised to 30 s (`8a84640`). The results above are after that fix.

Checked beyond the automated suites, using throwaway containers (the dev database was not touched):

- All four migrations apply to an empty Postgres 16, and `prisma migrate diff --exit-code` reports no drift (checked after tasks 2 and 6).
- A hash chain written through Prisma verifies after the JSONB round trip; a direct SQL edit is detected.
- Real Semgrep (`semgrep/semgrep:1.181.0` via Docker): the fixtures give the same findings, raw paths and lines map correctly, and an ast + Semgrep hit on one line becomes one finding. `p/python` itself does not flag the fixtures' f-string SQL or `eval()`; the ast checks do.
- `demo_app`'s own tests pass (with Flask installed) at the base and after `git apply` of each fixture diff.
- End to end: real agent service (token enforced), a git repo built from the fixtures, a task submitted through the API and processed by the worker. Task COMPLETED with steps VALIDATE_CONTEXT, STATIC_ANALYSIS; 2 findings matching the fixtures; `audit/verify` valid; a SQL edit to a finding gives `findingsDigestValid: false` and a SQL edit to an audit event breaks the chain.

Not verified: the full stack with Redis/BullMQ running (the worker function was invoked directly), and CI on GitHub (nothing was pushed).

### 10.3 Deferred

- **Semgrep.** Not installable natively on this Windows machine; the automated tests fake the process. `p/python` is fetched from the registry at run time, so the rule content is not pinned. Semgrep results are filtered to the changed lines, like the ast checks.
- **Check heuristics.** Python only. `TEST-GAP` sees only the test files included in the request (the engine is stateless) and matches by name; route handlers are excluded. `SQL-STRING-FORMAT` only inspects the argument passed directly to `execute()`. Route detection covers `@x.route/get/post/put/patch/delete(...)`. Secret detection is name-based.
- **Audit chain.** Removing the newest events is not detectable without storing the head hash on the VerificationRun. Task-level events (`TASK_*`) are not chained. Appends assume one writer per run.
- **Verification lifecycle.** There is no CANCELLED status, so a VERIFICATION task cancelled before STATIC_ANALYSIS leaves its VerificationRun QUEUED. A failed STATIC_ANALYSIS step is not stored as a FAILED WorkflowStep (the same as the other steps; the error is on the WorkflowRun and in the chain). Configuration errors (missing token, bad repository path) are retried like transient ones.
- **Worker host.** Needs `git` installed; repositories owned by another OS user may hit git's `safe.directory` check. Non-UTF-8 text files are decoded lossily.
- **Agent service.** `/docs` and `/openapi.json` are unauthenticated. `(taskId, attemptNumber)` on WorkflowRun is not unique.
- **No UI** for VERIFICATION tasks or findings.
- **Carried over** from §9.3 and not addressed: S4–S7, B8–B11, B13–B16, B18, registration-time validation of repository URLs (S2 follow-up), the remaining §6.3 docs drift.
- **Out of scope by decision:** scoring/verdict, LLM agents, Qdrant, LangGraph, GitHub.
