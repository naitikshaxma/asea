"""The verification pipeline as a LangGraph state graph.

    ingest -> static -> (negative_space || architecture) -> score -> report

ingest, static and score are deterministic. negative_space and architecture
run in parallel (the same superstep), each with a timeout and retries; a
failed or skipped agent leaves the run incomplete, which scoring treats as
"never allow". The reporter only explains; if it fails, a fallback report is
built from the findings. Each node reports agent_started / agent_finished
events through `emit` so callers can stream progress.
"""

import operator
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agents.architecture import run_architecture
from app.agents.change import ChangeContext, build_change_context
from app.agents.merge import merge_findings
from app.agents.negative_space import run_negative_space
from app.agents.reporter import fallback_report, write_report
from app.agents.runner import Stopwatch, now_iso, run_agent
from app.llm.provider import LLMProvider
from app.pipeline.contract import (
    AgentName,
    AgentRun,
    LLMInfo,
    PipelineRequest,
    PipelineResult,
    Report,
    StaticSummary,
)
from app.rag.index import CodeIndex
from app.verification.contract import Finding, StaticAnalysisResult
from app.verification.policy import ScoreResult
from app.verification.scoring import score_findings
from app.verification.static_analysis import run_static_analysis

AGENT_ORDER: tuple[AgentName, ...] = ("ingest", "static", "negative_space", "architecture", "score", "report")
LLM_AGENTS = ("negative_space", "architecture")


@dataclass
class PipelineDeps:
    # None when the LLM is not usable; the LLM agents are then skipped with provider_error
    provider: LLMProvider | None
    provider_error: str | None
    index: CodeIndex
    auth_decorators: set[str]
    semgrep: dict[str, Any]
    agent_timeout_s: float
    agent_max_attempts: int
    llm_timeout_s: float
    emit: Callable[[dict[str, Any]], None]


class PipelineState(TypedDict, total=False):
    pipeline: PipelineRequest
    change: ChangeContext
    static: StaticAnalysisResult
    agent_findings: Annotated[list[Finding], operator.add]
    agent_runs: Annotated[list[AgentRun], operator.add]
    findings: list[Finding]
    score: ScoreResult
    report: Report


def _started(deps: PipelineDeps, name: AgentName) -> Stopwatch:
    deps.emit({"type": "agent_started", "agent": name, "at": now_iso()})
    return Stopwatch()


def _finished(deps: PipelineDeps, run: AgentRun) -> list[AgentRun]:
    deps.emit({"type": "agent_finished", "run": run.model_dump()})
    return [run]


def build_graph(deps: PipelineDeps):
    def ingest(state: PipelineState) -> dict[str, Any]:
        clock = _started(deps, "ingest")
        change = build_change_context(state["pipeline"].request)
        detail = f"{len(change.files)} changed file(s), {len(change.changed_symbols)} changed symbol(s)"
        return {"change": change, "agent_runs": _finished(deps, clock.run("ingest", "completed", attempts=1, detail=detail))}

    def static(state: PipelineState) -> dict[str, Any]:
        clock = _started(deps, "static")
        result = run_static_analysis(state["pipeline"].request, auth_decorators=deps.auth_decorators, **deps.semgrep)
        detail = f"tools: {', '.join(result.tools_run)}" + (
            f"; unavailable: {', '.join(result.tools_unavailable)}" if result.tools_unavailable else ""
        )
        run = clock.run("static", "completed", attempts=1, finding_count=len(result.findings), detail=detail)
        return {"static": result, "agent_runs": _finished(deps, run)}

    def llm_agent(
        name: AgentName,
        work: Callable[[PipelineState], tuple[list[Finding], str]],
        precheck: Callable[[PipelineState], str | None] = lambda _: None,
    ):
        def node(state: PipelineState) -> dict[str, Any]:
            clock = _started(deps, name)
            skip_reason = (deps.provider_error or "LLM provider not configured") if deps.provider is None else precheck(state)
            if skip_reason:
                run = clock.run(name, "skipped", attempts=0, error=skip_reason)
                return {"agent_findings": [], "agent_runs": _finished(deps, run)}
            outcome = run_agent(
                name,
                lambda: work(state),
                timeout_s=deps.agent_timeout_s,
                max_attempts=deps.agent_max_attempts,
                count=lambda value: len(value[0]),
                detail=lambda value: value[1],
            )
            findings = outcome.value[0] if outcome.value else []
            return {"agent_findings": findings, "agent_runs": _finished(deps, outcome.run)}

        return node

    def negative_space_work(state: PipelineState) -> tuple[list[Finding], str]:
        result = run_negative_space(
            state["change"], state["static"].findings, deps.provider,  # type: ignore[arg-type]
            auth_decorators=deps.auth_decorators, llm_timeout_s=deps.llm_timeout_s,
        )
        missing = sum(1 for j in result.judgements if j.status == "missing")
        return result.findings, f"{len(result.responsibilities)} responsibilities checked, {missing} missing"

    def index_ready(state: PipelineState) -> str | None:
        request = state["pipeline"].request
        if deps.index.status(request.repository_id, request.base_sha).indexed:
            return None
        return f"Repository {request.repository_id} is not indexed at base commit {request.base_sha}"

    def architecture_work(state: PipelineState) -> tuple[list[Finding], str]:
        result = run_architecture(state["change"], deps.provider, deps.index, llm_timeout_s=deps.llm_timeout_s)  # type: ignore[arg-type]
        return result.findings, result.detail

    def score(state: PipelineState) -> dict[str, Any]:
        clock = _started(deps, "score")
        findings = merge_findings(state["static"].findings, state.get("agent_findings", []), state["change"].files)
        incomplete = [r.name for r in state.get("agent_runs", []) if r.name in LLM_AGENTS and r.status != "completed"]
        result = score_findings(findings, state["pipeline"].policy, incomplete)
        run = clock.run("score", "completed", attempts=1, finding_count=len(findings), detail=f"{result.score}/100, {result.verdict}")
        return {"findings": findings, "score": result, "agent_runs": _finished(deps, run)}

    def report(state: PipelineState) -> dict[str, Any]:
        clock = _started(deps, "report")
        findings, scored = state["findings"], state["score"]
        if deps.provider is None:
            run = clock.run("report", "skipped", attempts=0, error=deps.provider_error or "LLM provider not configured")
            return {"report": fallback_report(findings, scored), "agent_runs": _finished(deps, run)}
        provider = deps.provider
        outcome = run_agent(
            "report",
            lambda: write_report(findings, scored, provider, llm_timeout_s=deps.llm_timeout_s),
            timeout_s=deps.agent_timeout_s,
            max_attempts=deps.agent_max_attempts,
        )
        return {"report": outcome.value or fallback_report(findings, scored), "agent_runs": _finished(deps, outcome.run)}

    graph = StateGraph(PipelineState)
    graph.add_node("ingest", ingest)
    graph.add_node("static", static)
    graph.add_node("negative_space", llm_agent("negative_space", negative_space_work))
    graph.add_node("architecture", llm_agent("architecture", architecture_work, index_ready))
    graph.add_node("score", score)
    graph.add_node("report", report)
    graph.add_edge(START, "ingest")
    graph.add_edge("ingest", "static")
    graph.add_edge("static", "negative_space")
    graph.add_edge("static", "architecture")
    graph.add_edge(["negative_space", "architecture"], "score")
    graph.add_edge("score", "report")
    graph.add_edge("report", END)
    return graph.compile()


def run_pipeline(pipeline: PipelineRequest, deps: PipelineDeps) -> PipelineResult:
    state = build_graph(deps).invoke({"pipeline": pipeline, "agent_findings": [], "agent_runs": []})
    runs = sorted(state["agent_runs"], key=lambda r: AGENT_ORDER.index(r.name))
    static: StaticAnalysisResult = state["static"]
    provider = deps.provider
    return PipelineResult(
        findings=state["findings"],
        static=StaticSummary(
            tools_run=static.tools_run,
            tools_unavailable=static.tools_unavailable,
            duration_ms=static.duration_ms,
            semgrep_ruleset_sha256=static.semgrep_ruleset_sha256,
            finding_count=len(static.findings),
        ),
        score=state["score"],
        report=state["report"],
        agents=runs,
        llm=LLMInfo(provider=provider.name if provider else "none", model=provider.model if provider else "none"),
        complete=all(r.status == "completed" for r in runs if r.name in LLM_AGENTS),
    )
