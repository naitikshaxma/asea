"""Runs one agent with a timeout and retries, and records it as an AgentRun.

Each attempt runs in a worker thread and is abandoned after `timeout_s` (a
Python thread cannot be killed; the provider's own request timeout ends it).
Failures and timeouts are retried with a short backoff, except LLM errors
that cannot succeed on another attempt (a rejected key, a refusal).
"""

import logging
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Generic, TypeVar

from app.llm.provider import LLMError
from app.pipeline.contract import AgentName, AgentRun

logger = logging.getLogger(__name__)
T = TypeVar("T")

_executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="asea-agent")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class AgentOutcome(Generic[T]):
    value: T | None
    run: AgentRun


class Stopwatch:
    def __init__(self) -> None:
        self.started_at = now_iso()
        self._start = time.perf_counter()

    def run(self, name: AgentName, status: str, *, attempts: int, finding_count: int = 0,
            detail: str | None = None, error: str | None = None) -> AgentRun:
        return AgentRun(
            name=name,
            status=status,  # type: ignore[arg-type]
            started_at=self.started_at,
            finished_at=now_iso(),
            duration_ms=int((time.perf_counter() - self._start) * 1000),
            attempts=attempts,
            finding_count=finding_count,
            detail=detail,
            error=error,
        )


def run_agent(
    name: AgentName,
    fn: Callable[[], T],
    *,
    timeout_s: float,
    max_attempts: int,
    count: Callable[[T], int] = lambda _: 0,
    detail: Callable[[T], str | None] = lambda _: None,
    backoff_s: float = 0.5,
) -> AgentOutcome[T]:
    clock = Stopwatch()
    error = "not run"
    attempts = 0
    for attempt in range(1, max_attempts + 1):
        attempts = attempt
        future = _executor.submit(fn)
        try:
            value = future.result(timeout=timeout_s)
        except FutureTimeout:
            future.cancel()
            error = f"timed out after {timeout_s:g}s"
        except LLMError as exc:
            error = str(exc)
            if not exc.retryable:
                break
        except Exception as exc:  # an agent bug must not take the pipeline down
            logger.exception("Agent %s failed on attempt %d", name, attempt)
            error = f"{type(exc).__name__}: {exc}"
        else:
            return AgentOutcome(value, clock.run(name, "completed", attempts=attempt, finding_count=count(value), detail=detail(value)))
        logger.warning("Agent %s attempt %d/%d failed: %s", name, attempt, max_attempts, error)
        if attempt < max_attempts:
            time.sleep(backoff_s * attempt)
    return AgentOutcome(None, clock.run(name, "failed", attempts=attempts, error=error))
