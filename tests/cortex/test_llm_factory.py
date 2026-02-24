"""
Unit tests for the LLM Factory module.
"""

import os
import pytest
from unittest.mock import patch, MagicMock

from cortex.llm_factory import LLMFactory, LLMConfigurationError, ModelRole, get_llm_for_role


class TestLLMFactoryInitialization:
    def test_singleton_pattern(self, sample_config_path, mock_api_keys):
        factory1 = LLMFactory(config_path=sample_config_path)
        factory2 = LLMFactory(config_path=sample_config_path)
        assert factory1 is factory2

    def test_load_config_structure(self, sample_config_path, mock_api_keys):
        factory = LLMFactory(config_path=sample_config_path)
        assert "roles" in factory._registry
        assert "models" in factory._registry
        assert "defaults" in factory._registry

    def test_load_config_file_not_found(self, mock_api_keys):
        with pytest.raises(RuntimeError, match="Config not found"):
            LLMFactory(config_path='/nonexistent/path/config.yaml')


class TestModelRoleEnum:
    def test_all_roles_have_values(self):
        for role in ModelRole:
            assert isinstance(role.value, str)

    def test_role_enum_values(self):
        assert ModelRole.PROPOSER.value == "proposer"
        assert ModelRole.JUDGE.value == "judge"


class TestRoleToModelMapping:
    def test_get_model_info_fixed(self, sample_config_path, mock_api_keys):
        factory = LLMFactory(config_path=sample_config_path)
        info = factory.get_model_info(ModelRole.JUDGE)
        assert info["role"] == "judge"
        assert info["strategy"] == "fixed"

    def test_get_model_info_shuffle(self, sample_config_path, mock_api_keys):
        factory = LLMFactory(config_path=sample_config_path)
        info = factory.get_model_info(ModelRole.PROPOSER)
        assert info["strategy"] == "shuffle"
        assert info["pool"] is not None


class TestCostEstimation:
    def test_estimate_cost_calculation(self, sample_config_path, mock_api_keys):
        factory = LLMFactory(config_path=sample_config_path)
        cost = factory.estimate_cost(ModelRole.PROPOSER, input_tokens=1000, output_tokens=1000)
        # estimate_cost uses pool[0] for shuffle roles, which is gemini-pro
        expected = (1000/1000 * 0.00025) + (1000/1000 * 0.0005)
        assert abs(cost - expected) < 0.0001

    def test_estimate_cost_zero_tokens(self, sample_config_path, mock_api_keys):
        factory = LLMFactory(config_path=sample_config_path)
        cost = factory.estimate_cost(ModelRole.PROPOSER, input_tokens=0, output_tokens=0)
        assert cost == 0.0


class TestLLMCreation:
    @patch('cortex.llm_factory.ChatOpenAI')
    def test_get_model_creates_instance(self, mock_openai, sample_config_path, mock_api_keys):
        mock_openai.return_value = MagicMock()
        factory = LLMFactory(config_path=sample_config_path)
        model = factory.get_model(ModelRole.JUDGE)
        assert model is not None

    @patch('cortex.llm_factory.ChatGoogleGenerativeAI')
    def test_get_model_google_provider(self, mock_google, sample_config_path, mock_api_keys):
        mock_google.return_value = MagicMock()
        factory = LLMFactory(config_path=sample_config_path)
        factory.get_model(ModelRole.SEMANTIC_SCORER)
        mock_google.assert_called_once()


class TestResetInstance:
    def test_reset_creates_new_instance(self, sample_config_path, mock_api_keys):
        factory1 = LLMFactory(config_path=sample_config_path)
        id1 = id(factory1)
        LLMFactory.reset_instance()
        factory2 = LLMFactory(config_path=sample_config_path)
        id2 = id(factory2)
        assert id1 != id2
