"""Loads the static-analysis fixture cases in tests/fixtures (see its README)."""

import json
from pathlib import Path
from typing import Any

from unidiff import PatchSet

from app.verification.contract import ChangedFile, VerificationRequest

FIXTURES = Path(__file__).parent / "fixtures"
DEMO_APP = FIXTURES / "demo_app"
DIFFS = FIXTURES / "diffs"
CASES = sorted(p.stem for p in DIFFS.glob("*.diff"))


def apply_diff(base_dir: Path, diff_text: str) -> dict[str, str]:
    """Head content of every file the diff adds or modifies.

    Raises ValueError if a context or removed line does not match base_dir,
    i.e. the diff does not apply cleanly.
    """
    heads: dict[str, str] = {}
    for patched in PatchSet(diff_text):
        if patched.is_removed_file:
            continue
        source = [] if patched.is_added_file else (base_dir / patched.path).read_text(encoding="utf-8").splitlines(keepends=True)
        out: list[str] = []
        cursor = 0
        for hunk in patched:
            start = hunk.source_start - 1 if hunk.source_length else hunk.source_start
            out.extend(source[cursor:start])
            cursor = start
            for line in hunk:
                if line.is_context or line.is_removed:
                    if cursor >= len(source) or source[cursor] != line.value:
                        raise ValueError(f"{patched.path}:{cursor + 1} does not match the diff")
                    cursor += 1
                if line.is_context or line.is_added:
                    out.append(line.value)
        out.extend(source[cursor:])
        heads[patched.path] = "".join(out)
    return heads


def load_case(case: str) -> tuple[VerificationRequest, list[dict[str, Any]]]:
    diff = (DIFFS / f"{case}.diff").read_text(encoding="utf-8")
    heads = apply_diff(DEMO_APP, diff)
    request = VerificationRequest(
        repository_id="demo-app",
        base_sha="0" * 40,
        head_sha="1" * 40,
        requirement=f"Fixture case {case}",
        unified_diff=diff,
        changed_files=[ChangedFile(path=path, head_content=content) for path, content in sorted(heads.items())],
        author_type="ai",
    )
    expected = json.loads((DIFFS / f"{case}.expected_findings.json").read_text(encoding="utf-8"))
    return request, expected
