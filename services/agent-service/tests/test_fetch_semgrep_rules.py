"""scripts/fetch_semgrep_rules.py, against a synthetic semgrep-rules tarball (no network)."""

import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_semgrep_rules.py"
spec = importlib.util.spec_from_file_location("fetch_semgrep_rules", SCRIPT)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

ROOT = "semgrep-rules-abc123"
EVAL_YAML = """rules:
- id: eval-detected
  languages: [python]
  severity: WARNING
  message: eval
  pattern: eval(...)
  metadata:
    created: 2021-05-01
- id: not-in-pack
  languages: [python]
  severity: INFO
  message: other
  pattern: other(...)
"""
SHELL_YAML = """rules:
- id: subprocess-shell-true
  languages: [python]
  severity: ERROR
  message: shell
  pattern: subprocess.run(..., shell=True)
  options:
    symbolic_propagation: true
"""
PINNED_IDS = [
    "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
    "python.lang.security.audit.eval-detected.eval-detected",
]


def tarball(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(f"{ROOT}/{path}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


TARBALL = tarball(
    {
        "python/lang/security/audit/eval-detected.yaml": EVAL_YAML,
        "python/lang/security/audit/subprocess-shell-true.yaml": SHELL_YAML,
        "python/lang/security/audit/subprocess-shell-true.test.yaml": SHELL_YAML,
        ".github/rules.yaml": EVAL_YAML,
    }
)


def test_assembles_only_the_pinned_rules_with_registry_ids():
    ruleset = fetch.assemble_ruleset(TARBALL, PINNED_IDS)

    assert [rule["id"] for rule in ruleset["rules"]] == sorted(PINNED_IDS)
    eval_rule = ruleset["rules"][0]
    assert eval_rule["metadata"]["created"] == "2021-05-01"  # not turned into a date
    assert ruleset["rules"][1]["options"] == {"symbolic_propagation": True}


def test_canonical_output_is_deterministic():
    first = fetch.canonical_bytes(fetch.assemble_ruleset(TARBALL, PINNED_IDS))
    second = fetch.canonical_bytes(fetch.assemble_ruleset(TARBALL, list(reversed(PINNED_IDS))))
    assert first == second
    assert json.loads(first)["rules"][0]["id"] == PINNED_IDS[1]


def test_a_pinned_id_missing_from_the_tarball_fails():
    with pytest.raises(SystemExit, match="1 pinned rule ids are not in the tarball"):
        fetch.assemble_ruleset(TARBALL, [*PINNED_IDS, "python.flask.security.gone.gone"])


@pytest.fixture
def paths(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "LOCK_FILE", tmp_path / "p-python.lock.json")
    monkeypatch.setattr(fetch, "RULESET_FILE", tmp_path / "p-python.json")
    monkeypatch.setattr(fetch, "download", lambda url: TARBALL)
    return tmp_path


def write_lock(paths: Path, sha256: str) -> None:
    lock = {"source": {"commit": "abc123"}, "rule_ids": PINNED_IDS, "sha256": sha256}
    (paths / "p-python.lock.json").write_text(json.dumps(lock), encoding="utf-8")


def test_writes_the_ruleset_when_it_matches_the_lock(paths):
    expected = fetch.canonical_bytes(fetch.assemble_ruleset(TARBALL, PINNED_IDS))
    write_lock(paths, fetch.sha256(expected))

    assert fetch.main([]) == 0
    assert (paths / "p-python.json").read_bytes() == expected


def test_refuses_to_write_a_ruleset_that_does_not_match_the_lock(paths, capsys):
    write_lock(paths, "0" * 64)

    assert fetch.main([]) == 1
    assert not (paths / "p-python.json").exists()
    assert "does not match the pin" in capsys.readouterr().err


def test_committed_lock_pins_the_p_python_pack():
    lock = json.loads((SCRIPT.parents[1] / "rules" / "semgrep" / "p-python.lock.json").read_text(encoding="utf-8"))
    assert lock["pack"] == "p/python"
    assert lock["source"]["repository"] == "https://github.com/semgrep/semgrep-rules"
    assert len(lock["source"]["commit"]) == 40
    assert lock["rule_count"] == len(lock["rule_ids"]) == 151
    assert len(lock["sha256"]) == 64
    assert "Semgrep Rules License v1.0" in lock["license"]
