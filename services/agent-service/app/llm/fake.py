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
PATCH_MARKER_SUMMARY = "Deterministic E2E proposal; adds a test marker comment only."
PATCH_MARKER_LINES = ("// ASEA deterministic test proposal", "# ASEA deterministic test proposal")


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

    def _engineering_propose_patch(self, meta: dict[str, Any]) -> dict[str, Any]:
        """Create a conspicuous, deterministic patch for isolated E2E coverage only."""
        files = meta.get("files", [])
        supported = (".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".sh")
        source = next((item for item in files if item.get("path", "").lower().endswith(supported)), None)
        if not source:
            raise LLMError("fake patch provider needs a supported text file", retryable=False)

        file_path = source["path"]
        content = source["content"]
        evidence_line = next((line.strip() for line in content.splitlines() if line.strip()), "Empty source file")[:200]
        comment = "# ASEA deterministic test proposal" if file_path.lower().endswith((".py", ".sh")) else "// ASEA deterministic test proposal"
        lines = content.splitlines()
        if not lines:
            hunk = "@@ -0,0 +1 @@\n+" + comment
        else:
            line_number = len(lines)
            hunk = f"@@ -{line_number},1 +{line_number},2 @@\n {lines[-1]}\n+{comment}"
        return {
            "summary": PATCH_MARKER_SUMMARY,
            "plan": ["Select one bounded source file", "Add the deterministic marker in the disposable snapshot"],
            "evidence": [f"{file_path}:1 — supplied context begins with `{evidence_line}`."],
            "unified_diff": f"--- a/{file_path}\n+++ b/{file_path}\n{hunk}\n",
        }

    def _engineering_review_patch(self, meta: dict[str, Any]) -> dict[str, Any]:
        """Approve only the fake proposer's marker-only diff; request changes for anything else.

        This keeps the test reviewer from ever approving a real code change.
        """
        lines = meta["unified_diff"].splitlines()
        added = [line[1:] for line in lines if line.startswith("+") and not line.startswith("+++")]
        removed = [line for line in lines if line.startswith("-") and not line.startswith("---")]
        if added and not removed and all(line in PATCH_MARKER_LINES for line in added):
            return {"verdict": "APPROVE", "summary": "Deterministic E2E review: the patch only adds the test marker comment.", "findings": []}
        path = next((line[6:] for line in lines if line.startswith("+++ b/")), None)
        evidence = (added or removed or ["(empty diff)"])[0][:200] or "(blank line)"
        return {
            "verdict": "REQUEST_CHANGES",
            "summary": "The deterministic test reviewer approves only the fake proposer's marker comment.",
            "findings": [{
                "id": "fake-reviewer-unrecognised-change", "severity": "high", "path": path, "line": None,
                "message": "Only the deterministic marker comment can be approved by the test reviewer.",
                "evidence": evidence,
            }],
        }
