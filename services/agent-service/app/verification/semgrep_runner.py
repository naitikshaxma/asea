"""Runs Semgrep on the changed files only, in a temporary directory.

The command is an argument list (never a shell) built from SEMGREP_COMMAND,
which may be a prefix such as `wsl semgrep` or a `docker run ...` line; a
`{workdir}` token is replaced by the temporary directory's path.
"""

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


@dataclass
class SemgrepOutcome:
    available: bool
    results: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None


def build_command(command_prefix: str, workdir: str, config: str) -> list[str]:
    prefix = [part.replace("{workdir}", workdir) for part in shlex.split(command_prefix)]
    return [
        *prefix,
        "scan",
        "--config",
        config,
        "--json",
        "--metrics",
        "off",
        "--quiet",
        "--disable-version-check",
        ".",
    ]


def run_semgrep(files: dict[str, str], command_prefix: str, config: str, timeout_seconds: int) -> SemgrepOutcome:
    """files maps safe relative paths (see static_analysis.safe_relative_path) to content."""
    prefix = shlex.split(command_prefix)
    if not prefix or shutil.which(prefix[0]) is None:
        return SemgrepOutcome(available=False, reason=f"'{prefix[0] if prefix else command_prefix}' not found on PATH")

    with tempfile.TemporaryDirectory(prefix="asea-semgrep-") as workdir:
        for rel_path, content in files.items():
            target = Path(workdir, *PurePosixPath(rel_path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content.encode("utf-8"))

        command = build_command(command_prefix, workdir, config)
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
    return SemgrepOutcome(available=True, results=list(payload.get("results", [])))
