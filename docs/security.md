# Security Architecture and Threat Model (Phase 3)

## 1. Security Philosophy

The Autonomous AI Software Engineering Platform is designed on **zero-trust principles**:
1. **Never trust generated code**: Any code produced or modified by an AI model is treated as untrusted, potentially malicious input.
2. **Never execute untrusted code on the host**: Host shell execution is disabled by design.
3. **No credentials in frontend or workers**: The client interface and worker containers have zero access to database credentials or internal infrastructure keys.
4. **Defense in Depth**: Isolation is enforced across network, kernel, filesystem, and identity boundaries.

---

## 2. Authentication & Authorization Security

### 2.1 Password Security & Storage
- Passwords must be at least 8 characters and are validated against length limits to prevent DoS attacks via excessively long strings.
- Passwords are encrypted using **bcrypt** with a cost factor of 12 before persistence. Plaintext passwords are never stored, logged, or cached.
- Login failures use timing-consistent, generic error messages (`"Invalid email or password"`) to prevent account and email enumeration attacks.

### 2.2 Token & Session Management
- Sessions utilize HMAC-SHA256 signed JSON Web Tokens (JWT).
- The tokens are delivered through two defense mechanisms:
  - `Authorization: Bearer <token>` for programmatic API clients and mobile interfaces.
  - Secure `HttpOnly`, `SameSite=Lax` cookies for browser navigation to defend against Cross-Site Scripting (XSS) token theft.
- Production configurations validate that `JWT_SECRET` is not set to the default development secret string, halting startup if an insecure secret is detected.

### 2.3 Multi-Tenant Workspace Authorization & Legacy Hardening
- Every resource (Task, Repository, Analysis, Workflow Run, Workflow Step, Audit Event) is strictly partitioned by `workspaceId`.
- The `requireWorkspaceMembership` middleware intercepts all workspace-scoped requests:
  - Verifies the user belongs to the target workspace.
  - Enforces role hierarchy (`OWNER` > `ADMIN` > `MEMBER`).
  - Completely blocks cross-workspace data access attempts, returning `403 Forbidden`.
- **Legacy Route Hardening**: `GET /api/v1/tasks` is restricted so unauthenticated users can only view default bootstrap demo tasks, authenticated users only receive their own workspace tasks, and `GET /api/v1/tasks/:id` validates workspace membership before returning task data.

---

## 3. Transactional Outbox & Background Processing Security

### 3.1 Dual-Write Protection
- Task creation, workflow run initialization, and outbox event creation execute inside an atomic PostgreSQL transaction.
- If Redis is temporarily unreachable, the task record is safely preserved in PostgreSQL and enqueued automatically once Redis recovers.

### 3.2 Bounded Worker Processing
- Background processing is handled by a dedicated BullMQ worker (`services/api/src/worker.ts`).
- Worker execution is strictly deterministic:
  - Validates context.
  - Inspects repository metadata records.
  - Generates plan specifications.
  - Verifies boundaries and records steps.
- **Arbitrary shell execution is completely blocked.** Phase 3 does not execute user-provided scripts or shell commands.

---

## 4. Repository Intelligence Security & Containment (Phase 3)

The repository intelligence engine executes deep filesystem analysis while strictly defending against malicious repositories, path escapes, credential leaks, and Denial of Service (DoS):

### 4.1 Path Traversal & Symlink Escape Prevention
- **Path Canonicalization (`validateAndCanonicalizePath`)**: Every repository path is resolved to its absolute, canonical representation via `path.resolve` and `fs.realpathSync`.
- **Traversal Rejection**: Directory traversal sequences (`..`), null bytes (`\0`), and cross-drive jumps are immediately rejected with `400 Bad Request`.
- **Allowed Roots Jail**: If configured, `ALLOWED_REPO_ROOTS` enforces that repositories must strictly reside within pre-authorized filesystem trees.
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
- To prevent memory exhaustion and corrupt AST parsing, file headers (first 1,024 bytes) are inspected for null bytes (`0x00`) or non-printable control characters.
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
| **Account Enumeration** | Brute-force checking of email registration | Uniform 401 response on invalid credentials; email normalization; rate limiting |
| **Cross-Tenant Data Leak** | Caller requests tasks or repositories from another workspace ID | Middleware checks user workspace membership in database on every request; returns 403 |
| **Directory Traversal** | Malicious `repositoryUrl` with `../../etc/shadow` | Canonical path resolution + `ALLOWED_REPO_ROOTS` containment verification |
| **Symlink Escape** | Malicious repo containing symlink to host filesystem | Target canonical path checked against repo root; blocked with `SYMLINK_ESCAPE` |
| **Secret File Leakage** | Repository contains `.env` or AWS credential files | Secret filter regex blocks reading or persisting contents of sensitive files |
| **Credential Theft via XSS** | Injected JavaScript attempts to read tokens | HttpOnly cookies cannot be accessed via `document.cookie` |
| **Dual-Write State Desync** | Task saved in DB but Redis drops enqueue call | Transactional Outbox pattern polls and retries pending outbox events |
| **ReDoS / Parsing DoS** | Massive 100MB file or 500,000 file directory tree | Hard limits on max files (5,000), file size (1MB), total bytes (50MB), and scan timeout (30s) |
| **Remote Code Execution (RCE)** | User prompt attempts to execute shell commands | Worker runs deterministic steps only; zero shell/bash execution APIs are exposed |
| **Log Leakage** | Credentials printed to stdout / log aggregators | Centralized logger recursively masks `password`, `token`, `secret`, `authorization`, `cookie`, `key` |

---

## 6. Remaining Threats & Phase 4 Roadmap

1. **Multi-Factor Authentication (MFA)**: WebAuthn/TOTP integration.
2. **MicroVM Execution Sandbox**: Phase 4 will introduce gVisor/Firecracker disposable sandboxes for actual code modification and test execution.
3. **GitHub OAuth & App Integration**: Integration with GitHub App installation tokens for remote webhook listening and automated PR dispatch.
