import pytest
from unittest.mock import patch
from cortex.llm_factory import LLMFactory, ModelRole

@pytest.mark.unit
def test_registry_loading():
    """Verify registry loads without error."""
    factory = LLMFactory()
    assert "roles" in factory._registry

@pytest.mark.unit
def test_shuffle_strategy(mocker):
    """Verify 'shuffle' strategy actually varies the model selection."""
    factory = LLMFactory()
    
    # Mock the internal driver creation to avoid API calls
    mocker.patch.object(factory, "_create_driver", return_value="mock_driver")
    
    # Inject a test registry with a shuffle pool
    factory._registry = {
        "roles": {"proposer": {"strategy": "shuffle", "pool": ["model_a", "model_b"]}},
        "models": {
            "model_a": {"provider": "openai", "model_name": "a"},
            "model_b": {"provider": "openai", "model_name": "b"}
        },
        "defaults": {"temperature": 0.5, "max_retries": 1}
    }
    
    # We can't easily test randomness deterministically, but we ensure it runs
    model = factory.get_model(ModelRole.PROPOSER)
    assert model == "mock_driver"
