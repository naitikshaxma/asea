# API Reference

This reference describes the routes mounted by the current Node API and internal Python agent service. Shared TypeScript request/response contracts live in [`packages/contracts/src`](../packages/contracts/src); internal Python models live beside the FastAPI routes. The code is authoritative if this document and an implementation differ. The older [`ASEA_AUDIT.md`](ASEA_AUDIT.md) describes an earlier repository state and is not an API contract.

## Node API

Base path: `/api/v1`. JSON requests and responses use UTF-8. The browser sends the session cookie with `credentials: include`; non-browser callers may send `Authorization: Bearer <JWT>`. A workspace route requires an active membership at the listed minimum role (`ADMIN` includes `OWNER`).

### Error envelope

API errors use:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request payload validation failed",
    "details": [{ "field": "name", "message": "Name is required", "code": "too_small" }],
    "requestId": "…",
    "timestamp": "2026-10-22T00:00:00.000Z"
  }
}
```

`details`, `requestId`, and `timestamp` may be omitted where not available. Malformed JSON and Zod validation failures return `400`; missing/invalid authentication returns `401`; insufficient workspace role returns `403`; missing resources return `404`; policy name collisions and deleting the default policy return `409`; authentication attempts over the configured limit return `429 RATE_LIMITED`; unexpected failures return `500` (with a generic message in production). Request bodies over the Express parser's 10 MiB limit are rejected. Query values that have no documented validation should not be assumed to be safely normalized.

### Health

| Method and path | Auth | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /health` | Public | None | `HealthResponseSchema`: service, version, uptime, timestamp, environment | `200`; process liveness only. |
| `GET /ready` | Public | None | `ReadinessResponseSchema`: dependency states for PostgreSQL and Redis | `200` when dependencies marked required are up; otherwise `503`. |

### Authentication

| Method and path | Auth | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `POST /auth/register` | Public | `RegisterRequestSchema` (`email`, `password`, `displayName`) | `201 AuthResponseSchema` (`user`); session JWT is set as an HttpOnly cookie | `400` validation, `409` duplicate email, `429` Redis-shared IP rate limit, `503` auth-state store unavailable. Registration also creates the user's initial workspace and OWNER membership. |
| `POST /auth/login` | Public | `LoginRequestSchema` (`email`, `password`) | `200 AuthResponseSchema` and session cookie | `400` validation, `401` generic invalid-credentials response, `403` inactive account, `429` Redis-shared IP rate limit, `503` auth-state store unavailable. |
| `POST /auth/logout` | Public | None | `200 { success: true, message: string }`; revokes the server-side session and clears the configured cookie | `503` if session storage cannot revoke safely. |
| `GET /auth/me` | Session or Bearer | None | `200 { user: UserProfileSchema, workspaces: WorkspaceResponseSchema[] }` | `401` missing/invalid token, `404` user no longer exists. |
| `POST /auth/password/change` | Session or Bearer | `{ currentPassword, newPassword }`; new password is 8–128 characters | `200 { success, message }`; verifies current password, hashes the replacement, removes reset tokens, revokes the user's server sessions, and clears the cookie | `400` wrong current password or invalid body; `503` auth-state storage unavailable. |
| `POST /auth/password-reset/request` | Public, rate-limited | `{ email }` | `202` with the same generic response for known and unknown addresses | Reset mail is queued only when the development mailbox is configured. Production email delivery is not implemented. |
| `POST /auth/password-reset/complete` | Public, rate-limited | `{ token, newPassword }`; new password is 8–128 characters | `200 { success, message }`; atomically consumes the hashed, single-use token, updates the password, removes other reset tokens, revokes all sessions, and clears the cookie | `400` invalid, expired, used token or invalid body; `503` auth-state storage unavailable before the password write. |
| `GET /dev/mailbox` | Development-only Bearer `DEV_MAILBOX_TOKEN` | None | `200 { delivery: "development-memory-mailbox", messages }`, `Cache-Control: no-store` | `404` if unauthorized or in production. The process-memory sink is test/development infrastructure and is not an email provider. |

Cookie flags are HttpOnly and SameSite=Lax. Secure defaults to production-only and can be overridden with `COOKIE_SECURE`. The JWT is not returned in JSON. Each JWT has a server-registered random `jti` whose Redis TTL matches the JWT expiry; protected routes reject missing/revoked sessions. `AUTH_STATE_STORE=memory` is a non-production override only. Login and registration use `AUTH_RATE_LIMIT_MAX` attempts per `AUTH_RATE_LIMIT_WINDOW_MS` from each IP address (defaults: 5 attempts per 15 minutes), shared by API replicas through Redis. Redis errors fail closed with `503`. Unsafe browser requests must provide a same-origin `Origin` or `Referer`; cookie-authenticated writes without either are rejected.

### Workspaces

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /workspaces` | Session | None | `200 WorkspaceListResponseSchema` | Lists only the caller's memberships. |
| `POST /workspaces` | Session | `CreateWorkspaceRequestSchema` (`name`) | `201 WorkspaceResponseSchema`; caller becomes OWNER | `400` validation. Workspace and membership are created transactionally. |
| `GET /workspaces/:workspaceId` | MEMBER | None | `200 WorkspaceResponseSchema` (`id`, `name`, `ownerId`, caller's `role`, persisted `createdAt`, `updatedAt`) | `403` non-member. |
| `PATCH /workspaces/:workspaceId` | ADMIN | `UpdateWorkspaceRequestSchema` (`name?`) | `200 WorkspaceResponseSchema` | `400` validation, `403` insufficient role, `404` if membership/workspace is unavailable. |
| `GET /workspaces/:workspaceId/members` | MEMBER | None | `200 { members: [{ id, userId, email, displayName, role, createdAt }] }`; never includes password hashes | `403` non-member. |
| `GET /workspaces/:workspaceId/invitations` | ADMIN | None | `200 { invitations }`; includes status/expiry but never token material | `403` insufficient role. |
| `POST /workspaces/:workspaceId/invitations` | ADMIN; OWNER required for ADMIN invite | `{ email, role?: "ADMIN" | "MEMBER" }` | `201 { invitation }`; replaces earlier pending invitation for that email, expires after 7 days, and queues a fragment-token link in the configured development mailbox | `403` admin trying to invite an admin; `409` already a member; `503` when delivery is not configured. No real email provider is configured by this implementation. |
| `DELETE /workspaces/:workspaceId/invitations/:invitationId` | ADMIN | None | `204`; revokes an unaccepted invitation and audits the action transactionally | `404` outside workspace; `409` already accepted/inactive. |
| `POST /workspaces/:workspaceId/invitations/accept` | Session or Bearer; caller need not already be a member | `{ token }` | `201 { success, workspaceId, role }`; token must be unexpired, unused, and addressed to the authenticated user's email. Membership and audit event are created atomically. | `401` unauthenticated; `400` expired/revoked/used/wrong-account token. |
| `PATCH /workspaces/:workspaceId/members/:membershipId` | OWNER | `{ role: "ADMIN" | "MEMBER" }` | `200 { id, userId, role }`; audit event is transactional | `403` non-owner; `404` outside workspace; `409` owner role cannot change. |
| `DELETE /workspaces/:workspaceId/members/:membershipId` | ADMIN; ADMIN may remove MEMBER only | None | `204`; removal and audit are transactional and conditionally protect the owner and current role | `403` admin removing another admin; `404` outside workspace; `409` owner cannot be removed or role changed concurrently. |

Invitation and reset tokens are generated with cryptographic randomness and only SHA-256 token digests are stored in PostgreSQL. Raw links are placed in URL fragments so browsers do not send tokens in HTTP requests or referrer headers; the UI immediately removes the fragment from browser history. The development mailbox requires `DEV_MAILBOX_TOKEN` (at least 24 characters), is unavailable in production, is held only in API process memory, and must not be described as email delivery. Configure a real email provider before production account recovery or invitations.

### Repositories

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /workspaces/:workspaceId/repositories` | MEMBER | None | `200 RepositoryListResponseSchema` (`repositories`, `total`, `githubAppConnected`) | `403` non-member. |
| `POST /workspaces/:workspaceId/repositories` | ADMIN | `CreateRepositoryRequestSchema` (`name`, `provider`, `repositoryUrl`, `defaultBranch`) | `201 RepositoryResponseSchema` | `400` validation. A stored URL/path is metadata; repository access is checked when a local-repository operation runs. |
| `GET /workspaces/:workspaceId/repositories/:repositoryId` | MEMBER | None | `200 RepositoryResponseSchema` | `404` when the repository is not in this workspace. |
| `GET /workspaces/:workspaceId/repositories/:repositoryId/refs` | MEMBER | None | `200 RepositoryRefsResponseSchema` (`repositoryId`, `defaultBranch`, branch name/SHA/subject/time list) | `404` missing repository; `400` local path is not a readable Git checkout; filesystem access requires configured allowed roots. |
| `PUT /workspaces/:workspaceId/repositories/:repositoryId/github` | ADMIN | `ConnectGithubRequestSchema` (`fullName` in `owner/name` form) | `200 ConnectGithubResponseSchema`; returns a newly generated webhook secret once, URL, content type, and subscribed events | `400` validation, `404` missing repository. This configures the signed webhook link; it does not install a GitHub App. |
| `DELETE /workspaces/:workspaceId/repositories/:repositoryId/github` | ADMIN | None | `200 RepositoryResponseSchema`; removes GitHub name and webhook secret | `404` missing repository. |
| `GET /workspaces/:workspaceId/github-app` | MEMBER | None | `200 { configured, appSlug, installations }`; never includes credentials | `403` non-member. |
| `GET /workspaces/:workspaceId/github-app/install-url` | ADMIN | None | `200 { url, expiresInSeconds }`; URL state is signed, workspace/user-bound, and short-lived | `403` insufficient role; `503` GitHub App configuration missing. |
| `POST /workspaces/:workspaceId/github-app/installations/complete` | ADMIN | `{ installationId?, state, code }` returned by GitHub's App authorization callback | `201 { installation }`; verifies the App installation and that it is visible to the authenticated GitHub user, consumes callback state once, then stores the workspace association; if the ID is omitted and that user has several installations, returns `200 { selectionRequired, selectionToken, installations }` | `400` invalid/expired state or callback; `403` GitHub user cannot access the installation; `409` state replay; `502` GitHub error. |
| `POST /workspaces/:workspaceId/github-app/installations/select` | ADMIN | `{ selectionToken, installationId }` from the preceding multi-install response | `201 { installation }`; accepts only IDs in the signed, short-lived, one-use authorization selection | `400` invalid selection; `409` replay; `404` installation was removed; `502` GitHub error. |
| `GET /workspaces/:workspaceId/github-app/installations/:installationRecordId/repositories` | ADMIN | None | `200 { repositories: [{ id, fullName, private, defaultBranch }] }` from a short-lived installation token | `404` installation outside workspace; `403` GitHub access denied. |
| `PUT /workspaces/:workspaceId/repositories/:repositoryId/github-app` | ADMIN | `{ installationRecordId, fullName }` | `200 { repositoryId, githubFullName, installationRecordId, defaultBranch }`; confirms the selected repo is visible to the installation | `400` invalid input; `403` repo not available; `404` local repo/installation outside workspace. |
| `DELETE /workspaces/:workspaceId/repositories/:repositoryId/github-app` | ADMIN | None | `204`; disconnects the App installation link | `404` repository outside workspace. |

### Repository intelligence

All routes require MEMBER access to the workspace and the repository must belong to that workspace.

| Method and path | Request | Success response | Errors / behavior |
|---|---|---|---|
| `POST /workspaces/:workspaceId/repositories/:repositoryId/analyze` | Empty JSON body | `200 RepositoryAnalysisResponseSchema` | `404` repository missing; `400` unsafe/unreadable repository; `503` analysis is unavailable without configured allowed roots. Runs deterministic inventory/architecture analysis synchronously. |
| `GET /workspaces/:workspaceId/repositories/:repositoryId/analysis/latest` | None | `200 RepositoryAnalysisResponseSchema` | `404` repository or analysis missing. |
| `GET /workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId` | None | `200 RepositoryAnalysisResponseSchema` | `404` analysis not found in workspace/repository. |
| `GET /workspaces/:workspaceId/repositories/:repositoryId/analysis/:analysisId/files` | Query: `page` (default 1), `pageSize` (default 50, clamped 1–200), optional `category` | `200 AnalysisFileListResponseSchema` | `404` analysis not found. |
| `POST /workspaces/:workspaceId/repositories/:repositoryId/relevant-files` | `TaskRelevantFilesRequestSchema` (`taskDescription`, `limit` 1–50, default 10) | `200 TaskRelevantFilesResponseSchema` | `400` validation; `404` repository or analysis missing. Ranking uses persisted deterministic repository inventory. |

### Tasks and workflow history

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `POST /workspaces/:workspaceId/tasks` | MEMBER | `TaskSubmissionRequestSchema` (`title`, `description`, `taskType` (`CODE_PATCH` or `VERIFICATION`), `priority`, optional repository/workspace/branch/idempotency fields; CODE_PATCH requires `repositoryId`; VERIFICATION requires `repositoryId` and `verification.{baseSha,headSha,authorType,policyProfileId?}`) | `201 TaskResponseSchema` when newly created; `200` for idempotent replay | `400` invalid input/state/repository; transactional task/run/outbox persistence precedes queue dispatch. |
| `GET /workspaces/:workspaceId/tasks` | MEMBER | Query: optional `status`, `taskType` (database enum values; types no longer submittable are still listable) | `200 TaskListResponseSchema` | `400 VALIDATION_ERROR` for an unknown filter value, before any query runs; list is not paginated. |
| `GET /workspaces/:workspaceId/tasks/:taskId` | MEMBER | None | `200 TaskResponseSchema`, including attempts and ordered steps | `404` task not in workspace. |
| `GET /workspaces/:workspaceId/tasks/:taskId/patch` | MEMBER | None | `200` latest persisted `TaskPatch`, including proposal evidence, sandbox diagnostics, bounded test output, scanner versions/findings/limitations, independent review findings, cleanup status, PR fields, and CI check summaries | `404` when no patch was produced. Workspace-scoped through the task relation. |
| `POST /workspaces/:workspaceId/tasks/:taskId/publish` | ADMIN | Empty JSON object | `201 { publicationStatus, branch, commitSha, pullRequestNumber, pullRequestUrl, ciStatus }`; retries reuse the deterministic branch and open PR | `403` insufficient role; `404` missing patch; `409` patch not current/approved, tests, scan, or independent review not explicitly `PASSED`, dirty/stale source, or missing App link; `502` GitHub failure. It never writes to the default branch. |
| `POST /workspaces/:workspaceId/tasks/:taskId/ci/sync` | MEMBER | Empty JSON object | `200 { ciStatus, checks, diagnosis, syncedAt }` from actual GitHub check runs and latest commit statuses. For failed check runs, the API fetches up to 10 annotation lists (25 each), sanitizes and bounds the failure summary, and maps valid repository-relative annotation paths into a persisted diagnosis. | `404` missing patch; `409` no published PR; `502` GitHub failure. No checks are reported as `NOT_CONFIGURED`, never success. |
| `POST /workspaces/:workspaceId/tasks/:taskId/cancel` | MEMBER | None | `200 CancelTaskResponseSchema` | `404` task not in workspace; `400` task is not cancellable. A running task receives a cancellation request for the worker. |
| `GET /workspaces/:workspaceId/tasks/:taskId/runs` | MEMBER | None | `200 { runs: WorkflowRunResponseSchema[], total }` | Workspace-scoped by the task relationship. |
| `GET /workspaces/:workspaceId/runs/:runId` | MEMBER | None | `200 WorkflowRunResponseSchema` with ordered steps | `404` workflow run not in workspace. |

`taskType` is required. Only `CODE_PATCH` and `VERIFICATION` have a worker workflow and are accepted at submission; `BUG_INVESTIGATION`, `TEST_GENERATION`, `CODE_REVIEW`, and `CI_DIAGNOSIS` remain in the response enum for stored tasks but are rejected with `400 VALIDATION_ERROR` (field `taskType`) before anything is persisted. `CODE_PATCH` requires `repositoryId` at submission and, at run time, a registered local repository, configured authorized roots, a separate `TASK_WORKSPACE_ROOT`, internal agent service, and a working proposal model. It copies a secret-filtered snapshot, requests an evidence-bearing proposal, validates and applies the unified diff only inside the disposable copy, and allows one repair request for an invalid diff. When an opt-in sandbox is available it runs fixed-policy tests, read-only security scanners, and a separately configured reviewer before requesting a second-person approval. Missing runtime/tools/reviewer, failed tests/scans, or review findings are saved as actual blocked results; they do not create an approval. The source checkout is not written. A cancellation observed during scans, tests, or review stops the workflow before the next stage; no patch artifact or approval is stored. Tasks of other types queued before submission was restricted still end `NEEDS_ATTENTION` with `WORKFLOW_UNAVAILABLE`.

Task workspace names are unique per attempt. When the worker starts with `TASK_WORKSPACE_ROOT` configured, it removes only recognized direct-child workspaces tagged for this host whose recorded worker PID is no longer alive. Active and other-host workspaces are preserved. Sandbox containers also enforce an in-container command deadline and use Docker auto-removal so a worker crash does not leave repository execution unbounded.

### Patch approvals

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /workspaces/:workspaceId/approvals` | MEMBER | Optional `status` (`PENDING`, `APPROVED`, `REJECTED`) | `200 { approvals, total }`; each entry includes `patchIsCurrent` | `400` invalid status; workspace-isolated. |
| `POST /workspaces/:workspaceId/tasks/:taskId/approvals` | MEMBER | `{ patchHash: <64 lowercase hex chars> }` | `201` newly requested approval, `200` existing pending approval | `404` task outside workspace; `409` patch tests, security scans, or independent review are not all `PASSED`; `409` task has no current reviewable `CODE_PATCH` proposal or an approval/decision already exists. The hash must equal `task.executionMetadata.patchHash`. |
| `GET /workspaces/:workspaceId/approvals/:approvalId` | MEMBER | None | `200` approval, associated task/run history, requester/decider, `patchIsCurrent`, and audit history | `404` approval outside workspace. |
| `POST /workspaces/:workspaceId/approvals/:approvalId/decision` | ADMIN or OWNER | `{ decision: "APPROVED" | "REJECTED", reason? }`; rejection requires a reason | `200` updated approval with reviewer and timestamp | `403` member, requester self-review, or role changed; `409` `APPROVED` for a patch whose verification did not all pass (rejection stays allowed); `404` approval outside workspace; `409` duplicate decision or stale patch hash. Decision and audit event are transactional. |

Approval records are bound to the proposal hash, and one approval per task/hash is enforced by a database unique index. The worker creates the durable `TaskPatch` and pending `Approval` in the same transaction only after tests, security scans, and independent review all pass. Publication additionally requires the current patch, a different workspace administrator/owner, an exact approved hash, and a task that is not cancelled. In the inspected host, Docker and a reviewer identity were unavailable; new patch records therefore remain blocked and do not request approval.

### GitHub App and PR lifecycle

Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` together on the API server. In GitHub App settings, enable **Request user authorization (OAuth) during installation** and set the callback URL to `<PUBLIC_WEB_URL>/settings`. GitHub's install URL carries a signed, workspace/user-bound state value. The callback's one-time OAuth code is exchanged on the server, and the installation must appear in that user's `GET /user/installations` response before the workspace link is saved. If the redirect omits the installation ID and that user has more than one installation, the UI asks which one to connect using a signed, one-use selection token. This rejects spoofed installation IDs. Grant only Repository metadata read, Contents read/write, Pull requests read/write, Checks read, and Commit statuses read permissions. Subscribe to `installation`, `installation_repositories`, `pull_request`, `check_run`, `check_suite`, and `status` events. The API creates short-lived installation tokens server-side and never returns or logs either App or user tokens. See GitHub's [setup URL security guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url), [user access token flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [App permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

The publisher only creates a branch under `asea/task-*`. It requires the source checkout to have been clean when snapshotted, compares the remote base SHA and each changed file's SHA-256 to the stored snapshot basis, reapplies the approved diff in a disposable temporary directory, and creates Git blobs/tree/commit plus a PR. It does not push to a default branch. CI polling and signed App check webhooks update persisted check summaries and annotation-backed diagnoses; failure details are bounded and secret-like values are redacted. Diagnosis reports GitHub-supplied annotations and does not infer additional code causes. Automated repair and sandbox re-runs are not implemented because no isolated execution provider is configured.

### Verification results and audit trail

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /workspaces/:workspaceId/verification-runs` | MEMBER | Query: optional `taskId`, `repositoryId`, `status`, `verdict`, `limit` (1–100, default 20), `cursor` | `200 VerificationRunListResponseSchema`; newest first with `nextCursor` | `400` invalid query; workspace-isolated. |
| `GET /workspaces/:workspaceId/verification-runs/:runId` | MEMBER | None | `200 VerificationRunDetailResponseSchema`: run, score breakdown, policy snapshot, agent timeline, report, engine info | `404` run not in workspace. Fields not available before completion are null/empty. |
| `GET /workspaces/:workspaceId/verification-runs/:runId/findings` | MEMBER | Query: optional `severity` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) | `200 VerificationFindingListResponseSchema` | `400` invalid severity; `404` run not in workspace. |
| `GET /workspaces/:workspaceId/verification-runs/:runId/audit/events` | MEMBER | None | `200 AuditEventListResponseSchema`; oldest first | `404` run not in workspace. |
| `GET /workspaces/:workspaceId/verification-runs/:runId/audit/verify` | MEMBER | None | `200 AuditChainVerificationResponseSchema`: hash-chain, run-seal, findings, score, and report integrity results | `404` run not in workspace. An invalid audit produces a successful response with `valid: false` and failure details. |

### Policies and dashboard/system status

| Method and path | Auth / role | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `GET /workspaces/:workspaceId/policies` | MEMBER | None | `200 PolicyProfileListResponseSchema`; ensures a default policy exists | `403` non-member. |
| `POST /workspaces/:workspaceId/policies` | ADMIN | `CreatePolicyProfileRequestSchema` (`name`, optional description, `config`, optional `isDefault`) | `201 PolicyProfileResponseSchema` | `400` invalid policy, `409` duplicate name. |
| `GET /workspaces/:workspaceId/policies/:policyId` | MEMBER | None | `200 PolicyProfileResponseSchema` | `404` profile not found in workspace. |
| `PATCH /workspaces/:workspaceId/policies/:policyId` | ADMIN | `UpdatePolicyProfileRequestSchema` (non-empty partial name/description/config and optional `isDefault: true`) | `200 PolicyProfileResponseSchema` | `400` validation, `404` missing profile, `409` duplicate name. Changes apply to future runs; existing runs retain their policy snapshot. |
| `DELETE /workspaces/:workspaceId/policies/:policyId` | ADMIN | None | `204 No Content` | `404` missing profile, `409` default policy cannot be deleted. |
| `GET /workspaces/:workspaceId/stats` | MEMBER | None | `200 WorkspaceStatsResponseSchema`: counts, score average, finding severity counts, 14-day UTC activity, recent runs | `403` non-member. |
| `GET /system/status` | Any authenticated user | None | `200 SystemStatusResponseSchema`: engine readiness, LLM/index status, sandbox provider/image diagnostics, GitHub comment configuration, public/webhook URLs | Engine or sandbox unavailability is reported in the response rather than failing the endpoint. |

### GitHub webhook

| Method and path | Auth | Request | Success response | Errors / behavior |
|---|---|---|---|---|
| `POST /webhooks/github` | GitHub HMAC signature (`X-Hub-Signature-256`), not a user session | GitHub JSON payload plus `X-GitHub-Event` and `X-GitHub-Delivery` | `200` for `ping`; `202` for accepted PR/CI/install events | `400` missing event/delivery headers or wrong content type; `401` invalid signature. Legacy repository secrets continue to validate PR verification events; the GitHub App webhook secret validates App events and linked-repository PR/CI events. PR deliveries remain idempotent; repeated CI updates converge to the same persisted state. |

## Internal Python agent service

The service listens on `AI_SERVICE_URL`. `/health` and `/ready` are public probes; all `/api/v1/*` routes require `X-Internal-Token` matching `INTERNAL_SERVICE_TOKEN`. Missing service configuration returns `503`, invalid/missing token returns `401`, oversized bodies return `413`, and Pydantic request validation returns `422` with the shared error envelope.

| Method and path | Request model | Response model | Notes |
|---|---|---|---|
| `GET /health` | None | `HealthResponse` | Liveness. |
| `GET /ready` | None | `ReadinessResponse` | Reports LLM provider and code-index readiness. |
| `POST /api/v1/analyze` | `AnalysisRequest` | `501 { success: false, error: { code: "NOT_IMPLEMENTED", message, requestId?, timestamp } }` | Retired triage placeholder. No analysis is claimed; use the verification workflow for code-change review. |
| `POST /api/v1/verify/static` | `VerificationRequest` | `StaticAnalysisResult` | Deterministic static checks and configured static-analysis tools. Invalid verification input returns `422`. |
| `POST /api/v1/verify/score` | `ScoreRequest` | `ScoreResult` | Deterministic scoring. |
| `POST /api/v1/verify` | `PipelineRequest` | `PipelineResult` or `application/x-ndjson` events | Full verification graph. NDJSON accepts `agent_started`, `agent_finished`, then `result` or `error` lines. LLM stages may be skipped when no provider is usable; `complete` reports that state. |
| `POST /api/v1/index` | `IndexRequest` | `IndexResponse` | Indexes supplied repository file batches; marks index complete on the final batch. |
| `GET /api/v1/index/:repository_id/:commit_sha` | Path parameters | `IndexStatus` | Checks whether that commit is indexed. |
| `POST /api/v1/engineering/propose` | `PatchProposalRequest` (`task_id`, `requirement`, up to 24 bounded `files`, optional repair feedback) | `PatchProposal` (`summary`, structured `plan`, path/source-grounded `evidence`, `unified_diff`) | Uses the configured proposal LLM; missing provider returns `503`, provider failures return a sanitized `502`/`503`. Proposal content is untrusted and must be validated by the Node patch applicator. This route never applies or executes a patch. |
| `POST /api/v1/engineering/review` | `PatchReviewRequest` (task, requirement, source context, proposal summary/plan/evidence/diff) | `PatchReview` (`APPROVE` or `REQUEST_CHANGES`, bounded findings with evidence) | Requires a separately configured reviewer provider/key/model identity. A matching proposal model identity is rejected. It never applies or executes a patch. |

Python model definitions: [`schemas.py`](../services/agent-service/app/schemas.py), [`verification/contract.py`](../services/agent-service/app/verification/contract.py), [`verification/policy.py`](../services/agent-service/app/verification/policy.py), and [`pipeline/contract.py`](../services/agent-service/app/pipeline/contract.py). FastAPI's generated OpenAPI schema is available at `/openapi.json` when the service is running.

## Known coverage and limitations

- No real email provider is configured; invitations and known-account reset links require the explicitly identified development mailbox. Task retry remains queue-internal, and automated CI repair is not implemented. GitHub diagnosis/publication has mocked boundary coverage, but no live GitHub App credentials are configured. The sandbox ran live in Docker, but independent review credentials are absent, so approval/publication remains gated off. Scanner execution pins trusted Gitleaks and OSV configuration in the image, disables Gitleaks and Semgrep inline exceptions and Git ignores, and scans ignored dependency files. A repository `.semgrepignore` causes Semgrep to be marked unavailable rather than clean.
- Several Node tests mock PostgreSQL, Redis, GitHub, and the Python service. Passing tests do not establish live database, queue, LLM, or GitHub behavior.
- No live service URLs are provided because no project services were running during the audit.
