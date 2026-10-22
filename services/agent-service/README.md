# Agent Service (FastAPI)

Modular Python service skeleton for AI reasoning, repository intelligence, and agent orchestration.

## Phase 1 Scope

In Phase 1, this service acts as the foundation and contract verification point for future autonomous agents:
- Provides `/health` and `/ready` endpoints adhering to the platform shared contracts.
- Provides `/api/v1/analyze` contract endpoint for triage analysis.
- Runs without requiring any paid LLM API key by leveraging a local mock provider.
- Configured with Pydantic v2 schemas and strict environment validation.

## Local Development

### 1. Setup Virtual Environment
```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Run Service
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. Run Tests
```bash
pytest
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Process uptime and health status |
| `GET` | `/ready` | Service readiness and dependency connectivity |
| `POST` | `/api/v1/analyze` | Repository task analysis and triage skeleton |
| `POST` | `/api/v1/verify/static` | ASEA static analysis: `VerificationRequest` → `StaticAnalysisResult` |
| `POST` | `/api/v1/verify/score` | Deterministic scoring: `{findings, policy}` → `ScoreResult` (score, verdict, per-finding breakdown, caps) |

## Security

Every `/api/v1/*` request needs the `X-Internal-Token` header set to
`INTERNAL_SERVICE_TOKEN` (shared with the Node worker; while it is unset those
routes return 503). There is no CORS: only the worker calls this service.
Bodies over `AGENT_MAX_REQUEST_BYTES` (default 5 MiB) get 413. `/health` and
`/ready` need no token.

## Scoring (`POST /api/v1/verify/score`)

Pure and deterministic (`app/verification/scoring.py`; models in
`app/verification/policy.py`, mirrored by `packages/contracts/src/policy.ts`).
Each finding deducts `severity_weight × category_multiplier ×
source_multiplier` (rounded to 4 decimals) from 100; the remainder is rounded
half-up and clamped to 0–100; every cap whose condition holds (at least
`min_count` findings of a severity) limits the score to `max_score`; the
verdict is the first of `allow`, `review`, `high_risk`, `block` whose minimum
the score reaches. The result carries `policy_hash` (sha256 of the policy's
canonical JSON), which the worker checks against the run's policy snapshot.

The default policy (`packages/contracts/schemas/default-policy.json`) is a
**placeholder**: its numbers were picked so the four demo fixtures land in
distinct bands (clean → allow, no_tests → review, missing_auth → high_risk,
secret_and_sql → block) and are not calibrated against real changes.

## Static analysis (`POST /api/v1/verify/static`)

Stateless and deterministic: the request carries the unified diff and the head
content of the changed files (`app/verification/contract.py`, mirrored in
`packages/contracts/src/verification.ts`). Nothing is read from disk or a
database. Only `.py` files the diff adds or modifies are analysed, and only on
the lines the diff changes: added lines plus the line where a removal happened
(so deleting `@login_required` from an existing route is reported).

| Rule | Category / severity | Reports |
|---|---|---|
| `ASEA-PY-ROUTE-NO-AUTH` | static / high | A route handler (`@x.route/get/post/put/patch/delete(...)`) whose decorators or `def` line changed and that has none of the `ASEA_AUTH_DECORATORS` |
| `ASEA-PY-BARE-EXCEPT` | static / low | `except:` without an exception type |
| `ASEA-PY-HARDCODED-SECRET` | static / critical | Assignment of a string of 8+ characters (not a URL) to a name like `*secret*`, `*token*`, `*password*`, `*api_key*`, `*private_key*`, `*access_key*`, `*credential*`. The value is never echoed in evidence |
| `ASEA-PY-SUBPROCESS-SHELL` | static / high | `subprocess.run/call/check_call/check_output/Popen(..., shell=True)` |
| `ASEA-PY-EVAL-EXEC` | static / high | `eval(...)` or `exec(...)` |
| `ASEA-PY-SQL-STRING-FORMAT` | static / high | `.execute()`/`.executemany()` whose first argument is an f-string, `%`-formatted, `+`-concatenated or `.format()`-ed string |
| `ASEA-PY-TEST-GAP` | test_gap / medium | A new public module-level function or method (outside test files) that no test file in `changed_files` mentions by name. Route handlers are skipped (tests reach them by URL), and a changed `def` line of an existing function does not count as new |
| `ASEA-PY-PARSE-ERROR` | static / medium | A changed `.py` file that does not parse; no other ast checks run on it |

Requests with an unparseable diff, an absolute or `..` path, or a changed
`.py` file missing from `changed_files` are rejected with 422.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ASEA_AUTH_DECORATORS` | `login_required` | Comma-separated decorator names that count as authentication |
| `SEMGREP_COMMAND` | `semgrep` | Command prefix used to run Semgrep; `{workdir}` is replaced by the temporary directory holding the changed files |
| `SEMGREP_RULESET` | `rules/semgrep/p-python.json` | Pinned ruleset, downloaded by `npm run semgrep:rules` (see [rules/semgrep/README.md](rules/semgrep/README.md)) |
| `SEMGREP_RULES_LOCK` | `rules/semgrep/p-python.lock.json` | Lock holding the ruleset's expected sha256 |
| `SEMGREP_TIMEOUT_SECONDS` | `120` | Timeout for the whole Semgrep run |

### Semgrep (optional)

Semgrep runs offline with a pinned ruleset: the 151 rules of the registry pack
`p/python` at a fixed semgrep-rules commit, downloaded once by
`npm run semgrep:rules` (the rules are licensed for internal use only and are
not committed; see [rules/semgrep/README.md](rules/semgrep/README.md)). Before
each scan the service checks the file's sha256 against the lock; a missing or
different file means Semgrep is skipped.

The changed `.py` files and a copy of the ruleset are written to a temporary
directory, and `semgrep scan --config <ruleset> --json --metrics off ./<file>...`
is called as an argument list (never through a shell) with a timeout. No
registry config is passed, so Semgrep needs no network access. Its results are
limited to the changed lines, and a result on a file and line the ast checks
already reported is folded into that finding's evidence. When Semgrep ran,
`semgrep_ruleset_sha256` in the result is the ruleset's sha256 (otherwise
null). If the command is not found, the ruleset is missing or does not match,
or Semgrep times out, fails or prints something other than JSON, the response
lists `semgrep` in `tools_unavailable` and the ast findings are still returned.

Semgrep does not install natively on Windows. Two ways to use it there:

- **WSL**: install a distribution (`wsl --install -d Ubuntu`), then inside it
  `python3 -m pip install --user semgrep` (or `pipx install semgrep`), and set
  `SEMGREP_COMMAND="wsl semgrep"`. WSL maps the Windows working directory, so the
  temporary directory is visible to Semgrep.
- **Docker** (pin a version; `--network none` guarantees it stays offline):
  ```
  SEMGREP_COMMAND="docker run --rm --network none -v {workdir}:/src -w /src semgrep/semgrep:1.181.0 semgrep"
  ```

On Linux/macOS, `python3 -m pip install semgrep` and the default
`SEMGREP_COMMAND=semgrep` are enough. The Docker form was checked with
`semgrep/semgrep:1.181.0` and `--network none` against the fixtures in
`tests/fixtures/`; the automated tests fake the Semgrep process and do not need
it installed.

## Phase 2 Roadmap
- Integrated AST code graph indexing.
- Multi-turn LLM reasoning loop with bounded tool usage.
- Secure communication with `workers/execution-worker` for isolated verification.
