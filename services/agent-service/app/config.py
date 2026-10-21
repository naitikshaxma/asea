from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


_RULES_DIR = Path(__file__).resolve().parents[1] / "rules" / "semgrep"


class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    LOG_LEVEL: str = "INFO"

    # LLM Settings - purely optional for Phase 1 local development
    LLM_API_KEY: Optional[str] = None
    LLM_PROVIDER: str = "local_mock"
    MODEL_NAME: str = "mock-agent-v1"

    # Worker / sandbox boundary
    EXECUTION_SANDBOX_ENABLED: bool = False

    # Service-to-service security (S8): /api/v1/* requires this value in the
    # X-Internal-Token header; while unset, those routes return 503
    INTERNAL_SERVICE_TOKEN: Optional[str] = None
    AGENT_MAX_REQUEST_BYTES: int = 5 * 1024 * 1024

    # Static analysis (POST /api/v1/verify/static)
    # Comma-separated decorator names that count as authentication on a route
    ASEA_AUTH_DECORATORS: str = "login_required"
    # Command prefix for Semgrep, e.g. "semgrep", "wsl semgrep" or a
    # "docker run ... -v {workdir}:/src -w /src semgrep/semgrep:<tag> semgrep" line
    SEMGREP_COMMAND: str = "semgrep"
    # Pinned ruleset (downloaded by scripts/fetch_semgrep_rules.py) and the lock
    # holding its expected sha256; Semgrep is not run if they disagree
    SEMGREP_RULESET: Path = _RULES_DIR / "p-python.json"
    SEMGREP_RULES_LOCK: Path = _RULES_DIR / "p-python.lock.json"
    SEMGREP_TIMEOUT_SECONDS: int = 120

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
