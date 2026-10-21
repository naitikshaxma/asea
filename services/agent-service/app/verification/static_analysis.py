"""Static-analysis node: VerificationRequest -> StaticAnalysisResult.

Stateless: everything comes from the request (unified diff + head content of
changed files); nothing is read from the repository or a database.
"""

import logging
import time
from pathlib import Path, PurePosixPath
from typing import Any

from app.verification.ast_checks import finding_id, is_test_file, run_ast_checks
from app.verification.contract import Finding, StaticAnalysisResult, VerificationRequest
from app.verification.diff_ranges import FileChanges, changed_lines
from app.verification.semgrep_runner import run_semgrep

logger = logging.getLogger(__name__)

AST_TOOL = "python-ast"
SEMGREP_TOOL = "semgrep"
SEMGREP_SEVERITY = {"ERROR": "high", "WARNING": "medium", "INFO": "low"}


class InvalidVerificationInput(ValueError):
    pass


def safe_relative_path(path: str) -> str:
    p = PurePosixPath(path.replace("\\", "/"))
    if not p.parts or p.is_absolute() or ".." in p.parts or ":" in p.parts[0]:
        raise InvalidVerificationInput(f"changed file path must be a relative path inside the repository: {path!r}")
    return p.as_posix()


def _semgrep_findings(results: list[dict[str, Any]], changes: dict[str, FileChanges]) -> list[Finding]:
    findings = []
    for result in results:
        path = PurePosixPath(str(result.get("path", ""))).as_posix().removeprefix("./")
        line = int(result.get("start", {}).get("line", 0))
        if path not in changes or line not in changes[path].touched:
            continue
        extra = result.get("extra", {})
        rule_id = str(result.get("check_id", "semgrep"))
        message = str(extra.get("message", rule_id)).strip()
        lines = str(extra.get("lines", "")).strip()
        findings.append(
            Finding(
                id=finding_id(rule_id, path, line),
                category="static",
                severity=SEMGREP_SEVERITY.get(str(extra.get("severity", "")).upper(), "medium"),
                title=(message.splitlines()[0] if message else rule_id)[:200],
                file=path,
                line=line,
                evidence=[lines] if lines and lines != "requires login" else [],
                source="deterministic",
                rule_id=rule_id,
                remediation=str(extra.get("fix") or f"See Semgrep rule {rule_id}."),
            )
        )
    return findings


def _merge(ast_findings: list[Finding], semgrep_findings: list[Finding]) -> list[Finding]:
    """Semgrep findings on a file and line the ast checks already reported are
    folded into the ast finding's evidence instead of being listed twice."""
    by_location = {(f.file, f.line): f for f in ast_findings}
    merged = list(ast_findings)
    for finding in semgrep_findings:
        existing = by_location.get((finding.file, finding.line))
        if existing:
            existing.evidence.append(f"Also reported by Semgrep rule {finding.rule_id}")
        else:
            merged.append(finding)
    return merged


def run_static_analysis(
    request: VerificationRequest,
    *,
    auth_decorators: set[str],
    semgrep_command: str,
    semgrep_ruleset: Path,
    semgrep_rules_lock: Path,
    semgrep_timeout_seconds: int,
) -> StaticAnalysisResult:
    started = time.perf_counter()
    try:
        changes = changed_lines(request.unified_diff)
    except ValueError as exc:
        raise InvalidVerificationInput(str(exc)) from exc
    files = {safe_relative_path(f.path): f.head_content for f in request.changed_files}

    python_files = {path: files.get(path) for path in changes if path.endswith(".py")}
    missing = sorted(path for path, content in python_files.items() if content is None)
    if missing:
        raise InvalidVerificationInput(f"changed_files is missing head content for: {', '.join(missing)}")

    test_sources = [content for path, content in files.items() if is_test_file(path)]
    findings: list[Finding] = []
    for path, content in python_files.items():
        findings += run_ast_checks(path, content, changes[path], test_sources, auth_decorators)

    tools_run = [AST_TOOL]
    tools_unavailable: list[str] = []
    ruleset_sha256: str | None = None
    if python_files:
        outcome = run_semgrep(python_files, semgrep_command, semgrep_ruleset, semgrep_rules_lock, semgrep_timeout_seconds)
        if outcome.available:
            tools_run.append(SEMGREP_TOOL)
            ruleset_sha256 = outcome.ruleset_sha256
            findings = _merge(findings, _semgrep_findings(outcome.results, changes))
        else:
            logger.info("Semgrep unavailable: %s", outcome.reason)
            tools_unavailable.append(SEMGREP_TOOL)

    findings.sort(key=lambda f: (f.file, f.line, f.rule_id))
    return StaticAnalysisResult(
        findings=findings,
        tools_run=tools_run,
        tools_unavailable=tools_unavailable,
        duration_ms=int((time.perf_counter() - started) * 1000),
        semgrep_ruleset_sha256=ruleset_sha256,
    )
