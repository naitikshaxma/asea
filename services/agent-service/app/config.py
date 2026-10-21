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

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
