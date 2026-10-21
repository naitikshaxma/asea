# Static-analysis fixtures

- `demo_app/` is a tiny Flask app with a clear pattern: routes in `routes/`
  call a `services/` layer, every route is protected by `@login_required`,
  request bodies go through `validate_payload()`, and `tests/` covers the
  service functions. It is fixture data: the agent-service test run never
  imports or collects it (see `tests/conftest.py`).
- `diffs/<case>.diff` is `git diff` output against `demo_app/` (paths are
  relative to `demo_app/`). `diffs/<case>.expected_findings.json` lists every
  finding the static-analysis node must report for that diff, and nothing
  else, matched on `rule_id`, `category`, `severity`, `file` and `line`.

| Case | Change | Expected |
|---|---|---|
| `clean` | authenticated `PATCH` route, `rename_project()` service and a test for it | no findings |
| `missing_auth` | new `GET /projects/export` route without `@login_required` | `ASEA-PY-ROUTE-NO-AUTH` |
| `secret_and_sql` | hardcoded API key; f-string SQL passed to `cursor.execute()` (the new function is tested) | `ASEA-PY-HARDCODED-SECRET`, `ASEA-PY-SQL-STRING-FORMAT` |
| `no_tests` | new `archive_project()` service function with no test referencing it | `ASEA-PY-TEST-GAP` |

The API key in `secret_and_sql.diff` is a made-up value that matches no real
provider's key format.
