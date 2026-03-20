"""
Cortex Configuration Module

Centralized settings using pydantic-settings for environment validation.
Implements FAIL-FAST security - crashes immediately if required API keys are missing.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, SecretStr
from typing import Optional
import os


def _find_project_root() -> str:
    """Walk upward from this file to find the project root via marker files."""
    current = os.path.dirname(os.path.abspath(__file__))
    for _ in range(5):  # Max 5 levels up
        if any(
            os.path.exists(os.path.join(current, marker))
            for marker in (".env", "pyproject.toml", "package.json")
        ):
            return current
        current = os.path.dirname(current)
    # Fallback: assume cortex/ is one level below project root
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


_CORTEX_ROOT = _find_project_root()
_ENV_FILE_PATH = os.path.join(_CORTEX_ROOT, ".env")


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables.
    
    Uses SecretStr for API keys to prevent accidental logging.
    """
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE_PATH, 
        env_file_encoding="utf-8", 
        extra="ignore"
    )

    # API Keys (SecretStr prevents accidental logging)
    openai_api_key: Optional[SecretStr] = Field(default=None, alias="OPENAI_API_KEY")
    anthropic_api_key: Optional[SecretStr] = Field(default=None, alias="ANTHROPIC_API_KEY")
    google_api_key: Optional[SecretStr] = Field(default=None, alias="GOOGLE_API_KEY")
    xai_api_key: Optional[SecretStr] = Field(default=None, alias="XAI_API_KEY")
    
    # Paths (using module-level _CORTEX_ROOT for cross-project compatibility)
    @property
    def model_registry_path(self) -> str:
        return os.path.join(_CORTEX_ROOT, "config", "model_registry.yaml")
    
    log_level: str = "INFO"

    # Nexus Integration
    nexus_api_url: str = "http://localhost:4000/api"
    nexus_service_key: Optional[SecretStr] = Field(default=None, alias="NEXUS_SERVICE_KEY")
    supabase_service_key: Optional[SecretStr] = Field(default=None, alias="SUPABASE_SERVICE_KEY")  # backward compat
    nexus_user_id: Optional[str] = Field(default=None, alias="NEXUS_USER_ID")


# Singleton Instance (Crashes here if .env is missing required keys)
try:
    settings = Settings()
except Exception as e:
    print(f"❌ CRITICAL: Environment Validation Failed.\n{e}")
    exit(1)
