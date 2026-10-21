from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # Static analysis (POST /api/v1/verify/static)
    # Comma-separated decorator names that count as authentication on a route
    ASEA_AUTH_DECORATORS: str = "login_required"
    # Command prefix for Semgrep, e.g. "semgrep", "wsl semgrep" or a
    # "docker run ... -v {workdir}:/src -w /src semgrep/semgrep:<tag> semgrep" line
    SEMGREP_COMMAND: str = "semgrep"
    SEMGREP_CONFIG: str = "p/python"
    SEMGREP_TIMEOUT_SECONDS: int = 120

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
