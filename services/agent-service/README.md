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
| `SEMGREP_CONFIG` | `p/python` | Semgrep ruleset (fetched from the Semgrep registry, so it needs network access) |
| `SEMGREP_TIMEOUT_SECONDS` | `120` | Timeout for the whole Semgrep run |

### Semgrep (optional)

Semgrep runs on the changed `.py` files only: they are written to a temporary
directory and scanned with `semgrep scan --config $SEMGREP_CONFIG --json
--metrics off`, called as an argument list (never through a shell) with a
timeout. Its results are limited to the changed lines, and a result on a file
and line the ast checks already reported is folded into that finding's
evidence. If the command is not found, times out, fails or prints something
other than JSON, the response lists `semgrep` in `tools_unavailable` and the ast
findings are still returned.

Semgrep does not install natively on Windows. Two ways to use it there:

- **WSL**: install a distribution (`wsl --install -d Ubuntu`), then inside it
  `python3 -m pip install --user semgrep` (or `pipx install semgrep`), and set
  `SEMGREP_COMMAND="wsl semgrep"`. WSL maps the Windows working directory, so the
  temporary directory is visible to Semgrep.
- **Docker** (pin a version):
  ```
  SEMGREP_COMMAND="docker run --rm -v {workdir}:/src -w /src semgrep/semgrep:1.181.0 semgrep"
  ```

On Linux/macOS, `python3 -m pip install semgrep` and the default
`SEMGREP_COMMAND=semgrep` are enough. The Docker form was checked with
`semgrep/semgrep:1.181.0` against the fixtures in `tests/fixtures/`; the
automated tests fake the Semgrep process and do not need it installed.

## Phase 2 Roadmap
- Integrated AST code graph indexing.
- Multi-turn LLM reasoning loop with bounded tool usage.
- Secure communication with `workers/execution-worker` for isolated verification.
