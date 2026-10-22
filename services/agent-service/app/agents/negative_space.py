"""Negative-space agent: what the requirement needs that the change does not do.

1. The LLM lists the responsibilities a correct implementation of the
   requirement must have (authentication, tests, validation, ...).
2. Evidence is gathered deterministically for each one: structural facts about
   the change (which routes are new and how they are decorated, which new
   functions tests reference, what static analysis found) plus matching added
   lines, and a heuristic signal (present / absent / unknown).
3. The LLM judges each responsibility as satisfied, missing or unclear from
   that evidence.
4. Each missing responsibility becomes a finding. Its location comes from the
   evidence, never from the model, and it is always an existing line of a
   changed file.
"""

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from app.agents.change import ChangeContext
from app.llm.provider import LLMProvider, LLMRequest
from app.llm.untrusted import UNTRUSTED_RULES, fence
from app.verification.contract import Finding

Kind = Literal[
    "authentication",
    "authorization",
    "input_validation",
    "tests",
    "query_safety",
    "secrets",
    "error_handling",
    "logging",
    "other",
]
Signal = Literal["present", "absent", "unknown"]

MAX_RESPONSIBILITIES = 8
MAX_FACTS = 8
DATA_ACCESS_CALLS = {"execute", "executemany", "query", "filter", "filter_by", "find", "find_one", "update", "delete"}
BODY_CALLS = {"get_json", "json", "form", "get_data", "loads"}

SYSTEM = (
    "You review a code change against the requirement it implements, looking for what is missing: "
    "responsibilities the requirement implies but the change does not fulfil. "
    + UNTRUSTED_RULES
)


class Responsibility(BaseModel):
    id: str
    description: str
    kind: Kind
    severity: Literal["high", "medium", "low"]
    evidence_terms: list[str]


class ResponsibilityList(BaseModel):
    responsibilities: list[Responsibility]


class Judgement(BaseModel):
    responsibility_id: str
    status: Literal["satisfied", "missing", "unclear"]
    rationale: str


class JudgementList(BaseModel):
    judgements: list[Judgement]


@dataclass
class Evidence:
    responsibility: Responsibility
    signal: Signal
    facts: list[str]
    # Where a missing item belongs: (file, line)
    anchor: tuple[str, int] | None


@dataclass
class NegativeSpaceResult:
    responsibilities: list[Responsibility]
    judgements: list[Judgement]
    findings: list[Finding]


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", value.lower()).strip("-")[:40] or "item"


def _clean(responsibilities: list[Responsibility]) -> list[Responsibility]:
    """At most MAX_RESPONSIBILITIES, with unique, safe ids and bounded text."""
    seen: set[str] = set()
    out = []
    for r in responsibilities[:MAX_RESPONSIBILITIES]:
        rid = _slug(r.id)
        while rid in seen:
            rid = f"{rid}-{len(seen)}"
        seen.add(rid)
        out.append(
            r.model_copy(
                update={
                    "id": rid,
                    "description": r.description.strip()[:300] or r.kind,
                    "evidence_terms": [t.strip()[:60] for t in r.evidence_terms if t.strip()][:8],
                }
            )
        )
    return out


def _static_at(static: list[Finding], rule_id: str) -> list[Finding]:
    return [f for f in static if f.rule_id == rule_id]


def gather_evidence(r: Responsibility, ctx: ChangeContext, static: list[Finding], auth_decorators: set[str]) -> Evidence:
    routes = [s for s in ctx.changed_symbols if s.is_route]
    code_symbols = [s for s in ctx.changed_symbols if not s.is_test and s.kind != "class"]
    facts: list[str] = []
    signal: Signal = "unknown"
    anchor: tuple[str, int] | None = None

    if r.kind == "authentication":
        if not routes:
            facts.append("No route handler is added or changed.")
        for route in routes:
            protected = bool(set(route.decorators) & auth_decorators)
            facts.append(
                f"Route {route.name} ({route.path}:{route.def_line}) decorators: {', '.join(route.decorators) or 'none'}; "
                f"authentication decorator present: {'yes' if protected else 'no'}"
            )
            if not protected and anchor is None:
                anchor = (route.path, route.def_line)
        if routes:
            signal = "absent" if anchor else "present"
    elif r.kind == "tests":
        new = ctx.new_public_functions()
        facts.append(f"Test files changed: {', '.join(ctx.test_files) or 'none'}")
        for fn in new:
            referenced = ctx.referenced_by_tests(fn)
            facts.append(f"New function {fn.name} ({fn.path}:{fn.def_line}) referenced by a test: {'yes' if referenced else 'no'}")
            if not referenced and anchor is None:
                anchor = (fn.path, fn.def_line)
        if new:
            signal = "absent" if anchor else "present"
        else:
            facts.append("No new public function outside tests and route handlers.")
    elif r.kind == "input_validation":
        body_routes = [s for s in routes if set(s.calls) & BODY_CALLS]
        for route in body_routes:
            validates = [c for c in route.calls if "valid" in c.lower() or "schema" in c.lower()]
            facts.append(f"Route {route.name} reads a request body; validation calls: {', '.join(validates) or 'none'}")
            if not validates and anchor is None:
                anchor = (route.path, route.def_line)
        if body_routes:
            signal = "absent" if anchor else "present"
        else:
            facts.append("No changed route reads a request body.")
    elif r.kind == "query_safety":
        unsafe = _static_at(static, "ASEA-PY-SQL-STRING-FORMAT")
        for f in unsafe:
            facts.append(f"Static analysis: string-formatted SQL at {f.file}:{f.line}")
        if unsafe:
            signal, anchor = "absent", (unsafe[0].file, unsafe[0].line)
        elif any(set(s.calls) & {"execute", "executemany"} for s in code_symbols):
            signal = "present"
            facts.append("Changed code runs SQL; static analysis found no string-formatted query.")
    elif r.kind == "secrets":
        secrets = _static_at(static, "ASEA-PY-HARDCODED-SECRET")
        for f in secrets:
            facts.append(f"Static analysis: hardcoded secret-like value at {f.file}:{f.line}")
        if secrets:
            signal, anchor = "absent", (secrets[0].file, secrets[0].line)
        else:
            signal = "present"
            facts.append("Static analysis found no hardcoded secret-like value in the change.")
    elif r.kind == "authorization":
        data_access = [s for s in code_symbols if set(s.calls) & DATA_ACCESS_CALLS]
        for s in data_access:
            scoped = bool(re.search(r"owner|user_id|g\.user|current_user", s.code))
            facts.append(f"{s.name} ({s.path}:{s.def_line}) accesses data; scoped to the user: {'yes' if scoped else 'no'}")
            if not scoped and anchor is None:
                anchor = (s.path, s.def_line)
        if data_access:
            signal = "absent" if anchor else "present"
        else:
            facts.append("No changed function accesses stored data.")

    terms = [t.lower() for t in r.evidence_terms]
    hits = [a for a in ctx.added_lines if terms and any(t in a.text.lower() for t in terms)]
    for hit in hits[:4]:
        facts.append(f"Added line {hit.path}:{hit.line}: {hit.text.strip()[:160]}")
    # Kinds without a structural check only count term matches as (weak) evidence
    if r.kind in {"error_handling", "logging", "other"} and hits:
        signal = "present"
    return Evidence(r, signal, facts[:MAX_FACTS], anchor)


def _finding(r: Responsibility, judgement: Judgement, evidence: Evidence, ctx: ChangeContext) -> Finding:
    path, line = evidence.anchor or ctx.first_location()
    rule_id = f"ASEA-NS-{r.kind.upper().replace('_', '-')}"
    fid = hashlib.sha256(f"{rule_id}|{r.id}|{path}|{line}".encode()).hexdigest()[:16]
    return Finding(
        id=fid,
        category="negative_space",
        severity=r.severity,
        title=f"Requirement not met: {r.description}"[:200],
        file=path,
        line=line,
        evidence=[f"Expected: {r.description}", f"Judgement: {judgement.rationale.strip()[:500]}", *evidence.facts[:4]],
        source="llm",
        rule_id=rule_id,
        remediation=f"Make the change do this: {r.description}",
    )


def run_negative_space(
    ctx: ChangeContext,
    static: list[Finding],
    provider: LLMProvider,
    *,
    auth_decorators: set[str],
    llm_timeout_s: float,
) -> NegativeSpaceResult:
    requirement = ctx.request.requirement
    if not requirement.strip():
        return NegativeSpaceResult([], [], [])

    listed = provider.complete(
        LLMRequest(
            task="negative_space.responsibilities",
            system=SYSTEM,
            user=(
                "The requirement this change implements:\n"
                f"{fence('requirement', requirement, 4000)}\n\n"
                f"List the responsibilities a correct implementation must fulfil (at most {MAX_RESPONSIBILITIES}). "
                "For each: a short id, a one-sentence description, a kind (authentication, authorization, "
                "input_validation, tests, query_safety, secrets, error_handling, logging, other), a severity "
                "(high, medium, low) for leaving it out, and identifiers or words whose presence in code would be evidence."
            ),
            output=ResponsibilityList,
            metadata={"requirement": requirement},
        ),
        llm_timeout_s,
    )
    responsibilities = _clean(ResponsibilityList.model_validate(listed.model_dump()).responsibilities)
    if not responsibilities:
        return NegativeSpaceResult([], [], [])

    evidence = {r.id: gather_evidence(r, ctx, static, auth_decorators) for r in responsibilities}
    evidence_text = "\n\n".join(
        f"[{r.id}] {r.description}\n" + "\n".join(f"- {fact}" for fact in evidence[r.id].facts)
        for r in responsibilities
    )
    diff = ctx.request.unified_diff
    judged = provider.complete(
        LLMRequest(
            task="negative_space.judge",
            system=SYSTEM,
            user=(
                f"Requirement:\n{fence('requirement', requirement, 4000)}\n\n"
                f"Responsibilities and the evidence found in the change:\n{fence('evidence', evidence_text, 12000)}\n\n"
                f"The change (unified diff):\n{fence('diff', diff, 20000)}\n\n"
                "For each responsibility id, decide whether the change satisfies it, misses it, or whether it is "
                "unclear from the evidence, with a one or two sentence rationale citing the evidence."
            ),
            output=JudgementList,
            metadata={"evidence": [{"id": r.id, "signal": evidence[r.id].signal, "facts": evidence[r.id].facts} for r in responsibilities]},
        ),
        llm_timeout_s,
    )
    judgements = JudgementList.model_validate(judged.model_dump()).judgements
    by_id = {r.id: r for r in responsibilities}
    findings: dict[str, Finding] = {}
    kept: list[Judgement] = []
    for j in judgements:
        r = by_id.get(j.responsibility_id)
        if r is None or any(k.responsibility_id == r.id for k in kept):
            continue  # unknown or repeated ids are ignored
        kept.append(j)
        if j.status == "missing":
            finding = _finding(r, j, evidence[r.id], ctx)
            findings.setdefault(finding.id, finding)
    return NegativeSpaceResult(responsibilities, kept, sorted(findings.values(), key=lambda f: (f.file, f.line, f.rule_id)))
