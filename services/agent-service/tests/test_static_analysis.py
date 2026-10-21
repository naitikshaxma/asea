import difflib
import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.verification import semgrep_runner
from app.verification.semgrep_runner import RULESET_NAME, build_command
from tests.fixture_support import CASES, load_case

ENDPOINT = "/api/v1/verify/static"


@pytest.fixture(autouse=True)
def semgrep_not_installed(monkeypatch):
    """Default for these tests: Semgrep is not on PATH (as on this Windows dev box)."""
    monkeypatch.setattr(semgrep_runner.shutil, "which", lambda _name: None)


def request_body(diff: str, files: dict[str, str]) -> dict:
    return {
        "repository_id": "repo-1",
        "base_sha": "a" * 40,
        "head_sha": "b" * 40,
        "requirement": "test",
        "unified_diff": diff,
        "changed_files": [{"path": p, "head_content": c} for p, c in files.items()],
        "author_type": "human",
    }


def new_files(files: dict[str, str]) -> dict:
    diff = ""
    for path, source in files.items():
        lines = source.splitlines(keepends=True)
        diff += f"diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
        diff += f"@@ -0,0 +1,{len(lines)} @@\n" + "".join("+" + line for line in lines)
    return request_body(diff, files)


def modified_file(path: str, base: str, head: str) -> dict:
    diff = "".join(
        difflib.unified_diff(base.splitlines(True), head.splitlines(True), fromfile=f"a/{path}", tofile=f"b/{path}")
    )
    return request_body(diff, {path: head})


def findings(client: TestClient, body: dict) -> list[dict]:
    response = client.post(ENDPOINT, json=body)
    assert response.status_code == 200, response.text
    return response.json()["findings"]


def rules(client: TestClient, body: dict) -> list[tuple[str, int]]:
    return [(f["rule_id"], f["line"]) for f in findings(client, body)]


# --- Fixture cases -----------------------------------------------------------


@pytest.mark.parametrize("case", CASES)
def test_fixture_case_produces_exactly_its_expected_findings(client: TestClient, case: str):
    request, expected = load_case(case)
    response = client.post(ENDPOINT, json=request.model_dump())
    assert response.status_code == 200, response.text
    result = response.json()

    keys = ("rule_id", "category", "severity", "file", "line")
    actual = sorted(tuple(f[k] for k in keys) for f in result["findings"])
    assert actual == sorted(tuple(e[k] for k in keys) for e in expected)
    assert result["tools_run"] == ["python-ast"]
    assert result["tools_unavailable"] == ["semgrep"]
    for finding in result["findings"]:
        assert finding["source"] == "deterministic" and finding["evidence"] and finding["remediation"]


def test_clean_fixture_produces_no_findings(client: TestClient):
    request, _ = load_case("clean")
    assert findings(client, request.model_dump()) == []


def test_secret_evidence_never_contains_the_value(client: TestClient):
    request, _ = load_case("secret_and_sql")
    secret = next(f for f in findings(client, request.model_dump()) if f["rule_id"] == "ASEA-PY-HARDCODED-SECRET")
    assert "demo-reporting-key" not in json.dumps(secret)
    assert secret["evidence"] == ["REPORTING_API_KEY = <redacted string, 35 characters>"]


# --- Individual checks ---------------------------------------------------------


def test_eval_and_exec(client: TestClient):
    src = "import ast\n\nx = eval(data)\nexec(code)\ny = ast.literal_eval(data)\n"
    assert rules(client, new_files({"m.py": src})) == [("ASEA-PY-EVAL-EXEC", 3), ("ASEA-PY-EVAL-EXEC", 4)]


def test_subprocess_shell_true(client: TestClient):
    src = (
        "import subprocess\n"
        "from subprocess import Popen as P\n"
        "subprocess.run(cmd, shell=True)\n"
        "P(cmd, shell=True)\n"
        "subprocess.run(['ls', path], shell=False)\n"
        "subprocess.run(['ls', path])\n"
    )
    assert rules(client, new_files({"m.py": src})) == [
        ("ASEA-PY-SUBPROCESS-SHELL", 3),
        ("ASEA-PY-SUBPROCESS-SHELL", 4),
    ]


def test_bare_except(client: TestClient):
    src = "try:\n    a()\nexcept:\n    pass\ntry:\n    b()\nexcept Exception:\n    pass\n"
    assert rules(client, new_files({"m.py": src})) == [("ASEA-PY-BARE-EXCEPT", 3)]


def test_string_formatted_sql(client: TestClient):
    src = (
        'cur.execute(f"SELECT * FROM t WHERE id = {x}")\n'
        'cur.execute("SELECT * FROM t WHERE id = %s" % x)\n'
        'cur.execute("SELECT * FROM t WHERE id = " + x)\n'
        'cur.executemany("INSERT INTO t VALUES ({})".format(x), rows)\n'
        'cur.execute("SELECT * FROM t WHERE id = ?", (x,))\n'
        'cur.execute("SELECT 1 " + "FROM t")\n'
        'log(f"SELECT {x}")\n'
    )
    assert rules(client, new_files({"m.py": src})) == [("ASEA-PY-SQL-STRING-FORMAT", n) for n in (1, 2, 3, 4)]


def test_hardcoded_secrets(client: TestClient):
    src = (
        'DB_PASSWORD = "correct-horse-battery"\n'
        'self.api_key = "0123456789abcdef"\n'
        'SECRET_KEY = os.environ["SECRET_KEY"]\n'
        'TOKEN_URL = "https://auth.example.com/token"\n'
        'password = "short"\n'
        'greeting = "hello world, friend"\n'
    )
    assert rules(client, new_files({"m.py": src})) == [
        ("ASEA-PY-HARDCODED-SECRET", 1),
        ("ASEA-PY-HARDCODED-SECRET", 2),
    ]


ROUTES = """from flask import Blueprint

bp = Blueprint("x", __name__)


@bp.get("/open")
def open_route():
    return "ok"


@bp.post("/guarded")
@jwt_required()
def guarded_route():
    return "ok"


@bp.delete("/legacy")
@login_required
def legacy_route():
    return "ok"
"""


def test_route_without_auth_uses_configured_decorators(client: TestClient, monkeypatch):
    assert rules(client, new_files({"routes.py": ROUTES})) == [
        ("ASEA-PY-ROUTE-NO-AUTH", 7),
        ("ASEA-PY-ROUTE-NO-AUTH", 13),
    ]

    monkeypatch.setattr(settings, "ASEA_AUTH_DECORATORS", "jwt_required, login_required")
    assert rules(client, new_files({"routes.py": ROUTES})) == [("ASEA-PY-ROUTE-NO-AUTH", 7)]


def test_test_gap_rules(client: TestClient):
    service = (
        "def tested_function():\n    return 1\n\n\n"
        "def untested_function():\n    return 2\n\n\n"
        "def _private_helper():\n    return 3\n\n\n"
        "class Store:\n    def save(self):\n        return 4\n"
    )
    test = "from services.store import tested_function\n\n\ndef test_it():\n    assert tested_function() == 1\n"
    body = new_files({"services/store.py": service, "tests/test_store.py": test})
    assert rules(client, body) == [("ASEA-PY-TEST-GAP", 5), ("ASEA-PY-TEST-GAP", 14)]


# --- Changed-line scoping ------------------------------------------------------

BASE = """import subprocess


def existing():
    try:
        subprocess.run(cmd, shell=True)
    except:
        pass


def other():
    return 1
"""


def test_only_changed_lines_are_checked(client: TestClient):
    head = BASE.replace("    return 1\n", "    return 2\n")
    assert findings(client, modified_file("svc.py", BASE, head)) == []

    head = BASE.replace("    return 1\n", "    return eval(text)\n")
    assert rules(client, modified_file("svc.py", BASE, head)) == [("ASEA-PY-EVAL-EXEC", 12)]


def test_removing_an_auth_decorator_is_detected(client: TestClient):
    base = ROUTES
    head = ROUTES.replace('@bp.delete("/legacy")\n@login_required\n', '@bp.delete("/legacy")\n')
    assert rules(client, modified_file("routes.py", base, head)) == [("ASEA-PY-ROUTE-NO-AUTH", 18)]


def test_changed_signature_of_an_existing_function_is_not_a_test_gap(client: TestClient):
    head = BASE.replace("def other():", "def other(flag=False):")
    assert findings(client, modified_file("svc.py", BASE, head)) == []


def test_unparseable_changed_file_is_reported(client: TestClient):
    assert rules(client, new_files({"broken.py": "def broken(:\n    pass\n"})) == [("ASEA-PY-PARSE-ERROR", 1)]


def test_non_python_files_are_ignored(client: TestClient):
    result = client.post(ENDPOINT, json=new_files({"README.md": "password = 'hunter2hunter2'\n"})).json()
    assert result == {**result, "findings": [], "tools_run": ["python-ast"], "tools_unavailable": []}


# --- Invalid input ---------------------------------------------------------------


@pytest.mark.parametrize("path", ["../outside.py", "/etc/passwd.py", "C:/x/y.py", "a/../../b.py"])
def test_unsafe_changed_file_paths_are_rejected(client: TestClient, path: str):
    body = new_files({"ok.py": "x = 1\n"})
    body["changed_files"].append({"path": path, "head_content": "x = 1\n"})
    response = client.post(ENDPOINT, json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_VERIFICATION_INPUT"


def test_missing_head_content_is_rejected(client: TestClient):
    body = new_files({"a.py": "x = 1\n"})
    body["changed_files"] = []
    response = client.post(ENDPOINT, json=body)
    assert response.status_code == 422
    assert "a.py" in response.json()["error"]["message"]


def test_malformed_diff_is_rejected(client: TestClient):
    body = new_files({"a.py": "x = 1\n"})
    body["unified_diff"] = "--- a/a.py\n+++ b/a.py\n@@ -1,5 +1,5 @@\n+x = 1\n"
    response = client.post(ENDPOINT, json=body)
    assert response.status_code == 422
    assert "could not be parsed" in response.json()["error"]["message"]


# --- Semgrep -------------------------------------------------------------------

PINNED_RULESET = b'{"rules":[{"id":"python.test.rule","languages":["python"],"message":"m","pattern":"eval(...)","severity":"ERROR"}]}\n'
PINNED_SHA256 = hashlib.sha256(PINNED_RULESET).hexdigest()


@pytest.fixture
def pinned_ruleset(tmp_path, monkeypatch):
    """A downloaded ruleset whose sha256 matches its lock."""
    ruleset, lock = tmp_path / "p-python.json", tmp_path / "p-python.lock.json"
    ruleset.write_bytes(PINNED_RULESET)
    lock.write_text(json.dumps({"sha256": PINNED_SHA256}), encoding="utf-8")
    monkeypatch.setattr(settings, "SEMGREP_RULESET", ruleset)
    monkeypatch.setattr(settings, "SEMGREP_RULES_LOCK", lock)
    return ruleset


def fake_semgrep(monkeypatch, results=None, returncode=0, stdout=None, raises=None):
    calls = []

    def fake_run(command, **kwargs):
        workdir = Path(kwargs["cwd"])
        calls.append(
            {
                "command": command,
                "kwargs": kwargs,
                "files": {p.relative_to(workdir).as_posix(): p.read_bytes() for p in workdir.rglob("*") if p.is_file()},
            }
        )
        if raises:
            raise raises
        out = stdout if stdout is not None else json.dumps({"results": results or [], "errors": []})
        return subprocess.CompletedProcess(command, returncode, stdout=out, stderr="")

    monkeypatch.setattr(semgrep_runner.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(semgrep_runner.subprocess, "run", fake_run)
    return calls


def semgrep_result(path: str, line: int, check_id: str, severity: str = "ERROR") -> dict:
    return {
        "check_id": check_id,
        "path": path,
        "start": {"line": line, "col": 1},
        "end": {"line": line, "col": 10},
        "extra": {"message": f"{check_id} matched", "severity": severity, "lines": "flagged code"},
    }


def test_semgrep_runs_offline_on_the_pinned_ruleset_and_changed_files_only(
    client: TestClient, monkeypatch, pinned_ruleset
):
    calls = fake_semgrep(monkeypatch)
    body = new_files({"pkg/a.py": "x = 1\n", "notes.md": "text\n"})
    body["changed_files"].append({"path": "unchanged.py", "head_content": "y = 2\n"})

    result = client.post(ENDPOINT, json=body).json()

    assert result["tools_run"] == ["python-ast", "semgrep"]
    assert result["tools_unavailable"] == []
    assert result["semgrep_ruleset_sha256"] == PINNED_SHA256
    [call] = calls
    # The scan directory holds the changed Python file and a copy of the pinned ruleset
    assert call["files"] == {"pkg/a.py": b"x = 1\n", RULESET_NAME: PINNED_RULESET}
    command = call["command"]
    assert isinstance(command, list)
    assert command[:4] == ["semgrep", "scan", "--config", RULESET_NAME]
    assert not any(arg.startswith(("p/", "r/", "http")) or arg == "auto" for arg in command)
    assert command[-1] == "./pkg/a.py"
    assert "--json" in command and ["--metrics", "off"] == command[command.index("--metrics"):][:2]
    assert call["kwargs"]["timeout"] == settings.SEMGREP_TIMEOUT_SECONDS
    assert call["kwargs"].get("shell", False) is False


def test_semgrep_is_skipped_when_the_ruleset_is_missing(client: TestClient, monkeypatch, pinned_ruleset):
    calls = fake_semgrep(monkeypatch)
    pinned_ruleset.unlink()

    result = client.post(ENDPOINT, json=new_files({"a.py": "eval(x)\n"})).json()

    assert calls == []
    assert result["tools_unavailable"] == ["semgrep"]
    assert result["semgrep_ruleset_sha256"] is None
    assert [f["rule_id"] for f in result["findings"]] == ["ASEA-PY-EVAL-EXEC"]


def test_semgrep_refuses_a_ruleset_that_does_not_match_the_pin(client: TestClient, monkeypatch, pinned_ruleset):
    calls = fake_semgrep(monkeypatch)
    pinned_ruleset.write_bytes(PINNED_RULESET.replace(b"eval", b"exec"))

    result = client.post(ENDPOINT, json=new_files({"a.py": "eval(x)\n"})).json()

    assert calls == []
    assert result["tools_unavailable"] == ["semgrep"]
    assert result["semgrep_ruleset_sha256"] is None

    outcome = semgrep_runner.run_semgrep({"a.py": "x\n"}, "semgrep", pinned_ruleset, settings.SEMGREP_RULES_LOCK, 5)
    assert outcome.available is False and "does not match the pinned" in outcome.reason


def test_semgrep_findings_are_deduplicated_and_limited_to_changed_lines(
    client: TestClient, monkeypatch, pinned_ruleset
):
    fake_semgrep(
        monkeypatch,
        results=[
            semgrep_result("svc.py", 12, "python.lang.security.audit.eval-detected"),  # same line as ast
            semgrep_result("./svc.py", 12, "python.lang.other.rule", "WARNING"),  # same line again
            semgrep_result("svc.py", 6, "python.lang.security.audit.subprocess-shell-true"),  # unchanged line
        ],
    )
    head = BASE.replace("    return 1\n", "    return eval(text)\n")

    result = findings(client, modified_file("svc.py", BASE, head))

    [finding] = result
    assert (finding["rule_id"], finding["line"]) == ("ASEA-PY-EVAL-EXEC", 12)
    assert finding["evidence"][1:] == [
        "Also reported by Semgrep rule python.lang.security.audit.eval-detected",
        "Also reported by Semgrep rule python.lang.other.rule",
    ]


def test_semgrep_only_findings_are_mapped_to_the_contract(client: TestClient, monkeypatch, pinned_ruleset):
    fake_semgrep(monkeypatch, results=[semgrep_result("./a.py", 1, "python.flask.debug-enabled", "WARNING")])
    [finding] = findings(client, new_files({"a.py": "app.run(debug=True)\n"}))
    assert finding["rule_id"] == "python.flask.debug-enabled"
    assert (finding["category"], finding["severity"], finding["source"]) == ("static", "medium", "deterministic")
    assert finding["evidence"] == ["flagged code"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"raises": subprocess.TimeoutExpired(cmd="semgrep", timeout=1)},
        {"returncode": 2},
        {"stdout": "not json"},
    ],
    ids=["timeout", "error-exit", "bad-output"],
)
def test_semgrep_failure_is_recorded_and_ast_checks_still_run(client: TestClient, monkeypatch, pinned_ruleset, kwargs):
    fake_semgrep(monkeypatch, **kwargs)
    result = client.post(ENDPOINT, json=new_files({"a.py": "eval(x)\n"})).json()
    assert result["tools_run"] == ["python-ast"]
    assert result["tools_unavailable"] == ["semgrep"]
    assert result["semgrep_ruleset_sha256"] is None
    assert [f["rule_id"] for f in result["findings"]] == ["ASEA-PY-EVAL-EXEC"]


def test_semgrep_command_prefix_supports_wsl_and_docker():
    assert build_command("wsl semgrep", "/tmp/w", ["a.py"])[:3] == ["wsl", "semgrep", "scan"]
    docker = build_command(
        "docker run --rm --network none -v {workdir}:/src -w /src semgrep/semgrep:1.181.0 semgrep", "/tmp/w", ["a.py"]
    )
    assert docker[:10] == [
        "docker", "run", "--rm", "--network", "none", "-v", "/tmp/w:/src", "-w", "/src", "semgrep/semgrep:1.181.0"
    ]
    assert docker[10:14] == ["semgrep", "scan", "--config", RULESET_NAME]
    # A file name starting with "-" stays a path
    assert build_command("semgrep", "/tmp/w", ["-rf.py"])[-1] == "./-rf.py"
