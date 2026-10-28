# Implementation Status

## Initial audit snapshot — 2026-10-22

This snapshot records the repository before application-code changes in this audit. The checkout already contained user changes before work began; those files were inspected and preserved. Source presence is not treated as proof of live integration. “Verified” means exercised by the listed automated check, and does not imply production readiness.

### Baseline: working and verified

- [x] TypeScript workspace typecheck completes (`npm run typecheck`).
- [x] API unit/service/route suite passes: 202 tests in 27 files (`npm run test:api`). The suite uses mocks for persistence, queues, GitHub, and the agent service in many workflows; this is not a live end-to-end result.
- [x] Python agent-service suite passes: 156 tests (`npm run test:python`). LLM provider and external-tool behavior is mostly exercised with deterministic fixtures/mocks.
- [x] API source contains cookie-based registration/login, workspace membership checks, repository and task APIs, a PostgreSQL transactional outbox, BullMQ worker, repository analysis, verification runs, policy profiles, GitHub webhook signature checks, and health/readiness routes.
- [x] The verification path has explicit task/run persistence, cancellation/retry handling, a hash-chained audit record, deterministic static checks, optional LLM agents, and a final report. Its API/worker behavior is covered by the passing API tests.
- [x] The Python service exposes bounded request sizes, internal-token middleware, deterministic analysis/verification, a LangGraph pipeline, and health/readiness routes. Its test suite passes.
- [x] Docker and Docker Compose are installed. The checked Compose project has no running containers.

### Baseline: implemented but not verified live

- [ ] PostgreSQL schema and migrations exist, including workspaces, memberships, repositories, tasks, workflow runs/steps, analysis, verification, policy, and audit data. No project `.env` or database connection is configured, so migration state and live persistence were not checked.
- [ ] Redis/BullMQ queues and transactional outbox recovery are implemented. No Redis service is running, so live enqueue/worker recovery was not checked.
- [ ] Local repository inventory, architecture extraction, file ranking, and Qdrant-backed code indexing are implemented with file/byte/time bounds. No configured repository root or live repository-analysis run was available.
- [ ] The React/Vite application has authentication/session, dashboard, repository, verification, run-detail, policy, and settings pages wired to API helpers. The current modified frontend typechecks, but it has no discovered runnable tests (the former `App.test.tsx` is renamed to `.bak`). Build and browser behavior remain unverified.
- [ ] GitHub webhook processing, PR commit retrieval, and PR result comments are implemented in source. No GitHub credential or remote repository is configured, so live GitHub behavior was not verified.
- [ ] Docker Compose definitions and an E2E test harness exist. No stack services were started and no live E2E run was performed.

### Baseline: partially implemented

- [ ] Authentication uses password hashing and signed JWT cookies, but logout only clears the browser cookie; previously copied JWTs are not revoked. Password reset/change and server-side session invalidation are absent.
- [ ] Workspace creation/list/read/update and role checks exist. Member listing, invitation delivery/acceptance, and member role/removal APIs are absent.
- [ ] Repository registration and local branch metadata exist. GitHub association currently configures a webhook secret and repository name; there is no GitHub App installation/repository picker or general authenticated GitHub connection flow.
- [ ] Task persistence, queueing, retries, cancellation, workflow runs, and verification-task handling exist. The worker does not provide the requested natural-language engineering workflow that edits code, runs its tests, and returns a patch.
- [ ] Dashboard statistics and system status are calculated from database/configuration state, but no live database-backed dashboard was checked.
- [ ] The policy subsystem computes review scores and verdicts. Human approval records and an approval enforcement workflow are absent.
- [ ] Webhook authenticity and duplicate handling are implemented. Pull request creation, branch/commit publication, PR status/CI synchronization, and GitHub App lifecycle are absent.

### Baseline: mocked or placeholder

- [ ] Many API tests replace Prisma, Redis/BullMQ, the agent-service HTTP client, and GitHub with mocks; passing these tests does not verify the full user-to-PR journey.
- [ ] The legacy frontend test was moved to `apps/web/src/test/legacy-App.test.tsx.bak`; Vitest reports “No test files found” for the current frontend.
- [ ] LLM-dependent analysis/review stages explicitly skip when provider credentials are missing. This is an honest unavailable state, not a completed AI review.
- [ ] Repository records can describe a local checkout and a GitHub name, but that metadata alone does not prove remote access or a working GitHub App connection.

### Baseline: missing

- [ ] Isolated disposable sandbox for untrusted repository commands, tests, and generated code.
- [ ] Explicit AI patch generation, safe patch application, rollback, and bounded repair workflow.
- [ ] Human approval APIs/UI and durable reviewer decisions.
- [ ] Branch/commit/PR creation and CI status synchronization.
- [ ] Frontend automated coverage for registration/login, workspace selection, repository analysis, verification submission, and result review.
- [ ] A complete endpoint reference and implementation status (this file is the first audit snapshot).
- [ ] Production deployment automation and operational monitoring beyond health/readiness endpoints.

### Baseline: blocked by external configuration

- [ ] Live database and Redis verification: no `.env` file, no corresponding Compose containers, and no database/Redis environment variables were present in the current process.
- [ ] Live LLM analysis: no provider/API-key environment variables were configured.
- [ ] Live GitHub operations: no GitHub token or Git remote was configured.
- [ ] Repository analysis: `ALLOWED_REPO_ROOTS` is unset, so the service has no authorized repository root for a live scan.
- [ ] Python service and end-to-end application startup: internal service token and application runtime settings are not configured in the current process.

## Environment and baseline checks

- Project root: `C:\Users\sharm\OneDrive\Desktop\miniprject`
- OS/shell: Windows, PowerShell 7.6.5
- Runtime: Node.js 24.12.0, npm 11.7.0, Python 3.12.10
- Stack: npm workspaces; React/Vite/TypeScript; Express/TypeScript; Prisma/PostgreSQL; Redis/BullMQ; FastAPI/Python; Docker Compose
- Branch: `session-1-baseline`; no Git remote was listed
- Recent commits: GitHub signed PR webhooks/comments; repository indexing and streamed worker pipeline; LangGraph verification/provider/Qdrant; E2E Compose/test harness
- Initial working tree: user changes were already present in the frontend, API, shared contracts, E2E setup, package lock, deleted legacy components, and replacement pages/components. No changes were reset or staged by this audit.
- Baseline checks: `npm run typecheck` passed; `npm run test:api` passed (202/202); `npm run test:python` passed (156/156); `npm test` failed because the current frontend has no matching test files (API portion passed).
- Live services: none confirmed running; no application URL is claimed.

## Current status after audit work — 2026-10-22

### Working and verified after continuation work

- [x] Redis-backed registration/login sessions have expiring server-side state. Logout atomically revokes the `jti`, and protected requests reject replayed cookies. The real Docker E2E test checks a copied cookie before and after logout.
- [x] Auth rate counters use Redis Lua operations and are shared across API processes. Redis failures fail closed; production rejects `AUTH_STATE_STORE=memory`.
- [x] CSRF protection rejects mismatched browser origins and cookie-authenticated unsafe requests without `Origin`/`Referer`; native originless requests without cookies remain supported.
- [x] Durable approval request/decision APIs bind records to a patch hash, enforce workspace admin/owner decision rights, prohibit requester self-approval, reject stale or duplicate decisions, and write audit events transactionally. Seven route tests cover the authorization and state rules.
- [x] The worker now connects the model proposal boundary to the task workspace and safe patch applicator. It creates a bounded, secret-filtered snapshot, uses authorized local roots, permits one repair after an invalid diff, applies only inside the disposable directory, and removes the directory after use. The original checkout remains read-only.
- [x] Valid proposals are persisted with snapshot/patch hashes, plan, context and changed-file lists, unified diff, explicit test/security/cleanup statuses, workflow steps, pending second-review approval, and audit records in a database transaction. Approval decisions also update the patch artifact transactionally.
- [x] The task and approval UI supports task creation, status/history, cancellation, diff review, pending approvals, and role-gated decisions via the real API. The UI labels test/security checks and GitHub/CI publication as unavailable.
- [x] The sandbox provider is explicitly unavailable and cannot fall back to host process execution. Unsupported non-verification task types end in `NEEDS_ATTENTION` with `WORKFLOW_UNAVAILABLE` rather than a false completion.
- [x] The provider-backed proposal API calls the configured LLM using bounded, fenced context; it returns a schema-validated summary, plan, and diff. Missing providers return an unavailable error, and no test execution or patch security scan is implied.
- [x] Verification after the security/patch continuation: API suite passed 254/254 across 37 files (Vitest hook timeout set to 30 seconds for the Windows Git fixture), frontend suite passed 4/4, and Python suite passed 161/161. The prior disposable Docker E2E passed 13/13 across five suites, including Redis-backed copied-cookie revocation, PostgreSQL-backed second-person patch approval, fake-provider patch generation/application/persistence, and existing verification/webhook flows. The E2E stack uses a deterministic fake LLM/GitHub, not live accounts.
- [x] `npm run typecheck`, `npm run lint` (which delegates to typecheck), `npm run build`, and `git diff --check` passed. Docker build ownership is set for `/task-workspaces`, which is mounted as a named volume for the non-root worker.
- [x] Workspace detail returns persisted `createdAt` and `updatedAt`; regression coverage was added.
- [x] The default LLM provider is now `anthropic`. Without a configured API key, LLM stages are skipped and deterministic results/fallback reporting are used. The deterministic `fake` provider is explicit and used by tests/E2E only.
- [x] The legacy `/api/v1/analyze` placeholder returns `501 NOT_IMPLEMENTED` instead of fixed mock insights.
- [x] Login and registration use configurable per-IP attempt limits and return `429 RATE_LIMITED`; unknown-email login performs a dummy bcrypt comparison to reduce timing-based enumeration.
- [x] `docs/API_REFERENCE.md` describes the mounted Node and Python APIs; this document records baseline and current gaps.

### Still missing or incomplete at the 2026-10-22 checkpoint (superseded below where noted)

- [ ] Repository tests and patch static/security analysis do not run. No verified sandbox boundary with network disabled, resource limits, cancellation, and cleanup is configured; task artifacts correctly report `NOT_RUN` and `BOUNDARY_VALIDATED_NO_SCAN`.
- [ ] Bounded CI repair proposals, sandbox re-runs, and verification after repair are not implemented because the safe execution provider is unavailable.
- [ ] Workspace invitation/member-management APIs and password reset/change are absent.
- [ ] Live Anthropic and GitHub App smoke tests remain blocked because no provider/App credentials, configured Git remote, user database/Redis/index, or authorized repository root is configured on the host.
- [ ] The current session cannot run Docker-backed E2E: Docker Compose cannot connect to the Docker Desktop Linux engine pipe. The earlier E2E result remains valid for that prior disposable run, but was not repeated during this continuation.

### Capability classification after GitHub App continuation — 2026-10-22

| Capability | Classification | Evidence and limits |
|---|---|---|
| Session revocation, shared auth limits, and CSRF | Implemented and verified | Redis store and auth route tests; copied-cookie revocation was also exercised by the prior disposable E2E. Live host Redis is not configured. |
| Isolated patch proposal, validation, and persistence | Implemented and verified with deterministic fixtures | API/workflow tests and prior fake-provider E2E cover the disposable snapshot and patch artifact flow. No real LLM call was made in this environment. |
| Repository test execution and patch security scanning | Missing; blocked by sandbox infrastructure | The execution provider stays unavailable and does not fall back to host execution. The API leaves these results explicitly not passed. |
| Durable second-person patch approval | Implemented and verified | Route/transaction tests and prior PostgreSQL-backed disposable E2E cover authorization, hash binding, and audit persistence. |
| GitHub App installation, repository selection, branch/commit/PR publication, and CI status sync | Implemented; mocked boundary verified; live integration unverified | Focused mocked API/client/publisher tests cover OAuth installation ownership, one-use selection, stale-base rejection, idempotent publication, and CI summaries. No live App credentials were available; publication is currently blocked by the sandbox and security gates. |
| CI failure diagnosis | Implemented and verified with mocked GitHub responses; live integration unverified | Sync and signed webhooks persist bounded check summaries, secret-redacted GitHub annotations, valid affected-file paths, and an evidence-only diagnosis. It does not invent causes beyond GitHub annotations. |
| CI repair and sandbox re-run | Missing; blocked by sandbox infrastructure | No proposed repair is executed or marked fixed. Tests remain unavailable until the isolated sandbox is configured. |
| Task and approval frontend lifecycle | Implemented and verified with mocked APIs | Five frontend tests cover auth, verification submission, patch review/approval, and displaying a CI annotation diagnosis. No browser-backed live app run was performed. |
| Docker-backed E2E in this continuation | Blocked by local Docker engine | `docker compose ls` failed because `//./pipe/dockerDesktopLinuxEngine` was unavailable. Existing project `asea-e2e` was not modified. |

### Verification after GitHub App continuation — 2026-10-22

- The focused GitHub/publisher/patch-workspace/session-store run passed 50 tests across eight files. The complete API suite passed 257/257 tests across 37 files.
- Frontend tests passed 5/5, including a check that the actual GitHub annotation and pull request link render from persisted task data. The first aggregate `npm run test:all` attempt exposed a stale frontend fixture; the frontend suite passed after that fixture was updated.
- Python tests passed 161/161. `npm run typecheck`, `npm run lint` (typecheck alias), `npm run build`, `npx prisma validate --schema services/api/prisma/schema.prisma`, and `git diff --check` passed.
- Docker-backed E2E was not rerun because the Docker Desktop Linux engine pipe was unavailable. The 13/13 E2E result above is from the earlier disposable-stack run and uses test-only fake integrations.

### Data preservation

- Existing staged, unstaged, and untracked user changes were preserved; no staging or commits were performed.
- The default `asea-e2e` Docker volumes were not touched. E2E used project `codex-auth-20261022` and ports `18081` / `18100`; its containers, network, and uniquely named volumes were removed afterward.
- Patch-flow verification used the separate project `codex-patch-flow-20261022` on ports `18083` / `18102`. Its containers, network, volumes, and generated `.asea` environment file were removed after the passing run; the pre-existing `asea-e2e` project remains running.

## Priority follow-up

1. Supply and verify a real sandbox provider and patch security scanner before allowing repository tests or PR publication.
2. Implement bounded CI repair after the sandbox and scanner can safely validate candidate repairs. CI failure diagnosis is implemented, but no repair is proposed or applied.
3. Configure a real GitHub App and LLM provider, then run explicit live installation, publication, and provider smoke tests when credentials are available.
4. Add workspace invitation/member-management and password reset/change flows.

## Current status after secure sandbox and verification phase — 2026-10-23

This section is the latest source-based status and supersedes older “still missing” statements above where this phase changed the implementation. It distinguishes code and mock-backed coverage from execution against live infrastructure.

### Implemented in this phase

- [x] Added an opt-in `DockerSandboxProvider` and a fail-closed unavailable provider. The provider accepts only exact argv vectors, mounts one canonical task workspace, disables networking, runs non-root with a read-only root filesystem, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs/output, and both worker-side and in-container command deadlines. Cancellation force-removes the named container; a task that outlives a worker is bounded by the in-container deadline and Docker `--rm` cleanup.
- [x] Added a pinned local execution image with Gitleaks, Semgrep local rules, OSV-Scanner, and pytest. The task container receives no Docker socket, app credentials, or task-time network access. Compose keeps the provider explicitly unavailable because its worker has no Docker CLI or daemon socket.
- [x] Added conservative manifest-only test detection and exact command policy for Node's built-in test runner, offline npm test variants, and pytest. Repository commands run only through the sandbox provider. Reports retain actual command, exit code, duration, bounded stdout/stderr, truncation, and passed/failed/timed-out/cancelled/not-run state. No dependency installation occurs.
- [x] Added Gitleaks, pinned Semgrep local rules, and offline OSV scanning. Tool versions, statuses, bounded findings/evidence, and limitations are persisted; Gitleaks matched secret text is not persisted. Image-baked Gitleaks/OSV configs override repository exceptions, Semgrep inline suppressions and Git ignores are disabled, and a repository `.semgrepignore` prevents Semgrep from being treated as clean. OSV findings are parsed even when the scanner exits nonzero for findings.
- [x] Added a separately configured independent patch-review endpoint and wired proposal evidence, tests, scans, review, and sandbox diagnostics through the task workflow and `TaskPatch` persistence. Source-file hashes are checked after tests so a test process that changes snapshot files cannot produce a passing result.
- [x] Made every patch attempt use a unique host/PID-tagged workspace and added a startup reaper that removes only recognized direct-child workspaces for this host whose recorded worker PID is confirmed dead. Reaper failures are visible and fail safe; retry paths no longer collide with a stale snapshot.
- [x] Approval creation and GitHub publication now require tests, security scans, and independent review all to be `PASSED`, in addition to the existing current-patch/hash-bound human approval checks. Failure, unavailable, skipped, and not-run states block publication.
- [x] Updated the task UI, API reference, local development instructions, and security threat model to display these results and identify the unavailable runtime honestly.

### Verification performed in this phase

- The complete API suite passed **275/275 tests across 39 files** after adding startup workspace recovery, using `npm run test --workspace=@autonomous-engineer/api -- --maxWorkers=1 --minWorkers=1 --hookTimeout=30000 --reporter=dot`.
- Focused engineering tests passed **34/34** across five files, including the host/PID-scoped stale-workspace reaper. They use a scripted sandbox for integration logic and a local Node process for timeout/cancel primitive tests; they do not execute a repository inside Docker.
- Frontend tests passed **5/5**. Python agent-service tests passed **164/164** (one upstream Starlette/AnyIO deprecation warning).
- `npm run lint` passed; it delegates to the workspace TypeScript typecheck. `npm run build` passed contracts, API/Prisma client generation and compilation, and the Vite production bundle.
- `npx prisma validate --schema services/api/prisma/schema.prisma` passed with a process-local placeholder `DATABASE_URL`; the first invocation without a database URL correctly failed before schema validation.
- `git diff --check` and `git diff --cached --check` passed after the final documentation update. Existing staged, unstaged, and untracked work was left in place; no stage, commit, reset, clean, or delete operation was performed.

### Not verified or still incomplete

- [ ] Live Docker execution and Docker image build: the host Docker CLI cannot reach `//./pipe/dockerDesktopLinuxEngine`. Therefore the image, GNU timeout behavior inside Docker, bind mounts, scanner binaries/rules/database, and actual repository test execution remain unverified in this session. The test fakes do not prove those live behaviors.
- [ ] Live database/Redis, LLM proposal/reviewer, and GitHub App operations remain unverified because no working services or credentials are configured. No live branch, commit, PR, or CI result was created. The reviewer is unavailable by default, which blocks approval/publication.
- [ ] The standard Compose worker remains sandbox-disabled. To enable local execution, build the trusted image and run the worker directly on a host with Docker Engine access as documented in `docs/development.md`.
- [ ] Tests that require third-party project dependencies absent from the tool image/cache can fail. The platform does not install dependencies from an untrusted repository or fetch them over the network.
- [ ] Ordinary Docker reduces exposure but is not a complete boundary against a hostile kernel, Docker daemon, or container escape. Use a hardened VM/sandbox runtime for high-risk untrusted repositories; do not describe this phase as hostile-code proof.
- [ ] The OSV database is a trusted image-build snapshot and becomes stale until the image is rebuilt. Semgrep uses only the packaged local rules, and a clean scan is not a security guarantee.
- [ ] CI repair/re-run, workspace invitations/member management, password reset/change, task retry, and live external-service smoke tests remain outside the completed scope.

### Current environment blockers

| Dependency | Observed state | What is needed |
|---|---|---|
| Docker Engine | Docker Desktop is installed, but `com.docker.service` is `STOPPED`; `desktop-linux` has no reachable Engine pipe. | Start Docker Desktop manually, wait for the Linux Engine to become ready, then build the trusted sandbox image and run live sandbox/E2E checks. |
| Database and Redis | `postgres.exe` listens on 5432 and `redis-server.exe` on 6379; Redis answered a read-only `PING`. No project `.env` or `DATABASE_URL`/`REDIS_URL` process configuration selects an expendable test target. | Identify an isolated development/test database and Redis before migrations, task writes, queue tests, or restart-recovery tests. Existing local service data was not modified. |
| Proposal and review LLMs | No proposal/reviewer credentials or provider identity were configured in the process environment. | Configure proposal and distinct reviewer credentials, then run provider-backed smoke tests with cost authorization. |
| GitHub App | No App credentials or configured Git remote were available. | Configure an App installation and an authorized test repository before live publication, signed webhook, and CI checks. |

## Latest real-execution environment diagnosis — 2026-10-23

### Environment observations

- Docker CLI **28.0.1** and Compose **v2.33.1** are installed; the selected context is `desktop-linux`. `docker version` reports the client but cannot contact the server at `//./pipe/dockerDesktopLinuxEngine`; `docker info` reports the same failure.
- Docker Desktop is installed at `C:\Program Files\Docker\Docker\Docker Desktop.exe`. No Desktop process was running, the `com.docker.service` Windows service was `STOPPED`, and `docker desktop status` reported that Desktop was not running. Desktop was not started by this run; the user must start it.
- `docker compose -f compose.stack.yaml config --quiet` and the stack plus E2E override static configuration both passed with process-local placeholder values for required Compose variables. The Compose worker explicitly sets `SANDBOX_PROVIDER=unavailable`, mounts repository/task-workspace volumes, and has no Docker socket mount.
- The documented host-worker command is `npm run dev:worker`; the opt-in provider requires `SANDBOX_PROVIDER`, `SANDBOX_DOCKER_IMAGE`, `SANDBOX_DOCKER_EXECUTABLE`, `TASK_WORKSPACE_ROOT`, and `ALLOWED_REPO_ROOTS`. No project `.env` exists. Secret values were not printed.
- The 5432 listener belongs to `postgres.exe`; the 6379 listener belongs to `redis-server.exe`. Redis returned `PONG` to a read-only probe. There is no selected project database URL, and no migration, task write, or queue operation was run against these potentially user-owned services.
- `npm run e2e` was not run. Its default teardown invokes Compose `down -v` for project `asea-e2e`, which can delete that project's volumes; the Engine is also stopped. No Docker volume was reset or touched.

### Capability classifications for this environment

| Classification | Capability and evidence |
|---|---|
| Implemented and verified live | No complete task-execution or database lifecycle capability was verified live in this phase. Only read-only environment probes succeeded: Redis `PING` returned `PONG`, and Compose files parsed in quiet mode. |
| Implemented and verified with mocks | API tests passed 275/275, frontend tests 5/5, and Python tests 164/164 via `npm run test:all`. The provider, scanner parsing, task workflow, gates, and persistence contracts are covered by unit or scripted-provider tests; these do not execute repository code in Docker or prove real DB/GitHub/LLM behavior. |
| Implemented but unverified | Docker sandbox image/provider runtime, real in-container test commands and resource/network/credential boundaries, and real Gitleaks/Semgrep/OSV fixture findings. The host has no Gitleaks, Semgrep, or OSV-Scanner CLI; those binaries are intended to run from the sandbox image, which was not built because Docker Desktop is stopped. |
| Blocked by configuration | Docker Engine startup; database migrations, persistence, worker queue/restart and cancellation tests against an explicitly selected expendable database; provider-backed proposal/review; live GitHub publication and CI. Database/Redis processes are present, but no project connection configuration identifies them as safe test services. |
| Missing | Automated CI repair/re-run, workspace invitations/member management, and password reset/change remain outside the implemented lifecycle. |

### Static quality checks rerun in this phase

- `npm run test:all`: API 275/275, frontend 5/5, Python 164/164; one upstream Starlette/AnyIO deprecation warning.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed. `npx prisma validate --schema services/api/prisma/schema.prisma` passed with a process-local placeholder URL; it did not connect to PostgreSQL.
- Both Compose static configuration checks and prior `git diff --check` / `git diff --cached --check` passed. No files were staged, committed, reset, or cleaned.

### Required next action

Start Docker Desktop and wait until the `desktop-linux` Engine is ready. Then rebuild `asea/sandbox:2026.10` and run the documented sandbox fixture checks. Before any database mutation, explicitly select an expendable development/test PostgreSQL database and Redis instance. Use a new `E2E_PROJECT` name for E2E because the script removes its project's volumes by default.

## Docker execution follow-up — 2026-10-23

- Re-ran `docker version`, `docker info`, and `docker compose version` before and after the independent checks. `docker version` and `docker info` both exit 1 with: `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.` `docker compose version` succeeds as **v2.33.1-desktop.1**.
- Rechecked Docker Desktop: `docker desktop status` says it cannot retrieve status because Desktop is not running; `sc.exe query com.docker.service` reports `STATE: 1 STOPPED`. Docker Desktop remains installed, and was not started by this run.
- Stopped at the Docker availability gate. The sandbox image build, tool-version checks inside the image, live fixture tests, live scanner tests, worker-to-Engine test, and E2E run were not attempted. No controlled repository fixture or proposed task code ran on the host; only the platform's own test suites ran locally. No Docker volume or container was touched.
- Re-ran `npm run test:all`: API **275/275** across 39 files, frontend **5/5**, and Python **164/164** (one upstream Starlette/AnyIO deprecation warning). `npm run typecheck`, `npm run lint`, and `npm run build` also passed.
- The E2E runner remains intentionally uninvoked: its default `asea-e2e` teardown runs `docker compose down -v`. Once Docker is running, use a new unique `E2E_PROJECT` so teardown is limited to that run's resources.
- Database migrations, writes, queue processing, and worker recovery remain unverified: local PostgreSQL and Redis processes are present, and Redis answered only a read-only `PING`, but no explicitly selected disposable database/Redis configuration is available.

## Live verification update — 2026-10-23

This update supersedes the earlier 2026-10-23 Docker-unavailable checkpoints above. Docker Desktop became available later in the same session. Existing staged, unstaged, and untracked checkout changes were preserved; no staging, commit, reset, or Git cleanup was performed.

- The two temporary worker fixture roots `.codex-worker-fixture-88cec62d` and `.codex-worker-workspaces-88cec62d` remain untracked in the workspace. Their data is synthetic test content (including a fake token used only to test secret redaction); the temporary API, worker, and agent processes and their tmpfs database/Redis containers have been stopped and removed. Automatic safety review rejected the recursive cleanup command, so these fixture directories were left in place.

### Implemented and verified live

- Docker Engine **28.0.1** was reachable (`docker version`, `docker info`); Compose is **v2.33.1-desktop.1**. The trusted image `asea/sandbox:2026.10` built successfully from `services/api/sandbox/Dockerfile`. The Gitleaks checksum check remains enabled. The build now uses the upstream archive filename for checksum verification and bootstraps a non-empty OSV offline npm database, failing the build if its archive is absent, then makes the baked database readable by the sandbox UID.
- The image contains Node **24.22.1**, Python **3.11.2**, pytest **8.4.2**, Gitleaks **8.30.1**, Semgrep **1.181.0**, OSV-Scanner **2.7.0** (osv-scalibr **0.5.3**), and GNU timeout **9.1**. The OSV npm database archive was present and readable by UID 1000 (about 209 MiB).
- A temporary provider harness exercised **13/13** live Docker checks against disposable fixture repositories: passing and failing commands, prohibited shell command rejection, write outside the workspace, command timeout, cancellation, bounded output, cleanup after success/failure/timeout/cancellation, actual network denial, configured memory/CPU/PID limits, non-root execution, and no forwarded host sentinel credential or Docker socket. Commands reported `/.dockerenv`, UID 1000, and `/workspace`; only the fixture workspace was mounted. The tests and scanners ran inside the container.
- The live provider passed all three scanners on a clean fixture. A controlled unsafe fixture generated one Gitleaks finding, one Semgrep finding, and three OSV findings. These results were read back from `TaskPatch.securityResults`; the synthetic token value was absent from persisted evidence. A scanner timeout was persisted as `FAILED`, not clean.
- The documented host-side `npm run dev:worker` configuration (`SANDBOX_PROVIDER=docker`) connected to the Docker Engine through the trusted provider. API-created tasks ran fixture tests and scanners in real containers. A clean task persisted test and all scanner statuses as `PASSED`; the unsafe fixture persisted test `PASSED`, security `FAILED`, cleanup `CLEANED`, and the task remained `NEEDS_ATTENTION`. A separately observed scanner timeout also remained a failure. Proposal generation used the deterministic fake agent service.
- Migrations were applied and API/worker tasks, patch results, and queue processing were exercised against a newly created PostgreSQL test database and Redis container using **tmpfs-only** data directories and unique names. No local PostgreSQL/Redis service, existing Docker volume, or existing project database was used.
- `npm run e2e` passed **13/13** tests across five files using unique Compose project `codex-e2e-live-20261023-a83c` and dedicated ports. Its PostgreSQL, Redis, Qdrant, API, web, and worker services were disposable. The runner's scoped teardown removed that run's resources; the pre-existing `asea-e2e` volumes were left intact. E2E LLM and GitHub integrations were mocks, and its Compose worker deliberately remained sandbox-disabled. Real sandbox execution was demonstrated separately by the provider harness and host worker above.
- `npm run test:all` passed: API **275/275** across 39 files, frontend **5/5**, and Python **164/164**. `npm run typecheck`, `npm run lint`, and `npm run build` passed. The Python suite emitted one upstream Starlette/AnyIO deprecation warning.

### Implemented and verified with mocks

- API tests cover task/auth/approval and patch lifecycle behavior using test doubles where applicable. E2E GitHub and LLM behavior is mocked; those passes do not establish live external-service access.
- Queue and task lifecycle tests in the E2E project used real disposable PostgreSQL/Redis services; external proposal and publication services remained fake. This is not a live GitHub PR or live LLM run.

### Implemented but unverified or only partially verified

- Docker reported `Security Options: seccomp Profile: unconfined`. Network isolation, read-only root filesystem, dropped capabilities, no-new-privileges, non-root user, and configured memory/CPU/PID bounds were inspected or exercised, but a default seccomp profile is **not** active. No hostile-kernel/container-escape guarantee is claimed. Resource values were verified in effective container configuration; no CPU-throttling or memory-exhaustion stress test was run.
- Provider-level cancellation/timeout and cleanup were exercised live, and worker scanner timeout was persisted truthfully. Full task cancellation through the running worker, recovery of an in-flight task after worker/process restart, and retry/reaper recovery were not demonstrated live.
- The live worker's independent review was unavailable, so its task correctly stopped at `NEEDS_ATTENTION`. Live human approval of that task, live LLM proposal/review, and branch/commit/PR publication were not completed.
- A populated OSV database was verified at image-build and scan time. Its coverage is a point-in-time snapshot and becomes stale until rebuilt. Semgrep used only the packaged local rules; results do not cover rules absent from that set. A clean scan is not a guarantee of security. Missing-database behavior was enforced by the Docker build's non-empty archive assertion and scanner failures did not become clean results; no separate live runtime with a deliberately removed database was run.

### Blocked by configuration

- No paid/live proposal or independent-review provider credentials were selected, and no GitHub App credentials or explicitly authorized test repository were available. No real PR was created.
- Native PostgreSQL on port 5432 and Redis on port 6379 were not selected or modified. All live persistence/queue writes described above used isolated temporary containers.

### Missing

- CI repair/re-run, workspace invitations/member management, and password reset/change remain outside the completed scope. The sandbox daemon's unconfined seccomp state and unavailable live reviewer/GitHub integrations also prevent describing the complete approval-to-publication lifecycle as verified.

## Continuation update — 2026-10-23 (Docker and account/workspace lifecycle)

This section supersedes earlier statements above that Docker was stopped, sandbox execution was unverified, or member/password workflows were missing. All other staged, unstaged, and untracked changes were preserved.

### Implemented and verified live

- Docker Engine **28.0.1** and Compose **v2.33.1-desktop.1** responded to `docker version`, `docker info`, and `docker compose version`.
- Rebuilt `asea/sandbox:2026.10` with the documented command, `docker build -f services/api/sandbox/Dockerfile -t asea/sandbox:2026.10 .`. The image reported Node **24.22.1**, pytest **8.4.2**, Gitleaks **8.30.1**, Semgrep **1.181.0**, OSV-Scanner **2.7.0**, and a populated local OSV npm database. The Semgrep probe succeeded with the provider's `HOME=/tmp` environment, which keeps its state out of the read-only image root.
- The separate live provider/worker run documented above verified disposable repository commands and scanner results in Docker, including explicit `seccomp=builtin`, denied network access, non-root UID, read-only root, dropped capabilities, bounded resources/output, cancellation/timeout cleanup, and no Docker socket or host sentinel environment passed into the task container. Findings were persisted in task patch security results without the synthetic secret value.
- `npm run e2e` passed **13/13** tests across five files under unique Compose project `codex-followup-20261023-ea9d9d9f` (web port **18381**, GitHub mock port **18399**). API startup completed migrations against that run's fresh PostgreSQL database. The run's containers, network, and volumes were removed by the script's project-scoped teardown. The existing `asea-e2e` project and its volumes were not touched. The E2E worker intentionally remained sandbox-disabled; its LLM and GitHub integrations were mocks.

### Implemented and verified with mocks

- Workspace member listing, invitations, email-bound one-use invite acceptance, invitation revocation, role changes, member removal, owner/admin restrictions, and audit transactions are covered by API tests. Invitations store only token hashes. The invitation and reset delivery path uses the protected development mailbox, not real email delivery.
- Password change and reset use hashed one-time tokens, generic reset-request responses, and session revocation. Redis session revocation also scans the namespaced session keys so sessions created before the user-session index rollout are covered. Auth and Redis-store tests exercise these cases with test doubles.
- The UI flows for invitations, membership changes, password change, and account recovery use mocked APIs in frontend tests.
- `npm run test:all` passed API **288/288**, frontend **8/8**, and Python **164/164**. Four additional workspace route tests were then added; the latest `npm run test:api` passed **292/292** across 41 files, and `workspaceMembers.test.ts` passed **11/11**. The Python suite emitted one upstream Starlette/AnyIO deprecation warning.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed after the current source changes. `npx prisma validate --schema services/api/prisma/schema.prisma` passed using a process-local placeholder URL and did not connect to a database. The new migration was applied by the disposable E2E API startup.

### Seccomp hardening follow-up

Docker reports its daemon-wide default as `seccomp Profile: unconfined`. The sandbox provider explicitly passes `--security-opt=seccomp=builtin`; on the verified engine the container used seccomp mode 2, normal pytest execution succeeded, and a `keyctl` syscall was denied with `EPERM`. An otherwise equivalent container without the explicit profile allowed that syscall. This validates the per-container setting, not a general kernel-escape boundary.

### Implemented but unverified or only partially verified

- The Docker daemon reports its global default seccomp profile as `unconfined`; the provider explicitly requests the built-in profile, and the per-container regression verified that profile and a denied `keyctl` syscall. No hostile-kernel or container-escape guarantee is claimed.
- Live worker cancellation and process-restart recovery were subsequently demonstrated against the disposable tmpfs-only PostgreSQL/Redis stack. An API cancellation moved an active task through `CANCEL_REQUESTED` to `CANCELLED`, and its running sandbox container and task workspace were removed. Killing the exact worker process while a sandbox command was active and starting a replacement worker caused BullMQ to redeliver the job; the persisted task/run completed its workflow and stayed `NEEDS_ATTENTION` because a scanner gate failed closed at the earlier 512 MiB test limit. No task was approved or published.
- BullMQ retry persistence was exercised with an injected worker fault: attempts 1 and 2 were persisted as failed and attempt 3 completed. This demonstrates redelivery and per-attempt records, but not a transient fault recovering successfully on the first retry. The task remained `NEEDS_ATTENTION` because OSV-Scanner exited 137 at 512 MiB. A subsequent normal worker task at the documented 1024 MiB limit passed `node --test`, Gitleaks 8.30.1, Semgrep 1.181.0, and OSV-Scanner 2.7.0; the three zero-finding reports and `CLEANED` workspace status were persisted. The task remained `NEEDS_ATTENTION` because independent review was unavailable.
- The startup reaper removed a real abandoned workspace after worker restart. A separate live probe removed one synthetic dead same-host owner, retained a directory owned by the live worker PID, and retained a directory tagged for another host. The directories were disposable test entries beneath the dedicated temporary workspace root.
- Live provider and worker timeout handling plus cleanup are verified. A full API-created task deadline expiring through the worker, separate from the provider timeout and scanner timeout checks, was not demonstrated.
- The local Semgrep rule set is narrow and packaged with the image; OSV data is a point-in-time snapshot that becomes stale until the trusted image is rebuilt. A clean scan is not a guarantee that a repository has no vulnerabilities.

### Blocked by configuration

- No live proposal/reviewer LLM credentials or authorized GitHub App repository were selected. Live external review, GitHub publication, webhook delivery, and CI status sync remain unverified; no real PR was created.
- Native PostgreSQL and Redis processes were not selected or modified. Persistence and queue lifecycle checks used newly created disposable test services only.
- The Compose worker remains `SANDBOX_PROVIDER=unavailable`, with no Docker socket mount. Real sandbox execution is through the trusted host-side worker/provider configuration.

### Missing

- Automated CI repair and re-run remain missing. Production email delivery is also missing; the development mailbox is process-local and disabled in production.

### Data preservation and test artifacts

- No stage, commit, reset, or Git cleanup was performed. Existing fixture directories documented above remain untouched.
- The E2E runner generated `.asea/codex-followup-20261023-ea9d9d9f.env` with random test-only secrets. After teardown, an attempt to remove this file was blocked by automatic safety review, so it remains. Its contents were not displayed.
- Final `git diff --check` and `git diff --cached --check` passed; Git emitted only the existing LF-to-CRLF working-copy warnings.

### Final verification summary — 2026-10-23

- **Implemented and verified live:** `npm run test:all` passed API **292/292** across 41 files, frontend **8/8**, and Python **164/164** (one upstream Starlette/AnyIO deprecation warning). `npm run typecheck`, the `npm run lint` alias, and `npm run build` passed. The first build attempt hit Windows `EPERM` while replacing Prisma's engine DLL because the test API/worker were still running; after stopping those exact processes, the build passed. Docker Engine **28.0.1** and Compose **v2.33.1-desktop.1** were reachable; `asea/sandbox:2026.10` built and its pinned runtimes/scanners were probed. The unique E2E project `codex-followup-20261023-ea9d9d9f` passed **13/13** tests and its scoped teardown removed that run's containers, network, and volumes.
- **Implemented and verified with mocks:** proposal generation used the deterministic fake agent service. E2E LLM and GitHub integrations were mocked; frontend account/workspace flows and focused API routes were tested with mocks/test doubles.
- **Implemented but unverified or partially verified:** live reviewer/approval/publication and GitHub integration; a full worker-level task deadline test distinct from provider/scanner timeouts; a transient failure recovering successfully on the first retry. The scanner database is a point-in-time snapshot and the packaged Semgrep rules are intentionally limited.
- **Blocked by configuration:** no paid/live proposal or independent-review provider credentials and no authorized GitHub App test repository were configured. No real pull request was created. Worker persistence/queue checks used only the dedicated disposable tmpfs PostgreSQL and Redis services; native local PostgreSQL/Redis were not selected or changed.
- **Missing:** automated CI repair/re-run and production email delivery.
- **Preservation:** the isolated worker recovery Compose project was stopped and removed without `down -v`; its services used tmpfs only. Existing projects, volumes, and checkout changes were preserved. No stage, commit, reset, or clean operation was performed.

## Phase 1 sandbox storage and evidence hardening — 2026-10-25

This update records the storage and execution-evidence changes made after inspecting the provider, test runner, scanner, worker persistence/API paths, image definition, fixtures, and threat model. Existing staged, unstaged, and untracked changes were preserved.

### Implemented and verified live

- Docker Engine **28.0.1** (`desktop-linux`) and Compose **v2.33.1-desktop.1** responded to `docker version`, `docker info`, and `docker compose version`. The Docker Desktop VM reported about **7.63 GiB** memory; its global seccomp profile remains `unconfined`.
- Ran the documented image build command with a unique tag so the existing `asea/sandbox:2026.10` tag was not replaced: `docker build -f services/api/sandbox/Dockerfile -t asea/sandbox:2026.10-phase1-20261025 .`. The build succeeded using cached layers and produced image ID `sha256:b7965dc416254f20b9467923db78efe9d0a9fb2b10a4857611d3019ee6843a7e` (Linux/amd64, about 1.09 GB). Version probes inside a constrained container returned Node **24.22.1**, Python **3.11.2**, pytest **8.4.2**, Gitleaks **8.30.1**, Semgrep **1.181.0**, and OSV-Scanner **2.7.0** / osv-scalibr **0.5.3**.
- The live Docker fixture suite passed **8/8** tests. It ran Node and pytest fixtures through `DockerSandboxProvider`, inspected effective container settings, and verified network denial, read-only root and input mounts, non-root execution, no Docker socket, no forwarded host sentinel environment variable, disabled daemon log retention with the attached output stream still working, and configured memory/swap/CPU/PID/seccomp settings. The daemon default is unconfined, but the test container inspection confirmed the provider's explicit `seccomp=builtin` setting.
- A test filled the configured **64 MiB** `/workspace` tmpfs until Linux returned `ENOSPC`; the write did not grow the host task snapshot. The container uses a read-only host snapshot at `/input` and a per-command memory-backed tmpfs at `/workspace`; it has no writable host bind mount. Test success, failure, output overflow, timeout, cancellation, and abrupt worker-process interruption all removed the container and cleaned the task workspace. After interruption, the guarded reaper removed the dead worker's matching snapshot.
- The unsafe scanner fixture produced findings from Gitleaks, Semgrep, and OSV-Scanner; the synthetic GitHub token was absent from the returned report. A separate clean fixture produced `PASSED` from all three tools. The clean OSV fixture included a lockfile; no-lockfile scanner errors remain failures, not clean results.

### Implemented and verified with mocks

- `npm run test:all` passed: API **302 tests**, frontend **8 tests**, and Python **164 tests**. After adding the short sensitive-environment-value regression, the final `npm run test:api` passed **303 tests** with **8 gated live Docker cases skipped**; those live cases separately passed **8/8** against Docker. The Python run emitted one upstream Starlette/AnyIO deprecation warning; the frontend run emitted React Router future-flag warnings.
- `npm run typecheck`, `npm run lint` (the repository's typecheck alias), `npm run build`, and the targeted evidence-redaction suite passed. The worker persistence test verified sanitized test/scanner/review/diagnostic data at mocked Prisma calls; the route test verified task/patch response redaction. Tests cover credential assignments (including quoted values), sensitive JSON field names, private/known token formats, truncated output, exception messages, oversized evidence, and missing/failed scanners.
- The live scanner findings were returned by real in-container scanners; the database persistence and API response assertions were mock-based in this phase. No database write was performed for these fixtures.

### Implemented but unverified

- No live PostgreSQL round-trip was performed for the newly sanitized evidence. This phase did not select a dedicated expendable database or repeat worker/queue persistence tests; existing earlier live persistence results are recorded in the preceding updates.
- Aggregate storage/memory pressure across multiple independent worker processes was not stress-tested. Each command has an enforced tmpfs size and container memory/swap bounds, but concurrent containers share Docker Desktop's VM memory budget.
- Redaction covers common credential formats, labeled fields, and exact sensitive environment values of at least four characters available to the trusted worker. Arbitrary unlabeled secrets and values unavailable to that process cannot be guaranteed detectable.

### Blocked by configuration

- No live LLM proposal/reviewer credentials or authorized GitHub publication target were selected. The Phase 1 fixtures did not create a task through the full application worker, approve a patch, or publish a PR.
- No expendable PostgreSQL/Redis target was selected for this phase; no migrations or database/queue writes were attempted.

### Missing

- A disk-backed per-task quota is not provided. Writable test workspace data is deliberately placed on bounded memory-backed tmpfs, and the original snapshot is read-only and bounded. Documentation explicitly distinguishes this enforced tmpfs cap from a disk quota on a bind mount. Ordinary Docker kernel/daemon escape risk remains.

### Commands run in this phase

- `docker version`; `docker info`; `docker compose version`.
- `docker build -f services/api/sandbox/Dockerfile -t asea/sandbox:2026.10-phase1-20261025 .`.
- `npm run test --workspace=@autonomous-engineer/api -- tests/engineering/dockerSandboxProvider.live.test.ts` with `ASEA_LIVE_SANDBOX_IMAGE=asea/sandbox:2026.10-phase1-20261025` (**8/8 live**).
- `docker run` version probe for the pinned image tools under network-disabled, read-only, non-root, resource-bounded settings.
- A `--log-driver=none` container smoke probe confirmed that attached output still streams to the trusted provider while Docker log retention is disabled.
- `npm run test:all`; a final `npm run test:api` (**303 passed, 8 live tests skipped**); `npm run typecheck`; `npm run lint`; final `npm run build`; focused API regression tests; `git diff --check`; `git diff --cached --check`.
- No E2E teardown, database migration/write, stage, commit, reset, or Git cleanup was run.

## Implementation update — 2026-10-28 (task types, CODE_PATCH cancellation, live sandbox)

Existing staged, unstaged, and untracked changes were preserved; nothing was staged, committed, reset, or cleaned.

### Implemented

- **Task types are now honest at submission.** `taskType` is required. Only `CODE_PATCH` and `VERIFICATION` (the types with a worker workflow, `SUBMITTABLE_TASK_TYPES` in `packages/contracts/src/tasks.ts`) are accepted; `BUG_INVESTIGATION`, `TEST_GENERATION`, `CODE_REVIEW`, and `CI_DIAGNOSIS` return `400 VALIDATION_ERROR` on `taskType` before any task, run, or outbox row is written. The old default (`BUG_INVESTIGATION`, which always dead-ended in `WORKFLOW_UNAVAILABLE`) is gone. `CODE_PATCH` now requires `repositoryId` at submission instead of failing later in the worker. The enum keeps all values so stored tasks stay readable; the worker's `WORKFLOW_UNAVAILABLE` branch remains for any such task queued before this change.
- **Cancellation stops the patch workflow at each stage boundary.** Previously, a cancellation that aborted scans or tests let `generateTaskPatch` go on to call the independent reviewer (a possible paid model call) and the worker then persisted a `TaskPatch` for a cancelled task. It now raises `CANCELLED` after scans, after tests, and after review; the worker records the cancellation, and no patch or approval is stored.

### Verified

- **Live Docker sandbox:** rebuilt `asea/sandbox:2026.10-impl-20261028` (image `e0f587b1541e`, existing tags untouched). Probed Node 24.22.1, Python 3.11.2, pytest 8.4.2, Gitleaks 8.30.1, Semgrep 1.181.0, OSV-Scanner 2.7.0, GNU timeout 9.1. `dockerSandboxProvider.live.test.ts` passed **9/9** against it, including a new case that rejects `sh -c`, `node -e`, `npm install`, and an argument-smuggling `node --test` variant before any container is created. No `asea-sbx-*` container remained afterwards.
- **CODE_PATCH worker flow (`tests/engineering/codePatchWorkerFlow.test.ts`, 5 tests):** runs the real snapshot, diff validation/application, test runner, scanner parsing, gates, and worker persistence. Doubles are limited to the proposal/review clients, a scripted sandbox, and in-memory Prisma. Covered: all gates pass → `TaskPatch` with `PASSED` evidence, ordered steps, a `PENDING` approval bound to the persisted patch hash, and audit events; Gitleaks finding, failing tests, or unavailable reviewer → `VERIFICATION_BLOCKED` with evidence kept and no approval; cancellation during tests → `CANCELLED`, reviewer not called, no patch, workspace removed. The source checkout is unchanged in every case.
- `npm run test:api`: **310 passed**, 9 live cases skipped (they require `ASEA_LIVE_SANDBOX_IMAGE`). Frontend **8/8**, Python **164/164**. `npm run typecheck` and `npm run build` passed.
- **Disposable E2E** (`npm run e2e`, project `claude-impl-20261028-e2e2`, ports 18481/18499): **14/14** across five files against real PostgreSQL, Redis, Qdrant, API, worker, and agent service (fake LLM/GitHub, sandbox-disabled Compose worker). A new case checks that `BUG_INVESTIGATION` returns 400 and persists no task. The first run failed 13/14 because `approvals.e2e.test.ts` submitted `CODE_PATCH` without a repository. That test now links a GitHub-provider repository, so the worker still stops before generating a patch and the seeded artifact remains the only one. The scoped teardown removed only that project's containers, network, and volumes. The pre-existing `asea-e2e` project was not touched.

### Observed, not fixed (reproduced and fixed on 2026-10-29; see the next section)

- During one live run made while the image build saturated the Docker VM, a sandbox container was left in `Created` state (never started, so no code ran) and its test reported `NOT_RUN`. Three isolated reruns and the final 9/9 run left nothing behind. `docker run --rm` cleans up a container whose start fails, so the likely cause is a worker-side stop issuing `docker rm --force` before the daemon finished creating the container. This was not reproduced. A startup sweep of stale `asea-sbx-*` containers would close it. The live suite's cleanup hook now has a 60 s timeout, so a slow `docker rm` can no longer cascade into deleting the next test's fixtures. That cascade caused the misleading failures in the first contended run.

## Finalization update — 2026-10-29 (live CODE_PATCH, sandbox races, approval gates, UI E2E)

Existing staged, unstaged, and untracked changes were preserved; nothing was staged, committed, pushed, reset, or cleaned. There is no Git remote and `gh` is not authenticated, so no GitHub repository was identified and no live GitHub operation was attempted.

### Fixed or implemented

- **Task list filters:** `GET /workspaces/:id/tasks` validates `status`/`taskType` against the database enums. Unknown values, including the contract-only legacy statuses `PENDING`/`ANALYZING`/`EXECUTING`, return `400 VALIDATION_ERROR` instead of reaching Prisma as a 500.
- **Sandbox create/cancel race (reproduced, fixed):** `docker rm --force` exits 0 for a container that does not exist yet. A stop that arrived before the daemon had created the container therefore killed the CLI and left a `Created` container behind. The provider now retries removal until `docker rm` reports the container name, then stops the CLI. A new live test aborts in the same tick `docker run` is spawned: it failed 2/2 with the old single attempt and passes with the fix.
- **Sandbox container ownership and startup recovery:** every container carries `io.asea.sandbox=v1`, `io.asea.sandbox.host=<host token>`, and `io.asea.sandbox.pid=<worker pid>`. On startup the worker removes only labelled `asea-sbx-*` containers of this host whose owner PID is dead. Unlabelled, other-host, live-owner, and this-process containers are never removed, and a listing failure removes nothing. Verified with unit tests and live never-started containers.
- **Output redaction corrupted clean scans:** values of env vars with sensitive-looking names were redacted from all sandbox output. `COOKIE_SECURE=false` therefore rewrote every `false` in OSV-Scanner's JSON, so a clean scan was reported `FAILED` and approval was blocked. Public settings (`COOKIE_SECURE`, `COOKIE_NAME`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`) and boolean values are no longer treated as secrets. Real secret values stay redacted. This was found by the live run.
- **Approval gates:** requesting an approval (`POST …/tasks/:id/approvals`) and approving it now require tests, security scans, and independent review all `PASSED`, matching publication. Previously any member could request approval for a blocked patch and an admin could mark it `APPROVED`. Rejection of a blocked patch is still allowed.
- **Deterministic test reviewer:** the agent service's `fake` provider now answers `engineering.review_patch`. It approves only the fake proposer's marker-comment-only diff and requests changes for anything else. `/engineering/review` refuses a `fake` reviewer when `ENVIRONMENT=production`.
- **Live run script:** `npm run live:code-patch` (`scripts/live/code-patch-sandbox.mjs`), documented in `docs/development.md`.
- **Browser E2E:** `e2e/ui/workflows.ui.spec.ts` (Playwright, run by `npm run e2e` after the API suites) covers registration/sign-in errors, repository setup, patch task progress and blocked evidence, verification submission and verdict, and settings/members/GitHub App status against the real stack. It found no frontend integration defect. `run.mjs` now prints a kept-stack stop command that includes the GitHub mock's compose file.

### Verified

- **Live `CODE_PATCH` (`npm run live:code-patch`, image `asea/sandbox:2026.10-impl-20261028`): 16/16 checks.** Real API, worker, and agent service on the host; real Docker sandbox; run-only tmpfs PostgreSQL 16 and Redis 7 containers on loopback ports. Migrations applied; register; local repository; proposal → disposable apply → `node --test` → Gitleaks/Semgrep/OSV all `PASSED` → review `PASSED` → `PENDING` approval bound to the persisted patch hash, with all nine workflow steps `COMPLETED`. Requester self-approval returned 403, and the checkout was unchanged. A cancellation while a sandbox container ran ended `CANCELLED`, the patch endpoint returned 404, and no workspace or container remained. Teardown removed both run containers and the run directory. The first attempt failed 10/15 on the redaction defect above; the remaining failures were consequences of it.
- Live sandbox suite, `npm run typecheck`, `npm run build`, `prisma validate`, API/frontend/Python suites, and the final E2E are recorded below.
- **Final runs:** live sandbox suite **11/11**, with no `io.asea.sandbox` container left. `npm run e2e` (project `claude-final-20261029`, ports 18681/18699): API **14/14** and UI **4/4**, and the scoped teardown removed all of that project's containers, volumes, and network. `npm run test:api` **317 passed** (11 live cases skipped without the image), frontend **8/8**, Python **167/167**. `npm run typecheck`, `npm run build`, `prisma validate`, and `git diff --check` passed. The live script's migration drift step was added after its 16/16 run and has not been run yet.
- **Not verified:** all live GitHub operations (App, installation, repository access, branch/commit/PR, live webhooks, CI). There is no Git remote, `gh` is unauthenticated, and no public URL exists for the App webhook/callback. Mock-based GitHub tests pass.
