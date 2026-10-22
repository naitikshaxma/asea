"""The LLM behind the agents, selected by LLM_PROVIDER.

Agents describe what they need as an LLMRequest: a task name, the prompts and
the Pydantic model the answer must validate against. Providers return a
validated instance or raise LLMError. `metadata` carries the structured inputs
the prompt was built from; real providers ignore it, the fake provider (used by
tests, CI and keyless local runs) computes its deterministic answer from it.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMError(Exception):
    """A provider call that failed. Retryable errors (timeouts, rate limits,
    overload) may succeed on another attempt; others (bad key, refusal) won't."""

    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class LLMRequest:
    task: str
    system: str
    user: str
    output: type[BaseModel]
    metadata: dict[str, Any] = field(default_factory=dict)


class LLMProvider(Protocol):
    name: str
    model: str

    def complete(self, request: LLMRequest, timeout_s: float) -> BaseModel: ...


class ProviderNotConfigured(LLMError):
    def __init__(self, message: str):
        super().__init__(message, retryable=False)


def create_provider(provider: str, api_key: str | None, model: str | None, effort: str) -> LLMProvider:
    name = provider.strip().lower()
    if name == "fake":
        from app.llm.fake import FakeLLMProvider

        return FakeLLMProvider()
    if name == "anthropic":
        from app.llm.anthropic_provider import DEFAULT_MODEL, AnthropicProvider

        return AnthropicProvider(api_key=api_key, model=model or DEFAULT_MODEL, effort=effort)
    raise ProviderNotConfigured(f"Unknown LLM_PROVIDER '{provider}'; use 'fake' or 'anthropic'")
