import pytest
import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from dotenv import load_dotenv

# Ensure cortex package is importable (project root contains cortex/)
project_root = Path(__file__).parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Load environment variables from .env file
load_dotenv()

from cortex.llm_factory import LLMFactory


@pytest.fixture(autouse=True)
def reset_llm_factory():
    """Reset LLMFactory singleton between tests to avoid cross-contamination."""
    yield
    LLMFactory.reset_instance()


@pytest.fixture
def sample_config_path():
    """Path to the real model_registry.yaml for LLM factory tests."""
    config = Path(__file__).parent.parent.parent / "config" / "model_registry.yaml"
    assert config.exists(), f"model_registry.yaml not found at {config}"
    return str(config)


@pytest.fixture
def mock_api_keys(monkeypatch):
    """Mock all provider API keys so tests don't need real credentials."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-fake-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("XAI_API_KEY", "test-xai-key")


@pytest.fixture(autouse=True)
def clean_blackboard_cache():
    """Clear Blackboard instance cache between tests."""
    try:
        from cortex.blackboard import Blackboard
        Blackboard.clear_cache()
        yield
        Blackboard.clear_cache()
    except ImportError:
        yield  # Blackboard not available yet

@pytest.fixture
def mock_pydantic_llm():
    """
    Factory to mock BaseChatModel.ainvoke behaviour for manual JSON parsing.
    """
    def _create_mock(responses):
        # 'responses' is a list of Pydantic objects
        # We need to turn them into AIMessage-like objects with .content = json_str
        
        async def side_effect(*args, **kwargs):
            if not responses:
                return MagicMock(content="{}")
            resp_obj = responses.pop(0)
            # Handle dicts or Pydantic models
            if hasattr(resp_obj, "model_dump_json"):
                json_str = resp_obj.model_dump_json()
            elif hasattr(resp_obj, "json"):
                 json_str = resp_obj.json()
            else:
                import json
                json_str = json.dumps(resp_obj)
            
            msg = MagicMock()
            msg.content = json_str
            return msg

        mock_model = MagicMock()
        mock_model.ainvoke = AsyncMock(side_effect=side_effect)
        return mock_model
    return _create_mock
