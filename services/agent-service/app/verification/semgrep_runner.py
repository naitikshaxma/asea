"""Runs Semgrep on the changed files only, in a temporary directory, offline.

The rules are the pinned ruleset downloaded by scripts/fetch_semgrep_rules.py
(see rules/semgrep/README.md). Its sha256 must match the lock file, otherwise
Semgrep is not run. No registry config is ever passed, so Semgrep needs no
network access.

The command is an argument list (never a shell) built from SEMGREP_COMMAND,
which may be a prefix such as `wsl semgrep` or a `docker run ...` line; a
`{workdir}` token is replaced by the temporary directory's path.
"""

import hashlib
import json
import logging
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

# Name of the ruleset copy inside the scan directory (so a Docker mount of
# {workdir} contains it too); never a .py file, so it is never a scan target
RULESET_NAME = ".asea-semgrep-rules.json"


@dataclass
class SemgrepOutcome:
    available: bool
    results: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None
    ruleset_sha256: str | None = None


def build_command(command_prefix: str, workdir: str, targets: list[str]) -> list[str]:
    prefix = [part.replace("{workdir}", workdir) for part in shlex.split(command_prefix)]
    return [
        *prefix,
        "scan",
        "--config",
        RULESET_NAME,
        "--json",
        "--metrics",
        "off",
        "--quiet",
        "--disable-version-check",
        # "./" keeps a file name that starts with "-" from being read as an option
        *(f"./{target}" for target in targets),
    ]


def load_pinned_ruleset(ruleset_path: Path, lock_path: Path) -> tuple[bytes | None, str | None, str | None]:
    """(ruleset bytes, sha256, reason it can't be used)."""
    try:
        expected = json.loads(lock_path.read_text(encoding="utf-8"))["sha256"]
    except (OSError, ValueError, KeyError) as exc:
        return None, None, f"ruleset lock {lock_path} is unreadable: {exc}"
    try:
        data = ruleset_path.read_bytes()
    except OSError:
        return None, None, f"ruleset {ruleset_path} not found; run `npm run semgrep:rules`"
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        return None, actual, f"ruleset sha256 {actual} does not match the pinned {expected}"
    return data, actual, None


def run_semgrep(
    files: dict[str, str],
    command_prefix: str,
    ruleset_path: Path,
    lock_path: Path,
    timeout_seconds: int,
) -> SemgrepOutcome:
    """files maps safe relative paths (see static_analysis.safe_relative_path) to content."""
    prefix = shlex.split(command_prefix)
    if not prefix or shutil.which(prefix[0]) is None:
        return SemgrepOutcome(available=False, reason=f"'{prefix[0] if prefix else command_prefix}' not found on PATH")
    ruleset, ruleset_sha256, problem = load_pinned_ruleset(ruleset_path, lock_path)
    if ruleset is None:
        return SemgrepOutcome(available=False, reason=problem)

    with tempfile.TemporaryDirectory(prefix="asea-semgrep-") as workdir:
        Path(workdir, RULESET_NAME).write_bytes(ruleset)
        for rel_path, content in files.items():
            target = Path(workdir, *PurePosixPath(rel_path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content.encode("utf-8"))

        command = build_command(command_prefix, workdir, sorted(files))
        try:
            completed = subprocess.run(
                command,
                cwd=workdir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return SemgrepOutcome(available=False, reason=f"timed out after {timeout_seconds}s")
        except OSError as exc:
            return SemgrepOutcome(available=False, reason=f"could not start: {exc}")

    # Semgrep exits 0 (or 1 with --error) when the scan completes
    if completed.returncode not in (0, 1):
        logger.warning("Semgrep exited with %s: %s", completed.returncode, completed.stderr[-2000:])
        return SemgrepOutcome(available=False, reason=f"exited with code {completed.returncode}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return SemgrepOutcome(available=False, reason="output was not JSON")
    return SemgrepOutcome(available=True, results=list(payload.get("results", [])), ruleset_sha256=ruleset_sha256)
