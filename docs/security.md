# Security Architecture and Threat Model (Phase 3)

## 1. Security Philosophy

The Autonomous AI Software Engineering Platform is designed on **zero-trust principles**:
1. **Never trust generated code**: Any code produced or modified by an AI model is treated as untrusted, potentially malicious input.
2. **Never execute untrusted code on the API or worker host**: The worker delegates execution through an opt-in Docker provider and never falls back to host shell execution. With the provider disabled or unavailable, repository tests do not run.
3. **Keep credentials out of the browser and repository snapshot**: The trusted worker process holds database, Redis, internal-service, and optional GitHub credentials; task containers receive none of them.
4. **Use defense in depth**: Snapshot path checks, secret filtering, exact argv policy, container restrictions, bounded output, scanner reports, and publication gates work together. Ordinary Docker still shares the host kernel and is not a complete hostile-code boundary.

---

## 2. Authentication & Authorization Security

### 2.1 Password Security & Storage
- Passwords must be at least 8 characters and are validated against length limits to prevent DoS attacks via excessively long strings.
- Passwords are hashed using **bcrypt** with a cost factor of 10 before persistence. Plaintext passwords are never stored, logged, or cached.
- Login failures use a dummy bcrypt comparison for unknown email addresses and the same generic error (`"Invalid email or password"`) for both unknown users and incorrect passwords. This reduces the timing difference that could support account enumeration.

### 2.2 Token & Session Management
- Sessions utilize HMAC-SHA256 signed JSON Web Tokens (JWT).
- Register and login deliver the token **only** as an `HttpOnly`, `SameSite=Lax` cookie; Secure defaults on in production and can be overridden with `COOKIE_SECURE`. It is never included in a response body, and the web client never stores it, so page JavaScript cannot read it (defends against XSS token theft).
- The API also accepts `Authorization: Bearer <token>` for non-browser clients and tests.
- Production configurations validate that `JWT_SECRET` is not set to the default development secret string, halting startup if an insecure secret is detected.
- Each issued JWT has a random `jti` registered in the shared Redis authentication store until the JWT expiry. Protected requests require a matching live server-side session; logout atomically revokes it before clearing the cookie. Expired sessions are rejected by both JWT expiry and Redis TTL.
- Password change verifies the current bcrypt password, hashes the replacement, and revokes every session indexed for that user. Password-reset tokens are 256-bit random values; only SHA-256 digests are stored, expiry and one-time consumption are checked transactionally, and successful reset revokes all sessions. Reset request responses are the same for known and unknown email addresses. Raw reset/invitation tokens are delivered only as URL fragments through the protected development mailbox; the UI immediately removes the fragment from history. `DEV_MAILBOX_TOKEN` gates a process-local development sink that is disabled in production and is not real email delivery. A real email transport is still required for production delivery.
- Login and registration are limited by a Redis-backed fixed window shared across API replicas (defaults: five attempts per IP per 15 minutes). Redis errors fail closed with `503`; process memory is an explicit non-production option and production config rejects it.
- Unsafe browser methods must carry an `Origin` or `Referer` matching `CORS_ORIGIN`. Originless native requests without a session cookie remain supported. Cookie-authenticated requests missing both headers are rejected.
- Session cookies use HttpOnly and SameSite=Lax; Secure defaults on in production and can be overridden with `COOKIE_SECURE` for a deliberately plain-HTTP local stack.

### 2.3 Multi-Tenant Workspace Authorization
- Every resource (Task, Repository, Analysis, Workflow Run, Workflow Step, Audit Event) is strictly partitioned by `workspaceId`.
- The `requireWorkspaceMembership` middleware intercepts all workspace-scoped requests:
  - Verifies the user belongs to the target workspace.
  - Enforces role hierarchy (`OWNER` > `ADMIN` > `MEMBER`).
  - Completely blocks cross-workspace data access attempts, returning `403 Forbidden`.
- Workspace members can be listed without exposing password hashes. Only owners may invite admins or change member roles; admins may invite/remove ordinary members. The owner cannot be removed or demoted. Invitation acceptance requires an authenticated account whose email matches, atomically claims the unexpired invitation, creates the membership, and writes its audit event. Invitation/reset digests, not raw tokens, are persisted.
- **No unscoped task routes**: The pre-workspace `/api/v1/tasks`, `/api/v1/tasks/:id` and `/api/v1/system/info` routes have been removed. Every task endpoint lives under `/api/v1/workspaces/:workspaceId/tasks` and requires authentication and membership.

---

## 3. Transactional Outbox & Background Processing Security

### 3.1 Dual-Write Protection
- Task creation, workflow run initialization, and outbox event creation execute inside an atomic PostgreSQL transaction.
- If Redis is temporarily unreachable, the task record is safely preserved in PostgreSQL and enqueued automatically once Redis recovers.

### 3.2 Bounded Worker Processing
- Background processing is handled by a dedicated BullMQ worker (`services/api/src/worker.ts`). `CODE_PATCH` tasks create a secret-filtered snapshot, request a bounded proposal with evidence, validate and apply it only in that copy, then run verification before requesting approval. The proposal model call, separate reviewer model call, and patch generation each have bounded retry/timeouts; patch validation permits one repair request. A task artifact persists the exact patch hash, proposal evidence, diagnostics, test output/status, scan tools/findings/limitations, review findings, cleanup state, and publication/CI state.
- **Repository execution has an exact argv policy.** The optional `DockerSandboxProvider` accepts only manifest-detected `node --test`, offline `npm test` variants with lifecycle scripts ignored, `python -m pytest -q`, and pinned Gitleaks, Semgrep, and OSV-Scanner commands. It never invokes a repository command on the API or worker host. Package installation and task-time network access are not permitted; dependencies absent from the image/cache cause real test failure or a not-run result, never a successful result.
- A task container is started with `--pull=never`, `--network=none`, a read-only root filesystem, the task snapshot bind-mounted read-only at `/input` and copied into a size-capped tmpfs `/workspace` for tests (scanners mount the snapshot read-only at `/workspace` instead), no writable host bind mount, no Docker socket, no application secrets, dropped Linux capabilities, `no-new-privileges`, non-root UID/GID, `--security-opt=seccomp=builtin`, PID/memory/swap/CPU limits, timeouts, bounded output, and forced container removal on cancellation/timeout. A second deadline runs inside the container; if the worker process exits unexpectedly, the process is terminated after the configured command limit and the `--rm` container is removed. Security scanners mount the workspace read-only. The worker process is trusted and can invoke Docker; the task container cannot access the daemon. The explicit built-in seccomp profile is required because the verified Docker Desktop Engine advertises its implicit profile as `unconfined`. Live validation confirmed `seccomp=builtin` in `HostConfig`, `Seccomp: 2` in the sandbox process, normal pytest success, and `keyctl` denial (`EPERM`); the same syscall succeeded without the override. A runtime that rejects the explicit profile fails the command closed.
- A cancellation observed after scans, after tests, or after review stops the patch workflow at that boundary; the reviewer is not called and no patch artifact or approval is persisted for a cancelled task.
- Each task attempt receives a unique workspace directory tagged with a host token and owner PID. At worker startup, a bounded reaper considers only direct child directories with that exact generated name format and this host token, then removes a workspace only when its owner PID is confirmed dead. Live owners, other-host workspaces, symlinks, and unrelated directory names are not removed; PID-probe errors fail safe as live. This recovers leftover snapshots after a worker crash without colliding with a retry's workspace. If the root is unavailable or removal fails, the worker logs the issue and continues; the cleanup is retried on a later worker start.
- This Docker setup is defense in depth, **not a complete boundary against hostile code**. The container shares the host Linux kernel and Docker daemon, the tmpfs workspace counts against the container's memory budget rather than a disk quota, and Windows/desktop bind-mount behavior depends on the host runtime. A hardened VM or sandbox runtime is preferable for high-risk untrusted repositories. The stack Compose worker has no Docker CLI/socket and keeps the provider unavailable.
- Gitleaks uses an image-baked config extending its defaults and ignores no repository-provided exceptions; Semgrep runs local rules packaged with the image with Git ignores and inline suppressions disabled; OSV-Scanner uses a trusted empty exception config and scans ignored lockfiles against the local advisory database baked at trusted image-build time. A repository `.semgrepignore` blocks a clean scan because the pinned scanner cannot safely replace that untrusted ignore file. Missing tools, missing/stale OSV data, malformed output, findings, timeouts, and skipped scans are represented separately; no missing scanner is reported as clean. The OSV database becomes stale until the sandbox image is rebuilt. Reports are best-effort checks, not a security guarantee.
- The independent review endpoint requires a separately configured reviewer identity. If it is absent, uses the same model identity, requests changes, or returns invalid output, review is unavailable/failed and approval is not requested. Requesting an approval, approving it, and publication all require `testStatus`, `securityStatus`, and `reviewStatus` all `PASSED` (a blocked patch can only be rejected); publication also requires a current patch and hash-bound second-person approval, and a non-cancelled task. A patch change therefore requires new tests, scans, review, and approval.

### 3.3 Agent Service Boundary (`services/agent-service`)
- The agent service is called only by the worker, so it sends no CORS headers.
- Every `/api/v1/*` request must carry `X-Internal-Token` equal to `INTERNAL_SERVICE_TOKEN` (constant-time comparison). With no token configured, `/api/v1/*` returns `503`; a missing or wrong token returns `401`. `/health` and `/ready` stay open.
- Request bodies over `AGENT_MAX_REQUEST_BYTES` (default 5 MiB) are rejected with `413`, whether the size is declared in `Content-Length` or only discovered while the body streams in.

---

### 3.4 Verification Engine and Untrusted Repository Content

Code, diffs, PR titles/bodies and requirement text under review are untrusted input to the LLM agents. They are sent inside nonce-tagged fences that content cannot close, the system prompt marks them as data, answers must validate against a schema, finding locations are chosen by code (never by the model), deterministic findings cannot be removed or re-graded, and the reporter cannot add findings. Details: `services/agent-service/README.md` (Prompt-injection hardening).

### 3.5 GitHub Webhooks and PR Comments

- `POST /api/v1/webhooks/github` needs no session; it authenticates each delivery with `X-Hub-Signature-256` (HMAC-SHA256 of the exact request bytes) compared in constant time. Legacy PR webhook connections use per-repository secrets; GitHub App events use the server-only App webhook secret, and signed App events are associated only with App-linked repositories. Unknown repositories, missing or wrong signatures get 401; payloads must be JSON.
- GitHub App callback state is signed, workspace/user-bound and short lived, then consumed once through Redis (or the explicit non-production memory store). The OAuth code is exchanged on the server. Before associating an installation, the API confirms the installation belongs to the configured App and is present in the authenticated GitHub user's `/user/installations` result. If the callback has no installation ID and the user has several accessible installations, a signed one-use selection ticket restricts the final choice to that verified list. App private key, client secret, access tokens, and OAuth codes are never sent in API responses or written to the database.
- PR publication uses short-lived installation tokens, confirms the repository is available to that installation, refuses a dirty source snapshot, checks the GitHub base SHA and every changed file's SHA-256, reapplies the approved diff in a disposable temporary directory, and writes only a deterministic `asea/task-*` branch through Git Data API before opening/reusing a PR. It never writes to the default branch. Publication requires passing tests, security scans, independent review, and a current approval. Live publication has not been tested in this checkout.
- Redeliveries are idempotent: the task's idempotency key (`github:<delivery>:<repository>`) is unique per workspace (B10, now a database constraint).
- When the PR's commits are not in the local checkout, the worker fetches them from `origin` with repository config neutralised (no hooks, credential helpers, custom ssh, `ext::` or upload-pack commands); `GITHUB_TOKEN` is passed through `GIT_CONFIG_*` environment variables, not the command line.
- PR comments escape everything taken from the change (no HTML, no @mentions, no table breaks). Their outcome is recorded on the run, outside the sealed audit chain.

## 4. Repository Intelligence Security & Containment (Phase 3)

The repository intelligence engine reads bounded filesystem snapshots while defending against malicious repositories, path escapes, credential leaks, and Denial of Service (DoS). The task-workspace module copies that filtered snapshot into a separate task directory, and the patch applicator accepts only bounded text additions/modifications inside that directory. The worker uses these modules for provider-backed CODE_PATCH proposals. Original checkouts remain read-only to the patch workflow.

### 4.1 Path Traversal & Symlink Escape Prevention
- **Path Canonicalization (`validateAndCanonicalizePath`)**: Every repository path is resolved to its absolute, canonical representation via `path.resolve` and `fs.realpathSync`.
- **Traversal Rejection**: Directory traversal sequences (`..`), null bytes (`\0`), and cross-drive jumps are immediately rejected with `400 Bad Request`.
- **Allowed Roots Jail (required)**: `ALLOWED_REPO_ROOTS` has no default; analysis returns `503` until it is set. A repository URL must be an absolute local path inside one of the roots, otherwise analysis returns `400` and records nothing. Remote URLs (e.g. GitHub) are rejected; there is no fallback to the server's working directory.
- **Symlink Containment**: When encountering a symbolic link during traversal, the real path of the target is resolved and verified against the canonical repository root:
  - Internal symlinks pointing within the repository root are permitted.
  - Symlinks escaping the repository root (e.g. pointing to `/etc/passwd` or `C:\Windows`) are immediately skipped and recorded as `SYMLINK_ESCAPE` in inventory.

### 4.2 Zero-Exposure Credential & Secret Filtering
- Files matching sensitive filename patterns are completely excluded before content inspection:
  - Environment and config files: `.env`, `.env.local`, `.env.*`
  - Cryptographic keys: `*.key`, `*.pem`, `*.crt`, `*.pfx`, `*.p12`, `id_rsa`, `id_ed25519`
  - Cloud / service credentials: `credentials.json`, `service-account*.json`, `*secret*`, `*token*`, `*.htpasswd`
- Excluded secret files are categorized as `SECRET_EXCLUDED` in the inventory without reading their file contents or persisting their contents to PostgreSQL.

### 4.3 Binary Sniffing & Safe Skipping
- To prevent memory exhaustion and corrupt text parsing, file headers (first 1,024 bytes) are inspected for null bytes (`0x00`) or non-printable control characters.
- Detected binary files are categorized as `BINARY` and excluded from source analysis.

### 4.4 Hard Resource Boundaries & DoS Limits
- `ANALYSIS_MAX_FILES`: Caps the maximum number of files traversed (default 5,000 files).
- `ANALYSIS_MAX_FILE_SIZE_BYTES`: Caps maximum individual file size (default 1MB). Larger files are skipped with reason `EXCEEDS_FILE_SIZE_LIMIT`.
- `ANALYSIS_MAX_TOTAL_BYTES`: Bounds total cumulative bytes loaded into memory (default 50MB).
- `ANALYSIS_TIMEOUT_MS`: Hard execution timeout on the traversal and analysis pipeline (default 30,000ms).

---

## 5. Threat Modeling & Countermeasures

| Threat | Attack Vector | Countermeasure |
|---|---|---|
| **Account Enumeration** | Brute-force checking of email registration/login | Dummy bcrypt comparison for unknown users; uniform login error; Redis-shared per-IP attempt limit; registration still reveals duplicate email through 409 |
| **Cross-Tenant Data Leak** | Caller requests tasks or repositories from another workspace ID | Middleware checks user workspace membership in database on every request; returns 403 |
| **Directory Traversal** | Malicious `repositoryUrl` with `../../etc/shadow` | Canonical path resolution + `ALLOWED_REPO_ROOTS` containment verification |
| **Symlink Escape** | Malicious repo containing symlink to host filesystem | Target canonical path checked against repo root; blocked with `SYMLINK_ESCAPE` |
| **Secret File Leakage** | Repository contains `.env` or AWS credential files | Secret filter regex blocks reading or persisting contents of sensitive files |
| **Credential Theft via XSS** | Injected JavaScript attempts to read tokens | HttpOnly cookies cannot be accessed via `document.cookie` |
| **Dual-Write State Desync** | Task saved in DB but Redis drops enqueue call | Transactional Outbox pattern polls and retries pending outbox events |
| **ReDoS / Parsing DoS** | Massive 100MB file or 500,000 file directory tree | Hard limits on max files (5,000), file size (1MB), total bytes (50MB), and scan timeout (30s) |
| **Remote Code Execution (RCE)** | Repository tests attempt to execute hostile commands | Exact top-level argv allowlist; read-only host snapshot copied into bounded tmpfs; no network, host credentials, or daemon socket in the container; read-only root, dropped capabilities, explicit seccomp, and memory/CPU/PID/time/output limits; Docker kernel escape risk remains |
| **Workspace Storage Exhaustion** | A test creates files until host storage is full | Tests write only to a per-container memory-backed tmpfs with an enforced `size=` cap (default 256 MiB; 64–1024 MiB); snapshot input is read-only and bounded to 50 MiB; tmpfs creation failure fails closed. This is not a disk quota for bind mounts, and parallel containers still share the Docker Desktop VM memory budget. |
| **Execution Evidence Leakage** | Test output, exceptions, or scanner evidence contains credentials | Docker log retention is disabled while the attached stream remains available to the bounded provider capture; combined stdout/stderr is redacted before report construction; worker sanitizes nested evidence before persistence; task and patch responses sanitize again. Covers common credential formats, labeled assignments, and exact sensitive environment values available to the worker; arbitrary unlabeled or unavailable secrets cannot be guaranteed detectable. |

---

## 6. Remaining Threats & Phase 4 Roadmap

1. **Multi-Factor Authentication (MFA)**: WebAuthn/TOTP integration.
2. **Hardened execution isolation**: The opt-in Docker provider and explicit seccomp selection are live-verified on Docker Desktop. Ordinary Docker still shares the host kernel and Docker daemon; use a hardened VM/runtime for high-risk hostile repositories.
3. **GitHub App production validation**: The server-side App install, repository selection, branch/commit/PR, and CI synchronization paths are implemented with mocked API tests, but still need live credentialed smoke tests. CI failure diagnosis exists; automated CI repair is not implemented.
