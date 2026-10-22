"""Deterministic stand-in for an LLM (LLM_PROVIDER=fake).

Used by the tests, CI and the local stack when no API key is configured, so
the pipeline runs end to end with reproducible results. It answers each agent
task from the structured inputs in LLMRequest.metadata with simple rules, not
from the prompt text: requirement keywords become responsibilities, the
evidence's heuristic signal becomes the judgement, every convention gap shown
is confirmed, and the report is assembled from the findings. Its output is
validated like a real model's.
"""

import re
from typing import Any

from pydantic import BaseModel

from app.llm.provider import LLMError, LLMRequest

# (kind, pattern over the lowercased requirement, description, severity, evidence terms)
RESPONSIBILITY_RULES: list[tuple[str, str, str, str, list[str]]] = [
    ("authentication", r"authenticat|signed[- ]in|logged[- ]in|\blog ?in\b|\blogin", "Only authenticated users can reach the new or changed endpoints", "high", ["login_required", "authenticate", "auth"]),
    ("authorization", r"\btheir own\b|\bowner\b|\bown\b|authori[sz]|permission", "Users can only read or change their own data", "high", ["owner_id", "user_id", "g.user"]),
    ("input_validation", r"validat", "Request input is validated before it is used", "medium", ["validate"]),
    ("tests", r"\btests?\b|\btested\b|covered by", "The new behaviour is covered by tests", "medium", ["def test_"]),
    ("query_safety", r"parameteri[sz]|sql injection|prepared statement", "Database queries are parameterised", "high", ["execute("]),
    ("secrets", r"credential|secret|api key|from configuration", "Credentials come from configuration, not source code", "high", ["environ", "getenv", "config"]),
    ("error_handling", r"error handling|handle errors|handles errors", "Errors are handled explicitly", "medium", ["except", "raise", "abort"]),
    ("logging", r"\blogg(ed|ing)\b|\baudit", "The action is logged", "low", ["logger", "logging", "audit"]),
]

AUTH_LIKE = re.compile(r"login|auth|permission|require", re.IGNORECASE)
SEVERITY_ORDER = ("critical", "high", "medium", "low")


class FakeLLMProvider:
    name = "fake"
    model = "fake-deterministic-v1"

    def complete(self, request: LLMRequest, timeout_s: float) -> BaseModel:
        handler = getattr(self, "_" + request.task.replace(".", "_"), None)
        if handler is None:
            raise LLMError(f"fake provider has no answer for task {request.task}", retryable=False)
        return request.output.model_validate(handler(request.metadata))

    def _negative_space_responsibilities(self, meta: dict[str, Any]) -> dict[str, Any]:
        text = meta["requirement"].lower()
        return {
            "responsibilities": [
                {"id": kind, "description": description, "kind": kind, "severity": severity, "evidence_terms": terms}
                for kind, pattern, description, severity, terms in RESPONSIBILITY_RULES
                if re.search(pattern, text)
            ]
        }

    def _negative_space_judge(self, meta: dict[str, Any]) -> dict[str, Any]:
        status = {"present": "satisfied", "absent": "missing", "unknown": "unclear"}
        return {
            "judgements": [
                {
                    "responsibility_id": e["id"],
                    "status": status[e["signal"]],
                    "rationale": (e["facts"][0] if e["facts"] else "No evidence either way.")
                    if e["signal"] != "absent"
                    else "Not done: " + "; ".join(e["facts"][:2]),
                }
                for e in meta["evidence"]
            ]
        }

    def _architecture_compare(self, meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "deviations": [
                {
                    "symbol_id": t["symbol_id"],
                    "convention_id": c["id"],
                    "severity": "high" if AUTH_LIKE.search(c["name"]) else "medium",
                    "explanation": f"Similar code uses {c['name']} ({c['reason']}); this symbol does not.",
                }
                for t in meta["targets"]
                for c in t["missing"]
            ]
        }

    def _report_explain(self, meta: dict[str, Any]) -> dict[str, Any]:
        findings, score = meta["findings"], meta["score"]
        verdict = score["verdict"].replace("_", " ").upper()
        ranked = sorted(findings, key=lambda f: SEVERITY_ORDER.index(f["severity"]))
        summary = f"{verdict} with a score of {score['score']}/100 from {len(findings)} finding(s)."
        if ranked:
            summary += " Fix first: " + "; ".join(f"{f['title']} ({f['file']}:{f['line']})" for f in ranked[:3]) + "."
        else:
            summary += " Nothing in the change contradicts the requirement or the codebase's conventions."
        return {
            "summary": summary,
            "explanations": [
                {
                    "finding_id": f["id"],
                    "explanation": f"{f['title']} in {f['file']} at line {f['line']}. "
                    + (f["evidence"][0] if f["evidence"] else ""),
                    "suggested_fix": f["remediation"],
                }
                for f in findings
            ],
        }
