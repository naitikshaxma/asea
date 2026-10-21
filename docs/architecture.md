# Platform Architecture Specification (Phase 3)

## 1. System Topology & Architecture Overview

The Autonomous AI Software Engineering Platform is architected as a modular, contract-driven monorepo. Phase 3 introduces the **Repository Intelligence Engine**, encompassing secure filesystem snapshot collection, evidence-backed technology detection, AST architecture summarization, task-focused file retrieval, and database-backed analysis persistence.

```mermaid
graph TD
    subgraph Client["Developer Interface (apps/web)"]
        UI["React 18 + Vite Dashboard"]
        AuthModal["Auth Modal (Login/Register)"]
        State["API Client & Session State"]
        RepoMgr["Workspace Repository Manager"]
        TaskForm["Task Intake & Real Workflow Viewer"]

        UI --> AuthModal
        UI --> State
        UI --> RepoMgr
        UI --> TaskForm
    end

    subgraph Core["Control Plane (services/api)"]
        Express["Express 4 Application"]
        AuthMid["JWT & HttpOnly Cookie Auth Middleware"]
        WkMid["Workspace Membership & Role Middleware"]
        StateMachine["Central Workflow State Machine"]
        PrismaORM["Prisma ORM Client Singleton"]
        OutboxDispatcher["Transactional Outbox Poller & Dispatcher"]
        QueueSvc["BullMQ Queue Service (ae-tasks)"]

        Express --> AuthMid
        AuthMid --> WkMid
        Express --> StateMachine
        Express --> PrismaORM
        Express --> QueueSvc
        OutboxDispatcher --> PrismaORM
        OutboxDispatcher --> QueueSvc
    end

    subgraph Worker["Background Worker Process (services/api/worker.ts)"]
        BullWorker["BullMQ Worker Runner"]
        DeterministicSteps["Deterministic Safe Processing Pipeline"]
        BullWorker --> DeterministicSteps
        DeterministicSteps --> PrismaORM
    end

    subgraph Storage["Persistent & Ephemeral Stores"]
        PG[("PostgreSQL 16: Users, Workspaces, Repos, Tasks, Runs, Steps, Outbox")]
        RD[("Redis 7: BullMQ Queues, Job Locks, Ephemeral State")]
    end

    subgraph Contracts["Shared Contracts (packages/contracts)"]
        Schemas["Zod Schemas & TypeScript DTOs"]
        AuthContracts["Auth, Workspace & Repo Contracts"]
        TaskContracts["Task, State Machine & Workflow Contracts"]
    end

    State -->|HTTP / JSON (Bearer or Cookie)| Express
    PrismaORM -->|Parameterized SQL| PG
    QueueSvc -->|Job Enqueueing| RD
    BullWorker -->|Job Processing & Locks| RD
```

---

## 2. Core Service Boundaries

### 2.1 Web Frontend (`apps/web`)
- **Technology**: React 18, Vite 6, TypeScript, Tailwind CSS, Lucide icons.
- **Responsibilities**:
  - Authenticated session lifecycle (Sign in, Register, Sign out).
  - Multi-tenant workspace switcher and role display.
  - Workspace repository registration and association.
  - Real task intake with honest backend status reflection.
  - Expandable workflow run and step execution history.
  - Task cancellation for cancellable statuses (`QUEUED`, `RUNNING`).

### 2.2 Control Plane API (`services/api`)
- **Technology**: Node.js 24, Express 4, TypeScript, Prisma ORM, BullMQ, Zod.
- **Responsibilities**:
  - User registration with automatic personal workspace provisioning.
  - Timing-safe authentication and bcrypt password hashing (cost factor 12).
  - JWT issuance in both `Authorization: Bearer` and secure HttpOnly cookies.
  - Workspace membership verification with role hierarchy (`OWNER` > `ADMIN` > `MEMBER`).
  - Atomic database transactions for task, workflow run, and outbox event creation.
  - Cross-workspace data isolation preventing tenant data leakage.

### 2.3 Transactional Outbox & BullMQ (`services/api/src/services`)
- **Dual-Write Mitigation**: Rather than attempting a distributed transaction across PostgreSQL and Redis, task submissions create a `Task`, an initial `WorkflowRun`, and an `OutboxEvent` within one atomic PostgreSQL transaction.
- **Outbox Dispatcher (`outboxDispatcher.ts`)**: Background loop polls pending outbox events using `SELECT ... FOR UPDATE SKIP LOCKED`, dispatches them to the BullMQ `ae-tasks` queue in Redis, and marks them `PROCESSED` with a timestamp.
- **Guarantees**: Provides at-least-once delivery with idempotent deduplication via unique BullMQ job IDs (`task:<taskId>:<runId>`).

### 2.4 Background Worker Process (`services/api/src/worker.ts`)
- **Technology**: BullMQ `Worker`, Redis, Prisma ORM.
- **Execution Model**: Runs as an isolated Node.js process (or worker thread).
- **Safe Deterministic Pipeline**:
  - `VALIDATE_CONTEXT`: Validates payload schema and confirms repository metadata boundaries.
  - `INSPECT_REPOSITORY`: Inspects target workspace repository record and branch references.
  - `GENERATE_SPEC`: Generates execution plan specification.
  - `VERIFY_BOUNDARIES`: Verifies security constraints and commits step results to PostgreSQL.
- **Security Boundary**: **No arbitrary host shell commands are executed.** Code modification is deferred to Phase 3.

---

## 3. Database Schema Overview (Prisma ORM)

The PostgreSQL database is normalized and migration-managed (`prisma/migrations`):

| Model | Primary Purpose | Key Fields |
|---|---|---|
| `User` | User identity & authentication | `id`, `email` (unique), `passwordHash`, `displayName`, `accountStatus` |
| `Workspace` | Multi-tenant isolation boundary | `id`, `name`, `ownerId` |
| `WorkspaceMembership` | User-to-workspace role mapping | `workspaceId`, `userId`, `role` (`OWNER`, `ADMIN`, `MEMBER`), unique(`workspaceId`, `userId`) |
| `Repository` | Registered code repositories | `id`, `workspaceId`, `name`, `provider`, `repositoryUrl`, `defaultBranch`, `connectionStatus` |
| `Task` | Durable engineering tasks | `id`, `workspaceId`, `repositoryId`, `creatorId`, `title`, `description`, `taskType`, `priority`, `status` |
| `WorkflowRun` | Task execution attempts | `id`, `taskId`, `attemptNumber`, `status`, `workerId`, `startedAt`, `finishedAt` |
| `WorkflowStep` | Fine-grained run lifecycle steps | `id`, `runId`, `stepType`, `stepStatus`, `stepOrder`, `resultMetadata` |
| `Approval` | Human-in-the-loop decisions | `id`, `taskId`, `stepId`, `status`, `decisionMakerId`, `reason` |
| `AuditEvent` | Security & compliance audit trail | `id`, `workspaceId`, `actorId`, `eventType`, `resourceId`, `metadata` |
| `OutboxEvent` | Transactional outbox event queue | `id`, `aggregateType`, `aggregateId`, `eventType`, `payload`, `status`, `retryCount` |
| `RepositoryAnalysis` | Persisted repository intelligence snapshots | `id`, `workspaceId`, `repositoryId`, `status`, `commitHash`, `analyzerVersion`, `summary`, `technologies`, `statistics`, `fileInventory` |

---

## 4. Workflow State Machine

State transitions are centrally governed by `workflowStateMachine.ts`:

```
               ┌───────────┐
               │  QUEUED   │
               └─────┬─────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   ┌───────────┐           ┌───────────┐
   │  RUNNING  │           │ CANCELLED │
   └─────┬─────┘           └───────────┘
         │
   ┌─────┴──────────────────┬─────────────────┐
   ▼                        ▼                 ▼
┌───────────┐         ┌───────────┐    ┌──────────────────┐
│ COMPLETED │         │  FAILED   │    │ CANCEL_REQUESTED │
└───────────┘         └───────────┘    └────────┬─────────┘
                                                │
                                                ▼
                                         ┌───────────┐
                                         │ CANCELLED │
                                         └───────────┘
```

- **Validation Rules**: Terminal states (`COMPLETED`, `FAILED`, `CANCELLED`) cannot transition backward to `RUNNING`. Retrying a task requires instantiating a new `WorkflowRun`.
- **Cancellation**: Cancelling an active job transitions it to `CANCEL_REQUESTED`, allowing the worker to safely terminate processing and record `CANCELLED`.

---

## 5. Repository Intelligence Engine Architecture (Phase 3)

The Repository Intelligence Engine provides deterministic codebase comprehension without arbitrary shell execution:

```
[ Repository Source Directory ]
             │
             ▼
[ 1. snapshotCollector.ts ]
   ├── Canonicalize path & enforce ALLOWED_REPO_ROOTS
   ├── Verify symlink realpath containment (prevent escapes)
   ├── Exclude secret files (.env, *.key, *.pem, id_rsa, credentials.json)
   ├── Sniff binary files (null bytes & control characters)
   └── Enforce bounds (MAX_FILES, MAX_FILE_SIZE, MAX_TOTAL_BYTES, TIMEOUT)
             │
             ├── Eligible Files + Text Buffers
             │
             ├──► [ 2. technologyDetector.ts ]
             │       ├── Parse package.json, pyproject.toml, go.mod, Cargo.toml, Dockerfile
             │       └── Produce evidence-backed findings with confidence & rationales
             │
             ├──► [ 3. architectureSummarizer.ts ]
             │       ├── Extract entry points, key modules, API routes, service/model files
             │       └── Build static relationship graph (IMPORTS, TESTS, CONFIGURES)
             │
             ▼
[ 4. repositoryAnalysisService.ts ]
   ├── Persist to PostgreSQL (RepositoryAnalysis model via Prisma)
   └── Expose via Authenticated, Tenant-Scoped REST Endpoints
             │
             ▼
[ 5. relevanceRanker.ts ] (On-Demand Task Retrieval)
   ├── Extract query keywords & code tokens from engineering prompt
   ├── Score candidate files (token match, basename match, category weight, test coverage)
   └── Return top N ranked files with scores (0-100), reasons, and action recommendations
```

### 5.1 Snapshot Collector Security Pipeline
1. **Path Canonicalization**: `path.resolve` and `fs.realpathSync` eliminate directory traversal (`../`), null bytes (`\0`), and path separators spoofing.
2. **Allowed Roots Jail**: If `ALLOWED_REPO_ROOTS` is set, verifies target repository resides inside an authorized directory hierarchy.
3. **Symlink Containment**: Resolves real path of symlinks; if target escapes repo root, the entry is skipped with reason `SYMLINK_ESCAPE`.
4. **Zero Secret Leakage**: File paths matching secret patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials.json`, `*secret*`, `*token*`) are strictly excluded.
5. **Binary Sniffing**: Inspects the first 1KB of each file for null bytes. Binary files are tracked in inventory as `BINARY` but skipped from AST summarization.

### 5.2 Relevance Ranking Engine
The relevance ranker scores repository files against natural language engineering prompts:
- **Token Extraction**: Tokenizes prompt, identifies camelCase / snake_case code symbols, and filters common English stop-words.
- **Match Scoring**:
  - Exact filename match: **+40 points**
  - Token in filename: **+20 points**
  - Token in path: **+10 points**
  - Exact token in content: **+8 points**
- **Relational Propagation**:
  - Test bonus: If a source file matches query tokens, related test files receive **+15 bonus points** and vice-versa.
  - Category weighting: Source files matching query tokens receive a **+12 point category bonus**.
- **Action Recommendations**: Assigns recommended actions (`MODIFY` for high-scoring primary candidates, `REFERENCE` for models and configs, `EXTEND_TESTS` for corresponding test suites).
