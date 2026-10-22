"""Claude via the official Anthropic SDK (LLM_PROVIDER=anthropic).

Structured outputs: the request's Pydantic model is turned into the JSON
schema the answer must follow (the SDK's transform_schema), the stop reason is
checked (a refusal has no answer to parse), and the text is validated against
the model. Server-side refusal fallbacks are on, so a declined request is
retried on a fallback model inside the same call. The SDK retries transient
errors once; the agent runner adds its own attempts and timeout on top.
"""

import anthropic
from pydantic import BaseModel, ValidationError

from app.llm.provider import LLMError, LLMRequest, ProviderNotConfigured

DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 16000


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str | None, model: str, effort: str, client: anthropic.Anthropic | None = None):
        if client is None and not api_key:
            raise ProviderNotConfigured("LLM_API_KEY is not set; LLM_PROVIDER=anthropic needs an API key")
        self.model = model
        self.effort = effort
        self._client = client or anthropic.Anthropic(api_key=api_key, max_retries=1)

    def complete(self, request: LLMRequest, timeout_s: float) -> BaseModel:
        try:
            response = self._client.beta.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=request.system,
                messages=[{"role": "user", "content": request.user}],
                output_config={
                    "effort": self.effort,
                    "format": {"type": "json_schema", "schema": anthropic.transform_schema(request.output)},
                },
                betas=[FALLBACK_BETA],
                fallbacks="default",
                timeout=timeout_s,
            )
        except anthropic.APITimeoutError as exc:
            raise LLMError(f"{request.task}: request timed out", retryable=True) from exc
        except anthropic.RateLimitError as exc:
            raise LLMError(f"{request.task}: rate limited", retryable=True) from exc
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            raise LLMError(f"{request.task}: the API key was rejected ({exc.status_code})", retryable=False) from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(f"{request.task}: API returned {exc.status_code}", retryable=exc.status_code >= 500) from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"{request.task}: could not reach the API", retryable=True) from exc

        if response.stop_reason == "refusal":
            raise LLMError(f"{request.task}: the model declined the request", retryable=False)
        if response.stop_reason == "max_tokens":
            raise LLMError(f"{request.task}: the answer was cut off at {MAX_TOKENS} tokens", retryable=True)
        text = next((block.text for block in response.content if block.type == "text"), None)
        if not text:
            raise LLMError(f"{request.task}: the answer had no text", retryable=True)
        try:
            return request.output.model_validate_json(text)
        except ValidationError as exc:
            raise LLMError(f"{request.task}: the answer did not match the schema", retryable=True) from exc
