"""Combines deterministic findings with the agents' findings.

Deterministic findings are authoritative. An agent finding on a file and line
that already has a deterministic finding is folded into it as corroborating
evidence instead of being listed (and scored) twice. Agent findings are only
kept when they point at an existing line of a changed file.
"""

from app.verification.contract import Finding

AGENT_LABEL = {"ASEA-NS": "negative-space agent", "ASEA-ARCH": "architecture agent"}


def _label(finding: Finding) -> str:
    return next((label for prefix, label in AGENT_LABEL.items() if finding.rule_id.startswith(prefix)), "an agent")


def _valid_location(finding: Finding, files: dict[str, str]) -> bool:
    content = files.get(finding.file)
    return content is not None and 1 <= finding.line <= max(1, len(content.splitlines()))


def merge_findings(deterministic: list[Finding], agent: list[Finding], files: dict[str, str]) -> list[Finding]:
    merged = [f.model_copy(deep=True) for f in deterministic]
    at = {(f.file, f.line): f for f in merged}
    ids = {f.id for f in merged}
    for finding in sorted(agent, key=lambda f: (f.file, f.line, f.rule_id, f.id)):
        if finding.source == "deterministic" or not _valid_location(finding, files) or finding.id in ids:
            continue
        existing = at.get((finding.file, finding.line))
        if existing is not None and existing.source == "deterministic":
            existing.evidence.append(f"Also reported by the {_label(finding)}: {finding.title}")
            continue
        merged.append(finding)
        ids.add(finding.id)
        at.setdefault((finding.file, finding.line), finding)
    return sorted(merged, key=lambda f: (f.file, f.line, f.rule_id, f.id))
