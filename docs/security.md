# Security Architecture and Threat Model (Phase 2)

## 1. Security Philosophy

The Autonomous AI Software Engineering Platform is designed on **zero-trust principles**:
1. **Never trust generated code**: Any code produced or modified by an AI model is treated as untrusted, potentially malicious input.
2. **Never execute untrusted code on the host**: Host shell execution is disabled by design.
3. **No credentials in frontend or workers**: The client interface and worker containers have zero access to database credentials or internal infrastructure keys.
4. **Defense in Depth**: Isolation is enforced across network, kernel, filesystem, and identity boundaries.

---

## 2. Authentication & Authorization Security (Phase 2)

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

### 2.3 Multi-Tenant Workspace Authorization
- Every resource (Task, Repository, Workflow Run, Workflow Step, Audit Event) is partitioned by `workspaceId`.
- The `requireWorkspaceMembership` middleware intercepts all workspace-scoped requests:
  - Verifies the user belongs to the target workspace.
  - Enforces role hierarchy (`OWNER` > `ADMIN` > `MEMBER`).
  - Completely blocks cross-workspace data access attempts, returning `403 Forbidden`.

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
- **Arbitrary shell execution is completely blocked.** Phase 2 does not execute user-provided scripts or shell commands.

---

## 4. Threat Modeling & Countermeasures

| Threat | Attack Vector | Phase 2 Countermeasure |
|---|---|---|
| **Account Enumeration** | Brute-force checking of email registration | Uniform 401 response on invalid credentials; email normalization; rate limiting |
| **Cross-Tenant Data Leak** | Caller requests tasks or repositories from another workspace ID | Middleware checks user workspace membership in database on every request; returns 403 |
| **Credential Theft via XSS** | Injected JavaScript attempts to read tokens | HttpOnly cookies cannot be accessed via `document.cookie` |
| **Dual-Write State Desync** | Task saved in DB but Redis drops enqueue call | Transactional Outbox pattern polls and retries pending outbox events |
| **Remote Code Execution (RCE)** | User prompt attempts to execute shell commands | Worker runs deterministic steps only; zero shell/bash execution APIs are exposed |
| **Log Leakage** | Credentials printed to stdout / log aggregators | Centralized logger recursively masks `password`, `token`, `secret`, `authorization`, `cookie`, `key` |

---

## 5. Remaining Threats & Phase 3 Roadmap

1. **Multi-Factor Authentication (MFA)**: Phase 2 implements password authentication. Phase 3 will introduce WebAuthn/TOTP.
2. **MicroVM Execution Sandbox**: Phase 3 will introduce gVisor/Firecracker disposable sandboxes for actual code modification and test execution.
3. **GitHub OAuth & App Integration**: Repository records currently store metadata without tokens. Phase 3 will introduce GitHub App tokens managed via an isolated secrets vault.
