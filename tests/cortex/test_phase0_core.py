"""
Phase 0 Core Infrastructure - Smoke Tests
"""

import pytest
from cortex.llm_factory import LLMFactory, ModelRole


class TestPhase0Core:
    """Smoke tests for Phase 0 Core Infrastructure."""
    
    def test_config_validation(self):
        """Should load registry without error."""
        factory = LLMFactory()
        assert factory._registry is not None
        assert "models" in factory._registry
        assert "roles" in factory._registry
        assert "defaults" in factory._registry
    
    def test_shuffle_logic(self):
        """Verify shuffle mode works without errors."""
        factory = LLMFactory()
        for _ in range(5):
            model = factory.get_model(ModelRole.PROPOSER)
            assert model is not None
    
    def test_judge_instantiation(self):
        """Judge must be deterministic with temperature 0."""
        factory = LLMFactory()
        model = factory.get_model(ModelRole.JUDGE)
        assert model is not None
        if hasattr(model, "temperature"):
            assert model.temperature == 0.0
    
    def test_model_info(self):
        """Should return complete model info for roles."""
        factory = LLMFactory()
        judge_info = factory.get_model_info(ModelRole.JUDGE)
        assert judge_info["role"] == "judge"
        assert judge_info["strategy"] == "fixed"
        proposer_info = factory.get_model_info(ModelRole.PROPOSER)
        assert proposer_info["strategy"] == "shuffle"
        assert proposer_info["pool"] is not None
    
    def test_all_roles_defined(self):
        """Verify all ModelRole enum values have registry entries."""
        factory = LLMFactory()
        for role in ModelRole:
            info = factory.get_model_info(role)
            assert info is not None
