"""Reporter: explains the findings and the score; it never adds or changes findings.

Its output schema has no way to express a finding: only a summary and one
explanation per existing finding id. Explanations for unknown ids are dropped,
and findings the model skipped get a fallback explanation built from the
finding itself. If the reporter fails, the whole report is the fallback.
"""

from pydantic import BaseModel

from app.llm.provider import LLMProvider, LLMRequest
from app.llm.untrusted import UNTRUSTED_RULES, fence
from app.pipeline.contract import FindingExplanation, Report
from app.verification.contract import Finding
from app.verification.policy import ScoreResult

MAX_TEXT = 2000

SYSTEM = (
    "You write the review summary of an automated verification of a code change. You explain the "
    "findings you are given and the score they produced, for the engineer who has to fix them. You "
    "cannot add, remove or re-grade findings, and you do not change the score or verdict. "
    + UNTRUSTED_RULES
)


class ReportDraft(BaseModel):
    summary: str
    explanations: list[FindingExplanation]


def _verdict_text(score: ScoreResult) -> str:
    return f"{score.verdict.replace('_', ' ').upper()} (score {score.score}/100)"


def _fallback_explanation(f: Finding) -> FindingExplanation:
    detail = f" Evidence: {f.evidence[0]}" if f.evidence else ""
    return FindingExplanation(
        finding_id=f.id,
        explanation=f"{f.title} at {f.file}:{f.line} ({f.severity}, {f.category.replace('_', ' ')}).{detail}"[:MAX_TEXT],
        suggested_fix=f.remediation[:MAX_TEXT],
    )


def fallback_report(findings: list[Finding], score: ScoreResult) -> Report:
    counts = {s: sum(1 for f in findings if f.severity == s) for s in ("critical", "high", "medium", "low")}
    breakdown = ", ".join(f"{n} {s}" for s, n in counts.items() if n) or "none"
    top = sorted(findings, key=lambda f: ("critical", "high", "medium", "low").index(f.severity))[:3]
    summary = f"{_verdict_text(score)}. {len(findings)} finding(s): {breakdown}."
    if top:
        summary += " Most important: " + "; ".join(f"{f.title} ({f.file}:{f.line})" for f in top) + "."
    if score.adjustments:
        summary += " " + " ".join(a.reason for a in score.adjustments) + "."
    return Report(summary=summary, explanations=[_fallback_explanation(f) for f in findings], generated_by="fallback")


def write_report(findings: list[Finding], score: ScoreResult, provider: LLMProvider, *, llm_timeout_s: float) -> Report:
    listing = "\n".join(
        f"[{f.id}] {f.severity} {f.category} {f.rule_id} at {f.file}:{f.line}: {f.title}\n  evidence: {' | '.join(f.evidence)[:600]}"
        for f in findings
    )
    deductions = "\n".join(f"{i.finding_id}: -{i.deduction}" for i in score.breakdown)
    draft = provider.complete(
        LLMRequest(
            task="report.explain",
            system=SYSTEM,
            user=(
                f"Verdict: {_verdict_text(score)}. Caps applied: {', '.join(c.id for c in score.caps_applied) or 'none'}.\n"
                f"Score deductions:\n{deductions or 'none'}\n\n"
                f"Findings:\n{fence('findings', listing or 'none', 20000)}\n\n"
                "Write a short summary of what the change gets wrong and why it scored as it did, then one "
                "explanation and one concrete suggested fix per finding id."
            ),
            output=ReportDraft,
            metadata={"findings": [f.model_dump() for f in findings], "score": score.model_dump()},
        ),
        llm_timeout_s,
    )
    draft = ReportDraft.model_validate(draft.model_dump())
    known = {f.id: f for f in findings}
    explanations: dict[str, FindingExplanation] = {}
    for e in draft.explanations:
        if e.finding_id in known and e.finding_id not in explanations:
            explanations[e.finding_id] = FindingExplanation(
                finding_id=e.finding_id, explanation=e.explanation[:MAX_TEXT], suggested_fix=e.suggested_fix[:MAX_TEXT]
            )
    ordered = [explanations.get(f.id) or _fallback_explanation(f) for f in findings]
    return Report(summary=draft.summary.strip()[:MAX_TEXT] or fallback_report(findings, score).summary, explanations=ordered, generated_by="llm")
