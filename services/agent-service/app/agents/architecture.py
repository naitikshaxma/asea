"""Architecture agent: does the changed code follow the conventions of similar code?

For each changed function or method (outside tests), the most similar symbols
of the same repository at the base commit are retrieved from the index. Among
neighbours of the same kind (route handlers with route handlers, other code
with other code), decorators and calls used by most of them are conventions;
so is any decorator the symbol's previous version had. Conventions the changed
symbol lacks are candidate deviations. The LLM compares the code with its
neighbours and decides which deviations are real; each becomes a finding at
the symbol's definition line (the location never comes from the model).
"""

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

from app.agents.change import ChangeContext
from app.llm.provider import LLMProvider, LLMRequest
from app.llm.untrusted import UNTRUSTED_RULES, fence
from app.rag.index import CodeIndex, Neighbour, symbol_text
from app.rag.symbols import CodeSymbol
from app.verification.contract import Finding

MAX_TARGETS = 10
NEIGHBOURS = 6
MIN_SUPPORT = 0.6
MIN_COUNT = 2

SYSTEM = (
    "You review a code change for consistency with the existing codebase: given a changed function "
    "and the most similar existing functions, you decide whether it departs from conventions the "
    "codebase follows (decorators, helper calls, layering) in a way that matters. "
    + UNTRUSTED_RULES
)


class Convention(BaseModel):
    id: str
    kind: Literal["decorator", "call"]
    name: str
    # Share of comparable neighbours that use it (1.0 for the previous version's decorators)
    support: float
    reason: str


class Deviation(BaseModel):
    symbol_id: str
    convention_id: str
    severity: Literal["high", "medium", "low"]
    explanation: str


class DeviationList(BaseModel):
    deviations: list[Deviation]


@dataclass
class TargetComparison:
    symbol: CodeSymbol
    symbol_id: str
    neighbours: list[Neighbour]
    missing: list[Convention] = field(default_factory=list)


@dataclass
class ArchitectureResult:
    compared: int
    findings: list[Finding]
    detail: str


def _comparable(target: CodeSymbol, neighbour: Neighbour) -> bool:
    p = neighbour.payload
    return not p.get("is_test") and p.get("kind") != "class" and bool(p.get("is_route")) == target.is_route


def missing_conventions(target: CodeSymbol, neighbours: list[Neighbour]) -> list[Convention]:
    group = [n for n in neighbours if _comparable(target, n)]
    previous = next((n for n in group if n.payload.get("path") == target.path and n.payload.get("name") == target.name), None)
    others = [n for n in group if n is not previous]
    own_name = target.name.rsplit(".", 1)[-1]
    conventions: dict[str, Convention] = {}

    for kind, key, have in (("decorator", "decorators", set(target.decorators)), ("call", "calls", set(target.calls))):
        counts = Counter(item for n in others for item in set(n.payload.get(key, [])))
        for name, count in counts.items():
            # A call named after a neighbour itself (service.create_x from route create_x) is not a convention
            namesakes = sum(1 for n in others if n.payload.get("name", "").rsplit(".", 1)[-1] == name)
            support = count / len(others) if others else 0.0
            if name not in have and name != own_name and namesakes == 0 and count >= MIN_COUNT and support >= MIN_SUPPORT:
                conventions[f"{kind}:{name}"] = Convention(
                    id=f"{kind}:{name}", kind=kind, name=name, support=round(support, 2),
                    reason=f"{count} of {len(others)} similar {'route handlers' if target.is_route else 'functions'} use it",
                )
        if previous and kind == "decorator":
            for name in set(previous.payload.get("decorators", [])) - have:
                conventions[f"{kind}:{name}"] = Convention(
                    id=f"{kind}:{name}", kind=kind, name=name, support=1.0,
                    reason="the previous version of this function had it",
                )
    return sorted(conventions.values(), key=lambda c: c.id)


def _neighbour_text(n: Neighbour) -> str:
    p = n.payload
    return (
        f"{p.get('path')}::{p.get('name')} (similarity {n.score:.2f}; decorators: {', '.join(p.get('decorators', [])) or 'none'}; "
        f"calls: {', '.join(p.get('calls', [])[:15]) or 'none'})\n{str(p.get('code', ''))[:1200]}"
    )


def _finding(target: TargetComparison, convention: Convention, deviation: Deviation) -> Finding:
    symbol = target.symbol
    rule_id = "ASEA-ARCH-CONVENTION"
    fid = hashlib.sha256(f"{rule_id}|{symbol.path}|{symbol.def_line}|{convention.id}".encode()).hexdigest()[:16]
    what = f"@{convention.name}" if convention.kind == "decorator" else f"{convention.name}()"
    return Finding(
        id=fid,
        category="architecture",
        severity=deviation.severity,
        title=f"{symbol.name} does not use {what}, unlike similar code"[:200],
        file=symbol.path,
        line=symbol.def_line,
        evidence=[
            f"Convention: {what} ({convention.reason})",
            f"Assessment: {deviation.explanation.strip()[:500]}",
            *[f"Similar: {n.payload.get('path')}::{n.payload.get('name')}" for n in target.neighbours[:3]],
        ],
        source="llm",
        rule_id=rule_id,
        remediation=f"Follow the codebase's convention ({what}) or document why {symbol.name} is an exception.",
    )


def run_architecture(
    ctx: ChangeContext,
    provider: LLMProvider,
    index: CodeIndex,
    *,
    llm_timeout_s: float,
) -> ArchitectureResult:
    request = ctx.request
    targets: list[TargetComparison] = []
    for symbol in [s for s in ctx.changed_symbols if not s.is_test and s.kind != "class"][:MAX_TARGETS]:
        neighbours = index.search(
            request.repository_id, request.base_sha, symbol_text(symbol.path, symbol.name, symbol.decorators, symbol.code), NEIGHBOURS
        )
        comparison = TargetComparison(symbol, f"{symbol.path}::{symbol.name}", neighbours)
        comparison.missing = missing_conventions(symbol, neighbours)
        targets.append(comparison)

    suspects = [t for t in targets if t.missing]
    if not suspects:
        return ArchitectureResult(len(targets), [], f"Compared {len(targets)} changed symbol(s); no convention gaps")

    blocks = []
    for t in suspects:
        conventions = "\n".join(f"- {c.id}: {c.reason}" for c in t.missing)
        neighbours = "\n\n".join(_neighbour_text(n) for n in t.neighbours if _comparable(t.symbol, n))
        blocks.append(
            f"Changed symbol {t.symbol_id}:\n{fence('changed-code', t.symbol.code, 4000)}\n"
            f"Similar existing code:\n{fence('similar-code', neighbours, 6000)}\n"
            f"Conventions it does not follow:\n{fence('conventions', conventions, 2000)}"
        )
    answer = provider.complete(
        LLMRequest(
            task="architecture.compare",
            system=SYSTEM,
            user="\n\n".join(blocks)
            + "\n\nFor each changed symbol, list the conventions whose absence is a real problem (use the symbol id and "
            "convention id exactly as given), with a severity and a one or two sentence explanation. Leave out "
            "conventions that do not apply to this symbol.",
            output=DeviationList,
            metadata={"targets": [{"symbol_id": t.symbol_id, "missing": [c.model_dump() for c in t.missing]} for t in suspects]},
        ),
        llm_timeout_s,
    )
    by_symbol = {t.symbol_id: t for t in suspects}
    findings: dict[str, Finding] = {}
    for d in DeviationList.model_validate(answer.model_dump()).deviations:
        target = by_symbol.get(d.symbol_id)
        convention = next((c for c in target.missing if c.id == d.convention_id), None) if target else None
        if target is None or convention is None:
            continue  # the model may only confirm deviations it was shown
        finding = _finding(target, convention, d)
        findings.setdefault(finding.id, finding)
    ordered = sorted(findings.values(), key=lambda f: (f.file, f.line, f.id))
    return ArchitectureResult(len(targets), ordered, f"Compared {len(targets)} changed symbol(s) with similar code")


def is_auth_like(name: str) -> bool:
    return bool(re.search(r"login|auth|permission|require", name, re.IGNORECASE))
